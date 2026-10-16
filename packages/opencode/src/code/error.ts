export type Kind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownCapability"
  | "AmbiguousPermissionIdentity"
  | "CapabilitySchemaError"
  | "CapabilityDenied"
  | "CapabilityFailed"
  | "DependencyContractChanged"
  | "InvalidInput"
  | "InvalidOutput"
  | "LimitExceeded"
  | "Timeout"
  | "Cancelled"
  | "RunNotFound"
  | "RunNotReplayable"
  | "RunSourceUnavailable"
  | "SaveRejected"
  | "SavedToolNotFound"
  | "SavedToolAmbiguous"
  | "SavedToolDirty"
  | "SavedToolCycle"
  | "SavedToolDepthExceeded"
  | "RuntimeUnavailable"
  | "InternalRuntimeError"

export type Detail = {
  readonly kind: Kind
  readonly message: string
  readonly recovery: string
}

export type Success = {
  readonly ok: true
  readonly runID: string
  readonly sourceHash: string
  readonly inputHash?: string
  readonly replayOf?: string
  readonly sourceRunID?: string
  readonly replayable: boolean
  readonly value: unknown
  readonly calls: { readonly total: number; readonly failed: number }
  readonly warnings?: ReadonlyArray<{ readonly kind: string; readonly message: string }>
  readonly saved?: { readonly id: string; readonly revision: string; readonly handle: string; readonly path: string }
}

export type Failure = {
  readonly ok: false
  readonly runID: string
  readonly sourceHash?: string
  readonly replayOf?: string
  readonly sourceRunID?: string
  readonly error: Detail
  readonly calls?: { readonly total: number; readonly failed: number }
}

export type Result = Success | Failure

export const failure = (
  runID: string,
  kind: Kind,
  message: string,
  recovery: string,
  extra?: Partial<Pick<Failure, "sourceHash" | "replayOf" | "sourceRunID" | "calls">>,
): Failure => ({
  ok: false,
  runID,
  ...(extra ?? {}),
  error: { kind, message, recovery },
})

export const invalidInput = (runID: string, message: string): Failure => ({
  ok: false,
  runID,
  error: {
    kind: "InvalidInput",
    message,
    recovery: "Rewrite the code tool input so it matches the documented action-specific shape.",
  },
})
