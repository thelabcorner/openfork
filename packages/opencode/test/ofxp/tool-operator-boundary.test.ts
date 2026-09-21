import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "../../src/tool/ofxp"

const allowed = ["status", "peers", "roots", "list", "describe", "call", "receipt"] as const
const operatorOnly = ["pair", "trust", "grant", "approveRoot", "revoke", "rekey", "rotateIdentity", "start", "stop"] as const

describe("OFXP model/operator boundary", () => {
  test("accepts only the bounded model-facing action vocabulary", () => {
    for (const action of allowed) {
      expect(() => Schema.decodeUnknownSync(Parameters)({ action })).not.toThrow()
    }
  })

  test("rejects operator-owned trust, authority, and lifecycle actions", () => {
    for (const action of operatorOnly) {
      expect(() => Schema.decodeUnknownSync(Parameters)({ action })).toThrow()
    }
  })
})
