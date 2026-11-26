/**
 * Local decision-model backend (tev1 via Ollama's `/v1/systemone`).
 *
 * The endpoint is root-level, so a trailing `/api` on the base URL is dropped
 * before `/v1/systemone` is appended. One `choice` question with the
 * simple/complex/undecided rubric is asked; `undecided`, missing answers, and
 * low confidence all resolve to `complex` (uncertainty routes up).
 *
 * Wire format mirrors OpenCodeRAG's `OllamaDecisionProvider`:
 *   POST {model, state, questions: {id: {type, instructions, criteria?}}}
 *   ->  {answers: {id: {choice?, confidence?, probabilities?, ...}}}
 *
 * The request body is bounded to Ollama's 64 KiB limit. Prompt content goes
 * over the wire to the local model only; nothing is logged or echoed in errors.
 */

import { MAX_TIMEOUT_MS, type DecisionBackendConfig } from "../config.js";
import { buildState, truncate, type Classifier, type ClassifierContext, type Verdict } from "./types.js";

/** Minimal fetch-compatible POST used by the classifier (injectable for tests). */
export type DecisionFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "error" | "follow" | "manual" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Ollama rejects decision bodies larger than 64 KiB. */
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The rubric asked of the decision model. */
const RUBRIC_INSTRUCTIONS = `Classify the coding task in "prompt" by complexity, using "recent" conversation context when helpful.
simple: small well-scoped edits, straightforward questions, single-file changes with clear intent, mechanical refactors.
complex: architecture or design decisions, multi-file changes, difficult debugging, performance work, ambiguous or high-impact tasks.
undecided: not enough information to tell.`;

const CRITERIA: Record<string, string> = {
  simple: "Small, well-scoped task a focused single pass can handle.",
  complex: "Architecture, multi-file, hard debugging, or high-impact/ambiguous work.",
  undecided: "Insufficient information to classify confidently.",
};

/**
 * Resolve and validate the absolute `/v1/systemone` URL from an Ollama base URL.
 *
 * @param baseUrl - Base such as `http://127.0.0.1:11434` or one ending in `/api`.
 * @returns The sanitized decision endpoint URL (origin + pathname).
 * @throws When the URL is invalid, non-HTTP(S), or carries credentials/query/hash.
 */
export function resolveSystemOneUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("decision.baseUrl is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`decision.baseUrl must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("plaintext HTTP is only allowed for loopback decision endpoints");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("decision.baseUrl must not include credentials, query parameters, or fragments");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api")) path = path.slice(0, -"/api".length);
  return `${parsed.origin}${path}/v1/systemone`;
}

function isSecureForCredentials(endpointUrl: string): boolean {
  const parsed = new URL(endpointUrl);
  if (parsed.protocol === "https:") return true;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Extract a usable confidence in [0,1] from a raw decision answer.
 * Prefers an explicit `confidence`; falls back to the maximum reported probability.
 */
function extractConfidence(raw: Record<string, unknown>): number | undefined {
  const direct = toNumber(raw.confidence);
  if (direct !== undefined) return Math.min(1, Math.max(0, direct));
  const probabilities = raw.probabilities;
  let best: number | undefined;
  if (Array.isArray(probabilities)) {
    for (const p of probabilities.map(toNumber)) if (p !== undefined && (best === undefined || p > best)) best = p;
  } else if (typeof probabilities === "object" && probabilities !== null) {
    for (const p of Object.values(probabilities).map(toNumber)) if (p !== undefined && (best === undefined || p > best)) best = p;
  }
  return best === undefined ? undefined : Math.min(1, Math.max(0, best));
}

function serializeBoundedRequest(model: string, input: Parameters<Classifier>[0], budgetChars: number): string {
  let budget = Math.max(200, Math.floor(Number.isFinite(budgetChars) ? budgetChars : 3_000));
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = buildState(input, budget);
    const body = JSON.stringify({
      model,
      state,
      questions: {
        tier: { type: "choice", instructions: RUBRIC_INSTRUCTIONS, criteria: CRITERIA },
      },
    });
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes <= MAX_REQUEST_BYTES) return body;
    if (budget <= 200) break;
    // Shrink proportionally for multi-byte UTF-8 or JSON-escape expansion.
    const ratio = (MAX_REQUEST_BYTES * 0.85) / bytes;
    const nextBudget = Math.max(200, Math.floor(state.length * ratio));
    budget = nextBudget < budget ? nextBudget : Math.max(200, Math.floor(budget * 0.5));
  }
  throw new Error("decision request exceeds 64 KiB even after shrinking input state");
}

function isAbortOrTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

/**
 * Create the decision-model classifier.
 *
 * @param cfg - Endpoint, model, timeout, and optional API-key env var.
 * @param fetchImpl - Fetch-compatible POST (defaults to global `fetch`; inject a stub in tests).
 * @param env - Environment lookup for the optional API key (defaults to `process.env`).
 * @returns A classifier that throws on timeout, unreachable endpoint, or unusable answers.
 */
export function createDecisionClassifier(
  cfg: DecisionBackendConfig,
  fetchImpl: DecisionFetch = (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() })),
  env: Record<string, string | undefined> = process.env,
): Classifier {
  const url = resolveSystemOneUrl(cfg.baseUrl);
  const timeoutMs =
    Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? Math.min(Math.floor(cfg.timeoutMs), MAX_TIMEOUT_MS) : 30_000;

  return async (input: Parameters<Classifier>[0], ctx: ClassifierContext): Promise<Verdict> => {
    const startedAt = Date.now();
    const body = serializeBoundedRequest(cfg.model, input, ctx.budgetChars);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.apiKeyEnv) {
      const key = env[cfg.apiKeyEnv]?.trim();
      if (key) {
        if (!isSecureForCredentials(url)) {
          throw new Error(`refusing to send ${cfg.apiKeyEnv} over plaintext non-loopback HTTP (${url})`);
        }
        headers.authorization = `Bearer ${key}`;
      }
    }

    let response: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (err) {
      throw new Error(
        isAbortOrTimeout(err)
          ? `decision model timed out after ${timeoutMs}ms`
          : "decision model unreachable (network request failed)",
      );
    }

    if (!response.ok) {
      throw new Error(
        `decision model returned HTTP ${response.status} (Ollama >= 0.35 required; model "${cfg.model}" must be pulled)`,
      );
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (err) {
      throw new Error(
        isAbortOrTimeout(err)
          ? `decision model timed out reading response after ${timeoutMs}ms`
          : "decision model failed reading response",
      );
    }

    if (Buffer.byteLength(rawText, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("decision model returned a response larger than 64 KiB");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error("decision model returned a non-JSON response");
    }
    const record = typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    const answers =
      typeof record.answers === "object" && record.answers !== null && !Array.isArray(record.answers)
        ? (record.answers as Record<string, unknown>)
        : undefined;
    const rawAnswer = answers?.tier;
    if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) {
      throw new Error('decision model returned no valid answer object for "tier"');
    }

    const answer = rawAnswer as Record<string, unknown>;
    const choice = typeof answer.choice === "string" ? answer.choice.trim().toLowerCase() : "";
    const confidence = extractConfidence(answer);

    let tier: Verdict["tier"];
    let reason: string;
    if (choice === "simple") {
      tier = "simple";
      reason = "decision model: simple";
    } else if (choice === "complex") {
      tier = "complex";
      reason = "decision model: complex";
    } else {
      // "undecided" or anything unrecognized: uncertainty routes complex.
      tier = "complex";
      reason = "decision model: undecided";
    }

    if (confidence !== undefined && confidence < ctx.confidenceThreshold) {
      if (tier === "simple") reason = "decision model: simple -> complex (low confidence)";
      tier = "complex";
    }

    return {
      tier,
      reason: truncate(reason, 120),
      backend: "decision",
      latencyMs: Date.now() - startedAt,
      confidence,
    };
  };
}
