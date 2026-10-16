import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLimitRecovery, type LimitRecoveryAction } from "@/context/limit-recovery"
import { useNow } from "@/hooks/use-now"

export function LimitRecoveryComposerShelf(props: { sessionID: string }) {
  const recovery = useLimitRecovery()
  const language = useLanguage()
  const now = useNow()
  const current = () => recovery.recovery(props.sessionID)
  const visible = () => {
    const value = current()
    if (!value) return
    return value
  }
  const reset = () => current()?.resetAt
  const futureReset = () => reset() !== undefined && reset()! > now()
  const trustedFutureReset = () => {
    const value = current()
    return (
      value?.resetAt !== undefined &&
      value.resetAt > now() &&
      (value.resetSource === "retry-after" || value.resetSource === "provider")
    )
  }
  const resetLabel = () => {
    const at = reset()
    return at === undefined ? undefined : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }
  const mutate = (action: LimitRecoveryAction) => {
    void recovery.mutate(props.sessionID, action).catch(() => recovery.refresh(props.sessionID))
  }

  return (
    <Show when={visible()} keyed>
      {(item) => (
        <div
          data-component="limit-recovery-composer-shelf"
          class="mb-1.5 flex min-w-0 items-center gap-2 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2"
        >
          <span class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-base">
            {language.t("usageLimit.reached")}
            <span class="ml-2 text-v2-text-text-muted">
              {trustedFutureReset()
                ? language.t("usageLimit.resetAt", { time: resetLabel()! })
                : futureReset()
                  ? language.t("usageLimit.resetObservedAt", { time: resetLabel()! })
                  : language.t("usageLimit.resetUnknown")}
              {item.autoResume ? ` · ${language.t("usageLimit.autoResumeScheduled")}` : ""}
              {item.snoozeUntil !== undefined && item.snoozeUntil > now()
                ? ` · ${language.t("usageLimit.snoozedUntil", { time: resetLabel() ?? "" })}`
                : ""}
            </span>
          </span>

          <Show
            when={!item.manualResume}
            fallback={<span class="text-[12px] text-v2-text-text-muted">{language.t("usageLimit.resuming")}</span>}
          >
            <ButtonV2 size="small" variant="neutral" onClick={() => mutate("resume")}>
              {language.t("usageLimit.resumeNow")}
            </ButtonV2>
          </Show>

          <Show when={!item.manualResume && trustedFutureReset()}>
            <Show
              when={item.autoResume}
              fallback={
                <ButtonV2 size="small" variant="neutral" onClick={() => mutate("auto-resume")}>
                  {language.t("usageLimit.resumeAtReset")}
                </ButtonV2>
              }
            >
              <ButtonV2 size="small" variant="ghost" onClick={() => mutate("cancel-auto-resume")}>
                {language.t("usageLimit.cancelAutoResume")}
              </ButtonV2>
            </Show>
          </Show>

          <Show when={futureReset()}>
            <Show
              when={item.snoozeUntil === undefined || item.snoozeUntil <= now()}
              fallback={
                <ButtonV2 size="small" variant="ghost" onClick={() => mutate("unsnooze")}>
                  {language.t("usageLimit.unsnooze")}
                </ButtonV2>
              }
            >
              <ButtonV2 size="small" variant="ghost" onClick={() => mutate("snooze-until-reset")}>
                {language.t("usageLimit.snoozeUntilReset")}
              </ButtonV2>
            </Show>
          </Show>

          <ButtonV2 size="small" variant="ghost" onClick={() => mutate("cancel")}>
            {language.t("usageLimit.cancelRecovery")}
          </ButtonV2>
        </div>
      )}
    </Show>
  )
}
