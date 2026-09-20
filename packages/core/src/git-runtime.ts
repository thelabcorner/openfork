export * as GitRuntime from "./git-runtime"
import * as ProcessEnvironment from "./process-environment"

const MAX_INHERITED_CONFIG_PAIRS = 4096

export const eolConfig = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
] as const

const eolConfigKeys = new Set<string>(eolConfig.map(([key]) => key.toLowerCase()))
const eolArgs = eolConfig.flatMap(([key, value]) => ["-c", `${key}=${value}`])
const runtimeConfigName = /^GIT_CONFIG_(COUNT|KEY_(\d+)|VALUE_(\d+))$/i
type RuntimeConfigSlot = { key?: string; value?: string }

function takeInheritedConfig(env: NodeJS.ProcessEnv): Array<readonly [string, string]> {
  let raw: string | undefined
  let slots: Map<number, RuntimeConfigSlot> | undefined

  // Extract and remove the complete command-scope Git namespace in one pass.
  // The previous implementation repeatedly scanned every environment key for
  // COUNT and each KEY_n/VALUE_n pair, then scanned it again for deletion.
  for (const name in env) {
    const value = env[name]
    const match = runtimeConfigName.exec(name)
    if (!match) continue
    delete env[name]
    if (match[1]!.toUpperCase() === "COUNT") {
      if (raw === undefined) raw = value
      continue
    }
    if (value === undefined) continue
    const index = Number(match[2] ?? match[3])
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INHERITED_CONFIG_PAIRS) continue
    slots ??= new Map()
    const slot = slots.get(index) ?? {}
    if (match[2] !== undefined) {
      if (slot.key === undefined) slot.key = value
    } else if (slot.value === undefined) slot.value = value
    slots.set(index, slot)
  }

  if (raw === undefined || raw === "") return []
  if (!/^\d+$/.test(raw)) return []
  const count = Number(raw)
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_INHERITED_CONFIG_PAIRS) return []

  const pairs: Array<readonly [string, string]> = []
  for (let i = 0; i < count; i++) {
    const slot = slots?.get(i)
    if (slot?.key === undefined || slot.value === undefined) return []
    // Reapplying the boundary to an already-owned child must be idempotent.
    // Otherwise nested OpenCode processes add two GIT_CONFIG pairs per
    // generation and grow their environment without bound.
    if (eolConfigKeys.has(slot.key.toLowerCase())) continue
    pairs.push([slot.key, slot.value])
  }
  return pairs
}

/**
 * Canonical Git policy for every OpenCode-owned child process.
 *
 * Git for Windows commonly installs with system core.autocrlf=true. Letting
 * arbitrary child processes inherit that host default makes checkout/reset/
 * worktree commands silently materialize LF index blobs as CRLF. Injecting
 * command-scope config here makes the process tree deterministic without
 * mutating repository config. An explicit later git -c option still wins.
 *
 * Existing valid GIT_CONFIG_COUNT pairs are retained in-order. A malformed
 * inherited sequence is discarded because Git itself would reject it.
 */
export function environment(
  base: NodeJS.ProcessEnv | undefined,
  overrides: NodeJS.ProcessEnv | undefined = undefined,
): NodeJS.ProcessEnv {
  const env = ProcessEnvironment.merge(base, overrides)
  const inherited = takeInheritedConfig(env)
  env.GIT_CONFIG_COUNT = String(inherited.length + eolConfig.length)
  let index = 0
  for (const [key, value] of inherited) {
    env["GIT_CONFIG_KEY_" + index] = key
    env["GIT_CONFIG_VALUE_" + index] = value
    index++
  }
  for (const [key, value] of eolConfig) {
    env["GIT_CONFIG_KEY_" + index] = key
    env["GIT_CONFIG_VALUE_" + index] = value
    index++
  }
  return env
}

/** Defaults for direct Git argv calls. Later caller-provided -c options win. */
export function args(input: readonly string[]): string[] {
  return [...eolArgs, ...input]
}
