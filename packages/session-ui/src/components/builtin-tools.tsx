import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Markdown } from "./markdown"
import { SmartToolOutput } from "./tool-output"
import {
  ToolBadge,
  ToolBlock,
  ToolBoundedList,
  ToolEmpty,
  ToolFields,
  ToolLog,
  ToolNotice,
  ToolPath,
  ToolRow,
  ToolStats,
  type Tone,
} from "./tool-parts"

/**
 * Renderers for built-in tools.
 *
 * Every tool in here previously fell through to `GenericTool`, which printed
 * the raw input as JSON above a markdown blob. That is fine for third-party MCP
 * tools whose shape we can't know, but for our own tools we know the output
 * format exactly — so parse it and show the thing the user actually wants.
 *
 * Each parser degrades to `SmartToolOutput` when the shape doesn't match, so a
 * server-side format change downgrades the presentation instead of breaking it.
 */

/* ── Shared XML helpers ──────────────────────────────────────────────────── */

function unescapeXml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function tagText(source: string, name: string) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(source)
  return match ? unescapeXml(match[1]!.trim()) : undefined
}

function tagBlocks(source: string, name: string) {
  const out: { attrs: Record<string, string>; inner: string }[] = []
  for (const match of source.matchAll(new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g"))) {
    const attrs: Record<string, string> = {}
    for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
    out.push({ attrs, inner: match[2]! })
  }
  return out
}

function selfClosing(source: string, name: string) {
  const match = new RegExp(`<${name}([^>]*)\\/>`).exec(source)
  if (!match) return undefined
  const attrs: Record<string, string> = {}
  for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
  return attrs
}

/** Drops the trailing agent-facing hint paragraphs from a tool's output. */
function withoutHints(text: string) {
  return text
    .split("\n")
    .filter((line) => !/^(Use |Re-save |Try:|Stored\.|Superseded )/.test(line.trim()))
    .join("\n")
    .trim()
}

function bytes(value: number) {
  if (!Number.isFinite(value)) return ""
  const units = ["B", "KB", "MB", "GB"]
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/* ── Memory ──────────────────────────────────────────────────────────────── */

type MemoryEntry = {
  id?: string
  status?: string
  topic?: string
  kind?: string
  origin?: string
  scope?: string
  title?: string
  summary?: string
  score?: string
  updated?: string
  evidence?: string
}

function memoryEntry(attrs: Record<string, string>, inner: string): MemoryEntry {
  return {
    id: attrs.id,
    status: attrs.status,
    score: attrs.score,
    topic: tagText(inner, "topic"),
    kind: tagText(inner, "kind"),
    origin: tagText(inner, "origin"),
    scope: tagText(inner, "scope"),
    title: tagText(inner, "title"),
    summary: tagText(inner, "summary"),
    updated: tagText(inner, "updated"),
    evidence: selfClosing(inner, "evidence")?.count,
  }
}

function MemoryEntryRow(props: { entry: MemoryEntry }) {
  const e = () => props.entry
  return (
    <div data-component="memory-entry">
      <div data-slot="memory-entry-head">
        <span data-slot="memory-entry-title">{e().title ?? e().topic ?? e().id}</span>
        <Show when={e().score}>
          <ToolBadge tone="accent">{e().score}</ToolBadge>
        </Show>
        <Show when={e().status && e().status !== "active"}>
          <ToolBadge tone="warning">{e().status}</ToolBadge>
        </Show>
      </div>
      <Show when={e().summary}>
        <div data-slot="memory-entry-summary">{e().summary}</div>
      </Show>
      <div data-slot="memory-entry-meta">
        <Show when={e().topic}>
          <ToolBadge mono>{e().topic}</ToolBadge>
        </Show>
        <Show when={e().kind}>
          <ToolBadge>{e().kind}</ToolBadge>
        </Show>
        <Show when={e().scope}>
          <ToolBadge>{e().scope}</ToolBadge>
        </Show>
        <Show when={e().origin}>
          <ToolBadge>{e().origin}</ToolBadge>
        </Show>
        <Show when={e().evidence && e().evidence !== "0"}>
          <ToolBadge>{`${e().evidence} evidence`}</ToolBadge>
        </Show>
      </div>
    </div>
  )
}

export function MemoryOutput(props: { output: string }) {
  const i18n = useI18n()

  const stored = createMemo(() => {
    const blocks = tagBlocks(props.output, "memory")
    if (!blocks.length) return undefined
    return memoryEntry(blocks[0]!.attrs, blocks[0]!.inner)
  })

  const search = createMemo(() => {
    const blocks = tagBlocks(props.output, "memory-search")
    if (!blocks.length) return undefined
    const head = blocks[0]!
    return {
      query: head.attrs.query,
      hits: tagBlocks(head.inner, "hit").map((h) => memoryEntry(h.attrs, h.inner)),
    }
  })

  const emptySearch = createMemo(() => selfClosing(props.output, "memory-search"))
  const emptyMap = createMemo(() => selfClosing(props.output, "memory-map"))
  const forgotten = createMemo(() => selfClosing(props.output, "memory-forgotten"))

  const remainder = createMemo(() => withoutHints(props.output.replace(/<[^>]+>[\s\S]*?<\/[^>]+>|<[^>]+\/>/g, "")))

  return (
    <Show
      when={stored() || search() || emptySearch() || emptyMap() || forgotten()}
      fallback={<SmartToolOutput output={props.output} />}
    >
      <Show when={stored()}>{(entry) => <MemoryEntryRow entry={entry()} />}</Show>

      <Show when={search()}>
        {(result) => (
          <>
            <ToolStats
              items={[
                { label: i18n.t("ui.tool.memory.stat.results"), value: String(result().hits.length) },
              ]}
            />
            <ToolBlock label={result().query}>
              <ToolBoundedList items={result().hits} limit={5}>
                {(hit) => <MemoryEntryRow entry={hit} />}
              </ToolBoundedList>
            </ToolBlock>
          </>
        )}
      </Show>

      <Show when={forgotten()}>
        {(attrs) => (
          <ToolEmpty>
            <ToolBadge tone="warning">{i18n.t("ui.tool.memory.forgotten")}</ToolBadge> {attrs().id}
          </ToolEmpty>
        )}
      </Show>

      <Show when={(emptySearch() || emptyMap()) && remainder()}>
        <ToolEmpty>{remainder()}</ToolEmpty>
      </Show>
    </Show>
  )
}

/* ── Session ─────────────────────────────────────────────────────────────── */

type SessionMessage = {
  id?: string
  role?: string
  agent?: string
  model?: string
  text?: string
  createdAt?: number
  completedAt?: number
}

export function SessionOutput(props: { output: string }) {
  const i18n = useI18n()

  const parsed = createMemo(() => {
    const trimmed = props.output.trim()
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return undefined
    try {
      return JSON.parse(trimmed) as Record<string, any>
    } catch {
      return undefined
    }
  })

  const messages = createMemo<SessionMessage[]>(() => {
    const value = parsed()?.messages
    return Array.isArray(value) ? value : []
  })

  const duration = (m: SessionMessage) =>
    m.createdAt && m.completedAt ? `${((m.completedAt - m.createdAt) / 1000).toFixed(1)}s` : undefined

  return (
    <Show when={parsed()} fallback={<SmartToolOutput output={props.output} />}>
      {(data) => (
        <>
          <ToolFields
            items={[
              ...(data().sessionId
                ? [{ key: i18n.t("ui.tool.session.field.session"), value: data().sessionId as string, mono: true }]
                : []),
              ...(data().status?.type
                ? [
                    {
                      key: i18n.t("ui.tool.session.field.status"),
                      value: (<ToolBadge tone={data().status.type === "busy" ? "warning" : "success"}>{data().status.type}</ToolBadge>) as any,
                    },
                  ]
                : []),
            ]}
          />
          <Show when={messages().length > 0}>
            <ToolBlock label={i18n.t("ui.tool.session.messages")} trailing={String(messages().length)}>
              <ToolBoundedList items={messages()} limit={4}>
                {(message) => (
                  <div data-component="session-message">
                    <div data-slot="session-message-head">
                      <ToolBadge tone={message.role === "assistant" ? "accent" : "neutral"}>{message.role}</ToolBadge>
                      <Show when={message.agent}>
                        <ToolBadge>{message.agent}</ToolBadge>
                      </Show>
                      <Show when={message.model}>
                        <span data-slot="session-message-model">{message.model}</span>
                      </Show>
                      <Show when={duration(message)}>
                        <span data-slot="session-message-duration">{duration(message)}</span>
                      </Show>
                    </div>
                    <Show when={message.text}>
                      <div data-slot="session-message-text">{message.text}</div>
                    </Show>
                  </div>
                )}
              </ToolBoundedList>
            </ToolBlock>
          </Show>
        </>
      )}
    </Show>
  )
}

/* ── Project ─────────────────────────────────────────────────────────────── */

type TreeNode = { depth: number; label: string; meta?: string }

const TREE_LINE = /^(\s*)(.+?)\s*(?:\((\d[\d,]*\s+files?,\s*[\d.]+\s*\wB)\))?\s*$/

export function ProjectOutput(props: { output: string }) {
  const nodes = createMemo<TreeNode[]>(() => {
    const lines = props.output.split("\n").filter((line) => line.trim())
    const out: TreeNode[] = []
    for (const line of lines) {
      const match = TREE_LINE.exec(line)
      if (!match) continue
      const label = match[2]!.trim()
      // Prose lines (the "no manifest detected" preamble) aren't tree nodes.
      if (!label.endsWith("/") && !match[3] && !/^[\w.\-@]+$/.test(label)) continue
      out.push({ depth: Math.floor(match[1]!.length / 2), label, meta: match[3] })
    }
    return out
  })

  const preamble = createMemo(() => {
    const first = props.output.split("\n").find((line) => line.trim())
    return first && !nodes().some((n) => n.label === first.trim()) ? first.trim() : undefined
  })

  return (
    <Show when={nodes().length > 0} fallback={<SmartToolOutput output={props.output} />}>
      <Show when={preamble()}>
        <ToolEmpty>{preamble()}</ToolEmpty>
      </Show>
      <ToolBoundedList items={nodes()} limit={14} scroll>
        {(node) => (
          <ToolRow
            primary={
              <span style={{ "padding-left": `${node.depth * 12}px` }}>
                <span data-slot="project-node" data-dir={node.label.endsWith("/") ? "true" : undefined}>
                  {node.label}
                </span>
              </span>
            }
            trailing={node.meta}
          />
        )}
      </ToolBoundedList>
    </Show>
  )
}

/* ── Browser ─────────────────────────────────────────────────────────────── */

export function BrowserOutput(props: { output: string }) {
  /** Browser tools emit `k=v; k=v` preambles followed by free-form lines. */
  const parsed = createMemo(() => {
    const lines = props.output.split("\n")
    const fields: { key: string; value: string }[] = []
    const rest: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/^[\w .-]+=[^;]*(;|$)/.test(trimmed)) {
        for (const part of trimmed.split(";")) {
          const [key, ...value] = part.split("=")
          if (!key || !value.length) {
            if (part.trim()) rest.push(part.trim())
            continue
          }
          fields.push({ key: key.trim(), value: value.join("=").trim() })
        }
        continue
      }
      rest.push(trimmed)
    }
    return { fields, rest }
  })

  return (
    <Show when={parsed().fields.length > 0} fallback={<SmartToolOutput output={props.output} />}>
      <ToolFields
        items={parsed().fields.map((field) => ({
          key: field.key,
          value:
            field.value === "true" || field.value === "false" ? (
              <ToolBadge tone={field.value === "true" ? "success" : "neutral"}>{field.value}</ToolBadge>
            ) : (
              field.value
            ),
          mono: field.value.length > 20,
        }))}
      />
      <Show when={parsed().rest.length > 0}>
        <ToolBlock>
          <For each={parsed().rest}>{(line) => <ToolRow primary={line} mono={false} />}</For>
        </ToolBlock>
      </Show>
    </Show>
  )
}

