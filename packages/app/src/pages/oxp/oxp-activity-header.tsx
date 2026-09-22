import type { OxpParentActivitySummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { formatDuration, numeric, relativePhrase, spanMs, type Phrase } from "./oxp-presentation"
import { say } from "./oxp-phrase"

/**
 * Page header.
 *
 * One title line and one metadata line. The metric grid this replaced gave
 * "observed epochs" the same visual weight as the call count, which is exactly
 * how a product surface starts reading as an internal dashboard; the diagnostic
 * fields now live where they belong — on the call that produced them.
 */
export function OxpActivityHeader(props: {
  activity?: OxpParentActivitySummary
  /** Coarse clock (one minute) for the relative stamp. */
  minuteNow: number
  busy?: boolean
  onRename: (title: string | undefined) => Promise<unknown>
  onArchive: () => void
  onDelete: () => void
  onRefresh: () => void
}) {
  const language = useLanguage()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let input: HTMLInputElement | undefined

  createEffect(() => {
    const activity = props.activity
    if (!activity || editing()) return
    setDraft(activity.title ?? "")
  })

  const title = () =>
    props.activity?.title ?? props.activity?.lastRootAlias ?? language.t("oxpActivity.untitled")

  const save = async () => {
    setSaving(true)
    try {
      const value = draft().trim()
      await props.onRename(value || undefined)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const meta = createMemo<Array<{ text: string; tone?: "danger" | "strong" }>>(() => {
    const activity = props.activity
    if (!activity) return []
    const items: Array<{ text: string; tone?: "danger" | "strong" }> = []
    if (activity.lastRootAlias) items.push({ text: activity.lastRootAlias, tone: "strong" })
    items.push({ text: language.plural("oxpActivity.calls", numeric(activity.callCount)) })
    const failures = numeric(activity.failureCount)
    if (failures > 0)
      items.push({ text: language.t("oxpActivity.failures", { count: failures }), tone: "danger" })
    const span = spanMs(activity)
    if (span > 1000) items.push({ text: language.t("oxpActivity.span", { duration: formatDuration(span) }) })
    items.push({ text: say(language, relativePhrase(activity.lastSeenAt, props.minuteNow) as Phrase) })
    return items
  })

  const copyID = async () => {
    const id = props.activity?.id
    if (!id) return
    await navigator.clipboard.writeText(id)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <header data-slot="oxp-header">
      <div data-slot="oxp-header-top">
        <Show
          when={editing()}
          fallback={
            <h1 data-slot="oxp-title" title={title()}>
              {title()}
            </h1>
          }
        >
          <input
            ref={input}
            data-slot="oxp-title-input"
            value={draft()}
            maxlength={256}
            autofocus
            disabled={saving()}
            aria-label={language.t("oxpActivity.action.rename")}
            placeholder={language.t("oxpActivity.action.renamePlaceholder")}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void save()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                setDraft(props.activity?.title ?? "")
                setEditing(false)
              }
            }}
          />
        </Show>

        <Show when={props.activity?.archivedAt !== undefined}>
          <span data-slot="oxp-badge" data-tone="warning">
            {language.t("oxpActivity.archived")}
          </span>
        </Show>

        <div data-slot="oxp-header-actions">
          <Tooltip value={language.t("oxpActivity.action.refresh")} placement="bottom" gutter={4}>
            <IconButton
              icon="reset"
              size="small"
              variant="ghost"
              aria-label={language.t("oxpActivity.action.refresh")}
              onClick={props.onRefresh}
            />
          </Tooltip>

          <MenuV2 placement="bottom-end" gutter={4} onOpenChange={(open) => !open && setConfirmDelete(false)}>
            <MenuV2.Trigger
              as={IconButton}
              icon="dot-grid"
              size="small"
              variant="ghost"
              aria-label={language.t("oxpActivity.action.menu")}
            />
            <MenuV2.Portal>
              <MenuV2.Content class="w-56">
                <MenuV2.Item
                  disabled={!props.activity}
                  onSelect={() => {
                    setEditing(true)
                    queueMicrotask(() => input?.select())
                  }}
                >
                  <Icon name="pencil-line" size="small" />
                  <span class="min-w-0 flex-1 truncate">{language.t("oxpActivity.action.rename")}</span>
                </MenuV2.Item>
                <MenuV2.Item disabled={!props.activity} closeOnSelect={false} onSelect={() => void copyID()}>
                  <Icon name={copied() ? "check" : "copy"} size="small" />
                  <span class="min-w-0 flex-1 truncate">
                    {copied() ? language.t("oxpActivity.action.copied") : language.t("oxpActivity.action.copyID")}
                  </span>
                </MenuV2.Item>
                <MenuV2.Separator />
                <MenuV2.Item disabled={!props.activity || props.busy} onSelect={props.onArchive}>
                  <Icon name="archive" size="small" />
                  <span class="min-w-0 flex-1 truncate">{language.t("oxpActivity.action.archive")}</span>
                </MenuV2.Item>
                <Show
                  when={confirmDelete()}
                  fallback={
                    <MenuV2.Item closeOnSelect={false} disabled={!props.activity} onSelect={() => setConfirmDelete(true)}>
                      <Icon name="trash" size="small" />
                      <span class="min-w-0 flex-1 truncate">{language.t("oxpActivity.action.delete")}</span>
                    </MenuV2.Item>
                  }
                >
                  <MenuV2.Item
                    disabled={props.busy}
                    class="text-v2-state-fg-danger"
                    onSelect={props.onDelete}
                  >
                    <Icon name="trash" size="small" />
                    <span class="min-w-0 flex-1 truncate">{language.t("oxpActivity.action.deleteConfirm")}</span>
                  </MenuV2.Item>
                </Show>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </div>
      </div>

      <div data-slot="oxp-meta">
        <span data-slot="oxp-badge">{language.t("oxpActivity.protocol")}</span>
        <span data-slot="oxp-meta-item" data-tone="strong">
          {language.t("oxpActivity.source")}
        </span>
        <For each={meta()}>
          {(entry) => (
            <>
              <span data-slot="oxp-meta-dot" aria-hidden="true">
                ·
              </span>
              <span data-slot="oxp-meta-item" data-tone={entry.tone} title={entry.text}>
                {entry.text}
              </span>
            </>
          )}
        </For>
      </div>
    </header>
  )
}
