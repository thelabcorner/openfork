import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import path from "node:path"
import {
  AmbiguousOutcomeError,
  ContentionError,
  InternalError,
  ManagedWorktreeManager,
  ProtocolViolationError,
  ReconcileError,
  RequestRejectedError,
  UnavailableError,
} from "../../src/worktree/managed/client"
import { MANAGED_ERROR_CODES } from "../../src/worktree/managed/protocol"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { captureRecords, createResult, protocolVersionResult, statusResult, validCreateInput, writeFakeCli } from "./managed-fake-cli"

const it = testEffect(LayerNode.compile(LayerNode.group([ManagedWorktreeManager.node])))

const scopedTmpdir = (_label: string) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function errorPayload(code: string, category: string, message: string, extra: Record<string, unknown> = {}) {
  return { code, category, retryable: category === "contention", message, ...extra }
}

describe("ManagedWorktreeManager invocation", () => {
  it.live("runs protocol-version with the exact request document and no control plane", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-version")
      const fake = writeFakeCli(tmp.path, {
        results: { "protocol-version": protocolVersionResult() },
        capturePath: path.join(tmp.path, "capture.jsonl"),
      })
      const manager = yield* ManagedWorktreeManager.Service
      const result = yield* manager.protocolVersion({ executable: fake.executable })
      expect(result.managedProtocolVersion).toBe(1)
      expect(result.capabilities.managedCreateInitialize.neverFallsBackToUnmanagedGit).toBe(true)

      const records = captureRecords(fake.capturePath)
      expect(records).toHaveLength(1)
      expect(records[0]!.argv).toEqual(["protocol-version"])
      expect(JSON.parse(records[0]!.stdin)).toEqual({ protocolVersion: 1, command: "protocol-version" })
    }),
  )

  it.live("runs managed-status with explicit control-plane arguments and no shell", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-status")
      const controlPlaneRoot = path.join(tmp.path, "control-plane")
      const discoveryDirectory = path.join(tmp.path, "service-discovery")
      const fake = writeFakeCli(tmp.path, {
        results: { "managed-status": statusResult("wt_test") },
        capturePath: path.join(tmp.path, "capture.jsonl"),
      })
      const manager = yield* ManagedWorktreeManager.Service
      const result = yield* manager.status({
        executable: fake.executable,
        worktreeId: "wt_test",
        controlPlaneRoot,
        coordinatorEndpoint: "\\\\.\\pipe\\worktree-store-fixture",
        discoveryDirectory,
      })
      expect(result.worktree?.lifecycleState).toBe("idle_clean")

      const records = captureRecords(fake.capturePath)
      expect(records).toHaveLength(1)
      expect(records[0]!.argv).toEqual([
        "managed-status",
        "--control-plane-root",
        controlPlaneRoot,
        "--coordinator-endpoint",
        "\\\\.\\pipe\\worktree-store-fixture",
        "--openfork-discovery-directory",
        discoveryDirectory,
      ])
      expect(JSON.parse(records[0]!.stdin)).toEqual({
        protocolVersion: 1,
        command: "managed-status",
        worktreeId: "wt_test",
      })
    }),
  )

  it.live("refuses a relative OpenFork discovery directory without spawning", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-discovery")
      const fake = writeFakeCli(tmp.path, {
        results: { "managed-status": statusResult("wt_test") },
        capturePath: path.join(tmp.path, "capture.jsonl"),
      })
      const manager = yield* ManagedWorktreeManager.Service
      const error = yield* manager
        .status({
          executable: fake.executable,
          worktreeId: "wt_test",
          controlPlaneRoot: path.join(tmp.path, "control-plane"),
          discoveryDirectory: "service-discovery",
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(InternalError)
      expect((error as InternalError).code).toBe("invocation-invalid")
      expect(captureRecords(fake.capturePath)).toHaveLength(0)
    }),
  )

  it.live("runs managed-create-initialize with the fully resolved policy on stdin", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-create")
      const input = validCreateInput()
      const fake = writeFakeCli(tmp.path, {
        results: { "managed-create-initialize": createResult(input) },
        capturePath: path.join(tmp.path, "capture.jsonl"),
      })
      const manager = yield* ManagedWorktreeManager.Service
      const result = yield* manager.createInitialize({
        executable: fake.executable,
        request: input,
        controlPlaneRoot: path.join(tmp.path, "control-plane"),
      })
      expect(result.lifecycleState).toBe("idle_clean")
      expect(result.pinRef).toBe("refs/worktree-store/pins/wt_test")

      const document = JSON.parse(captureRecords(fake.capturePath)[0]!.stdin)
      expect(document.command).toBe("managed-create-initialize")
      expect(document.storagePolicy.acceptedVolumeGuids).toEqual(input.storagePolicy.acceptedVolumeGuids)
      expect(document.dedupe.nativeHelperPath).toBe("C:\\helpers\\refs-block-clone.exe")
    }),
  )
})

