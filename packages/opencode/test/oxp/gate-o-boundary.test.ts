import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const oxp = path.join(import.meta.dir, "../../src/oxp")
const root = path.join(import.meta.dir, "../../../..")

describe("OXP Gate O architecture boundary", () => {
  test("keeps delegation authority separate from per-call model and agent selection", async () => {
    const [worker, config, schema, surface] = await Promise.all([
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
      fs.readFile(path.join(oxp, "config.ts"), "utf8"),
      fs.readFile(path.join(oxp, "schema.ts"), "utf8"),
      fs.readFile(path.join(oxp, "surface.ts"), "utf8"),
    ])

    expect(worker).toContain('"agent_catalog"')
    expect(worker).toContain("resolveSelection")
    for (const legacyAction of [
      '"model_policy"',
      '"set_default_model"',
      '"clear_default_model"',
      '"set_default_agent"',
      '"clear_default_agent"',
    ]) {
      expect(worker).not.toContain(legacyAction)
    }
    expect(config).not.toContain("setWorkerDefaultModel")
    expect(config).not.toContain("setWorkerDefaultAgent")
    expect(config).not.toContain("setWorkerPolicy")
    expect(schema).toContain("Legacy v0 delegation-selection policy")
    expect(config).toContain("workerPolicy: _legacyWorkerPolicy")
    expect(surface).toContain("per-call preferences")
    expect(surface).toContain("No OXP selection allowlist/default gate exists")
  })

  test("removes default-selection control paths from privileged desktop and settings surfaces", async () => {
    const sources = await Promise.all([
      "packages/desktop/src/main/sidecar-protocol.ts",
      "packages/desktop/src/main/sidecar.ts",
      "packages/desktop/src/main/server.ts",
      "packages/desktop/src/main/oxp/controller.ts",
      "packages/desktop/src/main/oxp/ipc.ts",
      "packages/desktop/src/preload/index.ts",
      "packages/desktop/src/preload/types.ts",
      "packages/app/src/oxp/platform.ts",
      "packages/app/src/components/settings-v2/oxp.tsx",
    ].map((file) => fs.readFile(path.join(root, file), "utf8")))

    for (const source of sources) {
      expect(source).not.toContain("setWorkerDefaultModel")
      expect(source).not.toContain("setWorkerDefaultAgent")
      expect(source).not.toContain("set-worker-default-model")
      expect(source).not.toContain("set-worker-default-agent")
    }
    const settings = sources.at(-1)!
    expect(settings).not.toContain("SettingsModelPickerV2")
    expect(settings).not.toContain("workerPolicy")
    expect(settings).not.toContain("worker-default-agent")
  })

  test("new workers use runtime selection while rebinding existing workers remains explicit", async () => {
    const [worker, delegated] = await Promise.all([
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
      fs.readFile(path.join(root, "packages/opencode/src/session/delegated-worker.ts"), "utf8"),
    ])
    expect(worker).toContain(".resolveSelection(")
    expect(delegated).toContain("yield* agents.defaultInfo()")
    expect(delegated).toContain("yield* provider.defaultModel()")
    expect(delegated).toContain("sameSelection(expected.model, origin.model)")
    expect(worker).toContain("target.origin.agent")
    expect(worker).toContain("existing worker's durable selection")
    expect(worker).toContain('"set_selection"')
    expect(worker).toContain("expectedModel")
    expect(delegated).toContain("setDelegatedWorkerModel")
  })

  test("retains only real delegation authority boundaries", async () => {
    const [authority, worker] = await Promise.all([
      fs.readFile(path.join(oxp, "authority.ts"), "utf8"),
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
    ])
    expect(authority).toContain('grant.delegation === "spawn"')
    expect(authority).toContain("grant.nestedDelegation")
    expect(authority).toContain("Delegation is always workspace-bound")
    expect(worker).toContain('operation: "worker.nested.start"')
    expect(worker).toContain('operation: "worker.nested.batch_start"')
    expect(worker).not.toContain("revalidateWorkerPolicies")
    expect(worker).not.toContain("requireCurrentPolicy")
  })
})
