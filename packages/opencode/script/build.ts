#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { chmod, copyFile, link, rm, writeFile } from "node:fs/promises"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { validateChunkDbCapability } from "./chunkdb-capability"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import {
  LEGACY_PRODUCT_EXECUTABLE,
  PRODUCT_EXECUTABLE,
  PRODUCT_REPOSITORY,
} from "@opencode-ai/core/brand"
// The CLI release matrix has exactly one authority. `script/release-assets.ts`
// derives the expected published archive inventory from the same CLI_TARGETS
// and the same target-name helpers used below, so a release can never publish a
// name the inventory gate does not require (or the reverse).
import { CLI_TARGETS, bunCompileTarget, cliTargetSlug } from "./release-assets.ts"
import pkg from "../package.json"
import manifest from "../../../keep-manifest.json"
import { T3_CODE_COMPAT_EXECUTABLE, T3_CODE_COMPAT_PROFILE, T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION } from "../src/compat/t3code"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
// Optional release admission gate: the lightweight --version smoke cannot
// detect broken SQLite worker entrypoints or ACP session bootstrap. Run the
// existing real packaged ACP fixture only when explicitly requested.
const verifyPackagedAcp = process.argv.includes("--verify-packaged-acp")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

// OpenFork product/build identity and upstream-hosted compatibility are separate.
// The latter advances only when a verified upstream tag sync updates the manifest.
const releaseVersion = Script.preview ? pkg.version : Script.version
const upstreamCompatVersion = manifest.openCodeHostedCompatibility.version

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets = CLI_TARGETS

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

