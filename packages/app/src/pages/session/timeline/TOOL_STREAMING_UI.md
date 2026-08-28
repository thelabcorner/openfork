# Agent Response Streaming — Tool Call UI Rendering

## Overview

When an agent streams a response, tool calls appear progressively in the session timeline. This document maps the complete UI component chain that renders each tool invocation, its running state, intermediate output, completion, and any error state — as the streaming response unfolds.

## Architecture at a Glance

```
Agent streaming response (SSE)
  │
  ├─ sync() store updates (useSync → global state)
  │    ├─ sync().data.messages[sessionID]    (new messages appended)
  │    ├─ sync().data.part[messageID]        (new ToolPart objects)
  │    └─ sync().data.session_status[sessionID]  (status: idle|running|error|retry)
  │
  └─ SolidJS reactivity triggers UI re-render
       │
       └─ Timeline projection layer
            │
            ├─ packages/app/src/pages/session/timeline/projection.ts
            │     (creates TimelineRow.AssistantPart rows, deduplicates tool groups)
            │
            └─ packages/app/src/pages/session/timeline/message-timeline.tsx
                  └─ renderAssistantPartGroup()  [line ~1128]
                        ├── ContextToolGroup()  (for read/grep/list context groups)
                        └── <MessagePart />     (for individual ToolPart)
                              │
                              └─ packages/session-ui/src/components/message-part.tsx
                                   └─ PART_MAPPING["tool"]  [line ~1712]
                                        ├── ToolErrorCard (for error state)
                                        └── ToolRegistry.render(toolName) ?? GenericTool
                                              (dispatches to per-tool renderers)
```

## Component Hierarchy

### 1. App-level: `message-timeline.tsx`

**File:** `packages/app/src/pages/session/timeline/message-timeline.tsx`

#### `renderAssistantPartGroup()` (line ~1128)

This is the app-level function that decides how to render each assistant part group during streaming.

- **Context groups** (`read`, `grep`, `list`): Delegates to `<ContextToolGroup>` with `busy={workingTurn && isLastGroup}`.
- **Individual tool parts**: Delegates to `<MessagePart>` (the session-ui component) with streaming props:
  - `toolOpen` / `onToolOpenChange` — persistence across virtualizer recycling
  - `deferToolContent` — defers body rendering until opened (critical for streaming perf)
  - `onContentRendered` — triggers `resizeItem` so virtualizer re-sizes the row after content appears mid-stream

#### `workingTurn()` (line ~1095)

```ts
const workingTurn = (userMessageID: string) =>
  sessionStatus().type !== "idle" && activeMessageID() === userMessageID
```

Determines whether the current turn is actively streaming. Used to:
- Set `aria-hidden` on the assistant content container (prevents screen readers from reading partial content)
- Pass `busy` to `ContextToolGroup`
- Null out `assistantCopyPartID` (disables copy button while streaming)

#### `estimateInput()` (line ~374)

Computes streaming-aware size estimates for the virtualizer:
```ts
const streaming = sessionStatus().type !== "idle" && activeMessageID() === row.userMessageID
```

---

### 2. Session-UI: `message-part.tsx`

**File:** `packages/session-ui/src/components/message-part.tsx`

#### `Part()` (line ~1610)

Generic dispatcher: looks up `PART_MAPPING[props.part.type]` and renders the matched component via `<Dynamic>`.

#### `PART_MAPPING["tool"] = ToolPartDisplay` (line ~1712)

The **central tool renderer**. For each `ToolPart`:

1. **Filters `todowrite`** — returns `null` (managed by the diff sidebar, not inline).
2. **Hides `question` while active** — `hideQuestion` memo prevents rendering until the question resolves.
3. **Error branch** (line ~1752): If `part().state.status === "error"` and error text exists → renders `<ToolErrorCard>`.
4. **Normal branch** (line ~1788): Renders via `<Dynamic component={render()}>`:
   - `render()` = `ToolRegistry.render(part().tool)` → a registered per-tool component, or falls back to `GenericTool`.
   - Passes all `ToolProps`: `input`, `output`, `status`, `defaultOpen`, `open`, `onOpenChange`, `deferContent`, `virtualizeDiff`, `onContentRendered`.

#### `ToolRegistry` (line ~1671)

A simple registry mapping tool names to renderer components:

```ts
export const ToolRegistry = {
  register: registerTool,   // stores { name, render? } in internal state map
  render: getTool,          // returns render fn, or undefined → GenericTool
}
```

