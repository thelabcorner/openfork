import { For, Show, createMemo, createSignal } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { BoundedList, Chip, DiffLines, Dot, Fields, Notice, Path, Row, Rows, Stats, type Tone } from "./primitives"
import { CappedCode, EmptyNote, Section, inputString } from "./shared"
import { parseShellOutput } from "./ansi"
import { ToolText } from "./text"
import {
  backgroundRows,
  bytes,
  parseArchive,
  parseCheckpoints,
  parseGit,
  parseJobBlock,
  parseJsonValidate,
  parseLspHover,
  parseLspPlaces,
  parseMemory,
  parseMonitor,
  parseProjectTree,
  parseRefactor,
  parseSkillContents,
  parseSkillList,
  parseSkillNotice,
  parseSymbols,
  parseTest,
  parseTypecheck,
  skillFileLabel,
  statusTone,
  type Checkpoint,
  type Diagnostic,
  type MemoryEntry,
  type StatusEntry,
} from "./parse"

/**
 * Bodies for the built-in tools that had no renderer and fell through to the
 * generic JSON-plus-`<pre>` dump.
 *
 * These mirror the desktop client so the same call reads the same way on both
 * surfaces; the presentation is this app's own — 22px rows, `--font-2xs/xs`,
 * one type face, tap targets rather than hover affordances.
 */

/**
 * A tool's output as plain text.
 *
 * Goes through the ANSI parser rather than a strip-and-replace pair: it is the
 * one implementation that resolves carriage-return line rewrites, and these
 * renderers parse structure (XML envelopes, tables, counts) where the colour is
 * not the information — unlike the shell body, which keeps it.
 */
export function partOutput(part: ToolPart): string {
  const state = part.state
  const raw =
    state.status === "completed" || state.status === "error" ? (state as { output?: string }).output : undefined
  return parseShellOutput(raw ?? "").text
}

export function partMetadata(part: ToolPart): Record<string, unknown> {
  return ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
}

function inputRecord(part: ToolPart): Record<string, unknown> {
  return (part.state.input as Record<string, unknown> | undefined) ?? {}
}

/* ── Skill ───────────────────────────────────────────────────────────────── */

function SkillContentCard(props: { skill: ReturnType<typeof parseSkillContents>[number] }) {
  const [full, setFull] = createSignal(false)
  const body = () => props.skill.body
  const long = () => body().split("\n").length > 24
  const shown = () => (full() || !long() ? body() : body().split("\n").slice(0, 24).join("\n"))
  return (
    <div class="skill-card">
      <div class="skill-card-head">
        <span class="skill-card-name">{props.skill.name}</span>
        <Show when={props.skill.files.length}>
          <span class="skill-card-count tnum">{props.skill.files.length} files</span>
        </Show>
      </div>
      <Show when={props.skill.baseDir}>
        <div class="skill-card-base">{props.skill.baseDir}</div>
      </Show>
      <Show when={props.skill.files.length}>
        <div class="skill-files">
          <For each={props.skill.files.slice(0, 6)}>
            {(file) => <span class="skill-file">{skillFileLabel(file, props.skill.baseDir)}</span>}
          </For>
          <Show when={props.skill.files.length > 6}>
            <span class="skill-file more">+{props.skill.files.length - 6}</span>
          </Show>
        </div>
      </Show>
      <pre class="skill-body">{shown()}</pre>
      <Show when={long() && !full()}>
        <button
          class="tmore"
          onClick={(event) => {
            event.stopPropagation()
            setFull(true)
          }}
        >
          Read full skill
        </button>
      </Show>
    </div>
  )
}

