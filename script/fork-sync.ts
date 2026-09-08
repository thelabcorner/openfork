#!/usr/bin/env bun
/**
 * fork-sync: hardened upstream tag-sync pipeline for the OpenFork branch-fork.
 *
 * Usage:
 *   bun run fork:sync preflight <tag>   # fetch, refuse dirty tree, snapshot fork-only keys
 *   git merge <tag>                      # run by hand so the human sees the stop
 *   bun run fork:sync resolve            # auto-resolve prune/lock/pkg/generated/fork-owned/meta
 *   # ... handle MANUAL items printed by resolve, re-run resolve until clean ...
 *   bun install                          # regenerate bun.lock from merged manifests
 *   git commit                           # union-listing message (see skill)
 *   bun run fork:sync verify --tag <tag>
 *
 * Why this exists: every tag merge resurrects pruned SaaS trees (~100
 * conflict paths of noise), scatters package.json conflicts across 16+
 * manifests, and silently drops fork-only keys (v1.18.29 lost the
 * `@opencode-ai/core/memory` export because an ad-hoc union script only
 * merged deps+scripts). This script makes the mechanical resolutions
 * deterministic and turns the semantic checklist into failing checks.
 *
 * Rules source: keep-manifest.json (pruneFromMain) + FORK.md. If they
 * disagree, believe the newer of the two and update the other.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type PkgJson = Record<string, any>

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
/** Scripts that only make sense with the pruned SaaS trees. Never resurrected. */
const DROP_SCRIPTS = new Set(["dev:console", "dev:stats", "dev:storybook", "sso"])
/** Script keys where the fork value wins on conflict. */
const OURS_WIN_SCRIPTS = new Set(["dev"])
/** Top-level package.json keys taken verbatim from upstream. */
const THEIRS_KEYS = new Set(["workspaces"])

/** Options for mergePackageJson. Pass workspace callbacks during a real
 * resolve so `workspaces.packages` stays a curated, installable list
 * instead of upstream globs that reference pruned trees (v1.18.29 broke
 * `bun install` with `Workspace not found "packages/slack"`). */
export interface PkgMergeOptions {
  workspaceExists?: (entry: string) => boolean
  isDropWorkspace?: (entry: string) => boolean
}

/**
 * Workspace package list policy: explicit entries only (bare `packages/*`
 * globs re-include pruned trees), DROP entries removed, nonexistent
 * entries removed, upstream additions kept when they exist on disk.
 */
export function mergeWorkspacePackages(
  ours: unknown,
  theirs: unknown,
  opts: PkgMergeOptions = {},
): { packages: string[]; dropped: string[] } {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])
  const candidates = [...list(ours), ...list(theirs)]
  const out: string[] = []
  const dropped: string[] = []
  for (const entry of candidates) {
    if (out.includes(entry)) continue
    if (entry.endsWith("/*")) {
      dropped.push(entry)
      continue
    }
    if (opts.isDropWorkspace?.(entry)) {
      dropped.push(entry)
      continue
    }
    if (opts.workspaceExists && !opts.workspaceExists(entry)) {
      dropped.push(entry)
      continue
    }
    out.push(entry)
  }
  return { packages: out.sort(), dropped }
}

const REPO_ROOT = join(import.meta.dir, "..")

// ---------------------------------------------------------------------------
// git helpers (argv-based: no shell, so `packages/console/.../[id]/...`
// paths never glob-expand the way they do under PowerShell)
// ---------------------------------------------------------------------------

function git(...args: string[]): { ok: boolean; out: string; errout: string } {
  const out = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT })
  return {
    ok: out.exitCode === 0,
    out: out.stdout.toString().trim(),
    errout: out.stderr.toString().trim(),
  }
}

function unmergedFiles(): string[] {
  const r = git("diff", "--name-only", "--diff-filter=U")
  if (!r.ok || !r.out) return []
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean)
}

function trackedFiles(...paths: string[]): string[] {
  const r = git("ls-files", "--", ...paths)
  if (!r.ok || !r.out) return []
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean)
}

function showFile(rev: string, path: string): string | undefined {
  const r = git("show", `${rev}:${path}`)
  return r.ok ? r.out : undefined
}

// ---------------------------------------------------------------------------
// keep-manifest
// ---------------------------------------------------------------------------

interface KeepManifest {
  pruneFromMain: string[]
}

function loadManifest(): KeepManifest {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, "keep-manifest.json"), "utf8")) as KeepManifest
  if (!Array.isArray(parsed.pruneFromMain) || parsed.pruneFromMain.length === 0) {
    throw new Error("keep-manifest.json pruneFromMain is empty or missing")
  }
  return parsed
}

function isDropPath(path: string, prune: string[]): boolean {
  return prune.some((p) => path === p || path.startsWith(p + "/"))
}

// ---------------------------------------------------------------------------
// conflict classification (FORK.md § Conflict classes)
// ---------------------------------------------------------------------------

