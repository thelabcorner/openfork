import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { OxpError } from "@/oxp/error"
import { OxpWorker } from "@/oxp/worker"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { OxpWorkerControlV1 } from "@/oxp/worker-control-v1"
import { Provider } from "@/provider/provider"
import { DelegatedWorker } from "@/session/delegated-worker"
import { SessionGroup } from "@/session/group"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { testEffect } from "../lib/effect"

const WORKER_ID = SessionID.make("ses_delegated_worker_terminal")

const ORIGIN = {
  producer: "oxp",
  principalRef: "oxp:test-connector",
  invocationRef: "oxp-inv:test",
  rootRef: "root_test",
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
  nestedDelegation: false,
} as const

const identity = {
  producer: "oxp",
  principalRef: ORIGIN.principalRef,
} as const

const workerSession = {
  id: WORKER_ID,
  title: "Delegated worker",
  metadata: SessionMetadataOwnership.delegatedWorker(ORIGIN),
}

const layers = Layer.mergeAll(
  Layer.mock(Agent.Service, {
    list: () =>
      Effect.succeed([{ name: "build", hidden: false, permission: [] } as any]),
  }),
  Layer.mock(Provider.Service, {
    resolveAccountID: (_providerID, accountID) => Effect.succeed(accountID),
    getModel: () =>
      Effect.succeed({
        id: "test-model",
        providerID: "test",
        name: "Test Model",
        family: "test",
      } as any),
  }),
  Layer.mock(Session.Service, {
    get: () => Effect.succeed(workerSession as any),
    create: () => Effect.succeed(workerSession as any),
    messages: () =>
      Effect.succeed([
        {
          info: { id: "msg_terminal", role: "user", time: { created: 1 } },
          parts: [],
        } as any,
      ]),
  }),
  Layer.mock(SessionPrompt.Service, {
    hostPrompt: () =>
      Effect.succeed({
        info: { id: "msg_terminal", role: "user", time: { created: 1 } },
        parts: [],
      } as any),
    loop: () => Effect.never,
    cancel: () => Effect.void,
  }),
  Layer.effect(BackgroundJob.Service, CoreBackgroundJob.make),
  Layer.mock(SessionExecutionOwner.Service, {
    snapshot: (sessionID) => Effect.succeed({ sessionID, generation: 0 }),
  }),
)

const it = testEffect(layers)

describe("delegated worker terminal state", () => {
  it.live("cancel stays terminal for wait and result", () =>
    Effect.gen(function* () {
      const worker = yield* DelegatedWorker.make
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })

      const running = yield* worker.snapshot(session.id, identity)
      expect(running.state).toBe("running")

      const cancelled = yield* worker.cancel({
        sessionID: session.id,
        identity,
      })
      expect(cancelled.state).toBe("cancelled")

      const waited = yield* worker.wait({
        sessionID: session.id,
        identity,
        timeout: 1_000,
      })
      expect(waited.state).toBe("cancelled")

      const result = yield* worker.result({
        sessionID: session.id,
        identity,
      })
      expect(result.state).toBe("cancelled")
    }),
  )
})

const runtime = { DelegatedWorker, SessionGroup, SessionID }

function expectSelectionUnavailable(
  error: Error,
): OxpWorkerControl.SelectionUnavailable {
  if (!(error instanceof OxpWorkerControl.SelectionUnavailable)) {
    throw new Error("expected OxpDelegatedWorkerSelectionUnavailable")
  }
  return error
}

describe("delegated worker selection taxonomy", () => {
  test("model-only mismatch is not classified as a provider-account failure", () => {
    const mapped = OxpWorkerControlV1.mapWorkerError(
      runtime,
      new DelegatedWorker.SelectionMismatch(
        "Delegated worker is bound to a different model/account selection",
      ),
    )
    expect(mapped).toBeInstanceOf(OxpWorkerControl.SelectionUnavailable)
    expect(expectSelectionUnavailable(mapped).explicitAccount).toBe(false)
    expect(OxpWorker.mapControlError(mapped)).toBeInstanceOf(
      OxpError.InvalidArgument,
    )
  })

  test("explicit-account selection failure stays account-scoped", () => {
    const mapped = OxpWorkerControlV1.mapWorkerError(
      runtime,
      new DelegatedWorker.SelectionMismatch(
        "Requested delegated-worker provider account/model is unavailable",
        true,
      ),
    )
    expect(expectSelectionUnavailable(mapped).explicitAccount).toBe(true)
    const oxp = OxpWorker.mapControlError(mapped, "acct_1")
    expect(oxp).toBeInstanceOf(OxpError.ProviderAccountUnavailable)
    expect(oxp.metadata).toMatchObject({ accountID: "acct_1" })
  })
})

describe("delegated worker committed detail", () => {
  test("partial batch failure surfaces the member cause message", () => {
    const mapped = OxpWorker.mapControlError(
      new OxpWorkerControl.BatchCommitted(
        ["w1"],
        undefined,
        undefined,
        new Error("Delegated worker is owned by another live background-job type"),
      ),
    )
    expect(mapped).toBeInstanceOf(OxpError.DependencyUnavailable)
    expect(mapped.detail).toContain("another live background-job type")
    expect(mapped.metadata).toMatchObject({
      committed: true,
      workersCommitted: 1,
      workerID0: "w1",
    })
  })

  test("dependency causes keep the stable dependency detail", () => {
    const mapped = OxpWorker.mapControlError(
      new OxpWorkerControl.BatchCommitted(
        ["w1"],
        undefined,
        undefined,
        new Error("Service not found: WorkspaceRoutingMiddleware"),
      ),
    )
    expect(mapped.detail).toContain("WorkspaceRoutingMiddleware")
  })
})