export function SkillBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const contents = createMemo(() => parseSkillContents(output()))
  const list = createMemo(() => parseSkillList(output()))
  const notice = createMemo(() => parseSkillNotice(output()))

  return (
    <Show when={contents().length === 0} fallback={<For each={contents()}>{(c) => <SkillContentCard skill={c} />}</For>}>
      <Show
        when={list()}
        fallback={
          <Show when={notice()} fallback={<ToolText output={output()} />}>
            {(value) => (
              <Notice message={value().message} hints={value().hints} tone="warn">
                <Show when={value().items.length > 0}>
                  <Section label={`Available · ${value().items.length}`}>
                    <BoundedList items={value().items} limit={6} scroll>
                      {(item) => <Row primary={item.name} secondary={item.description || undefined} />}
                    </BoundedList>
                  </Section>
                </Show>
              </Notice>
            )}
          </Show>
        }
      >
        {(value) => (
          <Show when={value().items.length > 0} fallback={<EmptyNote>No skills matched.</EmptyNote>}>
            <BoundedList items={value().items} limit={8} scroll>
              {(item) => (
                <Row
                  primary={item.name}
                  secondary={item.description && item.description !== "No description." ? item.description : undefined}
                  trailing={item.score ? <Chip tone="accent">{item.score}</Chip> : undefined}
                />
              )}
            </BoundedList>
          </Show>
        )}
      </Show>
    </Show>
  )
}

/* ── Typecheck ───────────────────────────────────────────────────────────
   An 80-error run must not become an 80-screen scroll. Files collapse; each
   diagnostic is one line until tapped, because the `suggestion` the tool
   attaches is near-identical boilerplate across every diagnostic. */

function DiagnosticRow(props: { diagnostic: Diagnostic }) {
  const [open, setOpen] = createSignal(false)
  const d = () => props.diagnostic
  return (
    <div class={`tc-diag ${open() ? "open" : ""}`}>
      <Row
        onClick={() => setOpen(!open())}
        lead={<span class="tc-loc tnum">{`${d().line}:${d().column}`}</span>}
        primary={d().message}
        trailing={<span class="tc-code">{d().code}</span>}
      />
      <Show when={open()}>
        <div class="tc-detail">
          <div class="tc-detail-msg">{d().message}</div>
          <Show when={d().suggestion}>
            <div class="tc-detail-hint">{d().suggestion}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function TypecheckFile(props: { file: string; items: Diagnostic[]; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  return (
    <div class={`tc-file ${open() ? "open" : ""}`}>
      <Row
        onClick={() => setOpen(!open())}
        lead={<span class="tc-caret">{open() ? "▾" : "▸"}</span>}
        primary={<Path path={props.file} />}
        truncate="start"
        trailing={<span class="tnum">{props.items.length}</span>}
      />
      <Show when={open()}>
        <div class="tc-file-body">
          <BoundedList items={props.items} limit={8} scroll>
            {(item) => <DiagnosticRow diagnostic={item} />}
          </BoundedList>
        </div>
      </Show>
    </div>
  )
}

export function TypecheckBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseTypecheck(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <Show
          when={result().diagnostics.length > 0}
          fallback={
            <div class="tool-empty-note">
              <Chip tone="ok">No type errors</Chip>
            </div>
          }
        >
          <Stats
            items={[
              { label: "errors", value: String(result().diagnostics.length), tone: "bad" },
              { label: "files", value: String(result().groups.length) },
              ...result().tiers.map((tier) => ({
                label: tier.tier,
                value: String(tier.count),
                tone: (tier.tier === "P0" ? "bad" : tier.tier === "P1" ? "warn" : "neutral") as Tone,
              })),
            ]}
          />
          <BoundedList items={result().groups} limit={5}>
            {(group, index) => (
              <TypecheckFile
                file={group.file}
                items={group.items}
                defaultOpen={index === 0 && result().groups.length === 1}
              />
            )}
          </BoundedList>
        </Show>
      )}
    </Show>
  )
}

/* ── Test ────────────────────────────────────────────────────────────────── */

