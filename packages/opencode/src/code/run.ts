import { Effect } from "effect"
import type { Session } from "@/session/session"
import { PartID, type SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type * as CodeError from "./error"
import * as Revision from "./revision"

export type ResolutionKind = Extract<
  CodeError.Kind,
  "RunNotFound" | "RunNotReplayable" | "RunSourceUnavailable" | "SaveRejected"
>

export class ResolutionError extends Error {
  constructor(
    readonly kind: ResolutionKind,
    message: string,
    readonly recovery: string,
  ) {
    super(message)
    this.name = "CodeRunResolutionError"
  }
}

export type Store = Pick<Session.Interface, "physicalScope" | "getCodeToolPart">

export type ReplaySource = {
  readonly code: string
  readonly value: unknown
  readonly replayOf: string
  readonly sourceRunID: string
  readonly inputRunID: string
}

export type SaveSource = {
  readonly code: string
  readonly runID: string
  readonly sourceRunID: string
  readonly sourceHash: string
  readonly sessionID: SessionID
  readonly messageID: SessionV1.ToolPart["messageID"]
  readonly dependencies: readonly Revision.Dependency[]
}

export type RunDescriptor = {
  readonly ok: true
  readonly item: {
    readonly kind: "run"
    readonly ref: string
    readonly description: string
    readonly status: SessionV1.ToolPart["state"]["status"]
    readonly replayable: true
    readonly sourceHash?: string
    readonly replayOf?: string
    readonly sourceRunID?: string
    readonly inputRunID?: string
    readonly dependencies?: {
      readonly literalRefs: readonly string[]
      readonly dynamicCallTarget: boolean
    }
    readonly saved?: {
      readonly id?: string
      readonly revision?: string
      readonly handle?: string
    }
    readonly replayExample: {
      readonly action: "run"
      readonly runID: string
    }
  }
}

const notFound = () =>
  new ResolutionError(
    "RunNotFound",
    "The requested Code run was not found in the current physical project scope.",
    "Use code.search with target=runs to locate a retained run in this project, or execute the source again.",
  )

const notReplayable = (message: string) =>
  new ResolutionError(
    "RunNotReplayable",
    message,
    "Choose a retained code.run result whose source projection is intact, or execute the source again.",
  )

const sourceUnavailable = () =>
  new ResolutionError(
    "RunSourceUnavailable",
    "The replay lineage exists, but its canonical source run is no longer available.",
    "Use a saved tool/revision if one exists, or execute the source again to create a new replayable run.",
  )

const saveRejected = (message: string) =>
  new ResolutionError(
    "SaveRejected",
    message,
    "Only a successfully completed, intact code.run can be promoted to a saved tool.",
  )

export const toRunID = (partID: PartID) => `run:${partID}`

export function fromRunID(runID: string): PartID {
  if (!runID.startsWith("run:") || runID.startsWith("run:volatile:")) throw notFound()
  const raw = runID.slice("run:".length)
  if (!raw.startsWith("prt")) throw notFound()
  try {
    return PartID.make(raw)
  } catch {
    throw notFound()
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stateMetadata = (part: SessionV1.ToolPart) =>
  "metadata" in part.state ? record(part.state.metadata) : undefined

const runInput = (part: SessionV1.ToolPart) => record(part.state.input)

const sameScope = (left: string, right: string) => left === right

const read = (
  store: Store,
  runID: string,
  scopeKey: string,
  missing: () => ResolutionError,
) =>
  Effect.gen(function* () {
    const partID = yield* Effect.try({
      try: () => fromRunID(runID),
      catch: () => missing(),
    })
    const found = yield* store.getCodeToolPart(partID).pipe(
      Effect.mapError(() =>
        notReplayable("The requested Code run could not be rehydrated from durable session storage."),
      ),
    )
    if (!found || !sameScope(found.scope.key, scopeKey)) return yield* Effect.fail(missing())
    return found.part
  })

const validateRunPart = (part: SessionV1.ToolPart) => {
  const input = runInput(part)
  if (!input || input.action !== "run") {
    return Effect.fail(notReplayable("The requested Code ToolPart is not a code.run execution."))
  }
  return Effect.succeed(input)
}

/**
 * Resolve a retained CodeRun into canonical source and effective input without
 * walking replay chains. Replays record both sourceRunID and inputRunID, so a
 * replay-of-replay remains a constant number of indexed PartID lookups.
 */
export function resolveReplay(input: {
  readonly store: Store
  readonly currentSessionID: SessionID
  readonly requestedRunID: string
}) {
  return Effect.gen(function* () {
    const currentScope = yield* input.store.physicalScope(input.currentSessionID).pipe(
      Effect.mapError(() => notFound()),
    )
    const requested = yield* read(input.store, input.requestedRunID, currentScope.key, notFound)
    const requestedInput = yield* validateRunPart(requested)
    const requestedMetadata = stateMetadata(requested)

    let sourceRunID: string
    let sourceInput: Record<string, unknown>
    if (typeof requestedInput.code === "string") {
      sourceRunID = input.requestedRunID
      sourceInput = requestedInput
    } else {
      sourceRunID =
        typeof requestedMetadata?.sourceRunID === "string"
          ? requestedMetadata.sourceRunID
          : ""
      if (!sourceRunID) {
        return yield* Effect.fail(
          notReplayable("The requested replay does not retain canonical source lineage."),
        )
      }
      const source = yield* read(input.store, sourceRunID, currentScope.key, sourceUnavailable)
      sourceInput = yield* validateRunPart(source)
      if (typeof sourceInput.code !== "string") {
        return yield* Effect.fail(
          notReplayable("The canonical source run no longer contains executable source."),
        )
      }
    }

    const code = sourceInput.code
    if (typeof code !== "string") {
      return yield* Effect.fail(
        notReplayable("The canonical source run does not contain executable source."),
      )
    }

    let inputRunID: string
    let value: unknown
    if (Object.hasOwn(requestedInput, "input")) {
      inputRunID = input.requestedRunID
      value = requestedInput.input
    } else if (typeof requestedInput.code === "string") {
      inputRunID = input.requestedRunID
      value = {}
    } else {
      inputRunID =
        typeof requestedMetadata?.inputRunID === "string"
          ? requestedMetadata.inputRunID
          : sourceRunID
      const inputPart =
        inputRunID === input.requestedRunID
          ? requested
          : yield* read(input.store, inputRunID, currentScope.key, sourceUnavailable)
      const effective = yield* validateRunPart(inputPart)
      value = Object.hasOwn(effective, "input") ? effective.input : {}
    }

    return {
      code,
      value,
      replayOf: input.requestedRunID,
      sourceRunID,
      inputRunID,
    } satisfies ReplaySource
  })
}

/**
 * Resolve the canonical source bytes that produced a successful durable CodeRun.
 *
 * The requested run must itself have completed successfully. Source may live on
 * its canonical sourceRunID (for a replay), but the durable requested run's
 * sourceHash remains the integrity witness and must match the canonical bytes.
 */
export function resolveSaveSource(input: {
  readonly store: Store
  readonly currentSessionID: SessionID
  readonly requestedRunID: string
}) {
  return Effect.gen(function* () {
    const currentScope = yield* input.store.physicalScope(input.currentSessionID).pipe(
      Effect.mapError(() => notFound()),
    )
    const requested = yield* read(input.store, input.requestedRunID, currentScope.key, notFound)
    const requestedInput = yield* validateRunPart(requested)
    if (requested.state.status !== "completed") {
      return yield* Effect.fail(saveRejected("The requested Code run did not complete successfully."))
    }
    const metadata = stateMetadata(requested)
    const expectedHash = typeof metadata?.sourceHash === "string" ? metadata.sourceHash : undefined
    if (!expectedHash) {
      return yield* Effect.fail(
        sourceUnavailable(),
      )
    }

    const dependencySummary = record(metadata?.dependencies)
    if (
      !dependencySummary ||
      !Array.isArray(dependencySummary.literalRefs) ||
      !dependencySummary.literalRefs.every((ref) => typeof ref === "string") ||
      typeof dependencySummary.dynamicCallTarget !== "boolean"
    ) {
      return yield* Effect.fail(
        saveRejected("The requested Code run predates durable dependency-contract capture; rerun the source before saving."),
      )
    }
    if (dependencySummary.dynamicCallTarget) {
      return yield* Effect.fail(
        saveRejected("Saved tools require static call(ref, input) targets; this run used a computed capability ref."),
      )
    }
    let dependencies: readonly Revision.Dependency[]
    try {
      dependencies = Revision.parseDependencies(metadata?.dependencyContracts)
    } catch {
      return yield* Effect.fail(
        saveRejected("The requested Code run does not retain a valid dependency-contract envelope; rerun the source before saving."),
      )
    }
    const refs = [...dependencySummary.literalRefs].sort()
    if (
      refs.length !== dependencies.length ||
      refs.some((ref, index) => ref !== dependencies[index]?.ref)
    ) {
      return yield* Effect.fail(
        saveRejected("The requested Code run's dependency summary does not match its captured execution contracts."),
      )
    }

    let sourceRunID = input.requestedRunID
    let sourceInput = requestedInput
    if (typeof requestedInput.code !== "string") {
      sourceRunID = typeof metadata?.sourceRunID === "string" ? metadata.sourceRunID : ""
      if (!sourceRunID) return yield* Effect.fail(sourceUnavailable())
      const sourcePart = yield* read(input.store, sourceRunID, currentScope.key, sourceUnavailable)
      sourceInput = yield* validateRunPart(sourcePart)
    }
    if (typeof sourceInput.code !== "string") return yield* Effect.fail(sourceUnavailable())

    const code = Revision.canonicalSource(sourceInput.code)
    const sourceHash = Revision.sha256(code)
    if (sourceHash !== expectedHash) {
      return yield* Effect.fail(
        saveRejected("The retained Code source no longer matches the completed run's sourceHash."),
      )
    }

    return {
      code,
      runID: input.requestedRunID,
      sourceRunID,
      sourceHash,
      sessionID: requested.sessionID,
      messageID: requested.messageID,
      dependencies,
    } satisfies SaveSource
  })
}

/**
 * Exact, source-free inspection of one retained CodeRun. Raw source and runtime
 * input remain behind explicit replay/save resolution.
 */
export function describeRun(input: {
  readonly store: Store
  readonly currentSessionID: SessionID
  readonly runID: string
}) {
  return Effect.gen(function* () {
    const currentScope = yield* input.store.physicalScope(input.currentSessionID).pipe(
      Effect.mapError(() => notFound()),
    )
    const partID = yield* Effect.try({
      try: () => fromRunID(input.runID),
      catch: () => notFound(),
    })
    const found = yield* input.store.getCodeToolPart(partID).pipe(
      Effect.mapError(() =>
        notReplayable("The requested Code run could not be rehydrated from durable session storage."),
      ),
    )
    if (!found || found.scope.key !== currentScope.key) return yield* Effect.fail(notFound())
    yield* validateRunPart(found.part)

    const metadata = stateMetadata(found.part)
    const dependencyMetadata = record(metadata?.dependencies)
    const literalRefs =
      dependencyMetadata && Array.isArray(dependencyMetadata.literalRefs)
        ? dependencyMetadata.literalRefs
            .filter((ref): ref is string => typeof ref === "string")
            .slice(0, 64)
        : undefined
    const savedMetadata = record(metadata?.saved)

    return {
      ok: true,
      item: {
        kind: "run",
        ref: input.runID,
        description: "Durable replayable CodeRun.",
        status: found.part.state.status,
        replayable: true,
        ...(typeof metadata?.sourceHash === "string" ? { sourceHash: metadata.sourceHash } : {}),
        ...(typeof metadata?.replayOf === "string" ? { replayOf: metadata.replayOf } : {}),
        ...(typeof metadata?.sourceRunID === "string" ? { sourceRunID: metadata.sourceRunID } : {}),
        ...(typeof metadata?.inputRunID === "string" ? { inputRunID: metadata.inputRunID } : {}),
        ...(literalRefs
          ? {
              dependencies: {
                literalRefs,
                dynamicCallTarget: dependencyMetadata?.dynamicCallTarget === true,
              },
            }
          : {}),
        ...(savedMetadata
          ? {
              saved: {
                ...(typeof savedMetadata.id === "string" ? { id: savedMetadata.id } : {}),
                ...(typeof savedMetadata.revision === "string" ? { revision: savedMetadata.revision } : {}),
                ...(typeof savedMetadata.handle === "string" ? { handle: savedMetadata.handle } : {}),
              },
            }
          : {}),
        replayExample: {
          action: "run",
          runID: input.runID,
        },
      },
    } satisfies RunDescriptor
  })
}
