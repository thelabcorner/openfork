/**
 * Main-process authority for the logical lifetime of hosted-browser tabs.
 *
 * The renderer still owns the <webview> DOM element because that gives the
 * browser canvas/overlays one CSS coordinate and compositing space. It does
 * NOT own whether a tab exists. Every presentation attach/detach is admitted
 * through this coordinator, which prevents a late renderer event from
 * resurrecting a tab that main has already closed.
 *
 * There are deliberately two generations in the browser stack:
 * - lifecycleGeneration (here): logical close/re-create epochs for a tab id.
 * - presentation generation (HostedBrowserWebview remountKey): replacement
 *   <webview> instances inside one logical lifetime.
 *
 * Keeping them separate is what makes close-vs-register races deterministic.
 */
export type BrowserTabLifecyclePhase = "requested" | "attached" | "detached" | "closing"

export interface BrowserTabLifecycleSnapshot {
  readonly generation: number
  readonly phase: BrowserTabLifecyclePhase
}

export class BrowserTabLifecycle {
  private readonly entries = new Map<string, BrowserTabLifecycleSnapshot>()
  /** Process-monotonic so closed entries can be forgotten without making a
   * same-id recreation indistinguishable from delayed IPC from its predecessor. */
  private nextGeneration = 1

  /** Begin a new logical lifetime with a process-unique epoch. */
  request(tabId: string): number {
    const previous = this.entries.get(tabId)
    if (previous) {
      throw new Error(`Browser tab "${tabId}" already has an active lifecycle`)
    }
    const generation = this.nextGeneration++
    this.entries.set(tabId, { generation, phase: "requested" })
    return generation
  }

  snapshot(tabId: string): BrowserTabLifecycleSnapshot | undefined {
    return this.entries.get(tabId)
  }

  /** Engine teardown: release all active lifetime metadata. Generation stays
   * monotonic if the same engine instance is started again. */
  clear(): void {
    this.entries.clear()
  }

  isCurrent(tabId: string, generation: number): boolean {
    return this.entries.get(tabId)?.generation === generation
  }

  /** True only while a renderer is still allowed to attach/re-attach a view. */
  canAttach(tabId: string, generation: number): boolean {
    const current = this.entries.get(tabId)
    if (!current || current.generation !== generation) return false
    return current.phase === "requested" || current.phase === "detached" || current.phase === "attached"
  }

  markAttached(tabId: string, generation: number): boolean {
    if (!this.canAttach(tabId, generation)) return false
    this.entries.set(tabId, { generation, phase: "attached" })
    return true
  }

  /** Presentation disappeared; the logical tab remains alive and re-attachable. */
  markDetached(tabId: string, generation: number): boolean {
    const current = this.entries.get(tabId)
    if (!current || current.generation !== generation) return false
    if (current.phase !== "attached" && current.phase !== "detached" && current.phase !== "requested") return false
    this.entries.set(tabId, { generation, phase: "detached" })
    return true
  }

  /** Claim close before destructive work. Once closing, no new view may attach. */
  beginClose(tabId: string, generation?: number): BrowserTabLifecycleSnapshot | undefined {
    const current = this.entries.get(tabId)
    if (!current) return undefined
    if (generation !== undefined && current.generation !== generation) return undefined
    if (current.phase === "closing") return undefined
    const next = { generation: current.generation, phase: "closing" as const }
    this.entries.set(tabId, next)
    return next
  }

  finishClose(tabId: string, generation?: number): boolean {
    const current = this.entries.get(tabId)
    if (!current) return false
    if (generation !== undefined && current.generation !== generation) return false
    // Absence is itself sufficient to reject late IPC. The monotonic epoch
    // ensures a future same-id lifetime cannot accidentally accept it either.
    this.entries.delete(tabId)
    return true
  }
}
