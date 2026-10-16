import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { Global } from "@opencode-ai/core/global"
import { OxpBrowser } from "@/oxp/browser"
import { OxpConfig } from "@/oxp/config"
import { OxpError } from "@/oxp/error"
import { OxpResult } from "@/oxp/result"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-browser-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const requests: BrowserHostBroker.BrokerRequestInput[] = []
/** Broker-detected post-forward failure injected by the certainty tests. */
let injected: { readonly certainty: BrowserHostBroker.BrowserErrorCertainty; readonly tag: BrowserHostBroker.BrowserErrorTag } | undefined

const injectedFailure = (): Effect.Effect<BrowserHostBroker.BrokerResponse> =>
  Effect.succeed({
    ok: false as const,
    requestId: "browser-uncertain",
    elapsedMs: 1,
    error: {
      tag: injected?.tag ?? "BrowserControlInterrupted",
      message: injected?.tag === "BrowserHostUnavailable" ? "Host transport failure: socket closed" : "Browser control was interrupted",
      // The broker never marks a dispatched_unconfirmed failure retryable.
      retryable: injected?.certainty !== "dispatched_unconfirmed",
      ...(injected === undefined ? {} : { certainty: injected.certainty }),
    },
  })

const brokerLayer = Layer.succeed(
  BrowserHostBroker.Service,
  BrowserHostBroker.Service.of({
    register: () => Effect.die("browser test does not register hosts"),
    dispatch: (request) => {
      requests.push(request)
      if (injected !== undefined) return injectedFailure()
      if (request.operation.name === "status") {
        return Effect.succeed({
          ok: true as const,
          requestId: "browser-status",
          elapsedMs: 1,
          result: {
            status: { connected: false, appearance: "system", recording: { active: false } },
            tabs: [],
          },
        })
      }
      if (request.operation.name === "visual_history") {
        return Effect.succeed({
          ok: true as const,
          requestId: "browser-history",
          elapsedMs: 2,
          result: { history: { root: ".snapeye", baselines: [], runs: [] } },
        })
      }
      return Effect.die(`unexpected browser operation ${request.operation.name}`)
    },
    abort: () => Effect.void,
    pushEvent: () => Effect.void,
    list: () => Effect.succeed([]),
    listTabs: () => Effect.succeed([]),
    assign: () => Effect.die("browser test does not assign tabs"),
    orphanSession: () => Effect.void,
  }),
)

const layer = AppNodeBuilder.build(LayerNode.group([OxpBrowser.node, OxpConfig.node, OxpRoot.node]), [
  [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
  [BrowserHostBroker.node, brokerLayer],
])
const it = testEffect(layer)

beforeEach(async () => {
  requests.length = 0
  injected = undefined
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpBrowser", () => {
  it.live("is default-off and dispatches with an external connector principal rather than a fake Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const browser = yield* OxpBrowser.Service
    yield* config.setEnabled(true)

    const denied = yield* browser.execute({ operation: "status", args: {} }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(requests).toHaveLength(0)

    const granted = yield* config.setGrant({ browser: true })
    const missingParent = yield* browser.execute({ operation: "status", args: {} }).pipe(Effect.flip)
    expect(missingParent._tag).toBe("OXP_AUTH_DENIED")
    expect(requests).toHaveLength(0)

    const result = yield* browser.execute({ operation: "status", args: {} }, "parent-digest-one")
    expect(result.structured).toMatchObject({ status: { connected: false }, tabs: [] })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBeUndefined()
    expect(requests[0]?.messageId).toBeUndefined()
    expect(requests[0]?.principal).toEqual({
      kind: "external",
      principalId: `oxp:${granted.connector.id}:parent-digest-one`,
    })
    expect(requests[0]?.directory).toBeUndefined()
  }))

  it.live("binds SnapEye project operations to an explicit approved root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const browser = yield* OxpBrowser.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ browser: true })

    const result = yield* browser.execute(
      { operation: "visual_history", rootID: root.id, args: {} },
      "parent-digest-one",
    )
    expect(result.structured).toEqual({ history: { root: ".snapeye", baselines: [], runs: [] } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.directory).toBeTruthy()
    expect(path.basename(requests[0]?.directory ?? "")).toBe("workspace")
    expect(requests[0]?.principal?.kind).toBe("external")
  }))
})

