import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Accessor } from "solid-js"
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"
import { normalizeReply } from "@opencode-ai/core/question-normalize"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ScopedKey } from "@/utils/server-scope"
import { showToast } from "@/utils/toast"
import { QUESTION_DETAIL_MAX_CHARS } from "./question-details"

/** Free-form answer text for one question, plus the composer parts that produced it. */
export type QuestionDraft = {
  text: string
  /** Opaque composer parts, kept so back-navigation restores mention chips losslessly. */
  parts?: unknown
}

/**
 * Two-way hook into whichever editor acts as the "additional details" field.
 * The normal prompt input binds itself here, so question details are authored
 * with the full composer — file/agent/skill `@` mentions included — instead of
 * a second, weaker textarea that has to reimplement all of it.
 */
export type QuestionDetailsBinding = {
  /** Must read through a reactive source so `canAdvance` tracks typing. */
  read: () => QuestionDraft
  write: (draft: QuestionDraft) => void
  clear: () => void
  focus: () => void
}

type CachedQuestionState = { index: number; answers: QuestionAnswer[]; drafts: QuestionDraft[] }

const CACHE_MAX = 100
const cache = new Map<string, CachedQuestionState>()

function remember(key: string, value: CachedQuestionState) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

/** Drops blank and duplicate labels — models occasionally emit both. */
export function questionOptions(question: QuestionInfo | undefined) {
  const seen = new Set<string>()
  return (question?.options ?? []).filter((option) => {
    const label = option.label.trim()
    if (!label || seen.has(label)) return false
    seen.add(label)
    return true
  })
}

export function questionCustomAllowed(question: QuestionInfo | undefined) {
  if (!question) return false
  return question.custom !== false || questionOptions(question).length === 0
}

