import { createSignal, For, Show } from "solid-js"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { PromptCorrectionPatch } from "@/components/prompt-input/correction"

/**
 * Explicit, optional correction inspection. Previewing never edits the editor
 * and never sends anything. A stale draft or changed settings are rejected by
 * the caller immediately before invoking the existing submission path.
 */
export function DialogPromptCorrectionReview(props: {
  patches: readonly PromptCorrectionPatch[]
  bypassed?: boolean
  /** Undefined selects the exact original; an array selects only these patch starts. */
  onSend: (selectedPatchStarts?: readonly number[]) => boolean
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [selected, setSelected] = createSignal<ReadonlySet<number>>(new Set(props.patches.map((patch) => patch.start)))
  const toggle = (start: number, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(start)
      else next.delete(start)
      return next
    })
  }
  const send = (selectedPatchStarts?: readonly number[]) => {
    if (!props.onSend(selectedPatchStarts)) return
    dialog.close()
  }

  return (
    <Dialog size="normal" class="w-full max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{language.t("prompt.autocorrection.review.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="min-h-0 max-h-[400px] overflow-y-auto px-4 py-3">
        <Show when={props.patches.length > 0} fallback={
          <p class="text-xs leading-5 text-v2-state-text-muted">
            {language.t(props.bypassed
              ? "prompt.autocorrection.review.bypassed"
              : "prompt.autocorrection.review.none")}
          </p>
        }>
          <p class="mb-2 text-xs leading-5 text-v2-state-text-muted">
            {language.t("prompt.autocorrection.review.description", { count: props.patches.length })}
          </p>
          <div class="mb-2 flex items-center justify-between gap-3">
            <span class="text-xs tabular-nums text-v2-state-text-muted">
              {language.t("prompt.autocorrection.review.selected", {
                selected: selected().size, total: props.patches.length,
              })}
            </span>
            <div class="flex gap-1">
              <ButtonV2 size="small" variant="ghost" data-action="prompt-correction-review-select-all"
                onClick={() => setSelected(new Set(props.patches.map((patch) => patch.start)))}>
                {language.t("prompt.autocorrection.review.all")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" data-action="prompt-correction-review-select-none"
                onClick={() => setSelected(new Set<number>())}>
                {language.t("prompt.autocorrection.review.noneSelected")}
              </ButtonV2>
            </div>
          </div>
          <div role="list" aria-label={language.t("prompt.autocorrection.review.title")}
            class="divide-y divide-v2-border-weak rounded-md border border-v2-border-weak">
          <For each={props.patches}>
            {(patch) => (
              <div role="listitem" class="flex min-w-0 items-center gap-3 px-3 py-2 text-xs"
                data-action="prompt-correction-review-entry">
                <CheckboxV2
                  hideLabel
                  label={`${patch.original} → ${patch.replacement}`}
                  checked={selected().has(patch.start)}
                  data-action="prompt-correction-review-toggle"
                  data-patch-start={patch.start}
                  onChange={(checked) => toggle(patch.start, checked)}
                />
                <span class="min-w-0 flex-1 truncate font-mono text-v2-state-text-muted" title={patch.original}>
                  {patch.original}
                </span>
                <span class="shrink-0 text-v2-state-text-muted" aria-hidden="true">→</span>
                <span class="min-w-0 flex-1 truncate font-mono" title={patch.replacement}>
                  {patch.replacement}
                </span>
                <span class="shrink-0 text-[10px] text-v2-state-text-muted">
                  {language.t(patch.rule.startsWith("user:")
                    ? "prompt.autocorrection.review.personal"
                    : "prompt.autocorrection.review.known")}
                </span>
              </div>
            )}
          </For>
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="neutral" data-action="prompt-correction-review-send-exact"
          onClick={() => send()}>
          {language.t("prompt.autocorrection.sendExact")}
        </ButtonV2>
        <Show when={props.patches.length > 0}>
          <ButtonV2 variant="contrast" data-action="prompt-correction-review-send"
            disabled={selected().size === 0}
            onClick={() => send([...selected()].sort((a, b) => a - b))}>
            {language.t("prompt.autocorrection.review.send")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
