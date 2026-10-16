import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import { Persist, persisted } from "@/utils/persist"
import {
  clonePromptHistoryComments,
  clonePromptParts,
  migratePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryStoredEntry,
} from "./history"

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) => void
}

type PromptHistoryState = { entries: PromptHistoryStoredEntry[] }

function createPromptInputHistoryStore(
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  return {
    entries: (mode) => (mode === "shell" ? shell.entries : normal.entries),
    add(prompt, mode, comments) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      const next = prependHistoryEntry(current.entries, prompt, comments)
      if (next === current.entries) return
      setCurrent("entries", next)
    },
  }
}

export function createPromptInputHistory(): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ entries: [] })
  const [shell, setShell] = createStore<PromptHistoryState>({ entries: [] })
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

export function createPersistedPromptInputHistory() {
  let normalHistoryCompacted = false
  const migrateNormalHistory = (value: unknown) => {
    const next = migratePromptHistory(value)
    normalHistoryCompacted ||= next !== value
    return next
  }
  const [normal, setNormal, normalInit] = persisted(
    Persist.prompt({ ...Persist.global("prompt-history", ["prompt-history.v1"]), migrate: migrateNormalHistory }),
    createStore<PromptHistoryState>({ entries: [] }),
  )
  let shellHistoryCompacted = false
  const migrateShellHistory = (value: unknown) => {
    const next = migratePromptHistory(value)
    shellHistoryCompacted ||= next !== value
    return next
  }
  const [shell, setShell, shellInit] = persisted(
    {
      ...Persist.prompt(Persist.global("prompt-history-shell", ["prompt-history-shell.v1"])),
      defer: true,
      migrate: migrateShellHistory,
    },
    createStore<PromptHistoryState>({ entries: [] }),
  )
  const persistCompaction = (
    init: string | null | Promise<string | null>,
    compacted: () => boolean,
    entries: () => PromptHistoryStoredEntry[],
    setEntries: SetStoreFunction<PromptHistoryState>,
  ) => {
    const persist = () => {
      if (compacted()) setEntries("entries", entries().slice())
    }
    if (init instanceof Promise) void init.then(persist)
    else persist()
  }
  // `migrate` bounds the in-memory value before it reaches the UI. Persist the
  // compacted representation once so an old oversized value does not get
  // parsed again on every launch. The normal history remains after-paint and
  // shell history remains deferred by its Persist target.
  persistCompaction(normalInit, () => normalHistoryCompacted, () => normal.entries, setNormal)
  persistCompaction(shellInit, () => shellHistoryCompacted, () => shell.entries, setShell)
  const history = createPromptInputHistoryStore(normal, setNormal, shell, setShell)
  return {
    ...history,
    add(prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) {
      const ready = mode === "shell" ? shellInit : normalInit
      if (!(ready instanceof Promise)) return history.add(prompt, mode, comments)
      const saved = clonePromptParts(prompt)
      const metadata = clonePromptHistoryComments(comments)
      void ready.then(() => history.add(saved, mode, metadata))
    },
  }
}
