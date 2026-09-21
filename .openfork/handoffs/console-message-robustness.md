# Handoff: Robust `console-message` handling in Electron main process

## Context

File: `packages/desktop/src/main/windows.ts` (around line 462)

The desktop app listens for renderer console messages to log PTY/terminal activity:

```ts
win.webContents.on("console-message", (event, ...legacy) => {
  const level = event.level ?? legacy[0]
  const message = event.message ?? legacy[1]
  const line = event.lineNumber ?? legacy[2]
  const sourceId = event.sourceId ?? legacy[3]
  if (message?.toLowerCase().includes("terminal") || sourceId?.toLowerCase().includes("terminal")) {
    writeLog("pty", "console", { window: name, level, message, line, sourceId })
  }
})
```

## The problem

Electron's `webContents.on("console-message")` event has TWO signatures, and the installed runtime emits one or the other depending on version:

1. **New (current typings, Electron 42 in `electron.d.ts`)**: `listener: (details: Event<WebContentsConsoleMessageEventParams>) => void` — the message fields (`message`, `level`, `lineNumber`, `sourceId`) are spread directly onto the event object.

2. **Legacy (deprecated, still emitted by older binaries)**: `listener: (event, level, message, line, sourceId) => void` — message fields are positional args.

Our first attempt used only the new object-signature and crashed at runtime:

```
TypeError: Cannot read properties of undefined (reading 'toLowerCase')
    at WebContents.<anonymous> (...:17)
```

because the running binary was emitting the legacy positional form, so `details.message` was `undefined`.

The current fix uses `??`-based fallback to support both forms at once. It works, but it's hacky: it assumes `level`/`message`/`sourceId` are mutually exclusive between the two shapes, and it can't reliably tell WHICH form fireed. It's fragile.

## What we want you to research

Find the most robust way to handle this event across Electron versions, so it never crashes and always extracts the right fields. Investigate and report on:

1. **Version reality check**
   - Which Electron version does this repo actually installed and where? (Check `packages/desktop/package.json`, root `package.json`, lockfile.) The `.d.ts` we read resolved to `electron@42.3.3`. Confirm what's actually shipped.
   - Since when / until when did Electron support the object form vs. the positional-args form? Was the object form introduced in a specific major version (e.g. v30+)? Is the positional form fully removed in 42, or still emitted under some condition?
   - Is the deprecation warning ("'console-message' arguments are deprecated... use Event<WebContentsConsoleMessageEventParams> instead") a reliable signal that the NEW form is active? I.e., if we see the warning, can we rely on the object form?

2. **How to reliably detect the emitted shape** (this is the core question)
   - What is the authoritative way to distinguish "new object form" from "legacy positional form" at runtime?
   - Is `typeof (arg) === 'number'` on the first post-event arg a sound discriminator (level is a string in new form, but the first legacy positional arg `level` is a *string* too — check types)? Is `lineNumber`-vs-`line` or presence of `message` on the event object a better discriminator?
   - Does Electron document a recommended migration / capability gate? Look for an `app` or `webContents` API that tells you which emission style is active, or whether there's a feature flag / `app.commandLine` switch.

3. **Best-practice patterns**
   - How do the Electron docs and its own `electron.d.ts` recommend consuming the event in the target version?
   - Is there a cleaner single-shape approach if we pin/upgrade the Electron version rather than supporting both? What version would "just work" with only the object form?
   - Does `sniffing` (checking for the deprecation warning once at startup to set a form flag) offer a cleaner, one-time branch instead of per-event `??`?

4. **Testing**
   - How can we verify the handler against BOTH shapes deterministically in this repo (unit test that invokes the listener with each shape, or a runtime trigger)? What's the existing test setup for `packages/desktop`?
   - How can we confirm the fix on a real build (the `bun run dev` flow per `packages/desktop/AGENTS.md`)?

## Required output

Deliver a short report (not code) that:
- States definitively which Electron version(s) must be supported and which emission shape each uses.
- Recommends ONE robust handling strategy (or a small number of clearly-ranked options) with the exact discriminator to use and why it's safe.
- Gives the exact TypeScript-typed handler shape that would replace the current `??` hack with confidence (typed, not loose), if one is warranted.
- Notes any pure-type-system / version-pin alternative that removes the dual-shape problem entirely.
- Points to concrete Electron docs/sources (links + quote the relevant lines) backing each claim.

Do not make changes to the repo. This is research only — return the report.

## Priority / constraints

- Correctness across the versions we actually ship matters most (never crash, never drop a terminal log).
- Prefer a solution that won't break when we bump Electron.
- Keep it minimal — this is one small event handler, not an abstraction layer.
