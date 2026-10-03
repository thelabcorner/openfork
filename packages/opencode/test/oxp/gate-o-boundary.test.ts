import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const oxp = path.join(import.meta.dir, "../../src/oxp")
const root = path.join(import.meta.dir, "../../../..")

describe("OXP Gate O architecture boundary", () => {
  test("keeps durable defaults as preferences while leaving explicit selections unrestricted", async () => {
    const [worker, config, schema, host, surface] = await Promise.all([
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
      fs.readFile(path.join(oxp, "config.ts"), "utf8"),
      fs.readFile(path.join(oxp, "schema.ts"), "utf8"),
      fs.readFile(path.join(oxp, "host.ts"), "utf8"),
      fs.readFile(path.join(oxp, "surface.ts"), "utf8"),
    ])

    for (const action of [
      '"model_policy"',
      '"set_default_model"',
      '"clear_default_model"',
      '"set_default_agent"',
      '"clear_default_agent"',
    ]) {
      expect(worker).toContain(action)
    }
    expect(worker).toContain('"agent_catalog"')
    expect(worker).toContain('"model_catalog"')
    expect(worker).toContain("OxpModelCatalog.Service")
    expect(worker).toContain("configuredDefaultModel")
    expect(worker).toContain("resolveConfiguredSelection")
    expect(worker).toContain("policy.defaultModel")
    expect(worker).toContain("rootAgentPreference")
    expect(worker).toContain("No OXP delegated-worker default model is configured")
    expect(worker).not.toContain("revalidateWorkerPolicies")
    expect(worker).not.toContain("requireCurrentPolicy")
    expect(config).toContain("setWorkerDefaultModel")
    expect(config).toContain("setWorkerDefaultAgent")
    expect(config).toContain("scopeLegacyWorkerAgentPolicy")
    expect(config).not.toContain("setWorkerPolicy")
    expect(schema).toContain("Compatibility-only remnants")
    expect(schema).toContain("Durable model preference")
    expect(host).toContain("export function setWorkerDefaultModel")
    expect(host).toContain("export function setWorkerDefaultAgent")
    expect(host).toContain("OxpModelCatalogV1.layer")
    expect(surface).toContain("openfork_worker model_catalog")
    expect(surface).toContain("never invent a separate catalog bridge")
    expect(surface).toContain("preferences, not allowlists")
  })

  test("forbids autonomous default changes in the model-facing contract", async () => {
    const surface = await fs.readFile(path.join(oxp, "surface.ts"), "utf8")
    expect(surface).toContain(
      "Default model/agent changes require explicit user request",
    )
    expect(surface).toContain("never change them autonomously")
  })

  test("projects model and root-scoped agent defaults through privileged desktop IPC", async () => {
    const [protocol, sidecar, server, controller, ipc, preload, platform, settings] =
      await Promise.all(
        [
          "packages/desktop/src/main/sidecar-protocol.ts",
          "packages/desktop/src/main/sidecar.ts",
          "packages/desktop/src/main/server.ts",
          "packages/desktop/src/main/oxp/controller.ts",
          "packages/desktop/src/main/oxp/ipc.ts",
          "packages/desktop/src/preload/index.ts",
          "packages/app/src/oxp/platform.ts",
          "packages/app/src/components/settings-v2/oxp.tsx",
        ].map((file) => fs.readFile(path.join(root, file), "utf8")),
      )

    for (const source of [protocol, sidecar, controller, ipc, preload]) {
      expect(source).toContain("set-worker-default-model")
      expect(source).toContain("set-worker-default-agent")
    }
    for (const source of [protocol, sidecar, server, ipc, preload]) {
      expect(source).toContain("list-worker-agents")
    }
    expect(controller).toContain("sidecar.listWorkerAgents(rootID)")
    expect(platform).toContain("setWorkerDefaultModel")
    expect(platform).toContain("setWorkerDefaultAgent")
    expect(platform).toContain("listWorkerAgents")
    expect(settings).toContain("SettingsModelPickerV2")
    expect(settings).toContain("splitModelIDForProvider")
    expect(settings).toContain("workerPolicy.defaultModel")
    expect(settings).toContain('data-action="oxp-worker-agent-root"')
    expect(settings).toContain('data-action="oxp-worker-default-agent"')
    expect(settings).toContain("api.listWorkerAgents(rootID)")
  })

  test("materializes defaults before native resolution while existing worker rebinding stays explicit", async () => {
    const [worker, delegated] = await Promise.all([
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
      fs.readFile(path.join(root, "packages/opencode/src/session/delegated-worker.ts"), "utf8"),
    ])
    expect(worker).toContain("resolveConfiguredSelection")
    expect(worker).toContain(".resolveSelection(target, { agent, model })")
    expect(worker).toContain('"set_selection"')
    expect(worker).toContain("expectedModel")
    // The native resolver may retain generic OpenFork fallbacks for non-OXP
    // callers. OXP never reaches them with an omitted selection.
    expect(delegated).toContain("yield* agents.defaultInfo()")
    expect(delegated).toContain("yield* provider.defaultModel()")
    expect(delegated).toContain("sameSelection(expected.model, origin.model)")
    expect(delegated).toContain("setDelegatedWorkerModel")
  })

  test("keeps root-scoped agent preferences separate from delegation authority", async () => {
    const [authority, schema, config, worker, settings] = await Promise.all([
      fs.readFile(path.join(oxp, "authority.ts"), "utf8"),
      fs.readFile(path.join(oxp, "schema.ts"), "utf8"),
      fs.readFile(path.join(oxp, "config.ts"), "utf8"),
      fs.readFile(path.join(oxp, "worker.ts"), "utf8"),
      fs.readFile(
        path.join(root, "packages/app/src/components/settings-v2/oxp.tsx"),
        "utf8",
      ),
    ])
    expect(authority).toContain('grant.delegation === "spawn"')
    expect(authority).toContain("grant.nestedDelegation")
    expect(authority).toContain("Delegation is always workspace-bound")
    expect(schema).toContain("WorkerAgentRootPolicy")
    expect(schema).toContain("agentRoots")
    expect(config).toContain("scopeLegacyWorkerAgentPolicy")
    expect(worker).toContain("rootAgentPreference")
    expect(settings).toContain("workerAgentRootOptions")
    expect(worker).toContain('operation: "worker.nested.start"')
    expect(worker).toContain('operation: "worker.nested.batch_start"')
  })
})
