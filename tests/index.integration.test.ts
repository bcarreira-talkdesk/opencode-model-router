import { describe, it } from "node:test";
import assert from "node:assert/strict";
import serverPlugin from "../src/index.js";

function makeEventStream() {
  const queue: unknown[] = [];
  const waiters: Array<(event: unknown | undefined) => void> = [];
  let closed = false;
  return {
    emit(event: unknown) {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else queue.push(event);
    },
    subscribe(options: { signal?: AbortSignal } = {}) {
      options.signal?.addEventListener("abort", () => {
        closed = true;
        for (const waiter of waiters.splice(0)) waiter(undefined);
      }, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (queue.length) return { value: queue.shift(), done: false };
              if (closed) return { value: undefined, done: true };
              const value = await new Promise<unknown | undefined>((resolve) => waiters.push(resolve));
              return value === undefined ? { value: undefined, done: true } : { value, done: false };
            },
          };
        },
      };
    },
  };
}

function disposable() {
  return { dispose: async () => {} };
}

describe("server plugin integration with mocked OpenCode context", () => {
  it("routes simple -> cross-provider complex -> simple and classifies once per prompt", async () => {
    const events = makeEventStream();
    let promptHook: ((input: any) => Promise<void>) | undefined;
    let current = { id: "old", providerID: "manual" as string };
    const verdicts = ["simple", "complex", "simple"];
    let classifierCalls = 0;
    const switches: Array<{ providerID: string; id: string }> = [];
    const emissions: unknown[] = [];

    const ctx = {
      options: {
        mode: "auto",
        backend: "llm",
        simpleModel: { providerID: "ollama", id: "qwen3:8b" },
        complexModel: { providerID: "github-copilot", id: "gpt-6-luna" },
        llm: { model: { providerID: "opencode", id: "classifier" }, timeoutMs: 1000 },
      },
      storage: {
        get: async () => undefined,
        set: async () => {},
        remove: async () => {},
        scan: async () => ({ entries: [], cursor: undefined }),
      },
      agent: { get: async () => ({ data: { description: "Mock build agent" } }) },
      session: {
        hook: async (name: string, cb: (input: any) => Promise<void>) => {
          if (name === "prompt") promptHook = cb;
          return disposable();
        },
        get: async () => ({
          id: "s1",
          parentID: undefined,
          agent: "build",
          model: { ...current, variant: "default" },
          time: { created: 1, updated: 1, busy: 0, idle: 0 },
          location: { directory: "/test" },
        }),
        context: async () => [],
        switchModel: async ({ model }: { model: { providerID: string; id: string } }) => {
          switches.push(model);
          current = { id: model.id, providerID: model.providerID };
        },
      },
      model: {
        list: async () => ({
          location: { directory: "/test" },
          data: [
            { id: "ollama/qwen3:8b", modelID: "qwen3:8b", providerID: "ollama", name: "Qwen", enabled: true, cost: [], capabilities: { tools: true, input: ["text"] }, limit: { context: 100_000, output: 4096 } },
            { id: "github-copilot/gpt-6-luna", modelID: "gpt-6-luna", providerID: "github-copilot", name: "Luna", enabled: true, cost: [], capabilities: { tools: true, input: ["text"] }, limit: { context: 100_000, output: 4096 } },
          ],
        }),
      },
      experimental: {
        generate: {
          text: async () => ({ text: JSON.stringify({ tier: verdicts[classifierCalls++], reason: "mock verdict" }) }),
        },
      },
      rpc: {
        register: async () => ({ ...disposable(), events: { emit: async (_name: string, data: unknown) => { emissions.push(data); } } }),
      },
      event: { subscribe: events.subscribe.bind(events) },
    };

    const cleanup = await serverPlugin.setup(ctx as never);
    assert.ok(promptHook);

    for (let i = 0; i < 3; i++) {
      await promptHook!({
        sessionID: "s1",
        messageID: `m${i}`,
        prompt: { text: `prompt ${i}`, files: [] },
        delivery: "steer",
      });
      events.emit({ type: "session.inbox.delivered", data: { sessionID: "s1", inboxID: `m${i}` } });
      events.emit({ type: "session.execution.started", data: { sessionID: "s1" } });
      events.emit({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    }

    assert.equal(classifierCalls, 3, "classification happens once per admitted prompt");
    assert.deepEqual(switches, [
      { providerID: "ollama", id: "qwen3:8b" },
      { providerID: "github-copilot", id: "gpt-6-luna" },
      { providerID: "ollama", id: "qwen3:8b" },
    ]);
    assert.ok(emissions.length >= 3, "status events are emitted without prompt text");
    assert.ok(emissions.every((item) => !JSON.stringify(item).includes("prompt 0")));

    await (cleanup as (() => Promise<void>) | undefined)?.();
  });

  it("manual/off mode never serializes, classifies, or switches", async () => {
    const events = makeEventStream();
    let promptHook: ((input: any) => Promise<void>) | undefined;
    let calls = 0;
    const ctx = {
      options: { mode: "off" },
      storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({}) },
      session: {
        hook: async (name: string, cb: (input: any) => Promise<void>) => { if (name === "prompt") promptHook = cb; return disposable(); },
        get: async () => ({ id: "s-off", agent: "build", time: { busy: 5, idle: 1 }, model: { providerID: "manual", id: "chosen" } }),
        switchModel: async () => { calls++; },
      },
      experimental: { generate: { text: async () => { calls++; return { text: "" }; } } },
      model: { list: async () => ({ data: [] }) },
      rpc: { register: async () => ({ ...disposable(), events: { emit: async () => {} } }) },
      event: { subscribe: events.subscribe.bind(events) },
    };
    const cleanup = await serverPlugin.setup(ctx as never);
    await promptHook!({ sessionID: "s-off", messageID: "m1", prompt: { text: "unchanged", files: [] }, delivery: "steer" });
    assert.equal(calls, 0);
    await (cleanup as (() => Promise<void>) | undefined)?.();
  });
});
