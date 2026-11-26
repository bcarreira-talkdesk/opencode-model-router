/**
 * OpenCode V2 server entrypoint for the automatic model router.
 *
 * Routing changes only session model selection through `session.switchModel`.
 * Prompt text is never logged or persisted by this plugin. Busy-session prompts
 * are serialized in the admission hook before classification/switching so a
 * cross-provider switch cannot affect later steps of the previous execution.
 */

import { Plugin } from "@opencode/plugin";
import type { RouterSettings, ModelRef } from "./config.js";
import { parseSettingsLayer, resolveSettings } from "./config.js";
import { createDecisionClassifier } from "./classifiers/decision.js";
import { createLlmClassifier } from "./classifiers/llm.js";
import { TURN_CAP_CHARS, truncate, type ClassifierInput, type RecentTurn, type Verdict } from "./classifiers/types.js";
import { AdmissionSerializer } from "./routing/admission.js";
import { checkCompatibility, inferModalities } from "./routing/compatibility.js";
import { decide, effectiveConfig } from "./routing/policy.js";
import { formatCost, modelLabel, projectModelInfo, sameModel, type RouterModelInfo } from "./models.js";
import { ModelRouterRpc } from "./rpc.js";
import { SettingsWriter } from "./settings-store.js";
import { ModelRefresh } from "./model-refresh.js";

const STORAGE_KEY = "settings";

interface RouterStatus {
  readonly sessionID: string;
  readonly parentID?: string;
  readonly agentID?: string;
  readonly currentModel?: ModelRef;
  readonly tier?: "simple" | "complex";
  readonly messageID?: string;
  readonly reason: string;
  readonly warning?: string;
  readonly updated: number;
  readonly serialized: boolean;
}

function currentRef(model: { providerID: string; id: string; variant?: string } | undefined): ModelRef | undefined {
  if (!model) return undefined;
  return model.variant ? { providerID: model.providerID, id: model.id, variant: model.variant } : { providerID: model.providerID, id: model.id };
}

function sameSettingsModels(a: RouterSettings, b: RouterSettings): boolean {
  const equal = (left: ModelRef | null, right: ModelRef | null) => left === null && right === null ? true : sameModel(left, right);
  return equal(a.simpleModel, b.simpleModel)
    && equal(a.complexModel, b.complexModel)
    && equal(a.llm.model, b.llm.model);
}

function recentTurns(messages: readonly Record<string, unknown>[], maxTurns: number): RecentTurn[] {
  const turns: RecentTurn[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const message = messages[i];
    if (message.type === "user" && typeof message.text === "string") {
      turns.push({ role: "user", text: message.text.slice(0, TURN_CAP_CHARS) });
      continue;
    }
    if (message.type === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
        .map((part) => typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "")
        .join("\n")
        .trim();
      if (text) turns.push({ role: "assistant", text: text.slice(0, TURN_CAP_CHARS) });
    }
  }
  return turns.reverse();
}

function attachmentNames(files: readonly Record<string, unknown>[] | undefined): string[] {
  return (files ?? []).map((file) =>
    typeof file.name === "string" && file.name.trim() ? file.name : typeof file.uri === "string" ? file.uri : "attachment",
  );
}

function serializableStatus(status: RouterStatus): Record<string, unknown> {
  return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
}