/* ── Webfetch ────────────────────────────────────────────────────────────── */

export function WebfetchOutput(props: { output: string; input?: Record<string, any> }) {
  const i18n = useI18n()
  const [full, setFull] = createSignal(false)

  const url = createMemo(() => (typeof props.input?.url === "string" ? props.input.url : undefined))
  const host = createMemo(() => {
    const value = url()
    if (!value) return undefined
    try {
      return new URL(value.startsWith("http") ? value : `https://${value}`).host
    } catch {
      return undefined
    }
  })

  const size = createMemo(() => bytes(props.output.length))
  const words = createMemo(() => props.output.split(/\s+/).filter(Boolean).length)
  const preview = createMemo(() => (full() ? props.output : props.output.slice(0, 1200)))
  const truncated = createMemo(() => !full() && props.output.length > 1200)

  return (
    <>
      <ToolStats
        items={[
          { label: i18n.t("ui.tool.webfetch.stat.size"), value: size() },
          { label: i18n.t("ui.tool.webfetch.stat.words"), value: words().toLocaleString() },
          ...(typeof props.input?.format === "string"
            ? [{ label: i18n.t("ui.tool.webfetch.stat.format"), value: props.input.format as string }]
            : []),
        ]}
      />
      <Show when={host()}>
        <ToolBlock>
          <ToolRow
            lead={<span data-slot="webfetch-scheme">{url()!.startsWith("https") ? "\u{1F512}" : ""}</span>}
            primary={host()!}
            secondary={url()}
            trailing={
              <a data-slot="webfetch-open" href={url()} target="_blank" rel="noreferrer">
                {i18n.t("ui.tool.webfetch.open")}
              </a>
            }
          />
        </ToolBlock>
      </Show>
      <ToolBlock label={i18n.t("ui.tool.webfetch.content")}>
        <div data-component="webfetch-content">
          <Markdown text={preview()} />
        </div>
        <Show when={truncated()}>
          <button type="button" data-component="tool-more" onClick={() => setFull(true)}>
            {i18n.t("ui.tool.webfetch.showFull", { size: size() })}
          </button>
        </Show>
      </ToolBlock>
    </>
  )
}