export function createSessionQuestionController(input: { request: Accessor<QuestionRequest | undefined> }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const request = input.request
  const cacheKey = createMemo(() => {
    const current = request()
    return current ? ScopedKey.from(serverSDK().scope, current.id) : undefined
  })

  const [store, setStore] = createStore({
    id: undefined as string | undefined,
    index: 0,
    answers: [] as QuestionAnswer[],
    drafts: [] as QuestionDraft[],
    sending: false,
    minimized: false,
    /** Roving-focus position in the option list; -1 while focus lives elsewhere. */
    cursor: -1,
  })

  // Signal-backed so memos re-run when the composer binds or unbinds.
  const [binding, setBinding] = createSignal<QuestionDetailsBinding>()
  let replied = false
  let onSubmitted: (() => void) | undefined

  const questions = createMemo(() => request()?.questions ?? [])
  const total = createMemo(() => questions().length)
  const active = createMemo(() => total() > 0)
  const index = createMemo(() => Math.max(0, Math.min(store.index, Math.max(0, total() - 1))))
  const current = createMemo((): QuestionInfo | undefined => questions()[index()])
  const options = createMemo(() => questionOptions(current()))
  const multiple = createMemo(() => current()?.multiple === true)
  const customAllowed = createMemo(() => questionCustomAllowed(current()))
  const last = createMemo(() => index() >= total() - 1)

  /** Moves whatever sits in the bound composer into the current question's draft. */
  const captureDraft = () => {
    const bound = binding()
    if (!bound) return
    const draft = bound.read()
    setStore("drafts", index(), { text: draft.text.slice(0, QUESTION_DETAIL_MAX_CHARS), parts: draft.parts })
  }

  /**
   * Puts question `target`'s stored draft into the composer.
   *
   * `replace` wipes whatever is there first, which is right when stepping
   * between questions (the outgoing draft was just captured) but wrong when a
   * question first arrives — the composer may hold an ordinary message draft
   * the question interrupted, and clearing it would destroy the user's text.
   */
  const loadDraft = (target: number, options?: { replace?: boolean }) => {
    const bound = binding()
    if (!bound) return
    const draft = store.drafts[target]
    if (options?.replace) bound.clear()
    if (draft?.text) bound.write({ ...draft })
  }

  const persist = () => {
    const key = cacheKey()
    if (!key || replied) return
    remember(key, {
      index: store.index,
      answers: store.answers.map((answer) => (answer ? [...answer] : [])),
      drafts: store.drafts.map((draft) => ({ ...draft })),
    })
  }

  // Reset (or restore) whenever a different question request takes over.
  createEffect(
    on(
      () => request()?.id,
      (id) => {
        if (id === store.id) return
        replied = false
        const key = cacheKey()
        const restored = id && key ? cache.get(key) : undefined
        setStore({
          id,
          index: restored?.index ?? 0,
          answers: restored?.answers ?? [],
          drafts: restored?.drafts ?? [],
          sending: false,
          minimized: false,
          cursor: -1,
        })
        if (!id) return
        // A cached draft belongs back in the composer; an untouched composer
        // keeps whatever the user was already writing.
        loadDraft(restored?.index ?? 0)
      },
    ),
  )

  onCleanup(() => {
    captureDraft()
    persist()
  })

  const details = createMemo(() => {
    const bound = binding()
    if (bound) return bound.read().text
    return store.drafts[index()]?.text ?? ""
  })

  const picked = (label: string) => store.answers[index()]?.includes(label) ?? false

  const toggle = (label: string) => {
    if (store.sending) return
    const target = index()
    if (!multiple()) {
      // Re-picking the current answer clears it. A misclick on a single-choice
      // question would otherwise be unrecoverable without rejecting the whole
      // request, so the same gesture that chose an option also undoes it.
      setStore("answers", target, (answer = []) =>
        answer.length === 1 && answer[0] === label ? [] : [label],
      )
      return
    }
    setStore("answers", target, (answer = []) =>
      answer.includes(label) ? answer.filter((item) => item !== label) : [...answer, label],
    )
  }

  /** How many options the current question has selected. */
  const selected = createMemo(() => store.answers[index()]?.length ?? 0)

  /** Drops every selection for the current question, leaving details untouched. */
  const clearAnswer = () => {
    if (store.sending) return
    const target = index()
    if ((store.answers[target]?.length ?? 0) === 0) return
    setStore("answers", target, [])
  }

  const answeredAt = (target: number) => {
    if ((store.answers[target]?.length ?? 0) > 0) return true
    // A question that refuses custom answers discards details on the way out
    // (see `normalizeReply`), so text alone is not an answer there. Without
    // this, clearing a selection while details linger would leave Submit lit
    // and send nothing.
    if (!questionCustomAllowed(questions()[target])) return false
    // The live composer is authoritative for the question being shown.
    const text = target === index() ? details() : (store.drafts[target]?.text ?? "")
    return text.trim().length > 0
  }

  /** Enter/Send only means something once this question has an answer or details. */
  const canAdvance = createMemo(() => {
    if (store.sending || !active()) return false
    return answeredAt(index())
  })

  const fail = (error: unknown) => {
    showToast({
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    })
  }

  const goto = (target: number) => {
    if (store.sending) return
    const next = Math.max(0, Math.min(total() - 1, target))
    if (next === index()) return
    captureDraft()
    setStore({ index: next, cursor: -1 })
    loadDraft(next, { replace: true })
    binding()?.focus()
  }

  const finish = (run: () => Promise<unknown>, options?: { clearComposer?: boolean }) => {
    setStore("sending", true)
    onSubmitted?.()
    // Only a sent reply consumed the composer text. Dismissing must leave it
    // alone: it may be an ordinary message draft the question interrupted.
    if (options?.clearComposer) binding()?.clear()
    void run()
      .then(() => {
        replied = true
        const key = cacheKey()
        if (key) cache.delete(key)
      })
      .catch((error: unknown) => {
        setStore("sending", false)
        fail(error)
      })
  }

  const send = () => {
    const req = request()
    if (!req || store.sending) return
    captureDraft()
    const resolved = normalizeReply(questions(), {
      answers: store.answers,
      details: store.drafts.map((draft) => draft?.text ?? ""),
    })
    finish(
      () =>
        sdk().api.question.reply({
          sessionID: req.sessionID,
          requestID: req.id,
          answers: resolved.answers.map((answer) => [...answer]),
          details: [...resolved.details],
        }),
      { clearComposer: true },
    )
  }

  const dismiss = () => {
    const req = request()
    if (!req || store.sending) return
    finish(() => sdk().api.question.reject({ sessionID: req.sessionID, requestID: req.id }))
  }

  /** Primary action: walk the remaining questions, then reply. */
  const advance = () => {
    if (store.sending || !active()) return
    if (last()) {
      send()
      return
    }
    goto(index() + 1)
  }

  return {
    active,
    request,
    questions,
    total,
    index,
    current,
    options,
    multiple,
    customAllowed,
    last,
    details,
    picked,
    toggle,
    selected,
    clearAnswer,
    answeredAt,
    canAdvance,
    goto,
    back: () => goto(index() - 1),
    advance,
    send,
    dismiss,
    sending: () => store.sending,
    minimized: () => store.minimized,
    setMinimized: (value: boolean) => setStore("minimized", value),
    cursor: () => store.cursor,
    setCursor: (value: number) => setStore("cursor", value),
    onSubmitted: (handler: () => void) => {
      onSubmitted = handler
    },
    bound: () => !!binding(),
    bind(next: QuestionDetailsBinding) {
      setBinding(() => next)
      const draft = store.drafts[index()]
      if (draft?.text) next.write({ ...draft })
      return () => {
        if (binding() !== next) return
        captureDraft()
        setBinding(undefined)
      }
    },
  }
}

export type SessionQuestionController = ReturnType<typeof createSessionQuestionController>
