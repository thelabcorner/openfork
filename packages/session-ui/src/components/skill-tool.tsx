import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/icon"
import { parseSkillNotice, type SkillListItem } from "./skill-parse"
import { Markdown } from "./markdown"
import { SmartToolOutput } from "./tool-output"
import { ToolBadge, ToolBlock, ToolBoundedList, ToolEmpty, ToolNotice, ToolRow } from "./tool-parts"

function extractTag(text: string, name: string) {
  const match = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`).exec(text)
  if (!match) return undefined
  const attrs: Record<string, string> = {}
  for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!
  return { attrs, inner: match[2]! }
}

function extractAllTags(text: string, name: string) {
  const out: { attrs: Record<string, string>; inner: string }[] = []
  const re = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g")
  for (const match of text.matchAll(re)) {
    const attrs: Record<string, string> = {}
    for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!
    out.push({ attrs, inner: match[2]! })
  }
  return out
}

type ParsedSkill = {
  name: string
  body: string
  baseDir?: string
  files: string[]
}

function relativeToBase(file: string, base?: string) {
  if (!base) return file
  const normalized = file.replace(/\\/g, "/")
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/$/, "")
  return normalized.startsWith(normalizedBase + "/") ? normalized.slice(normalizedBase.length + 1) : normalized
}

function parseSkillContent(raw: { attrs: Record<string, string>; inner: string }): ParsedSkill {
  const inner = raw.inner
  const filesBlock = extractTag(inner, "skill_files")
  const files = filesBlock ? extractAllTags(filesBlock.inner, "file").map((f) => f.inner.trim()) : []
  const baseMatch = /Base directory for this skill:\s*(.+)/.exec(inner)
  const baseDir = baseMatch?.[1]?.trim()
  const cutIndex = inner.search(/\n+Base directory for this skill:/)
  let body = cutIndex >= 0 ? inner.slice(0, cutIndex) : inner
  body = body.replace(/^#\s*Skill:\s*.+\n+/, "").trim()
  return { name: raw.attrs.name ?? "skill", body, baseDir, files }
}


/**
 * Two shapes reach here: the `<skills>` block the list mode emits, and the
 * scored markdown the search mode emits. The latter used to fall through to a
 * raw markdown dump, complete with unrendered `**bold**` and the
 * `Use skill({...})` lines that are instructions for the model, not the user.
 */
function parseSkillList(output: string) {
  const tag = extractTag(output, "skills")
  if (tag) {
    const items: SkillListItem[] = []
    for (const line of tag.inner.split("\n")) {
      const match = /^\s*-\s*([^:]+):\s*(.*)$/.exec(line)
      if (!match) continue
      items.push({ name: match[1]!.trim(), description: match[2]!.trim() })
    }
    return { mode: tag.attrs.mode, count: tag.attrs.count, items }
  }

  const scored: SkillListItem[] = []
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\.\s*\*\*(.+?)\*\*\s*(?:\(score:\s*([\d.]+)\))?\s*(?:[—-]\s*(.*))?$/.exec(line)
    if (!match) continue
    const description = (match[3] ?? "").trim().replace(/^\((.*)\)$/, "$1")
    scored.push({ name: match[1]!.trim(), score: match[2], description })
  }
  if (scored.length) return { mode: "search", count: String(scored.length), items: scored }

  return undefined
}

function SkillFileList(props: { files: string[]; baseDir?: string }) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const visible = createMemo(() => (expanded() ? props.files : props.files.slice(0, 8)))
  const remaining = createMemo(() => props.files.length - visible().length)
  return (
    <div data-component="skill-file-list">
      <For each={visible()}>
        {(file) => (
          <span data-slot="skill-file-chip" title={file}>
            {relativeToBase(file, props.baseDir)}
          </span>
        )}
      </For>
      <Show when={remaining() > 0}>
        <button type="button" data-slot="skill-file-chip" data-more onClick={() => setExpanded(true)}>
          {i18n.t("ui.tool.skill.filesMore", { count: remaining() })}
        </button>
      </Show>
    </div>
  )
}

/**
 * One loaded skill. Flat, not a nested card — the tool card already draws the
 * frame, so this only needs internal rules to separate identity from body.
 */
function SkillContentCard(props: { skill: ParsedSkill }) {
  const i18n = useI18n()
  const [full, setFull] = createSignal(false)
  const [clamped, setClamped] = createSignal(false)

  // Markdown renders asynchronously, so the body's height is not known at
  // mount. Watch it instead of guessing — a short SKILL.md should get neither
  // the fade nor the button.
  let bodyRef: HTMLDivElement | undefined
  onMount(() => {
    if (!bodyRef || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (!bodyRef) return
      setClamped(bodyRef.scrollHeight - bodyRef.clientHeight > 4)
    })
    observer.observe(bodyRef)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div data-component="skill-content-card">
      <div data-slot="skill-content-header">
        <span data-slot="skill-content-name">
          <Icon name="brain" size="small" />
          {props.skill.name}
        </span>
        <Show when={props.skill.baseDir}>
          <span data-slot="skill-content-basedir" title={props.skill.baseDir}>
            {props.skill.baseDir}
          </span>
        </Show>
        <Show when={props.skill.files.length}>
          <span data-slot="skill-content-file-count">
            {i18n.t(props.skill.files.length === 1 ? "ui.tool.skill.files.one" : "ui.tool.skill.files.other", {
              count: props.skill.files.length,
            })}
          </span>
        </Show>
      </div>
      <Show when={props.skill.files.length}>
        <SkillFileList files={props.skill.files} baseDir={props.skill.baseDir} />
      </Show>
      {/* A SKILL.md is often hundreds of lines. Bound it, then let it out. */}
      <div
        ref={bodyRef}
        data-slot="skill-content-body"
        data-full={full() ? "true" : undefined}
        data-clamped={clamped() && !full() ? "true" : undefined}
      >
        <Markdown text={props.skill.body} />
      </div>
      <Show when={clamped() && !full()}>
        <button type="button" data-component="tool-more" onClick={() => setFull(true)}>
          {i18n.t("ui.tool.skill.readAll")}
        </button>
      </Show>
    </div>
  )
}

function SkillList(props: { mode?: string; count?: string; items: SkillListItem[] }) {
  const i18n = useI18n()
  return (
    <Show when={props.items.length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.skill.list.empty")}</ToolEmpty>}>
      <ToolBoundedList items={props.items} limit={10} scroll>
        {(item) => (
          <ToolRow
            primary={item.name}
            secondary={item.description && item.description !== "No description." ? item.description : undefined}
            trailing={item.score ? <ToolBadge tone="accent">{item.score}</ToolBadge> : undefined}
          />
        )}
      </ToolBoundedList>
    </Show>
  )
}

export function SkillOutput(props: { output: string }) {
  const i18n = useI18n()
  const parsed = createMemo(() => {
    const contents = extractAllTags(props.output, "skill_content").map(parseSkillContent)
    if (contents.length > 0) return { kind: "loaded" as const, contents }
    const list = parseSkillList(props.output)
    if (list) return { kind: "list" as const, ...list }
    const notice = parseSkillNotice(props.output)
    if (notice) return { kind: "notice" as const, ...notice }
    return { kind: "raw" as const }
  })

  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={parsed().kind === "loaded" && parsed()}>
        {(p) => (
          <div data-component="skill-loaded-list">
            <For each={(p() as { contents: ParsedSkill[] }).contents}>{(c) => <SkillContentCard skill={c} />}</For>
          </div>
        )}
      </Match>
      <Match when={parsed().kind === "list" && parsed()}>
        {(p) => {
          const list = p() as { mode?: string; count?: string; items: SkillListItem[] }
          return <SkillList mode={list.mode} count={list.count} items={list.items} />
        }}
      </Match>
      <Match when={parsed().kind === "notice" && parsed()}>
        {(p) => {
          const notice = p() as { message: string; items: SkillListItem[]; hints: string[] }
          return (
            <ToolNotice message={notice.message} hints={notice.hints} tone="warning">
              <Show when={notice.items.length > 0}>
                <ToolBlock label={i18n.t("ui.tool.skill.available")} trailing={String(notice.items.length)}>
                  <ToolBoundedList items={notice.items} limit={8} scroll>
                    {(item) => <ToolRow primary={item.name} secondary={item.description || undefined} />}
                  </ToolBoundedList>
                </ToolBlock>
              </Show>
            </ToolNotice>
          )
        }}
      </Match>
    </Switch>
  )
}