export function TestBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseTest(output()))
  const [showTail, setShowTail] = createSignal(false)

  const num = (key: string) => {
    const value = partMetadata(props.part)[key]
    return typeof value === "number" ? value : undefined
  }

  const stats = createMemo(() => {
    const items: { label: string; value: string; tone?: Tone }[] = []
    const passed = num("passed")
    const failed = num("failed")
    const skipped = num("skipped")
    const ms = num("durationMs")
    if (passed !== undefined) items.push({ label: "passed", value: String(passed), tone: "ok" })
    if (failed) items.push({ label: "failed", value: String(failed), tone: "bad" })
    if (skipped) items.push({ label: "skipped", value: String(skipped), tone: "warn" })
    if (ms !== undefined) items.push({ label: "time", value: ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms` })
    return items
  })

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <>
          <Show when={result().kind === "list" && result().files.length > 0}>
            <Section label={`Test files · ${result().files.length}`}>
              <BoundedList items={result().files} limit={10} scroll>
                {(file) => <Row primary={<Path path={file} />} truncate="start" />}
              </BoundedList>
            </Section>
          </Show>
          <Stats items={stats()} />
          <Show when={result().failures.length > 0}>
            <Section label={`Failures · ${result().failures.length}`}>
              <BoundedList items={result().failures} limit={6} scroll>
                {(failure) => (
                  <div class="test-failure">
                    <Row
                      lead={<Chip tone="bad">FAIL</Chip>}
                      primary={failure.name ?? "(unnamed)"}
                      trailing={failure.line}
                    />
                    <Show when={failure.file}>
                      <div class="test-failure-file">
                        <Path path={failure.file!} />
                      </div>
                    </Show>
                    <Show when={failure.detail}>
                      <div class="test-failure-detail">{failure.detail}</div>
                    </Show>
                  </div>
                )}
              </BoundedList>
            </Section>
          </Show>
          <Show when={result().tail}>
            <Show
              when={showTail()}
              fallback={
                <button
                  class="tmore"
                  onClick={(event) => {
                    event.stopPropagation()
                    setShowTail(true)
                  }}
                >
                  Show runner output
                </button>
              }
            >
              <Section label="Output">
                <CappedCode text={() => result().tail!} />
              </Section>
            </Show>
          </Show>
        </>
      )}
    </Show>
  )
}

/* ── Memory ──────────────────────────────────────────────────────────────── */

function MemoryRow(props: { entry: MemoryEntry }) {
  const e = () => props.entry
  return (
    <div class="mem-entry">
      <div class="mem-entry-head">
        <span class="mem-entry-title">{e().title ?? e().topic ?? e().id}</span>
        <Show when={e().score}>
          <Chip tone="accent">{e().score}</Chip>
        </Show>
        <Show when={e().status && e().status !== "active"}>
          <Chip tone="warn">{e().status}</Chip>
        </Show>
      </div>
      <Show when={e().summary}>
        <div class="mem-entry-summary">{e().summary}</div>
      </Show>
      <div class="mem-entry-meta">
        <For each={[e().topic, e().kind, e().scope, e().origin].filter(Boolean) as string[]}>
          {(value) => <Chip soft>{value}</Chip>}
        </For>
        <Show when={e().evidence && e().evidence !== "0"}>
          <Chip soft>{`${e().evidence} evidence`}</Chip>
        </Show>
      </div>
    </div>
  )
}

export function MemoryBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseMemory(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <>
          <Show when={result().stored}>{(entry) => <MemoryRow entry={entry()} />}</Show>
          <Show when={result().search}>
            {(search) => (
              <Section label={search().query ? `Search · ${search().query}` : "Search"}>
                <Show when={search().hits.length > 0} fallback={<EmptyNote>No memories matched.</EmptyNote>}>
                  <BoundedList items={search().hits} limit={4}>
                    {(hit) => <MemoryRow entry={hit} />}
                  </BoundedList>
                </Show>
              </Section>
            )}
          </Show>
          <Show when={result().forgotten}>
            {(id) => (
              <div class="tool-empty-note">
                <Chip tone="warn">forgotten</Chip> {id()}
              </div>
            )}
          </Show>
          <Show when={result().note}>{(note) => <EmptyNote>{note()}</EmptyNote>}</Show>
        </>
      )}
    </Show>
  )
}

/* ── Session ─────────────────────────────────────────────────────────────── */

type SessionMessage = {
  role?: string
  agent?: string
  model?: string
  text?: string
  createdAt?: number
  completedAt?: number
}

export function SessionBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => {
    const trimmed = output().trim()
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
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(data) => (
        <>
          <Fields
            items={[
              ...(data().sessionId ? [{ key: "Session", value: data().sessionId as string }] : []),
              ...(data().status?.type
                ? [
                    {
                      key: "Status",
                      value: (
                        <Chip tone={data().status.type === "busy" ? "warn" : "ok"}>{data().status.type}</Chip>
                      ) as any,
                    },
                  ]
                : []),
            ]}
          />
          <Show when={messages().length > 0}>
            <Section label={`Messages · ${messages().length}`}>
              <BoundedList items={messages()} limit={3}>
                {(message) => (
                  <div class="sess-msg">
                    <div class="sess-msg-head">
                      <Chip tone={message.role === "assistant" ? "accent" : "neutral"}>{message.role}</Chip>
                      <Show when={message.agent}>
                        <Chip soft>{message.agent}</Chip>
                      </Show>
                      <Show when={message.model}>
                        <span class="sess-msg-model">{message.model}</span>
                      </Show>
                      <Show when={duration(message)}>
                        <span class="sess-msg-time tnum">{duration(message)}</span>
                      </Show>
                    </div>
                    <Show when={message.text}>
                      <div class="sess-msg-text">{message.text}</div>
                    </Show>
                  </div>
                )}
              </BoundedList>
            </Section>
          </Show>
        </>
      )}
    </Show>
  )
}

/* ── Project ─────────────────────────────────────────────────────────────── */

export function ProjectBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseProjectTree(output()))

  return (
    <Show when={parsed().nodes.length > 0} fallback={<ToolText output={output()} />}>
      <Show when={parsed().preamble}>{(text) => <EmptyNote>{text()}</EmptyNote>}</Show>
      <BoundedList items={parsed().nodes} limit={12} scroll>
        {(node) => (
          <Row
            primary={
              <span style={{ "padding-left": `${Math.min(node.depth, 5) * 10}px` }}>
                <span class={`proj-node ${node.label.endsWith("/") ? "dir" : ""}`}>{node.label}</span>
              </span>
            }
            trailing={node.meta}
          />
        )}
      </BoundedList>
    </Show>
  )
}

/* ── Symbols ─────────────────────────────────────────────────────────────── */

export function SymbolsBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const hits = createMemo(() => parseSymbols(output()))

  return (
    <Show when={hits().length > 0} fallback={<ToolText output={output()} />}>
      <BoundedList items={hits()} limit={10} scroll>
        {(hit) => (
          <Row
            lead={hit.kind ? <Chip soft>{hit.kind}</Chip> : undefined}
            primary={hit.name}
            secondary={hit.file ? <Path path={hit.file} /> : undefined}
            trailing={hit.line}
          />
        )}
      </BoundedList>
    </Show>
  )
}

/* ── Monitor / Checkpoint / Archive / JSON ───────────────────────────────── */

export function MonitorBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseMonitor(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(monitor) => (
        <Fields
          items={[
            { key: "State", value: <Chip tone="accent">{monitor().state ?? "monitoring"}</Chip> },
            ...(monitor().description ? [{ key: "Watching", value: monitor().description! }] : []),
            ...(monitor().command ? [{ key: "Command", value: monitor().command! }] : []),
            ...(monitor().job ? [{ key: "Job", value: monitor().job! }] : []),
          ]}
        />
      )}
    </Show>
  )
}

export function CheckpointBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseCheckpoints(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <>
          <Show when={result().empty}>{(text) => <EmptyNote>{text()}</EmptyNote>}</Show>
          <Show when={result().list.length > 0}>
            <BoundedList items={result().list} limit={6} scroll>
              {(cp: Checkpoint) => (
                <Row
                  lead={<Chip soft>{`#${cp.ordinal ?? "?"}`}</Chip>}
                  primary={cp.kind ?? cp.id ?? ""}
                  secondary={cp.status ? <Chip tone={cp.status === "clean" ? "ok" : "warn"}>{cp.status}</Chip> : undefined}
                  trailing={
                    <span class="cp-counts tnum">
                      <Show when={cp.files}>
                        <span>{cp.files} files</span>
                      </Show>
                      <Show when={cp.add}>
                        <span class="add">{cp.add}</span>
                      </Show>
                      <Show when={cp.del}>
                        <span class="del">{cp.del}</span>
                      </Show>
                    </span>
                  }
                />
              )}
            </BoundedList>
          </Show>
        </>
      )}
    </Show>
  )
}

