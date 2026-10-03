import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OxpSurface } from "@/oxp/surface"

const src = path.resolve(import.meta.dir, "../../src")

describe("OXP Gate L file-exchange architecture boundary", () => {
  test("exposes a narrow parent-safe OpenAI Files adapter while retaining the file-exchange owner", async () => {
    const direct = OxpSurface.TOOLS.find((tool) => tool.name === "openai_files")
    expect(direct).toBeDefined()
    expect(JSON.stringify(direct?.inputSchema)).not.toMatch(
      /credential|secret|token|authorization|header|origin/i,
    )
    const capability = await fs.readFile(path.join(src, "oxp/capability.ts"), "utf8")
    expect(capability).toContain('"file.transfer"')
    expect(capability).toContain("OxpFileExchange.ChatGptParameters")
    const server = await fs.readFile(path.join(src, "oxp/server.ts"), "utf8")
    expect(server).toContain('name === "openai_files"')
    expect(server).toContain("fileExchange.execute(OxpFileExchange.openAiInput(input), signal)")
  })

  test("projects ChatGPT native file inputs through the host fileParams contract", () => {
    const broker = OxpSurface.TOOLS.find((tool) => tool.name === "capability")
    expect(broker).toBeDefined()
    expect(broker?._meta?.["openai/fileParams"]).toEqual(["source_file"])
    const schema = JSON.stringify(broker?.inputSchema)
    for (const field of ["download_url", "file_id", "mime_type", "file_name"]) expect(schema).toContain(`"${field}"`)
    expect(schema).toContain('"required":["download_url","file_id"]')
  })

  test("does not expose authenticated OpenAI Files actions through the generic broker schema", async () => {
    const source = await fs.readFile(path.join(src, "oxp/file-exchange.ts"), "utf8")
    const receiveSchema = source.slice(source.indexOf("export const ChatGptParameters"), source.indexOf("export type ChatGptInput"))
    expect(receiveSchema).toContain('Schema.Literal("save_chatgpt_file")')
    expect(receiveSchema).not.toMatch(/list|upload|download|get_openai/i)
  })

  test("keeps receive/send authority separate and root-bound", async () => {
    const source = await fs.readFile(path.join(src, "oxp/file-exchange.ts"), "utf8")
    expect(source).toContain('operation: "file.receive"')
    expect(source).toContain('operation: "file.send"')
    expect(source).toContain("rootID: input.rootID")
    expect(source).toContain("allowMissing: true")
    expect(source).toContain('authority.revalidate(admission, "network")')
    expect(source).toContain('authority.revalidate(admission, "commit")')
  })

  test("uses the shared OXP OpenAI credential and never provider/model credentials", async () => {
    const [exchange, host] = await Promise.all([
      fs.readFile(path.join(src, "oxp/file-exchange.ts"), "utf8"),
      fs.readFile(path.join(src, "oxp/host.ts"), "utf8"),
    ])
    expect(exchange).toContain("OPENCODE_OXP_OPENAI_API_KEY")
    expect(host).toContain("setOpenAiApiKey")
    expect(exchange).not.toMatch(/Provider|providerID|accountID|Auth\.get|model/)
  })

  test("preserves no-overwrite, no-follow, bounded-transfer, and atomic publication rules", async () => {
    const source = await fs.readFile(path.join(src, "oxp/file-exchange.ts"), "utf8")
    expect(source).toContain("O_NOFOLLOW")
    expect(source).toContain("O_EXCL")
    expect(source).toContain("512 * 1024 * 1024")
    expect(source).toContain("fs.link(partial, destination)")
    expect(source).toContain("assertNoSymlinkComponents(parent)")
    expect(source).toContain("fs.lstat(destination)")
    expect(source).toContain("published.ino !== staged.ino")
    expect(source).toContain("Destination already exists; file exchange never overwrites files")
  })

  test("accepts only native ChatGPT file references from pinned HTTPS hosts", async () => {
    const source = await fs.readFile(path.join(src, "oxp/file-exchange.ts"), "utf8")
    expect(source).toContain("files.oaiusercontent.com")
    expect(source).toContain("oaidalleapiprodscus.blob.core.windows.net")
    expect(source).toContain("oaisdmntprcentralus.blob.core.windows.net")
    expect(source).toContain('url.protocol !== "https:"')
    expect(source).toContain("source_file must be supplied by ChatGPT; never invent it")
  })
})