describe("ManagedWorktreeManager stdout discipline", () => {
  it.live("rejects malformed, extra, and duplicated stdout documents", () =>
    Effect.gen(function* () {
      const manager = yield* ManagedWorktreeManager.Service
      const tmp = yield* scopedTmpdir("managed-client-stdout")
      const good = JSON.stringify({
        protocolVersion: 1,
        ok: true,
        command: "protocol-version",
        result: protocolVersionResult(),
      })

      const cases = ["not json", `notice\n${good}`, `${good}\n${good}`, "", "   "]
      for (const [index, rawStdout] of cases.entries()) {
        const fake = writeFakeCli(path.join(tmp.path, `case-${index}`), { rawStdout })
        const error = yield* manager.protocolVersion({ executable: fake.executable }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ProtocolViolationError)
        expect((error as ProtocolViolationError).command).toBe("protocol-version")
      }
    }),
  )

  it.live("rejects a mismatched protocol version and command echo", () =>
    Effect.gen(function* () {
      const manager = yield* ManagedWorktreeManager.Service
      const tmp = yield* scopedTmpdir("managed-client-mismatch")

      const wrongVersion = writeFakeCli(path.join(tmp.path, "version"), {
        response: { protocolVersion: 2, ok: true, command: "protocol-version", result: {} },
      })
      const versionError = yield* manager.protocolVersion({ executable: wrongVersion.executable }).pipe(Effect.flip)
      expect(versionError).toBeInstanceOf(ProtocolViolationError)
      expect((versionError as ProtocolViolationError).code).toBe(MANAGED_ERROR_CODES.protocolVersionUnsupported)

      const wrongCommand = writeFakeCli(path.join(tmp.path, "command"), {
        response: { protocolVersion: 1, ok: true, command: "managed-status", result: statusResult("wt_test") },
      })
      const commandError = yield* manager.protocolVersion({ executable: wrongCommand.executable }).pipe(Effect.flip)
      expect(commandError).toBeInstanceOf(ProtocolViolationError)
      expect((commandError as ProtocolViolationError).code).toBe(MANAGED_ERROR_CODES.commandUnsupported)
    }),
  )

  it.live("keeps bounded stderr without failing a successful run", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-stderr")
      const fake = writeFakeCli(tmp.path, {
        results: { "protocol-version": protocolVersionResult() },
        stderr: "x".repeat(512 * 1024),
      })
      const manager = yield* ManagedWorktreeManager.Service
      const result = yield* manager.protocolVersion({ executable: fake.executable })
      expect(result.managedProtocolVersion).toBe(1)
    }),
  )

  it.live("rejects an identity mismatch in the status result", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-identity")
      const fake = writeFakeCli(tmp.path, { results: { "managed-status": statusResult("wt_other") } })
      const manager = yield* ManagedWorktreeManager.Service
      const error = yield* manager
        .status({ executable: fake.executable, worktreeId: "wt_test", controlPlaneRoot: tmp.path })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProtocolViolationError)
      expect((error as ProtocolViolationError).code).toBe(MANAGED_ERROR_CODES.worktreeIdentityConflict)
    }),
  )
})

