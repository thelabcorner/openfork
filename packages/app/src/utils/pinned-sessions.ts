import { createSignal } from "solid-js"

const STORAGE_KEY = "opencode.session.pinned"

function load(): Set<string> {
  if (typeof localStorage === "undefined") return new Set()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((item) => typeof item === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function persist(next: Set<string>) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // storage unavailable/full — pin state stays in-memory for this session
  }
}

const [pinned, setPinned] = createSignal<Set<string>>(load())

export function isSessionPinned(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return pinned().has(sessionID)
}

export function toggleSessionPin(sessionID: string): boolean {
  const next = new Set(pinned())
  const willPin = !next.has(sessionID)
  if (willPin) next.add(sessionID)
  else next.delete(sessionID)
  setPinned(next)
  persist(next)
  return willPin
}

export function pinnedSessionIds() {
  return pinned()
}
