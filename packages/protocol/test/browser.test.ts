import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Workspace } from "@opencode-ai/schema/workspace"
import {
  A11yNode,
  BrokerError,
  BrokerRequest,
  BrokerResponse,
  BrowserErrorTag,
  BrowserOperation,
  ClickInput,
  ElementTarget,
  HostRegistration,
  HostHelloReply,
  QueryInput,
  SnapshotOutput,
} from "../src/groups/browser"

// Suspended schemas (A11yNode, and anything containing it) have a non-statically-
// never DecodingServices; the cast only erases that type-level artifact, runtime
// decoding is unchanged.
const decode = async <A>(schema: Schema.Schema<A>, input: unknown): Promise<A> =>
  (await Effect.runPromise(Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown, never>)(input))) as A

const decodeFails = async (schema: Schema.Schema<unknown>, input: unknown) => {
  await expect(decode(schema, input)).rejects.toThrow()
}

describe("browser wire: HostRegistration", () => {
  test("accepts a valid registration with session identity and callback reachability", async () => {
    const registration = {
      protocolVersion: 1,
      hostId: "host-1",
      hostEpoch: 3,
      connectionId: "conn-1",
      windowId: "win-1",
      capabilities: {
        maxSnapshotBytes: 1_000_000,
        maxResultBytes: 256_000,
        supportedAppearances: ["system", "light", "dark"],
        supportsRecording: true,
        cdp: true,
      },
      guest: { attached: true, activeTabId: "tab_1", url: "https://example.com" },
      sessionId: Session.ID.make("ses_test"),
      workspaceId: Workspace.ID.make("wrk_1"),
      callbackUrl: "http://127.0.0.1:54123",
      callbackToken: "secret",
    }
    const decoded = await decode(HostRegistration, registration)
    expect(decoded.sessionId).toBe(Session.ID.make("ses_test"))
    expect(decoded.protocolVersion).toBe(1)
    expect(decoded.callbackToken).toBe("secret")
  })

  test("rejects a registration missing session identity", async () => {
    const missing = {
      protocolVersion: 1,
      hostId: "host-1",
      hostEpoch: 0,
      connectionId: "conn-1",
      windowId: "win-1",
      capabilities: {
        maxSnapshotBytes: 1_000_000,
        maxResultBytes: 256_000,
        supportedAppearances: ["system", "light", "dark"],
        supportsRecording: false,
        cdp: true,
      },
      guest: { attached: false, activeTabId: null, url: null },
      callbackUrl: "http://127.0.0.1:54123",
      callbackToken: "secret",
    }
    await decodeFails(HostRegistration, missing)
  })
})

describe("browser wire: HostHelloReply", () => {
  test("round trips the accepted reply", async () => {
    const reply = { data: { accepted: true, brokerProtocolVersion: 1, hostId: "host-1", replacement: true } }
    const decoded = await decode(HostHelloReply, reply)
    expect(decoded).toEqual(reply)
  })
})

describe("browser wire: BrokerRequest", () => {
  test("round trips a ref-targeted click request", async () => {
    const request = {
      requestId: "req-1",
      sessionId: Session.ID.make("ses_test"),
      windowId: "win-1",
      workspaceId: Workspace.ID.make("wrk_1"),
      messageId: SessionMessage.ID.make("msg_1"),
      toolCallId: "call-1",
      tabId: "tab_1",
      operation: {
        name: "click",
        input: { target: { ref: "e7", snapshotVersion: 4 }, button: "left", clickCount: 1, scrollIntoView: true },
      },
      timeoutMs: 30_000,
    }
    const decoded = await decode(BrokerRequest, request)
    expect(decoded.operation.name).toBe("click")
    expect(decoded.operation.input).toEqual({
      target: { ref: "e7", snapshotVersion: 4 },
      button: "left",
      clickCount: 1,
      scrollIntoView: true,
    })
  })

  test("operation discriminator is `name` (canonical wire)", async () => {
    const tagged = {
      name: "open",
      input: { url: "https://example.com", newTab: false },
    } as const
    const decoded = await decode(BrowserOperation, tagged)
    expect(decoded).toEqual(tagged)
  })

  test("rejects an operation with an unknown name", async () => {
    await decodeFails(BrowserOperation, { name: "fly_to_the_moon", input: {} })
  })
})

