export * as BrowserShared from "./shared"

import { BrowserError, type BrowserErrorClass } from "@opencode-ai/core/browser/host-broker"
import { Schema } from "effect"
import {
  A11yNode,
  AnnotateInput,
  AnnotateOutput,
  AnnotationTarget,
  AnnotationTone,
  BrowserErrorTag,
  BrowserState,
  BrokerError,
  BrokerRequest,
  BrokerResponse,
  ClickInput,
  ClickOutput,
  CloseInput,
  CloseOutput,
  Coords,
  ElementSelector,
  ElementState,
  ElementTarget,
  EvaluateInput,
  EvaluateOutput,
  HighlightInput,
  HighlightOutput,
  HostCapabilities,
  HostEvent,
  HostGuestState,
  HostHello,
  HostHelloReply,
  HostRegistration,
  HostRegistrationInfo,
  Locator,
  NavigateInput,
  NavigateOutput,
  OpenInput,
  OpenOutput,
  PressInput,
  PressOutput,
  ProfilerResult,
  ProfilerStartInput,
  ProfilerStartOutput,
  ProfilerStopInput,
  ProfilerStopOutput,
  QueryInput,
  QueryOutput,
  QueryMatch,
  RecordingStartInput,
  RecordingStartOutput,
  RecordingStopInput,
  RecordingStopOutput,
  Rect,
  RefTarget,
  ResizeInput,
  ResizeOutput,
  ResolvedTarget,
  ScrollInput,
  ScrollOutput,
  SelectorConfidence,
  SetAppearanceInput,
  SetAppearanceOutput,
  ScreenshotInput,
  ScreenshotOutput,
  SnapshotElement,
  SnapshotInput,
  SnapshotOutput,
  SnapshotRef,
  StatusInput,
  StatusOutput,
  TypeInput,
  TypeOutput,
  Viewport,
  WaitForCondition,
  WaitForInput,
  WaitForOutput,
  type BrowserOperationName,
} from "@opencode-ai/protocol/groups/browser"

/**
 * Tool-facing shared schemas for the `browser_*` tool surface.
 *
 * These re-export the wire shapes from `@opencode-ai/protocol/groups/browser`
 * (the single source of truth) and add the tool-layer conveniences: the
 * per-operation input/output schema maps (typed dispatch), the permission
 * family map, the error-tag → model-facing prose map, and helpers used by
 * every tool's `ctx.ask` and result rendering.
 */

export {
  A11yNode,
  AnnotateInput,
  AnnotateOutput,
  AnnotationTarget,
  AnnotationTone,
  BrowserErrorTag,
  BrowserState,
  BrokerError,
  BrokerRequest,
  BrokerResponse,
  ClickInput,
  ClickOutput,
  CloseInput,
  CloseOutput,
  Coords,
  ElementSelector,
  ElementState,
  ElementTarget,
  EvaluateInput,
  EvaluateOutput,
  HighlightInput,
  HighlightOutput,
  HostCapabilities,
  HostEvent,
  HostGuestState,
  HostHello,
  HostHelloReply,
  HostRegistration,
  HostRegistrationInfo,
  Locator,
  NavigateInput,
  NavigateOutput,
  OpenInput,
  OpenOutput,
  PressInput,
  PressOutput,
  ProfilerResult,
  ProfilerStartInput,
  ProfilerStartOutput,
  ProfilerStopInput,
  ProfilerStopOutput,
  QueryInput,
  QueryOutput,
  QueryMatch,
  RecordingStartInput,
  RecordingStartOutput,
  RecordingStopInput,
  RecordingStopOutput,
  Rect,
  RefTarget,
  ResizeInput,
  ResizeOutput,
  ResolvedTarget,
  ScrollInput,
  ScrollOutput,
  SelectorConfidence,
  SetAppearanceInput,
  SetAppearanceOutput,
  ScreenshotInput,
  ScreenshotOutput,
  SnapshotElement,
  SnapshotInput,
  SnapshotOutput,
  SnapshotRef,
  StatusInput,
  StatusOutput,
  TypeInput,
  TypeOutput,
  Viewport,
  WaitForCondition,
  WaitForInput,
  WaitForOutput,
}
export type { BrowserOperationName }
export { BrowserError }
export type { BrowserErrorClass }

