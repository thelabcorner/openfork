import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { isCodeRunTrace, type CodeRunTraceView } from "@opencode-ai/schema/v1/session"
import { SmartToolOutput } from "./tool-output"
import {
  codeAttachmentLabel,
  codeOutputLifecycle,
  codeTraceOmittedLabel,
} from "./code-tool-model"
import {
  ToolBadge,
  ToolBlock,
  ToolBoundedList,
  ToolEmpty,
  ToolLog,
  ToolNotice,
  ToolRow,
  ToolScrollArea,
  ToolStats,
  type Tone,
} from "./tool-parts"
import "./code-tool.css"

/* ── Types ─────────────────────────────────────────────────────────────────── */

type CodeAction = "search" | "describe" | "run" | "save" | "call"

type TraceFrame = CodeRunTraceView["frames"][number]
type CodeTrace = CodeRunTraceView

type SavedRef = {
  id: string
  revision: string
  handle: string
  path: string
}

type SearchCapability = {
  ref: string
  description?: string
  kind?: string
  scope?: string
  tags?: string[]
}

type SearchRunRef = {
  runID: string
  status?: string
  createdAt?: number
  calls?: { total: number; failed: number }
  summary?: string
}

type DescribeResult = {
  ref?: string
  kind?: string
  description?: string
  schema?: unknown
  executionContract?: string
}

