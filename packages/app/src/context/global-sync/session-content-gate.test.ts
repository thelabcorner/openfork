import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { applyDirectoryEvent } from "./event-reducer"
import type { State } from "./types"

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

const part = (id: string, messageID: string, sessionID = "ses_1") =>
  ({ id, messageID, sessionID, type: "text", text: "" }) as State["part"][string][number]

// Both production call sites (server-sync.tsx:630 and :749) pass
// `sessionContent: false`, because per-delta session content is reduced into the
// shared session store (server-session.ts) instead. This locks that in: the
// global-sync child store must NOT accumulate streaming text, or every token
// would pay for a second reactive projection that nothing renders.
describe("applyDirectoryEvent session-content gate", () => {
  const contentEvents: { type: string; properties: unknown }[] = [
    { type: "message.part.delta", properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" } },
    { type: "message.part.updated", properties: { part: part("prt_1", "msg_1") } },
    { type: "message.updated", properties: { info: { id: "msg_1", sessionID: "ses_1" } } },
    { type: "message.part.removed", properties: { messageID: "msg_1", partID: "prt_1" } },
    { type: "todo.updated", properties: { sessionID: "ses_1", todos: [{ id: "t", content: "x", status: "pending" }] } },
    { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
    { type: "session.diff", properties: { sessionID: "ses_1", diff: [] } },
  ]

  test("sessionContent:false writes no session content at all", () => {
    const [store, setStore] = createStore(
      baseState({ part: { msg_1: [part("prt_1", "msg_1")] }, message: { ses_1: [] } }),
    )

    for (const event of contentEvents) {
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
        sessionContent: false,
      })
    }

    expect(store.part.msg_1).toEqual([part("prt_1", "msg_1")])
    expect(store.part_text_accum_delta).toEqual({})
    expect(store.todo).toEqual({})
    expect(store.session_status).toEqual({})
    expect(store.session_diff).toEqual({})
  })

  test("the gate is what suppresses it, not the event shape", () => {
    const [store, setStore] = createStore(baseState({ part: { msg_1: [part("prt_1", "msg_1")] } }))

    applyDirectoryEvent({
      event: {
        type: "message.part.delta",
        properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect((store.part.msg_1?.[0] as { text: string }).text).toBe("hello")
    expect(store.part_text_accum_delta.prt_1).toBe("hello")
  })
})
