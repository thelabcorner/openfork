import path from "path"
import { OxpError } from "./error"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export interface ExplicitLocation {
  readonly rootID?: OxpSchema.RootID
  readonly path?: string
}

/**
 * OXP never infers an external caller's workspace from resident OpenFork state.
 * A root ID may address the whole root or qualify a relative path; without it,
 * the caller must provide an absolute native/virtual spelling.
 */
export function requireExplicit(input: ExplicitLocation, operation: string) {
  if (input.rootID) return
  if (!input.path) throw new OxpError.RootRequired({ detail: `${operation} requires an explicit approved root or path` })
  const value = input.path.trim()
  if (!value || (!path.isAbsolute(value) && !/^[/\\]/.test(value))) {
    throw new OxpError.RootRequired({ detail: `Relative ${operation} paths require an explicit approved root` })
  }
}

export function targetPath(root: OxpRoot.ResolvedPath | OxpRoot.ResolvedRoot) {
  return "path" in root ? root.path : root.canonicalPath
}

export * as OxpLocation from "./location"
