import { describe, expect, test } from "bun:test"
import {
  MANAGED_ERROR_CODES,
  MANAGED_EXIT_CODES,
  MANAGED_EXIT_CONTENTION_RETRYABLE,
  MANAGED_EXIT_INTERNAL_DEFECT,
  MANAGED_EXIT_INVALID_REQUEST,
  MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL,
  MANAGED_EXIT_SUCCESS,
  MANAGED_PROTOCOL_COMMANDS,
  MANAGED_PROTOCOL_VERSION,
  ManagedRequestInvalid,
  ManagedWireViolation,
  categoryForExitCode,
  exitCodeForCategory,
  managedCreateInitializeRequestDocument,
  managedProtocolVersionRequestDocument,
  managedStatusRequestDocument,
  parseManagedCreateInitializeResult,
  parseManagedExitOutcome,
  parseManagedProtocolVersionResult,
  parseManagedResponseText,
  parseManagedStatusResult,
} from "../../src/worktree/managed/protocol"
import { createInitializeRequestDocument, serializeRequestDocument } from "../../src/worktree/managed/request"
import { createResult, protocolVersionResult, statusResult, validCreateInput } from "./managed-fake-cli"

function expectWireViolation(run: () => unknown): void {
  let captured: unknown
  try {
    run()
  } catch (error) {
    captured = error
  }
  expect(captured).toBeInstanceOf(ManagedWireViolation)
}

function expectRequestInvalid(run: () => unknown): void {
  let captured: unknown
  try {
    run()
  } catch (error) {
    captured = error
  }
  expect(captured).toBeInstanceOf(ManagedRequestInvalid)
}

function successResponse(command: string, result: unknown): string {
  return JSON.stringify({ protocolVersion: MANAGED_PROTOCOL_VERSION, ok: true, command, result })
}

function errorResponse(command: string, error: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: MANAGED_PROTOCOL_VERSION, ok: false, command, error })
}

const DOMAIN_ERROR = {
  code: MANAGED_ERROR_CODES.repositoryNotRegistered,
  category: "invalid-request",
  retryable: false,
  message: "Repository repo_test is not registered.",
}

describe("managed protocol v1 constants", () => {
  test("exact version, commands, and exit-code taxonomy", () => {
    expect(MANAGED_PROTOCOL_VERSION).toBe(1)
    expect(MANAGED_PROTOCOL_COMMANDS).toEqual(["protocol-version", "managed-create-initialize", "managed-status"])
    expect(MANAGED_EXIT_CODES).toEqual({
      success: 0,
      invalidRequest: 2,
      contentionRetryable: 3,
      reconcileQuarantineFatal: 4,
      internalDefect: 5,
    })
    expect(categoryForExitCode(MANAGED_EXIT_SUCCESS)).toBeUndefined()
    expect(categoryForExitCode(MANAGED_EXIT_INVALID_REQUEST)).toBe("invalid-request")
    expect(categoryForExitCode(MANAGED_EXIT_CONTENTION_RETRYABLE)).toBe("contention")
    expect(categoryForExitCode(MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL)).toBe("reconcile-required")
    expect(categoryForExitCode(MANAGED_EXIT_INTERNAL_DEFECT)).toBe("internal")
    expect(categoryForExitCode(1)).toBeUndefined()
    expect(exitCodeForCategory("invalid-request")).toBe(2)
    expect(exitCodeForCategory("contention")).toBe(3)
    expect(exitCodeForCategory("reconcile-required")).toBe(4)
    expect(exitCodeForCategory("internal")).toBe(5)
  })
})

