/**
 * Pretext-backed text measurement adapter (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * Contract:
 *   - prepareTextLayout(text, typography, options?) -> PreparedTextHandle | undefined
 *       One-time analysis pass (normalize whitespace, segment, measure with
 *       canvas). Expensive; result is cached by content identity WITHOUT width.
 *   - estimateTextHeight(input, typography, widthPx, options?) -> number | undefined
 *       Cheap hot path: pure arithmetic over a prepared handle. Accepts either
 *       a PreparedTextHandle or a raw string (preparing through the shared LRU
 *       cache on miss).
 *
 * Pretext is loaded LAZILY via dynamic import so it never lands on the
 * critical render path. The first estimate call after load may miss (returns
 * undefined and the caller falls back); the warm-up import is kicked at first
 * use and the module is retained for subsequent synchronous calls.
 *
 * Determinism: cache is a pure accelerator. Same (text, typography, width)
 * always yields the same height, regardless of eviction state.
 */

import { PreparedTextCache, preparedCacheKey, type PreparedTextHandle } from "./prepared-cache"
import { canvasFont, type TextTypography, type WhiteSpaceMode } from "./typography"

type PretextModule = typeof import("@chenglou/pretext")

export type PrepareTextOptions = {
  whiteSpace?: WhiteSpaceMode
}

let pretextModule: PretextModule | undefined
let pretextPromise: Promise<PretextModule | undefined> | undefined

function ensurePretext(): Promise<PretextModule | undefined> {
  if (pretextModule) return Promise.resolve(pretextModule)
  pretextPromise ??= import("@chenglou/pretext")
    .then((mod) => {
      pretextModule = mod
      return mod
    })
    .catch(() => {
      pretextPromise = undefined
      return undefined
    })
  return pretextPromise
}

const preparedCache = new PreparedTextCache()

export { PreparedTextCache }

export function clearPreparedCache() {
  preparedCache.clear()
}

function optionsKey(whiteSpace: WhiteSpaceMode) {
  return whiteSpace
}

export function prepareTextLayout(
  text: string,
  typography: TextTypography,
  options?: PrepareTextOptions,
): PreparedTextHandle | undefined {
  if (!text) return
  const mod = pretextModule
  if (!mod) {
    void ensurePretext()
    return
  }
  const whiteSpace = options?.whiteSpace ?? "normal"
  const key = `${preparedCacheKey(text, typography)}\0${optionsKey(whiteSpace)}`
  const cached = preparedCache.get(key)
  if (cached) return cached
  try {
    const prepared = mod.prepare(text, canvasFont(typography), {
      whiteSpace,
      ...(typography.letterSpacingPx ? { letterSpacing: typography.letterSpacingPx } : {}),
    })
    const handle: PreparedTextHandle = { __prepared: prepared }
    preparedCache.set(key, handle, text.length)
    return handle
  } catch {
    return
  }
}

export function estimateTextHeight(
  input: string | PreparedTextHandle,
  typography: TextTypography,
  widthPx: number,
  options?: PrepareTextOptions,
): number | undefined {
  if (typeof input === "string") {
    const handle = prepareTextLayout(input, typography, options)
    if (!handle) return
    return layoutHandle(handle, typography, widthPx)
  }
  return layoutHandle(input, typography, widthPx)
}

function layoutHandle(handle: PreparedTextHandle, typography: TextTypography, widthPx: number) {
  const mod = pretextModule
  if (!mod) return
  const width = Math.max(1, Math.floor(widthPx))
  try {
    const { height, lineCount } = mod.layout(handle.__prepared as never, width, typography.lineHeightPx)
    // Browsers still size an empty block to one line-height; match that.
    return Math.max(typography.lineHeightPx, height, (lineCount || 1) * typography.lineHeightPx)
  } catch {
    return
  }
}

/** Pre-warm the lazy pretext module (fire and forget). Returns true when
 * pretext is already available synchronously. */
export function warmPretext() {
  void ensurePretext()
  return !!pretextModule
}

/** Await the lazy pretext module (tests / warm-up points). Resolves with the
 * module or undefined when it cannot load (e.g. no canvas / Intl.Segmenter). */
export function loadPretext() {
  return ensurePretext()
}