/** Typed input schema per operation — the tool `Parameters` for each tool. */
export const OperationInput = {
  status: StatusInput,
  open: OpenInput,
  navigate: NavigateInput,
  resize: ResizeInput,
  set_appearance: SetAppearanceInput,
  snapshot: SnapshotInput,
  screenshot: ScreenshotInput,
  click: ClickInput,
  type: TypeInput,
  press: PressInput,
  scroll: ScrollInput,
  evaluate: EvaluateInput,
  wait_for: WaitForInput,
  recording_start: RecordingStartInput,
  recording_stop: RecordingStopInput,
  close: CloseInput,
  query: QueryInput,
  highlight: HighlightInput,
  annotate: AnnotateInput,
  profiler_start: ProfilerStartInput,
  profiler_stop: ProfilerStopInput,
}

/** Typed output schema per operation — validates the host's success object. */
export const OperationOutput = {
  status: StatusOutput,
  open: OpenOutput,
  navigate: NavigateOutput,
  resize: ResizeOutput,
  set_appearance: SetAppearanceOutput,
  snapshot: SnapshotOutput,
  screenshot: ScreenshotOutput,
  click: ClickOutput,
  type: TypeOutput,
  press: PressOutput,
  scroll: ScrollOutput,
  evaluate: EvaluateOutput,
  wait_for: WaitForOutput,
  recording_start: RecordingStartOutput,
  recording_stop: RecordingStopOutput,
  close: CloseOutput,
  query: QueryOutput,
  highlight: HighlightOutput,
  annotate: AnnotateOutput,
  profiler_start: ProfilerStartOutput,
  profiler_stop: ProfilerStopOutput,
}

export type OperationName = keyof typeof OperationInput

export type OperationInputOf<Name extends OperationName> = (typeof OperationInput)[Name]["Type"]
export type OperationOutputOf<Name extends OperationName> = (typeof OperationOutput)[Name]["Type"]

/** Default host-side timeout per operation (ms). Tools override via timeoutMs?. */
export const DEFAULT_TIMEOUT_MS: Record<OperationName, number> = {
  status: 10_000,
  snapshot: 30_000,
  screenshot: 30_000,
  open: 30_000,
  navigate: 30_000,
  resize: 10_000,
  set_appearance: 10_000,
  click: 15_000,
  type: 15_000,
  press: 15_000,
  scroll: 15_000,
  evaluate: 15_000,
  wait_for: 30_000,
  recording_start: 15_000,
  recording_stop: 15_000,
  close: 10_000,
  query: 15_000,
  highlight: 15_000,
  annotate: 15_000,
  profiler_start: 10_000,
  profiler_stop: 10_000,
}

/** Permission family per operation (design §5 + premium amendment). */
export type BrowserFamily = "browser.read" | "browser.navigate" | "browser.interact" | "browser.evaluate" | "browser.record"

export const FAMILY: Record<OperationName, BrowserFamily> = {
  status: "browser.read",
  snapshot: "browser.read",
  screenshot: "browser.read",
  query: "browser.read",
  profiler_start: "browser.read",
  profiler_stop: "browser.read",
  open: "browser.navigate",
  navigate: "browser.navigate",
  close: "browser.navigate",
  resize: "browser.interact",
  set_appearance: "browser.interact",
  click: "browser.interact",
  type: "browser.interact",
  press: "browser.interact",
  scroll: "browser.interact",
  wait_for: "browser.interact",
  highlight: "browser.interact",
  annotate: "browser.interact",
  evaluate: "browser.evaluate",
  recording_start: "browser.record",
  recording_stop: "browser.record",
}

