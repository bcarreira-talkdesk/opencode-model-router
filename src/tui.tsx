/**
 * TUI settings/model picker for the model router.
 *
 * `/router` (also available in the command palette) exposes the routing mode,
 * classifier backend, simple/complex/LLM model pickers, current-agent
 * overrides, and current-session status. Model rows include the server-reported
 * input/output, cache, and context-tier labels; missing prices are `unknown`.
 */

import { Plugin } from "@opencode/plugin/tui";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { ModelRef, RouterSettings } from "./config.js";
import { ModelRouterRpc } from "./rpc.js";

interface PickableModel {
  providerID: string;
  id: string;
  key: string;
  label: string;
  costLabel: string;
  enabled?: boolean;
}

interface SettingsReply {
  settings: RouterSettings;
  errors?: string[];
}

interface StatusReply {
  sessionID: string;
  messageID?: string;
  agentID?: string;
  currentModel?: ModelRef;
  tier?: string;
  reason: string;
  warning?: string;
  serialized?: boolean;
  updated: number;
}

function shortModel(ref: ModelRef | null | undefined): string {
  return ref ? `${ref.providerID}/${ref.id}` : "not selected";
}

function sessionID(context: {
  ui: { router: { current(): { type: string; sessionID?: string } } };
}): string | undefined {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

/** TUI entrypoint. */
export default Plugin.define({
  id: "opencode-model-router-tui",
  async setup(context) {
    const router = context.client.rpc(ModelRouterRpc);

    const rpcOptions = context.location ? { location: context.location } : undefined;
    const getSettings = async (): Promise<SettingsReply> =>
      await router.getSettings({}, rpcOptions) as unknown as SettingsReply;
    const listModels = async (): Promise<PickableModel[]> => {
      const response = await router.listModels({}, rpcOptions) as unknown as { data?: PickableModel[] };
      return (response.data ?? []).filter((model) => model.enabled !== false);
    };
    const save = async (patch: Record<string, unknown>): Promise<SettingsReply> =>
      await router.updateSettings({ patch }, rpcOptions) as unknown as SettingsReply;

    const showErrors = (reply: SettingsReply): void => {
      if (!reply.errors?.length) return;
      context.ui.toast.show({ title: "Router settings", message: reply.errors.join("\n"), variant: "warning" });
    };

    const chooseMode = async (initial?: string): Promise<void> => {
      const selected = await context.ui.dialog.select({
        title: "Router mode",
        options: [
          { title: "Auto", value: "auto", description: "Classify each prompt, serializing busy-session admission" },
          { title: "Simple", value: "simple", description: "Always use the selected simple model" },
          { title: "Complex", value: "complex", description: "Always use the selected complex model" },
          { title: "Off", value: "off", description: "Preserve OpenCode's selected model" },
        ],
        current: initial,
      });
      if (selected) showErrors(await save({ mode: selected }));
    };

    const chooseBackend = async (initial?: string): Promise<void> => {
      const selected = await context.ui.dialog.select({
        title: "Complexity classifier backend",
        options: [
          { title: "Local decision model", value: "decision", description: "POST to configurable /v1/systemone" },
          { title: "Selected LLM", value: "llm", description: "Stateless generation through OpenCode's connected provider" },
        ],
        current: initial,
      });
      if (selected === "llm") {
        const confirmed = await context.ui.dialog.confirm({
          title: "Enable cloud-capable LLM classification?",
          message: "The selected classifier model receives the active prompt, bounded recent context, and attachment names on every auto-classified prompt. Provider billing may apply separately from routed model usage.",
          label: { confirm: "Use selected LLM", cancel: "Cancel" },
        });
        if (!confirmed) return;
      }
      if (selected) showErrors(await save({ backend: selected }));
    };

    const chooseModel = async (role: "simple" | "complex" | "llm", current?: ModelRef | null): Promise<void> => {
      const models = await listModels();
      if (models.length === 0) {
        context.ui.toast.show({ title: "Router models", message: "No enabled chat models are available in this location.", variant: "warning" });
        return;
      }
      const chosen = await context.ui.dialog.select<PickableModel | null>({
        title: `Select ${role === "llm" ? "LLM classifier" : role} model · prices are USD/Mtok; subscriptions may differ`,
        placeholder: "Search provider or model…",
        options: [
          { title: "Clear selection", value: null, description: "Leave this role unselected", category: "Selection" },
          ...models.map((model) => ({
            title: model.label,
            value: model,
            description: `${model.costLabel} · ${model.key}`,
            category: model.providerID,
          })), 
        ],
        current: null,
      });
      if (chosen === undefined) return;
      const ref = chosen ? { providerID: chosen.providerID, id: chosen.id } : null;
      showErrors(await save(role === "llm" ? { llm: { model: ref } } : { [`${role}Model`]: ref }));
      if (current && !chosen) {
        context.ui.toast.show({ title: "Model cleared", message: `${role} selection cleared.`, variant: "info" });
      }
    };

    const configureAdvanced = async (settings: RouterSettings): Promise<void> => {
      const choice = await context.ui.dialog.select({
        title: "Advanced router settings",
        options: [
          { title: `Decision endpoint: ${settings.decision.baseUrl}`, value: "decisionBaseUrl" },
          { title: `Decision model: ${settings.decision.model}`, value: "decisionModel" },
          { title: `Decision timeout: ${settings.decision.timeoutMs} ms`, value: "decisionTimeout" },
          { title: `LLM timeout: ${settings.llm.timeoutMs} ms`, value: "llmTimeout" },
          { title: `Classifier failure: ${settings.failurePolicy}`, value: "failurePolicy" },
          { title: `Confidence threshold: ${settings.confidenceThreshold}`, value: "confidenceThreshold" },
          { title: `Input budget: ${settings.inputBudgetChars} chars`, value: "inputBudgetChars" },
          { title: `Recent turns: ${settings.contextTurns}`, value: "contextTurns" },
        ],
      });
      if (!choice) return;
      if (choice === "failurePolicy") {
        const selected = await context.ui.dialog.select({
          title: "On classifier failure",
          options: [
            { title: "Keep current model", value: "keep-current", description: "Show a warning and preserve OpenCode's selection" },
            { title: "Route complex", value: "complex", description: "Treat classifier failure as uncertain and route up" },
          ],
          current: settings.failurePolicy,
        });
        if (selected) showErrors(await save({ failurePolicy: selected }));
        return;
      }
      const initial = choice === "decisionBaseUrl" ? settings.decision.baseUrl
        : choice === "decisionModel" ? settings.decision.model
        : choice === "decisionTimeout" ? String(settings.decision.timeoutMs)
        : choice === "llmTimeout" ? String(settings.llm.timeoutMs)
        : choice === "confidenceThreshold" ? String(settings.confidenceThreshold)
        : choice === "inputBudgetChars" ? String(settings.inputBudgetChars)
        : String(settings.contextTurns);
      const raw = await context.ui.dialog.prompt({
        title: "Update router setting",
        description: "Invalid values are rejected by the server; the stored value is preserved.",
        value: initial,
      });
      if (raw === undefined) return;
      const patch: Record<string, unknown> = {};
      if (choice === "decisionBaseUrl") patch.decision = { baseUrl: raw };
      else if (choice === "decisionModel") patch.decision = { model: raw };
      else if (choice === "decisionTimeout") patch.decision = { timeoutMs: Number(raw) };
      else if (choice === "llmTimeout") patch.llm = { timeoutMs: Number(raw) };
      else if (choice === "confidenceThreshold") patch.confidenceThreshold = Number(raw);
      else if (choice === "inputBudgetChars") patch.inputBudgetChars = Number(raw);
      else if (choice === "contextTurns") patch.contextTurns = Number(raw);
      showErrors(await save(patch));
    };

    const configureAgent = async (): Promise<void> => {
      const id = sessionID(context);
      if (!id) {
        context.ui.toast.show({ title: "Router agent override", message: "Open a session first.", variant: "warning" });
        return;
      }
      const agentID = context.data.session.get(id)?.agent ?? "build";
      const mode = await context.ui.dialog.select<string | null>({
        title: `Routing mode for agent ${agentID}`,
        options: [
          { title: "Keep existing", value: null, description: "Do not change the agent mode override" },
          { title: "Auto", value: "auto" },
          { title: "Simple", value: "simple" },
          { title: "Complex", value: "complex" },
          { title: "Off", value: "off" },
        ],
      });
      if (mode === undefined) return;
      const models = await listModels();
      const simple = await context.ui.dialog.select<PickableModel | null>({
        title: `Simple model for agent ${agentID}`,
        options: [
          { title: "Keep existing", value: null, description: "Do not change the agent simple-model override" },
          ...models.map((model) => ({ title: model.label, value: model, description: model.costLabel, category: model.providerID })),
        ],
      });
      if (simple === undefined) return;
      const complex = await context.ui.dialog.select<PickableModel | null>({
        title: `Complex model for agent ${agentID}`,
        options: [
          { title: "Keep existing", value: null, description: "Do not change the agent complex-model override" },
          ...models.map((model) => ({ title: model.label, value: model, description: model.costLabel, category: model.providerID })),
        ],
      });
      if (complex === undefined) return;
      const override: Record<string, unknown> = {};
      if (mode) override.mode = mode;
      if (simple) override.simpleModel = { providerID: simple.providerID, id: simple.id };
      if (complex) override.complexModel = { providerID: complex.providerID, id: complex.id };
      showErrors(await save({ agentOverrides: { [agentID]: override } }));
    };

    const showStatus = async (): Promise<void> => {
      const id = sessionID(context);
      if (!id) {
        context.ui.toast.show({ title: "Router status", message: "Open a session first.", variant: "warning" });
        return;
      }
      const status = await router.getStatus({ sessionID: id }, rpcOptions) as unknown as StatusReply;
      await context.ui.dialog.alert({
        title: "Model router status",
        message: [
          `Session: ${status.sessionID}`,
          `Agent: ${status.agentID ?? "unknown"}`,
          `Model: ${shortModel(status.currentModel)}`,
          `Tier: ${status.tier ?? "not classified"}`,
          `Reason: ${status.reason}`,
          `Serialized admission: ${status.serialized ? "yes" : "no"}`,
          status.warning ? `Warning: ${status.warning}` : "Warning: none",
        ].join("\n"),
      });
    };

    const showMenu = async (): Promise<void> => {
      const reply = await getSettings();
      showErrors(reply);
      const settings = reply.settings;
      const selected = await context.ui.dialog.select({
        title: "OpenCode model router",
        placeholder: "Choose a setting",
        options: [
          { title: `Mode: ${settings.mode}`, value: "mode", description: "Auto/simple/complex/off" },
          { title: `Backend: ${settings.backend}`, value: "backend", description: "Local decision model or selectable LLM" },
          { title: `Simple: ${shortModel(settings.simpleModel)}`, value: "simple", description: "Search models with published costs" },
          { title: `Complex: ${shortModel(settings.complexModel)}`, value: "complex", description: "May use a different provider" },
          { title: `Classifier: ${shortModel(settings.llm.model)}`, value: "llm", description: "Used only by the LLM backend" },
          { title: "Current agent overrides", value: "agent", description: "Mode and simple/complex model pair for the active agent" },
          { title: "Advanced settings", value: "advanced", description: "Endpoint, timeouts, failure policy, and classifier budgets" },
          { title: "Current session status", value: "status", description: "Effective model, tier, reason, and warning" },
        ],
      });
      if (selected === "mode") await chooseMode(settings.mode);
      else if (selected === "backend") await chooseBackend(settings.backend);
      else if (selected === "simple") await chooseModel("simple", settings.simpleModel);
      else if (selected === "complex") await chooseModel("complex", settings.complexModel);
      else if (selected === "llm") await chooseModel("llm", settings.llm.model);
      else if (selected === "agent") await configureAgent();
      else if (selected === "advanced") await configureAdvanced(settings);
      else if (selected === "status") await showStatus();
    };

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const [view, setView] = createSignal<{ settings?: RouterSettings; status?: StatusReply; }>();
        createEffect(() => {
          let disposed = false;
          const load = async () => {
            try {
              const [settingsReply, status] = await Promise.all([
                router.getSettings({}, rpcOptions) as unknown as Promise<SettingsReply>,
                router.getStatus({ sessionID }, rpcOptions) as unknown as Promise<StatusReply>,
              ]);
              if (!disposed) setView({ settings: settingsReply.settings, status });
            } catch {
              if (!disposed) setView(undefined);
            }
          };
          void load();
          const timer = setInterval(() => void load(), 1_000);
          onCleanup(() => { disposed = true; clearInterval(timer); });
        });
        return (
          <Show when={view()?.settings}>
            {(settings: () => RouterSettings) => (
              <box flexDirection="column" paddingTop={1}>
                <text fg={context.theme.text.base}>Model router</text>
                <text fg={context.theme.text.muted}>mode {settings().mode} · {settings().backend}</text>
                <text fg={context.theme.text.muted}>simple {shortModel(settings().simpleModel)}</text>
                <text fg={context.theme.text.muted}>complex {shortModel(settings().complexModel)}</text>
                <Show when={view()?.status?.messageID}>
                  <text fg={context.theme.text.base}>tier {view()?.status?.tier ?? "classifying"}</text>
                  <text fg={context.theme.text.base}>active {shortModel(view()?.status?.currentModel)}</text>
                  <text fg={context.theme.text.muted}>{view()?.status?.serialized ? "serialized admission" : view()?.status?.reason}</text>
                </Show>
                <Show when={view()?.status?.warning}>
                  <text fg={context.theme.text.muted}>warning {view()?.status?.warning}</text>
                </Show>
              </box>
            )}
          </Show>
        );
      },
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "opencode-model-router.open",
        title: "Model router",
        description: "Configure automatic simple/complex model routing and published model costs",
        palette: true,
        slash: { name: "router" },
        run: async () => {
          try {
            await showMenu();
          } catch (error) {
            const message = error instanceof Error ? error.message : "router dialog failed to open";
            context.ui.toast.show({ title: "Model router", message, variant: "error" });
          }
        },
      }],
    }));
  },
});
