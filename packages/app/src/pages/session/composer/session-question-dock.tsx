import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { showToast } from "@/utils/toast"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { normalizeReply } from "@opencode-ai/core/question-normalize"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useServerSDK } from "@/context/server-sdk"
import { ScopedKey } from "@/utils/server-scope"
import { useFile } from "@/context/file"
import { PromptInputV2Popover, type PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import {
  applyQuestionMention,
  questionMentionToken,
  type QuestionMentionToken,
} from "./question-custom-mention"

const QUESTION_CACHE_MAX = 100
const QUESTION_DETAIL_MAX_CHARS = 16_384
const QUESTION_MENTION_QUERY_MAX_CHARS = 64
const QUESTION_MENTION_RESULT_LIMIT = 50
const cache = new Map<string, { tab: number; answers: QuestionAnswer[]; custom: string[] }>()

function cacheQuestionState(key: string, value: { tab: number; answers: QuestionAnswer[]; custom: string[] }) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > QUESTION_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  label: string
  description?: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">{props.label}</span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{ request: QuestionRequest; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const files = useFile()
  const cacheKey = ScopedKey.from(serverSDK().scope, props.request.id)

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(cacheKey)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    editing: false,
    focus: 0,
    minimized: false,
    optionsHeight: 180,
  })

  let root: HTMLDivElement | undefined
  let optionsRef: HTMLDivElement | undefined
  let customRef: HTMLTextAreaElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined
  let mentionTimer: ReturnType<typeof setTimeout> | undefined
  let mentionController: AbortController | undefined
  let mentionGeneration = 0

  const [mention, setMention] = createSignal<QuestionMentionToken>()
  const [mentionItems, setMentionItems] = createSignal<PromptInputV2Suggestion[]>([])
  const [mentionActive, setMentionActive] = createSignal(0)

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => {
    const seen = new Set<string>()
    return (question()?.options ?? []).filter((option) => {
      if (!option.label.trim() || seen.has(option.label)) return false
      seen.add(option.label)
      return true
    })
  })
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customAllowed = createMemo(() => question()?.custom !== false || options().length === 0)
  const count = createMemo(() => options().length + (customAllowed() ? 1 : 0))

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })
  const customLabel = () =>
    options().length > 0 ? language.t("ui.question.custom.addDetails") : language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")

  const last = createMemo(() => store.tab >= total() - 1)
  const collapse = useSpring(() => (store.minimized ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const hidden = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const optionsOff = createMemo(() => hidden() > 0.98)

  const customUpdate = (value: string) => setStore("custom", store.tab, value.slice(0, QUESTION_DETAIL_MAX_CHARS))

  const closeMention = () => {
    if (!mentionTimer && !mentionController && mention() === undefined && mentionItems().length === 0) return
    mentionGeneration++
    if (mentionTimer) clearTimeout(mentionTimer)
    mentionTimer = undefined
    mentionController?.abort()
    mentionController = undefined
    setMention(undefined)
    setMentionItems([])
    setMentionActive(0)
  }

  const searchMention = (token: QuestionMentionToken) => {
    if (mentionTimer) clearTimeout(mentionTimer)
    mentionController?.abort()
    const generation = ++mentionGeneration
    setMention(token)
    setMentionItems([])
    setMentionActive(0)
    mentionTimer = setTimeout(() => {
      mentionTimer = undefined
      const controller = new AbortController()
      mentionController = controller
      void files
        .searchMentions(token.query, { limit: QUESTION_MENTION_RESULT_LIMIT, signal: controller.signal, symbols: false })
        .then((page) => {
          if (generation !== mentionGeneration || controller.signal.aborted) return
          const rows = page.results.flatMap((entry): PromptInputV2Suggestion[] => {
            if (entry.kind !== "file") return []
            const offset = entry.baseOffset !== undefined && entry.baseOffset > 0 ? entry.baseOffset : 0
            return [
              {
                id: `question-file:${entry.path}`,
                kind: "file",
                label: entry.path,
                path: entry.path,
                positions: entry.positions?.map((position) => position + offset),
                size: entry.size,
                mtime: entry.mtime,
                lineCount: entry.lineCount,
              },
            ]
          })
          setMentionItems(rows)
          setMentionActive((current) => Math.max(0, Math.min(current, rows.length - 1)))
        })
        .catch(() => {
          if (generation !== mentionGeneration || controller.signal.aborted) return
          setMentionItems([])
          setMentionActive(0)
        })
    }, 30)
  }

  const syncMention = (value: string, cursor: number) => {
    const token = questionMentionToken(value, cursor)
    if (!token) {
      closeMention()
      return
    }
    const searchToken = { ...token, query: token.query.slice(0, QUESTION_MENTION_QUERY_MAX_CHARS) }
    const current = mention()
    if (current?.query === searchToken.query) {
      if (current.start !== searchToken.start || current.end !== searchToken.end) setMention(searchToken)
      return
    }
    searchMention(searchToken)
  }

  const selectMention = (item: PromptInputV2Suggestion) => {
    const token = mention()
    const path = item.path
    if (!token || !path) return
    const next = applyQuestionMention(input(), token, path)
    const value = next.value.slice(0, QUESTION_DETAIL_MAX_CHARS)
    customUpdate(value)
    closeMention()
    requestAnimationFrame(() => {
      customRef?.focus()
      const cursor = Math.min(next.cursor, value.length)
      customRef?.setSelectionRange(cursor, cursor)
      if (customRef) resizeInput(customRef)
    })
  }

  const moveMention = (step: number) => {
    const items = mentionItems()
    if (items.length === 0) return
    setMentionActive((current) => (current + step + items.length) % items.length)
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(Math.max(0, count() - 1), i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    const selected = list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false)
    if (selected >= 0) return selected
    if (list.length === 0 && questions()[tab]?.custom !== false) return 0
    return 0
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = customAllowed() && next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  createEffect(() => {
    const el = optionsRef
    if (!el) return
    const update = () => setStore("optionsHeight", (height) => Math.max(height, el.scrollHeight))
    update()
    createResizeObserver(el, update)
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    closeMention()
    if (replied) return
    cacheQuestionState(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (response: { answers: QuestionAnswer[]; details: string[] }) =>
      sdk().api.question.reply({
        sessionID: props.request.sessionID,
        requestID: props.request.id,
        answers: response.answers,
        details: response.details,
      }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk().api.question.reject({ sessionID: props.request.sessionID, requestID: props.request.id }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = async (response: { answers: QuestionAnswer[]; details: string[] }) => {
    if (sending()) return
    await replyMutation.mutateAsync(response)
  }

  const reject = async () => {
    if (sending()) return
    await rejectMutation.mutateAsync()
  }

  const normalizedResponse = createMemo(() =>
    normalizeReply(questions(), {
      answers: store.answers,
      details: store.custom,
    }),
  )

  const submit = () =>
    void reply({
      answers: normalizedResponse().answers.map((answer) => [...answer]),
      details: [...normalizedResponse().details],
    })

  const answered = (i: number) => {
    if ((normalizedResponse().answers[i]?.length ?? 0) > 0) return true
    return (normalizedResponse().details[i]?.length ?? 0) > 0
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string) => {
    setStore("answers", store.tab, [answer])
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customOpen = () => {
    if (sending() || !customAllowed()) return
    setStore("focus", options().length)
    setStore("editing", true)
    customRef?.focus()
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      event.preventDefault()
      void reject()
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const next = () => {
    if (sending()) return
    closeMention()
    setStore("editing", false)

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    closeMention()
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    closeMention()
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const minimize = () => {
    if (sending()) return
    closeMention()
    setStore("editing", false)
    setStore("minimized", true)
  }

  const restore = () => {
    if (sending()) return
    setStore("minimized", false)
    focus(pickFocus())
  }

  return (
    <div data-component="session-question-dock">
      <DockPrompt
        kind="question"
        ref={(el) => (root = el)}
        onKeyDown={nav}
        header={
          <>
            <div data-slot="question-header-title">{summary()}</div>
            <div data-slot="question-header-actions">
              <Show when={total() > 1}>
                <div data-slot="question-progress">
                  <For each={questions()}>
                    {(_, i) => (
                      <button
                        type="button"
                        data-slot="question-progress-segment"
                        data-active={i() === store.tab}
                        data-answered={answered(i())}
                        disabled={sending()}
                        onClick={() => jump(i())}
                        aria-label={language.t("ui.tool.questions.numbered", { number: i() + 1 })}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <button
                type="button"
                data-component="icon-button"
                data-icon="chevron-down"
                data-size="normal"
                data-variant="ghost"
                disabled={sending()}
                style={{ transform: `rotate(${hidden() * 180}deg)` }}
                onClick={store.minimized ? restore : minimize}
                aria-label={language.t(store.minimized ? "session.question.restore" : "session.question.minimize")}
              >
                <Icon name="chevron-down" size="small" />
              </button>
            </div>
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
              {language.t("ui.common.dismiss")}
            </Button>
            <div data-slot="question-footer-actions">
              <Show when={store.tab > 0}>
                <Button variant="secondary" size="large" disabled={sending()} onClick={back}>
                  {language.t("ui.common.back")}
                </Button>
              </Show>
              <Button
                variant={last() ? "primary" : "secondary"}
                size="large"
                disabled={sending()}
                onClick={next}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              >
                {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
              </Button>
            </div>
          </>
        }
      >
        <div
          data-slot="question-text"
          style={{
            display: store.minimized ? "-webkit-box" : undefined,
            "-webkit-line-clamp": store.minimized ? "3" : undefined,
            "-webkit-box-orient": store.minimized ? "vertical" : undefined,
            overflow: store.minimized ? "hidden" : undefined,
          }}
        >
          {question()?.question}
        </div>
        <Show when={!store.minimized && options().length > 0}>
          <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
            <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
          </Show>
        </Show>
        <div
          ref={(el) => (optionsRef = el)}
          data-slot="question-options"
          aria-hidden={store.minimized || optionsOff() ? "true" : undefined}
          classList={{ "pointer-events-none": hidden() > 0.1 }}
          style={{
            "max-height": `${Math.max(0, store.optionsHeight * (1 - hidden()))}px`,
            opacity: `${Math.max(0, Math.min(1, 1 - hidden()))}`,
            visibility: optionsOff() ? "hidden" : "visible",
          }}
        >
          <For each={options()}>
            {(opt, i) => (
              <Option
                multi={multi()}
                picked={picked(opt.label)}
                label={opt.label}
                description={opt.description}
                disabled={sending()}
                ref={(el) => (optsRef[i()] = el)}
                onFocus={() => setStore("focus", i())}
                onClick={() => selectOption(i())}
              />
            )}
          </For>

          <Show when={customAllowed()}>
            <div data-slot="question-custom" data-active={store.editing} data-filled={input().trim().length > 0}>
              <div data-slot="question-custom-heading">
                <span data-slot="option-label">{customLabel()}</span>
                <Show when={options().length > 0}>
                  <span data-slot="question-custom-optional">{language.t("ui.question.custom.optional")}</span>
                </Show>
              </div>
              <div data-slot="question-custom-composer">
                <textarea
                  ref={(el) => {
                    customRef = el
                    resizeInput(el)
                  }}
                  data-slot="question-custom-input"
                  aria-label={customLabel()}
                  placeholder={customPlaceholder()}
                  value={input()}
                  rows={1}
                  maxlength={QUESTION_DETAIL_MAX_CHARS}
                  disabled={sending()}
                  onFocus={() => {
                    setStore("focus", options().length)
                    setStore("editing", true)
                    syncMention(input(), customRef?.selectionStart ?? input().length)
                  }}
                  onBlur={() => {
                    setStore("editing", false)
                    closeMention()
                  }}
                  onClick={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart)}
                  onKeyUp={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
                    syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
                  }}
                  onKeyDown={(e) => {
                    if (mention() && mentionItems().length > 0) {
                      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
                      if (plain && e.key === "ArrowDown") {
                        e.preventDefault()
                        moveMention(1)
                        return
                      }
                      if (plain && e.key === "ArrowUp") {
                        e.preventDefault()
                        moveMention(-1)
                        return
                      }
                      if (plain && (e.key === "Enter" || e.key === "Tab")) {
                        const item = mentionItems()[mentionActive()]
                        if (item) {
                          e.preventDefault()
                          selectMention(item)
                          return
                        }
                      }
                    }
                    if (mention() && e.key === "Escape") {
                      e.preventDefault()
                      closeMention()
                      return
                    }
                    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "Enter") return
                  }}
                  onInput={(e) => {
                    customUpdate(e.currentTarget.value)
                    resizeInput(e.currentTarget)
                    syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
                  }}
                />
              </div>
              <Show when={mention()}>
                {(token) => (
                  <PromptInputV2Popover
                    inline
                    emptyLabel={language.t("prompt.popover.emptyResults")}
                    items={mentionItems()}
                    activeID={mentionItems()[mentionActive()]?.id}
                    query={token().query}
                    onActiveChange={(item) => {
                      const index = mentionItems().findIndex((candidate) => candidate.id === item.id)
                      if (index >= 0) setMentionActive(index)
                    }}
                    onSelect={selectMention}
                  />
                )}
              </Show>
              <div data-slot="question-custom-hint">{language.t("ui.question.custom.mentionHint")}</div>
            </div>
          </Show>
        </div>
      </DockPrompt>
    </div>
  )
}
