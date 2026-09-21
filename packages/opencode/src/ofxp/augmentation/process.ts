export * as OfxpProcessCapability from "./process"

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeOwnedCommand } from "@/exchange/owned-command"
import { ExchangeProcess } from "@/exchange/process"
import { ExchangeProcessEnvironment } from "@/exchange/process-environment"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { ShellLaunch } from "@/tool/shell/launch"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeProcess.Parameters

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

type Owned = {
  readonly handle: ExchangeProcess.Handle
  readonly ownerKey: string
  readonly peerID: Ofxp.PeerID
  readonly rootID: Ofxp.RootID
}

const MAX_TIMER_MS = 2_147_000_000

export interface Interface {
  readonly execute: (
    peer: PeerCertificateIdentity,
    call: Ofxp.CapabilityCall,
    signal?: AbortSignal,
  ) => Effect.Effect<Result, unknown>
  /** Internal exact-argv lifecycle for trusted higher-level OFXP capabilities. */
  readonly runArgv: (
    peer: PeerCertificateIdentity,
    context: Ofxp.InvocationContext,
    input: {
      readonly rootID: Ofxp.RootID
      readonly workdir?: string
      readonly argv: readonly [string, ...string[]]
      readonly env?: NodeJS.ProcessEnv
      readonly title?: string
      readonly operation?: string
      readonly timeoutMs: number
      readonly outputCapBytes?: number
      readonly expectedGrantRevision?: number
      /** Trusted write-ahead hook immediately before the process spawn boundary. */
      readonly beforeStart?: () => Effect.Effect<void, unknown>
    },
    signal?: AbortSignal,
  ) => Effect.Effect<ExchangeOwnedCommand.Result, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OfxpProcessCapability") {}
export const use = serviceUse(Service)

function handleFor(peerID: Ofxp.PeerID, invocationID: Ofxp.InvocationID): ExchangeProcess.Handle {
  const digest = ExchangeRequestDigest.sha256("ofxp:process-handle:v1", { peerID, invocationID }).slice("sha256:".length, "sha256:".length + 40)
  return Schema.decodeUnknownSync(ExchangeProcess.Handle)(`proc_${digest}`)
}

function defaultShell() {
  return process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const processes = yield* ExchangeProcess.Service
    const fs = yield* FSUtil.Service
    const owned = new Map<ExchangeProcess.Handle, Owned>()
    const deadlines = new Map<ExchangeProcess.Handle, ReturnType<typeof setTimeout>>()

    const clearDeadline = (handle: ExchangeProcess.Handle) => {
      const timer = deadlines.get(handle)
      if (timer) clearTimeout(timer)
      deadlines.delete(handle)
    }

    const forget = (handle: ExchangeProcess.Handle) => {
      clearDeadline(handle)
      owned.delete(handle)
    }

    const retireOwned = (item: Owned) =>
      processes.retire(item.ownerKey, item.handle).pipe(
        Effect.tap((retired) => Effect.sync(() => retired && forget(item.handle))),
        Effect.asVoid,
      )

    const runRetire = (item: Owned) => {
      void Effect.runPromise(retireOwned(item).pipe(Effect.catch(() => Effect.void)))
    }

    const armExpiry = (item: Owned, expiresAt?: number) => {
      clearDeadline(item.handle)
      if (expiresAt === undefined) return
      const schedule = () => {
        const remaining = expiresAt - Date.now()
        if (remaining <= 0) {
          runRetire(item)
          return
        }
        deadlines.set(item.handle, setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS)))
      }
      schedule()
    }

    const register = (item: Owned, expiresAt?: number) => {
      owned.set(item.handle, item)
      armExpiry(item, expiresAt)
    }

    const unsubscribe = peers.subscribe((change) => {
      for (const item of owned.values()) {
        if (item.peerID !== change.peerID) continue
        if ((change.kind === "root-removed" || change.kind === "root-upserted") && item.rootID !== change.rootID) continue
        runRetire(item)
      }
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe()
        for (const timer of deadlines.values()) clearTimeout(timer)
        deadlines.clear()
      }),
    )

    const authorize = Effect.fn("OfxpProcessCapability.authorize")(function* (
      peerID: Ofxp.PeerID,
      rootID: Ofxp.RootID,
      expectedGrantRevision?: number,
    ) {
      const admission = yield* peers.authorize({
        peerID,
        capability: "process",
        rootID,
        ...(expectedGrantRevision === undefined ? {} : { expectedGrantRevision }),
      })
      const root = yield* roots.verify(admission)
      return { admission, root }
    })

    const revalidate = (
      peerID: Ofxp.PeerID,
      rootID: Ofxp.RootID,
      expectedGrantRevision: number,
    ): Effect.Effect<void, ExchangeError.Error> =>
      authorize(peerID, rootID, expectedGrantRevision).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          new ExchangeError.AuthorityDenied({
            detail: error instanceof Error ? error.message : "OFXP process authority changed",
          }),
        ),
      )

    const requireHandle = (input: ExchangeProcess.Input) =>
      input.handle
        ? Effect.succeed(input.handle)
        : Effect.fail(new ExchangeError.InvalidArgument({ detail: `process.${input.action} requires handle` }))

    const runArgv: Interface["runArgv"] = Effect.fn("OfxpProcessCapability.runArgv")(function* (
      peer,
      context,
      input,
      signal,
    ) {
      if (input.argv.length === 0) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP argv execution requires a program" })
      const { admission, root } = yield* authorize(peer.peerID, input.rootID, input.expectedGrantRevision)
      const workdir = input.workdir ? yield* roots.resolve(admission, input.workdir) : root
      const stat = yield* fs.stat(workdir.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat || stat.type !== "Directory") {
        return yield* new ExchangeError.InvalidArgument({ detail: "OFXP exact-argv workdir must be an existing directory" })
      }
      const ownerKey = OfxpPrincipal.key(peer.peerID, context)
      const expectedRevision = admission.grantRevision

      const result = yield* ExchangeOwnedCommand.run<unknown>(
        {
          start: (request) =>
            Effect.gen(function* () {
              const [bin, ...args] = request.argv
              const handle = Schema.decodeUnknownSync(ExchangeProcess.Handle)(
                `proc_${randomUUID().replaceAll("-", "")}`,
              )
              const item: Owned = { handle, ownerKey, peerID: peer.peerID, rootID: input.rootID }
              if (input.beforeStart) yield* input.beforeStart()
              yield* processes.start({
                handle,
                ownerKey,
                rootKey: input.rootID,
                generation: expectedRevision,
                rootPath: root.rootPath,
                workdir: workdir.path,
                title: request.title ?? [bin, ...args].join(" "),
                shell: "",
                mode: "background",
                command: ChildProcess.make(bin, args, {
                  cwd: workdir.path,
                  env: ExchangeProcessEnvironment.childEnvironment(request.env ?? process.env),
                  stdin: "ignore",
                  detached: process.platform !== "win32",
                  forceKillAfter: "3 seconds",
                }),
                revalidate: () => revalidate(peer.peerID, input.rootID, expectedRevision),
                onStdout: request.onStdout,
                onStderr: request.onStderr,
              })
              register(item, admission.grantExpiresAt)
              return { handle }
            }),
          wait: (handle, timeoutMs, waitSignal) =>
            processes.wait(ownerKey, Schema.decodeUnknownSync(ExchangeProcess.Handle)(handle), timeoutMs, waitSignal),
          kill: (handle) => processes.kill(ownerKey, Schema.decodeUnknownSync(ExchangeProcess.Handle)(handle)),
          remove: (handle) =>
            Effect.gen(function* () {
              const parsed = Schema.decodeUnknownSync(ExchangeProcess.Handle)(handle)
              const removed = yield* processes.remove(ownerKey, parsed)
              if (removed) forget(parsed)
            }),
        },
        {
          argv: input.argv,
          workdir: input.workdir,
          env: input.env,
          title: input.title,
          operation: input.operation,
          timeoutMs: input.timeoutMs,
          outputCapBytes: input.outputCapBytes,
          signal,
        },
      )
      yield* authorize(peer.peerID, input.rootID, expectedRevision)
      return result
    })

    const execute: Interface["execute"] = Effect.fn("OfxpProcessCapability.execute")(function* (peer, call, signal) {
      if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP process operations require an approved root" })
      const input = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP process arguments are invalid" }),
      })
      const rootID = call.rootID
      const ownerKey = OfxpPrincipal.key(peer.peerID, call.context)

      if (input.action === "list") {
        const { admission } = yield* authorize(peer.peerID, rootID)
        const views = yield* processes.list(ownerKey, rootID, admission.grantRevision)
        yield* authorize(peer.peerID, rootID, admission.grantRevision)
        return {
          title: "Remote processes",
          output: JSON.stringify(views),
          metadata: { processes: views },
          grantRevision: admission.grantRevision,
        }
      }

      if (input.action === "start") {
        if (!input.command) return yield* new ExchangeError.InvalidArgument({ detail: "process.start requires command" })
        if (Buffer.byteLength(input.command, "utf8") > ExchangeProcess.MAX_COMMAND_BYTES) {
          return yield* new ExchangeError.InvalidArgument({ detail: "process.start command exceeds 256 KiB" })
        }
        const { admission, root } = yield* authorize(peer.peerID, rootID)
        const workdir = input.workdir ? yield* roots.resolve(admission, input.workdir) : root
        const stat = yield* fs.stat(workdir.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat || stat.type !== "Directory") {
          return yield* new ExchangeError.InvalidArgument({ detail: "process.start workdir must be an existing directory" })
        }
        const shell = input.shell ?? defaultShell()
        const env = ExchangeProcessEnvironment.childEnvironment(process.env)
        const command = yield* Effect.try({
          try: () =>
            ShellLaunch.command(
              shell,
              input.command!,
              workdir.path,
              env,
              { stream: "pipe", endOnDone: false },
              { forceKillAfter: "3 seconds" },
            ),
          catch: (cause) => new ExchangeError.InvalidArgument({ detail: cause instanceof Error ? cause.message : String(cause) }),
        })
        const handle = handleFor(peer.peerID, call.context.invocationID)
        const requestDigest = ExchangeRequestDigest.sha256("ofxp:process-start:v1", {
          rootID,
          workdir: workdir.relativePath,
          command: input.command,
          shell,
          mode: input.mode ?? "foreground",
          yieldMs: input.yieldMs ?? 10_000,
          ownerKey,
        })
        const admitted = yield* invocations.admit({
          invocationID: call.context.invocationID,
          sourcePeerID: peer.peerID,
          operation: "process.start",
          commitClass: "durable_start",
          requestDigest,
          targetRef: handle,
        })

        const item: Owned = { handle, ownerKey, peerID: peer.peerID, rootID }
        if (!admitted.fresh) {
          const receipt = admitted.receipt
          if (receipt.state === "committed") {
            const current = yield* processes.descriptor(ownerKey, handle)
            if (!current) {
              return yield* new ExchangeError.NotFound({
                detail: `Process start ${receipt.invocationID} was committed, but its live-runtime handle is stale; OFXP will not respawn it automatically`,
              })
            }
            register(item, admission.grantExpiresAt)
            const view = yield* processes.status(ownerKey, handle)
            return {
              title: input.command,
              output: `OFXP process invocation ${receipt.invocationID} was already committed; no duplicate process was spawned.`,
              metadata: { ...view, duplicate: true, receipt },
              grantRevision: admission.grantRevision,
            }
          }
          if (receipt.state === "started") {
            const current = yield* processes.descriptor(ownerKey, handle)
            if (!current) {
              return yield* new ExchangeError.AmbiguousCommit({
                detail: `OFXP process invocation ${receipt.invocationID} crossed its start boundary but no live handle can be proven; do not respawn with this InvocationID`,
                targetRef: handle,
              })
            }
            register(item, admission.grantExpiresAt)
            const settled = yield* invocations.settle({ invocationID: receipt.invocationID, state: "committed", targetRef: handle })
            const view = yield* processes.status(ownerKey, handle)
            return {
              title: input.command,
              output: `Reconciled OFXP process invocation ${receipt.invocationID}; no duplicate process was spawned.`,
              metadata: { ...view, duplicate: true, reconciled: true, receipt: settled },
              grantRevision: admission.grantRevision,
            }
          }
          if (receipt.state === "cancelled") {
            return yield* new ExchangeError.Cancelled({ detail: `OFXP process invocation ${receipt.invocationID} was already cancelled` })
          }
          if (receipt.state === "failed") {
            return yield* new ExchangeError.Conflict({ detail: `OFXP process invocation ${receipt.invocationID} already failed; use a new InvocationID` })
          }
        }

        yield* invocations.prepare({ invocationID: call.context.invocationID, targetRef: handle })
        const view = yield* processes.start({
          handle,
          ownerKey,
          rootKey: rootID,
          generation: admission.grantRevision,
          rootPath: root.rootPath,
          workdir: workdir.path,
          title: input.command,
          shell,
          mode: input.mode ?? "foreground",
          command,
          revalidate: () => revalidate(peer.peerID, rootID, admission.grantRevision),
        }).pipe(
          Effect.tapError((error) =>
            error instanceof ExchangeError.AmbiguousCommit
              ? Effect.void
              : invocations
                  .settle({ invocationID: call.context.invocationID, state: error instanceof ExchangeError.Cancelled ? "cancelled" : "failed", targetRef: handle })
                  .pipe(Effect.catch(() => Effect.void), Effect.asVoid),
          ),
        )
        register(item, admission.grantExpiresAt)
        const receipt = yield* invocations
          .settle({ invocationID: call.context.invocationID, state: "committed", targetRef: handle })
          .pipe(
            Effect.mapError(
              () =>
                new ExchangeError.AmbiguousCommit({
                  detail: `Process ${handle} started but its durable receipt could not be settled; reconcile the same InvocationID before retrying`,
                  targetRef: handle,
                }),
            ),
          )

        let finalView = view
        let output = `process running: ${handle}`
        if ((input.mode ?? "foreground") === "foreground") {
          finalView = yield* processes.wait(ownerKey, handle, input.yieldMs ?? 10_000, signal)
          if (!finalView.running) {
            const page = yield* processes.poll(ownerKey, handle, 0, 64 * 1024)
            output = page.output || "(no output)"
          }
        }
        return {
          title: input.command,
          output,
          metadata: { ...finalView, invocationID: call.context.invocationID, receipt },
          grantRevision: admission.grantRevision,
        }
      }

      const handle = yield* requireHandle(input)
      if (input.action === "status" || input.action === "poll" || input.action === "wait") {
        const found = yield* processes.descriptor(ownerKey, handle)
        if (!found || found.rootKey !== rootID) return yield* new ExchangeError.NotFound({ detail: "Unknown or stale process handle" })
        const { admission } = yield* authorize(peer.peerID, rootID, found.generation)
        const egress = () => authorize(peer.peerID, rootID, found.generation).pipe(Effect.asVoid)
        if (input.action === "status") {
          const view = yield* processes.status(ownerKey, handle)
          yield* egress()
          return { title: handle, output: JSON.stringify(view), metadata: { ...view }, grantRevision: admission.grantRevision }
        }
        if (input.action === "poll") {
          const page = yield* processes.poll(ownerKey, handle, input.offset ?? 0, input.maxBytes ?? 64 * 1024)
          yield* egress()
          return { title: handle, output: page.output, metadata: page.metadata, grantRevision: admission.grantRevision }
        }
        const view = yield* processes.wait(ownerKey, handle, input.timeoutMs ?? 30_000, signal)
        yield* egress()
        return { title: handle, output: JSON.stringify(view), metadata: { ...view }, grantRevision: admission.grantRevision }
      }

      // Mutation reconciliation must not require the live resource to still
      // exist. A committed remove/kill/write receipt is durable evidence that
      // the exact request already crossed its mutation boundary. We still
      // require current process+root authority before revealing/reusing it.
      const current = yield* authorize(peer.peerID, rootID)
      const mutation = input.action
      const requestDigest = ExchangeRequestDigest.sha256(`ofxp:process-${mutation}:v1`, {
        rootID,
        handle,
        ...(input.action === "write" ? { chars: input.chars } : {}),
        ownerKey,
      })
      const commitClass = input.action === "write" ? "non_idempotent_mutation" : "idempotent_mutation"
      const admitted = yield* invocations.admit({
        invocationID: call.context.invocationID,
        sourcePeerID: peer.peerID,
        operation: `process.${mutation}`,
        commitClass,
        requestDigest,
        targetRef: handle,
      })

      if (!admitted.fresh) {
        const receipt = admitted.receipt
        if (receipt.state === "committed") {
          return {
            title: handle,
            output: `OFXP process.${mutation} invocation ${receipt.invocationID} was already committed; no duplicate mutation was executed.`,
            metadata: { duplicate: true, receipt, handle },
            grantRevision: current.admission.grantRevision,
          }
        }
        if (receipt.state === "started" && input.action === "write") {
          return yield* new ExchangeError.AmbiguousCommit({
            detail: `OFXP process.write invocation ${receipt.invocationID} may have written partial stdin; do not replay it blindly`,
            targetRef: handle,
          })
        }
        if (receipt.state === "cancelled") {
          return yield* new ExchangeError.Cancelled({ detail: `OFXP process.${mutation} invocation ${receipt.invocationID} was already cancelled` })
        }
        if (receipt.state === "failed") {
          return yield* new ExchangeError.Conflict({ detail: `OFXP process.${mutation} invocation ${receipt.invocationID} already failed` })
        }
        // started kill/remove are idempotent and safe to reconcile by replaying
        // the same control operation after live-handle validation below.
      }

      const found = yield* processes.descriptor(ownerKey, handle)
      if (!found || found.rootKey !== rootID) return yield* new ExchangeError.NotFound({ detail: "Unknown or stale process handle" })
      const { admission } = yield* authorize(peer.peerID, rootID, found.generation)
      const egress = () => authorize(peer.peerID, rootID, found.generation).pipe(Effect.asVoid)

      yield* invocations.prepare({ invocationID: call.context.invocationID, targetRef: handle })
      yield* egress()

      if (input.action === "write") {
        if (input.chars === undefined) return yield* new ExchangeError.InvalidArgument({ detail: "process.write requires chars" })
        const view = yield* processes.write(ownerKey, handle, input.chars).pipe(
          Effect.mapError(
            () =>
              new ExchangeError.AmbiguousCommit({
                detail: `OFXP process.write invocation ${call.context.invocationID} may have written partial stdin; inspect process state before continuing`,
                targetRef: handle,
              }),
          ),
        )
        const receipt = yield* invocations.settle({ invocationID: call.context.invocationID, state: "committed", targetRef: handle })
        return {
          title: handle,
          output: `wrote ${Buffer.byteLength(input.chars, "utf8")} bytes to ${handle}`,
          metadata: { ...view, receipt },
          grantRevision: admission.grantRevision,
        }
      }

      if (input.action === "kill") {
        const view = yield* processes.kill(ownerKey, handle)
        const receipt = yield* invocations.settle({ invocationID: call.context.invocationID, state: "committed", targetRef: handle })
        return { title: handle, output: JSON.stringify(view), metadata: { ...view, receipt }, grantRevision: admission.grantRevision }
      }

      if (input.action === "remove") {
        const removed = yield* processes.remove(ownerKey, handle)
        if (removed) forget(handle)
        const receipt = yield* invocations.settle({ invocationID: call.context.invocationID, state: "committed", targetRef: handle })
        return {
          title: handle,
          output: removed ? `removed ${handle}` : `${handle} was already absent`,
          metadata: { handle, removed, receipt },
          grantRevision: admission.grantRevision,
        }
      }

      return yield* new ExchangeError.InvalidArgument({ detail: "Unsupported OFXP process action" })
    })

    return Service.of({ execute, runArgv })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OfxpPeer.node, OfxpRoot.node, OfxpInvocation.node, ExchangeProcess.node, FSUtil.node],
})

