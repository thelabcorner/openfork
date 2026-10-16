import { describe, expect, test } from "bun:test"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { EventManifest } from "../../src/event-manifest"
import { t3CodeAccountModelID } from "../../src/compat/t3code"
import * as Question from "../../src/question"
import * as Session from "../../src/session/session"
import { OpenCodeHttpApi } from "../../src/server/routes/instance/httpapi/api"
import {
  CommandPayload,
  ForkPayload,
  PromptPayload,
  SummarizePayload,
  UpdatePayload,
} from "../../src/server/routes/instance/httpapi/groups/session"
import { AddPayload } from "../../src/server/routes/instance/httpapi/groups/mcp"

type Method = "get" | "post" | "patch"
type Parameter = {
  readonly name?: string
  readonly in?: string
  readonly required?: boolean
}
type JsonSchema = {
  readonly $ref?: string
  readonly type?: string
  readonly required?: ReadonlyArray<string>
  readonly properties?: Record<string, unknown>
  readonly additionalProperties?: unknown
  readonly items?: JsonSchema
}
type Media = { readonly schema?: JsonSchema }
type Response = {
  readonly description?: string
  readonly content?: Record<string, Media>
}
type Operation = {
  readonly parameters?: ReadonlyArray<Parameter>
  readonly requestBody?: { readonly content?: Record<string, Media> }
  readonly responses?: Record<string, Response>
}
type Spec = {
  readonly paths: Record<string, Partial<Record<Method, Operation>>>
  readonly components?: { readonly schemas?: Record<string, JsonSchema> }
}

// Effect's OpenAPI emitter hoists a shared response body into components and
// leaves only a $ref at the use site, so the declared shape has to be resolved
// before its `type` can be read. A dangling ref resolves to undefined and fails
// the caller's assertion loudly rather than quietly satisfying an optional
// chain -- which is the whole reason these envelope assertions exist.
function resolveSchema(spec: Spec, schema: JsonSchema | undefined): JsonSchema | undefined {
  let current = schema
  for (let hop = 0; hop < 10; hop++) {
    const ref = current?.$ref
    if (typeof ref !== "string") return current
    current = spec.components?.schemas?.[ref.replace("#/components/schemas/", "")]
    if (!current) return undefined
  }
  return undefined
}

const sdkOperations = [
  ["app.agents", "get", "/agent"],
  ["app.skills", "get", "/skill"],
  ["command.list", "get", "/command"],
  ["event.subscribe", "get", "/event"],
  ["global.health", "get", "/global/health"],
  ["mcp.add", "post", "/mcp"],
  ["permission.list", "get", "/permission"],
  ["permission.reply", "post", "/permission/{requestID}/reply"],
  ["provider.list", "get", "/provider"],
  ["question.list", "get", "/question"],
  ["question.reply", "post", "/question/{requestID}/reply"],
  ["session.abort", "post", "/session/{sessionID}/abort"],
  ["session.children", "get", "/session/{sessionID}/children"],
  ["session.command", "post", "/session/{sessionID}/command"],
  ["session.create", "post", "/session"],
  ["session.fork", "post", "/session/{sessionID}/fork"],
  ["session.get", "get", "/session/{sessionID}"],
  ["session.message", "get", "/session/{sessionID}/message/{messageID}"],
  ["session.messages", "get", "/session/{sessionID}/message"],
  ["session.promptAsync", "post", "/session/{sessionID}/prompt_async"],
  ["session.status", "get", "/session/status"],
  ["session.summarize", "post", "/session/{sessionID}/summarize"],
  ["session.update", "patch", "/session/{sessionID}"],
] as const satisfies ReadonlyArray<readonly [string, Method, string]>

