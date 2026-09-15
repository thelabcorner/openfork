import { lstatSync } from "node:fs"
import { lstat, mkdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  SNAPEYE_BASELINES_DIR,
  SNAPEYE_ROOT,
  SNAPEYE_RUNS_DIR,
  VisualArtifactError,
  isValidSnapEyeFilename,
  isValidSnapEyeName,
  isValidSnapEyeRunId,
} from "./protocol"

export interface VisualArtifactPaths {
  project: string
  root: string
  baselines: string
  runs: string
}

/** Canonicalize the trusted broker project root before deriving `.snapeye`. */
export const resolveVisualArtifactPaths = async (directory: string): Promise<VisualArtifactPaths> => {
  if (typeof directory !== "string" || directory.length === 0) throw invalidPath(directory)
  const project = await realpath(resolve(directory)).catch(() => {
    throw invalidPath(directory)
  })
  const projectStat = await stat(project).catch(() => null)
  if (!projectStat?.isDirectory()) throw invalidPath(directory)

  const root = safeJoin(project, SNAPEYE_ROOT)
  // The project directory is allowed to have been reached through a symlink;
  // `realpath` above deliberately canonicalizes that trusted root. The derived
  // .snapeye boundary itself, however, must never be a link/junction.
  assertNoLinkEscape(root, root)
  return {
    project,
    root,
    baselines: safeJoin(root, SNAPEYE_BASELINES_DIR),
    runs: safeJoin(root, SNAPEYE_RUNS_DIR),
  }
}

export const ensureVisualArtifactLayout = async (paths: VisualArtifactPaths): Promise<void> => {
  await ensureSafeDirectory(paths.root, paths.root)
  await ensureSafeDirectory(paths.root, paths.baselines)
  await ensureSafeDirectory(paths.root, paths.runs)
}

export const baselineFilePath = (paths: VisualArtifactPaths, name: string, extension: ".png" | ".json"): string => {
  if (!isValidSnapEyeName(name)) throw new VisualArtifactError("INVALID_NAME", `Invalid SnapEye baseline name: ${JSON.stringify(name)}`)
  return safeJoin(paths.root, SNAPEYE_BASELINES_DIR, `${name}${extension}`)
}

export const runFilePath = (paths: VisualArtifactPaths, runId: string, filename: string): string => {
  if (!isValidSnapEyeRunId(runId)) throw new VisualArtifactError("INVALID_RUN_ID", `Invalid SnapEye run id: ${JSON.stringify(runId)}`)
  if (!isValidSnapEyeFilename(filename)) throw new VisualArtifactError("INVALID_ARTIFACT", `Invalid SnapEye artifact filename: ${JSON.stringify(filename)}`)
  return safeJoin(paths.root, SNAPEYE_RUNS_DIR, runId, filename)
}

export const safeJoin = (root: string, ...segments: string[]): string => {
  if (!isAbsolute(root)) throw invalidPath(root)
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length === 0 || segment === "." || segment === "..") throw invalidPath(segment)
    if (segment.includes("/") || segment.includes("\\") || isAbsolute(segment)) throw invalidPath(segment)
  }
  const target = resolve(join(root, ...segments))
  if (!isInside(root, target)) throw invalidPath(segments.join("/"))
  return target
}

export const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Reject any existing symlink/junction from the artifact root to `target`.
 * Node reports Windows junctions through lstat().isSymbolicLink(), so this is
 * the same guard on NTFS and POSIX filesystems.
 */
export const assertNoLinkEscape = (root: string, target: string): void => {
  if (!isAbsolute(root) || !isAbsolute(target) || !isInside(root, target)) throw invalidPath(target)
  const rootStat = lstatIfExists(root)
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) throw invalidPath(root)

  const rel = relative(root, target)
  if (!rel) return
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    const entry = lstatIfExists(current)
    if (!entry) return
    if (entry.isSymbolicLink()) throw invalidPath(current)
  }
}

export const ensureSafeDirectory = async (root: string, directory: string): Promise<void> => {
  assertNoLinkEscape(root, directory)
  await mkdir(directory, { recursive: true })
  assertNoLinkEscape(root, directory)
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalidPath(directory)
}

export const ensureSafeParent = async (root: string, file: string): Promise<void> => {
  const parent = resolve(file, "..")
  assertNoLinkEscape(root, file)
  await ensureSafeDirectory(root, parent)
  assertNoLinkEscape(root, file)
}

const lstatIfExists = (path: string): ReturnType<typeof lstatSync> | null => {
  try {
    return lstatSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

const invalidPath = (value: unknown) =>
  new VisualArtifactError("INVALID_PATH", `SnapEye refused an unsafe path: ${JSON.stringify(String(value))}`)
