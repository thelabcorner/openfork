import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { OpenCodeHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { PermissionNotFoundError, QuestionNotFoundError } from "../../src/server/routes/instance/httpapi/errors"
import { UpdatePayload } from "../../src/server/routes/instance/httpapi/groups/session"

type Method = "get" | "post" | "patch"
type Parameter = { readonly name?: string; readonly in?: string; readonly schema?: { allOf?: ReadonlyArray<{ pattern?: string }> } }
type Operation = {
  readonly parameters?: ReadonlyArray<Parameter>
  readonly responses?: Record<string, { readonly content?: Record<string, { readonly schema?: unknown }> }>
}
type Spec = {
  readonly paths: Record<string, Partial<Record<Method, Operation>>>
}

/**
 * Retained-v1 (OpenCode SDK 1.15.13) tool / permission / question RESPONSE contract.
 *
 * Latest stock T3 Code (origin/main a21702d0e) negotiates generation by SEMVER MAJOR, not by
 * route presence, and this wrapper reports 1.15.13 (`/api/info` 404, `/global/health` 200).
 * That selects the v1 client, so these are the response paths latest T3 actually consumes and
 * they must not be treated as v1-only artifacts.
 *
 * The pre-existing suite (test/server/t3code-compat-contract.test.ts) asserts route existence,
 * param shape and payload acceptance. It never asserts a status code, a response envelope, or
 * that a payload survives decode UNALTERED. This file closes that gap for the tool/permission/
 * question surfaces.
 *
 * OWNERSHIP SCOPE — read before citing anything here as a T3 contract. The reply DOMAIN and the
 * rule-name assertions below characterize OpenFork's OWN schema. They are NOT immutable T3 wire
 * vocabulary, and OpenFork must not be read as defining T3's contract. Concretely: both audited
 * stock generations type their outgoing mapper as exactly three values —
 *   old    t3-old-0fcd5f9      apps/server/src/provider/opencodeRuntime.ts:542-556
 *   latest t3-latest-a21702d0e apps/server/src/provider/opencodeRuntime.ts:546-560
 *     toOpenCodePermissionReply(decision): "once" | "always" | "reject"
 * and latest OpenCodeAdapterV2.ts:3490-3501 sends only that mapper's output. So T3's outgoing
 * vocabulary is a strict SUBSET of OpenFork's four. Accepting the fourth is a compatible superset:
 * never required by T3, never contradicted by it. Read those snapshots read-only; never edit them.
 *
 * Evidence class: unit/contract over the OpenApi description and pure schema/permission
 * functions. NOT a stock-T3 process/HTTP/SSE end-to-end proof.
 */
describe("retained v1 tool / permission / question response contract", () => {
  const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

  /** Status -> OpenAPI schema identity (component $ref or bare type), so a 200 with the
   * wrong shape fails here instead of passing as "accepted". */
  const envelopes = (path: string, method: Method) => {
    const operation = spec.paths[path]?.[method]
    if (!operation?.responses) throw new Error(`${method.toUpperCase()} ${path} declares no responses`)
    const out: Record<string, string> = {}
    for (const [code, response] of Object.entries(operation.responses)) {
      const schema = response.content?.["application/json"]?.schema as
        | { $ref?: string; type?: string; items?: unknown }
        | undefined
      out[code] = schema?.$ref ?? `${schema?.type ?? "no-body"}${schema?.items ? "[]" : ""}`
    }
    return out
  }

  test("pending-request lists answer an array envelope and declare no not-found error", () => {
    // A list has no request id to miss, so it must not be able to answer 404 for an id:
    // T3 distinguishes "no pending requests" (200 []) from "unknown request" (404 + tag).
    expect(envelopes("/permission", "get")).toEqual({
      "200": "array[]",
      "400": "#/components/schemas/InvalidRequestError",
      "401": "no-body",
    })
    expect(envelopes("/question", "get")).toEqual({
      "200": "array[]",
      "400": "#/components/schemas/InvalidRequestError",
      "401": "no-body",
    })
  })

  test("permission reply distinguishes a real decision from an unknown request id", () => {
    // The high-severity shape-only gap: a 200-with-boolean plus a missing 404 makes an unknown
    // id indistinguishable from a real approval, i.e. a silent cross-boundary decision.
    expect(envelopes("/permission/{requestID}/reply", "post")).toEqual({
      "200": "boolean",
      "400": "#/components/schemas/effect_HttpApiError_BadRequest",
      "401": "no-body",
      "404": "#/components/schemas/PermissionNotFoundError",
    })
  })

  test("question reply distinguishes a real answer from an unknown request id", () => {
    expect(envelopes("/question/{requestID}/reply", "post")).toEqual({
      "200": "boolean",
      "400": "#/components/schemas/effect_HttpApiError_BadRequest",
      "401": "no-body",
      "404": "#/components/schemas/QuestionNotFoundError",
    })
  })

  test("the not-found errors T3 must branch on are 404 and carry the request id", () => {
    // Statuses alone are not enough: T3 renders these as user-facing failures, so the body has
    // to be a parseable tagged error naming the id, not a bare string.
    expect(new PermissionNotFoundError({ requestID: "per_x", message: "gone" })._tag).toBe("PermissionNotFoundError")
    expect(new QuestionNotFoundError({ requestID: "que_x", message: "gone" })._tag).toBe("QuestionNotFoundError")
  })

  test("reply request ids are brand-constrained on the wire, per family", () => {
    // T3 addresses each request family by a prefixed id. Assert the constraint T3 actually sees
    // on the wire rather than only in TS types, so a wrong-family id fails at the edge instead
    // of being looked up against the wrong pending-request registry.
    const patternOf = (path: string) =>
      spec.paths[path]?.post?.parameters?.find((p) => p.in === "path")?.schema?.allOf?.[0]?.pattern
    expect(patternOf("/permission/{requestID}/reply")).toBe("^per")
    expect(patternOf("/question/{requestID}/reply")).toBe("^que")
  })

  test("PATCH /session/{sessionID} keeps its singular `permission` ruleset key", () => {
    // Latest T3 v2 renamed this key to plural `permissions` (OpenCode2AdapterV2.ts
    // writeRules -> session.update({ sessionID, permissions })), while v1 sends singular
    // `permission` (OpenCodeAdapterV2.ts:3013, :1421, :3577). The retained v1 key is singular;
    // assert it so a rename cannot land unnoticed.
    expect(envelopes("/session/{sessionID}", "patch")["200"]).toBe("#/components/schemas/Session4")
    expect(Schema.is(UpdatePayload)({ permission: [{ permission: "edit", pattern: "*", action: "ask" }] })).toBe(true)
  })

  test("undeclared T3 permission rule names survive decode UNALTERED, not merely tolerated", () => {
    // `codesearch` is a permission name latest T3 writes that OpenFork does not implement
    // (zero hits). Compatibility therefore rests on three canonical properties, not a shim:
    // Rule.permission is Schema.String (not an enum), evaluate() matches generically by name,
    // and core config permission carries a StructWithRest Record(String, Rule).
    //
    // Assert the payload survives intact. A decode that merely returned 2xx while dropping or
    // rewriting the rule would pass a weaker assertion and silently change what T3 can express.
    const rules = [
      { permission: "codesearch", pattern: "**", action: "ask" },
      { permission: "doom_loop", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "C:\\outside", action: "deny" },
    ] as const

    const decoded = Schema.decodeUnknownSync(UpdatePayload)({ permission: rules })
    expect(decoded).toEqual({ permission: rules })
    expect((decoded as { permission: ReadonlyArray<{ permission: string }> }).permission.map((r) => r.permission)).toEqual([
      "codesearch",
      "doom_loop",
      "external_directory",
    ])

    // Pin OPENNESS as the property itself, not just three lucky spellings: the rule-name domain
    // must stay an unconstrained string, so a name invented after this test was written decodes
    // unchanged. If `Rule.permission` ever tightens into an enum this fails, which is the point —
    // a closed set would silently drop T3 rules it does not know by name.
    const invented = "zqx_perm_invented_999"
    expect(invented).not.toBe("codesearch")
    expect(Schema.is(PermissionV1.Rule)({ permission: invented, pattern: "**", action: "ask" })).toBe(true)
    expect(Schema.decodeUnknownSync(PermissionV1.Rule)({ permission: invented, pattern: "**", action: "ask" })).toEqual({
      permission: invented,
      pattern: "**",
      action: "ask",
    })
    // ...while the sibling `action` field IS a closed set, so the rule-name openness above is
    // deliberate rather than an artifact of the whole Rule being unconstrained.
    expect(Schema.is(PermissionV1.Rule)({ permission: invented, pattern: "**", action: "allowish" })).toBe(false)
  })

  test("a plural `permissions` key does not silently populate the v1 ruleset", () => {
    // Hazard pin, stated in the dangerous direction. If a future T3 sends the v2 plural key
    // while this server still declares the v1 singular key, an excess key is dropped rather
    // than rejected: the call looks successful and the session keeps its PREVIOUS rules. That
    // is a silent privilege change, so it must be visible here. If this assertion ever fails,
    // the generation-negotiation gate has changed and the v2 shape is being served.
    const decoded = Schema.decodeUnknownSync(UpdatePayload)({
      permissions: [{ permission: "edit", pattern: "*", action: "ask" }],
    }) as Record<string, unknown>
    expect(
      decoded.permission,
      "v2 plural `permissions` reached the v1 ruleset; re-examine generation negotiation before accepting",
    ).toBeUndefined()
  })

  test("permission evaluation is generic by name, with no closed set of permission names", () => {
    // This is what lets an unknown T3 permission code work without a compatibility shim: the
    // rule is matched by name against the ruleset, never dispatched through an enum.
    const ruleset: PermissionV1.Ruleset = [{ permission: "doom_loop", pattern: "*", action: "deny" }]
    expect(Permission.evaluate("doom_loop", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("codesearch", "*", ruleset).action).not.toBe("allow")
    expect(Permission.evaluate("anything/at/all", "*", ruleset).action).not.toBe("allow")
  })

  test("an unmatched permission falls back to ask, never to allow", () => {
    // The fail-closed default (permission/index.ts:44-48). Name the permissive direction: a
    // default-to-allow edit would satisfy every tool without an approved rule.
    const resolved = Permission.evaluate("codesearch", "*", [])
    expect(resolved).toEqual({ action: "ask", permission: "codesearch", pattern: "*" })
    expect(resolved.action).not.toBe("allow")
  })

  test("a path rule does not widen to unrelated paths", () => {
    // Highest-severity case in this lane: a pattern-matching fallback that treats an unparseable
    // or over-broad pattern as match-all is a silent privilege escalation. Pin the narrow rule's
    // actual reach and assert the escalation direction explicitly.
    const ruleset: PermissionV1.Ruleset = [{ permission: "edit", pattern: "src/target.ts", action: "allow" }]
    expect(Permission.evaluate("edit", "src/target.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/other.ts", ruleset).action).not.toBe("allow")
    expect(Permission.evaluate("edit", "*", ruleset).action).not.toBe("allow")
  })

  test("an out-of-domain permission reply value is rejected by the schema, not coerced", () => {
    // A permission surface that fails OPEN on an unrecognized reply is worse than one that
    // errors, because the error is visible and the fail-open is not. Assert the permissive
    // coercions ("always", "allow") cannot be reached by an unrecognized string.
    //
    // `run` is the FOURTH value in OPENFORK'S OWN schema, not a T3 requirement — see the file
    // docstring: stock T3 sends only once|always|reject in both audited generations. It is
    // OpenFork-first-class and load-bearing, not a synonym for the others: src/permission/index.ts
    // :259-267 grants it into `executionApprovals` keyed by (sessionID, executionID) — an
    // execution-scoped allow — whereas "always" pushes into the session-wide `approved` ruleset
    // (:249-257) and "once" resolves only this single request (:272). Collapsing `run` onto
    // `always` would escalate a scoped grant into a durable one that outlives the execution.
    //
    // Assert exact SET EQUALITY, not sampling: a positive sample of a closed domain cannot detect
    // a MISSING member, which is how this file's own earlier three-value loop managed to be green
    // while omitting `run`. This characterizes OpenFork's schema; it does not assert T3 behavior.
   const DOMAIN = ["once", "run", "always", "reject"] as const
    for (const value of DOMAIN) {
      expect(Schema.is(PermissionV1.Reply)(value), `${value} must decode as a decision`).toBe(true)
    }

    // Negatives are genuinely out-of-domain: case variants, whitespace-padded and near-miss
    // spellings of the four real values, the `Action` vocabulary ("allow"/"deny"/"ask" are
    // ruleset actions, not replies), plausible-but-wrong words, and non-string JSON values.
    const OUT_OF_DOMAIN = [
      "allow",
      "deny",
      "ask",
      "approve",
      "approved",
      "yes",
      "no",
      "permit",
      "auto",
      "accept",
      "ALWAYS",
      "Once",
      "Run",
      "REJECT",
      "",
      " ",
      "once ",
      " once",
      "run ",
      "runn",
      "alwayss",
      "reject!",
      null,
      undefined,
      0,
      1,
      true,
      false,
      ["once"],
      { reply: "once" },
    ]

    // Non-vacuity control: this probe must exercise BOTH outcomes. A schema that rejected
    // everything, or accepted everything, would otherwise satisfy the set equality trivially.
    const accepted = [...DOMAIN, ...OUT_OF_DOMAIN].filter((value) => Schema.is(PermissionV1.Reply)(value))
    expect(accepted.length).toBeGreaterThan(0)
    expect(accepted.length).toBeLessThan(DOMAIN.length + OUT_OF_DOMAIN.length)
    expect([...accepted].sort()).toEqual([...DOMAIN].sort())

    for (const value of OUT_OF_DOMAIN) {
      expect(
        Schema.is(PermissionV1.Reply)(value),
        `permission reply ${JSON.stringify(value)} must not decode as a decision`,
      ).toBe(false)
    }
    expect(Schema.is(PermissionV1.Action)("allow")).toBe(true)
    expect(Schema.is(PermissionV1.Action)("maybe")).toBe(false)
    // `Action` and `Reply` share no members, so neither vocabulary can be substituted for the
    // other by a client that conflates a ruleset action with a user's decision.
    expect(DOMAIN.some((reply) => Schema.is(PermissionV1.Action)(reply))).toBe(false)
  })


  test("question replies require an answers array and keep the declared value domain", () => {
    expect(Schema.is(Question.Reply)({ answers: [["first"]] })).toBe(true)
    expect(Schema.is(Question.Reply)({ answers: [], details: [""] })).toBe(true)
    expect(Schema.is(Question.Reply)({ details: ["text"] })).toBe(false)
    expect(Schema.is(Question.Reply)({ answers: "first" })).toBe(false)
  })
})