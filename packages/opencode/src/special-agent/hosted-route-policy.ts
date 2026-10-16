import { Agent as AgentContract } from "@opencode-ai/schema/agent"

// Goal, SPAD, and project-copy naming are host-owned request-local runtimes,
// not catalogued built-ins. The canonical topology owns the other identities,
// including Dreamer, Summary, Title, Compaction and Prompt Revisor.
const REQUEST_LOCAL_AGENTS: ReadonlySet<string> = new Set([
  "goal-auditor",
  "goal-revisor",
  "spad-auditor",
  "project-copy-name",
])

export function isHostOwnedSpecialAgent(name: string): boolean {
  return AgentContract.isSpecialAgentID(name) || REQUEST_LOCAL_AGENTS.has(name)
}

/**
 * One semantic rule used at both Session admission and LLM dispatch.
 * The provider layer still owns hosted-provider classification; callers supply
 * that fact rather than this module independently redefining the provider list.
 * Session identity can outlive a particular turn's agent selection, so the
 * Session admission path checks both owned identities.
 */
export function requiresAccountBackedHostedRoute(input: {
  readonly hostedProvider: boolean
  readonly agent: string
  readonly sessionAgent?: string
}): boolean {
  return input.hostedProvider &&
    (isHostOwnedSpecialAgent(input.agent) ||
      (input.sessionAgent !== undefined && isHostOwnedSpecialAgent(input.sessionAgent)))
}