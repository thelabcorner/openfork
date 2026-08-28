#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const outFile = path.join(dir, "dist/node/node.js")
const stampFile = path.join(dir, "dist/node/.build-stamp")
const stamp = `${Script.version}\0${Script.channel}`

if (process.env.OPENCODE_FORCE_NODE_BUILD !== "1" && (await isFresh())) {
  console.log("Build skipped (up to date)")
} else {
  const generated = await import("./generate.ts")

  await Bun.build({
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
      OPENCODE_CHANNEL: `'${Script.channel}'`,
    },
    files: {
      "opencode-web-ui.gen.ts": "",
    },
  })

  await Bun.write(stampFile, stamp)
  console.log("Build complete")
}

async function isFresh() {
  if (!existsSync(outFile) || !existsSync(stampFile)) return false
  if ((await Bun.file(stampFile).text()) !== stamp) return false
  const outTime = statSync(outFile).mtimeMs
  return inputRoots().every((root) => newestMtime(root) <= outTime)
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
