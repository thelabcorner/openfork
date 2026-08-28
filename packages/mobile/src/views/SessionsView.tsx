import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { IconArchive, IconClock, IconFolder, IconPlus, IconSearch, IconSliders } from "../icons"
import { SessionRow, type SessionRuntime } from "../components/SessionRow"
import { VirtualList } from "../components/VirtualList"

type FilterTab = "recent" | "projects" | "archived"

export function SessionsView(props: {
  sessions: Session[]
  archivedSessions: Session[]
  projects: Project[]
  runtimes: Record<string, SessionRuntime>
  contextTotals: Record<string, number>
  activeSessionID?: string
  connected: boolean
  onSelect: (id: string) => void
  onNewSession: () => void
  onContextMenu: (id: string) => void
  onOpenLimits: () => void
  onLoadArchived: () => void
}) {
  const [searchInput, setSearchInput] = createSignal("")
  const [search, setSearch] = createSignal("")
  // debounced search — 140ms, avoids re-filtering 1k items on every keystroke
  let debounce: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const v = searchInput()
    clearTimeout(debounce)
    debounce = setTimeout(() => batch(() => setSearch(v)), 140)
  })
  onCleanup(() => clearTimeout(debounce))

  const [tab, setTab] = createSignal<FilterTab>("recent")

  const contextPct = (session: Session) => {
    const total = props.contextTotals[session.id]
    if (!total) return undefined
    const t = session.tokens
    if (!t) return 0
    const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
    return Math.min(100, Math.round((used / total) * 100))
  }

  const baseSessions = createMemo(() => (tab() === "archived" ? props.archivedSessions : props.sessions))

  const filtered = createMemo(() => {
    let list = baseSessions()
    const q = search().toLowerCase().trim()
    if (q) {
      // O(n) scan — fast for 1k, but debounced above so not per-keystroke
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.directory.toLowerCase().includes(q) ||
          s.projectID.toLowerCase().includes(q) ||
          (s.model && s.model.id.toLowerCase().includes(q)),
      )
    }
    // Already sorted by updated desc from server (V2 order desc), but re-sort to be safe
    // Single sort is O(n log n) — ok for 1k, memoed so not per-frame
    return list.slice().sort((a, b) => b.time.updated - a.time.updated)
  })

  const activeGenerating = createMemo(() => Object.values(props.runtimes).filter((r) => r.status === "generating" || r.status === "retry").length)
  const alertCount = createMemo(() =>
    Object.values(props.runtimes).reduce((n, r) => n + r.permissions + r.questions, 0),
  )

  const generatingIDs = createMemo(() =>
    filtered()
      .filter((s) => props.runtimes[s.id]?.status === "generating" || props.runtimes[s.id]?.status === "retry" || (props.runtimes[s.id]?.permissions ?? 0) > 0 || (props.runtimes[s.id]?.questions ?? 0) > 0)
      .map((s) => s.id),
  )

  const projectById = createMemo(() => {
    const m = new Map<string, Project>()
    for (const p of props.projects) m.set(p.id, p)
    return m
  })
  const projectNameForSession = (s: Session) => {
    const p = projectById().get(s.projectID)
    if (p?.name) return p.name
    if (p?.worktree) return p.worktree.split(/[\\/]/).filter(Boolean).pop() ?? p.worktree
    return s.directory.split(/[\\/]/).filter(Boolean).pop() ?? s.directory ?? s.projectID.slice(0, 8)
  }

  const projectGroups = createMemo(() => {
    if (tab() !== "projects") return null
    const groups = new Map<string, Session[]>()
    for (const s of filtered()) {
      const key = projectNameForSession(s)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(s)
    }
    return new Map([...groups.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.time.updated)) - Math.max(...a[1].map((x) => x.time.updated))))
  })

  // For virtualization: flatten projects groups into single list with headers
  type FlatItem = { kind: "groupHeader"; name: string; count: number } | { kind: "session"; session: Session }
  const flatProjectItems = createMemo<FlatItem[]>(() => {
    const g = projectGroups()
    if (!g) return []
    const out: FlatItem[] = []
    for (const [name, sessions] of g.entries()) {
      out.push({ kind: "groupHeader", name, count: sessions.length })
      for (const s of sessions) out.push({ kind: "session", session: s })
    }
    return out
  })

  const row = (session: Session) => (
    <SessionRow
      session={session}
      active={props.activeSessionID === session.id}
      runtime={props.runtimes[session.id] ?? { status: "idle", permissions: 0, questions: 0 }}
      contextPct={contextPct(session)}
      onSelect={() => props.onSelect(session.id)}
      onContextMenu={() => props.onContextMenu(session.id)}
    />
  )

  // Separate generating from rest for Recent so Active stays pinned at top (not virtualized — tiny)
  const recentRest = createMemo(() => filtered().filter((s) => !(tab() === "recent" && !search() && generatingIDs().includes(s.id))))
  const recentGenerating = createMemo(() => filtered().filter((s) => tab() === "recent" && !search() && generatingIDs().includes(s.id)))

  const ROW_H = 74
  const HEADER_H = 32

  return (
    <div class="view-root">
      <div class="sessions-header">
        <div class="sessions-titlebar">
          <div class="brand-mark">
            <div class="brand-glyph">OC</div>
            <span class="brand-title">Sessions</span>
          </div>
          <div class="header-actions">
            <Show when={alertCount() > 0}>
              <div class="pill-badge amber">{alertCount()}</div>
            </Show>
            <Show when={activeGenerating() > 0}>
              <div class="pill-badge blue">
                <span class="wave-bars" style={{ height: "9px" }}>
                  {[3, 5, 4].map((h, i) => <span style={{ height: `${h}px`, "animation-delay": `${i * 0.15}s` }} />)}
                </span>
                {activeGenerating()}
              </div>
            </Show>
            <button class="icon-btn solid" onClick={props.onNewSession} title="New session">
              <IconPlus size={13} />
            </button>
          </div>
        </div>

        <div class="search-box">
          <IconSearch size={12} />
          <input placeholder="Search sessions…" value={searchInput()} onInput={(e) => setSearchInput(e.currentTarget.value)} />
        </div>

        <div class="filter-tabs">
          <button class={`filter-tab ${tab() === "recent" ? "active" : ""}`} onClick={() => setTab("recent")}>
            <IconClock size={11} />
            Recent
          </button>
          <button class={`filter-tab ${tab() === "projects" ? "active" : ""}`} onClick={() => setTab("projects")}>
            <IconFolder size={11} />
            Projects
          </button>
          <button
            class={`filter-tab ${tab() === "archived" ? "active" : ""}`}
            onClick={() => {
              setTab("archived")
              props.onLoadArchived()
            }}
          >
            <IconArchive size={11} />
            Archive
          </button>
        </div>
      </div>

      <div class="view-scroll">
        <Show when={tab() === "recent" && !search() && generatingIDs().length > 0}>
          <div class="list-section-label">Active</div>
          <For each={recentGenerating()}>{row}</For>
          <div class="list-section-label">All</div>
        </Show>

        <Show
          when={tab() !== "projects"}
          fallback={
            // Projects — single virtualized flat list (headers + rows)
            <Show
              when={flatProjectItems().length > 0}
              fallback={
                <div class="empty-list">
                  <p>{search() ? "No sessions matching" : "No sessions yet"}</p>
                  <Show when={search()}><span class="query">"{search()}"</span></Show>
                </div>
              }
            >
              <VirtualList
                items={flatProjectItems()}
                estimateSize={(it) => (it.kind === "groupHeader" ? HEADER_H : ROW_H)}
                overscan={8}
                renderItem={(it) =>
                  it.kind === "groupHeader" ? (
                    <div class="project-group-header">
                      <IconFolder size={10} />
                      <span class="name">{it.name}</span>
                      <span class="count">({it.count})</span>
                    </div>
                  ) : (
                    row(it.session)
                  )
                }
              />
            </Show>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="empty-list">
                <Show when={tab() === "archived"}><IconArchive size={20} /></Show>
                <p>{search() ? "No sessions matching" : tab() === "archived" ? "No archived sessions" : "No sessions yet"}</p>
                <Show when={search()}><span class="query">"{search()}"</span></Show>
              </div>
            }
          >
            {/* Recent / Archived — virtualized rest. For <80 items the VirtualList auto-falls back to plain For. */}
            <Show when={tab() === "recent" && !search() && generatingIDs().length > 0} fallback={
              <VirtualList
                items={filtered()}
                estimateSize={ROW_H}
                overscan={8}
                renderItem={(s) => row(s as Session)}
              />
            }>
              <VirtualList
                items={recentRest()}
                estimateSize={ROW_H}
                overscan={8}
                renderItem={(s) => row(s as Session)}
              />
            </Show>
          </Show>
        </Show>

        <Show when={tab() === "recent" && !search() && filtered().length > 0}>
          <button class="new-session-row" onClick={props.onNewSession}>
            <IconPlus size={11} />
            <span>New session</span>
          </button>
        </Show>
      </div>

      <div class="status-footer">
        <span class={`status-dot ${props.connected ? "green" : "error"}`} />
        <span>{props.connected ? "connected" : "offline"}</span>
        <span>·</span>
        <span class="tnum">{props.sessions.length} sessions</span>
        <Show when={props.projects.length > 0}>
          <span>·</span>
          <span class="tnum">{props.projects.length} projects</span>
        </Show>
        <span class="spacer" />
        <button onClick={props.onOpenLimits}>
          <IconSliders size={11} />
        </button>
      </div>
    </div>
  )
}
