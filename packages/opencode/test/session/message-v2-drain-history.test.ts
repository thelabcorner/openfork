import { expect, test } from "bun:test"
import { Effect } from "effect"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

test("V1 drain history reads legacy history once and applies committed message events in memory", async () => {
  const sessionID = SessionID.make("ses_drain_projection")
  const messageID = MessageID.make("msg_drain_projection")
  const partID = PartID.make("prt_drain_projection")
  const messages = [
    {
      id: messageID,
      session_id: sessionID,
      time_created: 1,
      data: {
        role: "user",
        time: { created: 1 },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      },
    },
  ]
  const parts = [
    {
      id: partID,
      session_id: sessionID,
      message_id: messageID,
      time_created: 1,
      data: { type: "text", text: "before" },
    },
  ]
  const reads = { messages: 0, parts: 0 }
  let sequence = 0
  let subscriber: ((event: any) => Effect.Effect<void>) | undefined
  const tx: any = {
    select: () => {
      let table: unknown
      const query: any = {
        from: (value: unknown) => {
          table = value
          return query
        },
        where: () => query,
        orderBy: () => query,
        all: () => {
          if (table === MessageTable) {
            reads.messages++
            return Effect.succeed(messages.slice())
          }
          if (table === PartTable) {
            reads.parts++
            return Effect.succeed(parts.slice())
          }
          throw new Error("Unexpected V1 history query")
        },
        get: () => Effect.succeed(table === EventSequenceTable ? { seq: sequence } : undefined),
      }
      return query
    },
  }
  tx.transaction = (fn: (database: unknown) => Effect.Effect<unknown>) => fn(tx)
  const events = {
    listenAggregate: (_aggregateID: string, listener: (event: any) => Effect.Effect<void>) =>
      Effect.sync(() => {
        subscriber = listener
        return Effect.sync(() => {
          subscriber = undefined
        })
      }),
  } as any
  const projection = await Effect.runPromise(
    MessageV2.makeDrainHistory({ sessionID, db: tx, events }),
  )
  const emit = async (type: string, data: unknown, seq: number) => {
    sequence = seq
    await Effect.runPromise(
      subscriber!({
        type,
        data,
        durable: { aggregateID: sessionID, seq, version: 1 },
      }),
    )
  }

  const initial = await Effect.runPromise(projection.history())
  expect(await Effect.runPromise(projection.history())).toBe(initial)
  const initialPart = initial[0]?.parts[0]
  expect(initialPart?.type).toBe("text")
  if (initialPart?.type === "text") expect(initialPart.text).toBe("before")
  expect(reads).toEqual({ messages: 1, parts: 1 })

  const updatedPart = (text: string) => ({
    sessionID,
    time: 2,
    part: { id: partID, sessionID, messageID, type: "text", text },
  })
  await emit(SessionV1.Event.PartUpdated.type, updatedPart("after"), 1)
  await emit(SessionV1.Event.PartUpdated.type, updatedPart("final"), 3)
  await emit(SessionV1.Event.PartUpdated.type, updatedPart("middle"), 2)
  for (let index = 0; index < 5; index++) {
    const current = await Effect.runPromise(projection.history())
    if (index === 0) expect(current).not.toBe(initial)
    else expect(current).toBe(await Effect.runPromise(projection.history()))
    const currentPart = current[0]?.parts[0]
    expect(currentPart?.type).toBe("text")
    if (currentPart?.type === "text") expect(currentPart.text).toBe("final")
  }
  expect(reads).toEqual({ messages: 1, parts: 1 })

  await emit(SessionV1.Event.PartRemoved.type, { sessionID, messageID, partID }, 4)
  expect((await Effect.runPromise(projection.history()))[0]?.parts).toEqual([])
  await emit(SessionV1.Event.MessageRemoved.type, { sessionID, messageID }, 5)
  expect(await Effect.runPromise(projection.history())).toEqual([])
  expect(reads).toEqual({ messages: 1, parts: 1 })

  await emit(SessionEvent.Prompted.type, { sessionID }, 6)
  expect((await Effect.runPromise(projection.history())).map((message) => message.info.id)).toEqual([messageID])
  expect(reads).toEqual({ messages: 2, parts: 2 })

  await emit("test.sequence_gap", { sessionID }, 8)
  expect((await Effect.runPromise(projection.history())).map((message) => message.info.id)).toEqual([messageID])
  expect(reads).toEqual({ messages: 3, parts: 3 })

  await Effect.runPromise(projection.close)
  expect(subscriber).toBeUndefined()
})

test("V1 drain part snapshot uses a bounded session predicate for long transcripts", async () => {
  const sessionID = SessionID.make("ses_drain_many")
  const messages = Array.from({ length: 1_500 }, (_, index) => {
    const id = MessageID.make(`msg_drain_many_${index}`)
    return {
      id,
      session_id: sessionID,
      time_created: index + 1,
      data: {
        role: "user",
        time: { created: index + 1 },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      },
    }
  })
  const parts = messages.map((message, index) => ({
    id: PartID.make(`prt_drain_many_${index}`),
    session_id: sessionID,
    message_id: message.id,
    time_created: index + 1,
    data: { type: "text", text: `part-${index}` },
  }))
  const predicates: Array<{ table: unknown; value: any }> = []
  let sequence = 0
  const tx: any = {
    select: () => {
      let table: unknown
      let predicate: unknown
      const query: any = {
        from: (value: unknown) => { table = value; return query },
        where: (value: unknown) => { predicate = value; predicates.push({ table, value }); return query },
        orderBy: () => query,
        all: () => Effect.succeed(table === MessageTable ? messages : table === PartTable ? parts : []),
        get: () => Effect.succeed(table === EventSequenceTable ? { seq: sequence } : undefined),
      }
      return query
    },
  }
  tx.transaction = (fn: (database: unknown) => Effect.Effect<unknown>) => fn(tx)
  const events = { listenAggregate: () => Effect.succeed(Effect.void) } as any
  const projection = await Effect.runPromise(MessageV2.makeDrainHistory({ sessionID, db: tx, events }))
  const history = await Effect.runPromise(projection.history())
  expect(history).toHaveLength(messages.length)
  const lastPart = history[0]?.parts[0]
  expect(lastPart?.type).toBe("text")
  if (lastPart?.type === "text") expect(lastPart.text).toBe("part-1499")
  const partPredicate = predicates.find((entry) => entry.table === PartTable)?.value
  expect(partPredicate?.queryChunks).toContain(PartTable.session_id)
  expect(partPredicate?.queryChunks).not.toContain(PartTable.message_id)
  await Effect.runPromise(projection.close)
})
