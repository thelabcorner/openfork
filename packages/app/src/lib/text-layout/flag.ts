/**
 * OPENCODE_TEXT_LAYOUT feature flag: values off | prior | pretext, default off.
 *
 * - "off":     the estimator is inert; the timeline keeps its fixed fallback
 *              size and behavior is byte-identical to the un-flagged build.
 * - "prior":   per-row-type EWMA priors and width-bucketed history are used;
 *              pretext is never invoked.
 * - "pretext": pretext geometry prediction is allowed above the priors.
 *
 * Read once per call (not at module load) so tests can override via `input`
 * and the app can flip the flag without stale cached state.
 */

export type TextLayoutMode = "off" | "prior" | "pretext"

const MODES: readonly TextLayoutMode[] = ["off", "prior", "pretext"]

const flagEnv = () =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    "OPENCODE_TEXT_LAYOUT"
  ]

// Direct member access so Vite statically replaces it in production builds
// (dynamic access would never flip the flag in the bundle).
const flagViteEnv = () => import.meta.env.VITE_OPENCODE_TEXT_LAYOUT

export function textLayoutMode(input?: string): TextLayoutMode {
  const raw = input ?? flagEnv() ?? flagViteEnv()
  if (!raw) return "off"
  const value = raw.trim().toLowerCase()
  return (MODES as readonly string[]).includes(value) ? (value as TextLayoutMode) : "off"
}