describe("browser wire: premium targeting", () => {
  test("RefTarget is the primary element target", async () => {
    const ref = { ref: "e12", snapshotVersion: 2 }
    const decoded = await decode(ElementTarget, ref)
    expect(decoded).toEqual(ref)
  })

  test("Locator and Coords remain valid element targets", async () => {
    const locator = { type: "css", value: "#submit", exact: true } as const
    const coords = { x: 12, y: 34 }
    expect(await decode(ElementTarget, locator)).toEqual(locator)
    expect(await decode(ElementTarget, coords)).toEqual(coords)
  })

  test("click input accepts ref, locator, or coords targets", async () => {
    for (const target of [
      { ref: "e1", snapshotVersion: 1 },
      { type: "text", value: "Submit" },
      { x: 0, y: 0 },
    ] as const) {
      await expect(decode(ClickInput, { target })).resolves.toBeDefined()
    }
  })

  test("stale refs are rejected when snapshotVersion is missing", async () => {
    await decodeFails(ElementTarget, { ref: "e1" })
  })
})

describe("browser wire: premium query + snapshot", () => {
  test("QueryInput requires a locator", async () => {
    const decoded = await decode(QueryInput, { target: { type: "css", value: "button" } })
    expect(decoded.maxResults).toBeUndefined()
  })

  test("SnapshotOutput carries snapshotVersion and versioned elements", async () => {
    const output = {
      snapshot: {
        tabId: "tab_1",
        url: "https://example.com",
        snapshotVersion: 4,
        tree: [
          {
            role: "button",
            name: "Submit",
            states: [],
            target: { locator: { type: "text", value: "Submit" }, rect: { x: 0, y: 0, width: 10, height: 10 } },
            children: [],
          },
        ],
        elements: [
          {
            ref: "e7",
            role: "button",
            name: "Submit",
            selector: { kind: "role-name", value: "button:Submit", confidence: "high" },
            rect: { x: 0, y: 0, width: 10, height: 10 },
            center: { x: 5, y: 5 },
            state: { visible: true, enabled: true, checked: false, focused: false, readonly: false },
          },
        ],
        text: "Submit",
        truncated: false,
        count: 1,
        viewport: { width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0 },
      },
    }
    const decoded = await decode(SnapshotOutput, output)
    expect(decoded.snapshot.snapshotVersion).toBe(4)
    expect(decoded.snapshot.elements[0]?.ref).toBe("e7")
    expect(decoded.snapshot.elements[0]?.selector.confidence).toBe("high")
  })
})

describe("browser wire: error taxonomy + broker response", () => {
  test("premium error tags are part of the taxonomy", () => {
    const tags = BrowserErrorTag.literals as readonly string[]
    expect(tags).toContain("BrowserStaleRefError")
    expect(tags).toContain("BrowserNotAReactAppError")
  })

  test("BrokerError round trips with premium tags", async () => {
    const stale = { tag: "BrowserStaleRefError", message: "stale ref", retryable: true } as const
    expect(await decode(BrokerError, stale)).toEqual(stale)
    const notReact = { tag: "BrowserNotAReactAppError", message: "not react", retryable: false } as const
    expect(await decode(BrokerError, notReact)).toEqual(notReact)
  })

  test("BrokerResponse ok arm round trips", async () => {
    const ok = {
      ok: true,
      requestId: "req-1",
      result: { status: { connected: true } },
      elapsedMs: 12,
      snapshotAfter: { tabId: "tab_1", url: "https://example.com", title: "Example", readyState: "Success" },
    } as const
    expect(await decode(BrokerResponse, ok)).toEqual(ok)
  })

  test("BrokerResponse error arm round trips", async () => {
    const err = {
      ok: false,
      requestId: "req-1",
      error: { tag: "BrowserHostUnavailable", message: "no host", retryable: true },
      elapsedMs: 3,
    } as const
    expect(await decode(BrokerResponse, err)).toEqual(err)
  })

  test("A11yNode is recursive and decodes nested children", async () => {
    const tree = {
      role: "main",
      name: "",
      states: [],
      children: [
        {
          role: "button",
          name: "Go",
          states: [],
          target: { locator: { type: "text", value: "Go" }, rect: { x: 1, y: 1, width: 2, height: 2 } },
          children: [],
        },
      ],
    }
    const decoded = await decode(A11yNode, tree)
    expect(decoded.children).toHaveLength(1)
  })
})
