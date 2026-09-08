import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
  autoApproveAsks?: boolean
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const inherited = input.parentSessionPermission.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  )

  const sessionRules = input.autoApproveAsks
    ? [
        // A leading wildcard handles the implicit default-ask case. Replaying
        // the subagent rules after it preserves explicit allow/deny ordering
        // while turning only modal `ask` decisions into autonomous allows.
        { permission: "*", pattern: "*", action: "allow" as const },
        ...input.subagent.permission.map((rule) =>
          rule.action === "ask" ? { ...rule, action: "allow" as const } : rule,
        ),
        // Parent session rules remain a hard ceiling. A parent-session deny
        // still wins; inherited asks become allow so YOLO does not reintroduce
        // permission dialogs in child sessions.
        ...inherited.map((rule) => (rule.action === "ask" ? { ...rule, action: "allow" as const } : rule)),
      ]
    : inherited

  return [
    ...sessionRules,
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