describe("managed request documents", () => {
  test("builders emit exact-key v1 documents", () => {
    expect(managedProtocolVersionRequestDocument()).toEqual({ protocolVersion: 1, command: "protocol-version" })
    expect(managedStatusRequestDocument("wt_test")).toEqual({
      protocolVersion: 1,
      command: "managed-status",
      worktreeId: "wt_test",
    })

    const document = managedCreateInitializeRequestDocument(validCreateInput())
    expect(Object.keys(document)).toEqual([
      "protocolVersion",
      "command",
      "worktreeId",
      "repositoryId",
      "repositoryPath",
      "storageVolumeId",
      "targetPath",
      "branchName",
      "commitish",
      "storagePolicy",
      "storageProbe",
      "dedupe",
    ])
    expect(document.command).toBe("managed-create-initialize")
    expect(document.storagePolicy.acceptedVolumeGuids).toHaveLength(1)
    expect(document.dedupe).not.toHaveProperty("concurrency")
    expect(serializeRequestDocument(document)).toContain('"managed-create-initialize"')
  })

  test("optional fields stay absent when the caller does not resolve them", () => {
    const input = validCreateInput()
    const document = createInitializeRequestDocument({
      ...input,
      repositoryPath: undefined,
      storagePolicy: { ...input.storagePolicy, expectedLabel: undefined },
      storageProbe: { helperPath: input.storageProbe.helperPath },
      dedupe: { nativeHelperPath: input.dedupe.nativeHelperPath, minimumCandidateBytes: 4096 },
    })
    expect(document).not.toHaveProperty("repositoryPath")
    expect(document.storagePolicy).not.toHaveProperty("expectedLabel")
    expect(document.storageProbe).not.toHaveProperty("helperArgsPrefix")
    expect(document.dedupe).not.toHaveProperty("nativeHelperArgsPrefix")
  })

  test("rejects malformed resolved policy input", () => {
    expectRequestInvalid(() => managedCreateInitializeRequestDocument(validCreateInput({ targetPath: "managed\\wt" })))
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ storagePolicy: { ...validCreateInput().storagePolicy, acceptedVolumeGuids: [] } }),
      ),
    )
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ storagePolicy: { ...validCreateInput().storagePolicy, minimumVolumeFreeRatio: 1.5 } }),
      ),
    )
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ dedupe: { nativeHelperPath: "C:\\helpers\\x.exe", minimumCandidateBytes: 0 } }),
      ),
    )
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ dedupe: { nativeHelperPath: "C:\\helpers\\x.exe", minimumCandidateBytes: 1, concurrency: 65 } }),
      ),
    )
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ storageProbe: { helperPath: "", helperArgsPrefix: ["--x"] } }),
      ),
    )
    expectRequestInvalid(() => managedStatusRequestDocument(""))
    expectRequestInvalid(() =>
      managedCreateInitializeRequestDocument(
        validCreateInput({ storagePolicy: { ...validCreateInput().storagePolicy, surprise: true } as never }),
      ),
    )
    expectRequestInvalid(() => createInitializeRequestDocument(validCreateInput({ branchName: "refs/heads/feature" })))
  })
})

describe("managed response envelope", () => {
  test("accepts a well-formed success document", () => {
    const response = parseManagedResponseText(successResponse("protocol-version", { managedProtocolVersion: 1 }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.command).toBe("protocol-version")
    expect(response.result).toEqual({ managedProtocolVersion: 1 })
  })

  test("accepts a well-formed error document", () => {
    const response = parseManagedResponseText(errorResponse("managed-status", DOMAIN_ERROR))
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.category).toBe("invalid-request")
    expect(response.error.retryable).toBe(false)
  })

  test("rejects malformed stdout", () => {
    expectWireViolation(() => parseManagedResponseText(""))
    expectWireViolation(() => parseManagedResponseText("   "))
    expectWireViolation(() => parseManagedResponseText("not json"))
    expectWireViolation(() => parseManagedResponseText("\uFEFF" + successResponse("protocol-version", {})))
    expectWireViolation(() => parseManagedResponseText(successResponse("protocol-version", {}) + " trailing"))
    expectWireViolation(() =>
      parseManagedResponseText(successResponse("protocol-version", {}) + "\n" + successResponse("protocol-version", {})),
    )
  })

  test("rejects extra keys, wrong protocol versions, and unknown commands", () => {
    expectWireViolation(() =>
      parseManagedResponseText(
        JSON.stringify({ protocolVersion: 1, ok: true, command: "protocol-version", result: {}, extra: true }),
      ),
    )
    expectWireViolation(() =>
      parseManagedResponseText(JSON.stringify({ protocolVersion: 2, ok: true, command: "protocol-version", result: {} })),
    )
    expectWireViolation(() =>
      parseManagedResponseText(JSON.stringify({ protocolVersion: 1, ok: true, command: "frobnicate", result: {} })),
    )
    expectWireViolation(() =>
      parseManagedResponseText(errorResponse("managed-status", { ...DOMAIN_ERROR, surprise: 1 })),
    )
    expectWireViolation(() =>
      parseManagedResponseText(
        errorResponse("managed-status", { ...DOMAIN_ERROR, category: "contention", retryable: false }),
      ),
    )
  })
})

