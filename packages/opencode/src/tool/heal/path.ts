// Heal layer — extracted from read/path.ts and read/inspect.ts for reuse
// across edit, write, patch, grep, glob, project, symbols, test, archive, etc.
export {
  resolveReadPath,
  fixDotUserPath,
  fixUsersUsers,
  isPosixAbsoluteOnWindows,
  posixSuffixes,
  extensionFlips,
  stemOf,
  sameStem,
  isInside,
  coerceFilePaths,
  statPath,
  escapeGlob,
} from "../read/path"

export { renderHeal, renderGrep, aroundWindow, compilePattern } from "../read/inspect"