/* ── Symbols ─────────────────────────────────────────────────────────────── */

type SymbolHit = { name: string; kind?: string; file?: string; line?: string }

export function SymbolsOutput(props: { output: string }) {
  const hits = createMemo<SymbolHit[]>(() => {
    const out: SymbolHit[] = []
    for (const line of props.output.split("\n")) {
      // `name  kind  path:line`
      const match = /^\s*(\S+)\s+(?:\[(\w+)\]\s+)?(.+?):(\d+)\s*$/.exec(line)
      if (!match) continue
      out.push({ name: match[1]!, kind: match[2], file: match[3], line: match[4] })
    }
    return out
  })

  return (
    <Show when={hits().length > 0} fallback={<SmartToolOutput output={props.output} />}>
      <ToolBoundedList items={hits()} limit={12} scroll>
        {(hit) => (
          <ToolRow
            lead={<Show when={hit.kind}>{(kind) => <ToolBadge>{kind()}</ToolBadge>}</Show>}
            primary={hit.name}
            secondary={<ToolPath path={hit.file ?? ""} />}
            trailing={hit.line}
          />
        )}
      </ToolBoundedList>
    </Show>
  )
}

/* ── Test ────────────────────────────────────────────────────────────────────
   `test` carries the richest metadata of any builtin (passed/failed/skipped/
   durationMs/harness), so the headline needs no parsing at all — only the
   failure list and tail come from the XML body. */

