---
title: OpenCode model router
tags: [plugin, routing, server, tui, v2]
sourceRefs: [package.json, README.md, src/index.ts, src/rpc.ts, src/tui.tsx, src/config.ts, src/models.ts, src/classifiers, src/routing, src/model-refresh.ts, src/settings-store.ts, tests/index.integration.test.ts, .opencode/wiki/concepts/cross-provider-routing-boundaries.md]
lastReviewed: 2026-11-26
---

# OpenCode model router

Standalone OpenCode V2 plugin that routes admitted prompts to configured simple and complex models, including across providers. It supports local `/v1/systemone` and selected LLM classification, validated settings, cost-aware TUI selection, serialized busy-session admission, compatibility checks, and typed RPC status/settings.

## Distribution

Hosted publicly at `https://github.com/bcarreira-talkdesk/opencode-model-router` (`main`). Not published to npm; install by pointing `opencode.json` at the checkout path. `node_modules/`, `dist/`, and `.env*` are git-ignored.

## Verification status

- Exact runtime/API target: **OpenCode 2.4.1 / `@opencode/plugin 2.4.1`**.
- `tsc --noEmit` passes.
- **44 unit/integration/TUI tests across 13 suites** pass.
- Controlled package load on OpenCode 2.4.1 reports server, TUI, and RPC features active.
- `getSettings`, `updateSettings`, `listModels`, and `getStatus` RPC smoke checks succeeded.
- Live same-session routing confirmed `ia_appliance/qwen3-coder-next` → `ollama/gemma4:12b`; the assistant record used `ollama/gemma4:12b` and returned `SIMPLE_SMOKE_OK`.
- User-authorized paid smoke confirmed `ollama/gemma4:12b` → `github-copilot/gpt-6-luna`; the assistant record used `github-copilot/gpt-6-luna` and returned `COMPLEX_SMOKE_OK`.
- Live return `github-copilot/gpt-6-luna` → `ollama/gemma4:12b` completed; the assistant record used `ollama/gemma4:12b` and returned `RETURN_SIMPLE_OK`.
- Routing in the isolated location was restored to `off` after the authorized smoke.

## Runtime constraints

Busy-session prompts are serialized in the awaited prompt hook. This avoids changing the model beneath later steps of an active prompt, but deliberately changes steering/queue overlap into FIFO admission behavior. Exact `session.inbox.delivered` and `session.inbox.cancelled` identities are correlated per message.

Remote plaintext decision endpoints are rejected; decision fetch redirects fail; prompt history is bounded; model compatibility is checked; invalid inventory generations are retried/rejected; plugin storage mutations are serialized and transactional in memory. OpenCode RPC is treated as the trusted local/server boundary; arbitrary remote exposure remains an operator concern.

## Remaining acceptance matrix

Live cross-provider routing is proven. Queue/interruption, compaction, hot-reload recovery, and child-session isolation also passed. The `/router` dialog and sidebar are confirmed in the real TUI: every TUI RPC call must pass `{ location: context.location }`, otherwise the command registers but the dialog never opens. Remaining stress coverage is simultaneous steering races, continuation classification count, and user model-picker ownership/restoration. Routing state is per-location; see [[../concepts/cross-provider-routing-boundaries]].