describe("managed exit-code taxonomy", () => {
  test("maps exit codes to categories with matching payloads", () => {
    const success = parseManagedExitOutcome(
      { exitCode: 0, stdout: successResponse("managed-status", statusResult("wt_test")), stderr: "" },
      { command: "managed-status" },
    )
    expect(success.category).toBeUndefined()
    expect(success.retryable).toBe(false)

    const contention = parseManagedExitOutcome(
      {
        exitCode: MANAGED_EXIT_CONTENTION_RETRYABLE,
        stdout: errorResponse("managed-status", {
          code: MANAGED_ERROR_CODES.contentionRetryable,
          category: "contention",
          retryable: true,
          message: "database is locked",
        }),
        stderr: "managed-cli: CONTENTION_RETRYABLE",
      },
      { command: "managed-status" },
    )
    expect(contention.category).toBe("contention")
    expect(contention.retryable).toBe(true)

    const reconcile = parseManagedExitOutcome(
      {
        exitCode: MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL,
        stdout: errorResponse("managed-create-initialize", {
          code: MANAGED_ERROR_CODES.worktreeStateConflict,
          category: "reconcile-required",
          retryable: false,
          message: "worktree exists in lifecycle error",
          reconcileRequired: true,
        }),
        stderr: "",
      },
      { command: "managed-create-initialize" },
    )
    expect(reconcile.category).toBe("reconcile-required")

    const internal = parseManagedExitOutcome(
      {
        exitCode: MANAGED_EXIT_INTERNAL_DEFECT,
        stdout: errorResponse("managed-status", {
          code: MANAGED_ERROR_CODES.internalDefect,
          category: "internal",
          retryable: false,
          message: "bug",
        }),
        stderr: "",
      },
      { command: "managed-status" },
    )
    expect(internal.category).toBe("internal")

    const invalid = parseManagedExitOutcome(
      { exitCode: MANAGED_EXIT_INVALID_REQUEST, stdout: errorResponse("managed-status", DOMAIN_ERROR), stderr: "" },
      { command: "managed-status" },
    )
    expect(invalid.category).toBe("invalid-request")
  })

  test("rejects contradictions between exit code and payload", () => {
    expectWireViolation(() =>
      parseManagedExitOutcome(
        { exitCode: 0, stdout: errorResponse("managed-status", DOMAIN_ERROR), stderr: "" },
        { command: "managed-status" },
      ),
    )
    expectWireViolation(() =>
      parseManagedExitOutcome(
        {
          exitCode: MANAGED_EXIT_INVALID_REQUEST,
          stdout: successResponse("managed-status", statusResult("wt_test")),
          stderr: "",
        },
        { command: "managed-status" },
      ),
    )
    expectWireViolation(() =>
      parseManagedExitOutcome(
        { exitCode: 1, stdout: successResponse("managed-status", {}), stderr: "boom" },
        { command: "managed-status" },
      ),
    )
    expectWireViolation(() =>
      parseManagedExitOutcome(
        {
          exitCode: MANAGED_EXIT_INVALID_REQUEST,
          stdout: errorResponse("managed-status", {
            code: MANAGED_ERROR_CODES.contentionRetryable,
            category: "contention",
            retryable: true,
            message: "locked",
          }),
          stderr: "",
        },
        { command: "managed-status" },
      ),
    )
    expectWireViolation(() =>
      parseManagedExitOutcome(
        { exitCode: 0, stdout: successResponse("managed-create-initialize", {}), stderr: "" },
        { command: "managed-status" },
      ),
    )
    expectWireViolation(() =>
      parseManagedExitOutcome({ exitCode: 0, stdout: "", stderr: "empty" }, { command: "managed-status" }),
    )
  })
})

