import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCost, formatCostTier, isSelectable, modelKey, modelLabel, sameModel } from "./models.js";

describe("models cost formatting and identity", () => {
  it("renders missing or empty cost as unknown", () => {
    assert.equal(formatCost({}), "unknown");
    assert.equal(formatCost({ cost: [] }), "unknown");
  });

  it("labels zero catalog prices with a catalog caveat instead of free", () => {
    const cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
    assert.equal(formatCost({ cost }), "$0 / $0 per Mtok (catalog)");
  });

  it("preserves non-zero cache pricing even when base input/output are zero", () => {
    const cost = [{ input: 0, output: 0, cache: { read: 0.05, write: 0.1 } }];
    assert.equal(formatCost({ cost }), "$0 / $0 per Mtok ($0.05 read · $0.1 write)");
  });

  it("formats multiple context tiers cheapest-first with cache rates", () => {
    const cost = [
      { tier: { type: "context" as const, size: 1_000_000 }, input: 6, output: 24, cache: { read: 0.6, write: 7.5 } },
      { tier: { type: "context" as const, size: 200_000 }, input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    ];
    const formatted = formatCost({ cost });
    assert.equal(
      formatted,
      "≤1M: $6 / $24 per Mtok ($0.6 read · $7.5 write) · ≤200k: $3 / $15 per Mtok ($0.3 read · $3.75 write)",
    );
  });

  it("handles NaN and negative values safely without throwing", () => {
    const tier = { input: -1, output: Number.NaN, cache: { read: -0.1, write: 0.2 } };
    assert.equal(formatCostTier(tier), "$? / $? per Mtok");

    const multiZero = [
      { tier: { type: "context" as const, size: 100_000 }, input: 0, output: 0, cache: { read: 0, write: 0 } },
      { tier: { type: "context" as const, size: 200_000 }, input: 0, output: 0, cache: { read: 0, write: 0 } },
    ];
    assert.equal(formatCost({ cost: multiZero }), "≤100k: $0 / $0 per Mtok · ≤200k: $0 / $0 per Mtok");

    const badSize = [
      { tier: { type: "context" as const, size: 100_000 }, input: 1, output: 2, cache: { read: 0, write: 0 } },
      { tier: { type: "context" as const, size: -5 }, input: 3, output: 4, cache: { read: 0, write: 0 } },
    ];
    assert.equal(formatCost({ cost: badSize }), "≤100k: $1 / $2 per Mtok · ≤?: $3 / $4 per Mtok");
    assert.equal(formatCost({ cost: [{ input: 1, output: 2, cache: undefined as never }] }), "unknown");
    assert.equal(formatCost({ cost: [{ input: 1, output: 2, cache: { read: Infinity, write: 0 } }] }), "unknown");
  });

  it("handles provider/model IDs containing slashes", () => {
    const a = { providerID: "openrouter", id: "anthropic/claude-3.5-sonnet" };
    const b = { providerID: "anthropic", id: "anthropic/claude-3.5-sonnet" };
    assert.equal(modelKey(a), "openrouter/anthropic/claude-3.5-sonnet");
    assert.equal(modelLabel(b), "claude-3.5-sonnet");
    assert.equal(modelLabel(a), "anthropic/claude-3.5-sonnet");
    assert.equal(sameModel(a, b), false);
    assert.equal(sameModel(a, { providerID: "openrouter", id: "anthropic/claude-3.5-sonnet" }), true);
    assert.equal(sameModel({ providerID: "p", id: "m", variant: "low" }, { providerID: "p", id: "m", variant: "high" }), false);
    assert.equal(sameModel({ providerID: "p", id: "m" }, { providerID: "p", id: "m", variant: "default" }), true);
    assert.equal(isSelectable({ ...a, enabled: false }), false);
    assert.equal(isSelectable(a), true);
  });
});
