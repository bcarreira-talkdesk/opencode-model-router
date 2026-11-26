---
title: Cross-provider routing execution boundaries
tags: [opencode-v2, cross-provider, queue, lifecycle, verified]
sourceRefs: [https://opencode.ai/docs/build/plugins/server, ../opencode-session-usage/node_modules/@opencode/plugin/dist/promise/session.d.ts, src/routing/admission.ts, tests/index.integration.test.ts]
lastReviewed: 2026-11-26
---

# Cross-provider routing execution boundaries

OpenCode 2.3.2 proved that model selection is resolved per step and that queued prompts could execute inside the prior prompt. A session switch during active work can therefore affect later steps. The router uses awaited busy-session admission to avoid that hazard at the cost of serializing queue/steering overlap.

## Serialized admission evidence

The isolated V2.3.2 probe held P2 in its prompt-admission hook while P1 ran. P1 succeeded at `1795654158369`; P2's hook returned at `1795654158370`; P2 was durably admitted at `1795654160182`; a new execution began at `1795654160198`. An 8-second idle-session hook delay also preceded durable message admission, confirming callbacks are awaited.

The production implementation correlates exact `session.inbox.delivered` / `session.inbox.cancelled` `inboxID` values to prompt `messageID`, releases one FIFO waiter, and fails closed on stream loss. Settings/agent changes invalidate a waiting prompt rather than allowing stale classification.

## OpenCode 2.4.1 live verification

The package was loaded in a controlled location as an active server/TUI/RPC plugin. With routing scoped to one test session:

| Route | Persisted switch | Assistant record | Text |
| --- | --- | --- | --- |
| initial → simple | `ia_appliance/qwen3-coder-next` → `ollama/gemma4:12b` | `ollama/gemma4:12b` | `SIMPLE_SMOKE_OK` |
| simple → complex | `ollama/gemma4:12b` → `github-copilot/gpt-6-luna` | `github-copilot/gpt-6-luna` | `COMPLEX_SMOKE_OK` |
| complex → simple | `github-copilot/gpt-6-luna` → `ollama/gemma4:12b` | `ollama/gemma4:12b` | `RETURN_SIMPLE_OK` |

After verification, routing was returned to `off`; selected role models remain persisted only for the isolated PoC location.

This proves the happy-path cross-provider `simple → complex → simple` sequence and model identity on assistant records. A live OpenCode 2.4.1 stress run additionally proved that P2 submitted with `delivery: queue` during P1 was not admitted until P1 was interrupted: P1 idle `1795660462165`, P2 user admission `1795660463179` (about 1.0 s later). P2 completed successfully on `ollama/gemma4:12b` and returned `STRESS_P2_OK`; the assistant record stayed on the simple provider. A later compaction ran on the already-selected `ollama/gemma4:12b` without changing router status.

Hot reload while busy was then stress-tested: a touch of the plugin during P1 first exposed a missed terminal event and a P2 120-second timeout. The implementation was changed to reconcile waiting admissions from `SessionInfo.outcome`/`updated`; the repeated run admitted P2 after the boundary with status `serialized: true`, without HTTP 500 or timeout. A forked child session using agent `general` completed independently on `ollama/gemma4:12b`.

Remaining acceptance checks are simultaneous steering races, continuation classification counts, and TUI click-through. Routing was restored to `off` in the isolated location after stress testing.
