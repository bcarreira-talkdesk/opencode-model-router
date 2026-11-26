import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type RouterSettings } from "../config.js";
import { decide, effectiveConfig } from "./policy.js";

const simpleModel = { providerID: "ollama", id: "qwen3:8b" };
const complexModel = { providerID: "github-copilot", id: "gpt-6-luna" };

const baseSettings: RouterSettings = {
  ...DEFAULT_SETTINGS,
  mode: "auto",
  simpleModel,
  complexModel,
  agentOverrides: {
    plan: { mode: "complex" },
    docs: { mode: "simple", simpleModel: null },
  },
};

describe("routing policy", () => {
  it("applies per-agent overrides including explicit null without prototype pollution", () => {
    const plan = effectiveConfig(baseSettings, "plan");
    assert.equal(plan.mode, "complex");
    assert.deepEqual(plan.simpleModel, simpleModel);

    const docs = effectiveConfig(baseSettings, "docs");
    assert.equal(docs.mode, "simple");
    assert.equal(docs.simpleModel, null);

    const proto = effectiveConfig(baseSettings, "toString");
    assert.equal(proto.mode, "auto");
  });

  it("handles off, fixed, auto, failure policies, and no-op switches", () => {
    const verdict = { tier: "simple" as const, reason: "small", backend: "decision" as const, latencyMs: 10 };
    assert.equal(decide({ mode: "off", simpleModel, complexModel }, null, verdict, "complex").action, "none");

    const fixedComplex = decide({ mode: "complex", simpleModel, complexModel }, simpleModel, verdict, "keep-current");
    assert.equal(fixedComplex.action, "switch");
    if (fixedComplex.action === "switch") {
      assert.deepEqual(fixedComplex.to, complexModel);
      assert.equal(fixedComplex.verdict, undefined);
    }

    assert.equal(decide({ mode: "auto", simpleModel, complexModel }, simpleModel, null, "keep-current").action, "none");
    const failComplex = decide({ mode: "auto", simpleModel, complexModel }, simpleModel, null, "complex");
    assert.equal(failComplex.action, "switch");
    if (failComplex.action === "switch") assert.deepEqual(failComplex.to, complexModel);

    assert.equal(decide({ mode: "auto", simpleModel, complexModel }, simpleModel, verdict, "keep-current").action, "none");
  });
});