export type ConflictClass =
  | "prune" // DROP tree re-added by upstream: always delete
  | "lock" // bun.lock: take theirs, regenerate with bun install
  | "pkg-union" // package.json: canonical union merger
  | "generated" // SDK/client codegen: take theirs, regenerate
  | "fork-ours" // fork-owned: keep ours, replay only clear bugfixes by hand
  | "meta-ours" // FORK.md / AGENTS.md / workflows / updater / README: keep ours
  | "union-manual" // registry / plugin / prompt unions: combine by hand
  | "manual" // case-by-case or unknown: human decides, never guess

const GENERATED = [/^packages\/client\/src\/generated(-effect)?\//, /^packages\/sdk\/js\/src\/(v2\/)?gen\//]
const FORK_OWNED = [
  /^packages\/app\/src\/components\/titlebar-/,
  /^packages\/app\/src\/context\/tabs\.tsx$/,
  /^packages\/app\/src\/components\/project-explorer/,
  /^packages\/app\/src\/pages\/session\/v2\/project-explorer/,
  /^packages\/app\/src\/pages\/session\/models-panel/,
  /^packages\/app\/src\/components\/models\//,
  /^packages\/app\/src\/context\/fork-usage\.tsx$/,
  /^packages\/app\/src\/utils\/fork-client\.ts$/,
  /^packages\/desktop\/src\/main\/browser\//,
  /^packages\/app\/src\/pages\/session\/v2\/browser/,
  /session-group/,
  /^packages\/core\/src\/session\/(group-id|sql)\.ts$/,
  /^packages\/opencode\/src\/session\/group\.ts$/,
  /^packages\/opencode\/src\/quota\//,
  /^packages\/opencode\/src\/fork\//,
  /^packages\/opencode\/src\/tool\/(json|background|sqlite|git|typecheck|project|symbols|test|refactor|sympy|patch|archive|swarm|browser|reload|checkpoint|shell-safety)/,
  /^packages\/core\/src\/search\//,
  /^packages\/core\/src\/checkpoint\.ts$/,
  /^packages\/opencode\/src\/session\/checkpoint\.ts$/,
  /^packages\/opencode\/script\/install-jetbrains-acp\.ts$/,
  /^packages\/core\/src\/special-agent-completion\.ts$/,
  /^packages\/core\/src\/prompt-revisor(?:-prompt)?\.ts$/,
  /^packages\/opencode\/src\/prompt-revisor\//,
  /^packages\/opencode\/src\/special-agent\//,
  /^packages\/core\/src\/session\/title\.ts$/,
  /^packages\/opencode\/src\/session\/spad\//,
  /^packages\/schema\/src\/goal(?:-id)?\.ts$/,
  /^packages\/core\/src\/goal(?:\.ts|\/)/,
  /^packages\/core\/test\/goal\//,
  /^packages\/core\/src\/database\/migration\/.*goal/,
  /^packages\/opencode\/src\/tool\/goal\.ts$/,
  /^packages\/opencode\/src\/server\/routes\/instance\/httpapi\/(?:groups|handlers)\/goal\.ts$/,
  /^packages\/app\/src\/components\/goal-composer-shelf/,
  /^packages\/app\/src\/context\/goals\.ts$/,
]
const META = [/^FORK\.md$/, /\/AGENTS\.md$/, /^\.github\/workflows\//, /^README\.md$/, /^packages\/desktop\/src\/main\/updater\.ts$/]
const UNION_MANUAL = [
  /^packages\/opencode\/src\/tool\/registry\.ts$/,
  /^packages\/opencode\/src\/plugin\/index\.ts$/,
  /^packages\/opencode\/src\/session\/prompt\.ts$/,
  /^packages\/opencode\/src\/session\/message-v2\.ts$/,
  /^packages\/opencode\/src\/provider\/provider\.ts$/,
  /^packages\/opencode\/src\/server\/routes\/instance\/httpapi\/(api|server)\.ts$/,
  /^packages\/opencode\/src\/agent\/agent\.ts$/,
  /^packages\/opencode\/src\/tool\/shell\.ts$/,
  /^packages\/core\/src\/config\.ts$/,
  /^packages\/core\/src\/v1\/config\/(config|migrate)\.ts$/,
  /^packages\/core\/src\/session\/runner\/llm\.ts$/,
  /^packages\/core\/src\/location-services\.ts$/,
  /^packages\/app\/src\/context\/settings\.tsx$/,
  /^packages\/app\/src\/components\/settings-v2\/general\.tsx$/,
  /^packages\/app\/src\/components\/prompt-input-v2\.tsx$/,
  /^packages\/app\/src\/i18n\/en\.ts$/,
  /^packages\/session-ui\/src\/v2\/components\/prompt-input\/index\.tsx$/,
]

export function classifyConflict(path: string, prune: string[]): ConflictClass {
  if (isDropPath(path, prune)) return "prune"
  if (path === "bun.lock") return "lock"
  if (path === "package.json" || (path.endsWith("/package.json") && !path.includes("node_modules"))) return "pkg-union"
  if (GENERATED.some((re) => re.test(path))) return "generated"
  if (META.some((re) => re.test(path))) return "meta-ours"
  if (FORK_OWNED.some((re) => re.test(path))) return "fork-ours"
  if (UNION_MANUAL.some((re) => re.test(path))) return "union-manual"
  return "manual"
}

// ---------------------------------------------------------------------------
// package.json canonical union (the v1.18.29 lesson: union EVERYTHING, and
// prove no fork-only key was lost — not just deps+scripts)
// ---------------------------------------------------------------------------

export interface PkgMergeReport {
  file: string
  versionTaken: string | undefined
  forkOnlyKept: string[]
  upstreamOnlyTaken: string[]
  overlapUpstreamWins: string[]
  overlapForkWins: string[]
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function unionArray(a: unknown, b: unknown): unknown[] {
  const out: unknown[] = Array.isArray(a) ? [...a] : []
  for (const item of Array.isArray(b) ? b : []) {
    if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item)
  }
  return out
}

/**
 * Merge policy:
 * - version: upstream (theirs).
 * - dep sections: union; upstream wins overlapping ranges.
 * - scripts: union minus DROP_SCRIPTS; fork wins `dev` (+ OURS_WIN_SCRIPTS).
 * - exports/imports: union; fork wins overlapping keys (fork keys are
 *   additive; an overlap with different values is reported for human review).
 * - files/keywords arrays: union unique.
 * - workspaces: upstream. Any other fork-only top-level key is preserved,
 *   never dropped (a dropped fork-only key is a failed sync, not a
 *   resolution).
 */
export function mergePackageJson(
  file: string,
  ours: PkgJson,
  theirs: PkgJson,
  opts: PkgMergeOptions = {},
): { merged: PkgJson; report: PkgMergeReport } {
  const merged: PkgJson = JSON.parse(JSON.stringify(theirs))
  const report: PkgMergeReport = {
    file,
    versionTaken: typeof theirs.version === "string" ? theirs.version : undefined,
    forkOnlyKept: [],
    upstreamOnlyTaken: [],
    overlapUpstreamWins: [],
    overlapForkWins: [],
  }
  const note = (list: string[], key: string) => {
    if (!list.includes(key)) list.push(key)
  }

  for (const section of DEP_SECTIONS) {
    const o = isPlainObject(ours[section]) ? ours[section] : {}
    const t = isPlainObject(theirs[section]) ? theirs[section] : {}
    const m = isPlainObject(merged[section]) ? { ...merged[section] } : {}
    for (const [k, v] of Object.entries(o)) {
      if (!(k in m)) {
        m[k] = v
        note(report.forkOnlyKept, `${section}.${k}`)
      } else if (JSON.stringify(m[k]) !== JSON.stringify(v)) {
        note(report.overlapUpstreamWins, `${section}.${k}`)
      }
    }
    for (const k of Object.keys(t)) {
      if (!(k in o)) note(report.upstreamOnlyTaken, `${section}.${k}`)
    }
    if (Object.keys(m).length > 0) merged[section] = m
    else delete merged[section]
  }

  // scripts
  {
    const o = isPlainObject(ours.scripts) ? ours.scripts : {}
    const t = isPlainObject(theirs.scripts) ? theirs.scripts : {}
    const m: Record<string, any> = {}
    for (const [k, v] of Object.entries(t)) {
      if (DROP_SCRIPTS.has(k)) continue
      m[k] = v
      if (!(k in o)) note(report.upstreamOnlyTaken, `scripts.${k}`)
    }
    for (const [k, v] of Object.entries(o)) {
      if (DROP_SCRIPTS.has(k)) continue
      if (!(k in m)) {
        m[k] = v
        note(report.forkOnlyKept, `scripts.${k}`)
      } else if (JSON.stringify(m[k]) !== JSON.stringify(v)) {
        if (OURS_WIN_SCRIPTS.has(k)) {
          m[k] = v
          note(report.overlapForkWins, `scripts.${k}`)
        } else {
          note(report.overlapUpstreamWins, `scripts.${k}`)
        }
      }
    }
    merged.scripts = m
  }

  // exports / imports: union, fork wins overlaps (reported)
  for (const section of ["exports", "imports"]) {
    const o = isPlainObject(ours[section]) ? ours[section] : {}
    const t = isPlainObject(theirs[section]) ? theirs[section] : {}
    if (Object.keys(o).length === 0 && Object.keys(t).length === 0) continue
    const m = { ...(isPlainObject(merged[section]) ? merged[section] : {}) }
    for (const [k, v] of Object.entries(o)) {
      if (!(k in m)) {
        m[k] = v
        note(report.forkOnlyKept, `${section}.${k}`)
      } else if (JSON.stringify(m[k]) !== JSON.stringify(v)) {
        m[k] = v
        note(report.overlapForkWins, `${section}.${k}`)
      }
    }
    for (const k of Object.keys(t)) {
      if (!(k in o)) note(report.upstreamOnlyTaken, `${section}.${k}`)
    }
    merged[section] = m
  }

  // arrays: union unique
  for (const section of ["files", "keywords"]) {
    if (Array.isArray(ours[section]) || Array.isArray(theirs[section])) {
      merged[section] = unionArray(theirs[section], ours[section])
    }
  }

  // workspaces: curated explicit list (never upstream globs over DROP trees).
  // Without fs callbacks there is nothing safe to compute, so keep upstream
  // and let verify's `bun install` check catch it.
  if (isPlainObject(ours.workspaces) || isPlainObject(theirs.workspaces)) {
    const oPkgs = isPlainObject(ours.workspaces) ? ours.workspaces.packages : undefined
    const tPkgs = isPlainObject(theirs.workspaces) ? theirs.workspaces.packages : undefined
    if (opts.workspaceExists || opts.isDropWorkspace) {
      const { packages, dropped } = mergeWorkspacePackages(oPkgs, tPkgs, opts)
      merged.workspaces = { ...(isPlainObject(merged.workspaces) ? merged.workspaces : {}), packages }
      for (const d of dropped) note(report.overlapUpstreamWins, `workspaces.packages!${d}`)
      const oSet = new Set(Array.isArray(oPkgs) ? oPkgs : [])
      for (const p of packages) if (!oSet.has(p)) note(report.upstreamOnlyTaken, `workspaces.packages.${p}`)
    }
    // workspaces.catalog: union pins, upstream wins overlaps (v1.18.29: identical, no loss)
    const oCat = isPlainObject(ours.workspaces) && isPlainObject(ours.workspaces.catalog) ? ours.workspaces.catalog : {}
    const tCat = isPlainObject(theirs.workspaces) && isPlainObject(theirs.workspaces.catalog) ? theirs.workspaces.catalog : {}
    if (Object.keys(oCat).length > 0 || Object.keys(tCat).length > 0) {
      const m = { ...tCat }
      for (const [k, v] of Object.entries(oCat)) {
        if (!(k in m)) {
          m[k] = v
          note(report.forkOnlyKept, `workspaces.catalog.${k}`)
        } else if (JSON.stringify(m[k]) !== JSON.stringify(v)) {
          note(report.overlapUpstreamWins, `workspaces.catalog.${k}`)
        }
      }
      merged.workspaces = { ...(isPlainObject(merged.workspaces) ? merged.workspaces : {}), catalog: m }
    }
  }

  // any other fork-only top-level key is preserved, never dropped
  const handled = new Set([...DEP_SECTIONS, "scripts", "exports", "imports", "files", "keywords", "version"])
  for (const [k, v] of Object.entries(ours)) {
    if (handled.has(k) || THEIRS_KEYS.has(k)) continue
    if (!(k in merged)) {
      merged[k] = v
      note(report.forkOnlyKept, k)
    } else if (JSON.stringify(merged[k]) !== JSON.stringify(v)) {
      note(report.overlapUpstreamWins, k)
    }
  }

  return { merged, report }
}

// ---------------------------------------------------------------------------
// snapshot: fork-only package.json surface, taken at preflight, enforced
// by resolve + verify so a lost key fails loudly instead of at runtime
// ---------------------------------------------------------------------------

export interface PkgSnapshot {
  file: string
  forkOnlyTopKeys: string[]
  forkOnlyExports: string[]
  forkOnlyDeps: string[]
  forkOnlyScripts: string[]
}

export function snapshotPackageJson(file: string, ours: PkgJson, theirs: PkgJson): PkgSnapshot {
  const snap: PkgSnapshot = { file, forkOnlyTopKeys: [], forkOnlyExports: [], forkOnlyDeps: [], forkOnlyScripts: [] }
  for (const k of Object.keys(ours)) {
    if (!(k in theirs)) snap.forkOnlyTopKeys.push(k)
  }
  const oExp = isPlainObject(ours.exports) ? ours.exports : {}
  const tExp = isPlainObject(theirs.exports) ? theirs.exports : {}
  for (const k of Object.keys(oExp)) if (!(k in tExp)) snap.forkOnlyExports.push(k)
  for (const section of DEP_SECTIONS) {
    const o = isPlainObject(ours[section]) ? ours[section] : {}
    const t = isPlainObject(theirs[section]) ? theirs[section] : {}
    for (const k of Object.keys(o)) if (!(k in t)) snap.forkOnlyDeps.push(`${section}.${k}`)
  }
  const oS = isPlainObject(ours.scripts) ? ours.scripts : {}
  const tS = isPlainObject(theirs.scripts) ? theirs.scripts : {}
  for (const k of Object.keys(oS)) {
    if (!(k in tS) && !DROP_SCRIPTS.has(k)) snap.forkOnlyScripts.push(k)
  }
  return snap
}

export function checkSnapshot(snap: PkgSnapshot, merged: PkgJson): string[] {
  const missing: string[] = []
  for (const k of snap.forkOnlyTopKeys) if (!(k in merged)) missing.push(k)
  const exp = isPlainObject(merged.exports) ? merged.exports : {}
  for (const k of snap.forkOnlyExports) if (!(k in exp)) missing.push(`exports.${k}`)
  for (const dep of snap.forkOnlyDeps) {
    const dot = dep.indexOf(".")
    const section = dep.slice(0, dot)
    const name = dep.slice(dot + 1)
    const m = isPlainObject(merged[section]) ? merged[section] : {}
    if (!(name in m)) missing.push(dep)
  }
  const scripts = isPlainObject(merged.scripts) ? merged.scripts : {}
  for (const k of snap.forkOnlyScripts) if (!(k in scripts)) missing.push(`scripts.${k}`)
  return missing
}

function snapshotPath(tag: string): string {
  return join(REPO_ROOT, ".opencode", "cache", `fork-sync-${tag}.json`)
}

function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"))
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdPreflight(tag: string): number {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`preflight: expected a release tag like v1.18.29, got ${JSON.stringify(tag)}`)
    return 1
  }
  const fetch = git("fetch", "upstream", "--tags", "--prune")
  if (!fetch.ok) {
    console.error(`preflight: git fetch upstream failed:\n${fetch.out}`)
    return 1
  }
  if (!git("rev-parse", "--verify", tag).ok) {
    console.error(`preflight: tag ${tag} not found after fetch`)
    return 1
  }
  const dirty = git("status", "--porcelain")
  if (dirty.ok && dirty.out) {
    console.error("preflight: working tree is dirty — commit or stash first, then re-run. Refusing to start a sync on a dirty tree.")
    return 1
  }
  // Snapshot fork-only package.json surface vs the tag, so resolve/verify
  // can prove nothing fork-only was lost.
  const manifests = trackedFiles("package.json", "packages/*/package.json").filter((f) => f.endsWith("package.json"))
  const snaps: PkgSnapshot[] = []
  for (const file of manifests) {
    const oursRaw = showFile("HEAD", file)
    const theirsRaw = showFile(tag, file)
    if (!oursRaw || !theirsRaw) continue
    try {
      snaps.push(snapshotPackageJson(file, JSON.parse(oursRaw), JSON.parse(theirsRaw)))
    } catch {
      console.error(`preflight: could not parse ${file} on one side — will need manual review`)
    }
  }
  writeFileSync(snapshotPath(tag), JSON.stringify({ tag, snaps }, null, 2))
  console.log(`preflight: ${tag} verified, tree clean, snapshot of ${snaps.length} manifests -> .opencode/cache/fork-sync-${tag}.json`)
  console.log(git("diff", "--stat", `main...${tag}`, "--", "packages/app", "packages/desktop", "packages/opencode", "packages/core",
    "packages/schema", "packages/protocol", "packages/server", "packages/session-ui", "packages/ui").out || "(no KEEP-path changes)")
  console.log(`next: git merge ${tag}`)
  return 0
}