type TestFailure = { file?: string; line?: string; name?: string; detail?: string }

export function TestOutput(props: { output: string; metadata?: Record<string, unknown> }) {
  const i18n = useI18n()
  const [showTail, setShowTail] = createSignal(false)

  const num = (key: string) => {
    const value = props.metadata?.[key]
    return typeof value === "number" ? value : undefined
  }

  const run = createMemo(() => tagBlocks(props.output, "test-run")[0])
  const list = createMemo(() => tagBlocks(props.output, "test-list")[0])

  const failures = createMemo<TestFailure[]>(() => {
    const inner = run()?.inner ?? ""
    return [...inner.matchAll(/<failure\s([^>]*)\/>/g)].map((match) => {
      const attrs: Record<string, string> = {}
      for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
      return { file: attrs.file, line: attrs.line, name: attrs.name, detail: attrs.detail }
    })
  })

  const tail = createMemo(() => tagText(run()?.inner ?? "", "tail"))

  const files = createMemo(() =>
    [...(list()?.inner ?? "").matchAll(/<file\spath="([^"]*)"\s*\/>/g)].map((m) => unescapeXml(m[1]!)),
  )

  const duration = () => {
    const ms = num("durationMs")
    return ms === undefined ? undefined : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }

  const stats = createMemo(() => {
    const items: { label: string; value: string; tone?: Tone }[] = []
    const passed = num("passed")
    const failed = num("failed")
    const skipped = num("skipped")
    if (passed !== undefined)
      items.push({ label: i18n.t("ui.tool.test.passed"), value: String(passed), tone: "success" })
    if (failed) items.push({ label: i18n.t("ui.tool.test.failed"), value: String(failed), tone: "danger" })
    if (skipped) items.push({ label: i18n.t("ui.tool.test.skipped"), value: String(skipped), tone: "warning" })
    const d = duration()
    if (d) items.push({ label: i18n.t("ui.tool.test.duration"), value: d })
    return items
  })

  return (
    <Show when={run() || list()} fallback={<SmartToolOutput output={props.output} />}>
      <Show when={list()}>
        <ToolBlock label={i18n.t("ui.tool.test.files")} trailing={String(files().length)}>
          <ToolBoundedList items={files()} limit={12} scroll>
            {(file) => <ToolRow primary={<ToolPath path={file} />} truncate="start" />}
          </ToolBoundedList>
        </ToolBlock>
      </Show>

      <Show when={run()}>
        <Show when={stats().length > 0}>
          <ToolStats items={stats()} />
        </Show>
        <Show when={failures().length > 0}>
          <ToolBlock label={i18n.t("ui.tool.test.failures")} trailing={String(failures().length)}>
            <ToolBoundedList items={failures()} limit={8} scroll>
              {(failure) => (
                <div data-component="test-failure">
                  <ToolRow
                    lead={
                      <ToolBadge tone="danger" mono>
                        FAIL
                      </ToolBadge>
                    }
                    primary={failure.name ?? "(unnamed)"}
                    mono={false}
                    trailing={failure.line}
                  />
                  <Show when={failure.file}>
                    <div data-slot="test-failure-file">
                      <ToolPath path={failure.file!} />
                    </div>
                  </Show>
                  <Show when={failure.detail}>
                    <div data-slot="test-failure-detail">{failure.detail}</div>
                  </Show>
                </div>
              )}
            </ToolBoundedList>
          </ToolBlock>
        </Show>
        <Show when={tail()}>
          <ToolBlock>
            <Show
              when={showTail()}
              fallback={
                <button type="button" data-component="tool-more" onClick={() => setShowTail(true)}>
                  {i18n.t("ui.tool.test.showOutput")}
                </button>
              }
            >
              <pre data-component="tool-pre">{tail()}</pre>
            </Show>
          </ToolBlock>
        </Show>
      </Show>
    </Show>
  )
}

/* ── Monitor ─────────────────────────────────────────────────────────────── */

export function MonitorOutput(props: { output: string }) {
  const i18n = useI18n()
  const block = createMemo(() => tagBlocks(props.output, "monitor")[0])

  return (
    <Show when={block()} fallback={<SmartToolOutput output={props.output} />}>
      {(monitor) => (
        <ToolFields
          items={[
            {
              key: i18n.t("ui.tool.monitor.state"),
              value: <ToolBadge tone="info">{monitor().attrs.state ?? "monitoring"}</ToolBadge>,
            },
            ...(tagText(monitor().inner, "description")
              ? [{ key: i18n.t("ui.tool.monitor.watching"), value: tagText(monitor().inner, "description")! }]
              : []),
            ...(tagText(monitor().inner, "command")
              ? [{ key: i18n.t("ui.tool.monitor.command"), value: tagText(monitor().inner, "command")!, mono: true }]
              : []),
            ...(monitor().attrs.job
              ? [{ key: i18n.t("ui.tool.monitor.job"), value: monitor().attrs.job!, mono: true }]
              : []),
          ]}
        />
      )}
    </Show>
  )
}

