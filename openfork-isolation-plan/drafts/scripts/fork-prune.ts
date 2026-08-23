#!/usr/bin/env bun
import { $ } from "bun"
import manifest from "../keep-manifest.json"

const paths = manifest.pruneFromMain
if (paths.length === 0) throw new Error("keep-manifest.json pruneFromMain is empty")

const existing = paths.filter((path) => {
  const out = Bun.spawnSync(["git", "ls-files", "--", path], { stdout: "pipe" })
  return out.stdout.toString().trim().length > 0
})

if (existing.length === 0) {
  console.log("fork-prune: nothing to remove")
  process.exit(0)
}

await $`git rm -rf --ignore-unmatch ${existing}`
console.log(`fork-prune: removed ${existing.join(" ")}`)
