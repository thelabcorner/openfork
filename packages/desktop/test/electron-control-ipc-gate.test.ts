import { execFile } from "node:child_process"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "bun:test"

test("actual Electron IPC reserves urgent control while six admissions wait", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".electron-ipc-gate-"))
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "electron-control-ipc-gate.ts")], target: "node", format: "cjs", packages: "external", outdir: directory,
      plugins: [{ name: "bundle-workspace-contracts", setup(builder) {
        builder.onResolve({ filter: /^@opencode-ai\// }, args => ({ path: Bun.resolveSync(args.path, dirname(args.importer)), external: false }))
        // The product main build is ESM. This test uses a CJS bootstrap so
        // startup failures are caught without an Electron error dialog.
        builder.onLoad({ filter: /[/\\]windows\.ts$/ }, async args => ({
          contents: (await Bun.file(args.path).text()).replace("fileURLToPath(import.meta.url)", "__filename"), loader: "ts",
        }))
      } }],
    })
    expect(build.success, build.logs.map(log => log.message).join("\n")).toBe(true)
    const main = join(directory, "electron-control-ipc-gate.cjs")
    await rename(join(directory, "electron-control-ipc-gate.js"), main)
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "openfork-ipc-gate", main: "electron-control-ipc-gate.cjs" }))
    const evidencePath = join(directory, "evidence.json")
    const bootstrap = join(directory, "launch.cjs")
    await writeFile(bootstrap, `const {app}=require('electron'); const fs=require('node:fs');
const fail=error=>{fs.writeFileSync(process.env.OPENCODE_GATE_RESULT_PATH,JSON.stringify({error:String(error),stack:error?.stack}));app.exit(1)};
process.on('uncaughtException',fail); try{require('./electron-control-ipc-gate.cjs')}catch(error){fail(error)};`)
    const execution = promisify(execFile)(resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe"), ["--no-sandbox", "--disable-gpu", bootstrap], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, OPENCODE_GATE_RESULT_PATH: evidencePath }, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    execution.child.stderr?.on("data", (chunk) => {
      const message = String(chunk)
      if (message.includes("App threw an error")) {
        console.error(message)
        execution.child.kill()
      }
    })
    await execution.catch(async error => { throw new Error(await readFile(evidencePath, "utf8").catch(() => String(error))) })
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"))
    expect(evidence.heldAdmissionsAtCompletion, JSON.stringify(evidence)).toBe(6)
    expect(evidence.untrustedRejected).toBe(true)
    expect(evidence.createCompletionMs).toBeGreaterThan(0)
    console.log("Electron IPC evidence:", evidence)
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 90000)