/* ── Checkpoint ──────────────────────────────────────────────────────────── */

type Checkpoint = {
  ordinal?: string
  id?: string
  status?: string
  kind?: string
  files?: string
  add?: string
  del?: string
  mine?: string
}

export function CheckpointOutput(props: { output: string }) {
  const i18n = useI18n()

  const list = createMemo<Checkpoint[]>(() =>
    [...props.output.matchAll(/<cp\s([^>]*?)\/>/g)].map((match) => {
      const attrs: Record<string, string> = {}
      for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
      return attrs as Checkpoint
    }),
  )

  const empty = createMemo(() => {
    const block = tagBlocks(props.output, "checkpoints")[0]
    return block && block.attrs.count === "0" ? block.inner.trim() : undefined
  })

  return (
    <Show when={list().length > 0 || empty()} fallback={<SmartToolOutput output={props.output} />}>
      <Show when={empty()}>
        <ToolEmpty>{empty()}</ToolEmpty>
      </Show>
      <Show when={list().length > 0}>
        <ToolBoundedList items={list()} limit={8} scroll>
          {(cp) => (
            <ToolRow
              lead={<ToolBadge mono>{`#${cp.ordinal ?? "?"}`}</ToolBadge>}
              primary={cp.kind ?? cp.id ?? ""}
              mono={false}
              secondary={
                <>
                  <Show when={cp.status}>
                    <ToolBadge tone={cp.status === "clean" ? "success" : "warning"}>{cp.status}</ToolBadge>
                  </Show>
                  <Show when={cp.mine === "false"}>
                    <ToolBadge tone="accent">{i18n.t("ui.tool.checkpoint.foreign")}</ToolBadge>
                  </Show>
                </>
              }
              trailing={
                <span data-slot="checkpoint-counts">
                  <Show when={cp.files}>
                    <span>{i18n.t("ui.tool.checkpoint.files", { count: Number(cp.files) })}</span>
                  </Show>
                  <Show when={cp.add}>
                    <span data-slot="checkpoint-add">{cp.add}</span>
                  </Show>
                  <Show when={cp.del}>
                    <span data-slot="checkpoint-del">{cp.del}</span>
                  </Show>
                </span>
              }
            />
          )}
        </ToolBoundedList>
      </Show>
    </Show>
  )
}

/* ── Archive ─────────────────────────────────────────────────────────────── */

type ArchiveEntry = { name: string; size?: string; dir: boolean; unsafe: boolean }

export function ArchiveOutput(props: { output: string }) {
  const i18n = useI18n()

  const meta = createMemo(() => ({
    archive: tagText(props.output, "archive"),
    format: tagText(props.output, "format"),
    entries: tagText(props.output, "entries"),
    uncompressed: tagText(props.output, "uncompressed"),
  }))

  const entries = createMemo<ArchiveEntry[]>(() => {
    const out: ArchiveEntry[] = []
    for (const line of props.output.split("\n")) {
      const match = /^\s{2}(\[!\]|\[D\]|\s{3})\s(.+)$/.exec(line)
      if (!match) continue
      const marker = match[1]!.trim()
      const rest = match[2]!
      const unsafe = marker === "[!]"
      const dir = marker === "[D]"
      const split = rest.lastIndexOf(" — ")
      const name = split > 0 ? rest.slice(0, split) : rest
      const detail = split > 0 ? rest.slice(split + 3) : undefined
      out.push({ name, size: unsafe ? undefined : detail, dir, unsafe })
    }
    return out
  })

  return (
    <Show when={meta().archive || entries().length > 0} fallback={<SmartToolOutput output={props.output} />}>
      <Show when={meta().entries}>
        <ToolStats
          items={[
            { label: i18n.t("ui.tool.archive.entries"), value: meta().entries! },
            ...(meta().uncompressed ? [{ label: i18n.t("ui.tool.archive.size"), value: meta().uncompressed! }] : []),
            ...(meta().format ? [{ label: i18n.t("ui.tool.archive.format"), value: meta().format! }] : []),
          ]}
        />
      </Show>
      <Show when={entries().length > 0}>
        <ToolBoundedList items={entries()} limit={14} scroll>
          {(entry) => (
            <ToolRow
              tone={entry.unsafe ? "danger" : undefined}
              lead={
                <Show when={entry.unsafe} fallback={<ToolBadge mono>{entry.dir ? "D" : "F"}</ToolBadge>}>
                  <ToolBadge tone="danger" mono>
                    !
                  </ToolBadge>
                </Show>
              }
              primary={<ToolPath path={entry.name} />}
              truncate="start"
              trailing={entry.unsafe ? i18n.t("ui.tool.archive.unsafe") : entry.size}
            />
          )}
        </ToolBoundedList>
      </Show>
    </Show>
  )
}

/* ── JSON ────────────────────────────────────────────────────────────────── */

