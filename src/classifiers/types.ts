/**
 * Shared verdict contract for both classifier backends.
 *
 * Backends return a `Verdict` or throw; the routing layer maps throws to the
 * configured failure policy. Prompt content is never logged — only the tier,
 * a short reason, and metadata.
 */

import type { BackendKind } from "../config.js";

/** Complexity tier a prompt is routed to. */
export type Tier = "simple" | "complex";

/** The outcome of one classification. */
export interface Verdict {
  /** The chosen tier. */
  readonly tier: Tier;
  /** Short human-readable justification, safe for status display (max ~120 chars). */
  readonly reason: string;
  /** Which backend produced the verdict. */
  readonly backend: BackendKind;
  /** Wall-clock latency of the classifier call, in milliseconds. */
  readonly latencyMs: number;
  /** Classifier confidence in [0,1] when the backend reports one; omitted otherwise. */
  readonly confidence?: number;
}

/** One recent conversation turn included in classifier input. */
export interface RecentTurn {
  readonly role: "user" | "assistant";
  /** Turn text, already truncated to the per-turn cap. */
  readonly text: string;
}

/** Everything a classifier needs to judge one prompt. */
export interface ClassifierInput {
  readonly sessionID: string;
  readonly agentID: string;
  /** Short role description supplied by OpenCode, when available. */
  readonly agentDescription?: string;
  /** The new prompt's text (no system context, no history). */
  readonly promptText: string;
  /** Names/URIs of attached files, for modality awareness only — contents are never read. */
  readonly fileNames: string[];
  /** Bounded recent conversation turns, oldest first. */
  readonly recentTurns: readonly RecentTurn[];
}

/** Per-call limits applied by the routing layer. */
export interface ClassifierContext {
  /** Maximum characters of assembled state text. */
  readonly budgetChars: number;
  /** Verdict confidence below this is treated as uncertain (routed complex). */
  readonly confidenceThreshold: number;
}

/** A classifier implementation (decision or LLM backend). Throws on failure/timeout. */
export type Classifier = (input: ClassifierInput, ctx: ClassifierContext) => Promise<Verdict>;

/** Per-turn text cap inside the state budget. */
export const TURN_CAP_CHARS = 400;

/**
 * Assemble the bounded classifier state from a prompt and recent turns.
 *
 * Header metadata (`agent`, `files`) and the `prompt` slice are reserved first
 * so recent conversation history never crowds out or truncates the active
 * prompt. Total output never exceeds `budgetChars` (floored at 200).
 *
 * @param input - Prompt, attachments, and recent turns.
 * @param budgetChars - Maximum characters for the returned state text.
 */
export function buildState(input: ClassifierInput, budgetChars: number): string {
  const safeBudget = Number.isFinite(budgetChars) ? Math.max(200, Math.floor(budgetChars)) : 3_000;

  const headerLines: string[] = [`agent: ${input.agentID.slice(0, 80)}`];
  if (input.agentDescription?.trim()) {
    headerLines.push(`role: ${input.agentDescription.trim().slice(0, 160)}`);
  }
  if (input.fileNames.length > 0) {
    const names = input.fileNames.slice(0, 5).map((n) => n.slice(0, 60)).join(", ");
    headerLines.push(`files: ${names}${input.fileNames.length > 5 ? ` (+${input.fileNames.length - 5} more)` : ""}`);
  }
  const header = headerLines.join("\n");
  const promptPrefix = "\nprompt: ";
  const promptBudget = Math.max(80, Math.floor(safeBudget / 2));
  const promptSlice = input.promptText.slice(0, Math.max(0, Math.min(promptBudget, safeBudget - header.length - promptPrefix.length)));
  const promptLine = `${promptPrefix}${promptSlice}`;

  const turnsBudget = safeBudget - header.length - promptLine.length - "\nrecent:".length;
  const kept: string[] = [];
  let used = 0;
  if (turnsBudget > 20) {
    // Newest turns matter most: fill the remaining budget from the tail forward.
    for (let i = input.recentTurns.length - 1; i >= 0; i--) {
      const turn = input.recentTurns[i];
      const line = `${turn.role}: ${turn.text.slice(0, TURN_CAP_CHARS)}`;
      const cost = line.length + 1; // +1 for leading newline
      if (used + cost > turnsBudget) break;
      kept.unshift(line);
      used += cost;
    }
  }

  const parts = [header];
  if (kept.length > 0) {
    parts.push("recent:", ...kept);
  }
  const state = `${parts.join("\n")}${promptLine}`;
  return state.length > safeBudget ? state.slice(0, safeBudget) : state;
}

/** Truncate a string with an ellipsis marker when it exceeds the cap. */
export function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const cap = Math.floor(maxChars);
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= cap) return clean;
  return `${clean.slice(0, cap - 1)}…`;
}