/** Server-side plugin definition. */
export default Plugin.define({
  id: "opencode-model-router",
  async setup(ctx) {

    const options = (ctx.options ?? {}) as unknown;
    let stored = await ctx.storage.get(STORAGE_KEY);

    let resolved = resolveSettings(options, stored);
    let settings: RouterSettings = resolved.settings;
    const statuses = new Map<string, RouterStatus>();
    const admission = new AdmissionSerializer(120_000);
    const abort = new AbortController();
    const settingsWriter = new SettingsWriter();
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    const modelInventory = new Map<string, RouterModelInfo>();
    const inventoryRefresh = new ModelRefresh<RouterModelInfo[]>();
    let emitStatus = async (_data: Record<string, unknown>): Promise<void> => {};

    const refreshModels = async (): Promise<RouterModelInfo[]> => {
      const refreshed = await inventoryRefresh.run(async () => {
        const response = await ctx.model.list({ types: ["chat"] });
        return response.data.map((info) => projectModelInfo(info));
      });
      if (!inventoryRefresh.current(refreshed.generation)) {
        throw new Error("model inventory changed while refreshing; retry the prompt");
      }
      modelInventory.clear();
      for (const model of refreshed.data) modelInventory.set(`${model.providerID}/${model.id}`, model);
      return refreshed.data;
    };

    const setStatus = (status: RouterStatus): void => {
      statuses.set(status.sessionID, status);
      void emitStatus(serializableStatus(status)).catch(() => {});
    };


    const promptHook = await ctx.session.hook("prompt", async (input) => {

      const metadata = input.metadata as Record<string, unknown> | undefined;
      if (metadata?.__opencodeModelRouter === "classifier") return;

      const preInfo = await ctx.session.get({ sessionID: input.sessionID });
      const hookSettings = settings;
      const agentID = preInfo.agent;
      const cfg = effectiveConfig(hookSettings, agentID);
      if (cfg.mode === "off") return;

      const wasBusy = admission.isBusy(input.sessionID) || (preInfo.time.busy ?? 0) > (preInfo.time.idle ?? 0);
      admission.seed(input.sessionID, preInfo);
      if (wasBusy) setStatus({
        sessionID: input.sessionID,
        parentID: preInfo.parentID,
        agentID,
        currentModel: currentRef(preInfo.model),
        messageID: input.messageID,
        reason: "waiting for the current execution to finish",
        updated: Date.now(),
        serialized: true,
      });

      try {
        const waiting = admission.wait(input.sessionID, input.messageID);
        const observedBusy = preInfo.time.busy ?? 0;
        const reconcileAbort = new AbortController();
        const reconcile = (async () => {
          while (!reconcileAbort.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            if (!wasBusy || reconcileAbort.signal.aborted) return;
            const current = await ctx.session.get({ sessionID: input.sessionID });
            if (current.outcome && (current.time.updated ?? 0) > observedBusy) {
              admission.terminal(input.sessionID);
              return;
            }
          }
        })();
        try {
          await Promise.race([waiting, reconcile.then(() => waiting)]);
        } finally {
          reconcileAbort.abort();
        }

        // Read again after waiting: agent/model selection may have changed while serialized.
        const info = await ctx.session.get({ sessionID: input.sessionID });
        const live = resolveSettings(options, stored).settings;
        if (info.agent !== agentID || live.mode !== hookSettings.mode || live.backend !== hookSettings.backend || live.failurePolicy !== hookSettings.failurePolicy || !sameSettingsModels(live, hookSettings)) {
          admission.cancel(input.sessionID, input.messageID);
          throw new Error("router agent or settings changed while prompt was waiting; resubmit the prompt");
        }
        const activeAgent = agentID;
        const activeCfg = effectiveConfig(live, activeAgent);
        if (activeCfg.mode === "off") {
          admission.cancel(input.sessionID, input.messageID);
          return;
        }

        const history = await ctx.session.context({ sessionID: input.sessionID });
        const fullHistoryChars = JSON.stringify(history).length;
        const boundedTurns = recentTurns(history as unknown as readonly Record<string, unknown>[], hookSettings.contextTurns);
        const files = attachmentNames(input.prompt.files as readonly Record<string, unknown>[] | undefined);
        let agentDescription: string | undefined;
        if (activeAgent) {
          try {
            agentDescription = (await ctx.agent.get({ agentID: activeAgent })).data.description;
          } catch {
            // Agent description improves classification but is not required for routing.
          }
        }
        const classifierInput: ClassifierInput = {
          sessionID: input.sessionID,
          agentID: activeAgent ?? "unknown",
          agentDescription,
          promptText: input.prompt.text,
          fileNames: files,
          recentTurns: boundedTurns,
        };

        let verdict: Verdict | null = null;
        let warning: string | undefined;
        if (activeCfg.mode === "auto") {
          try {
            verdict = await (hookSettings.backend === "llm"
              ? createLlmClassifier(hookSettings.llm, (input, requestOptions) => ctx.experimental.generate.text(input, requestOptions))
              : createDecisionClassifier(hookSettings.decision))(classifierInput, {
              budgetChars: hookSettings.inputBudgetChars,
              confidenceThreshold: hookSettings.confidenceThreshold,
            });
          } catch (error) {
            warning = error instanceof Error ? truncate(error.message, 160) : "classifier failed";
          }
        }

        const action = decide(activeCfg, currentRef(info.model) ?? null, verdict, hookSettings.failurePolicy);
        if (action.action === "none") {
          setStatus({
            sessionID: input.sessionID,
            parentID: info.parentID,
            agentID: activeAgent,
            currentModel: currentRef(info.model),
            tier: verdict?.tier,
            messageID: input.messageID,
            reason: action.reason,
            warning,
            updated: Date.now(),
            serialized: wasBusy,
          });
          return;
        }

        const inventory = await refreshModels();
        const compatibility = checkCompatibility(action.to, inventory, {
          // Conservative: any primary agent can use tools until OpenCode exposes
          // active request tools before prompt admission.
          requiresTools: true,
          modalities: inferModalities(files),
          estimatedInputTokens: Math.ceil((fullHistoryChars + input.prompt.text.length) / 4),
        });
        if (!compatibility.compatible) {
          const failureWarning = `route rejected: ${compatibility.reason}`;
          setStatus({
            sessionID: input.sessionID,
            parentID: info.parentID,
            agentID: activeAgent,
            currentModel: currentRef(info.model),
            tier: verdict?.tier,
            messageID: input.messageID,
            reason: "kept current model; target is incompatible",
            warning: failureWarning,
            updated: Date.now(),
            serialized: wasBusy,
          });
          return;
        }

        await ctx.session.switchModel({ sessionID: input.sessionID, model: action.to });
        setStatus({
          sessionID: input.sessionID,
          parentID: info.parentID,
          agentID: activeAgent,
          currentModel: action.to,
          tier: verdict?.tier ?? (activeCfg.mode === "simple" ? "simple" : "complex"),
          messageID: input.messageID,
          reason: action.reason,
          warning,
          updated: Date.now(),
          serialized: wasBusy,
        });
      } catch (error) {
        admission.cancel(input.sessionID, input.messageID);
        throw error;
      }
    });
    registrations.push(promptHook);


    const rpcRegistration = await ctx.rpc.register(ModelRouterRpc, {
      getSettings: async () => ({ settings, errors: resolved.errors }),
      updateSettings: async (raw) => settingsWriter.enqueue(async () => {
        const patchInput = raw && typeof raw === "object" ? (raw as { patch?: unknown }).patch : raw;
        const parsed = parseSettingsLayer(patchInput);
        if (parsed.errors.length > 0) return { settings, errors: parsed.errors };

        const base = stored && typeof stored === "object" && !Array.isArray(stored)
          ? stored as Record<string, unknown>
          : {};
        const decision = base.decision && typeof base.decision === "object" && !Array.isArray(base.decision)
          ? base.decision as Record<string, unknown>
          : {};
        const llm = base.llm && typeof base.llm === "object" && !Array.isArray(base.llm)
          ? base.llm as Record<string, unknown>
          : {};
        const storedOverrides = base.agentOverrides && typeof base.agentOverrides === "object" && !Array.isArray(base.agentOverrides)
          ? base.agentOverrides as Record<string, unknown>
          : {};
        const agentOverrides: Record<string, unknown> = { ...storedOverrides };
        for (const [agentID, override] of Object.entries(parsed.patch.agentOverrides ?? {})) {
          const previous = agentOverrides[agentID];
          agentOverrides[agentID] = previous && typeof previous === "object" && !Array.isArray(previous)
            ? { ...previous as Record<string, unknown>, ...override }
            : { ...override };
        }

        const mergedStored = {
          ...base,
          ...parsed.patch,
          decision: { ...decision, ...(parsed.patch.decision ?? {}) },
          llm: { ...llm, ...(parsed.patch.llm ?? {}) },
          agentOverrides,
        };
        // Round-trip removes undefined and branded/interface-only shapes so the
        // value conforms to the storage domain's JSON type at runtime and TS.
        const persisted = JSON.parse(JSON.stringify(mergedStored));
        await ctx.storage.set(STORAGE_KEY, persisted);
        stored = persisted;
        resolved = resolveSettings(options, persisted);
        settings = resolved.settings;
        await rpcRegistration.events.emit("settingsChanged", { settings, errors: resolved.errors });
        return { settings, errors: resolved.errors };
      }),
      listModels: async () => ({
        data: (await refreshModels()).map((model) => ({
          ...model,
          key: `${model.providerID}/${model.id}`,
          label: modelLabel(model),
          costLabel: formatCost(model),
        })),
      }),
      getStatus: async (raw) => {
        const sessionID = typeof raw === "object" && raw !== null && "sessionID" in raw ? String(raw.sessionID) : "";
        return serializableStatus(statuses.get(sessionID) ?? {
          sessionID,
          reason: "router has not handled a prompt for this session",
          updated: Date.now(),
          serialized: false,
        });
      },
    });
    emitStatus = (data) => rpcRegistration.events.emit("statusChanged", data);
    registrations.push(rpcRegistration);


    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.inbox.delivered", "session.inbox.cancelled", "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle", "model.updated", "provider.updated"],
          signal: abort.signal,
        })) {
          const data = event as unknown as { type: string; data?: { sessionID?: string } };
          if (data.type === "model.updated" || data.type === "provider.updated") {
            inventoryRefresh.invalidate();
            modelInventory.clear();
            continue;
          }
          const sessionID = data.data?.sessionID;
          if (!sessionID) continue;
          if (data.type === "session.execution.started") admission.started(sessionID);
          else if (data.type === "session.inbox.delivered") {
            const inboxID = (data.data as { inboxID?: string } | undefined)?.inboxID;
            if (inboxID) admission.delivered(sessionID, inboxID);
          } else if (data.type === "session.inbox.cancelled") {
            const inboxID = (data.data as { inboxID?: string } | undefined)?.inboxID;
            if (inboxID) admission.cancel(sessionID, inboxID);
          } else admission.terminal(sessionID);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          const failure = new Error("router lifecycle event subscription ended; reload the plugin before routing again");
          admission.fail(failure);
          console.error("opencode-model-router event subscription ended", error instanceof Error ? error.name : "stream error");
        }
      } finally {
        if (!abort.signal.aborted) admission.fail(new Error("router lifecycle event subscription closed unexpectedly"));
      }
    })();

    return async () => {
      abort.abort();
      admission.dispose();
      // Event streams are host-owned. Aborting is sufficient; never hold location
      // shutdown forever if the underlying iterator fails to observe its signal.
      void subscription;
      for (const registration of registrations.reverse()) await registration.dispose();
    };
  },
});
