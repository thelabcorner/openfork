# T9 — Spillover surfaces: composer, tooltip, manage-models, legacy list

**Goal:** No duplicate account rows survive anywhere in the app, and the selected account is
legible outside the picker.

## Context

The account label is baked into `Model.name`, so **every** surface that renders a model name
currently shows `Hunyuan 4 Preview (jack@example.com)`:

| Surface | File |
|---|---|
| Composer model trigger | `components/prompt-input.tsx` (model button label) |
| Model tooltip | `components/model-tooltip.tsx` |
| Manage models dialog | `components/dialog-manage-models.tsx` |
| Legacy v1 list | `components/dialog-select-model.tsx:169-300` (`ModelList`) |
| Fork/agent pickers | `components/dialog-fork.tsx`, subagent pickers |
| Session header / context tab | `components/session/session-header.tsx` |
| Unpaid variants | `dialog-select-model-unpaid*.tsx` |

## Steps

1. **Composer trigger.** Render `canonicalModelName(...)` plus the account chip from
   UX-SPEC §2 (same component). Truncation rules identical to the row's.
2. **`ModelTooltip`.** Add an account line when the model is account-qualified:
   "Account · dana@example.com · 71% left", using the same normalized data as the submenu.
   Keep it one line; the tooltip is already dense.
3. **`dialog-manage-models.tsx`.** Apply the same collapse: one visibility toggle per model,
   not per (model × account). Toggling the group toggles every variant. This prevents the
   nonsensical state "model visible on account A, hidden on account B" that today's UI can
   produce silently.
4. **Legacy `ModelList` (v1).** Collapse there too, using the same pure module. It has its
   own `workbuddyMaxRequests` scan (`:189-198`) — after collapsing it iterates 12 items, not
   60. If the v1 list is dead code in this build, delete it instead and say so in the PR.
5. **Fork / subagent / unpaid pickers.** They render from the same catalog; route their name
   rendering through `canonicalModelName` at minimum, and collapse where they use the shared
   controller.
6. **Session header / history.** A past message referencing `hy4-preview@wb-old` (account
   since removed) must render the canonical name, not a raw id — add the fallback path.

## Acceptance

- [ ] `grep -rn '@wb-\|@vd-' packages/app/src` shows no raw id rendered into user-visible
      text.
- [ ] Manage-models shows one toggle per model for WorkBuddy/Verdent.
- [ ] The composer shows `Hunyuan 4 Preview` + a `dana` chip when pinned, and no chip when on
      Auto.
- [ ] A message from a removed account still renders a readable model name.

## Risk

- The manage-models collapse changes the persisted visibility key space. Migrate: on load,
  if any variant of a group is hidden, treat the group as hidden and rewrite the store once
  (idempotent) — do not leave half-hidden groups.
- Some surfaces intentionally show the raw id for debugging (`model-pipeline-debug-overlay.tsx`).
  Leave those alone.