function loadSnapshots(): PkgSnapshot[] {
  let best: PkgSnapshot[] = []
  let cacheDir: string[] = []
  try {
    cacheDir = readdirSync(join(REPO_ROOT, ".opencode", "cache"))
  } catch {
    return best
  }
  for (const entry of cacheDir) {
    if (!entry.startsWith("fork-sync-") || !entry.endsWith(".json")) continue
    try {
      const data = readJsonFile(join(REPO_ROOT, ".opencode", "cache", entry))
      if (Array.isArray(data.snaps) && data.snaps.length >= best.length) best = data.snaps
    } catch {
      /* ignore malformed snapshots */
    }
  }
  return best
}

function cmdResolve(): number {
  const manifest = loadManifest()
  if (!git("rev-parse", "--verify", "MERGE_HEAD").ok) {
    console.error("resolve: no merge in progress (MERGE_HEAD missing). Nothing to do.")
    return 1
  }
  const files = unmergedFiles()
  if (files.length === 0) {
    console.log("resolve: no unmerged paths — nothing to do.")
    return 0
  }

  let snapshots = loadSnapshots()
  if (snapshots.length === 0) {
    // No preflight snapshot: build ours-vs-theirs on the fly from the merge.
    snapshots = []
    for (const file of files.filter((f) => f.endsWith("package.json"))) {
      const oursRaw = showFile("HEAD", file)
      const theirsRaw = showFile("MERGE_HEAD", file)
      if (oursRaw && theirsRaw) {
        try {
          snapshots.push(snapshotPackageJson(file, JSON.parse(oursRaw), JSON.parse(theirsRaw)))
        } catch {
          /* ignore */
        }
      }
    }
  }

  const auto: string[] = []
  const manual: { file: string; cls: ConflictClass }[] = []
  const reports: PkgMergeReport[] = []

  for (const file of files) {
    const cls = classifyConflict(file, manifest.pruneFromMain)
    switch (cls) {
      case "prune": {
        // Deleted-by-us or re-added under a DROP tree: always remove.
        if (!git("rm", "--quiet", "-f", "--", file).ok) {
          // Already absent from the worktree (index-only entry): unstage it.
          git("rm", "--cached", "--quiet", "--", file)
        }
        auto.push(`prune ${file}`)
        break
      }
      case "lock":
      case "generated": {
        git("checkout", "--theirs", "--", file)
        git("add", "--", file)
        auto.push(`${cls} ${file} (theirs${cls === "lock" ? "; run bun install after" : "; regenerate after"})`)
        break
      }
      case "fork-ours":
      case "meta-ours": {
        git("checkout", "--ours", "--", file)
        git("add", "--", file)
        auto.push(`${cls} ${file} (ours)`)
        break
      }
      case "pkg-union": {
        const oursRaw = showFile("HEAD", file)
        const theirsRaw = showFile("MERGE_HEAD", file)
        if (!oursRaw || !theirsRaw) {
          manual.push({ file, cls })
          break
        }
        try {
          const { merged, report } = mergePackageJson(file, JSON.parse(oursRaw), JSON.parse(theirsRaw), {
            workspaceExists: (entry) => {
              try {
                return readdirSync(join(REPO_ROOT, entry), { withFileTypes: true }).some((e) => e.isDirectory() || e.isFile())
              } catch {
                return false
              }
            },
            isDropWorkspace: (entry) => isDropPath(entry, manifest.pruneFromMain),
          })
          writeFileSync(join(REPO_ROOT, file), JSON.stringify(merged, null, 2) + "\n")
          git("add", "--", file)
          reports.push(report)
          auto.push(`pkg-union ${file}`)
        } catch (e) {
          console.error(`resolve: ${file} failed to merge: ${e}`)
          manual.push({ file, cls })
        }
        break
      }
      default:
        manual.push({ file, cls })
    }
  }

  // Loss detection: every snapshotted fork-only key must survive.
  const losses: string[] = []
  for (const s of snapshots) {
    try {
      const merged = readJsonFile(join(REPO_ROOT, s.file))
      for (const m of checkSnapshot(s, merged)) losses.push(`${s.file}: ${m}`)
    } catch {
      /* file may be pruned; ignore */
    }
  }

  console.log(`resolve: auto-resolved ${auto.length}/${files.length}`)
  for (const line of auto) console.log(`  auto  ${line}`)
  for (const r of reports) {
    if (r.overlapForkWins.length > 0)
      console.log(`  note  ${r.file} fork-wins (upstream changed the same key — review): ${r.overlapForkWins.join(", ")}`)
    if (r.overlapUpstreamWins.length > 0) console.log(`  note  ${r.file} upstream-wins: ${r.overlapUpstreamWins.join(", ")}`)
  }
  if (losses.length > 0) {
    console.error(`resolve: LOST fork-only keys (fix before committing):\n  ${losses.join("\n  ")}`)
  }
  if (manual.length > 0) {
    console.log(`resolve: MANUAL (${manual.length}) — resolve by hand per FORK.md, then re-run resolve:`)
    for (const m of manual) console.log(`  manual [${m.cls}] ${m.file}`)
    return 2
  }
  if (losses.length > 0) return 1
  console.log("resolve: clean. Next: delete untracked DROP leftovers, bun install, commit with a union-listing message, then fork:sync verify.")
  return 0
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(join(REPO_ROOT, path), "utf8").includes(needle)
  } catch {
    return false
  }
}

