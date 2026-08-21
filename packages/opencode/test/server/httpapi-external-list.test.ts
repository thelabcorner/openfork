import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = {} as Parameters<ReturnType<typeof HttpApiApp.webHandler>["handler"]>[1]

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

type PendingPermission = { id: string; permission: string; patterns: string[] }

async function pendingPermissions(directory: string): Promise<PendingPermission[]> {
  const response = await request("/permission", directory)
  return (await response.json()) as PendingPermission[]
}

async function replyPermission(directory: string, requestID: string, reply: "once" | "always" | "reject") {
  const url = new URL(`http://localhost/permission/${requestID}/reply`)
  const response = await HttpApiApp.webHandler().handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      body: JSON.stringify({ reply }),
    }),
    context,
  )
  expect(response.status).toBe(200)
  await response.body?.cancel()
}

async function waitForExternalAsk(directory: string): Promise<PendingPermission> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = await pendingPermissions(directory)
    const found = pending.find((item) => item.permission === "external_directory")
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("external_directory permission ask never appeared")
}

async function makeExternalTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-external-"))
  await fs.mkdir(path.join(root, "zdir"))
  await fs.writeFile(path.join(root, "afile.txt"), "a")
  await fs.writeFile(path.join(root, "bfile.txt"), "b")
  // Server realpaths the base before listing; compare against the resolved form.
  return fs.realpath(root)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("GET /fs/external-list", () => {
  test("rejects relative and device paths", async () => {
    await using tmp = await tmpdir({ git: true })

    const relative = await request(FilePaths.externalList, tmp.path, {
      path: "src/index.ts",
      sessionID: "ses_test",
    })
    expect(relative.status).toBe(400)

    const device = await request(FilePaths.externalList, tmp.path, {
      path: "\\\\.\\C:\\x",
      sessionID: "ses_test",
    })
    expect(device.status).toBe(400)
  })

  test("lists workspace-internal absolute paths without asking", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "inner.txt"), "x")

    const response = await request(FilePaths.externalList, tmp.path, {
      path: tmp.path,
      sessionID: "ses_test",
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { base: string; entries: Array<{ name: string }> }
    expect(body.entries.map((entry) => entry.name)).toContain("inner.txt")
    expect(await pendingPermissions(tmp.path)).toEqual([])
  })

  test("prompts once, remembers always-grant, sorts dirs first, filters by query", async () => {
    await using tmp = await tmpdir({ git: true })
    const external = await makeExternalTree()

    const first = request(FilePaths.externalList, tmp.path, {
      path: external,
      sessionID: "ses_test",
    })

    const ask = await waitForExternalAsk(tmp.path)
    expect(ask.patterns.length).toBe(1)
    expect(ask.patterns[0]).toMatch(/\*$/)
    await replyPermission(tmp.path, ask.id, "always")

    const listed = (await (await first).json()) as {
      base: string
      entries: Array<{ name: string; type: string }>
    }
    expect(listed.base.toLowerCase()).toBe(external.toLowerCase())
    expect(listed.entries.map((entry) => entry.name)).toEqual(["zdir", "afile.txt", "bfile.txt"])

    const second = await request(FilePaths.externalList, tmp.path, {
      path: external,
      sessionID: "ses_test",
      query: "file",
    })
    expect(second.status).toBe(200)
    const filtered = (await second.json()) as { entries: Array<{ name: string }> }
    expect(filtered.entries.map((entry) => entry.name)).toEqual(["afile.txt", "bfile.txt"])
    expect(await pendingPermissions(tmp.path)).toEqual([])
  })

  test("rejection maps to 403 and does not remember the grant", async () => {
    await using tmp = await tmpdir({ git: true })
    const external = await makeExternalTree()

    const blocked = request(FilePaths.externalList, tmp.path, {
      path: external,
      sessionID: "ses_test",
    })
    const ask = await waitForExternalAsk(tmp.path)
    await replyPermission(tmp.path, ask.id, "reject")

    expect((await blocked).status).toBe(403)

    const again = request(FilePaths.externalList, tmp.path, {
      path: external,
      sessionID: "ses_test",
    })
    const reAsk = await waitForExternalAsk(tmp.path)
    expect(reAsk.id).not.toBe(ask.id)
    await replyPermission(tmp.path, reAsk.id, "reject")
    expect((await again).status).toBe(403)
  })

  test("config deny wins without prompting", async () => {
    const external = await makeExternalTree()
    const glob = path.join(external, "*").replaceAll("\\", "/")
    await using tmp = await tmpdir({
      git: true,
      config: { permission: { external_directory: { [glob]: "deny" } } },
    })

    const response = await request(FilePaths.externalList, tmp.path, {
      path: external,
      sessionID: "ses_test",
    })

    expect(response.status).toBe(403)
    expect(await pendingPermissions(tmp.path)).toEqual([])
  })
})
