import { batch, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { proposeHarperAutofix, rejectHarperAutofix, rebaseHarperChanges, shiftHarperChanges, type AutoHarperChange } from "./harper-autofix"
import type { Prompt } from "@/context/prompt-state"
import { snapshotPrompt } from "@/context/prompt-snapshot"
import { applyHarperSuggestion, projectPromptForHarper, promptGrammarDraftIdentity, type PromptGrammarIssue } from "./harper-projection"
import { acquireHarper } from "./harper-worker"
import { lintHarperProjection } from "./harper-worker"

const DEBOUNCE_MS = 320

/**
 * Only mounted opt-in composers consume a shared Harper worker. No inference,
 * timer on each keypress, DOM mutation, or send-path hook.
 */
export function createPromptHarper(input: {
  enabled: Accessor<boolean>
  parts: Accessor<Prompt>
  locale: Accessor<string>
  ignoredWords: Accessor<readonly string[]>
  /** Second explicit opt-in: diagnostics alone never authorize mutations. */
  autoApply: Accessor<boolean>
  cursor?: Accessor<number | undefined>
  replace: (parts: Prompt, cursor: number, source?: "manual" | "auto" | "reject") => void
}) {
  const [issues, setIssues] = createSignal<PromptGrammarIssue[]>([])
  const [state, setState] = createSignal<"off" | "idle" | "loading" | "ready" | "unavailable">("off")
  const [undoStep, setUndoStep] = createSignal<{ before: Prompt; afterID: string; cursor: number }>()
  const [autoChanges, setAutoChanges] = createSignal<AutoHarperChange[]>([])
  const [rejectedWords, setRejectedWords] = createSignal<string[]>([])
  const [dismissedIssues, setDismissedIssues] = createSignal<string[]>([])
  let autoIdentity: string | undefined
  let autoUndoIdentity: string | undefined
  let autoReference: Prompt | undefined
  let diagnosedDraftID: string | undefined
  let dismissedDraftID: string | undefined
  let serial = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let lease: ReturnType<typeof acquireHarper> | undefined

  createEffect(() => {
    const active = input.enabled() && /^en(?:$|[-_])/i.test(input.locale())
    const revision = ++serial
    diagnosedDraftID = undefined
    if (timer !== undefined) clearTimeout(timer)

    // True zero-work opt-out: an inactive composer subscribes only to the
    // setting/mode, not every keystroke or draft mutation. No maps, abort
    // controllers or worker scheduling while the user has disabled Harper.
    if (!active) {
      setIssues([])
      setState("off")
      lease?.release()
      lease = undefined
      return
    }
    const parts = input.parts()
    // Dismissals are scoped to this exact draft, never globally persistent.
    // A substantive edit may introduce a new issue at the same old offsets.
    const currentID = promptGrammarDraftIdentity(parts)
    if (currentID !== dismissedDraftID) {
      dismissedDraftID = currentID
      setDismissedIssues([])
    }
    if (!parts.some((part) => part.type === "text" && part.content.trim())) {
      // A sent/cleared draft starts a new rejection scope. No stale preference
      // silently carries over to an unrelated future prompt.
      setRejectedWords([])
      setAutoChanges([])
      autoIdentity = undefined
      autoUndoIdentity = undefined
      autoReference = undefined
      setIssues([])
      setState("idle")
      return
    }
    const ignored = new Set(input.ignoredWords().map((word) => word.toLowerCase()))
    const cancellation = new AbortController()
    onCleanup(() => cancellation.abort())

    setIssues([])
    setState(lease ? "ready" : "loading")
    timer = setTimeout(() => {
      timer = undefined
      if (serial !== revision) return
      const projected = projectPromptForHarper(parts)
      if (!projected) {
        setState("idle")
        return
      }
      const identity = promptGrammarDraftIdentity(parts)
      if (!identity) {
        setState("idle")
        return
      }
      try {
        lease ??= acquireHarper()
      } catch {
        // Worker creation can be denied by CSP or a restricted WebView.
        // Grammar is strictly optional and must never affect the composer.
        setIssues([])
        setState("unavailable")
        return
      }
      void lease.ready.then(async (worker) => {
        if (serial !== revision) return
        const diagnostics = await lintHarperProjection(worker, projected, cancellation.signal)
        if (serial !== revision) return
        diagnosedDraftID = identity
        const filtered = diagnostics.filter((issue) => {
          const word = issue.original.toLowerCase()
          // Explicitly restored words are not mistakes awaiting another
          // suggestion—respect that rejection across spelling AND grammar.
          return !dismissedIssues().includes(issue.id) && !rejectedWords().includes(word) &&
            (issue.category !== "spelling" || !ignored.has(word))
        })
        if (input.autoApply() && input.enabled() && identity === promptGrammarDraftIdentity(input.parts())) {
          const proposed = proposeHarperAutofix(input.parts(), filtered, input.cursor?.(),
            new Set([...ignored, ...rejectedWords()]))
          if (proposed) {
            const afterID = promptGrammarDraftIdentity(proposed.parts)
            if (afterID) {
              const difference = proposed.change.replacement.length - proposed.change.original.length
              const oldEnd = proposed.change.start + proposed.change.original.length
              const shifted = shiftHarperChanges(autoChanges(), proposed.change.start, oldEnd, difference)
              // Commit prompt + metadata as one Solid transaction. Otherwise
              // observers can see an updated chip against the old prompt (or
              // vice versa) and invalidate a perfectly legitimate correction.
              batch(() => {
                autoIdentity = afterID
                autoUndoIdentity = afterID
                autoReference = snapshotPrompt(proposed.parts)
              setAutoChanges([...shifted, proposed.change].slice(-32))
                setIssues([])
                input.replace(proposed.parts, proposed.cursor, "auto")
                setState("ready")
              })
              return
            }
          }
        }
        setIssues(filtered)
        setState("ready")
      }).catch((error: unknown) => {
        if (serial !== revision || (error instanceof Error && error.name === "AbortError")) return
        console.warn("[harper] local worker unavailable", error instanceof Error ? error.message : String(error))
        setIssues([])
        setState("unavailable")
      })
    }, DEBOUNCE_MS)
  })

  createEffect(() => {
    const current = input.parts()
    const step = undoStep()
    const automatic = autoChanges()
    if (!input.enabled() || (step && promptGrammarDraftIdentity(current) !== step.afterID)) setUndoStep(undefined)
    if (automatic.length && promptGrammarDraftIdentity(current) !== autoIdentity) {
      const rebased = autoReference ? rebaseHarperChanges(autoReference, current, automatic) : undefined
      if (rebased?.length) {
        autoIdentity = promptGrammarDraftIdentity(current)
        // After the author manually types, Ctrl+Z belongs to the browser's
        // most recent edit. The older correction remains rejectable via UI.
        autoUndoIdentity = undefined
        autoReference = snapshotPrompt(current)
        setAutoChanges(rebased)
      } else {
        setAutoChanges([])
        autoIdentity = undefined
        autoUndoIdentity = undefined
        autoReference = undefined
      }
    }
  })

  onCleanup(() => {
    serial++
    if (timer !== undefined) clearTimeout(timer)
    lease?.release()
    lease = undefined
  })

  const apply = (issue: PromptGrammarIssue, replacement: string) => {
    if (!input.enabled() || !/^en(?:$|[-_])/i.test(input.locale())) return false
    if (!diagnosedDraftID || diagnosedDraftID !== promptGrammarDraftIdentity(input.parts())) return false
    if (!issues().some((value) => value.id === issue.id && value.original === issue.original)) return false
    const change = applyHarperSuggestion(input.parts(), issue, replacement)
    if (!change) return false
    // Retain a single, exact, local undo step. A subsequent edit, model change
    // or disabled setting clears it rather than risking a stale overwrite.
    const before = snapshotPrompt(input.parts())
    const originalCursor = input.cursor?.() ?? issue.end
    input.replace(change.parts, change.cursor, "manual")
    const afterID = promptGrammarDraftIdentity(change.parts)
    if (afterID) setUndoStep({ before, afterID, cursor: originalCursor })
    diagnosedDraftID = undefined
    setIssues([])
    return true
  }

  const dismiss = (id: string) => {
    if (!input.enabled() || !diagnosedDraftID ||
      diagnosedDraftID !== promptGrammarDraftIdentity(input.parts())) return false
    if (!issues().some((item) => item.id === id)) return false
    setDismissedIssues((old) => [...old, id])
    setIssues((old) => old.filter((item) => item.id !== id))
    return true
  }

  const reject = (id: string) => {
    if (!input.enabled() || !autoIdentity || autoIdentity !== promptGrammarDraftIdentity(input.parts())) return false
    const change = autoChanges().find((item) => item.id === id)
    if (!change) return false
    const restored = rejectHarperAutofix(input.parts(), change, input.cursor?.())
    if (!restored) return false
    const nextID = promptGrammarDraftIdentity(restored.parts)
    if (!nextID) return false
    const difference = change.original.length - change.replacement.length
    const shifted = shiftHarperChanges(autoChanges().filter((item) => item !== change),
      change.start, change.end, difference)
    batch(() => {
      setRejectedWords((old) => [...new Set([...old, change.original.toLowerCase()])])
      autoIdentity = nextID
      autoUndoIdentity = undefined
      autoReference = snapshotPrompt(restored.parts)
      setAutoChanges(shifted)
      diagnosedDraftID = undefined
      setIssues([])
      input.replace(restored.parts, restored.cursor, "reject")
    })
    return true
  }

  const undo = () => {
    const lastAuto = autoChanges().at(-1)
    if (lastAuto && autoUndoIdentity && autoUndoIdentity === promptGrammarDraftIdentity(input.parts()))
      return reject(lastAuto.id)
    const step = undoStep()
    if (!step || !input.enabled() || step.afterID !== promptGrammarDraftIdentity(input.parts())) return false
    setUndoStep(undefined)
    input.replace(step.before, step.cursor)
    return true
  }

  return {
    issues, state, apply, reject, dismiss, autoChanges, rejectedWords,
    undo, undoAvailable: () =>
      (autoChanges().length > 0 && !!autoUndoIdentity) || undoStep() !== undefined,
  }
}
