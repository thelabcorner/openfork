#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { existsSync, promises as fs, readdirSync, statSync } from "node:fs"
import path from "path"
import { fileURLToPath } from "url"
import manifest from "../../../keep-manifest.json"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const outFile = path.join(dir, "dist/node/node.js")
const compressWorkerFile = path.join(dir, "dist/node/compress-worker.js")
const decompressWorkerFile = path.join(dir, "dist/node/decompress-worker.js")
const stampFile = path.join(dir, "dist/node/.build-stamp")
const artifactLockFile = path.join(dir, "dist/node/.oxp-runtime-refresh.lock")
const buildLockOwner = `build:${process.pid}`
// Preview Script.version values contain the current UTC minute. That value is
// useful as build metadata, but it is not an input fingerprint: including it
// here invalidated an otherwise-current sidecar every minute. Source mtimes
// below already decide when a preview artifact must be rebuilt. Explicit/release
// versions remain part of the freshness contract because they are stable inputs.
const stampVersion = process.env.OPENCODE_VERSION ?? (Script.preview ? `preview:${Script.channel}` : Script.version)
const upstreamCompatVersion = manifest.openCodeHostedCompatibility.version
const stamp = `${stampVersion}\0${Script.channel}\0${upstreamCompatVersion}`

// Product release identity stays independent from the upstream OpenCode hosted
// compatibility baseline stamped above.
const releaseVersion = Script.preview
  ? ((await Bun.file(path.join(dir, "package.json")).json()) as { version: string }).version
  : Script.version

if (!(await acquireBuildLock())) {
  console.error("OXP runtime artifact transaction is active; retry the Node sidecar build after it completes")
  process.exit(75)
}

try {
  if (process.env.OPENCODE_FORCE_NODE_BUILD !== "1" && (await isFresh())) {
    console.log("Build skipped (up to date)")
  } else {
    const generated = await import("./generate.ts")

    await buildOrThrow({
      target: "node",
      entrypoints: ["./src/node.ts"],
      outdir: "./dist/node",
      format: "esm",
      sourcemap: "linked",
      external: ["jsonc-parser", "@lydell/node-pty"],
      // Claude first-party: @anthropic-ai/claude-agent-sdk is optionalDependency (package.json) but
      // intentionally omitted from hard deps + loaded only via guarded dynamic import (see
      // availability.ts using indirect specifier + /* @vite-ignore */). Never bundled at build;
      // absent at runtime -> graceful unavailable (no startup failure). claude/* runtime modules
      // (runtime/bridge/sessions/tool-bridge/...) are reached via dynamic import from provider
      // wiring + explicit force-include below in shared.ts to ensure sidecar bundle parity.
      // Do not add the SDK to external[]. See docs/claude-first-party.md .
      define: {
        OPENCODE_MODELS_DEV: generated.modelsData,
        OPENCODE_VERSION: `'${Script.version}'`,
        OPENCODE_RELEASE_VERSION: JSON.stringify(releaseVersion),
        OPENCODE_UPSTREAM_COMPAT_VERSION: JSON.stringify(upstreamCompatVersion),
        OPENCODE_CHANNEL: `'${Script.channel}'`,
        OPENCODE_CHUNKDB_COMPRESS_WORKER_PATH: JSON.stringify("./compress-worker.js"),
        OPENCODE_CHUNKDB_DECOMPRESS_WORKER_PATH: JSON.stringify("./decompress-worker.js"),
      },
      files: {
        "opencode-web-ui.gen.ts": "",
      },
    })

    // ChunkDB workers must be real sibling assets. The main server bundle cannot
    // point at ../core/src/*.ts at runtime because packaged/dev sidecars execute
    // from dist/node. Bundle each worker independently so its core codec imports
    // are self-contained and Node Worker can execute it directly.
    await buildOrThrow({
      target: "node",
      entrypoints: ["../core/src/database/compress-worker.ts", "../core/src/database/decompress-worker.ts"],
      outdir: "./dist/node",
      format: "esm",
      sourcemap: "linked",
    })

    await Bun.write(stampFile, stamp)
    console.log("Build complete")
  }
} finally {
  await releaseBuildLock()
}

async function acquireBuildLock() {
  await fs.mkdir(path.dirname(artifactLockFile), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(artifactLockFile, `${buildLockOwner}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let owner = ""
      try {
        owner = (await fs.readFile(artifactLockFile, "utf8")).trim()
      } catch {
        continue
      }
      const match = /^(?:build|trial|startup):(\d+)(?::|$)/.exec(owner)
      const pid = match ? Number(match[1]) : undefined
      if (pid !== undefined && processAlive(pid)) return false
      await fs.rm(artifactLockFile, { force: true }).catch(() => undefined)
    }
  }
  return false
}

async function releaseBuildLock() {
  try {
    const owner = (await fs.readFile(artifactLockFile, "utf8")).trim()
    if (owner !== buildLockOwner) return
    await fs.rm(artifactLockFile, { force: true })
  } catch {}
}

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isFresh() {
  const outputs = [outFile, compressWorkerFile, decompressWorkerFile]
  if (outputs.some((file) => !existsSync(file)) || !existsSync(stampFile)) return false
  if ((await Bun.file(stampFile).text()) !== stamp) return false
  const oldestOutput = Math.min(...outputs.map((file) => statSync(file).mtimeMs))
  return inputRoots().every((root) => newestMtime(root) <= oldestOutput)
}

async function buildOrThrow(options: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(options)
  if (result.success) return result
  for (const log of result.logs) console.error(log)
  throw new Error("Node sidecar build failed")
}

function inputRoots() {
  return [
    path.join(dir, "src"),
    path.join(dir, "script"),
    path.join(dir, "package.json"),
    path.join(dir, "../core/src"),
    path.join(dir, "../protocol/src"),
    path.join(dir, "../plugin/src"),
    path.join(dir, "../../bun.lock"),
  ]
}

function newestMtime(root: string) {
  if (!existsSync(root)) return 0
  const info = statSync(root)
  if (info.isFile()) return info.mtimeMs
  let newest = info.mtimeMs
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    if (!current) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const time = statSync(full).mtimeMs
      if (time > newest) newest = time
    }
  }
  return newest
}
