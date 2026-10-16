// Owner-patch simulation: compile the REAL full CLI app with the verified
// embedded-worker fix applied ONLY in this harness (build.ts is another
// owner's dirty file and is never edited).
//
// Fix simulation (2 lines worth of behavior):
//   1. naming: { entry: "[name].[ext]" } collapses every additional entrypoint
//      to its basename at the embedded root, where the compiled worker URL
//      `./sqlite-bun-worker.ts` actually resolves.
//   2. OPENCODE_WORKER_PATH tracks the collapsed TUI worker name ("./worker.js").
//
// Deviations from script/build.ts, documented in the lane journal:
//   - no embedded web UI (equivalent to --skip-embed-web-ui)
//   - this script does not run build.ts's internal capability smoke; the ACP
//     certification harness is the acceptance test
//
// Output goes under this lane's .work directory only.

import { createHash } from "node:crypto"
import { readFile, mkdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { workRoot } from "../lib/work"

const laneRoot = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneRoot, "..", "..")
const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string }

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
const treeSitterWorker = await Bun.file(
  (await import("node:url")).fileURLToPath(import.meta.resolve("@opentui/core/parser.worker")),
).text()
const modelsData = await readFile(join(packageRoot, ".cache", "models.dev.json"), "utf8").catch(() => "{}")

const plugin = createSolidTransformPlugin()
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
const outDir = process.env.OPENFORK_CERT_OUTPUT_DIR ?? join(workRoot(), "builds", `fixed-${stamp}-${process.pid}`)
const targetDir = join(outDir, "openfork-windows-x64")
const binDir = join(targetDir, "bin")
await mkdir(binDir, { recursive: true })
const outfile = join(binDir, process.platform === "win32" ? "openfork.exe" : "openfork")

const started = performance.now()
const build = await Bun.build({
  root: packageRoot,
  conditions: ["bun", "node"],
  tsconfig: join(packageRoot, "tsconfig.json"),
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  sourcemap: "none",
  splitting: true,
  // VERIFIED FIX (simulated): collapse additional entrypoints to the embedded
  // root by basename so `new URL("./sqlite-bun-worker.ts", import.meta.url)`
  // resolves inside the compiled binary.
  naming: { entry: "[name].[ext]" },
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: targetName() as never,
    outfile,
    execArgv: [`--user-agent=openfork/${pkg.version}`, "--use-system-ca", "--"],
    windows: {},
  },
  files: {
    [treeSitterWorkerPath]: treeSitterWorker,
  },
  entrypoints: [
    join(packageRoot, "src/index.ts"),
    join(packageRoot, "src/cli/tui/worker.ts"),
    join(packageRoot, "..", "core", "src", "database", "sqlite-bun-worker.ts"),
    treeSitterWorkerPath,
  ],
  define: {
    FFF_LIBC: JSON.stringify("gnu"),
    OPENCODE_VERSION: JSON.stringify(pkg.version),
    OPENCODE_RELEASE_VERSION: JSON.stringify(pkg.version),
    OPENCODE_UPSTREAM_COMPAT_VERSION: JSON.stringify("1.18.34"),
    OPENCODE_MODELS_DEV: modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: (process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/") + treeSitterWorkerPath,
    // VERIFIED FIX (simulated): matches the collapsed TUI worker basename.
    OPENCODE_WORKER_PATH: JSON.stringify("./worker.js"),
    OPENCODE_CHANNEL: JSON.stringify("main"),
    OPENCODE_LIBC: JSON.stringify(""),
  },
})

if (!build.success) {
  console.log(JSON.stringify({ probe: "full-app-fix", ok: false, logs: build.logs.map((l) => `${l.level}: ${l.message}`).slice(0, 30) }))
  process.exit(1)
}

const bytes = await readFile(outfile)
const child = Bun.spawn([outfile, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
const [code, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
])

console.log(
  JSON.stringify(
    {
      probe: "full-app-fix",
      ok: code === 0,
      bunVersion: process.versions.bun,
      buildMs: Math.round(performance.now() - started),
      binary: outfile,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: stdout.trim(),
      versionExit: code,
      stderrTail: stderr.trim().slice(0, 400),
      outputDir: outDir,
    },
    null,
    2,
  ),
)
process.exit(code === 0 ? 0 : 1)
