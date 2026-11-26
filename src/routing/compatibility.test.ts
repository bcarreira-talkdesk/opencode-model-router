import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCompatibility, inferModalities } from "./compatibility.js";

const target = { providerID: "p", id: "model" };

describe("routing compatibility", () => {
  it("rejects unavailable, disabled, tool-incompatible, modality, and context-incompatible targets", () => {
    assert.equal(checkCompatibility(target, [], { requiresTools: true, modalities: [], estimatedInputTokens: 10 }).compatible, false);

    assert.match(
      (checkCompatibility(target, [{ ...target, enabled: false }], { requiresTools: false, modalities: [], estimatedInputTokens: 10 }) as { compatible: false; reason: string }).reason,
      /disabled/,
    );

    const model = { ...target, enabled: true, capabilities: { tools: false, input: ["text"] }, limit: { context: 1000, input: 500 } };
    assert.match(
      (checkCompatibility(target, [model], { requiresTools: true, modalities: [], estimatedInputTokens: 10 }) as { compatible: false; reason: string }).reason,
      /tool capability/,
    );
    assert.match(
      (checkCompatibility(target, [model], { requiresTools: false, modalities: ["image"], estimatedInputTokens: 10 }) as { compatible: false; reason: string }).reason,
      /image/,
    );
    assert.match(
      (checkCompatibility(target, [model], { requiresTools: false, modalities: [], estimatedInputTokens: 501 }) as { compatible: false; reason: string }).reason,
      /input limit/,
    );
  });

  it("fails closed on unknown required capabilities and accepts known compatible requests", () => {
    assert.equal(checkCompatibility(target, [{ ...target }], { requiresTools: true, modalities: ["image"], estimatedInputTokens: 999 }).compatible, false);
    assert.deepEqual(
      checkCompatibility(
        target,
        [{ ...target, capabilities: { tools: true, input: ["text", "image"] }, limit: { input: 1000 } }],
        { requiresTools: true, modalities: ["IMAGE"], estimatedInputTokens: 1000 },
      ),
      { compatible: true },
    );
  });

  it("infers modalities from names/URIs without reading contents", () => {
    assert.deepEqual(inferModalities(["photo.PNG", "recording.wav", "clip.webm?token=x", "a.ts"]), ["image", "audio", "video"]);
  });
});