// The exact success envelope T3 Code's 1.x client decodes per operation. Keyed
// by operation so an added or renamed SDK operation fails loudly instead of
// silently inheriting no envelope at all. `undefined` content type means the
// success is genuinely body-less.
const sdkSuccessEnvelope: Record<string, readonly [status: string, contentType: string | undefined]> = {
  "app.agents": ["200", "application/json"],
  "app.skills": ["200", "application/json"],
  "command.list": ["200", "application/json"],
  // The legacy event stream. T3's first subscribe event is `server.connected`.
  "event.subscribe": ["200", "text/event-stream"],
  "global.health": ["200", "application/json"],
  "mcp.add": ["200", "application/json"],
  "permission.list": ["200", "application/json"],
  "permission.reply": ["200", "application/json"],
  "provider.list": ["200", "application/json"],
  "question.list": ["200", "application/json"],
  "question.reply": ["200", "application/json"],
  "session.abort": ["200", "application/json"],
  "session.children": ["200", "application/json"],
  "session.command": ["200", "application/json"],
  "session.create": ["200", "application/json"],
  "session.fork": ["200", "application/json"],
  "session.get": ["200", "application/json"],
  "session.message": ["200", "application/json"],
  "session.messages": ["200", "application/json"],
  // The one body-less success: promptAsync acknowledges and returns nothing.
  "session.promptAsync": ["204", undefined],
  "session.status": ["200", "application/json"],
  "session.summarize": ["200", "application/json"],
  "session.update": ["200", "application/json"],
}

const consumedEvents = [
  "server.connected",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.error",
  "session.compacted",
  "session.status",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "todo.updated",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
] as const