export function JsonOutput(props: { output: string }) {
  const i18n = useI18n()

  const validate = createMemo(() => {
    const selfClose = selfClosing(props.output, "json-validate")
    if (selfClose) return { attrs: selfClose, error: undefined, excerpt: undefined }
    const block = tagBlocks(props.output, "json-validate")[0]
    if (!block) return undefined
    const errorMatch = /<error\s([^>]*)>([\s\S]*?)<\/error>/.exec(block.inner)
    const errorAttrs: Record<string, string> = {}
    if (errorMatch) {
      for (const attr of errorMatch[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) errorAttrs[attr[1]!] = unescapeXml(attr[2]!)
    }
    const error = errorMatch
      ? {
          line: errorAttrs.line,
          column: errorAttrs.column,
          position: errorAttrs.position,
          message: unescapeXml(errorMatch[2]!.trim()),
        }
      : undefined
    return { attrs: block.attrs, error, excerpt: tagText(block.inner, "excerpt") }
  })

  return (
    <Show when={validate()} fallback={<SmartToolOutput output={props.output} />}>
      {(result) => (
        <>
          <ToolStats
            items={[
              {
                label: i18n.t("ui.tool.json.status"),
                value: result().attrs.ok === "true" ? i18n.t("ui.tool.json.valid") : i18n.t("ui.tool.json.invalid"),
                tone: result().attrs.ok === "true" ? "success" : "danger",
              },
              ...(result().attrs.bytes
                ? [{ label: i18n.t("ui.tool.json.bytes"), value: bytes(Number(result().attrs.bytes)) }]
                : []),
              ...(result().attrs.parseMs
                ? [{ label: i18n.t("ui.tool.json.parse"), value: `${Number(result().attrs.parseMs).toFixed(1)}ms` }]
                : []),
            ]}
          />
          <Show when={result().error}>
            {(error) => (
              <ToolBlock label={i18n.t("ui.tool.json.error")}>
                <ToolRow
                  lead={
                    <ToolBadge tone="danger" mono>{`${error().line}:${error().column}`}</ToolBadge>
                  }
                  primary={error().message}
                  mono={false}
                />
                <Show when={result().excerpt}>
                  <pre data-component="tool-pre">{result().excerpt}</pre>
                </Show>
              </ToolBlock>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

/* ── background ──────────────────────────────────────────────────────────────
   Five shapes, one tool. `status` and `wait` wrap a `<job>` block whose body is
   `Key: value` lines plus an optional output tail; `list` prints a fixed-width
   table (but hands us the rows in metadata, which is far better); `read` is raw
   log text; `send`/`kill` are one-line acknowledgements.

   All of it used to go through the markdown renderer, which stripped the `<job>`
   wrapper, glued the fields into one paragraph, and left the command — the one
   thing you actually want to see — wrapped mid-flag with no monospace.
   ────────────────────────────────────────────────────────────────────────── */

type BackgroundJobRow = {
  id: string
  status: string
  kind?: string
  description?: string
  command: string
  startedAt?: number
  logPath?: string
  exit?: number | null
}

const BACKGROUND_TONE: Record<string, Tone> = {
  running: "info",
  completed: "success",
  error: "danger",
  cancelled: "warning",
  stale: "warning",
}

function jobRows(metadata: Record<string, any> | undefined): BackgroundJobRow[] {
  const rows = metadata?.jobs
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is BackgroundJobRow => !!row && typeof row.id === "string")
}

/** `<job id="…" status="…" kind="…">` … `</job>` — status and wait. */
function parseJobBlock(output: string) {
  const block = tagBlocks(output, "job")[0]
  if (!block) return undefined

  const command = tagText(block.inner, "command")
  const fields: { key: string; value: string }[] = []
  let tail: string[] = []
  let inTail = false

  for (const raw of block.inner.split("\n")) {
    const line = raw.trimEnd()
    if (/^Output tail:\s*$/.test(line.trim())) {
      inTail = true
      continue
    }
    if (inTail) {
      tail.push(raw)
      continue
    }
    if (/^<command>/.test(line.trim())) continue
    const field = /^([A-Z][A-Za-z ]{0,20}):\s+(\S.*)$/.exec(line.trim())
    if (field) fields.push({ key: field[1]!, value: unescapeXml(field[2]!) })
  }

  while (tail.length && !tail[0]!.trim()) tail.shift()
  while (tail.length && !tail[tail.length - 1]!.trim()) tail.pop()

  return { attrs: block.attrs, command, fields, tail: tail.join("\n") }
}

function BackgroundJobList(props: { rows: BackgroundJobRow[] }) {
  const i18n = useI18n()
  return (
    <Show when={props.rows.length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.background.empty")}</ToolEmpty>}>
      <ToolBoundedList items={props.rows} limit={8} scroll>
        {(row) => (
          <ToolRow
            lead={<span data-component="tool-dot" data-tone={BACKGROUND_TONE[row.status] ?? "neutral"} />}
            primary={row.description || row.command}
            secondary={row.id}
            mono={false}
            trailing={
              <ToolBadge tone={BACKGROUND_TONE[row.status] ?? "neutral"}>
                {row.exit === null || row.exit === undefined ? row.status : `${row.status} · ${row.exit}`}
              </ToolBadge>
            }
          />
        )}
      </ToolBoundedList>
    </Show>
  )
}

export function BackgroundOutput(props: {
  output: string
  input?: Record<string, any>
  metadata?: Record<string, any>
}) {
  const i18n = useI18n()
  const action = createMemo(() => (typeof props.input?.action === "string" ? props.input.action : undefined))
  const rows = createMemo(() => jobRows(props.metadata))
  const job = createMemo(() => parseJobBlock(props.output))
  const logPath = createMemo(() =>
    typeof props.metadata?.logPath === "string" ? (props.metadata.logPath as string) : undefined,
  )

  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={action() === "list"}>
        <BackgroundJobList rows={rows()} />
      </Match>

      <Match when={job()}>
        {(parsed) => (
          <>
            <Show when={parsed().command}>
              {(command) => <ToolLog text={`$ ${command()}`} label={i18n.t("ui.tool.background.command")} />}
            </Show>
            <ToolFields
              items={parsed()
                .fields.filter((field) => field.key !== "Log")
                .map((field) => ({ key: field.key, value: field.value, mono: true }))}
            />
            <Show when={parsed().fields.find((field) => field.key === "Log")}>
              {(log) => (
                <ToolBlock label={i18n.t("ui.tool.background.log")}>
                  <ToolRow primary={<ToolPath path={log().value} />} truncate="start" />
                </ToolBlock>
              )}
            </Show>
            <Show when={parsed().tail}>
              <ToolLog text={parsed().tail} label={i18n.t("ui.tool.background.tail")} />
            </Show>
          </>
        )}
      </Match>

      {/* `read` returns the log verbatim — ANSI and all. */}
      <Match when={action() === "read"}>
        <>
          <Show when={logPath()}>
            {(path) => (
              <ToolBlock label={i18n.t("ui.tool.background.log")}>
                <ToolRow primary={<ToolPath path={path()} />} truncate="start" />
              </ToolBlock>
            )}
          </Show>
          <ToolLog text={props.output} />
        </>
      </Match>
    </Switch>
  )
}

/* ── lsp ─────────────────────────────────────────────────────────────────────
   The tool stringifies whatever the language server returned, so the fallback
   showed a screen of raw LSP JSON — `uri`, zero-based `range.start.character`,
   numeric `kind`. Every operation reduces to one of three shapes, and all three
   are a list of places you might jump to.
   ────────────────────────────────────────────────────────────────────────── */

const SYMBOL_KIND = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
]

type LspPlace = { name?: string; kind?: string; path: string; line?: number; character?: number; detail?: string }

const fileFromUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""))

function lspRange(node: any) {
  const start = node?.range?.start ?? node?.selectionRange?.start ?? node?.location?.range?.start
  if (!start) return {}
  // LSP is zero-based; editors are not.
  return { line: (start.line ?? 0) + 1, character: (start.character ?? 0) + 1 }
}

function lspPlaces(result: unknown): LspPlace[] {
  if (!Array.isArray(result)) return []
  return result.flatMap((raw: any): LspPlace[] => {
    // Call hierarchy wraps the item it is telling you about.
    const node = raw?.from ?? raw?.to ?? raw
    const uri = node?.uri ?? node?.location?.uri
    if (typeof uri !== "string") return []
    return [
      {
        name: typeof node.name === "string" ? node.name : undefined,
        kind: typeof node.kind === "number" ? SYMBOL_KIND[node.kind - 1] : undefined,
        detail: typeof node.detail === "string" ? node.detail : undefined,
        path: fileFromUri(uri),
        ...lspRange(node),
      },
    ]
  })
}

/** `hover` returns markup rather than locations. */
function lspHover(result: unknown) {
  if (!Array.isArray(result)) return undefined
  const contents = (result[0] as any)?.contents
  if (typeof contents === "string") return contents
  if (typeof contents?.value === "string") return contents.value
  if (Array.isArray(contents)) {
    return contents.map((part: any) => (typeof part === "string" ? part : (part?.value ?? ""))).join("\n\n")
  }
  return undefined
}

export function LspOutput(props: { output: string; input?: Record<string, any>; metadata?: Record<string, any> }) {
  const i18n = useI18n()
  const result = createMemo(() => {
    if (props.metadata?.result !== undefined) return props.metadata.result
    try {
      return JSON.parse(props.output)
    } catch {
      return undefined
    }
  })
  const hover = createMemo(() => lspHover(result()))
  const places = createMemo(() => lspPlaces(result()))

  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={hover()}>{(text) => <Markdown text={text()} />}</Match>
      <Match when={places().length > 0}>
        <ToolBoundedList items={places()} limit={10} scroll>
          {(place) => (
            <ToolRow
              lead={place.kind ? <ToolBadge>{place.kind}</ToolBadge> : undefined}
              primary={place.name ?? place.path.split(/[\\/]/).pop()!}
              secondary={place.detail ?? place.path}
              mono={!place.name}
              trailing={place.line ? `${place.line}:${place.character}` : undefined}
            />
          )}
        </ToolBoundedList>
      </Match>
      <Match when={Array.isArray(result()) && (result() as unknown[]).length === 0}>
        <ToolEmpty>{i18n.t("ui.tool.lsp.empty")}</ToolEmpty>
      </Match>
    </Switch>
  )
}

/* ── refactor ────────────────────────────────────────────────────────────────
   `<refactor status="…">` wrapping either a unified diff (preview) or a list of
   changed files (applied); `<references>` and `<symbol>` for the read-only
   modes. The diff is the whole point of a preview, so it gets diff colouring
   rather than being flattened into prose.
   ────────────────────────────────────────────────────────────────────────── */

const REFACTOR_TONE: Record<string, Tone> = {
  applied: "success",
  preview: "info",
  noop: "neutral",
  "rolled-back": "danger",
}

function attrsOf(source: string, name: string) {
  return [...source.matchAll(new RegExp(`<${name}([^>]*)\\/>`, "g"))].map((match) => {
    const attrs: Record<string, string> = {}
    for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
    return attrs
  })
}

function DiffPre(props: { text: string }) {
  const lines = createMemo(() => props.text.split("\n"))
  const kind = (line: string) => {
    if (/^(\+\+\+|---|diff |index |@@)/.test(line)) return "meta"
    if (line.startsWith("+")) return "add"
    if (line.startsWith("-")) return "del"
    return undefined
  }
  return (
    <div data-component="tool-diff">
      <For each={lines()}>
        {(line) => (
          <div data-slot="tool-diff-line" data-kind={kind(line)}>
            {line || " "}
          </div>
        )}
      </For>
    </div>
  )
}

export function RefactorOutput(props: { output: string; metadata?: Record<string, any> }) {
  const i18n = useI18n()
  const block = createMemo(() => tagBlocks(props.output, "refactor")[0])
  const references = createMemo(() => tagBlocks(props.output, "references")[0])
  const symbol = createMemo(() => tagBlocks(props.output, "symbol")[0])
  const changed = createMemo(() => attrsOf(block()?.inner ?? "", "changed"))

  // The preview body is a raw unified diff; anything else in there is prose.
  const diff = createMemo(() => {
    const inner = block()?.inner
    if (!inner) return undefined
    const stripped = inner.replace(/<summary>[\s\S]*?<\/summary>/g, "").replace(/<changed[^>]*\/>/g, "").trim()
    return /^(diff |--- |\+\+\+ |@@)/m.test(stripped) ? unescapeXml(stripped) : undefined
  })

  const summary = createMemo(() => {
    const inner = block()?.inner
    if (!inner) return undefined
    const explicit = tagText(inner, "summary")
    if (explicit) return explicit
    if (diff()) return undefined
    const rest = inner.replace(/<changed[^>]*\/>/g, "").trim()
    return rest ? unescapeXml(rest) : undefined
  })

  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={block()}>
        {(entry) => (
          <>
            <div data-component="tool-strip">
              <ToolBadge tone={REFACTOR_TONE[entry().attrs.status ?? ""] ?? "neutral"}>
                {entry().attrs.status ?? "refactor"}
              </ToolBadge>
              <Show when={entry().attrs.mode}>{(mode) => <ToolBadge mono>{mode()}</ToolBadge>}</Show>
            </div>
            <Show when={summary()}>{(text) => <ToolNotice message={text()} />}</Show>
            <Show when={changed().length > 0}>
              <ToolBlock label={i18n.t("ui.tool.refactor.changed")} trailing={String(changed().length)}>
                <ToolBoundedList items={changed()} limit={8} scroll>
                  {(file) => <ToolRow primary={<ToolPath path={file.rel ?? ""} />} trailing={file.kind} />}
                </ToolBoundedList>
              </ToolBlock>
            </Show>
            <Show when={diff()}>{(text) => <DiffPre text={text()} />}</Show>
          </>
        )}
      </Match>

      <Match when={references()}>
        {(entry) => (
          <ToolBlock label={i18n.t("ui.tool.refactor.references")} trailing={entry().attrs.total}>
            <ToolBoundedList items={attrsOf(entry().inner, "file")} limit={10} scroll>
              {(file) => (
                <ToolRow
                  primary={<ToolPath path={file.path ?? ""} />}
                  truncate="start"
                  trailing={`${file.references ?? 0} · ${file.definitions ?? 0}`}
                />
              )}
            </ToolBoundedList>
          </ToolBlock>
        )}
      </Match>

      <Match when={symbol()}>
        {(entry) => (
          <ToolFields
            items={[
              { key: i18n.t("ui.tool.refactor.name"), value: tagText(entry().inner, "name") ?? "", mono: true },
              { key: i18n.t("ui.tool.refactor.kind"), value: tagText(entry().inner, "kind") ?? "" },
              {
                key: i18n.t("ui.tool.refactor.location"),
                value: `${entry().attrs.file}:${entry().attrs.line}:${entry().attrs.column}`,
                mono: true,
              },
              ...(tagText(entry().inner, "canRename") === "true"
                ? [{ key: i18n.t("ui.tool.refactor.rename"), value: tagText(entry().inner, "renameDisplay") ?? "yes" }]
                : []),
            ]}
          />
        )}
      </Match>
    </Switch>
  )
}
