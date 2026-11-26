/**
 * Model inventory helpers shared by the server (picker data, compatibility
 * checks) and the TUI (cost display).
 *
 * Costs come from OpenCode's model metadata: an array of USD-per-million-token
 * entries, optionally split into context tiers. Missing cost data is rendered
 * as "unknown" — never invented. Zero prices are labeled as a reported catalog
 * price rather than guaranteed free usage. List prices are what providers
 * publish; subscription plans (e.g. GitHub Copilot) may bill differently,
 * which the TUI footer calls out.
 */

/** One cost entry. Prices are USD per million tokens. */
export interface ModelCostTier {
  /** Present when the price only applies below a context size (tokens). */
  readonly tier?: { readonly type: "context"; readonly size: number };
  readonly input: number;
  readonly output: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** Structural subset of OpenCode's `Model.Info` used by the router. */
export interface RouterModelInfo {
  readonly providerID: string;
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly cost?: readonly ModelCostTier[];
  readonly capabilities?: {
    readonly tools?: boolean;
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
}

/** Format one non-negative USD-per-million-tokens amount for display. */
function fmtMoney(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value === 0) return "0";
  const fixed = value.toFixed(value < 0.1 ? 4 : value < 1 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
}

/** Format a context-tier size compactly, e.g. 200000 -> "200k". */
function fmtContextSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "?";
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(size % 1_000_000 ? 1 : 0)}M`;
  if (size >= 1_000) return `${Math.round(size / 1_000)}k`;
  return String(size);
}

function isZeroTier(tier: ModelCostTier): boolean {
  const cacheZero = !tier.cache || (tier.cache.read === 0 && tier.cache.write === 0);
  return tier.input === 0 && tier.output === 0 && cacheZero;
}

function tierLabel(tier: ModelCostTier): string {
  return `${tier.tier ? `≤${fmtContextSize(tier.tier.size)}: ` : "base: "}${formatCostTier(tier)}`;
}

/**
 * Format the cost of one model tier for display.
 *
 * @param tier - Cost entry from model metadata.
 * @returns A string like `$0.25 / $1.00 per Mtok` with a cache suffix when
 *   cache pricing is non-zero and differs from the base prices, e.g.
 *   `($0.03 read · $0.30 write)`.
 */
export function formatCostTier(tier: ModelCostTier): string {
  const base = `$${fmtMoney(tier.input)} / $${fmtMoney(tier.output)} per Mtok`;
  const cache = tier.cache;
  if (cache && Number.isFinite(cache.read) && Number.isFinite(cache.write) && cache.read >= 0 && cache.write >= 0) {
    const interesting =
      (cache.read > 0 || cache.write > 0) && (cache.read !== tier.input || cache.write !== tier.output);
    if (interesting) return `${base} ($${fmtMoney(cache.read)} read · $${fmtMoney(cache.write)} write)`;
  }
  return base;
}

/**
 * Compact one-line cost for a model, for picker rows.
 *
 * - No cost data at all -> `unknown`.
 * - All-zero catalog prices -> `$0 / $0 per Mtok (catalog)` (never labeled "free").
 * - Multiple context tiers -> every tier in provider/catalog order with its threshold.
 *
 * @param model - Model metadata (cost may be missing or empty).
 */
export function formatCost(model: Pick<RouterModelInfo, "cost">): string {
  const cost = model.cost;
  if (!cost || cost.length === 0) return "unknown";

  const tiers = [...cost];
  if (!tiers.every((tier) => Number.isFinite(tier.input) && tier.input >= 0 && Number.isFinite(tier.output) && tier.output >= 0 && tier.cache && Number.isFinite(tier.cache.read) && tier.cache.read >= 0 && Number.isFinite(tier.cache.write) && tier.cache.write >= 0)) return "unknown";
  if (tiers.length === 1) {
    if (isZeroTier(tiers[0])) return "$0 / $0 per Mtok (catalog)";
    return formatCostTier(tiers[0]);
  }

  return tiers.map(tierLabel).join(" · ");
}

/**
 * Human-readable model label: the display name, falling back to the bare ID
 * (with a leading `providerID/` prefix stripped when present).
 */
export function modelLabel(model: RouterModelInfo): string {
  const prefix = `${model.providerID}/`;
  const bare = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
  return model.name || bare || "unknown";
}

/** Stable `providerID/id` key for a model. Never split on `/` since `id` may contain slashes. */
export function modelKey(model: Pick<RouterModelInfo, "providerID" | "id">): string {
  return `${model.providerID}/${model.id}`;
}

/** True when provider/model and normalized variant match (`undefined` == `"default"`). */
export function sameModel(
  a: (Pick<RouterModelInfo, "providerID" | "id"> & { variant?: string }) | null | undefined,
  b: (Pick<RouterModelInfo, "providerID" | "id"> & { variant?: string }) | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "default") === (b.variant ?? "default");
}

/**
 * Project OpenCode's generated `ModelInfo` into the router's small inventory
 * shape. `modelID` is the bare request identifier accepted by
 * `session.switchModel`; `info.id` may be a provider/model display composite.
 *
 * @param info - One item from `ctx.model.list()`.
 */
export function projectModelInfo(info: {
  providerID: string;
  id: string;
  modelID: string;
  name?: string;
  enabled?: boolean;
  cost?: readonly ModelCostTier[];
  capabilities?: RouterModelInfo["capabilities"];
  limit?: RouterModelInfo["limit"];
}): RouterModelInfo {
  return {
    providerID: info.providerID,
    id: info.modelID || info.id,
    name: info.name,
    enabled: info.enabled,
    cost: info.cost,
    capabilities: info.capabilities,
    limit: info.limit,
  };
}

/**
 * Whether a model is usable as a routing target: enabled (when the flag is
 * present) and not explicitly disabled.
 */
export function isSelectable(model: RouterModelInfo): boolean {
  return model.enabled !== false;
}