**Name aliasing:** `getTool` maps `apply_patch` → `"patch"` and `bash` → `"shell"`.

#### Registered Tool Renderers

| Tool name(s) | File/Location (line in message-part.tsx) | Component | Streaming behavior |
|---|---|---|---|
| `read` | 2131 | `BasicTool` + file/code viewer | Shows shimmer title while pending; renders file content viewer after completion |
| `list` | 2204 | `BasicTool` + `SmartToolOutput` | Shimmer title; output as prose/markdown |
| `glob` | 2220 | `BasicTool` + `GlobResults` | Shimmer title; structured file list after completion |
| `grep` | 2243 | `BasicTool` + `GrepResults` | Shimmer title; parsed grep results after completion |
| `webfetch` | 2269 | `BasicTool` | Custom trigger with URL link; shimmer while running |
| `websearch` | 2315 | `BasicTool` + `ExaOutput` | Provider label as title; shimmer while running |
| `task` | 2342 | `BasicTool` (custom trigger) | Custom card with agent color + spinner; navigates to subagent session |
| `shell` / `bash` | 2449 | `ShellTool` component | Terminal-style output with ANSI stripping, timer, stop button |
| `write` | ~2760 | `BasicTool` + file viewer | File diff/content viewer |
| `edit` | ~2960 | `BasicTool` + file diff viewer | Inline diff with `virtualizeDiff` support |
| `apply_patch` | ~3015 | `BasicTool` + `ToolFileAccordion` | Per-file accordion with diff views |
| `sympy` | ~3060 | `BasicTool` + `SympyOutput` | LaTeX rendering |
| `sqlite` | ~3110 | `BasicTool` + `SqliteTool` | Table results viewer |
| `git` | ~3160 | `GitTool` | Commit/branch info |
| `compression` | ~3180 | `BasicTool` + `SmartToolOutput` | Decompressed file list |
| `question` | ~3200 | `BasicTool` (hidden while running) | Renders only when non-pending |
| `patch` | (via `apply_patch` alias) | see `apply_patch` | — |

**Fallback:** `GenericTool` (in `basic-tool.tsx` line 342) — renders any unregistered tool with a default trigger, JSON input viewer, and `SmartToolOutput` for output.

---

### 3. Base Tool Wrapper: `basic-tool.tsx`

**File:** `packages/session-ui/src/components/basic-tool.tsx`

#### `BasicTool` (line ~99)

The collapsible container used by nearly all tool renderers. Key streaming behaviors:

- **`pending()`** = `props.status === "pending" || "running"`
- **`TextShimmer` on title** (line 224): Shimmering text effect on the tool trigger title while pending/running.
- **Deferred content mount** (line 311): `Show when={!props.defer || ready()}` — content body is NOT mounted until the tool is opened. This prevents rendering heavy diff viewers / file components for collapsed tools mid-stream.
- **`scheduleDeferredMount`** (line 85): Staggered mounting of deferred content — uses `requestAnimationFrame` chaining so heavy default-open tools (like shell output with large diffs) mount top-to-bottom and become interactive incrementally rather than blocking the main thread.
- **Animated height** (line 165): `motion` package spring animation on expand/collapse.
- **`Collapsible.Arrow`** (line 271): Chevron icon that animates on open/close.

#### `GenericTool` (line ~342)

Fallback for unregistered tools:
- Icon: `"brain"`
- Title: i18n `ui.basicTool.called` with tool name
- Subtitle: extracted from input (looks for `description`, `query`, `url`, `filePath`, `path`, `pattern`, `name` fields)
- Args: remaining input fields as `key=value` chips
- Body: JSON input viewer (`CodeView`) + `SmartToolOutput` for output

---

### 4. Streaming-specific UI Elements

| File | Component | Role during streaming |
|------|-----------|----------------------|
| `packages/session-ui/src/components/tool-output.tsx` | `SmartToolOutput` | Renders tool `output` string — if JSON, shows in a syntax-highlighted code viewer; otherwise renders as Markdown. Updates reactively as `props.output` changes mid-stream. |
| `packages/session-ui/src/components/tool-error-card.tsx` | `ToolErrorCard` | Renders error state with close icon, error title, copy button, and collapsible error body. Triggered when `part().state.status === "error"`. |
| `packages/session-ui/src/components/message-part.tsx` | `PacedMarkdown` (line 343) | Text output with pacing animation (`streaming` prop). Uses `Markdown` component with incremental text reveal. |
| `packages/session-ui/src/components/markdown.tsx` | `Markdown` | Core markdown renderer with `streaming` prop that controls text reveal animation and layout stabilization. |
| `packages/ui/src/text-shimmer.tsx` | `TextShimmer` | CSS shimmer animation over text — used on tool titles and status labels while the tool is `pending`/`running`. |
| `packages/ui/src/text-reveal.tsx` | `TextReveal` | Typewriter-style text reveal — used for reasoning headings and thinking status. |

