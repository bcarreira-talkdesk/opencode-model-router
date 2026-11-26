import { describe, it } from "node:test";
import assert from "node:assert/strict";
import tuiPlugin from "./tui.js";
import { DEFAULT_SETTINGS } from "./config.js";

function tuiHarness() {
  const selections: unknown[] = [];
  const writes: Record<string, unknown>[] = [];
  const alerts: unknown[] = [];
  const toasts: unknown[] = [];
  let commands: any[] = [];
  const settings = { ...DEFAULT_SETTINGS, mode: "off" as const };
  const models = [
    { providerID: "ollama", id: "gemma4:12b", key: "ollama/gemma4:12b", label: "gemma4:12b", costLabel: "$0 / $0 per Mtok (catalog)", enabled: true },
    { providerID: "github-copilot", id: "gpt-6-luna", key: "github-copilot/gpt-6-luna", label: "GPT-6 Luna", costLabel: "$3 / $15 per Mtok", enabled: true },
  ];
  const rpc = {
    getSettings: async () => ({ settings, errors: [] }),
    updateSettings: async ({ patch }: any) => { writes.push(patch); return { settings, errors: [] }; },
    listModels: async () => ({ data: models }),
    getStatus: async ({ sessionID }: any) => ({
      sessionID,
      agentID: "build",
      currentModel: { providerID: "ollama", id: "gemma4:12b" },
      tier: "simple",
      reason: "already on simple model",
      serialized: false,
      updated: Date.now(),
    }),
  };
  const context: any = {
    client: { rpc: () => rpc },
    data: { session: { get: () => ({ agent: "build" }) } },
    keymap: { layer: (factory: any) => { commands = factory().commands; } },
    ui: {
      slot: () => () => {},
      router: { current: () => ({ type: "session", sessionID: "s1" }) },
      dialog: {
        select: async (options: any) => {
          const selected = selections.shift();
          if (selected === "__assert_models__") {
            const row = options.options[1];
            assert.equal(row.title, "gemma4:12b");
            assert.ok(String(row.description).startsWith("$0 / $0 per Mtok (catalog)"));
            assert.ok(String(row.description).includes("ollama/gemma4:12b"));
            return row.value;
          }
          return selected;
        },
        confirm: async () => false,
        prompt: async () => undefined,
        alert: async (value: any) => { alerts.push(value); },
      },
      toast: { show: (value: any) => toasts.push(value) },
    },
  };
  return { context, selections, writes, alerts, toasts, get commands() { return commands; } };
}

describe("TUI /router interactions", () => {
  it("registers palette and slash command", async () => {
    const h = tuiHarness();
    await tuiPlugin.setup(h.context as never);
    assert.equal(h.commands[0].id, "opencode-model-router.open");
    assert.equal(h.commands[0].slash.name, "router");
    assert.equal(h.commands[0].palette, true);
  });

  it("opens model picker, displays catalog cost, and saves without enabling routing", async () => {
    const h = tuiHarness();
    h.selections.push("simple", "__assert_models__");
    await tuiPlugin.setup(h.context as never);
    await h.commands[0].run();
    assert.deepEqual(h.writes, [{ simpleModel: { providerID: "ollama", id: "gemma4:12b" } }]);
    assert.deepEqual(h.writes[0], { simpleModel: { providerID: "ollama", id: "gemma4:12b" } });
  });

  it("cancels cloud-classifier confirmation without persisting backend", async () => {
    const h = tuiHarness();
    h.selections.push("backend", "llm");
    await tuiPlugin.setup(h.context as never);
    await h.commands[0].run();
    assert.deepEqual(h.writes, []);
  });

  it("shows current-session status", async () => {
    const h = tuiHarness();
    h.selections.push("status");
    await tuiPlugin.setup(h.context as never);
    await h.commands[0].run();
    assert.equal(h.alerts.length, 1);
    assert.match((h.alerts[0] as any).message, /Model: ollama\/gemma4:12b/);
  });
});
