export * as GoalStateMachine from "./state-machine"

import { Goal } from "@opencode-ai/schema/goal"

export type Action =
  | "start"
  | "pause"
  | "resume"
  | "block"
  | "request_verification"
  | "verification_pass"
  | "verification_fail"
  | "cancel"
  | "fail"

const terminal = new Set<Goal.Status>(["completed", "cancelled", "failed"])

const transitions: Readonly<Record<Goal.Status, Readonly<Partial<Record<Action, Goal.Status>>>>> = {
  draft: { start: "active", cancel: "cancelled", fail: "failed" },
  active: {
    pause: "paused",
    block: "blocked",
    request_verification: "verifying",
    cancel: "cancelled",
    fail: "failed",
  },
  paused: { resume: "active", cancel: "cancelled", fail: "failed" },
  blocked: { resume: "active", cancel: "cancelled", fail: "failed" },
  verifying: { verification_pass: "completed", verification_fail: "active", cancel: "cancelled", fail: "failed" },
  completed: {},
  cancelled: {},
  failed: {},
}

export function next(status: Goal.Status, action: Action): Goal.Status | undefined {
  return transitions[status][action]
}

export function can(status: Goal.Status, action: Action): boolean {
  return next(status, action) !== undefined
}

export function isTerminal(status: Goal.Status): boolean {
  return terminal.has(status)
}

export function actions(status: Goal.Status): readonly Action[] {
  return Object.keys(transitions[status]) as Action[]
}