describe("ManagedWorktreeManager failure taxonomy", () => {
  it.live("maps exit codes 2/3/4/5 onto typed failures", () =>
    Effect.gen(function* () {
      const manager = yield* ManagedWorktreeManager.Service
      const tmp = yield* scopedTmpdir("managed-client-taxonomy")
      const run = (label: string, exitCode: number, payload: Record<string, unknown>) =>
        Effect.gen(function* () {
          const fake = writeFakeCli(path.join(tmp.path, label), {
            response: { protocolVersion: 1, ok: false, command: "managed-status", error: payload },
            exitCode,
          })
          return yield* manager.status({ executable: fake.executable, worktreeId: "wt_test", controlPlaneRoot: tmp.path }).pipe(Effect.flip)
        })

      const domain = yield* run(
        "domain",
        2,
        errorPayload(MANAGED_ERROR_CODES.repositoryNotRegistered, "invalid-request", "not registered"),
      )
      expect(domain).toBeInstanceOf(RequestRejectedError)
      expect((domain as RequestRejectedError).kind).toBe("domain")

      const protocolMismatch = yield* run(
        "protocol",
        2,
        errorPayload(MANAGED_ERROR_CODES.protocolVersionUnsupported, "invalid-request", "protocol 2"),
      )
      expect(protocolMismatch).toBeInstanceOf(ProtocolViolationError)

      const controlPlane = yield* run(
        "control-plane",
        2,
        errorPayload(MANAGED_ERROR_CODES.controlPlaneUnavailable, "invalid-request", "no control plane"),
      )
      expect(controlPlane).toBeInstanceOf(UnavailableError)

      const contention = yield* run(
        "contention",
        3,
        errorPayload(MANAGED_ERROR_CODES.contentionRetryable, "contention", "database is locked"),
      )
      expect(contention).toBeInstanceOf(ContentionError)

      const reconcile = yield* run(
        "reconcile",
        4,
        errorPayload(MANAGED_ERROR_CODES.worktreeStateConflict, "reconcile-required", "lifecycle error", {
          reconcileRequired: true,
          state: { worktree: { lifecycleState: "error" } },
        }),
      )
      expect(reconcile).toBeInstanceOf(ReconcileError)
      expect((reconcile as ReconcileError).reconcileRequired).toBe(true)
      expect((reconcile as ReconcileError).detailsJson).toContain("lifecycleState")

      const internal = yield* run("internal", 5, errorPayload(MANAGED_ERROR_CODES.internalDefect, "internal", "bug"))
      expect(internal).toBeInstanceOf(InternalError)

      const unknown = yield* run("unknown-code", 2, errorPayload("SOMETHING_NEW", "invalid-request", "new code"))
      expect(unknown).toBeInstanceOf(ProtocolViolationError)
    }),
  )

  it.live("returns an unavailable failure when the executable cannot be spawned", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-spawn")
      const manager = yield* ManagedWorktreeManager.Service
      const error = yield* manager
        .protocolVersion({ executable: { path: path.join(tmp.path, "missing-managed-cli.exe"), argsPrefix: [] } })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as UnavailableError).code).toBe("managed-process-unavailable")
    }),
  )

  it.live("rejects relative executables and shell interpreters without spawning", () =>
    Effect.gen(function* () {
      const manager = yield* ManagedWorktreeManager.Service
      const relative = yield* manager
        .protocolVersion({ executable: { path: "managed-cli.exe", argsPrefix: [] } })
        .pipe(Effect.flip)
      expect(relative).toBeInstanceOf(UnavailableError)
      expect((relative as UnavailableError).code).toBe("managed-executable-not-absolute")

      const nullByte = yield* manager
        .protocolVersion({ executable: { path: "C:\\bad\u0000path.exe", argsPrefix: [] } })
        .pipe(Effect.flip)
      expect(nullByte).toBeInstanceOf(UnavailableError)
      expect((nullByte as UnavailableError).code).toBe("managed-executable-invalid")

      if (process.platform === "win32") {
        const script = yield* manager
          .protocolVersion({ executable: { path: "C:\\managed\\run.cmd", argsPrefix: [] } })
          .pipe(Effect.flip)
        expect(script).toBeInstanceOf(UnavailableError)
        expect((script as UnavailableError).code).toBe("managed-executable-shell-interpreter")
      }
    }),
  )
})

describe("ManagedWorktreeManager timeout and cancellation", () => {
  it.live("kills the child on timeout, returns an ambiguous failure, and never retries", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-timeout")
      const fake = writeFakeCli(tmp.path, { sleepMs: 60_000, capturePath: path.join(tmp.path, "capture.jsonl") })
      const manager = yield* ManagedWorktreeManager.Service
      const error = yield* manager
        .protocolVersion({ executable: fake.executable, timeout: Duration.millis(1500) })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(AmbiguousOutcomeError)
      expect((error as AmbiguousOutcomeError).reason).toBe("timeout")

      const records = captureRecords(fake.capturePath)
      expect(records).toHaveLength(1)

      const killed = yield* Effect.promise(async () => {
        const pid = records[0]!.pid
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            process.kill(pid, 0)
          } catch {
            return true
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return false
      })
      expect(killed).toBe(true)
    }),
  )

  it.live("returns an ambiguous cancelled failure when the caller aborts", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir("managed-client-cancel")
      const fake = writeFakeCli(tmp.path, { sleepMs: 60_000, capturePath: path.join(tmp.path, "capture.jsonl") })
      const controller = new AbortController()
      const manager = yield* ManagedWorktreeManager.Service
      yield* Effect.forkChild(
        Effect.sleep("150 millis").pipe(Effect.tap(() => Effect.sync(() => controller.abort()))),
      )
      const error = yield* manager
        .protocolVersion({ executable: fake.executable, signal: controller.signal })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(AmbiguousOutcomeError)
      expect((error as AmbiguousOutcomeError).reason).toBe("cancelled")
    }),
  )
})
