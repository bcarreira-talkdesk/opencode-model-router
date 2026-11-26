import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildState, truncate } from "./types.js";

describe("classifier state builder and truncate", () => {
  it("never exceeds budgetChars and preserves the active prompt over old turns", () => {
    const state = buildState(
      {
        sessionID: "s1",
        agentID: "build",
        promptText: "CURRENT_PROMPT_MARKER",
        fileNames: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
        recentTurns: [
          { role: "user", text: "old ".repeat(200) },
          { role: "assistant", text: "recent_reply" },
        ],
      },
      260,
    );
    assert.ok(state.length <= 260);
    assert.ok(state.includes("CURRENT_PROMPT_MARKER"));
    assert.ok(state.includes("(+1 more)"));
  });

  it("handles NaN budgetChars safely", () => {
    const state = buildState(
      { sessionID: "s1", agentID: "build", promptText: "hello", fileNames: [], recentTurns: [] },
      Number.NaN,
    );
    assert.ok(state.includes("prompt: hello"));
  });

  it("returns empty string for non-positive truncate cap", () => {
    assert.equal(truncate("hello", 0), "");
    assert.equal(truncate("hello", -5), "");
    assert.equal(truncate("hello world", 5), "hell…");
  });
});
