import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OxpSurface } from "@/oxp/surface"

const opencode = path.resolve(import.meta.dir, "../../src")
const core = path.resolve(import.meta.dir, "../../../core/src")

describe("OXP Gate J delegation architecture boundary", () => {
  test("keeps delegated-worker discovery at one bootstrap-free Core owner", async () => {
    const [delegation, inspection] = await Promise.all([
      fs.readFile(
        path.join(core, "session/delegation-inspection.ts"),
        "utf8",
      ),
      fs.readFile(path.join(core, "session/inspection.ts"), "utf8"),
    ])

    expect(delegation).toContain("deps: [Database.node]")
    expect(delegation).toContain("SessionExecutionOwnerTable")
    expect(delegation).toContain("workerDelegation")
    expect(delegation).not.toMatch(
      /InstanceStore|LocationServiceMap|SessionPrompt|BackgroundJob|Provider|Plugin|Tool\.Context|process\.cwd/,
    )
    expect(inspection).not.toMatch(
      /delegatedWorker|delegatedWorkers|SessionExecutionOwnerTable/,
    )
  })

  test("keeps the OXP worker domain above an abstract runtime-control port", async () => {
    const source = await fs.readFile(path.join(opencode, "oxp/worker.ts"), "utf8")

    expect(source).toContain(
      'from "@opencode-ai/core/session/delegation-inspection"',
    )
    expect(source).toContain('from "./worker-control"')
    expect(source).not.toMatch(
      /@\/effect\/app-runtime|@\/project\/instance-store|@\/session\/prompt|@\/background\/job|@\/tool\/task|Tool\.Context|SessionPrompt|BackgroundJob|InstanceStore/,
    )
  })

  test("loads the Tier-3 worker adapter and native worker owners lazily", async () => {
    const [adapter, shim, runtime] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/worker-control-v1.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/runtime-v1.ts"), "utf8"),
      fs.readFile(path.join(opencode, "exchange/runtime-v1.ts"), "utf8"),
    ])

    expect(adapter).toContain('import("@/session/delegated-worker")')
    expect(adapter).toContain('import("@/session/group")')
    expect(adapter).toContain("OxpRuntimeV1.enter")
    expect(adapter).not.toMatch(
      /import\s+\{[^}]*DelegatedWorker[^}]*\}\s+from|import\s+\{[^}]*SessionGroup[^}]*\}\s+from/,
    )
    expect(shim).toContain('from "@/exchange/runtime-v1"')
    expect(runtime).toContain('import("@/effect/app-runtime")')
    expect(runtime).toContain('import("@/project/instance-store")')
    expect(runtime).not.toMatch(
      /import\s+\{[^}]*AppRuntime[^}]*\}\s+from|import\s+\{[^}]*InstanceStore[^}]*\}\s+from/,
    )
  })

  test("creates real worker Sessions without manufacturing a ChatGPT parent Session", async () => {
    const [domain, worker] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/worker.ts"), "utf8"),
      fs.readFile(path.join(opencode, "session/delegated-worker.ts"), "utf8"),
    ])

    expect(domain).not.toMatch(/sessions?\.create\(|parentID|Tool\.Context/)
    expect(worker).toContain("sessions.create({")
    expect(worker).toContain(
      "metadata: SessionMetadataOwnership.delegatedWorker(input.origin)",
    )
    expect(worker).not.toMatch(/parentID\s*:/)
  })

  test("uses SessionID as the durable worker handle and BackgroundJob only as local execution state", async () => {
    const [worker, adapter] = await Promise.all([
      fs.readFile(path.join(opencode, "session/delegated-worker.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/worker-control-v1.ts"), "utf8"),
    ])

    expect(worker).toContain("id: session.id")
    expect(worker).toContain("sessionID: session.id")
    expect(adapter).toContain("workerID: String(session.id)")
    expect(adapter).not.toMatch(/workerID:\s*(?:job|attempt)\./)
  })

  test("reconstructs restart-visible state from durable Session history plus SessionExecutionOwner", async () => {
    const worker = await fs.readFile(
      path.join(opencode, "session/delegated-worker.ts"),
      "utf8",
    )

    expect(worker).toContain(
      'from "@opencode-ai/core/session/execution-owner"',
    )
    expect(worker).toContain("execution.snapshot(sessionID)")
    expect(worker).toContain('ownership.ownerID')
    expect(worker).toContain('"recoverable"')
    expect(worker).toContain('while (current.state === "running")')
  })

  test("keeps provider account identity first-class and never persists model@account", async () => {
    const worker = await fs.readFile(
      path.join(opencode, "session/delegated-worker.ts"),
      "utf8",
    )

    expect(worker).toContain("id: selected.model.modelID")
    expect(worker).toContain("accountID: selected.model.accountID")
    expect(worker).not.toMatch(
      /modelID\s*\+\s*["'`]@|["'`]@["'`]\s*\+\s*(?:selection|selected|input)/,
    )
  })

  test("requires both durable worker policy and live nested-delegation authority", async () => {
    const [worker, domain] = await Promise.all([
      fs.readFile(path.join(opencode, "session/delegated-worker.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/worker.ts"), "utf8"),
    ])

    expect(worker).toContain(
      "origin.nestedDelegation && input.nestedDelegation",
    )
    expect(domain).toContain('"worker.nested.continue"')
    expect(domain).toContain('"worker.nested.batch_continue"')
  })

  test("has no task adapter or Tool.Context dependency anywhere in the OXP delegation stack", async () => {
    const sources = await Promise.all(
      [
        "oxp/worker.ts",
        "oxp/worker-control.ts",
        "oxp/worker-control-v1.ts",
        "session/delegated-worker.ts",
      ].map((file) => fs.readFile(path.join(opencode, file), "utf8")),
    )
    const joined = sources.join("\n")

    expect(joined).not.toMatch(
      /@\/tool\/task|tool\/task|TaskTool|Tool\.Context/,
    )
  })

  test("keeps openfork_worker in the fixed manifest without exceeding the direct-tool budget", () => {
    expect(OxpSurface.TOOLS.map((tool) => tool.name)).toContain(
      "openfork_worker",
    )
    expect(OxpSurface.TOOLS.length).toBeLessThanOrEqual(14)
  })
})