function numStr(n: number | undefined) {
  if (n === undefined || !Number.isFinite(n)) return undefined
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`
  return `${n}ms`
}

function shortHash(hash: string | undefined) {
  if (!hash) return undefined
  return hash.slice(0, 8)
}

function refLabel(ref: string) {
  // Shorten capability refs: strip domain prefix up to last '/'
  const slash = ref.lastIndexOf("/")
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

/* ── Frame status badge ────────────────────────────────────────────────────── */

const FRAME_TONE: Record<TraceFrame["status"], Tone> = {
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "warning",
}

const FRAME_DOT: Record<TraceFrame["status"], string> = {
  running: "•",
  succeeded: "✓",
  failed: "✕",
  cancelled: "–",
}

/* ── Code header strip ─────────────────────────────────────────────────────── */

function CodeHeader(props: {
  action: CodeAction
  pending: boolean
  runID?: string
  sourceHash?: string
  error?: boolean
  saved?: SavedRef
  calls?: { total: number; failed: number }
}) {
  const actionLabel = () => {
    const labels: Record<CodeAction, string> = {
      search: "code.search",
      describe: "code.describe",
      run: "code.run",
      save: "code.save",
      call: "code.call",
    }
    return labels[props.action] ?? props.action
  }

  const statusTone = (): Tone => {
    if (props.pending) return "info"
    if (props.error) return "danger"
    return "success"
  }

  return (
    <div data-component="code-header">
      <div data-slot="code-header-left">
        <span data-slot="code-action-pill" data-tone={statusTone()}>
          {actionLabel()}
        </span>
        <Show when={props.saved}>
          {(saved) => (
            <span data-slot="code-saved-pill">
              <span data-slot="code-saved-scope">{saved().handle.split(":")[0]}/</span>
              <span data-slot="code-saved-name">{saved().id}</span>
              <span data-slot="code-saved-rev">#{saved().revision.slice(0, 6)}</span>
            </span>
          )}
        </Show>
      </div>
      <div data-slot="code-header-right">
        <Show when={props.calls && (props.calls.total > 0 || !props.pending)}>
          {(_) => (
            <span data-slot="code-calls-badge">
              <span data-slot="code-calls-total">{props.calls!.total}</span>
              <Show when={props.calls!.failed > 0}>
                <span data-slot="code-calls-sep">·</span>
                <span data-slot="code-calls-failed" data-tone="danger">
                  {props.calls!.failed} failed
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={props.runID}>
          <span data-slot="code-run-id" title={props.runID}>
            {shortHash(props.runID)}
          </span>
        </Show>
        <Show when={props.sourceHash}>
          <span data-slot="code-source-hash" title={props.sourceHash}>
            {shortHash(props.sourceHash)}
          </span>
        </Show>
      </div>
    </div>
  )
}

/* ── Code source viewer ────────────────────────────────────────────────────── */

function CodeSource(props: { code: string }) {
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => props.code.split("\n"))
  const trimmed = createMemo(() => props.code.trim())
  const lineCount = createMemo(() => lines().length)
  const preview = createMemo(() => {
    if (expanded()) return trimmed()
    const head = lines().slice(0, 12).join("\n")
    return head
  })
  const truncated = createMemo(() => !expanded() && lineCount() > 12)

  return (
    <div data-component="code-source">
      <div data-slot="code-source-header">
        <span data-slot="code-source-label">source</span>
        <span data-slot="code-source-meta">{lineCount()} lines</span>
      </div>
      <ToolScrollArea component="code-source-pre" axis="both">
        <pre data-slot="code-source-body">
          <code>{preview()}</code>
        </pre>
      </ToolScrollArea>
      <Show when={truncated()}>
        <button type="button" data-component="tool-more" onClick={() => setExpanded(true)}>
          Show {lineCount() - 12} more lines
        </button>
      </Show>
    </div>
  )
}

/* ── Capability call trace ─────────────────────────────────────────────────── */

function TraceFrameRow(props: { frame: TraceFrame; index: number }) {
  return (
    <div data-component="code-trace-frame" data-status={props.frame.status}>
      <span data-slot="code-frame-index">{props.index + 1}</span>
      <span data-slot="code-frame-dot" data-tone={FRAME_TONE[props.frame.status]}>
        {FRAME_DOT[props.frame.status]}
      </span>
      <span data-slot="code-frame-ref" title={props.frame.ref}>
        {refLabel(props.frame.ref)}
      </span>
      <Show when={props.frame.title}>
        {(title) => <span data-slot="code-frame-title">{title()}</span>}
      </Show>
      <Show when={props.frame.kind}>
        <span data-slot="code-frame-kind">{props.frame.kind}</span>
      </Show>
      <Show when={props.frame.depth > 0}>
        <span data-slot="code-frame-depth">depth {props.frame.depth}</span>
      </Show>
      <Show when={(props.frame.attachmentCount ?? 0) > 0}>
        <span data-slot="code-frame-attachments">{codeAttachmentLabel(props.frame.attachmentCount!)}</span>
      </Show>
      <Show when={props.frame.durationMs !== undefined}>
        <span data-slot="code-frame-duration">{numStr(props.frame.durationMs)}</span>
      </Show>
      <span data-slot="code-frame-status" data-tone={FRAME_TONE[props.frame.status]}>
        {props.frame.status}
      </span>
    </div>
  )
}

function CodeTrace(props: { trace: CodeTrace }) {
  const { counters, frames, truncated } = props.trace

  return (
    <div data-component="code-trace">
      {/* Counters bar */}
      <div data-slot="code-trace-counters">
        <span data-slot="code-counter" data-active={counters.calls > 0}>
          <span data-slot="code-counter-value">{counters.calls}</span>
          <span data-slot="code-counter-label">calls</span>
        </span>
        <Show when={counters.failed > 0}>
          <span data-slot="code-counter" data-tone="danger">
            <span data-slot="code-counter-value">{counters.failed}</span>
            <span data-slot="code-counter-label">failed</span>
          </span>
        </Show>
        <Show when={counters.active > 0}>
          <span data-slot="code-counter" data-tone="info">
            <span data-slot="code-counter-value">{counters.active}</span>
            <span data-slot="code-counter-label">active</span>
          </span>
        </Show>
      </div>
      {/* Frame list */}
      <Show
        when={frames.length > 0}
        fallback={<div data-slot="code-trace-empty">No capability calls recorded</div>}
      >
        <div data-slot="code-trace-frames">
          <ToolBoundedList items={frames} limit={10} scroll>
            {(frame, index) => <TraceFrameRow frame={frame} index={index} />}
          </ToolBoundedList>
        </div>
      </Show>
      <Show when={truncated?.frames}>
        {(count) => (
          <div data-slot="code-trace-truncated">{codeTraceOmittedLabel(count())}</div>
        )}
      </Show>
    </div>
  )
}

/* ── Search results ────────────────────────────────────────────────────────── */

function SearchCapabilityList(props: { items: SearchCapability[]; query?: string }) {
  return (
    <div data-component="code-search-results">
      <Show when={props.query}>
        <div data-slot="code-search-query">
          <span data-slot="code-search-query-label">query</span>
          <span data-slot="code-search-query-value">{props.query}</span>
        </div>
      </Show>
      <ToolBoundedList items={props.items} limit={8} scroll>
        {(item) => (
          <div data-component="code-search-cap">
            <div data-slot="code-search-cap-head">
              <span data-slot="code-search-cap-ref" title={item.ref}>
                {item.ref}
              </span>
              <Show when={item.kind}>
                <ToolBadge mono>{item.kind}</ToolBadge>
              </Show>
              <Show when={item.scope}>
                <ToolBadge>{item.scope}</ToolBadge>
              </Show>
            </div>
            <Show when={item.description}>
              <div data-slot="code-search-cap-desc">{item.description}</div>
            </Show>
            <Show when={item.tags?.length}>
              <div data-slot="code-search-cap-tags">
                <For each={item.tags}>{(tag) => <ToolBadge mono>{tag}</ToolBadge>}</For>
              </div>
            </Show>
          </div>
        )}
      </ToolBoundedList>
    </div>
  )
}

function SearchRunList(props: { items: SearchRunRef[] }) {
  return (
    <div data-component="code-search-runs">
      <ToolBoundedList items={props.items} limit={8} scroll>
        {(run) => (
          <ToolRow
            lead={<ToolBadge mono>{shortHash(run.runID)}</ToolBadge>}
            primary={run.summary ?? run.runID}
            mono={false}
            trailing={
              <Show when={run.calls}>
                <span data-slot="code-run-calls">
                  {run.calls!.total}
                  <Show when={run.calls!.failed > 0}>
                    <span data-tone="danger"> · {run.calls!.failed}✕</span>
                  </Show>
                </span>
              </Show>
            }
          />
        )}
      </ToolBoundedList>
    </div>
  )
}

/* ── Describe result ───────────────────────────────────────────────────────── */

function DescribePanel(props: { result: DescribeResult }) {
  const r = () => props.result
  return (
    <div data-component="code-describe">
      <Show when={r().ref}>
        <div data-slot="code-describe-ref">
          <span data-slot="code-describe-ref-label">ref</span>
          <span data-slot="code-describe-ref-value">{r().ref}</span>
          <Show when={r().kind}>
            <ToolBadge mono>{r().kind}</ToolBadge>
          </Show>
        </div>
      </Show>
      <Show when={r().description}>
        <div data-slot="code-describe-desc">{r().description}</div>
      </Show>
      <Show when={r().executionContract}>
        <div data-slot="code-describe-contract">
          <div data-slot="code-describe-contract-label">execution contract</div>
          <ToolScrollArea component="code-describe-contract-body" axis="both">
            <pre>{r().executionContract}</pre>
          </ToolScrollArea>
        </div>
      </Show>
      <Show when={r().schema}>
        <div data-slot="code-describe-schema">
          <div data-slot="code-describe-schema-label">schema</div>
          <ToolScrollArea component="code-describe-schema-body" axis="both">
            <pre>{JSON.stringify(r().schema, null, 2)}</pre>
          </ToolScrollArea>
        </div>
      </Show>
    </div>
  )
}

/* ── Save panel ────────────────────────────────────────────────────────────── */

function SavePanel(props: { saved: SavedRef; runID: string; sourceHash: string }) {
  return (
    <div data-component="code-save-panel">
      <div data-slot="code-save-badge">
        <span data-slot="code-save-icon">✓</span>
        <span data-slot="code-save-label">Saved as</span>
        <span data-slot="code-save-handle">{props.saved.handle}</span>
      </div>
      <div data-slot="code-save-meta">
        <span data-slot="code-save-meta-item">
          <span data-slot="code-save-meta-key">id</span>
          <span data-slot="code-save-meta-value">{props.saved.id}</span>
        </span>
        <span data-slot="code-save-meta-item">
          <span data-slot="code-save-meta-key">rev</span>
          <span data-slot="code-save-meta-value">{props.saved.revision.slice(0, 8)}</span>
        </span>
        <span data-slot="code-save-meta-item">
          <span data-slot="code-save-meta-key">run</span>
          <span data-slot="code-save-meta-value">{shortHash(props.runID)}</span>
        </span>
        <Show when={props.sourceHash}>
          <span data-slot="code-save-meta-item">
            <span data-slot="code-save-meta-key">src</span>
            <span data-slot="code-save-meta-value">{shortHash(props.sourceHash)}</span>
          </span>
        </Show>
      </div>
      <Show when={props.saved.path}>
        <div data-slot="code-save-path">{props.saved.path}</div>
      </Show>
    </div>
  )
}

/* ── Error panel ───────────────────────────────────────────────────────────── */

function ErrorPanel(props: { kind: string; message: string; recovery?: string }) {
  return (
    <div data-component="code-error-panel">
      <div data-slot="code-error-head">
        <ToolBadge tone="danger" mono>
          {props.kind}
        </ToolBadge>
      </div>
      <div data-slot="code-error-message">{props.message}</div>
      <Show when={props.recovery}>
        <div data-slot="code-error-recovery">
          <span data-slot="code-error-recovery-label">Recovery</span>
          <span data-slot="code-error-recovery-text">{props.recovery}</span>
        </div>
      </Show>
    </div>
  )
}

/* ── Run output panel ──────────────────────────────────────────────────────── */

function RunValuePanel(props: { value: unknown; replayable?: boolean; replayOf?: string }) {
  const [expanded, setExpanded] = createSignal(false)

  const rendered = createMemo(() => {
    const v = props.value
    if (v === undefined || v === null) return undefined
    if (typeof v === "string") return v.trim() ? v : undefined
    return JSON.stringify(v, null, 2)
  })

  const isLong = createMemo(() => (rendered()?.length ?? 0) > 800)
  const preview = createMemo(() => {
    const r = rendered()
    if (!r) return undefined
    if (expanded() || !isLong()) return r
    return r.slice(0, 800) + "\n…"
  })

  return (
    <div data-component="code-run-value">
      <div data-slot="code-run-value-header">
        <span data-slot="code-run-value-label">output</span>
        <Show when={props.replayable}>
          <ToolBadge tone="accent">replayable</ToolBadge>
        </Show>
        <Show when={props.replayOf}>
          <ToolBadge mono>replay of {shortHash(props.replayOf)}</ToolBadge>
        </Show>
      </div>
      <Show when={rendered()} fallback={<div data-slot="code-run-value-empty">—</div>}>
        <ToolScrollArea component="code-run-value-pre" axis="both">
          <pre data-slot="code-run-value-body">
            <code>{preview()}</code>
          </pre>
        </ToolScrollArea>
        <Show when={isLong() && !expanded()}>
          <button type="button" data-component="tool-more" onClick={() => setExpanded(true)}>
            Show full output
          </button>
        </Show>
      </Show>
    </div>
  )
}

/* ── Warnings panel ────────────────────────────────────────────────────────── */

function WarningsPanel(props: { warnings: { kind: string; message: string }[] }) {
  return (
    <Show when={props.warnings.length > 0}>
      <div data-component="code-warnings">
        <For each={props.warnings}>
          {(w) => (
            <div data-slot="code-warning">
              <ToolBadge tone="warning" mono>
                {w.kind}
              </ToolBadge>
              <span data-slot="code-warning-message">{w.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ── Main CodeOutput ───────────────────────────────────────────────────────── */

export interface CodeOutputProps {
  output?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  pending?: boolean
}

export function CodeOutput(props: CodeOutputProps) {
  const action = createMemo(() => {
    const a = props.metadata?.action ?? props.input?.action
    return typeof a === "string" ? (a as CodeAction) : ("run" as CodeAction)
  })

  const lifecycle = createMemo(() => codeOutputLifecycle({ output: props.output, metadata: props.metadata }))
  const parsed = createMemo(() => lifecycle().parsed)
  const trace = createMemo(() => lifecycle().trace)
  const isError = createMemo(() => lifecycle().isError)

  const runResult = createMemo(() => {
    const p = parsed()
    if (!p || p.ok !== true) return undefined
    return p as {
      ok: true
      runID: string
      sourceHash: string
      replayOf?: string
      replayable?: boolean
      value: unknown
      calls: { total: number; failed: number }
      warnings?: { kind: string; message: string }[]
      saved?: SavedRef
    }
  })

  const failureResult = createMemo(() => {
    const p = parsed()
    if (!p || p.ok !== false) return undefined
    return p as {
      ok: false
      runID: string
      error: { kind: string; message: string; recovery: string }
      calls?: { total: number; failed: number }
    }
  })

  const searchItems = createMemo(() => {
    const p = parsed()
    if (!p) return undefined
    // Capability search: array of refs or { items: [...] }
    const raw = p.items ?? p.capabilities ?? (Array.isArray(p) ? p : undefined)
    if (!Array.isArray(raw)) return undefined
    return raw as SearchCapability[]
  })

  const searchRuns = createMemo(() => {
    const p = parsed()
    if (!p) return undefined
    const raw = p.runs ?? (Array.isArray(p) && action() === "search" ? p : undefined)
    if (!Array.isArray(raw)) return undefined
    return raw as SearchRunRef[]
  })

  const describeResult = createMemo(() => {
    const p = parsed()
    if (!p || action() !== "describe") return undefined
    if (p.ok === false) return undefined
    return p as DescribeResult
  })

  const savedResult = createMemo(() => {
    const p = parsed()
    if (!p) return undefined
    if (action() === "save" && p.ok === true) {
      return p.saved as SavedRef | undefined
    }
    return undefined
  })

  const metadata = () => props.metadata as Record<string, unknown>
  const savedMeta = createMemo((): SavedRef | undefined => {
    const s = metadata()?.saved
    if (typeof s === "object" && s !== null && "id" in s) return s as SavedRef
    return undefined
  })
  const runIDMeta = createMemo(() => (typeof metadata()?.runID === "string" ? metadata()!.runID as string : undefined))
  const sourceHashMeta = createMemo(() =>
    typeof metadata()?.sourceHash === "string" ? metadata()!.sourceHash as string : undefined,
  )
  const callsMeta = createMemo(() => {
    const c = metadata()?.calls
    if (typeof c === "object" && c !== null && "total" in c) return c as { total: number; failed: number }
    return undefined
  })

  const codeInput = createMemo(() => {
    const c = props.input?.code
    return typeof c === "string" && c.trim() ? c : undefined
  })

  return (
    <div data-component="code-tool-output">
      {/* Header strip — always visible inside the expanded panel */}
      <CodeHeader
        action={action()}
        pending={props.pending ?? false}
        runID={runResult()?.runID ?? failureResult()?.runID ?? runIDMeta()}
        sourceHash={runResult()?.sourceHash ?? sourceHashMeta()}
        error={isError()}
        saved={runResult()?.saved ?? savedMeta()}
        calls={runResult()?.calls ?? failureResult()?.calls ?? callsMeta()}
      />

      {/* Trace is lifecycle data, not success-only output. Live progress and
          failed runs must render the same schema-owned bounded projection. */}
      <Show when={trace()}>
        {(t) => <CodeTrace trace={t()} />}
      </Show>

      {/* Action-specific body */}
      <Switch fallback={<Show when={props.output}>{(output) => <SmartToolOutput output={output()} />}</Show>}>
        {/* ── error path (any action) */}
        <Match when={isError() && failureResult()}>
          {(failure) => (
            <ErrorPanel
              kind={failure().error.kind}
              message={failure().error.message}
              recovery={failure().error.recovery}
            />
          )}
        </Match>

        {/* ── search: capabilities */}
        <Match when={action() === "search" && searchItems()}>
          {(items) => (
            <SearchCapabilityList
              items={items()}
              query={typeof props.input?.query === "string" ? props.input.query : undefined}
            />
          )}
        </Match>

        {/* ── search: runs */}
        <Match when={action() === "search" && searchRuns()}>
          {(runs) => <SearchRunList items={runs()} />}
        </Match>

        {/* ── describe */}
        <Match when={action() === "describe" && describeResult()}>
          {(result) => <DescribePanel result={result()} />}
        </Match>

        {/* ── save */}
        <Match when={action() === "save" && savedResult()}>
          {(saved) => (
            <SavePanel
              saved={saved()}
              runID={(parsed()?.runID as string) ?? runIDMeta() ?? ""}
              sourceHash={(parsed()?.sourceHash as string) ?? sourceHashMeta() ?? ""}
            />
          )}
        </Match>

        {/* ── run / call: success */}
        <Match when={runResult()}>
          {(result) => (
            <>
              {/* Code source (run only) */}
              <Show when={action() === "run" && codeInput()}>
                {(code) => <CodeSource code={code()} />}
              </Show>

              {/* Warnings */}
              <Show when={result().warnings?.length}>
                <WarningsPanel warnings={result().warnings!} />
              </Show>

              {/* Run value output */}
              <Show when={result().value !== undefined || !trace()}>
                <RunValuePanel
                  value={result().value}
                  replayable={result().replayable}
                  replayOf={result().replayOf}
                />
              </Show>

              {/* Save result (from inline run + save) */}
              <Show when={result().saved && action() === "run"}>
                {(_) => (
                  <SavePanel
                    saved={result().saved!}
                    runID={result().runID}
                    sourceHash={result().sourceHash}
                  />
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
