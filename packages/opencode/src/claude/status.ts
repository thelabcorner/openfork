// Setup/status contracts for first-party Claude provider.
// Unavailable/approval-required states are distinguishable from network errors.

import { Schema } from "effect"

export const SetupState = Schema.Literals(["not-configured", "cli-missing", "cli-auth-required", "approval-required", "ready", "error"])
export type SetupState = typeof SetupState.Type

export interface StatusInfo {
  readonly providerID: string
  readonly setupState: SetupState
  readonly messageKey: string // localization key, never hardcoded English
  readonly detail?: string
  readonly isRecoverable: boolean
  readonly actionKey?: string // localization key for the action label
}

export function unavailableState(messageKey: string, detail?: string): StatusInfo {
  return {
    providerID: "claude",
    setupState: "cli-auth-required",
    messageKey,
    detail,
    isRecoverable: true,
    actionKey: "provider.setup.action.setup",
  }
}

export function approvalRequiredState(messageKey: string): StatusInfo {
  return {
    providerID: "claude",
    setupState: "approval-required",
    messageKey,
    isRecoverable: true,
    actionKey: "provider.setup.action.approve",
  }
}

export function readyState(): StatusInfo {
  return {
    providerID: "claude",
    setupState: "ready",
    messageKey: "provider.setup.status.ready",
    isRecoverable: false,
  }
}

export * as ClaudeStatus from "./status"
