---
title: Model router knowledge history
tags: [log, model-routing]
sourceRefs: [https://opencode.ai/docs/build/plugins/server]
lastReviewed: 2026-11-26
---

# Model router knowledge history

## [2026-11-25] ingest | OpenCode model router

Recorded preliminary package state and acceptance criteria in [[entities/model-router]].

## [2026-11-25] ingest | Cross-provider routing execution boundaries

Corrected the earlier idle FIFO assumption using the queued-input timing experiment. [[concepts/cross-provider-routing-boundaries]] records why idle-session switching is proven but safe queued/steering cross-provider routing remains an open gate.

## [2026-11-25] ingest | Serialized admission investigation approved

The user selected isolated investigation of holding busy-session submissions until execution ends. Recorded scope and outstanding safety checks in [[concepts/cross-provider-routing-boundaries]]. No production serialization behavior or core changes are approved by this investigation alone.

## [2026-11-26] ingest | Runtime implementation and controlled load

Implemented server, RPC, TUI, FIFO serialized admission, compatibility checks, and mocked cross-provider integration coverage. `tsc --noEmit` and 38 unit/integration tests pass. Controlled OpenCode V2 location activation reports server, TUI, and RPC features active; `getSettings` and `listModels` RPC smoke calls succeeded while routing remained off. See [[entities/model-router]] and [[concepts/cross-provider-routing-boundaries]].

## [2026-11-26] ingest | TUI interaction smoke

Added mocked `/router` interaction coverage for command registration, palette/slash exposure, cost-bearing model selection, safe persistence without enabling mode, cloud-classifier confirmation cancellation, and session status rendering. Suite now has 44 passing tests.

## [2026-11-26] ingest | Hot reload and child-session stress

A busy-session plugin touch exposed missed terminal delivery; waiting admissions now reconcile `SessionInfo.outcome` and `updated`. The repeated reload+queue run passed with `serialized: true`. A forked child session using agent `general` completed independently on the configured simple model.

## [2026-11-26] ingest | Queue interruption and compaction stress

Verified real `delivery: queue` serialization after an interrupted execution on OpenCode 2.4.1. P2 admission followed P1 interrupted idle by about one second, then completed on the simple model. Compaction preserved the selected model and did not update router status. Routing restored to `off`.

## [2026-11-26] ingest | OpenCode 2.4.1 live cross-provider smoke

After user-authorized environment upgrade and minimal paid smoke, controlled location loading succeeded on OpenCode 2.4.1. Real assistant records proved `ia_appliance → ollama`, `ollama → github-copilot`, and `github-copilot → ollama`. Routing was restored to `off` in the isolated location. See [[entities/model-router]] and [[concepts/cross-provider-routing-boundaries]].
