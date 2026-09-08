export function childRuntimeEnvPatch(versions: { electron?: string } = process.versions): Record<string, string> {
  // The utility process is already running when this is applied. The flag only
  // changes how descendant electron.exe launches behave, which makes
  // `spawn(process.execPath, [script])` act as Node instead of recursively
  // booting the Electron application.
  return versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}
}
