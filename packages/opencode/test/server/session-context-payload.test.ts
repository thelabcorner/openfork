import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { Schema } from "effect"
import { ContextOpsPayload, CONTEXT_OPS_MAX_BATCH } from "@/server/routes/instance/httpapi/groups/session-context"
import {
  MAX_CONTEXT_REPLACEMENT_BYTES,
  MAX_CONTEXT_BATCH_TEXT_BYTES,
  withinContextPayloadBudget,
} from "@/session/context/admission-budget"

const decode = Schema.decodeUnknownSync(ContextOpsPayload)

describe("Context mutation request admission", () => {
  test("caps total UTF-8 event payload bytes, not only operation count or UTF-16 length", () => {
    const edit = (content: string) => ({ type: "text.replace", messageID: "msg_budget", content })
    expect(withinContextPayloadBudget([edit("a".repeat(4096))])).toBe(true)
    expect(withinContextPayloadBudget([edit("x".repeat(MAX_CONTEXT_REPLACEMENT_BYTES))])).toBe(true)
    expect(withinContextPayloadBudget([edit("x".repeat(MAX_CONTEXT_REPLACEMENT_BYTES + 1))])).toBe(false)
    // U+1F600 is two UTF-16 code units but four UTF-8 bytes; equality at the
    // byte boundary must remain deterministic on Windows and other platforms.
    expect(withinContextPayloadBudget([edit("😀".repeat(MAX_CONTEXT_REPLACEMENT_BYTES / 4))])).toBe(true)
    expect(withinContextPayloadBudget([edit("😀".repeat(MAX_CONTEXT_REPLACEMENT_BYTES / 4 + 1))])).toBe(false)
    const balanced = "z".repeat(MAX_CONTEXT_REPLACEMENT_BYTES)
    expect(withinContextPayloadBudget([edit(balanced), edit(balanced)])).toBe(true)
    expect(MAX_CONTEXT_BATCH_TEXT_BYTES).toBe(MAX_CONTEXT_REPLACEMENT_BYTES * 2)
    expect(withinContextPayloadBudget([edit(balanced), edit(balanced), edit("extra")])).toBe(false)
    expect(withinContextPayloadBudget([{ type: "message.pin" }, edit("ok")])).toBe(true)
    expect(withinContextPayloadBudget([{ type: "text.replace" }])).toBe(false)
  })

  test("durable Context routes never acquire an execution Instance", async () => {
    const group = await readFile(new URL("../../src/server/routes/instance/httpapi/groups/session-context.ts", import.meta.url), "utf8")
    const handler = await readFile(new URL("../../src/server/routes/instance/httpapi/handlers/session-context.ts", import.meta.url), "utf8")
    const domain = await readFile(new URL("../../src/session/context/inspection.ts", import.meta.url), "utf8")
    expect(group).toContain(".middleware(WorkspaceRoutingMiddleware)")
    expect(group).toContain(".middleware(Authorization)")
    expect(group).not.toContain("InstanceContextMiddleware")
    expect(handler).not.toContain("InstanceStore")
    expect(handler).not.toContain("InstanceRef")
    expect(handler).not.toContain("session.get(")
    expect(handler).toContain("SessionTable.metadata")
    expect(domain).not.toContain("InstanceStore")
    expect(domain).toContain("reader.transaction")
    expect(domain).toContain("scanDb()")
  })
  test("allows ordinary and maximum supported batches", () => {
    expect(decode({ operations: [] }).operations).toHaveLength(0)
    expect(decode({ operations: [{ type: "message.include", messageID: "msg_batch_1" }] }).operations).toHaveLength(1)
    const operations = Array.from({ length: CONTEXT_OPS_MAX_BATCH }, (_, i) => ({
      type: "message.pin",
      messageID: `msg_batch_${i}`,
    }))
    expect(decode({ operations }).operations).toHaveLength(CONTEXT_OPS_MAX_BATCH)
  })

  test("rejects oversized operation arrays before any SQL reads or events", () => {
    const operations = Array.from({ length: CONTEXT_OPS_MAX_BATCH + 1 }, (_, i) => ({
      type: "message.pin",
      messageID: `msg_batch_${i}`,
    }))
    expect(() => decode({ operations })).toThrow()
  })
})
