import { describe, expect, test } from "bun:test"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "./session-export"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("fetches full transcript from client", async () => {
    const session = { id: "ses_1", title: "Test Session" } as Session
    const msg = { id: "msg_1", role: "user" } as Message
    const part = { id: "prt_1", type: "text", text: "hello" } as Part
    const messages = [{ info: msg, parts: [part] }]

    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: messages }),
      },
    }

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      client,
    })

    expect(result).toEqual({
      info: session,
      messages,
    })
  })

  test("throws when session not found", async () => {
    const client = {
      session: {
        get: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
      },
    }

    expect(
      fetchSessionExport({
        sessionID: "ses_missing",
        client,
      }),
    ).rejects.toThrow("Session not found: ses_missing")
  })
})

describe("downloadSessionExport", () => {
  test("appends .br when compression returns bytes", async () => {
    const name = await downloadSessionExport("session.json", { a: 1 }, async () => new Uint8Array([1, 2, 3]))
    expect(name).toBe("session.json.br")
  })

  test("keeps plain json filename when compressor returns null", async () => {
    const name = await downloadSessionExport("session.json", { a: 1 }, async () => null)
    expect(name).toBe("session.json")
  })

  test("falls back to plain json when compressor rejects", async () => {
    const name = await downloadSessionExport(
      "session.json",
      { a: 1 },
      async () => {
        throw new Error("compressor failed")
      },
    )
    expect(name).toBe("session.json")
  })

  test("works without a compressor (web fallback)", async () => {
    const name = await downloadSessionExport("session.json", { a: 1 })
    expect(name).toBe("session.json")
  })

  test("ignores empty compression output", async () => {
    const name = await downloadSessionExport("session.json", { a: 1 }, async () => new Uint8Array(0))
    expect(name).toBe("session.json")
  })
})
