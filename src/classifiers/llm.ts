/**
 * LLM classifier backend: any connected chat model, invoked statelessly via
 * OpenCode's `experimental.generate.text` (no session, history, or tools).
 *
 * The model is asked for a small strict JSON verdict; anything malformed is a
 * failure (the routing layer then applies the configured failure policy).
 * There is no silent fallback to another backend — backend choice is explicit.
 */

import { MAX_TIMEOUT_MS, type LlmBackendConfig, type ModelRef } from "../config.js";
import { buildState, truncate, type Classifier, type ClassifierContext, type Verdict } from "./types.js";

/** The stateless text-generation call (matches `ctx.experimental.generate.text`; injectable for tests). */
export type GenerateText = (
  input: { prompt: string; model?: ModelRef | null },
  options?: { signal?: AbortSignal },
) => Promise<{ text: string }>;

const VERDICT_INSTRUCTIONS = `You are a task-complexity classifier for a coding assistant.
Read the task in "prompt" (plus bounded recent context) and respond with ONLY one JSON object, no prose, no code fences:
{"tier":"simple"|"complex","reason":"<at most 120 chars>"}
simple: small well-scoped edits, straightforward questions, single-file changes with clear intent, mechanical refactors.
complex: architecture or design decisions, multi-file changes, difficult debugging, performance work, ambiguous or high-impact tasks.
When in doubt, choose complex.`;

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/**
 * Parse and strictly validate a verdict JSON object from raw model output.
 *
 * @param text - Raw completion text (code fences tolerated).
 * @returns The validated tier and reason.
 * @throws When the output does not contain a valid verdict object.
 */
export function parseLlmVerdict(text: string): { tier: "simple" | "complex"; reason: string } {
  const candidates = extractJsonObjectCandidates(text.trim());
  if (candidates.length === 0) throw new Error("LLM classifier returned no JSON object");

  let lastError = "LLM classifier returned invalid JSON";
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      lastError = "LLM classifier verdict is not an object";
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const tier = record.tier;
    if (tier !== "simple" && tier !== "complex") {
      lastError = `LLM classifier returned invalid tier: ${String(tier)}`;
      continue;
    }
    const cleanedReason = typeof record.reason === "string" ? truncate(record.reason, 120) : "";
    return { tier, reason: cleanedReason || "llm classifier" };
  }
  throw new Error(lastError);
}

/** Race a promise against a timeout; aborts the optional controller and rejects on expiry. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS) : 20_000;
  // Prevent unhandled rejection if the underlying call rejects after timeout expiry.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${safeTimeout}ms`));
          controller?.abort();
        }, safeTimeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Create the LLM classifier.
 *
 * @param cfg - Classifier model and timeout from settings.
 * @param generateText - The stateless generation call (defaults to a runtime-provided implementation).
 * @returns A classifier that throws on missing model, timeout, or malformed verdicts.
 */
export function createLlmClassifier(cfg: LlmBackendConfig, generateText: GenerateText): Classifier {
  return async (input: Parameters<Classifier>[0], ctx: ClassifierContext): Promise<Verdict> => {
    if (!cfg.model) throw new Error("llm classifier has no model selected (pick one via /router)");
    const startedAt = Date.now();
    const state = buildState(input, ctx.budgetChars);
    const prompt = `${VERDICT_INSTRUCTIONS}\n\n${state}`;
    const controller = new AbortController();

    let text: string;
    try {
      ({ text } = await withTimeout(
        generateText({ prompt, model: cfg.model }, { signal: controller.signal }),
        cfg.timeoutMs,
        "llm classifier",
        controller,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("timed out")) throw new Error(msg);
      const kind = err instanceof Error && err.name && err.name !== "Error" ? err.name : "request error";
      throw new Error(`llm classifier failed (${kind})`);
    }

    const verdict = parseLlmVerdict(text);
    return {
      tier: verdict.tier,
      reason: `llm: ${verdict.reason}`,
      backend: "llm",
      latencyMs: Date.now() - startedAt,
    };
  };
}