// Allow isolated local verification builds to write outside the shared package
// dist tree. Release builds keep the historical default unless explicitly set.
const distDir = path.resolve(process.env.OPENFORK_BUILD_OUTPUT_DIR ?? path.join(dir, "dist"))
let packagedAcpVerified = false

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = cliTargetSlug(item)
  const bunTarget = bunCompileTarget(item)
  console.log(`building ${name}`)
  // Clean only the target we are about to replace. `dist/node` may be serving a
  // live Electron sidecar, and unrelated historical/cross-platform output may
  // legitimately be locked by another process. A single-target build must not
  // fail because some other dist subtree cannot be removed.
  await rm(path.join(distDir, name), { recursive: true, force: true })
  const targetDir = path.join(distDir, name)
  const binDir = path.join(targetDir, "bin")
  await $`mkdir -p ${binDir}`

  const workerPath = "./src/cli/tui/worker.ts"
  const sqliteWorkerPath = "../core/src/database/sqlite-bun-worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    // Bun 1.4's compiled virtual FS must expose secondary worker entrypoints
    // at the basename used by new Worker(new URL("./sqlite-bun-worker.ts",
    // import.meta.url)). Without this, the compiled Windows CLI fails to
    // resolve B:/~BUN/root/sqlite-bun-worker.ts at runtime even when the
    // worker was explicitly included in entrypoints.
    naming: { entry: "[name].[ext]" },
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: bunTarget as any,
      outfile: path.join(binDir, PRODUCT_EXECUTABLE),
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      sqliteWorkerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_RELEASE_VERSION: JSON.stringify(releaseVersion),
      OPENCODE_UPSTREAM_COMPAT_VERSION: JSON.stringify(upstreamCompatVersion),
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      // TUI is likewise a secondary entrypoint; naming flattens its virtual
      // path to worker.js, so the runtime worker locator must match.
      OPENCODE_WORKER_PATH: JSON.stringify("./worker.js"),
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // OpenFork owns the real executable name. Keep the historical `opencode`
  // command as a transparent forwarding compatibility surface so existing
  // OpenFork scripts do not silently enter a consumer-specific profile.
  const compatibilityPath = path.join(
    distDir,
    name,
    "bin",
    item.os === "win32" ? `${LEGACY_PRODUCT_EXECUTABLE}.cmd` : LEGACY_PRODUCT_EXECUTABLE,
  )
  const compatibilityLauncher =
    item.os === "win32"
      ? `@echo off\r\n"%~dp0${PRODUCT_EXECUTABLE}.exe" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nexec "$(dirname "$0")/${PRODUCT_EXECUTABLE}" "$@"\n`
  await writeFile(compatibilityPath, compatibilityLauncher)
  if (item.os !== "win32") await chmod(compatibilityPath, 0o755)

  const devLauncherPath = path.join(
    distDir,
    name,
    "bin",
    item.os === "win32" ? "opencode-dev.cmd" : "opencode-dev",
  )
  const devLauncher =
    item.os === "win32"
      ? `@echo off\r\nif not defined OPENCODE_DB set "OPENCODE_DB=%USERPROFILE%\\.local\\share\\openfork\\openfork-dev.db"\r\n"%~dp0${PRODUCT_EXECUTABLE}.exe" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nif [ -z "\${OPENCODE_DB:-}" ]; then export OPENCODE_DB="$HOME/.local/share/openfork/openfork-dev.db"; fi\nexec "$(dirname "$0")/${PRODUCT_EXECUTABLE}" "$@"\n`
  await writeFile(devLauncherPath, devLauncher)
  if (item.os !== "win32") await chmod(devLauncherPath, 0o755)

  // Ship an explicitly named OpenFork-owned T3 launcher. T3 already exposes a
  // configurable OpenCode binaryPath, so this consumer-specific compatibility
  // profile does not need to leak into canonical or historical OpenFork entrypoints.
  const t3CodeCompatibilityPath = path.join(
    distDir,
    name,
    "bin",
    item.os === "win32" ? `${T3_CODE_COMPAT_EXECUTABLE}.cmd` : T3_CODE_COMPAT_EXECUTABLE,
  )
  const t3CodeCompatibilityLauncher =
    item.os === "win32"
      ? `@echo off\r\nset "OPENFORK_COMPAT_PROFILE=${T3_CODE_COMPAT_PROFILE}"\r\n"%~dp0${PRODUCT_EXECUTABLE}.exe" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nOPENFORK_COMPAT_PROFILE=${T3_CODE_COMPAT_PROFILE} exec "$(dirname "$0")/${PRODUCT_EXECUTABLE}" "$@"\n`
  await writeFile(t3CodeCompatibilityPath, t3CodeCompatibilityLauncher)
  if (item.os !== "win32") await chmod(t3CodeCompatibilityPath, 0o755)

  // Windows managed clients can invoke the native executable directly rather
  // than using a batch shell. Only this invoked basename activates the T3
  // compatibility profile; canonical openfork.exe retains its product identity.
  if (item.os === "win32") {
    const source = path.join(binDir, `${PRODUCT_EXECUTABLE}.exe`)
    const alias = path.join(binDir, `${T3_CODE_COMPAT_EXECUTABLE}.exe`)
    try {
      await link(source, alias)
    } catch {
      await copyFile(source, alias)
    }
  }

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - ${path.join(binDir, PRODUCT_EXECUTABLE)}`
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = path.join(
      distDir,
      name,
      "bin",
      item.os === "win32" ? `${PRODUCT_EXECUTABLE}.exe` : PRODUCT_EXECUTABLE,
    )
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      if (item.os === "win32") {
        const alias = path.join(binDir, `${T3_CODE_COMPAT_EXECUTABLE}.exe`)
        const compatVersion = (await $`${alias} --version`.text()).trim()
        if (compatVersion !== T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION) {
          throw new Error(`T3 executable alias version mismatch: ${compatVersion}`)
        }
        console.log(`T3 alias version passed: ${compatVersion}`)
      }
      const chunkDb = await validateChunkDbCapability(path.resolve(binaryPath))
      console.log(`ChunkDB capability smoke passed: user_version ${chunkDb.userVersion}`)
      if (verifyPackagedAcp) {
        // The cert runs the *compiled* executable, speaks real ACP, exercises
        // the async SQLite worker and V1 session lifecycle, and uses its own
        // disposable database and local mock provider. --binary prevents a
        // nested recursive build; nonzero verdict fails the packaging gate.
        const command = [
          "bun", "run", "script/sqlite-acp-cert-20261011/smoke-cert.ts",
          "--binary", path.resolve(binaryPath),
          "--driver", "default", "--stdout-json",
        ]
        const child = Bun.spawn(command, {
          cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        })
        const deadline = setTimeout(() => child.kill(), 120_000)
        let code: number
        let output: string
        let errors: string
        try {
          ;[code, output, errors] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
        } finally {
          clearTimeout(deadline)
        }
        const report = (() => {
          try {
            return JSON.parse(output) as {
              verdict?: string
              checks?: { name: string; status: string }[]
            }
          } catch {
            throw new Error(`Packaged ACP certification did not emit JSON: ${output.slice(-1200)}`)
          }
        })()
        const checks = report.checks ?? []
        const required = [
          "initialize.protocolVersion", "session/new.sessionId",
          "session/list.membership", "lock-release.external-write",
          "cancel.prompt.cancelled", "session/close", "exit.code",
          "protocol.clean-stdout", "db.integrity", "fixture.released",
        ]
        if (code !== 0 || report.verdict !== "pass" ||
            required.some((name) => !checks.some((check) => check.name === name && check.status === "pass"))) {
          throw new Error(`Packaged ACP certification failed for ${name}: exit=${code} verdict=${report.verdict ?? "missing"} checks=${JSON.stringify(checks.filter((check) => check.status !== "pass"))} stderr=${errors.slice(-1200)}`)
        }
        packagedAcpVerified = true
        console.log(`Packaged ACP certification passed: ${checks.length} checks, real SQLite worker and V1 session lifecycle`)
      }
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await rm(path.join(binDir, "tui"), { recursive: true, force: true })
  await Bun.file(path.join(targetDir, "package.json")).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (verifyPackagedAcp && !packagedAcpVerified) {
  throw new Error("--verify-packaged-acp requested, but no native executable was certified")
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ${path.join(distDir, `${key}.tar.gz`)} *`.cwd(path.join(distDir, key, "bin"))
    } else {
      await $`zip -r ${path.join(distDir, `${key}.zip`)} *`.cwd(path.join(distDir, key, "bin"))
    }
  }
  const repository = process.env.GH_REPO ?? PRODUCT_REPOSITORY
  await $`gh release upload v${Script.version} ${path.join(distDir, "*.zip")} ${path.join(distDir, "*.tar.gz")} --clobber --repo ${repository}`
}

export { binaries }
