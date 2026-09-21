import { expect, test } from "bun:test"
import type {
  SessionInputAdmitted,
  SessionMessageCompaction,
  SessionMessageSynthetic,
  SessionMessageUser,
  V2SessionPromptData,
} from "../src/v2/gen/types.gen"

test("V2 SDK exposes provenance only on server-owned turn state", () => {
  type RequestHasProvenance = "provenance" extends keyof V2SessionPromptData["body"] ? true : false
  type AdmissionHasProvenance = "provenance" extends keyof SessionInputAdmitted ? true : false
  type UserHasProvenance = "provenance" extends keyof SessionMessageUser ? true : false
  type SyntheticHasProvenance = "provenance" extends keyof SessionMessageSynthetic ? true : false
  type CompactionHasProvenance = "provenance" extends keyof SessionMessageCompaction ? true : false

  const requestHasProvenance: RequestHasProvenance = false
  const responseShapesHaveProvenance: [
    AdmissionHasProvenance,
    UserHasProvenance,
    SyntheticHasProvenance,
    CompactionHasProvenance,
  ] = [true, true, true, true]

  expect(requestHasProvenance).toBe(false)
  expect(responseShapesHaveProvenance).toEqual([true, true, true, true])
})