/** Model-facing prose for each broker error tag (tool `output` on failure). */
export const ERROR_MESSAGE: Record<Schema.Schema.Type<typeof BrowserErrorTag>, string> = {
  BrowserHostUnavailable:
    "No live Desktop browser host is registered for this session. The browser panel may be closed, or the app reconnected. Call browser_status to check, and browser_open to (re)create the guest.",
  BrowserProtocolMismatch:
    "The Desktop host speaks a different broker protocol version. The host must re-register; ask the user to restart the browser panel.",
  BrowserTabNotFound:
    "The requested tab does not exist (or the guest has no active tab). Call browser_open to create a tab first.",
  BrowserGuestCrashed: "The browser guest crashed. Call browser_open to recreate it.",
  BrowserControlInterrupted:
    "Browser control was interrupted (the user took over, a newer host connection superseded this one, or the operation was aborted). Re-snapshot and retry.",
  BrowserInvalidSelector:
    "The locator could not be parsed. Rewrite the selector (valid CSS, XPath, or a supported locator type).",
  BrowserTargetNotFound:
    "The target matched no element (or the element is not actionable). Re-snapshot and retry with a fresh ref or locator from the snapshot.",
  BrowserTimeout: "The browser operation timed out. Retry, possibly with a longer timeoutMs or a smaller operation.",
  BrowserResultTooLarge:
    "The result exceeded the size cap. Narrow the request (maxDepth, smaller script, or fewer elements).",
  BrowserDebuggerConflict:
    "The CDP debugger is unavailable (guest is being inspected or the debugger is attached elsewhere).",
  BrowserUnsupportedOperation: "This Desktop host does not support the operation (missing capability).",
  BrowserPermissionDenied: "Permission to perform this browser action was denied. The action was not executed.",
  BrowserNotAttached: "The guest exists but no page is attached. Call browser_open to attach a page.",
  BrowserOperationFailed: "The browser operation failed. See the error details; retry may help.",
  BrowserStaleRefError:
    "The element reference is stale — the page changed since the snapshot it came from. Re-snapshot and retry with the new ref.",
  BrowserNotAReactAppError:
    "The page is not a React application, so React profiling is unavailable. Profiling only reports render-count approximations, never wall-clock timing.",
}

/**
 * Map a decoded `BrokerResponse` error arm (or a broker-detected failure) onto
 * a typed `BrowserErrorClass` with model-facing prose.
 */
export function toBrowserError(error: { tag: Schema.Schema.Type<typeof BrowserErrorTag>; message: string; retryable: boolean; details?: unknown }): BrowserErrorClass {
  return BrowserError.make(error.tag, error)
}

/**
 * Permission pattern for a tool's `ctx.ask`. Navigate/open use the target URL's
 * origin; everything else uses `"*"` (the active tab's origin is only known
 * after a status/snapshot round-trip, so family-wide rules apply for v1).
 */
export function permissionPattern(operation: OperationName, url?: string): string {
  if (url && (operation === "open" || operation === "navigate")) {
    try {
      return new URL(url).origin
    } catch {
      return "*"
    }
  }
  return "*"
}

export function formatViewport(viewport: Schema.Schema.Type<typeof Viewport>): string {
  return `${viewport.width}x${viewport.height}@${viewport.dpr}x scroll(${viewport.scrollX},${viewport.scrollY})`
}

export function formatTarget(target: Schema.Schema.Type<typeof ResolvedTarget>): string {
  const parts: string[] = []
  if (target.ref !== undefined) parts.push(`ref ${target.ref}`)
  if (target.selector !== undefined) parts.push(`selector [${target.selector.kind}] ${target.selector.value} (${target.selector.confidence})`)
  if (target.tagName !== undefined) parts.push(`<${target.tagName}>`)
  if (target.role !== undefined) parts.push(`role=${target.role}`)
  if (target.name !== undefined) parts.push(`name=${target.name}`)
  if (target.rect !== undefined) {
    parts.push(`rect (${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.width)}x${Math.round(target.rect.height)})`)
  }
  if (target.center !== undefined) parts.push(`center (${target.center.x},${target.center.y})`)
  return parts.length > 0 ? parts.join(" ") : "unresolved target"
}
