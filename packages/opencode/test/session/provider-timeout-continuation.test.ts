import { expect, test } from "bun:test"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import {
  MAX_PROVIDER_TIMEOUT_CONTINUATIONS,
  nextProviderTimeoutContinuationAttempt,
  PROVIDER_TIMEOUT_CONTINUATION_PROMPT,
} from "../../src/session/provider-timeout-continuation"

test("provider timeout continuations have a strictly bounded durable retry budget", () => {
  const source = SessionTurnProvenance.Source.ProviderTimeoutContinuation
  expect(MAX_PROVIDER_TIMEOUT_CONTINUATIONS).toBe(2)
  expect(nextProviderTimeoutContinuationAttempt({})).toBe(1)
  expect(nextProviderTimeoutContinuationAttempt({ provenance: { source: "model.switch" } })).toBe(1)
  expect(nextProviderTimeoutContinuationAttempt({ provenance: { source, ref: "1:msg_prior" } })).toBe(2)
  expect(nextProviderTimeoutContinuationAttempt({ provenance: { source, ref: "2:msg_prior" } })).toBeUndefined()
  expect(nextProviderTimeoutContinuationAttempt({ provenance: { source, ref: "garbled" } })).toBeUndefined()
  expect(nextProviderTimeoutContinuationAttempt({ provenance: { source, ref: "999999999999999:msg_x" } })).toBeUndefined()
})

test("timeout continuation resumes durable work without blindly replaying mutating tools", () => {
  expect(PROVIDER_TIMEOUT_CONTINUATION_PROMPT).toContain("Completed tool results")
  expect(PROVIDER_TIMEOUT_CONTINUATION_PROMPT).toContain("inspect the current state")
  expect(PROVIDER_TIMEOUT_CONTINUATION_PROMPT).toContain("do not replay")
})