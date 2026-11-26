import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDecisionClassifier, resolveSystemOneUrl } from "./decision.js";

describe("decision classifier", () => {
  it("resolves /v1/systemone and rejects invalid or credentialed URLs", () => {
    assert.equal(resolveSystemOneUrl("http://127.0.0.1:11434/api/"), "http://127.0.0.1:11434/v1/systemone");
    assert.equal(resolveSystemOneUrl("https://ollama.example.com"), "https://ollama.example.com/v1/systemone");
    assert.throws(() => resolveSystemOneUrl("ftp://127.0.0.1:11434"), /http or https/);
    assert.throws(() => resolveSystemOneUrl("http://remote.example.com:11434"), /loopback/);
    assert.throws(() => resolveSystemOneUrl("http://user:pass@127.0.0.1:11434"), /credentials/);
  });

  it("routes simple, complex, undecided, and low-confidence verdicts properly", async () => {
    const baseCfg = { baseUrl: "http://127.0.0.1:11434", model: "tev1", timeoutMs: 5_000 };
    const input = { sessionID: "s1", agentID: "build", promptText: "SECRET_PROMPT", fileNames: [], recentTurns: [] };

    const simple = createDecisionClassifier(baseCfg, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: { tier: { choice: "simple", confidence: 0.9 } } }),
    }));
    const v1 = await simple(input, { budgetChars: 1000, confidenceThreshold: 0.5 });
    assert.equal(v1.tier, "simple");

    const lowConf = createDecisionClassifier(baseCfg, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: { tier: { choice: "simple", probabilities: { simple: 0.4, complex: 0.3 } } } }),
    }));
    const v2 = await lowConf(input, { budgetChars: 1000, confidenceThreshold: 0.5 });
    assert.equal(v2.tier, "complex");
    assert.match(v2.reason, /low confidence/);
  });

  it("enforces 64 KiB limit with multi-byte UTF-8 and never leaks prompt text in errors", async () => {
    let sentBytes = 0;
    const clf = createDecisionClassifier(
      { baseUrl: "http://127.0.0.1:11434", model: "tev1", timeoutMs: 5_000 },
      async (_url, init) => {
        sentBytes = Buffer.byteLength(init.body, "utf8");
        return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { tier: { choice: "complex" } } }) };
      },
    );
    const v = await clf(
      { sessionID: "s1", agentID: "build", promptText: "😀".repeat(25_000), fileNames: [], recentTurns: [] },
      { budgetChars: 32_000, confidenceThreshold: 0.5 },
    );
    assert.ok(sentBytes <= 64 * 1024);
    assert.equal(v.tier, "complex");

    const failing = createDecisionClassifier(
      { baseUrl: "http://127.0.0.1:11434", model: "tev1", timeoutMs: 5_000 },
      async () => ({ ok: true, status: 200, text: async () => "not-json" }),
    );
    await assert.rejects(
      () => failing({ sessionID: "s1", agentID: "build", promptText: "PRIVATE_TEXT", fileNames: [], recentTurns: [] }, { budgetChars: 1000, confidenceThreshold: 0.5 }),
      (err: Error) => !err.message.includes("PRIVATE_TEXT"),
    );
  });

  it("injects Authorization header on loopback HTTP and HTTPS, and refuses non-loopback plaintext HTTP", async () => {
    let authHeader: string | undefined;
    const okClf = createDecisionClassifier(
      { baseUrl: "http://127.0.0.1:11434", model: "tev1", timeoutMs: 5_000, apiKeyEnv: "OLLAMA_KEY" },
      async (_url, init) => {
        authHeader = init.headers.authorization;
        return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { tier: { choice: "simple" } } }) };
      },
      { OLLAMA_KEY: "secret-token" },
    );
    await okClf({ sessionID: "s1", agentID: "build", promptText: "hi", fileNames: [], recentTurns: [] }, { budgetChars: 1000, confidenceThreshold: 0.5 });
    assert.equal(authHeader, "Bearer secret-token");

    assert.throws(
      () => createDecisionClassifier(
        { baseUrl: "http://remote.example.com:11434", model: "tev1", timeoutMs: 5_000, apiKeyEnv: "OLLAMA_KEY" },
        async () => ({ ok: true, status: 200, text: async () => "{}" }),
        { OLLAMA_KEY: "secret-token" },
      ),
      /loopback decision endpoints/,
    );
  });

  it("handles undecided, missing tier, HTTP errors without leaking body, and body-read timeouts", async () => {
    const cfg = { baseUrl: "http://127.0.0.1:11434", model: "tev1", timeoutMs: 5_000 };
    const input = { sessionID: "s1", agentID: "build", promptText: "SECRET_PROMPT", fileNames: [], recentTurns: [] };

    const undecided = createDecisionClassifier(cfg, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: { tier: { choice: "undecided" } } }),
    }));
    const v = await undecided(input, { budgetChars: 1000, confidenceThreshold: 0.5 });
    assert.equal(v.tier, "complex");

    const missingTier = createDecisionClassifier(cfg, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: {} }),
    }));
    await assert.rejects(() => missingTier(input, { budgetChars: 1000, confidenceThreshold: 0.5 }), /no valid answer/);

    const httpErr = createDecisionClassifier(cfg, async () => ({
      ok: false,
      status: 500,
      text: async () => "echoed SECRET_PROMPT",
    }));
    await assert.rejects(
      () => httpErr(input, { budgetChars: 1000, confidenceThreshold: 0.5 }),
      (err: Error) => err.message.includes("HTTP 500") && !err.message.includes("SECRET_PROMPT"),
    );

    const oversized = createDecisionClassifier(cfg, async () => ({
      ok: true,
      status: 200,
      text: async () => "x".repeat(64 * 1024 + 1),
    }));
    await assert.rejects(() => oversized(input, { budgetChars: 1000, confidenceThreshold: 0.5 }), /larger than 64 KiB/);

    const bodyTimeout = createDecisionClassifier(cfg, async () => ({
      ok: true,
      status: 200,
      text: async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    }));
    await assert.rejects(() => bodyTimeout(input, { budgetChars: 1000, confidenceThreshold: 0.5 }), /timed out reading response/);
  });
});
