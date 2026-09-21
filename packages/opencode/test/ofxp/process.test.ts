import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ExchangeProcess } from "../../src/exchange/process"
import { OfxpProcessCapability } from "../../src/ofxp/augmentation/process"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpPrincipal } from "../../src/ofxp/principal"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const processLayer = (filename: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      FSUtil.node,
      OfxpPeer.node,
      OfxpInvocation.node,
      OfxpRoot.node,
      ExchangeProcess.node,
      OfxpProcessCapability.node,
    ]),
    [[Database.node, Database.layerFromPath(filename)]],
  )

const peerLayer = (filename: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(filename)]],
  )

const layer = processLayer(":memory:")
const it = testEffect(layer)

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: `realm:${label.toLowerCase()}`,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
    certificate: {
      peerID: key.peerID,
      fingerprint: key.fingerprint,
      publicKeySpki: key.publicKeySpki,
    } satisfies PeerCertificateIdentity,
  }
}

function call(
  peerID: Ofxp.PeerID,
  sourceSessionID: SessionID,
  rootID: Ofxp.RootID,
  args: unknown,
  invocationID = Ofxp.InvocationID.create(),
): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID,
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID,
      plane: "augmentation",
      hopCount: 0,
    },
    rootID,
    capability: "process",
    contract: "broker-v1:000000000000000000000000",
    args,
  }
}

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function nodeCommand(script: string) {
  if (process.platform === "win32") {
    if (script.includes('"')) throw new Error("Windows OFXP process test scripts must not contain double quotes")
    return `"${process.execPath}" -e "${script}"`
  }
  return `${shQuote(process.execPath)} -e ${shQuote(script)}`
}

function handleOf(result: OfxpProcessCapability.Result) {
  const handle = result.metadata.handle
  if (typeof handle !== "string") throw new Error("process result did not include a handle")
  return ExchangeProcess.Handle.make(handle)
}

const waitUntil = (predicate: () => Effect.Effect<boolean>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* predicate())) {
      if (Date.now() >= deadline) return false
      yield* Effect.sleep("50 millis")
    }
    return true
  })

function setup(
  peers: OfxpPeer.Interface,
  roots: OfxpRoot.Interface,
  repo: string,
  source: ReturnType<typeof identity>,
  options: { expiresAt?: number } = {},
) {
  return Effect.gen(function* () {
    const trusted = yield* peers.trust({ identity: source.identity })
    const granted = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    return { granted, root }
  })
}

