/**
 * Validated settings for the model router plugin.
 *
 * Precedence (highest wins, field by field):
 *   1. `options` — the plugin's config object from opencode.json (`"plugins": {…}` / entry options).
 *   2. stored — user selections persisted by the TUI via plugin storage.
 *   3. built-in defaults.
 *
 * Invalid values never throw at runtime: each bad field is dropped (keeping
 * lower-precedence valid values or defaults) and is reported in `errors` so
 * the TUI can surface it.
 */

/** A model in OpenCode's `providerID/id` namespace, preserving optional variants. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  /** Optional OpenCode model variant. Omitted means the model default. */
  readonly variant?: string;
}

/** Routing mode. `off` preserves OpenCode's own model selection entirely. */
export type RouterMode = "auto" | "simple" | "complex" | "off";

/** Which classifier backend judges prompt complexity. */
export type BackendKind = "decision" | "llm";

/** What to do when the classifier fails, times out, or returns no usable verdict. */
export type FailurePolicy = "keep-current" | "complex";

/** Settings for the local decision-model backend (Ollama `/v1/systemone`, tev1). */
export interface DecisionBackendConfig {
  /** Ollama base URL, e.g. `http://127.0.0.1:11434`. A trailing `/api` is dropped before `/v1/systemone` is appended. */
  readonly baseUrl: string;
  /** Decision model name, e.g. `tev1` or `tev1:0.8b`. Must be pulled into Ollama (>= 0.35). */
  readonly model: string;
  /** Request timeout in milliseconds. The first call may load the model, so keep this generous. */
  readonly timeoutMs: number;
  /** Optional env var holding an API key; sent as `Authorization: Bearer <value>` when set and non-empty. */
  readonly apiKeyEnv?: string;
}

/** Settings for the LLM classifier backend (any connected chat model via `experimental.generate.text`). */
export interface LlmBackendConfig {
  /** Chat model used to produce the verdict, from OpenCode's connected inventory. */
  readonly model: ModelRef | null;
  /** Request timeout in milliseconds (enforced by aborting/racing the generation call). */
  readonly timeoutMs: number;
}

/** Per-agent overrides. Unset fields inherit the global setting. */
export interface AgentOverride {
  readonly mode?: RouterMode;
  readonly simpleModel?: ModelRef | null;
  readonly complexModel?: ModelRef | null;
}

/** Fully-resolved router settings. All fields always present after `resolveSettings`. */
export interface RouterSettings {
  /** Global routing mode. */
  readonly mode: RouterMode;
  /** Model used for the `simple` tier (and `simple` mode). Null until the user picks one. */
  readonly simpleModel: ModelRef | null;
  /** Model used for the `complex` tier (and `complex` mode). Null until the user picks one. */
  readonly complexModel: ModelRef | null;
  /** Active classifier backend. */
  readonly backend: BackendKind;
  /** Decision-backend settings (used when `backend === "decision"`). */
  readonly decision: DecisionBackendConfig;
  /** LLM-backend settings (used when `backend === "llm"`). */
  readonly llm: LlmBackendConfig;
  /** Failure policy for classifier errors/timeouts. `keep-current` is the safe default. */
  readonly failurePolicy: FailurePolicy;
  /** Verdicts with confidence below this (0..1) are treated as uncertain and routed complex. */
  readonly confidenceThreshold: number;
  /** Maximum characters of classifier input state (prompt + bounded recent context). */
  readonly inputBudgetChars: number;
  /** How many recent conversation turns (user+assistant each count one) to include in classifier input. */
  readonly contextTurns: number;
  /** Per-agent overrides keyed by agent ID (e.g. `build`, `plan`). */
  readonly agentOverrides: Record<string, AgentOverride>;
}

/** Partial layer returned by `parseSettingsLayer` so nested overrides do not clobber lower layers. */
export interface SettingsPatch {
  mode?: RouterMode;
  simpleModel?: ModelRef | null;
  complexModel?: ModelRef | null;
  backend?: BackendKind;
  decision?: Partial<DecisionBackendConfig>;
  llm?: Partial<LlmBackendConfig>;
  failurePolicy?: FailurePolicy;
  confidenceThreshold?: number;
  inputBudgetChars?: number;
  contextTurns?: number;
  agentOverrides?: Record<string, AgentOverride>;
}

export const MAX_INPUT_BUDGET_CHARS = 32_000;
export const MIN_INPUT_BUDGET_CHARS = 200;
export const MAX_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_CONTEXT_TURNS = 50;

/**
 * Built-in defaults. The plugin ships inert (`mode: "off"`) and without model
 * selections so it never routes until the user configures it via `/router`.
 */
export const DEFAULT_SETTINGS: RouterSettings = {
  mode: "off",
  simpleModel: null,
  complexModel: null,
  backend: "decision",
  decision: {
    baseUrl: "http://127.0.0.1:11434",
    model: "tev1",
    timeoutMs: 30_000,
  },
  llm: {
    model: null,
    timeoutMs: 20_000,
  },
  failurePolicy: "keep-current",
  confidenceThreshold: 0.5,
  inputBudgetChars: 3_000,
  contextTurns: 4,
  agentOverrides: {},
};