// The browser host is an external effect boundary. When the broker cannot
// confirm the outcome of an envelope it already dispatched, a MUTATING OXP
// browser call must land on the existing ambiguous-external-result contract —
// which `OxpResult.projectError` projects as retryable:false — instead of an
// ordinary retryable dependency failure that invites a duplicate mutation.
//
// Certainty only decides WHETHER the failure is ambiguous. It must not be used
// to launder an interruption/supersession into an automatic retry, so the
// retryability of a non-ambiguous failure still follows its error tag.
describe("OxpBrowser dispatch certainty", () => {
  const authorized = Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const browser = yield* OxpBrowser.Service
    yield* config.setEnabled(true)
    yield* config.setGrant({ browser: true })
    return browser
  })

  const failClick = (browser: OxpBrowser.Interface) =>
    browser.execute({ operation: "click", args: { target: { ref: "e1", snapshotVersion: 1 } } }, "parent-digest-one").pipe(
      Effect.flip,
    )

  const failStatus = (browser: OxpBrowser.Interface) =>
    browser.execute({ operation: "status", args: {} }, "parent-digest-one").pipe(Effect.flip)

  it.live("transport loss on a MUTATION becomes ambiguous and non-retryable", () =>
    Effect.gen(function* () {
      const browser = yield* authorized
      injected = { certainty: "dispatched_unconfirmed", tag: "BrowserHostUnavailable" }

      const error = yield* failClick(browser)
      expect(error._tag).toBe("OXP_AMBIGUOUS_EXTERNAL_RESULT")
      // OXP ambiguity is never automatically retryable, and recovery is by
      // inspecting browser state rather than replaying the mutation.
      expect(OxpResult.projectError(error).retryable).toBe(false)
      const detail = OxpError.boundDetail(error.detail)
      expect(detail).toContain("browser.click")
      expect(detail).toContain("before replaying")
    }),
  )

  it.live("transport loss on a READ-ONLY operation stays safely repeatable", () =>
    Effect.gen(function* () {
      const browser = yield* authorized
      injected = { certainty: "dispatched_unconfirmed", tag: "BrowserHostUnavailable" }

      const error = yield* failStatus(browser)
      // status carries no external effect, so the same lost outcome must not be
      // escalated into an ambiguity the caller would refuse to retry.
      expect(error._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
      expect(OxpResult.projectError(error).retryable).toBe(true)
    }),
  )

  it.live("a mid-flight INTERRUPTION of a mutation is ambiguous, and cancellation is never made auto-retryable", () =>
    Effect.gen(function* () {
      const browser = yield* authorized
      injected = { certainty: "dispatched_unconfirmed", tag: "BrowserControlInterrupted" }

      const error = yield* failClick(browser)
      expect(error._tag).toBe("OXP_AMBIGUOUS_EXTERNAL_RESULT")
      expect(OxpResult.projectError(error).retryable).toBe(false)

      // The same interruption on a READ-ONLY op stays a cancellation, and the
      // non-ambiguous path must NOT convert that into an automatic retry.
      const readOnly = yield* failStatus(browser)
      expect(readOnly._tag).toBe("OXP_CANCELLED")
      expect(OxpResult.projectError(readOnly).retryable).toBe(false)
    }),
  )

  it.live("a provably pre-dispatch failure is never escalated to ambiguity", () =>
    Effect.gen(function* () {
      const browser = yield* authorized
      injected = { certainty: "not_dispatched", tag: "BrowserHostUnavailable" }

      const error = yield* failClick(browser)
      // Nothing reached the host, so the ordinary retryable dependency failure
      // is correct and no inspect-before-replay ceremony is warranted.
      expect(error._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
      expect(OxpResult.projectError(error).retryable).toBe(true)
    }),
  )
})