describe("T3 Code OpenCode 1.15.13 consumer contract", () => {
  test("retains every SDK operation used by T3 Code", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

    for (const [operation, method, path] of sdkOperations) {
      expect(spec.paths[path]?.[method], `${operation} must remain available at ${method.toUpperCase()} ${path}`).toBeDefined()
    }
  })

  test("retains T3 Code directory routing and bootstrap-free status semantics", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec
    const fork = spec.paths["/session/{sessionID}/fork"]?.post
    const status = spec.paths["/session/status"]?.get

    expect(fork?.parameters?.some((parameter) => parameter.in === "query" && parameter.name === "directory")).toBe(true)
    const statusDirectory = status?.parameters?.find((parameter) => parameter.name === "directory")
    expect(statusDirectory?.required ?? false).toBe(false)
  })

  test("retains every event type consumed by the T3 Code adapter", () => {
    for (const event of consumedEvents) {
      expect(EventManifest.Latest.has(event), `${event} must remain in the legacy event manifest`).toBe(true)
    }
  })

  test("retains the status variants T3 Code recognizes", () => {
    expect(Schema.is(SessionStatusEvent.Info)({ type: "idle" })).toBe(true)
    expect(Schema.is(SessionStatusEvent.Info)({ type: "busy" })).toBe(true)
    expect(
      Schema.is(SessionStatusEvent.Info)({
        type: "retry",
        attempt: 1,
        message: "retry",
        next: 0,
      }),
    ).toBe(true)
  })

  test("accepts the request payload shapes T3 Code emits", () => {
    const accountAlias = t3CodeAccountModelID(
      "claude-test",
      "opencode-account:t3-test",
    )
    const fullAccessPermissions = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ] as const

    expect(
      Schema.is(ConfigMCPV1.Info)({
        type: "remote",
        url: "http://127.0.0.1:43123",
        headers: { Authorization: "Bearer t3-test" },
        oauth: false,
      }),
    ).toBe(true)

    expect(
      Schema.is(Session.CreateInput)({
        title: "T3 Code thread",
        permission: fullAccessPermissions,
      }),
    ).toBe(true)

    expect(
      Schema.is(ForkPayload)({
        messageID: "msg_t3_rewind",
      }),
    ).toBe(true)

    expect(
      Schema.is(PromptPayload)({
        messageID: "msg_t3_test",
        model: {
          providerID: "anthropic",
          modelID: accountAlias,
        },
        system: "T3 Code runtime addendum",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mime: "text/plain",
            filename: "notes.txt",
            url: "file:///tmp/notes.txt",
          },
        ],
      }),
    ).toBe(true)

    expect(
      Schema.is(CommandPayload)({
        messageID: "msg_t3_command",
        command: "test",
        arguments: "",
        model: `anthropic/${accountAlias}`,
        agent: "build",
        variant: "high",
        parts: [],
      }),
    ).toBe(true)

    expect(
      Schema.is(SummarizePayload)({
        providerID: "anthropic",
        modelID: accountAlias,
        auto: false,
      }),
    ).toBe(true)

    expect(
      Schema.is(UpdatePayload)({
        permission: fullAccessPermissions,
      }),
    ).toBe(true)

    for (const reply of ["once", "always", "reject"] as const) {
      expect(Schema.is(PermissionV1.Reply)(reply)).toBe(true)
    }

    expect(Schema.is(Schema.Array(Question.Answer))([["first"], ["second", "third"], []])).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Declared response envelopes and status codes.
  //
  // The tests above are a SPEC-LEVEL existence and acceptance check. Route
  // existence cannot see a route that answers the wrong status, the wrong body,
  // or no body at all, and `Schema.is` proves only that OpenFork ACCEPTS a
  // payload -- never what T3's 1.x client then reads back. These close that gap.
  //
  // EVIDENCE CLASS: contract_tests. In-process OpenAPI declarations on a live
  // dirty worktree. This is NOT real_E2E and never satisfies it -- proving the
  // bytes on the wire needs an actual stock-T3 client against a real listener,
  // which is the E2E peers' column, not this file's.
  // ---------------------------------------------------------------------------

  test("declares a response contract for every SDK operation T3 Code consumes", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

    for (const [operation, method, path] of sdkOperations) {
      const responses = spec.paths[path]?.[method]?.responses ?? {}
      const codes = Object.keys(responses)
      const label = `${operation} (${method.toUpperCase()} ${path})`

      const success = codes.filter((code) => code.startsWith("2"))
      expect(success, `${label} must declare exactly one success status, saw [${codes.join(",")}]`).toHaveLength(1)

      // Exact success envelope per operation: twenty-one routes answer
      // 200 application/json, the legacy event stream is text/event-stream, and
      // promptAsync is the single body-less 204. Pinning the shape per operation
      // is what catches an SSE route silently retyped as JSON or a data route
      // losing its body -- neither of which route existence can see.
      const envelope = sdkSuccessEnvelope[operation]
      expect(envelope, `${label} has no declared success envelope in this suite`).toBeDefined()
      const [status, contentType] = envelope!
      expect(success, `${label} must answer ${status}, saw [${codes.join(",")}]`).toEqual([status])
      expect(
        Object.keys(responses[status]?.content ?? {}),
        `${label} must declare its success content type as ${contentType ?? "(none)"}`,
      ).toEqual(contentType ? [contentType] : [])

      const errors = codes.filter((code) => !code.startsWith("2"))
      for (const code of errors) {
        expect(Number(code) >= 400, `${label} declares ${code}, which is outside the 4xx/5xx range`).toBe(true)
        expect(responses[code]?.description, `${label} must describe its ${code} response`).toBeTruthy()
      }

      // Authorization is an endpoint-contract middleware, so the DECLARED 401 is
      // the observable auth signal -- the OpenAPI `security` field is `[]` on
      // every route in this API and therefore proves nothing.
      if (errors.length > 0) {
        expect(codes, `${label} declares errors but no 401, so its auth surface is undocumented`).toContain("401")
      }
    }
  })

  test("declares the abort wire contract stock T3 Code reads", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec
    const abort = spec.paths["/session/{sessionID}/abort"]?.post
    const responses = abort?.responses ?? {}

    // Stock T3 reads the abort result as a BARE JSON boolean. Wrapping it in an
    // envelope would decode to an object and break `abortData` at every call
    // site, with no route-existence assertion able to notice.
    expect(responses["200"]?.content?.["application/json"]?.schema?.type).toBe("boolean")

    // The concrete regression: handlers/session-control.ts compared the RAW
    // x-opencode-directory header against the durable directory, so stock T3's
    // URI-encoded header produced exactly this status. It must stay a DECLARED,
    // documented rejection rather than an undeclared failure.
    expect(responses["400"], "abort must declare 400 for a stale or mismatched directory hint").toBeDefined()
    expect(responses["404"], "abort must declare 404 for an unknown session").toBeDefined()

    const directory = abort?.parameters?.find((parameter) => parameter.in === "query" && parameter.name === "directory")
    expect(directory, "abort must accept a directory query hint").toBeDefined()
    // Optional in both carriers: a caller may pass the hint by query OR by
    // header, so omitting the query spelling can never 400 on its own.
    expect(directory?.required ?? false, "abort's directory query hint must stay optional").toBe(false)

    // x-opencode-directory is read straight off the raw request and is
    // deliberately NOT a declared header parameter. That undeclared second
    // carrier is precisely why the handler accepts two spellings (raw and safe
    // decode) for the same directory. Pin the absence so introducing a required
    // header carrier -- which would reintroduce the stock-T3 400 -- fails here.
    const headers = abort?.parameters?.filter((parameter) => parameter.in === "header") ?? []
    expect(headers, "abort must not declare a header-carried directory parameter").toHaveLength(0)
  })

  test("accepts the permission vocabulary latest T3 Code emits", () => {
    // Stock origin/main a21702d0e apps/server/src/provider/opencodeRuntime.ts
    // `buildOpenCodePermissionRules` emits `codesearch` and `doom_loop`, neither
    // of which appears in the audited old-T3 ruleset, and sends them verbatim on
    // session.update (PATCH /session/{id}) and inside session create payloads.
    // Rule.permission is Schema.String, not an enum, so all three decode.
    // This is the property that turns a future tightening to an enum into a
    // visible failure here instead of a silent latest-T3 rejection at the
    // permission boundary that no legacy test would catch.
    for (const name of ["codesearch", "doom_loop", "totally_unknown_permission"] as const) {
      const rule = { permission: name, pattern: "*", action: "ask" }

      expect(Schema.is(PermissionV1.Rule)(rule), `${name} must remain an accepted permission name`).toBe(true)
      expect(
        Schema.is(Session.CreateInput)({ title: "T3 Code thread", permission: [rule] }),
        `session create must accept the ${name} rule`,
      ).toBe(true)
      expect(
        Schema.is(UpdatePayload)({ permission: [rule] }),
        `session update must accept the ${name} rule`,
      ).toBe(true)
    }
  })

  test("fails closed on an out-of-domain permission reply", () => {
    // The domain is FOUR literals, not three: `run` is first-class alongside
    // once/always/reject. An assertion built from a three-value list would let a
    // reply T3 actually sends be treated as invalid.
    for (const reply of ["once", "run", "always", "reject"] as const) {
      expect(Schema.is(PermissionV1.Reply)(reply), `${reply} must remain an accepted reply`).toBe(true)
      expect(Schema.is(PermissionV1.ReplyInput)({ requestID: "per_t3", reply })).toBe(true)
    }

    // A permission surface that fails OPEN is worse than one that errors: the
    // error is visible, the silent default is not. These must be rejected
    // outright rather than coerced to "always".
    for (const reply of ["approve", "yes", "ALWAYS", ""] as const) {
      expect(
        Schema.is(PermissionV1.Reply)(reply),
        `${JSON.stringify(reply)} must be rejected rather than coerced or defaulted`,
      ).toBe(false)
      expect(Schema.is(PermissionV1.ReplyInput)({ requestID: "per_t3", reply })).toBe(false)
    }
  })

  // ---------------------------------------------------------------------------
  // v1 response BODIES, as the stock 1.x driver actually reads them.
  //
  // Every citation below is stock T3 Code origin/main a21702d0e
  // apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts -- the
  // v1-WIRE adapter. Deliberately NOT OpenCode2AdapterV2.ts, which drives the
  // 2.0.18 client and whose envelope genuinely differs: it sends
  // `permissions` (plural) on session.update where the v1 driver sends
  // `permission` (singular), and it reads list payloads under a `data` key.
  // Copying the v2 adapter's shapes in here would assert a contract this
  // wrapper never serves.
  //
  // Success status and content type are already pinned above. Status cannot
  // see a body of the right JSON type but the wrong SHAPE: a `{data:[...]}`
  // list, a bare-message array, or an array where T3 indexes by session id all
  // answer 200 application/json and all break the read that follows.
  // ---------------------------------------------------------------------------

  test("declares the v1 response bodies the stock driver indexes and destructures", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

    // GET /session/status -- stock reads `statuses[state.nativeSessionId]` and
    // then `.type` off the result, so the payload is a MAP keyed by session id
    // (declared as Schema.Record(Schema.String, SessionStatusEvent.Info),
    // groups/global.ts:657). An array of {sessionID} rows would answer
    // 200 application/json and break the `statuses[sessionID]` index read.
    //
    // PRECISION, corrected by wire evidence from the latest-T3 E2E lane
    // (statusIsArray:false, statusIsPlainObject:true): this map is a projection
    // of ACTIVE work, NOT a per-session registry. A freshly created, never
    // prompted session legitimately has NO entry, and stock's
    // `statuses[id]?.type ?? "idle"` then yields "idle" -- which is the CORRECT
    // answer for an idle session. So do NOT read this as "an absent entry is a
    // silent wrong answer"; that overstates it and would read as a false bug
    // report. The narrower real hazard is a regression that DROPS A BUSY
    // SESSION'S entry, which would leave stock reporting "idle" for a session
    // that is actually running -- with no error and no shape change to detect.
    // This assertion catches "map became an array"; it CANNOT catch "busy
    // entry vanished", because proving that needs a genuinely busy session,
    // i.e. a model-spend turn. That boundary is deliberate and not closed here.
    const status = spec.paths["/session/status"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema
    expect(status?.type, "session status must stay an object keyed by session id, not an array").toBe("object")
    expect(status?.additionalProperties, "session status must remain a MAP so `statuses[sessionID]` resolves").toBeDefined()
    expect(status?.items, "session status must not become an array").toBeUndefined()

    // GET /session/{sessionID}/message -- stock iterates the result directly
    // and destructures each element as `{ info }`
    // (`messages.find(({ info }) => info.role === "user")?.info.id`), so the
    // payload is a bare ARRAY whose items carry the {info, parts} wrapper
    // (Schema.Array(SessionV1.WithParts), groups/session-read.ts:67). There
    // is no `data` envelope on this generation and no bare-message list.
    //
    // The ARRAY-vs-ENVELOPE half is confirmed on the wire by the latest-T3 E2E
    // lane (messagesIsArray:true). The per-ITEM {info,parts} shape asserted
    // below is still DECLARATION-LAYER ONLY: that harness runs no model-spend
    // turn, so every message list is legitimately empty (messageCount 0) and no
    // row was synthesized to manufacture one. Treat the item requirement as an
    // open boundary rather than as wire-proven.
    const messages = spec.paths["/session/{sessionID}/message"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema
    expect(messages?.type, "session messages must stay a bare array, not a {data:[...]} envelope").toBe("array")
    expect(messages?.items?.required, "each message must keep the {info, parts} wrapper stock destructures").toEqual([
      "info",
      "parts",
    ])

    // Session bodies -- stock reads a bare `id` (makeProviderThread,
    // `fork.id`), `time.created`/`time.updated` as epoch numbers
    // (`dateTimeFromEpoch(input.nativeSession.time.created, ...)`), and
    // `permission` as an array it feeds straight back through
    // openCodeChildPermissionRules. get, create, fork and update must
    // therefore all answer the same object shape.
    for (const [method, path] of [
      ["get", "/session/{sessionID}"],
      ["post", "/session"],
      ["post", "/session/{sessionID}/fork"],
      ["patch", "/session/{sessionID}"],
    ] as const) {
      const label = `${method.toUpperCase()} ${path}`
      const schema = resolveSchema(spec, spec.paths[path]?.[method]?.responses?.["200"]?.content?.["application/json"]?.schema)
      expect(schema?.type, `${label} must answer a bare session object`).toBe("object")
      expect(schema?.properties, `${label} must expose the session fields stock reads`).toHaveProperty("id")
      // `time` must stay REQUIRED: createdAt/updatedAt are derived straight off
      // it, and an absent time decodes as undefined rather than failing.
      expect(schema?.required ?? [], `${label} must keep session.time required`).toContain("time")
      // `permission` and `parentID` are read back OFF the response
      // (`nativeChildSession.permission ?? []`, `info?.parentID`). Dropping
      // either leaves the route answering 200 while stock silently re-derives
      // child permissions from an empty ruleset.
      expect(schema?.properties, `${label} must expose session.permission for stock to read back`).toHaveProperty("permission")
      expect(schema?.properties, `${label} must expose session.parentID for stock to walk parent hops`).toHaveProperty(
        "parentID",
      )
    }

    // Field-level, against the schema those routes declare (Session.Info).
    const stockRead = {
      id: "ses_t3",
      slug: "t3-thread",
      projectID: "prj_t3",
      directory: "C:\\tmp\\t3",
      title: "T3 Code thread",
      version: "1.15.13",
      time: { created: 1, updated: 2 },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      parentID: "ses_parent",
    }
    expect(Schema.is(Session.Info)(stockRead), "a stock-read session body must satisfy the declared response schema").toBe(true)

    // `permission` must remain a FIELD for `nativeChildSession.permission ?? []`
    // to have anything to land on -- dropping it would not error, it would
    // quietly re-derive child permissions from an empty ruleset.
    expect(Object.keys(Session.Info.fields), "stock reads session.permission back off the response").toContain("permission")
    // `parentID` is how stock walks child -> parent hops
    // (`const parentId = info?.parentID`).
    expect(Object.keys(Session.Info.fields), "stock walks parent hops via session.parentID").toContain("parentID")
    // `time` must stay REQUIRED because createdAt/updatedAt are derived
    // straight off it; an absent time would decode as undefined, not fail.
    expect(
      Schema.is(Session.Info)({ ...stockRead, time: undefined }),
      "session.time must stay required -- stock computes createdAt/updatedAt from it",
    ).toBe(false)
  })

  test("requires the nested MCP config envelope stock T3 Code sends", () => {
    // Stock old T3 0fcd5f9 apps/server/src/provider/Layers/OpenCodeAdapter.ts
    // :2871-2883 posts `client.mcp.add({ name, config: { type, url, headers,
    // oauth } })`, and legacy SDK 1.15.13 maps `name` and `config` as separate
    // body keys (dist/v2/gen/sdk.gen.js:1236-1257), so the nesting reaches the
    // wire intact. The E2E lane measured the consequence: a flattened
    // producer is REJECTED with `Missing key at ["config"]` and never
    // registers. Route existence plus a 2xx cannot see that difference, so
    // the nesting is pinned here as a request-envelope contract.
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec
    const body = spec.paths["/mcp"]?.post?.requestBody?.content?.["application/json"]?.schema

    expect(body?.required, "POST /mcp must require the nested `config` key").toEqual(["name", "config"])

    const nested = {
      name: "t3-code",
      config: {
        type: "remote",
        url: "http://127.0.0.1:43123",
        headers: { Authorization: "Bearer t3-test" },
        oauth: false,
      },
    }

    expect(Schema.is(AddPayload)(nested), "the nested envelope stock T3 sends must decode").toBe(true)
    expect(
      Schema.is(AddPayload)({ name: "t3-code", type: "remote", url: "http://127.0.0.1:43123" }),
      "a flattened mcp payload must be rejected, not silently tolerated",
    ).toBe(false)
    expect(Schema.is(AddPayload)({ config: nested.config }), "mcp `name` must stay required alongside `config`").toBe(false)
  })
})