describe("OFXP process capability", () => {
  test("retires an admitted process when a sibling service changes peer authority", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "shared-process-authority.db")
    const repo = path.join(tmp.path, "repo")
    await fs.mkdir(repo, { recursive: true })
    const source = identity("process-sibling-authority")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const contextB = yield* Layer.build(Layer.fresh(processLayer(filename)))
          const contextA = yield* Layer.build(Layer.fresh(peerLayer(filename)))
          const peersB = Context.get(contextB, OfxpPeer.Service)
          const peersA = Context.get(contextA, OfxpPeer.Service)
          const rootsB = Context.get(contextB, OfxpRoot.Service)
          const capabilityB = Context.get(contextB, OfxpProcessCapability.Service)
          const processesB = Context.get(contextB, ExchangeProcess.Service)
          const { granted, root } = yield* setup(peersB, rootsB, repo, source)
          const session = SessionID.descending()
          const request = call(source.key.peerID, session, root.id, {
            action: "start",
            command: nodeCommand("setTimeout(()=>process.exit(0),30000)"),
            mode: "background",
          })
          const started = yield* capabilityB.execute(source.certificate, request)
          const handle = handleOf(started)
          const ownerKey = OfxpPrincipal.key(source.key.peerID, request.context)
          expect((yield* processesB.descriptor(ownerKey, handle))?.running).toBe(true)

          // Mutate through the independent writer, not through the process
          // capability's in-process OfxpPeer service. B must learn this solely
          // from the durable authority generation feed.
          yield* peersA.setGrant({
            peerID: source.key.peerID,
            expectedRevision: granted.info.grantRevision,
            grant: { ...Ofxp.DENY_GRANT },
          })

          expect(
            yield* waitUntil(
              Effect.fnUntraced(function* () {
                return (yield* processesB.descriptor(ownerKey, handle)) === undefined
              }),
              5_000,
            ),
          ).toBe(true)
        }),
      ),
    )
  })

  it.live("starts inside the approved root and deduplicates durable start by InvocationID", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const invocations = yield* OfxpInvocation.Service
    const source = identity("process-start")
    const { root } = yield* setup(peers, roots, repo, source)
    const session = SessionID.descending()
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      session,
      root.id,
      { action: "start", command: nodeCommand("process.stdout.write('alpha\\n')"), mode: "foreground", yieldMs: 5_000 },
      invocationID,
    )

    const first = yield* processCapability.execute(source.certificate, request)
    const handle = handleOf(first)
    expect(first.output).toBe("alpha\n")
    expect(first.metadata.running).toBe(false)
    expect(JSON.stringify(first.metadata)).not.toContain(repo)
    expect(JSON.stringify(first.metadata)).not.toContain('"pid"')

    const duplicate = yield* processCapability.execute(source.certificate, request)
    expect(duplicate.output).toContain("already committed")
    expect(duplicate.metadata.handle).toBe(handle)
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("committed")

    const removeInvocation = Ofxp.InvocationID.create()
    const remove = call(source.key.peerID, session, root.id, { action: "remove", handle }, removeInvocation)
    const removed = yield* processCapability.execute(source.certificate, remove)
    expect(removed.output).toBe(`removed ${handle}`)
    const duplicateRemove = yield* processCapability.execute(source.certificate, remove)
    expect(duplicateRemove.output).toContain("already committed")
    expect((yield* invocations.get(source.key.peerID, removeInvocation)).state).toBe("committed")
  }))

  it.live("isolates handles by source Session and never respawns a committed stale handle", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const processes = yield* ExchangeProcess.Service
    const source = identity("process-isolation")
    const { root } = yield* setup(peers, roots, repo, source)
    const sessionA = SessionID.descending()
    const sessionB = SessionID.descending()
    const invocationID = Ofxp.InvocationID.create()
    const start = call(
      source.key.peerID,
      sessionA,
      root.id,
      { action: "start", command: nodeCommand("setTimeout(()=>process.exit(0),30000)"), mode: "background" },
      invocationID,
    )
    const started = yield* processCapability.execute(source.certificate, start)
    const handle = handleOf(started)

    const denied = yield* processCapability
      .execute(source.certificate, call(source.key.peerID, sessionB, root.id, { action: "status", handle }))
      .pipe(Effect.flip)
    expect(String(denied)).toContain("Unknown or stale process handle")

    const ownerKey = OfxpPrincipal.key(source.key.peerID, start.context)
    expect(yield* processes.retire(ownerKey, handle)).toBe(true)
    expect(yield* processes.descriptor(ownerKey, handle)).toBeUndefined()

    const stale = yield* processCapability.execute(source.certificate, start).pipe(Effect.flip)
    expect(String(stale)).toContain("live-runtime handle is stale")
    expect(yield* processes.descriptor(ownerKey, handle)).toBeUndefined()
  }))

  it.live("protects stdin against replay and bounds retained output", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const source = identity("process-stdin")
    const { root } = yield* setup(peers, roots, repo, source)
    const session = SessionID.descending()

    const interactive = yield* processCapability.execute(
      source.certificate,
      call(source.key.peerID, session, root.id, {
        action: "start",
        command: nodeCommand("process.stdin.once('data',d=>{process.stdout.write(d);setTimeout(()=>process.exit(0),50)})"),
        mode: "background",
      }),
    )
    const handle = handleOf(interactive)
    const writeInvocation = Ofxp.InvocationID.create()
    const write = call(source.key.peerID, session, root.id, { action: "write", handle, chars: "hello\n" }, writeInvocation)
    yield* processCapability.execute(source.certificate, write)
    const duplicate = yield* processCapability.execute(source.certificate, write)
    expect(duplicate.output).toContain("already committed")

    yield* processCapability.execute(
      source.certificate,
      call(source.key.peerID, session, root.id, { action: "wait", handle, timeoutMs: 5_000 }),
    )
    const poll = yield* processCapability.execute(
      source.certificate,
      call(source.key.peerID, session, root.id, { action: "poll", handle, offset: 0, maxBytes: 64 * 1024 }),
    )
    expect(poll.output).toBe("hello\n")

    const noisy = yield* processCapability.execute(
      source.certificate,
      call(source.key.peerID, session, root.id, {
        action: "start",
        command: nodeCommand("process.stdout.write('x'.repeat(300000))"),
        mode: "foreground",
        yieldMs: 5_000,
      }),
    )
    const noisyHandle = handleOf(noisy)
    const noisyPoll = yield* processCapability.execute(
      source.certificate,
      call(source.key.peerID, session, root.id, { action: "poll", handle: noisyHandle, offset: 0, maxBytes: ExchangeProcess.MAX_OUTPUT_BYTES }),
    )
    expect(Buffer.byteLength(noisyPoll.output, "utf8")).toBeLessThanOrEqual(ExchangeProcess.MAX_OUTPUT_BYTES)
    expect(noisyPoll.metadata.truncated).toBe(true)
  }))

  it.live("rejects workdir traversal and actively retires jobs when the approved root changes", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const processes = yield* ExchangeProcess.Service
    const source = identity("process-root")
    const { root } = yield* setup(peers, roots, repo, source)
    const session = SessionID.descending()

    const traversal = yield* processCapability
      .execute(
        source.certificate,
        call(source.key.peerID, session, root.id, {
          action: "start",
          workdir: "../outside",
          command: nodeCommand("process.stdout.write('bad')"),
          mode: "foreground",
        }),
      )
      .pipe(Effect.flip)
    expect(String(traversal)).toContain("path traversal")

    const request = call(source.key.peerID, session, root.id, {
      action: "start",
      command: nodeCommand("setTimeout(()=>process.exit(0),30000)"),
      mode: "background",
    })
    const started = yield* processCapability.execute(source.certificate, request)
    const handle = handleOf(started)
    const ownerKey = OfxpPrincipal.key(source.key.peerID, request.context)
    expect((yield* processes.descriptor(ownerKey, handle))?.running).toBe(true)

    expect(yield* peers.removeRoot({ peerID: source.key.peerID, rootID: root.id })).toBe(true)
    expect(yield* waitUntil(Effect.fnUntraced(function* () {
      return (yield* processes.descriptor(ownerKey, handle)) === undefined
    }))).toBe(true)
  }))

  it.live("retires a live process at grant expiry without a polling loop", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const processes = yield* ExchangeProcess.Service
    const source = identity("process-expiry")
    const { root } = yield* setup(peers, roots, repo, source, { expiresAt: Date.now() + 500 })
    const session = SessionID.descending()
    const request = call(source.key.peerID, session, root.id, {
      action: "start",
      command: nodeCommand("setTimeout(()=>process.exit(0),30000)"),
      mode: "background",
    })
    const started = yield* processCapability.execute(source.certificate, request)
    const handle = handleOf(started)
    const ownerKey = OfxpPrincipal.key(source.key.peerID, request.context)
    expect((yield* processes.descriptor(ownerKey, handle))?.running).toBe(true)

    expect(yield* waitUntil(Effect.fnUntraced(function* () {
      return (yield* processes.descriptor(ownerKey, handle)) === undefined
    }), 6_000)).toBe(true)
  }))
})