const MODES: readonly RouterMode[] = ["auto", "simple", "complex", "off"];
const BACKENDS: readonly BackendKind[] = ["decision", "llm"];
const FAILURE_POLICIES: readonly FailurePolicy[] = ["keep-current", "complex"];
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a candidate model reference; returns null when not a usable `{providerID, id}` pair. */
export function parseModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!providerID || !id) return null;
  const variant = typeof value.variant === "string" && value.variant.trim() ? value.variant.trim() : undefined;
  return variant ? { providerID, id, variant } : { providerID, id };
}

function parseModelRefOrNull(value: unknown): ModelRef | null {
  if (value === null || value === undefined) return null;
  return parseModelRef(value);
}

function parseBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function parseUnitInterval(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Parse one layer of raw settings (options or stored) into a partial patch.
 *
 * Invalid fields are dropped (with a diagnostic) rather than throwing, so a
 * single bad key can never take the plugin down at prompt time.
 *
 * @param raw - Unvalidated JSON (from opencode.json options or plugin storage).
 * @returns The valid portion plus human-readable diagnostics for dropped fields.
 */
export function parseSettingsLayer(raw: unknown): { patch: SettingsPatch; errors: string[] } {
  const patch: SettingsPatch = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { patch, errors };
  if (!isRecord(raw)) {
    errors.push("settings: expected an object");
    return { patch, errors };
  }

  if (raw.mode !== undefined) {
    if ((MODES as readonly string[]).includes(raw.mode as string)) patch.mode = raw.mode as RouterMode;
    else errors.push(`mode: expected one of ${MODES.join(", ")}`);
  }
  if (raw.simpleModel !== undefined) {
    const ref = parseModelRefOrNull(raw.simpleModel);
    if (ref || raw.simpleModel === null) patch.simpleModel = ref;
    else errors.push("simpleModel: expected {providerID, id} or null");
  }
  if (raw.complexModel !== undefined) {
    const ref = parseModelRefOrNull(raw.complexModel);
    if (ref || raw.complexModel === null) patch.complexModel = ref;
    else errors.push("complexModel: expected {providerID, id} or null");
  }
  if (raw.backend !== undefined) {
    if ((BACKENDS as readonly string[]).includes(raw.backend as string)) patch.backend = raw.backend as BackendKind;
    else errors.push(`backend: expected one of ${BACKENDS.join(", ")}`);
  }
  if (raw.failurePolicy !== undefined) {
    if ((FAILURE_POLICIES as readonly string[]).includes(raw.failurePolicy as string))
      patch.failurePolicy = raw.failurePolicy as FailurePolicy;
    else errors.push(`failurePolicy: expected one of ${FAILURE_POLICIES.join(", ")}`);
  }
  if (raw.confidenceThreshold !== undefined) {
    const v = parseUnitInterval(raw.confidenceThreshold);
    if (v !== null) patch.confidenceThreshold = v;
    else errors.push("confidenceThreshold: expected a finite number between 0 and 1");
  }
  if (raw.inputBudgetChars !== undefined) {
    const v = parseBoundedInt(raw.inputBudgetChars, MIN_INPUT_BUDGET_CHARS, MAX_INPUT_BUDGET_CHARS);
    if (v !== null) patch.inputBudgetChars = v;
    else errors.push(`inputBudgetChars: expected an integer between ${MIN_INPUT_BUDGET_CHARS} and ${MAX_INPUT_BUDGET_CHARS}`);
  }
  if (raw.contextTurns !== undefined) {
    const v = parseBoundedInt(raw.contextTurns, 0, MAX_CONTEXT_TURNS);
    if (v !== null) patch.contextTurns = v;
    else errors.push(`contextTurns: expected an integer between 0 and ${MAX_CONTEXT_TURNS}`);
  }

  if (raw.decision !== undefined) {
    if (isRecord(raw.decision)) {
      const d: { -readonly [K in keyof DecisionBackendConfig]?: DecisionBackendConfig[K] } = {};
      if (raw.decision.baseUrl !== undefined) {
        if (typeof raw.decision.baseUrl === "string" && isValidHttpUrl(raw.decision.baseUrl)) {
          d.baseUrl = raw.decision.baseUrl.trim();
        } else {
          errors.push("decision.baseUrl: expected a valid http(s) URL without credentials or query");
        }
      }
      if (raw.decision.model !== undefined) {
        if (typeof raw.decision.model === "string" && raw.decision.model.trim()) d.model = raw.decision.model.trim();
        else errors.push("decision.model: expected a non-empty string");
      }
      if (raw.decision.timeoutMs !== undefined) {
        const v = parseBoundedInt(raw.decision.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if (v !== null) d.timeoutMs = v;
        else errors.push(`decision.timeoutMs: expected an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
      }
      if (raw.decision.apiKeyEnv !== undefined) {
        if (typeof raw.decision.apiKeyEnv === "string" && ENV_VAR_PATTERN.test(raw.decision.apiKeyEnv.trim())) {
          d.apiKeyEnv = raw.decision.apiKeyEnv.trim();
        } else {
          errors.push("decision.apiKeyEnv: expected a valid environment variable name");
        }
      }
      if (Object.keys(d).length > 0) patch.decision = d;
    } else {
      errors.push("decision: expected an object");
    }
  }

  if (raw.llm !== undefined) {
    if (isRecord(raw.llm)) {
      const l: { -readonly [K in keyof LlmBackendConfig]?: LlmBackendConfig[K] } = {};
      if (raw.llm.model !== undefined) {
        const ref = parseModelRefOrNull(raw.llm.model);
        if (ref || raw.llm.model === null) l.model = ref;
        else errors.push("llm.model: expected {providerID, id} or null");
      }
      if (raw.llm.timeoutMs !== undefined) {
        const v = parseBoundedInt(raw.llm.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if (v !== null) l.timeoutMs = v;
        else errors.push(`llm.timeoutMs: expected an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
      }
      if (Object.keys(l).length > 0) patch.llm = l;
    } else {
      errors.push("llm: expected an object");
    }
  }

  if (raw.agentOverrides !== undefined) {
    if (isRecord(raw.agentOverrides)) {
      const overrides: Record<string, AgentOverride> = {};
      for (const [agentID, rawOverride] of Object.entries(raw.agentOverrides)) {
        if (agentID === "__proto__" || agentID === "constructor" || agentID === "prototype") {
          errors.push(`agentOverrides.${agentID}: reserved property name is not allowed`);
          continue;
        }
        if (!isRecord(rawOverride)) {
          errors.push(`agentOverrides.${agentID}: expected an object`);
          continue;
        }
        const override: { mode?: RouterMode; simpleModel?: ModelRef | null; complexModel?: ModelRef | null } = {};
        if (rawOverride.mode !== undefined) {
          if ((MODES as readonly string[]).includes(rawOverride.mode as string)) override.mode = rawOverride.mode as RouterMode;
          else errors.push(`agentOverrides.${agentID}.mode: expected one of ${MODES.join(", ")}`);
        }
        if (rawOverride.simpleModel !== undefined) {
          const ref = parseModelRefOrNull(rawOverride.simpleModel);
          if (ref || rawOverride.simpleModel === null) override.simpleModel = ref;
          else errors.push(`agentOverrides.${agentID}.simpleModel: expected {providerID, id} or null`);
        }
        if (rawOverride.complexModel !== undefined) {
          const ref = parseModelRefOrNull(rawOverride.complexModel);
          if (ref || rawOverride.complexModel === null) override.complexModel = ref;
          else errors.push(`agentOverrides.${agentID}.complexModel: expected {providerID, id} or null`);
        }
        if (Object.keys(override).length > 0) overrides[agentID] = override;
      }
      patch.agentOverrides = overrides;
    } else {
      errors.push("agentOverrides: expected an object keyed by agent ID");
    }
  }

  return { patch, errors };
}

function mergeAgentOverrides(
  base: Record<string, AgentOverride>,
  higher: Record<string, AgentOverride> | undefined,
): Record<string, AgentOverride> {
  if (!higher) return base;
  const merged: Record<string, AgentOverride> = { ...base };
  for (const [agentID, override] of Object.entries(higher)) {
    merged[agentID] = Object.hasOwn(merged, agentID) ? { ...merged[agentID], ...override } : override;
  }
  return merged;
}

/**
 * Resolve effective settings from the two config layers.
 *
 * @param options - Plugin options from opencode.json (highest precedence).
 * @param stored - User selections persisted via plugin storage.
 * @returns The fully-resolved settings plus diagnostics for anything invalid in either layer.
 */
export function resolveSettings(options: unknown, stored: unknown): { settings: RouterSettings; errors: string[] } {
  const { patch: storedPatch, errors: storedErrors } = parseSettingsLayer(stored);
  const { patch: optionsPatch, errors: optionsErrors } = parseSettingsLayer(options);

  const settings: RouterSettings = {
    ...DEFAULT_SETTINGS,
    ...storedPatch,
    ...optionsPatch,
    decision: {
      ...DEFAULT_SETTINGS.decision,
      ...(storedPatch.decision ?? {}),
      ...(optionsPatch.decision ?? {}),
    },
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...(storedPatch.llm ?? {}),
      ...(optionsPatch.llm ?? {}),
    },
    agentOverrides: mergeAgentOverrides(
      mergeAgentOverrides(DEFAULT_SETTINGS.agentOverrides, storedPatch.agentOverrides),
      optionsPatch.agentOverrides,
    ),
  };
  return { settings, errors: [...storedErrors, ...optionsErrors] };
}