describe("managed protocol-version postconditions", () => {
  test("parses the exact v1 handshake result", () => {
    const result = parseManagedProtocolVersionResult(protocolVersionResult())
    expect(result.managedProtocolVersion).toBe(1)
    expect(result.commands).toContain("managed-create-initialize")
    expect(result.capabilities.managedCreateInitialize.neverFallsBackToUnmanagedGit).toBe(true)
    expect(result.capabilities.managedStatus.readOnly).toBe(true)
    expect(result.exitCodes).toEqual(MANAGED_EXIT_CODES)
  })

  test("preserves additive capability extensions without guessing their shape", () => {
    const documented = protocolVersionResult()
    const capabilities = { ...(documented.capabilities as Record<string, unknown>) }
    capabilities.managedProvisionRepository = { requiresElevation: false }
    const result = parseManagedProtocolVersionResult({ ...documented, capabilities })
    expect(result.capabilities.additions).toEqual({ managedProvisionRepository: { requiresElevation: false } })
  })

  test("rejects a handshake that is missing required v1 facts", () => {
    const missingCommand = protocolVersionResult()
    ;(missingCommand as Record<string, unknown>).commands = ["protocol-version", "managed-create-initialize"]
    expectWireViolation(() => parseManagedProtocolVersionResult(missingCommand))

    const wrongExitCodes = protocolVersionResult()
    ;(wrongExitCodes as Record<string, unknown>).exitCodes = { ...MANAGED_EXIT_CODES, invalidRequest: 9 }
    expectWireViolation(() => parseManagedProtocolVersionResult(wrongExitCodes))

    const missingCapability = protocolVersionResult()
    const capabilities = { ...(missingCapability.capabilities as Record<string, unknown>) }
    delete capabilities.managedStatus
    ;(missingCapability as Record<string, unknown>).capabilities = capabilities
    expectWireViolation(() => parseManagedProtocolVersionResult(missingCapability))

    const nonBooleanFlag = protocolVersionResult()
    const create = {
      ...((nonBooleanFlag.capabilities as Record<string, unknown>).managedCreateInitialize as Record<string, unknown>),
      neverFallsBackToUnmanagedGit: "yes",
    }
    ;(nonBooleanFlag as Record<string, unknown>).capabilities = {
      ...(nonBooleanFlag.capabilities as Record<string, unknown>),
      managedCreateInitialize: create,
    }
    expectWireViolation(() => parseManagedProtocolVersionResult(nonBooleanFlag))

    const unknownTopLevel = protocolVersionResult()
    ;(unknownTopLevel as Record<string, unknown>).surprise = true
    expectWireViolation(() => parseManagedProtocolVersionResult(unknownTopLevel))
  })
})

describe("managed-status postconditions", () => {
  test("parses a well-formed observation and enforces identity echo", () => {
    const result = parseManagedStatusResult(statusResult("wt_test"), { worktreeId: "wt_test" })
    expect(result.worktree?.lifecycleState).toBe("idle_clean")
    expect(result.handoff.reconcileRequired).toBe(false)
    expect(result.revision.actual).toBe(result.worktree?.revision)

    expectWireViolation(() => parseManagedStatusResult(statusResult("wt_other"), { worktreeId: "wt_test" }))
    expectWireViolation(() =>
      parseManagedStatusResult(statusResult("wt_test", { worktree: null }), { worktreeId: "wt_test" }),
    )
    expectWireViolation(() =>
      parseManagedStatusResult(statusResult("wt_test", { revision: { actual: 99, openOperationExpectedRevisions: [] } }), {
        worktreeId: "wt_test",
      }),
    )
    const extraKey = statusResult("wt_test")
    extraKey.surprise = true
    expectWireViolation(() => parseManagedStatusResult(extraKey, { worktreeId: "wt_test" }))
  })

  test("bounds evidence text and array sizes", () => {
    const worktree = statusResult("wt_test").worktree as Record<string, unknown>
    expectWireViolation(() =>
      parseManagedStatusResult(statusResult("wt_test", { worktree: { ...worktree, head: "a".repeat(8192) } }), {
        worktreeId: "wt_test",
      }),
    )
    expectWireViolation(() =>
      parseManagedStatusResult(
        statusResult("wt_test", { guardAttempts: Array.from({ length: 65 }, () => ({})) }),
        { worktreeId: "wt_test" },
      ),
    )
  })
})

describe("managed-create-initialize postconditions", () => {
  const input = validCreateInput()
  const request = managedCreateInitializeRequestDocument(input)

  test("accepts the exact managed idle-clean result", () => {
    const result = parseManagedCreateInitializeResult(createResult(input), { request })
    expect(result.lifecycleState).toBe("idle_clean")
    expect(result.durabilityClass).toBe("reconstructable_clean")
    expect(result.branchRef).toBe("refs/heads/feature/managed")
    expect(result.pinRef).toBe("refs/worktree-store/pins/wt_test")
    expect(result.idempotent).toBe(false)
  })

  test("accepts an idempotent result with absent operation ids", () => {
    const result = parseManagedCreateInitializeResult(
      createResult(input, {
        idempotent: true,
        createOperationId: null,
        initializationOperationId: null,
        summary: null,
      }),
      { request },
    )
    expect(result.idempotent).toBe(true)
    expect(result.createOperationId).toBeNull()
  })

  test("rejects identity and state postcondition violations", () => {
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { worktreeId: "wt_other" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { ownership: "unmanaged" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { lifecycleState: "error" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { durabilityClass: "quarantined" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { pinRef: "refs/worktree-store/pins/other" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { branchRef: "refs/heads/other" }), { request }),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(
        createResult(input, { idempotent: false, initializationOperationId: null }),
        { request },
      ),
    )
    expectWireViolation(() =>
      parseManagedCreateInitializeResult(createResult(input, { revision: 0 }), { request }),
    )
  })
})
