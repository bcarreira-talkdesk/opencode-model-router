/**
 * Pure compatibility checks used before the router selects a model.
 *
 * A target must be selectable, support tools when the active request requires
 * them, accept every attached modality, and have enough reported context for
 * the estimated input. Unknown metadata fails closed for required tools and
 * modalities; the router never invents capabilities or mutates the prompt.
 */

import type { ModelRef } from "../config.js";
import type { RouterModelInfo } from "../models.js";
import { modelKey } from "../models.js";

/** Requirements inferred from an admitted prompt and its bounded recent context. */
export interface RoutingRequirements {
  /** Whether OpenCode must expose tools to the model for this request. */
  readonly requiresTools: boolean;
  /** Input modalities carried by attachments (for example `image`). */
  readonly modalities: readonly string[];
  /** Approximate input-token count; deliberately conservative (`chars / 4`). */
  readonly estimatedInputTokens: number;
}

/** A compatible model, or the reason compatibility failed. */
export type CompatibilityResult =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

/**
 * Validate that a target model can safely serve a prompt.
 *
 * @param ref - The selected routing target.
 * @param inventory - Current OpenCode model inventory for the location.
 * @param requirements - Prompt-derived tools/modalities/token estimate.
 * @returns A success marker or a concise human-readable failure reason.
 */
export function checkCompatibility(
  ref: ModelRef,
  inventory: readonly RouterModelInfo[],
  requirements: RoutingRequirements,
): CompatibilityResult {
  const model = inventory.find((candidate) => candidate.providerID === ref.providerID && candidate.id === ref.id);
  if (!model) return { compatible: false, reason: `${modelKey(ref)} is not available in this location` };
  if (model.enabled === false) return { compatible: false, reason: `${modelKey(ref)} is disabled` };

  const capabilities = model.capabilities;
  if (requirements.requiresTools && capabilities?.tools !== true) {
    return { compatible: false, reason: `${modelKey(ref)} tool capability is unavailable or unsupported` };
  }
  if (requirements.modalities.length > 0) {
    if (!capabilities?.input) {
      return { compatible: false, reason: `${modelKey(ref)} input capabilities are unknown` };
    }
    const accepted = new Set(capabilities.input.map((value) => value.toLowerCase()));
    const missing = requirements.modalities.find((modality) => !accepted.has(modality.toLowerCase()));
    if (missing) return { compatible: false, reason: `${modelKey(ref)} does not accept ${missing} input` };
  }

  const limit = model.limit?.input ?? model.limit?.context;
  if (limit !== undefined && limit > 0 && requirements.estimatedInputTokens > limit) {
    return {
      compatible: false,
      reason: `${modelKey(ref)} input limit is ${limit} tokens (estimated ${Math.ceil(requirements.estimatedInputTokens)})`,
    };
  }

  return { compatible: true };
}

/**
 * Infer coarse input modalities from attachment names or URI extensions.
 * This is intentionally conservative and never reads attachment contents.
 */
export function inferModalities(fileNames: readonly string[]): string[] {
  const modalities = new Set<string>();
  for (const name of fileNames) {
    const normalized = name.toLowerCase().split(/[?#]/, 1)[0];
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/.test(normalized)) modalities.add("image");
    else if (/\.(wav|mp3|m4a|aac|ogg|flac|opus)$/.test(normalized)) modalities.add("audio");
    else if (/\.(mp4|mov|m4v|avi|webm|mkv)$/.test(normalized)) modalities.add("video");
  }
  return [...modalities];
}
