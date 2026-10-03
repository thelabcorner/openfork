#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { chmod, rm, writeFile } from "node:fs/promises"
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
  PRODUCT_SLUG,
} from "@opencode-ai/core/brand"
import pkg from "../package.json"
import manifest from "../../../keep-manifest.json"
import { T3_CODE_COMPAT_EXECUTABLE, T3_CODE_COMPAT_PROFILE } from "../src/compat/t3code"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
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

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

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

const distDir = path.join(dir, "dist")

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const targetParts = [
    // Bun names its Windows compile target "windows", not "win32".
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
  const name = [PRODUCT_SLUG, ...targetParts].join("-")
  const bunTarget = ["bun", ...targetParts].join("-")
  console.log(`building ${name}`)
  // Clean only the target we are about to replace. `dist/node` may be serving a
  // live Electron sidecar, and unrelated historical/cross-platform output may
  // legitimately be locked by another process. A single-target build must not
  // fail because some other dist subtree cannot be removed.
  await rm(path.join(distDir, name), { recursive: true, force: true })
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
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
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: bunTarget as any,
      outfile: `dist/${name}/bin/${PRODUCT_EXECUTABLE}`,
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
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // OpenFork owns the real executable name. Keep the historical `opencode`
  // command as a transparent forwarding compatibility surface so existing
  // OpenFork scripts do not silently enter a consumer-specific profile.
  const compatibilityPath = path.join(
    "dist",
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
    "dist",
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
    "dist",
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

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = path.join(
      "dist",
      name,
      "bin",
      item.os === "win32" ? `${PRODUCT_EXECUTABLE}.exe` : PRODUCT_EXECUTABLE,
    )
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      const chunkDb = await validateChunkDbCapability(path.resolve(binaryPath))
      console.log(`ChunkDB capability smoke passed: user_version ${chunkDb.userVersion}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
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

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  const repository = process.env.GH_REPO ?? PRODUCT_REPOSITORY
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${repository}`
}

export { binaries }
