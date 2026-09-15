import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const preload = resolve(import.meta.dir, "../out/preload/preview.js")
await readFile(preload)
const visualRuntime = resolve(import.meta.dir, "../out/preload/visual-runtime.js")
await readFile(visualRuntime)
const snapeyeCli = resolve(import.meta.dir, "../../browser-visual/node_modules/@zumer/snapeye/src/cli.js")
await readFile(snapeyeCli)
const electronCli = resolve(import.meta.dir, "../node_modules/electron/cli.js")
await readFile(electronCli)

const output = await mkdtemp(join(tmpdir(), "opencode-visual-webview-harness-"))
try {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "./visual-webview-harness-main.ts")],
    target: "node",
    format: "cjs",
    minify: false,
    sourcemap: "none",
    external: ["electron"],
  })
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(`Failed to build Electron visual harness: ${build.logs.map(String).join("\n")}`)
  }
  const entry = join(output, "visual-webview-harness.cjs")
  const resultPath = join(output, "result.json")
  await writeFile(entry, await build.outputs[0]!.arrayBuffer())
  await writeFile(
    join(output, "package.json"),
    JSON.stringify({ name: "opencode-visual-webview-harness", private: true, main: "visual-webview-harness.cjs" }),
    "utf8",
  )
  const env = {
    ...process.env,
    OPENCODE_VISUAL_PRELOAD: preload,
    OPENCODE_VISUAL_RUNTIME_PATH: visualRuntime,
    OPENCODE_SNAPEYE_CLI_PATH: snapeyeCli,
    OPENCODE_VISUAL_RESULT_PATH: resultPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  }
  // The OpenCode dev shell can intentionally carry ELECTRON_RUN_AS_NODE for
  // helper processes. Passing it to the fidelity harness makes electron.exe
  // behave like plain Node and silently bypass the Electron main/preload path we
  // are trying to certify.
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn(["node", electronCli, output], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (stdout.trim()) process.stdout.write(stdout)
  let result: { ok?: unknown }
  try {
    result = JSON.parse(await readFile(resultPath, "utf8")) as { ok?: unknown }
  } catch (error) {
    if (stderr.trim()) process.stderr.write(stderr)
    const loaded = await readFile(`${resultPath}.loaded`, "utf8").catch(() => "<entry-not-loaded>")
    throw new Error(`Electron visual fidelity harness produced no result file (exit=${code}, loaded=${loaded}): ${String(error)}`)
  }
  if (code !== 0) {
    if (stderr.trim()) process.stderr.write(stderr)
    throw new Error(`Electron visual fidelity harness exited ${code}: ${JSON.stringify(result)}`)
  }
  if (result.ok !== true) throw new Error(`Electron visual fidelity harness did not report success: ${JSON.stringify(result)}`)
  if (!stdout.trim()) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await rm(output, { recursive: true, force: true }).catch(() => undefined)
}
