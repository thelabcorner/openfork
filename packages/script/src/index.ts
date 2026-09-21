import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"
const REPOSITORY = process.env.GH_REPO ?? "thelabcorner/openfork"

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { "User-Agent": "openfork-release-script" },
  })
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => String(data.tag_name ?? "").replace(/^v/, ""))
  const parsed = semver.parse(version)
  if (!parsed) throw new Error(`Latest OpenFork release tag is not semver: ${version || "<empty>"}`)
  const t = env.OPENCODE_BUMP?.toLowerCase()
  if (t === "major") return `${parsed.major + 1}.0.0`
  if (t === "minor") return `${parsed.major}.${parsed.minor + 1}.0`
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const teamFile = Bun.file(teamPath)
let teamMembers: string[] = []
if (await teamFile.exists()) {
  teamMembers = (await teamFile.text())
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"))
}
const team = [...teamMembers, ...bot]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
  get publishUpstreamNpmNamespace() {
    return process.env.OPENFORK_PUBLISH_UPSTREAM_NPM_NAMESPACE === "1"
  },
}
console.log(`openfork script`, JSON.stringify(Script, null, 2))
