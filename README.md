# opencode-model-router

Standalone OpenCode V2 plugin that routes each admitted user prompt to a configured **simple** or **complex** chat model. The models may come from different providers. Complexity is judged by either a local Ollama `/v1/systemone` decision model or a stateless LLM selected from OpenCode's connected inventory.

## Status and compatibility

- Tested runtime/API target: OpenCode V2.4.1 with `@opencode/plugin@2.4.1`.
- Plugin peer dependency: `@opencode/plugin 2.4.1` (no untested compatibility range is claimed).
- TypeScript and unit/integration tests pass. The package also loaded successfully in an isolated OpenCode 2.4.1 location with server, TUI, and RPC active; `getSettings` and `listModels` RPC smoke tests succeeded while routing remained off.

### Queued/steering prompts

OpenCode V2.3.2 can process queued prompts inside the previous prompt's execution. A `session.switchModel` during that execution can affect the previous prompt's later tool-driven steps. The router therefore **serializes busy-session admission** in the prompt hook: a second prompt is held until the current execution reaches a terminal boundary, then classified and switched before its own execution starts.

This changes queue/steering responsiveness: a late prompt no longer interrupts or joins the active model execution. A switch is never applied mid-execution.

## Install as a local package

No npm publishing is required. Add the absolute package path to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-model-router",
      "options": {
        "mode": "off",
        "simpleModel": { "providerID": "ollama", "id": "qwen3:8b" },
        "complexModel": { "providerID": "github-copilot", "id": "gpt-6-luna" },
        "backend": "decision",
        "decision": {
          "baseUrl": "http://127.0.0.1:11434",
          "model": "tev1",
          "timeoutMs": 30000
        }
      }
    }
  ]
}
```

The package starts with `mode: "off"`. Use `/router` in the TUI (or **Model router** in the command palette) to choose models and turn routing on.

## Settings

The effective value is merged field-by-field as:

1. plugin `options` (highest precedence)
2. persisted TUI selections
3. built-in defaults

Relevant settings:

- `mode`: `auto`, `simple`, `complex`, or `off` (`manual/off` semantics)
- `simpleModel`, `complexModel`: `{ providerID, id }` OpenCode model references
- `backend`: `decision` or `llm`
- `decision`: `baseUrl`, `model`, `timeoutMs`, optional `apiKeyEnv`
- `llm`: selected `{ model, timeoutMs }`
- `failurePolicy`: `keep-current` (default) or `complex`
- `confidenceThreshold`, `inputBudgetChars`, `contextTurns`
- `agentOverrides`: mode and model pair overrides by agent ID

Nested option fields override only the fields they explicitly provide. Invalid fields are reported through the TUI and do not clobber valid lower-precedence values.

## Classifier backends

### Local decision model

The router posts a bounded state to `${baseUrl}/v1/systemone`; a trailing `/api` is stripped. The body is kept below 64 KiB in UTF-8. If `apiKeyEnv` is set, its environment value is used as a bearer token only for HTTPS or loopback HTTP endpoints.

Uncertainty, `undecided`, and low confidence route to `complex`. Redirects are rejected and remote plaintext HTTP is not allowed. The endpoint must run a compatible Ollama version and have the configured decision model available.

### Selected LLM

The TUI selects any enabled chat model in OpenCode's connected inventory. Classification is a no-session `experimental.generate.text` call and must return a small strict JSON verdict. Timeouts abort the request. There is no silent backend fallback when the local backend fails.

## Model compatibility and prices

Before switching, the router verifies:

- provider/model availability and enabled state
- tool capability (conservatively required)
- input modality compatibility for image/audio/video attachments
- reported input/context token limit against a conservative character estimate

The picker displays OpenCode-published USD per million input/output tokens, cache read/write rates, and multiple context tiers. Missing metadata is **unknown**, never treated as zero or free. A `$0 / $0 per Mtok (catalog)` value is a reported catalog price, not a guarantee of zero real-world cost.

Subscription plans, including some GitHub Copilot plans, may bill differently from published token list prices. The plugin does not promise savings or estimate a per-prompt bill.

## Privacy and logging

Prompt text and attachment contents are not logged or stored. Attachment names/URIs and a configurable bounded recent transcript are sent to the selected classifier backend. The local decision backend remains local only when its URL is local. Selecting a cloud LLM classifier explicitly sends classification text to that model's provider.

Classifier errors are shortened and sanitized. Raw HTTP bodies and model response content are not included in persisted status.

## Development

```bash
npm install
npm run typecheck
npm test
```

The current unit suite covers settings, models/prices, both classifier backends, bounded state, routing policy, compatibility, and serialized admission.
