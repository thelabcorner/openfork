import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PartID, MessageID, SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import * as CodeRun from "@/code/run"
import * as Revision from "@/code/revision"

const currentSessionID = SessionID.make("ses_current")

function toolPart(
  id: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): SessionV1.ToolPart {
  return {
    id: PartID.make(id),
    sessionID: SessionID.make(`ses_${id}`),
    messageID: MessageID.make(`msg_${id}`),
    type: "tool",
    callID: `call_${id}`,
    tool: "code",
    state: {
      status: "completed",
      input,
      output: "{}",
      title: "code",
      metadata,
      time: { start: 1, end: 2 },
    },
  }
}

function record(part: SessionV1.ToolPart, key = "scope-a"): Session.CodeToolPartRecord {
  return {
    part,
    scope: {
      key,
      root: key,
      directory: key,
      projectID: "project-test" as Session.CodeToolPartRecord["scope"]["projectID"],
    },
  }
}

function store(
  entries: Array<Session.CodeToolPartRecord>,
  currentKey = "scope-a",
  onRead?: (id: string) => void,
): CodeRun.Store {
  const map = new Map(entries.map((entry) => [entry.part.id, entry]))
  return {
    physicalScope: () =>
      Effect.succeed({
        key: currentKey,
        root: currentKey,
        directory: currentKey,
        projectID: "project-test" as Session.PhysicalScope["projectID"],
      }),
    getCodeToolPart: (id) => {
      onRead?.(id)
      return Effect.succeed(map.get(id))
    },
  }
}

async function failure(effect: Effect.Effect<unknown, CodeRun.ResolutionError>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(error)),
    ),
  )
}

describe("CodeRun fresh replay resolution", () => {
  test("replays an inline run from its retained source and input", async () => {
    const source = record(
      toolPart("prt_source", {
        action: "run",
        code: "return input.value * 2",
        input: { value: 4 },
      }),
    )

    const resolved = await Effect.runPromise(
      CodeRun.resolveReplay({
        store: store([source]),
        currentSessionID,
        requestedRunID: "run:prt_source",
      }),
    )

    expect(resolved).toEqual({
      code: "return input.value * 2",
      value: { value: 4 },
      replayOf: "run:prt_source",
      sourceRunID: "run:prt_source",
      inputRunID: "run:prt_source",
    })
  })

  test("replay-of-replay resolves canonical source and effective input without walking lineage", async () => {
    const source = record(
      toolPart("prt_source", {
        action: "run",
        code: "return input.value",
        input: { value: 1 },
      }),
    )
    const inputOrigin = record(
      toolPart(
        "prt_input",
        { action: "run", runID: "run:prt_source", input: { value: 9 } },
        { replayOf: "run:prt_source", sourceRunID: "run:prt_source", inputRunID: "run:prt_input" },
      ),
    )
    const target = record(
      toolPart(
        "prt_target",
        { action: "run", runID: "run:prt_input" },
        { replayOf: "run:prt_input", sourceRunID: "run:prt_source", inputRunID: "run:prt_input" },
      ),
    )
    const reads: string[] = []

    const resolved = await Effect.runPromise(
      CodeRun.resolveReplay({
        store: store([source, inputOrigin, target], "scope-a", (id) => reads.push(id)),
        currentSessionID,
        requestedRunID: "run:prt_target",
      }),
    )

    expect(resolved.code).toBe("return input.value")
    expect(resolved.value).toEqual({ value: 9 })
    expect(resolved.sourceRunID).toBe("run:prt_source")
    expect(resolved.inputRunID).toBe("run:prt_input")
    expect(reads).toEqual(["prt_target", "prt_source", "prt_input"])
  })

  test("foreign physical scope is indistinguishable from a missing run", async () => {
    const foreign = record(
      toolPart("prt_foreign", { action: "run", code: "return 1" }),
      "scope-b",
    )

    const error = await failure(
      CodeRun.resolveReplay({
        store: store([foreign], "scope-a"),
        currentSessionID,
        requestedRunID: "run:prt_foreign",
      }),
    )

    expect(error).toBeInstanceOf(CodeRun.ResolutionError)
    expect((error as CodeRun.ResolutionError).kind).toBe("RunNotFound")
  })

  test("projection/rehydration failures become RunNotReplayable", async () => {
    const broken: CodeRun.Store = {
      physicalScope: () =>
        Effect.succeed({
          key: "scope-a",
          root: "scope-a",
          directory: "scope-a",
          projectID: "project-test" as Session.PhysicalScope["projectID"],
        }),
      getCodeToolPart: () => Effect.fail(new Error("dangling $cdbRef")),
    }

    const error = await failure(
      CodeRun.resolveReplay({
        store: broken,
        currentSessionID,
        requestedRunID: "run:prt_broken",
      }),
    )

    expect(error).toBeInstanceOf(CodeRun.ResolutionError)
    expect((error as CodeRun.ResolutionError).kind).toBe("RunNotReplayable")
  })

  test("non-run Code ToolParts cannot be replayed as source", async () => {
    const search = record(toolPart("prt_search", { action: "search", query: "files" }))

    const error = await failure(
      CodeRun.resolveReplay({
        store: store([search]),
        currentSessionID,
        requestedRunID: "run:prt_search",
      }),
    )

    expect(error).toBeInstanceOf(CodeRun.ResolutionError)
    expect((error as CodeRun.ResolutionError).kind).toBe("RunNotReplayable")
  })
})

