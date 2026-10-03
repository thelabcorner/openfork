import { Agent } from "@opencode-ai/schema/agent"

export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

/**
 * Chooser eligibility is derived from the shared agent contract rather than
 * re-encoding the `mode` enum here, so the composer, the @mention palette, and
 * Agent Studio cannot drift apart. `mode` arrives as `string` from the wire
 * catalog; an unrecognized value is treated as `all`, which is also what the
 * runtime uses for a custom agent with no configured mode.
 */
function normalize(item: { hidden?: boolean; mode: string }) {
  const mode =
    item.mode === "primary" || item.mode === "subagent" || item.mode === "all" ? (item.mode as Agent.Mode) : "all"
  return Agent.exposure({ mode, hidden: item.hidden === true })
}

export function isPrimarySelectableAgent(item: { hidden?: boolean; mode: string }) {
  return normalize(item).composer
}

export function isSubagentMentionableAgent(item: { hidden?: boolean; mode: string }) {
  return normalize(item).mention
}

export function isDelegatableAgent(item: { hidden?: boolean; mode: string }) {
  // `hidden` is a discoverability flag only. `Task` resolves `subagent_type`
  // against the canonical catalog by exact name and the host refuses a
  // `primary` agent, so delegation depends on `mode` alone.
  return normalize(item).delegation
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
