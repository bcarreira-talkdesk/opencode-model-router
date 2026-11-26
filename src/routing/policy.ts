/**
 * Routing policy: maps resolved settings, an agent, and a classifier verdict
 * to a concrete action for one prompt. Pure functions only — no I/O — so the
 * decision logic is fully unit-testable.
 */

import type { FailurePolicy, ModelRef, RouterMode, RouterSettings } from "../config.js";
import type { Tier, Verdict } from "../classifiers/types.js";
import { sameModel } from "../models.js";

/** Settings in effect for one agent after per-agent overrides are applied. */
export interface EffectiveConfig {
  readonly mode: RouterMode;
  readonly simpleModel: ModelRef | null;
  readonly complexModel: ModelRef | null;
}

/**
 * Apply per-agent overrides over the global settings.
 *
 * An override only replaces a field it explicitly sets (including an explicit
 * `null` to clear a tier model); unset fields inherit globally.
 *
 * @param settings - Fully-resolved router settings.
 * @param agentID - The agent handling the prompt, when known.
 */
export function effectiveConfig(settings: RouterSettings, agentID: string | undefined): EffectiveConfig {
  const override = agentID && Object.hasOwn(settings.agentOverrides, agentID) ? settings.agentOverrides[agentID] : undefined;
  return {
    mode: override?.mode ?? settings.mode,
    simpleModel: override && override.simpleModel !== undefined ? override.simpleModel : settings.simpleModel,
    complexModel: override && override.complexModel !== undefined ? override.complexModel : settings.complexModel,
  };
}

/** The outcome of routing one prompt. */
export type RoutingDecision =
  | { readonly action: "none"; readonly reason: string; readonly verdict?: Verdict }
  | { readonly action: "switch"; readonly to: ModelRef; readonly reason: string; readonly verdict?: Verdict };

/**
 * Decide the model action for one prompt.
 *
 * - `off` mode never acts.
 * - `simple`/`complex` modes pin the prompt to that tier's model (ignoring any verdict).
 * - `auto` uses the classifier verdict; when there is none (classifier
 *   failure), the failure policy applies — `keep-current` leaves the model
 *   as-is, `complex` routes up.
 * - A target equal to the current model is a no-op, so switching never
 *   churns a session that already runs the right model.
 *
 * @param cfg - Effective settings for the prompt's agent.
 * @param current - The model the session currently has selected (null when unknown).
 * @param verdict - Classifier verdict in auto mode; ignored in fixed modes.
 * @param failurePolicy - What to do in auto mode when no verdict is available.
 */
export function decide(
  cfg: EffectiveConfig,
  current: ModelRef | null,
  verdict: Verdict | null,
  failurePolicy: FailurePolicy,
): RoutingDecision {
  if (cfg.mode === "off") return { action: "none", reason: "router is off" };

  let tier: Tier;
  let activeVerdict: Verdict | undefined;
  if (cfg.mode === "simple") {
    tier = "simple";
  } else if (cfg.mode === "complex") {
    tier = "complex";
  } else if (verdict) {
    tier = verdict.tier;
    activeVerdict = verdict;
  } else if (failurePolicy === "keep-current") {
    return { action: "none", reason: "classifier failed; keeping current model" };
  } else {
    tier = "complex";
  }

  const to = tier === "simple" ? cfg.simpleModel : cfg.complexModel;
  if (!to) return { action: "none", reason: `no model selected for the ${tier} tier`, verdict: activeVerdict };
  if (current && sameModel(current, to)) {
    return { action: "none", reason: `already on ${to.providerID}/${to.id}`, verdict: activeVerdict };
  }

  return {
    action: "switch",
    to,
    verdict: activeVerdict,
    reason: activeVerdict ? `${activeVerdict.tier} (${activeVerdict.reason})` : `${tier} tier`,
  };
}
