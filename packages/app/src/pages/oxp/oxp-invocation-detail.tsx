import type { OxpInvocationDetailInfo, OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { checksum } from "@opencode-ai/core/util/encode"
import { normalize } from "@opencode-ai/session-ui/session-diff"
import { GitOutput } from "@opencode-ai/session-ui/git-tool"
import { ToolFileAccordion } from "@opencode-ai/session-ui/tool-file-accordion"
import { SmartToolOutput } from "@opencode-ai/session-ui/tool-output"
import {
  DirectoryOutput,
  GlobResults,
  GrepResults,
  parseGlobOutput,
  parseGrepOutput,
  parseReadWindow,
} from "@opencode-ai/session-ui/search-results"
import {
  ToolBlock,
  ToolBoundedList,
  ToolEmpty,
  ToolFields,
  ToolLog,
  ToolNotice,
  ToolParams,
  ToolPath,
  ToolRow,
} from "@opencode-ai/session-ui/tool-parts"
import { ToolErrorPanel } from "@opencode-ai/session-ui/tool-error-panel"
import { useLanguage } from "@/context/language"
import { buildDetail, type DetailSection, type Field } from "./oxp-detail-model"
import { isOpenableLink, linkIcon, linkKindKey, t, type Phrase } from "./oxp-presentation"
import { say } from "./oxp-phrase"

export type DetailState = {
  data?: OxpInvocationDetailInfo
  loaded: boolean
  loading: boolean
  error?: string
}

/**
 * Expanded body of one OXP call.
 *
 * Mounted only while the row is open (`BasicTool` defers its children), so the
 * parse and every heavy viewer below — diff, syntax highlighter, ANSI log — cost
 * nothing for the thousands of collapsed rows above it.
 */
export function OxpInvocationDetail(props: {
  item: OxpInvocationInfo
  state?: DetailState
  /** Live elapsed label; kept out of the parsed model so a ticking clock cannot reparse it. */
  duration: string
  onOpenSession: (sessionID: string) => void
  onOpenScheduled: () => void
  linkBusy?: string
}) {
  const language = useLanguage()
  const model = createMemo(() => buildDetail(props.item, props.state?.data))
  const diagnostics = createMemo<Field[]>(() => {
    const items = [...model().diagnostics]
    items.splice(1, 0, { label: t("oxpActivity.field.duration"), value: props.duration })
    return items
  })

  const pending = () => props.state?.loading || (!props.state?.loaded && !props.state?.error)

  return (
    <div data-component="oxp-detail">
      <Show when={pending()}>
        <div data-component="oxp-skeleton" role="status" aria-label={language.t("oxpActivity.detail.loading")}>
          <span />
          <span />
          <span />
        </div>
      </Show>

      <Show when={props.state?.error}>
        {(message) => <ToolNotice tone="danger" message={language.t("oxpActivity.detail.error")} hints={[message()]} />}
      </Show>

      <Show when={!pending() && !props.state?.error && model().empty}>
        <ToolNotice
          message={language.t("oxpActivity.detail.unavailable")}
          hints={[language.t("oxpActivity.detail.unavailableDescription")]}
        />
      </Show>

      <For each={model().sections}>{(section) => <Section section={section} {...props} />}</For>

      <Show when={model().truncated}>
        <ToolNotice tone="warning" message={language.t("oxpActivity.detail.captureTruncated")} />
      </Show>

      <Show when={props.item.links.length > 0}>
        <ToolBlock label={language.t("oxpActivity.detail.section.links")}>
          <For each={props.item.links}>
            {(link) => {
              const label = () => language.t(linkKindKey(link.kind))
              const openable = isOpenableLink(link.kind)
              const busy = () => props.linkBusy === link.ref
              const row = (
                <ToolRow
                  lead={<Icon name={linkIcon(link.kind)} size="small" />}
                  primary={link.label ?? link.ref}
                  secondary={label()}
                  trailing={link.relation}
                  mono={false}
                  truncate="end"
                />
              )
              return (
                <Show when={openable} fallback={row}>
                  <button
                    type="button"
                    data-component="oxp-link-row"
                    aria-disabled={busy() ? "true" : undefined}
                    aria-label={`${label()} — ${link.label ?? link.ref}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (busy()) return
                      if (link.kind === "scheduled_task") props.onOpenScheduled()
                      else props.onOpenSession(link.ref)
                    }}
                  >
                    {row}
                  </button>
                </Show>
              )
            }}
          </For>
        </ToolBlock>
      </Show>

      <ToolBlock label={language.t("oxpActivity.detail.section.diagnostics")}>
        <FieldGrid items={diagnostics()} />
      </ToolBlock>
    </div>
  )
}

function FieldGrid(props: { items: Field[] }) {
  const language = useLanguage()
  return (
    <ToolFields
      items={props.items.map((item) => ({
        key: say(language, item.label),
        value: typeof item.value === "string" ? item.value : say(language, item.value),
        mono: item.mono,
      }))}
    />
  )
}

function Section(props: {
  section: DetailSection
  item: OxpInvocationInfo
  onOpenSession: (sessionID: string) => void
  linkBusy?: string
}) {
  const language = useLanguage()
  const label = (phrase: Phrase | undefined) => (phrase ? say(language, phrase) : undefined)

  return (
    <Switch>
      <Match when={props.section.kind === "stats" && props.section}>
        {(section) => (
          <div data-component="tool-stats-wrap">
            <ToolStatsBlock items={section().items} />
          </div>
        )}
      </Match>

      <Match when={props.section.kind === "fields" && props.section}>
        {(section) => (
          <Show when={section().label} fallback={<FieldGrid items={section().items} />}>
            {(text) => (
              <ToolBlock label={say(language, text())}>
                <FieldGrid items={section().items} />
              </ToolBlock>
            )}
          </Show>
        )}
      </Match>

      <Match when={props.section.kind === "command" && props.section}>
        {(section) => <CommandBlock label={say(language, section().label)} command={section().command} />}
      </Match>

      <Match when={props.section.kind === "code" && props.section}>
        {(section) => (
          <ToolBlock label={say(language, section().label)} trailing={section().trailing}>
            <div data-component="oxp-code">
              <CodeBody filename={section().filename} body={section().body} />
            </div>
          </ToolBlock>
        )}
      </Match>

      <Match when={props.section.kind === "log" && props.section}>
        {(section) => <ToolLog label={say(language, section().label)} text={section().body} />}
      </Match>

      <Match when={props.section.kind === "prose" && props.section}>
        {(section) => (
          <ToolBlock label={say(language, section().label)}>
            <SmartToolOutput output={section().body} />
          </ToolBlock>
        )}
      </Match>

      <Match when={props.section.kind === "diff" && props.section}>
        {(section) => (
          <DiffBlock
            path={section().path}
            patch={section().patch}
            before={section().before}
            after={section().after}
            additions={section().additions}
            deletions={section().deletions}
            status={section().status}
          />
        )}
      </Match>

      <Match when={props.section.kind === "grep" && props.section}>
        {(section) => {
          const parsed = createMemo(() => parseGrepOutput(section().output))
          return (
            <ToolBlock label={say(language, section().label)}>
              <Show when={parsed()} fallback={<SmartToolOutput output={section().output} />}>
                {(result) => <GrepResults result={result()} pattern={section().pattern} />}
              </Show>
            </ToolBlock>
          )
        }}
      </Match>

      <Match when={props.section.kind === "glob" && props.section}>
        {(section) => {
          const parsed = createMemo(() => parseGlobOutput(section().output))
          return (
            <ToolBlock label={say(language, section().label)}>
              <GlobResults result={parsed()} />
            </ToolBlock>
          )
        }}
      </Match>

      <Match when={props.section.kind === "readWindow" && props.section}>
        {(section) => {
          const parsed = createMemo(() => parseReadWindow(section().output))
          return (
            <Show when={parsed()} fallback={<SmartToolOutput output={section().output} />}>
              {(window) => (
                <ToolBlock
                  label={say(language, section().label)}
                  trailing={
                    window().type === "file"
                      ? `${(window() as { lineStart: number }).lineStart}–${(window() as { lineEnd: number }).lineEnd}`
                      : section().trailing
                  }
                >
                  <Show
                    when={window().type === "file" && window()}
                    fallback={<DirectoryOutput entries={(window() as { entries: string[] }).entries} />}
                  >
                    {(file) => (
                      <div data-component="oxp-code">
                        <CodeBody
                          filename={(file() as { path: string }).path}
                          body={(file() as { text: string }).text}
                        />
                      </div>
                    )}
                  </Show>
                </ToolBlock>
              )}
            </Show>
          )
        }}
      </Match>

      <Match when={props.section.kind === "git" && props.section}>
        {(section) => (
          <ToolBlock label={say(language, section().label)}>
            <GitOutput mode={section().mode} output={section().output} />
          </ToolBlock>
        )}
      </Match>

      <Match when={props.section.kind === "rows" && props.section}>
        {(section) => (
          <ToolBlock label={say(language, section().label)} trailing={String(section().rows.length)}>
            <Show when={section().rows.length > 0} fallback={<ToolEmpty>{label(section().label)}</ToolEmpty>}>
              <ToolBoundedList items={section().rows} limit={section().limit ?? 8} scroll>
                {(row) => {
                  const body = (
                    <ToolRow
                      primary={row.truncate === "start" ? <ToolPath path={row.primary} /> : row.primary}
                      secondary={row.secondary}
                      trailing={row.trailing}
                      tone={row.tone}
                      mono={row.mono}
                      truncate={row.truncate}
                    />
                  )
                  return (
                    <Show when={row.sessionID} fallback={body}>
                      {(sessionID) => (
                        <button
                          type="button"
                          data-component="oxp-link-row"
                          aria-disabled={props.linkBusy === sessionID() ? "true" : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            props.onOpenSession(sessionID())
                          }}
                        >
                          {body}
                        </button>
                      )}
                    </Show>
                  )
                }}
              </ToolBoundedList>
            </Show>
          </ToolBlock>
        )}
      </Match>

      <Match when={props.section.kind === "params" && props.section}>
        {(section) => (
          <ToolBlock label={say(language, section().label)}>
            <ToolParams input={section().input} />
          </ToolBlock>
        )}
      </Match>

      <Match when={props.section.kind === "error" && props.section}>
        {(section) => <ToolErrorPanel error={section().body} />}
      </Match>

      <Match when={props.section.kind === "notice" && props.section}>
        {(section) => (
          <ToolNotice tone={section().tone} message={say(language, section().message)} hints={section().hints} />
        )}
      </Match>
    </Switch>
  )
}

function ToolStatsBlock(props: { items: { label: Phrase; value: string; tone?: string }[] }) {
  const language = useLanguage()
  return (
    <div data-component="tool-stats">
      <For each={props.items}>
        {(item) => (
          <div data-slot="tool-stat">
            <span data-slot="tool-stat-value" data-tone={item.tone}>
              {item.value}
            </span>
            <span data-slot="tool-stat-label">{say(language, item.label)}</span>
          </div>
        )}
      </For>
    </div>
  )
}

/**
 * The command as it was actually run, in a shell-prompt frame and copyable —
 * the single most useful thing on a `process` row, and the reason the detail
 * fetch exists at all.
 */
function CommandBlock(props: { label: string; command: string }) {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    await navigator.clipboard.writeText(props.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  const copyLabel = () => (copied() ? language.t("oxpActivity.detail.copied") : language.t("oxpActivity.detail.copy"))

  return (
    <ToolBlock label={props.label}>
      <div data-component="oxp-command">
        <span data-slot="oxp-command-marker" aria-hidden="true">
          $
        </span>
        <pre data-slot="oxp-command-text">{props.command}</pre>
        <span data-slot="oxp-command-copy">
          <Tooltip value={copyLabel()} placement="top" gutter={4}>
            <IconButton
              icon={copied() ? "check" : "copy"}
              size="small"
              variant="ghost"
              aria-label={copyLabel()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                void copy()
              }}
            />
          </Tooltip>
        </span>
      </div>
    </ToolBlock>
  )
}

function CodeBody(props: { filename: string; body: string }) {
  const fileComponent = useFileComponent()
  return (
    <div data-component="tool-output-json">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{ name: props.filename, contents: props.body, cacheKey: checksum(props.body) }}
        overflow="scroll"
      />
    </div>
  )
}

function DiffBlock(props: {
  path: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}) {
  const fileComponent = useFileComponent()
  const view = createMemo(() =>
    normalize({
      file: props.path,
      ...(props.patch === undefined ? { before: props.before ?? "", after: props.after ?? "" } : { patch: props.patch }),
      additions: props.additions,
      deletions: props.deletions,
      status: props.status,
    }),
  )

  return (
    <div data-component="oxp-diff">
      <ToolFileAccordion
        path={props.path}
        actions={<DiffChanges changes={{ additions: props.additions, deletions: props.deletions }} />}
      >
        <div data-component="read-content">
          <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view().fileDiff} />
        </div>
      </ToolFileAccordion>
    </div>
  )
}
