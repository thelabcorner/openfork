import { For, Show, createMemo, onMount, type Component, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { useLanguage } from "@/context/language"
import type { SessionQuestionController } from "./question-controller"

/**
 * Checkbox / radio mark. Sized to the 12px option row rather than the 16px
 * form-control default so the list keeps the dense New York rhythm.
 */
function Mark(props: { multiple: boolean; picked: boolean }) {
  return (
    <span
      aria-hidden="true"
      class="flex size-3 shrink-0 items-center justify-center border transition-colors"
      classList={{
        "rounded-[3.5px]": props.multiple,
        "rounded-full": !props.multiple,
        "border-v2-text-text-accent bg-v2-text-text-accent": props.picked,
        "border-v2-border-border-strong bg-transparent group-hover:border-v2-text-text-base": !props.picked,
      }}
    >
      <Show when={props.picked}>
        <Show
          when={props.multiple}
          fallback={<span class="size-[5px] rounded-full bg-v2-background-bg-base" />}
          children={<Icon name="check" size="small" class="size-2 text-v2-background-bg-base" />}
        />
      </Show>
    </span>
  )
}

function HeaderButton(props: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: JSX.Element
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-40"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export const SessionQuestionCard: Component<{ controller: SessionQuestionController }> = (props) => {
  const language = useLanguage()
  const question = () => props.controller
  let rows: HTMLButtonElement[] = []

  const options = createMemo(() => question().options())
  const multiple = createMemo(() => question().multiple())
  const sending = createMemo(() => question().sending())
  const minimized = createMemo(() => question().minimized())
  const total = createMemo(() => question().total())

  const detailText = createMemo(() => question().details().trim())

  const focusRow = (target: number) => {
    const list = options()
    if (list.length === 0) return
    const next = ((target % list.length) + list.length) % list.length
    question().setCursor(next)
    rows[next]?.focus()
  }

  const select = (index: number) => {
    const option = options()[index]
    if (!option || sending()) return
    question().toggle(option.label)
  }

  /** Roving focus + type-a-digit selection, scoped to the option list. */
  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || sending()) return
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    const cursor = question().cursor()

    if (plain && (event.key === "ArrowDown" || event.key === "ArrowRight")) {
      event.preventDefault()
      focusRow(cursor + 1)
      return
    }
    if (plain && (event.key === "ArrowUp" || event.key === "ArrowLeft")) {
      event.preventDefault()
      focusRow(cursor - 1)
      return
    }
    if (plain && event.key === "Home") {
      event.preventDefault()
      focusRow(0)
      return
    }
    if (plain && event.key === "End") {
      event.preventDefault()
      focusRow(options().length - 1)
      return
    }
    if (plain && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index >= options().length) return
      event.preventDefault()
      select(index)
      focusRow(index)
      return
    }
    // Backspace/Delete empties the whole answer — the keyboard counterpart to
    // the footer's Clear, so an accidental pick never forces a dismissal.
    if (plain && (event.key === "Backspace" || event.key === "Delete")) {
      if (question().selected() === 0) return
      event.preventDefault()
      question().clearAnswer()
      return
    }
    // Escape hands focus back to the composer rather than discarding the question.
    if (plain && event.key === "Escape") {
      event.preventDefault()
      question().setCursor(-1)
      return
    }
  }

  onMount(() => {
    // Focus stays in the composer so typing details (and `@` mentions) just
    // works; the list is one Tab away.
    question().setCursor(-1)
  })

  const hint = createMemo(() => {
    if (options().length === 0) return language.t("session.question.hint.freeform")
    // Undoing is only worth explaining once there is a selection to undo.
    if (question().selected() > 0) return language.t("session.question.hint.selected")
    if (!question().customAllowed()) return language.t("session.question.hint.selectOnly")
    return multiple() ? language.t("session.question.hint.multiple") : language.t("session.question.hint.single")
  })

  return (
    <div
      data-component="session-question-card"
      data-kind="question"
      data-minimized={minimized() ? "true" : undefined}
      class="relative mb-1.5 w-full overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
    >
      {/* Header: identity, progress, navigation. */}
      <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 pl-2 pr-1">
        <Icon name="help" size="small" class="size-3.5 shrink-0 text-v2-text-text-accent" />
        <Show
          when={question().current()?.header?.trim()}
          fallback={
            <span class="truncate text-[11px] font-[600] leading-4 text-v2-text-text-base">
              {language.t("session.question.title")}
            </span>
          }
        >
          {(header) => (
            <span class="min-w-0 truncate text-[11px] font-[600] leading-4 text-v2-text-text-base">{header()}</span>
          )}
        </Show>

        <Show when={total() > 1}>
          <span class="shrink-0 text-[9px] font-[560] tabular-nums leading-4 text-v2-text-text-faint">
            {question().index() + 1}/{total()}
          </span>
          <div class="flex shrink-0 items-center gap-[3px]" role="tablist">
            <For each={question().questions()}>
              {(_, i) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={i() === question().index()}
                  aria-label={language.t("session.question.step", { number: i() + 1 })}
                  disabled={sending()}
                  class="h-[3px] rounded-full transition-all disabled:pointer-events-none"
                  classList={{
                    "w-4 bg-v2-text-text-accent": i() === question().index(),
                    "w-2 bg-v2-border-border-strong hover:bg-v2-text-text-faint":
                      i() !== question().index() && !question().answeredAt(i()),
                    "w-2 bg-v2-state-fg-success/60 hover:bg-v2-state-fg-success":
                      i() !== question().index() && question().answeredAt(i()),
                  }}
                  onClick={() => question().goto(i())}
                />
              )}
            </For>
          </div>
        </Show>

        <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <Show when={total() > 1}>
            <HeaderButton
              label={language.t("ui.common.back")}
              disabled={sending() || question().index() === 0}
              onClick={question().back}
            >
              <Icon name="chevron-down" size="small" class="size-3 rotate-90" />
            </HeaderButton>
            <HeaderButton
              label={language.t("ui.common.next")}
              disabled={sending() || question().last()}
              onClick={() => question().goto(question().index() + 1)}
            >
              <Icon name="chevron-down" size="small" class="size-3 -rotate-90" />
            </HeaderButton>
          </Show>
          <HeaderButton
            label={language.t(minimized() ? "session.question.restore" : "session.question.minimize")}
            disabled={sending()}
            onClick={() => question().setMinimized(!minimized())}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="size-3 transition-transform"
              classList={{ "rotate-180": minimized() }}
            />
          </HeaderButton>
        </div>
      </div>

      {/* Body: prompt text and choices. */}
      <div class="flex min-w-0 flex-col">
        <div
          class="px-2.5 pt-1.5 text-[12.5px] font-[500] leading-[17px] tracking-[-0.05px] text-v2-text-text-base"
          classList={{ "truncate pb-1.5": minimized(), "pb-1": !minimized() }}
        >
          {question().current()?.question}
        </div>

        <Show when={!minimized() && options().length > 0}>
          <div
            role={multiple() ? "group" : "radiogroup"}
            aria-label={question().current()?.question}
            class="flex max-h-[min(46vh,288px)] flex-col gap-px overflow-y-auto overscroll-contain px-1 pb-1 no-scrollbar"
            onKeyDown={onListKeyDown}
          >
            <For each={options()}>
              {(option, i) => {
                const picked = () => question().picked(option.label)
                return (
                  <button
                    type="button"
                    ref={(el) => (rows[i()] = el)}
                    role={multiple() ? "checkbox" : "radio"}
                    aria-checked={picked()}
                    // Roving tabindex: one stop for the whole list.
                    tabIndex={question().cursor() === i() || (question().cursor() < 0 && i() === 0) ? 0 : -1}
                    disabled={sending()}
                    title={
                      picked()
                        ? language.t("session.question.deselect")
                        : option.description || option.label
                    }
                    onFocus={() => question().setCursor(i())}
                    onClick={() => select(i())}
                    class="group flex h-[26px] w-full shrink-0 items-center gap-2 rounded-[6px] px-1.5 text-start outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
                    classList={{ "bg-v2-overlay-simple-overlay-hover": picked() }}
                  >
                    <Mark multiple={multiple()} picked={picked()} />
                    <span
                      class="min-w-0 shrink-0 truncate text-[12px] leading-4 text-v2-text-text-base"
                      classList={{
                        "font-[540]": picked(),
                        "font-[450]": !picked(),
                        "max-w-[52%]": !!option.description,
                      }}
                    >
                      {option.label}
                    </span>
                    <Show when={option.description}>
                      <span class="min-w-0 flex-1 truncate text-[11px] font-[440] leading-4 text-v2-text-text-faint">
                        {option.description}
                      </span>
                    </Show>
                    {/* A picked row trades its digit hint for the gesture that
                        undoes it, so "click again to remove" is discoverable
                        without a tooltip. */}
                    <span class="ml-auto flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      <Show
                        when={picked()}
                        fallback={
                          <Show when={i() < 9}>
                            <KeybindV2 keys={[String(i() + 1)]} variant="ghost" />
                          </Show>
                        }
                      >
                        <Icon name="close" size="small" class="size-2.5 text-v2-text-text-faint" />
                      </Show>
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Footer: affordance hints on the left, decisions on the right. */}
      <div class="flex h-6 shrink-0 items-center gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 pl-2.5 pr-1">
        <Show
          when={detailText().length > 0}
          fallback={<span class="min-w-0 truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">{hint()}</span>}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="size-1 shrink-0 rounded-full bg-v2-state-fg-success" />
            <span class="min-w-0 truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">
              {language.t("session.question.hint.detailsAttached", { count: detailText().length })}
            </span>
          </span>
        </Show>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          {/* Only rendered once there is something to undo, so the resting
              footer stays quiet. */}
          <Show when={question().selected() > 0}>
            <button
              type="button"
              disabled={sending()}
              title={language.t("session.question.clearHint")}
              onClick={() => question().clearAnswer()}
              class="flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[10px] font-[500] leading-4 text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon name="close" size="small" class="size-2.5" />
              {language.t("session.question.clear")}
              <Show when={multiple() && question().selected() > 1}>
                <span class="tabular-nums text-v2-text-text-faint">{question().selected()}</span>
              </Show>
            </button>
          </Show>
          <button
            type="button"
            disabled={sending()}
            onClick={question().dismiss}
            class="flex h-[18px] items-center rounded-[4px] px-1.5 text-[10px] font-[500] leading-4 text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-40"
          >
            {language.t("ui.common.dismiss")}
          </button>
          <button
            type="button"
            disabled={sending() || !question().canAdvance()}
            onClick={question().advance}
            class="flex h-[18px] items-center gap-1 rounded-[4px] bg-v2-text-text-accent px-1.5 text-[10px] font-[560] leading-4 text-v2-background-bg-base transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
          >
            {question().last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
            <Icon name="arrow-up" size="small" class="size-2.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
