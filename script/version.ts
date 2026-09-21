#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const repo = process.env.GH_REPO ?? "thelabcorner/openfork"
if (!Script.preview && process.env.OPENFORK_ENABLE_STABLE_PUBLISH !== "1") {
  throw new Error(
    "OpenFork stable publishing is not configured. Refusing to create a stable release without OPENFORK_ENABLE_STABLE_PUBLISH=1.",
  )
}

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

if (!Script.preview) {
  await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/openfork-release-notes.txt`
  await Bun.write(notesFile, body)
  await $`gh release create v${Script.version} -d --target ${sha} --title "OpenFork v${Script.version}" --notes-file ${notesFile} --repo ${repo}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId --repo ${repo}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await $`gh release create v${Script.version} -d --title "OpenFork v${Script.version}" --repo ${repo}`
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${repo}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${repo}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
