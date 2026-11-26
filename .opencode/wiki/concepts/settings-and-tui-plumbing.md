---
title: Settings precedence and TUI plumbing
tags: [opencode-v2, configuration, tui, rpc, gotcha]
sourceRefs: [src/config.ts, src/settings-store.ts, src/tui.tsx, src/rpc.ts, https://opencode.ai/docs/build/plugins/server, node_modules/@opencode/plugin/dist/tui/context.d.ts]
lastReviewed: 2026-11-26
---

# Settings precedence and TUI plumbing

Two settings paths reach the router — plugin `options` in `opencode.json` and settings persisted through the TUI/RPC. They are not peers, and the TUI talks to the server through a location-scoped RPC endpoint.

## Plugin options win over saved settings

A value set in the plugin's `options` block is a config layer that overrides what the TUI persisted. A leftover `"mode": "off"` therefore makes the sidebar keep reporting `off` after the user selects `auto`, and the picker looks like it failed to save.

- Leave `options: {}` when the user should control routing from `/router`.
- Use `options` only for values that must be pinned per location (for example an enforced `mode`).
- Settings persisted by the store are location-scoped, so a different directory starts from defaults.

## TUI RPC calls need the context location

Every RPC call from the TUI must pass the current location explicitly:

```ts
await router.getSettings({}, context.location ? { location: context.location } : undefined);
```

Without it the call targets an unavailable/default location: the `/router` key and palette entry still register, but the dialog never opens and no error surfaces. Failures are now wrapped so the command shows an error toast instead of failing silently.

## Dialog row layout

`DialogSelectOption` renders `title`, then `description`, then `footer`, and a narrow terminal truncates each field independently. Putting prices in the `footer` hid them behind the billing disclaimer.

- `title`: model display name only.
- `description`: price plus model id.
- Billing caveat belongs in the dialog `title`, not per-row `footer`.
- `unknown` price is rendered literally as `unknown`; it is never displayed as free.

Related: [[../entities/model-router]], [[cross-provider-routing-boundaries]].