export function ArchiveBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseArchive(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <>
          <Show when={result().entries}>
            <Stats
              items={[
                { label: "entries", value: result().entries! },
                ...(result().uncompressed ? [{ label: "size", value: result().uncompressed! }] : []),
                ...(result().format ? [{ label: "format", value: result().format! }] : []),
              ]}
            />
          </Show>
          <Show when={result().items.length > 0}>
            <BoundedList items={result().items} limit={12} scroll>
              {(entry) => (
                <Row
                  tone={entry.unsafe ? "bad" : undefined}
                  lead={<Chip tone={entry.unsafe ? "bad" : "neutral"} soft={!entry.unsafe}>{entry.unsafe ? "!" : entry.dir ? "D" : "F"}</Chip>}
                  primary={<Path path={entry.name} />}
                  truncate="start"
                  trailing={entry.unsafe ? "unsafe path" : entry.size}
                />
              )}
            </BoundedList>
          </Show>
        </>
      )}
    </Show>
  )
}

export function JsonBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseJsonValidate(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      {(result) => (
        <>
          <Stats
            items={[
              { label: "status", value: result().ok ? "valid" : "invalid", tone: result().ok ? "ok" : "bad" },
              ...(result().bytes ? [{ label: "size", value: bytes(Number(result().bytes)) }] : []),
              ...(result().parseMs ? [{ label: "parse", value: `${Number(result().parseMs).toFixed(1)}ms` }] : []),
            ]}
          />
          <Show when={result().error}>
            {(error) => (
              <Section label="Error">
                <Row lead={<Chip tone="bad">{`${error().line}:${error().column}`}</Chip>} primary={error().message} />
                <Show when={result().excerpt}>
                  <CappedCode text={() => result().excerpt!} />
                </Show>
              </Section>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

/* ── Background ──────────────────────────────────────────────────────────── */

const JOB_TONE: Record<string, Tone> = {
  running: "accent",
  completed: "ok",
  error: "bad",
  cancelled: "warn",
  stale: "warn",
}

export function BackgroundBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const action = createMemo(() => {
    const value = inputRecord(props.part).action
    return typeof value === "string" ? value : undefined
  })
  const rows = createMemo(() => backgroundRows(partMetadata(props.part)))
  const job = createMemo(() => parseJobBlock(output()))
  const logPath = createMemo(() => {
    const value = partMetadata(props.part).logPath
    return typeof value === "string" ? value : undefined
  })

  return (
    <Show
      when={action() !== "list"}
      fallback={
        <Show when={rows().length > 0} fallback={<EmptyNote>No background jobs.</EmptyNote>}>
          <BoundedList items={rows()} limit={6} scroll>
            {(row) => (
              <Row
                lead={<Dot tone={JOB_TONE[row.status] ?? "neutral"} pulse={row.status === "running"} />}
                primary={row.description || row.command}
                secondary={row.id}
                trailing={
                  <Chip tone={JOB_TONE[row.status] ?? "neutral"}>
                    {row.exit === null || row.exit === undefined ? row.status : `${row.status} · ${row.exit}`}
                  </Chip>
                }
              />
            )}
          </BoundedList>
        </Show>
      }
    >
      <Show
        when={job()}
        fallback={
          <Show when={action() === "read"} fallback={<ToolText output={output()} />}>
            <Show when={logPath()}>{(path) => <div class="job-log">{path()}</div>}</Show>
            <Section label="Log">
              <CappedCode text={output} />
            </Section>
          </Show>
        }
      >
        {(parsed) => (
          <>
            <Show when={parsed().command}>
              {(command) => (
                <Section label="Command">
                  <div class="shell-command">
                    <span class="shell-prompt" aria-hidden="true">
                      $
                    </span>
                    <CappedCode text={() => command()} />
                  </div>
                </Section>
              )}
            </Show>
            <Fields
              items={parsed()
                .fields.filter((field) => field.key !== "Log")
                .map((field) => ({ key: field.key, value: field.value }))}
            />
            <Show when={parsed().fields.find((field) => field.key === "Log")}>
              {(log) => <div class="job-log">{log().value}</div>}
            </Show>
            <Show when={parsed().tail}>
              <Section label="Output tail">
                <CappedCode text={() => parsed().tail} />
              </Section>
            </Show>
          </>
        )}
      </Show>
    </Show>
  )
}

/* ── Git ─────────────────────────────────────────────────────────────────── */

const GIT_TONE: Record<string, Tone> = {
  conflict: "bad",
  modify: "warn",
  add: "ok",
  delete: "bad",
  untracked: "neutral",
  neutral: "neutral",
}

const GIT_ORDER = ["conflict", "modify", "add", "delete", "untracked", "neutral"] as const

function GitStatusList(props: { entries: StatusEntry[] }) {
  const groups = createMemo(() => {
    const byTone = new Map<string, StatusEntry[]>()
    for (const entry of props.entries) {
      const tone = statusTone(entry.code)
      const list = byTone.get(tone) ?? []
      list.push(entry)
      byTone.set(tone, list)
    }
    return GIT_ORDER.flatMap((tone) => {
      const items = byTone.get(tone)
      return items?.length ? [{ tone, count: items.length }] : []
    })
  })

  return (
    <Show when={props.entries.length > 0} fallback={<EmptyNote>Working tree clean.</EmptyNote>}>
      <Stats items={groups().map((group) => ({ label: group.tone, value: String(group.count), tone: GIT_TONE[group.tone] }))} />
      <BoundedList items={props.entries} limit={8} scroll>
        {(entry) => (
          <Row
            lead={<Chip tone={GIT_TONE[statusTone(entry.code)]}>{entry.code.trim() || "?"}</Chip>}
            primary={<Path path={entry.path} />}
            truncate="start"
          />
        )}
      </BoundedList>
    </Show>
  )
}

const LOG_LINE = /^(\S+)\s*(\(.*?\))?\s*(.*)$/

function GitCommitList(props: { commits: string[] }) {
  return (
    <Show when={props.commits.length > 0} fallback={<EmptyNote>No commits.</EmptyNote>}>
      <BoundedList items={props.commits} limit={8} scroll>
        {(line) => {
          const match = LOG_LINE.exec(line)
          return (
            <Row
              lead={<span class="git-hash">{match?.[1] ?? line}</span>}
              primary={match?.[3] ?? ""}
              secondary={match?.[2] ? match[2].slice(1, -1) : undefined}
            />
          )
        }}
      </BoundedList>
    </Show>
  )
}

type ParsedGitLocal = NonNullable<ReturnType<typeof parseGit>>

/** Narrows the union so `Show` gets a value to pass down, not a boolean. */
function gitMode<M extends ParsedGitLocal["mode"]>(
  value: ParsedGitLocal | undefined,
  mode: M,
): Extract<ParsedGitLocal, { mode: M }> | undefined {
  return value?.mode === mode ? (value as Extract<ParsedGitLocal, { mode: M }>) : undefined
}

export function GitBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const mode = createMemo(() => {
    const value = inputRecord(props.part).mode
    return typeof value === "string" ? value : "status"
  })
  const parsed = createMemo(() => parseGit(mode(), output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      <Show when={gitMode(parsed(), "status")}>
        {(value) => <GitStatusList entries={value().entries} />}
      </Show>

      <Show when={gitMode(parsed(), "summary")}>
        {(value) => (
          <>
            <Show when={value().branch}>
              {(branch) => (
                <div class="git-branch">
                  <Chip tone="accent">{branch()}</Chip>
                </div>
              )}
            </Show>
            <GitStatusList entries={value().entries} />
            <Show when={value().commits.length > 0}>
              <Section label="Recent">
                <GitCommitList commits={value().commits} />
              </Section>
            </Show>
          </>
        )}
      </Show>

      <Show when={gitMode(parsed(), "log")}>{(value) => <GitCommitList commits={value().commits} />}</Show>

      <Show when={gitMode(parsed(), "diff")}>{(value) => <DiffLines text={value().diff} />}</Show>

      <Show when={gitMode(parsed(), "commit")}>
        {(value) => (
          <>
            <Show when={value().hash}>
              {(hash) => (
                <Row
                  lead={<Chip tone={value().applied ? "ok" : "warn"}>{value().applied ? "committed" : "preview"}</Chip>}
                  primary={<span class="git-hash">{hash()}</span>}
                />
              )}
            </Show>
            <GitStatusList entries={value().entries} />
            <Show when={value().raw}>{(raw) => <CappedCode text={() => raw()} />}</Show>
          </>
        )}
      </Show>

      <Show when={gitMode(parsed(), "raw")}>{(value) => <CappedCode text={() => value().text} />}</Show>
    </Show>
  )
}

/* ── LSP ─────────────────────────────────────────────────────────────────── */

export function LspBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const result = createMemo(() => {
    const meta = partMetadata(props.part).result
    if (meta !== undefined) return meta
    try {
      return JSON.parse(output())
    } catch {
      return undefined
    }
  })
  const hover = createMemo(() => parseLspHover(result()))
  const places = createMemo(() => parseLspPlaces(result()))

  return (
    <Show when={hover()} fallback={
      <Show
        when={places().length > 0}
        fallback={
          <Show when={Array.isArray(result())} fallback={<ToolText output={output()} />}>
            <EmptyNote>No results.</EmptyNote>
          </Show>
        }
      >
        <BoundedList items={places()} limit={10} scroll>
          {(place) => (
            <Row
              lead={place.kind ? <Chip soft>{place.kind}</Chip> : undefined}
              primary={place.name ?? place.path.split(/[\\/]/).pop()!}
              secondary={place.detail ?? place.path}
              trailing={place.line ? `${place.line}:${place.character}` : undefined}
            />
          )}
        </BoundedList>
      </Show>
    }>
      {(text) => <CappedCode text={() => text()} />}
    </Show>
  )
}

/* ── Refactor ────────────────────────────────────────────────────────────── */

const REFACTOR_TONE: Record<string, Tone> = {
  applied: "ok",
  preview: "accent",
  noop: "neutral",
  "rolled-back": "bad",
}

type ParsedRefactorLocal = NonNullable<ReturnType<typeof parseRefactor>>

function refactorKind<K extends ParsedRefactorLocal["kind"]>(
  value: ParsedRefactorLocal | undefined,
  kind: K,
): Extract<ParsedRefactorLocal, { kind: K }> | undefined {
  return value?.kind === kind ? (value as Extract<ParsedRefactorLocal, { kind: K }>) : undefined
}

export function RefactorBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const parsed = createMemo(() => parseRefactor(output()))

  return (
    <Show when={parsed()} fallback={<ToolText output={output()} />}>
      <Show when={refactorKind(parsed(), "refactor")}>
        {(value) => (
          <>
            <div class="tstrip">
              <Chip tone={REFACTOR_TONE[value().status ?? ""] ?? "neutral"}>{value().status ?? "refactor"}</Chip>
              <Show when={value().mode}>{(mode) => <Chip soft>{mode()}</Chip>}</Show>
            </div>
            <Show when={value().summary}>{(text) => <Notice message={text()} />}</Show>
            <Show when={value().changed.length > 0}>
              <Section label={`Changed · ${value().changed.length}`}>
                <BoundedList items={value().changed} limit={6} scroll>
                  {(file) => <Row primary={<Path path={file.rel ?? ""} />} truncate="start" trailing={file.kind} />}
                </BoundedList>
              </Section>
            </Show>
            <Show when={value().diff}>{(diff) => <DiffLines text={diff()} />}</Show>
          </>
        )}
      </Show>

      <Show when={refactorKind(parsed(), "references")}>
        {(value) => (
          <Section label={`References · ${value().total ?? value().files.length}`}>
            <BoundedList items={value().files} limit={8} scroll>
              {(file) => (
                <Row
                  primary={<Path path={file.path ?? ""} />}
                  truncate="start"
                  trailing={`${file.references ?? 0} · ${file.definitions ?? 0}`}
                />
              )}
            </BoundedList>
          </Section>
        )}
      </Show>

      <Show when={refactorKind(parsed(), "symbol")}>
        {(value) => (
          <Fields
            items={[
              { key: "Symbol", value: value().name ?? "" },
              { key: "Kind", value: value().symbolKind ?? "" },
              { key: "Location", value: `${value().file}:${value().line}:${value().column}` },
              ...(value().rename ? [{ key: "Renameable", value: value().rename! }] : []),
            ]}
          />
        )}
      </Show>
    </Show>
  )
}

/* ── Read-only fallbacks for the remaining registry entries ──────────────── */

export function SqliteBody(props: { part: ToolPart }) {
  return <ToolText output={partOutput(props.part)} />
}

export function GenericBody(props: { part: ToolPart }) {
  const output = createMemo(() => partOutput(props.part))
  const query = createMemo(() => inputString(props.part, "query", "pattern", "command"))
  return (
    <Show when={output()} fallback={<EmptyNote>No output recorded.</EmptyNote>}>
      <Show when={query()}>{(text) => <div class="tool-query">{text()}</div>}</Show>
      <ToolText output={output()} />
    </Show>
  )
}
