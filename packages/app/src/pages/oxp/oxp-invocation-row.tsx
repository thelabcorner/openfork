import type { OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import { createMemo, Show } from "solid-js"
import { BasicTool } from "@opencode-ai/session-ui/basic-tool"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { useLanguage } from "@/context/language"
import { detailHints } from "./oxp-detail-model"
import { OxpInvocationDetail, type DetailState } from "./oxp-invocation-detail"
import {
  elapsedMs,
  formatDuration,
  invocationFacts,
  isFailure,
  isRunning,
  toolIdentity,
  toolStatus,
} from "./oxp-presentation"
import { say } from "./oxp-phrase"

/**
 * One call in the transcript.
 *
 * Deliberately the same `BasicTool` the live session timeline draws, with the
 * same collapsed anatomy — badge, title, target, outcome facts, right-aligned
 * duration — so a reader moving between a session and this page is not learning
 * a second visual language.
 */
export function OxpInvocationRow(props: {
  item: OxpInvocationInfo
  concurrent: boolean
  /** Ticking clock. Only read by rows that are still running. */
  now: () => number
  detail?: DetailState
  linkBusy?: string
  onEnsureDetail: (invocationID: string) => void
  onOpenSession: (sessionID: string) => void
  onOpenScheduled: () => void
}) {
  const language = useLanguage()

  const running = () => isRunning(props.item)
  const failed = () => isFailure(props.item)

  // A `process` row cannot show its command, and a `find` row cannot show its
  // query, until the detail payload exists — and fetching one per visible row
  // would defeat the whole lazy-detail design. So the row renders what the
  // compact projection has, and upgrades itself for free once the payload is in
  // the cache (after the first expand, or after a revisit).
  const hints = createMemo(() => detailHints(props.item, props.detail?.data))

  const identity = createMemo(() => toolIdentity(props.item, hints()))
  const facts = createMemo(() => invocationFacts(props.item))

  const duration = createMemo(() =>
    formatDuration(elapsedMs(props.item, props.item.completedAt === undefined ? props.now() : 0)),
  )

  return (
    <div data-slot="oxp-row" data-concurrent={props.concurrent ? "true" : undefined}>
      <BasicTool
        icon={identity().icon}
        status={toolStatus(props.item)}
        allowOpenWhilePending
        defer
        animated
        contentVariant="card"
        trigger={{
          title: say(language, identity().title),
          subtitle: identity().subtitle,
          subtitleMono: identity().subtitleMono,
          subtitleTruncate: identity().subtitleTruncate,
          args: facts().facts.map((fact) => say(language, fact)),
          result: duration(),
          resultTone: failed() ? "danger" : running() ? "warning" : "neutral",
          action: (
            <Show when={facts().changes}>{(changes) => <DiffChanges changes={changes()} />}</Show>
          ),
        }}
        onOpenChange={(open) => {
          if (open) props.onEnsureDetail(props.item.id)
        }}
      >
        <OxpInvocationDetail
          item={props.item}
          state={props.detail}
          duration={duration()}
          linkBusy={props.linkBusy}
          onOpenSession={props.onOpenSession}
          onOpenScheduled={props.onOpenScheduled}
        />
      </BasicTool>
    </div>
  )
}