---

### 5. Context Tool Groups

**File:** `packages/session-ui/src/components/message-part.tsx`, `ContextToolGroup()` (line ~1136)

During streaming, context-gathering tools (`read`, `grep`, `list`) are batched into collapsible groups:

- **`pending()`** checks all parts: `parts.some((part) => part.state.status === "pending" || "running")`
- **`ToolStatusTitle`**: Animated status label showing "Gathering context…" (active) → "Gathered context" (done) with shimmer + width-swap animation.
- **`AnimatedCountList`**: Dynamic count badges for read/search/list operations that update as parts complete mid-stream.
- Each context tool within the group renders as an individual item with its own trigger, streaming status, and output content.

---

### 6. Legacy vs. New Timeline

There are two parallel timeline implementations:

| | Legacy | New (V2) |
|---|---|---|
| File | `packages/session-ui/src/components/session-turn.tsx` | `packages/app/src/pages/session/timeline/message-timeline.tsx` |
| Component | `SessionTurn` + `AssistantParts` | `MessageTimeline` + `renderTimelineRow` + `renderAssistantPartGroup` |
| Parts rendering | `session-turn.tsx` lines 409-421 (`<AssistantParts>`) | `message-timeline.tsx` line 1128 (`renderAssistantPartGroup`) |
| Tool rendering | Same `message-part.tsx` `PART_MAPPING["tool"]` | Same `message-part.tsx` `PART_MAPPING["tool"]` |

Both use the same underlying `message-part.tsx` tool rendering pipeline — only the layout/scaffolding differs.

---

## Key Data Flow During Streaming

```
1. SSE event arrives with partial message content
   ├─ sync().data.messages[sessionID] updated with new/updated AssistantMessage
   ├─ sync().data.part[messageID] updated with new ToolPart (status: "pending")
   └─ sync().data.session_status[sessionID] = { type: "running", ... }

2. SolidJS reactivity triggers
   ├─ createTimelineProjection() recomputes timeline rows
   │   └─ TimelineRow.AssistantPart rows created/updated
   ├─ MessageTimeline re-renders virtualizer items
   └─ renderAssistantPartGroup() called for each AssistantPart row

3. During streaming (status: "pending" or "running")
   ├─ <BasicTool> shows TextShimmer on title
   ├─ <ToolStatusTitle> shows "gathering" animation (context groups)
   ├─ Content body deferred (deferToolContent)
   └─ aria-hidden prevents screen reader interference

4. Tool completes (status: "completed")
   ├─ <BasicTool> shows done title (shimmer stops)
   ├─ Content body mounts on open
   ├─ SmartToolOutput renders parsed output
   └─ Context group counts increment

5. Tool errors (status: "error")
   └─ <ToolErrorCard> renders with error message + copy button
```

---

## ToolProps Interface

The streaming state is communicated via the `ToolProps` interface (message-part.tsx line ~1633):

```ts
export interface ToolProps {
  input: Record<string, any>         // tool invocation arguments
  metadata: Record<string, any>      // tool metadata (sessionId for task, provider for websearch, etc.)
  tool: string                       // tool name (e.g. "shell", "read", "webfetch")
  sessionID?: string                 // session ID (for task tool navigation, shell stop)
  callID?: string                    // tool call ID (for shell stop)
  output?: string                    // tool output (appended during streaming)
  status?: string                    // "pending" | "running" | "completed" | "error"
  hideDetails?: boolean              // hide the collapsible arrow/details
  defaultOpen?: boolean              // initially expanded
  open?: boolean                     // controlled open state
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean             // defer body mount until opened
  virtualizeDiff?: boolean           // virtualize large diffs
  onContentRendered?: () => void     // notify parent (for resize)
  forceOpen?: boolean                // force-open the collapsible
  locked?: boolean                   // prevent closing
}
```

The `status` prop is the primary signal that drives streaming visual states across all tool renderers.