describe("CodeRun saved-source resolution", () => {
  test("resolves canonical source only from a successful hash-verified run", async () => {
    const code = "\uFEFFreturn input.value\r\n"
    const canonical = Revision.canonicalSource(code)
    const source = record(
      toolPart(
        "prt_save_source",
        { action: "run", code, input: { value: 3 } },
        {
          sourceHash: Revision.sha256(canonical),
          sourceRunID: "run:prt_save_source",
          dependencies: { literalRefs: [], dynamicCallTarget: false },
          dependencyContracts: [],
        },
      ),
    )

    const resolved = await Effect.runPromise(
      CodeRun.resolveSaveSource({
        store: store([source]),
        currentSessionID,
        requestedRunID: "run:prt_save_source",
      }),
    )

    expect(resolved.code).toBe("return input.value\n")
    expect(resolved.sourceHash).toBe(Revision.sha256("return input.value\n"))
    expect(resolved.sourceRunID).toBe("run:prt_save_source")
    expect(resolved.sessionID).toBe(source.part.sessionID)
    expect(resolved.dependencies).toEqual([])
  })

  test("refuses promotion when durable source bytes no longer match sourceHash", async () => {
    const source = record(
      toolPart(
        "prt_tampered",
        { action: "run", code: "return 2" },
        { sourceHash: Revision.sha256("return 1"), sourceRunID: "run:prt_tampered" },
      ),
    )

    const error = await failure(
      CodeRun.resolveSaveSource({
        store: store([source]),
        currentSessionID,
        requestedRunID: "run:prt_tampered",
      }),
    )
    expect((error as CodeRun.ResolutionError).kind).toBe("SaveRejected")
  })

  test("refuses promotion of a failed code.run even when source remains retained", async () => {
    const part = toolPart(
      "prt_failed_save",
      { action: "run", code: "throw new Error('nope')" },
      { sourceHash: Revision.sha256("throw new Error('nope')") },
    )
    part.state = {
      status: "error",
      input: part.state.input,
      error: "failed",
      metadata: part.state.status === "completed" ? part.state.metadata : undefined,
      time: { start: 1, end: 2 },
    }
    const failed = record(part)

    const error = await failure(
      CodeRun.resolveSaveSource({
        store: store([failed]),
        currentSessionID,
        requestedRunID: "run:prt_failed_save",
      }),
    )
    expect((error as CodeRun.ResolutionError).kind).toBe("SaveRejected")
  })
})