function workspaceDirExists(entry: string): boolean {
  try {
    return readdirSync(join(REPO_ROOT, entry)).length >= 0
  } catch {
    return false
  }
}

function cmdVerify(tag?: string): number {
  const manifest = loadManifest()
  const failures: string[] = []

  const unmerged = unmergedFiles()
  if (unmerged.length > 0) failures.push(`unmerged paths remain: ${unmerged.join(", ")}`)

  const dropTracked = trackedFiles(...manifest.pruneFromMain)
  if (dropTracked.length > 0)
    failures.push(`DROP paths still tracked (${dropTracked.length}): ${dropTracked.slice(0, 8).join(", ")}${dropTracked.length > 8 ? " …" : ""}`)

  // conflict markers anywhere outside DROP trees. The needle is built
  // dynamically so this file does not itself contain the literal.
  {
    const needle = "<".repeat(7) + " HEAD"
    const args = ["grep", "-l", needle, "--", ".", ...manifest.pruneFromMain.map((p) => `:(exclude)${p}`)]
    const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT })
    const hits = r.stdout.toString().trim()
    if (hits) failures.push(`conflict markers remain in:\n${hits}`)
  }

  const checks: { name: string; run(): string | undefined }[] = [
    {
      name: "quota routes registered",
      run: () =>
        fileContains("packages/opencode/src/server/routes/instance/httpapi/api.ts", "QuotaApi")
          ? undefined
          : "QuotaApi missing from httpapi/api.ts",
    },
    {
      name: "fork tools present in registry",
      run: () => {
        const need = ["BackgroundTool", "SqliteTool", "SympyTool", "MemoryTool"]
        const missing = need.filter((n) => !fileContains("packages/opencode/src/tool/registry.ts", n))
        return missing.length > 0 ? `tool/registry.ts missing fork tools: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "pause/resume/regenerate-title handlers",
      run: () =>
        fileContains("packages/opencode/src/server/routes/instance/httpapi/groups/session.ts", "regenerate")
          ? undefined
          : "regenerate-title handler missing from session group routes",
    },
    {
      name: "session groups",
      run: () => (trackedFiles("packages/schema/src/session-group*").length > 0 ? undefined : "packages/schema/src/session-group* missing"),
    },
    {
      name: "goal mode native control plane",
      run: () => {
        const missing: string[] = []
        if (!fileContains("packages/opencode/src/server/routes/instance/httpapi/api.ts", "GoalApi")) missing.push("GoalApi")
        if (!fileContains("packages/opencode/src/tool/registry.ts", "GoalTool")) missing.push("V1 GoalTool")
        if (!fileContains("packages/core/src/tool/builtins.ts", "GoalTool")) missing.push("V2 GoalTool")
        if (!fileContains("packages/opencode/src/session/prompt.ts", "GoalAutomation")) missing.push("V1 automation seam")
        if (!fileContains("packages/core/src/session/runner/llm.ts", "GoalAutomation")) missing.push("V2 automation seam")
        if (!fileContains("packages/core/src/goal/automation.ts", "GoalAutomationTable")) missing.push("durable reservation service")
        try {
          const migrations = readdirSync(join(REPO_ROOT, "packages/core/src/database/migration"))
          if (!migrations.some((name) => name.includes("goal") && name.endsWith(".ts"))) missing.push("Goal migrations")
        } catch {
          missing.push("Goal migrations")
        }
        return missing.length > 0 ? `Goal Mode missing: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "goal mode composer shelf",
      run: () => {
        const missing: string[] = []
        if (!fileContains("packages/app/src/app.tsx", "GoalsProvider")) missing.push("GoalsProvider")
        if (!fileContains("packages/app/src/components/prompt-input-v2.tsx", "GoalComposerShelf")) missing.push("GoalComposerShelf")
        if (!fileContains("packages/session-ui/src/v2/components/prompt-input/index.tsx", "goalControl")) missing.push("goalControl slot")
        return missing.length > 0 ? `Goal composer integration missing: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "goal auditor semantic gate",
      run: () => {
        const missing: string[] = []
        if (!fileContains("packages/schema/src/goal.ts", "AuditorPolicy")) missing.push("per-Goal AuditorPolicy")
        if (!fileContains("packages/core/src/config.ts", "auditor_prompt")) missing.push("global auditor_prompt")
        if (!fileContains("packages/core/src/goal/auditor.ts", "audit_verdict")) missing.push("audit_verdict tool")
        if (!fileContains("packages/core/src/goal/auditor-prompt.ts", "PROTOCOL_PROMPT")) missing.push("host-owned auditor protocol")
        if (!fileContains("packages/schema/src/goal.ts", "continuationPrompt")) missing.push("auditor continuation artifact")
        if (!fileContains("packages/core/src/goal/sql.ts", "continuation_prompt")) missing.push("durable continuation prompt")
        if (!fileContains("packages/core/src/goal/automation.ts", "renderContinuationPrompt")) missing.push("auditor continuation wrapper")
        for (const tool of ["read", "grep", "glob"]) {
          if (!fileContains("packages/core/src/goal/auditor.ts", `${tool}: Tool.make`)) missing.push(`auditor ${tool} tool`)
        }
        if (!fileContains("packages/core/src/session/runner/llm.ts", "GoalAuditor")) missing.push("V2 auditor seam")
        if (!fileContains("packages/opencode/src/session/prompt.ts", "GoalAuditor")) missing.push("V1 auditor seam")
        if (!fileContains("packages/app/src/components/settings-v2/general.tsx", "AuditorPromptDialog")) missing.push("auditor prompt settings")
        if (!fileContains("packages/app/src/components/goal-composer-shelf.tsx", "goal-auditor-model")) missing.push("per-Goal auditor model picker")
        return missing.length > 0 ? `Goal auditor missing: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "shared special-agent completion protocol",
      run: () => {
        const missing: string[] = []
        const shared = "packages/core/src/special-agent-completion.ts"
        if (!fileContains(shared, "runAdaptiveToolChoice")) missing.push("shared tool-choice negotiation")
        if (!fileContains(shared, "runTerminalCompletionWithTranscript")) missing.push("shared terminal protocol")
        if (!fileContains(shared, "appendCompletionRepair")) missing.push("same-session repair transcript")
        if (!fileContains("packages/core/src/prompt-revisor.ts", "runTerminalCompletion")) missing.push("Prompt Revisor shared completion seam")
        if (!fileContains("packages/core/src/session/title.ts", "runTerminalCompletion")) missing.push("V2 title shared completion seam")
        if (!fileContains("packages/core/src/goal/auditor.ts", "runTerminalCompletion")) missing.push("Goal Auditor shared completion seam")
        if (!fileContains("packages/opencode/src/session/prompt.ts", "runTerminalCompletionWithTranscript")) missing.push("V1 title shared completion seam")
        if (!fileContains("packages/opencode/src/prompt-revisor/runtime.ts", "generateAdaptive")) missing.push("Prompt Revisor host compatibility seam")
        if (!fileContains("packages/opencode/src/special-agent/model-message-bridge.ts", "appendModelCompletionRepair")) missing.push("legacy transcript bridge")
        return missing.length > 0 ? `Special-agent protocol missing: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "JetBrains ACP YOLO integration",
      run: () => {
        const missing: string[] = []
        if (!fileContains("packages/opencode/src/agent/agent.ts", 'name: "yolo"')) missing.push("native yolo agent")
        if (!fileContains("packages/opencode/src/tool/shell.ts", "catastrophicDeleteReason")) missing.push("catastrophic shell guard")
        if (!fileContains("packages/opencode/script/install-jetbrains-acp.ts", "OpenCode (OpenFork)")) missing.push("JetBrains installer")
        if (!fileContains("packages/opencode/src/tool/registry.ts", "CheckpointTool")) missing.push("checkpoint tool")
        return missing.length > 0 ? `JetBrains ACP integration missing: ${missing.join(", ")}` : undefined
      },
    },
    {
      name: "updater stays fork-pinned",
      run: () =>
        fileContains("packages/desktop/src/main/constants.ts", "UPDATER_ENABLED = false")
          ? undefined
          : "UPDATER_ENABLED = false missing from desktop constants",
    },
    {
      name: "core memory export resolvable",
      run: () => {
        try {
          const pkg = readJsonFile(join(REPO_ROOT, "packages/core/package.json"))
          return pkg.exports?.["./memory"] ? undefined : "packages/core/package.json exports./memory missing (v1.18.29 regression)"
        } catch {
          return "packages/core/package.json unreadable"
        }
      },
    },
    {
      name: "workspaces installable (no globs, no DROP, all exist)",
      run: () => {
        try {
          const pkg = readJsonFile(join(REPO_ROOT, "package.json"))
          const entries = pkg.workspaces?.packages
          if (!Array.isArray(entries)) return "root workspaces.packages is not a list"
          const bad = entries.filter(
            (e) =>
              typeof e !== "string" ||
              e.endsWith("/*") ||
              isDropPath(e, manifest.pruneFromMain) ||
              !workspaceDirExists(e),
          )
          return bad.length > 0
            ? `root workspaces.packages has uninstallable entries (v1.18.29 broke bun install this way): ${bad.join(", ")}`
            : undefined
        } catch {
          return "root package.json unreadable"
        }
      },
    },
    {
      name: "websearch union (fork engines + upstream)",
      run: () => {
        if (!fileContains("packages/opencode/src/tool/websearch.ts", "SearxngWebSearch"))
          return "fork SearxngWebSearch engine missing from websearch.ts (union dropped fork engines)"
        if (!fileContains("packages/opencode/src/tool/websearch.ts", "McpWebSearch"))
          return "upstream McpWebSearch engine missing from websearch.ts (union dropped upstream engines)"
        return undefined
      },
    },
  ]
  for (const c of checks) {
    const fail = c.run()
    if (fail) failures.push(`${c.name}: ${fail}`)
  }

  if (tag) {
    try {
      const data = readJsonFile(snapshotPath(tag))
      for (const s of data.snaps as PkgSnapshot[]) {
        try {
          const merged = readJsonFile(join(REPO_ROOT, s.file))
          for (const m of checkSnapshot(s, merged)) failures.push(`snapshot loss ${s.file}: ${m}`)
        } catch {
          /* pruned; ignore */
        }
      }
    } catch {
      failures.push(`no preflight snapshot at .opencode/cache/fork-sync-${tag}.json — run fork:sync preflight next time`)
    }
  }

  if (failures.length > 0) {
    console.error(`verify: FAILED (${failures.length})\n- ${failures.join("\n- ")}`)
    return 1
  }
  console.log("verify: all static checks pass. Still required by hand: typechecks (opencode/app/desktop), focused tests, desktop boot.")
  return 0
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, arg, arg2] = Bun.argv.slice(2)
  let code = 1
  if (cmd === "preflight" && arg) code = cmdPreflight(arg)
  else if (cmd === "resolve") code = cmdResolve()
  else if (cmd === "verify") code = cmdVerify(arg === "--tag" ? arg2 : arg)
  else {
    console.error("usage: fork-sync preflight <tag> | resolve | verify [--tag <tag>]")
    code = 1
  }
  process.exit(code)
}
