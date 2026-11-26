import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLlmClassifier, parseLlmVerdict } from "./llm.js";

describe("LLM classifier", () => {
  it("parses strict JSON and fenced JSON while tolerating prose", () => {
    assert.deepEqual(parseLlmVerdict('{"tier":"simple","reason":"typo fix"}'), { tier: "simple", reason: "typo fix" });
    assert.deepEqual(
      parseLlmVerdict('Sure {note}:\n```json\n{"tier":"complex","reason":"multi-file refactor"}\n```'),
      { tier: "complex", reason: "multi-file refactor" },
    );
    assert.deepEqual(parseLlmVerdict('{"tier":"simple","reason":"   "}'), { tier: "simple", reason: "llm classifier" });
    assert.throws(() => parseLlmVerdict('{"tier":"medium","reason":"bad"}'), /invalid tier/);
  });

  it("aborts and times out slow generation calls", async () => {
    let aborted = false;
    const clf = createLlmClassifier(
      { model: { providerID: "opencode", id: "nano" }, timeoutMs: 25 },
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    await assert.rejects(
      () => clf({ sessionID: "s1", agentID: "build", promptText: "hi", fileNames: [], recentTurns: [] }, { budgetChars: 1000, confidenceThreshold: 0.5 }),
      /timed out/,
    );
    assert.equal(aborted, true);
  });

  it("rejects when model is missing or output is malformed without leaking prompt text", async () => {
    const noModel = createLlmClassifier({ model: null, timeoutMs: 1_000 }, async () => ({ text: "{}" }));
    await assert.rejects(
      () => noModel({ sessionID: "s1", agentID: "build", promptText: "PRIVATE", fileNames: [], recentTurns: [] }, { budgetChars: 1000, confidenceThreshold: 0.5 }),
      /no model selected/,
    );

    const badOut = createLlmClassifier({ model: { providerID: "opencode", id: "nano" }, timeoutMs: 1_000 }, async () => ({
      text: "not json at all",
    }));
    await assert.rejects(
      () => badOut({ sessionID: "s1", agentID: "build", promptText: "PRIVATE", fileNames: [], recentTurns: [] }, { budgetChars: 1000, confidenceThreshold: 0.5 }),
      (err: Error) => err.message.includes("no JSON object") && !err.message.includes("PRIVATE"),
    );
  });
});
