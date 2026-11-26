import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, parseSettingsLayer, resolveSettings } from "./config.js";

describe("config parsing and precedence", () => {
  it("returns defaults when both layers are empty", () => {
    const { settings, errors } = resolveSettings(undefined, undefined);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.deepEqual(errors, []);
  });

  it("applies options > stored > defaults without clobbering partial decision/llm overrides", () => {
    const stored = {
      mode: "auto",
      simpleModel: { providerID: "ollama", id: "qwen3:8b" },
      decision: { baseUrl: "http://127.0.0.1:11435", model: "tev1:0.8b", timeoutMs: 45_000 },
      llm: { model: { providerID: "opencode", id: "gpt-nano" }, timeoutMs: 25_000 },
    };
    const options = {
      decision: { timeoutMs: 12_000 },
      llm: { timeoutMs: 8_000 },
    };

    const { settings, errors } = resolveSettings(options, stored);
    assert.deepEqual(errors, []);
    assert.equal(settings.mode, "auto");
    assert.deepEqual(settings.simpleModel, { providerID: "ollama", id: "qwen3:8b" });
    assert.equal(settings.decision.baseUrl, "http://127.0.0.1:11435");
    assert.equal(settings.decision.model, "tev1:0.8b");
    assert.equal(settings.decision.timeoutMs, 12_000);
    assert.deepEqual(settings.llm.model, { providerID: "opencode", id: "gpt-nano" });
    assert.equal(settings.llm.timeoutMs, 8_000);
  });

  it("merges agentOverrides per agent and per field", () => {
    const stored = {
      agentOverrides: {
        build: { mode: "simple", simpleModel: { providerID: "p1", id: "m1" } },
        plan: { mode: "complex" },
      },
    };
    const options = {
      agentOverrides: {
        build: { complexModel: { providerID: "p2", id: "m2" } },
      },
    };

    const { settings, errors } = resolveSettings(options, stored);
    assert.deepEqual(errors, []);
    assert.deepEqual(settings.agentOverrides.build, {
      mode: "simple",
      simpleModel: { providerID: "p1", id: "m1" },
      complexModel: { providerID: "p2", id: "m2" },
    });
    assert.deepEqual(settings.agentOverrides.plan, { mode: "complex" });
  });

  it("drops invalid option fields without overwriting valid stored values", () => {
    const stored = {
      inputBudgetChars: 5_000,
      contextTurns: 0,
      decision: { timeoutMs: 40_000 },
    };
    const options = {
      inputBudgetChars: -10,
      contextTurns: "bad",
      decision: { timeoutMs: Number.POSITIVE_INFINITY, baseUrl: "ftp://bad", apiKeyEnv: "not valid!" },
    };

    const { settings, errors } = resolveSettings(options, stored);
    assert.equal(settings.inputBudgetChars, 5_000);
    assert.equal(settings.contextTurns, 0);
    assert.equal(settings.decision.timeoutMs, 40_000);
    assert.equal(settings.decision.baseUrl, DEFAULT_SETTINGS.decision.baseUrl);
    assert.ok(errors.length >= 5);
  });

  it("preserves optional variants on model references", () => {
    const { settings } = resolveSettings({ simpleModel: { providerID: "p", id: "m", variant: "low" } }, undefined);
    assert.deepEqual(settings.simpleModel, { providerID: "p", id: "m", variant: "low" });
  });

  it("reports diagnostics for non-object root, decision, and llm layers, and rejects prototype keys", () => {
    const root = parseSettingsLayer("not-an-object");
    assert.deepEqual(root.errors, ["settings: expected an object"]);

    const nested = parseSettingsLayer({ decision: "bad", llm: [] });
    assert.deepEqual(nested.errors, ["decision: expected an object", "llm: expected an object"]);

    const protoPayload = JSON.parse('{"agentOverrides":{"__proto__":{"mode":"simple"},"constructor":{"mode":"complex"}}}');
    const proto = parseSettingsLayer(protoPayload);
    assert.equal(proto.errors.length, 2);
    assert.equal(Object.keys(proto.patch.agentOverrides ?? {}).length, 0);
  });
});
