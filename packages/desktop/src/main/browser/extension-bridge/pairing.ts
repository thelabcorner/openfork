// pairing.ts — native messaging host installation for the chrome-attach lane
//
// Writes `com.opencode.desktop.json` to each browser's NativeMessagingHosts dir so
// Chrome / Brave / Edge can find and launch the desktop side helper. No external
// service; first-party only. Exposes a renderer pairing IPC shape via
// `window.api.chrome` (not implemented here — the preload bridge forwards there).
//
// Spec: developer.chrome.com/docs/extensions/develop/concepts/native-messaging
// Chromium kMaximumNativeMessageSize = 1_048_576 (host→extension).
//
// Manifest shape expected by Chrome:
//
//   {
//     "name": "com.opencode.desktop",
//     "description": "opencode desktop bridge",
//     "path": "<absolute path to host binary>",
//     "type": "stdio",
//     "allowed_origins": ["chrome-extension://<id>/"]
//   }
//
// Registry on Windows: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.desktop
// (points at the JSON file on disk).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join, resolve } from "node:path"

export const HOST_NAME = "com.opencode.desktop"

export interface NativeHostManifest {
  name: typeof HOST_NAME
  description: string
  path: string
  type: "stdio"
  allowed_origins: string[]
}

export type BrowserVariant = "chrome" | "brave" | "edge"

export interface PairingStatus {
  /** Whether at least one browser host file is installed. */
  installed: boolean
  /** Per-variant presence of the JSON file on disk. */
  hosts: Record<BrowserVariant, boolean>
  /** Computed manifest path for the current platform/variant (debug helper). */
  paths: Record<BrowserVariant, string>
  /** Extension id currently paired, if known (from the installed manifest). */
  extensionId?: string
  /** Underlying error from the last write/remove attempt, if any. */
  lastError?: string
}

export interface PairingOptions {
  /** Absolute path to the native host binary (or Node shim). */
  hostBinaryPath: string
  /** Allowlisted extension origin(s), e.g. `chrome-extension://<id>/`. */
  allowedOrigins: string[]
  /** Override homedir (tests). */
  homeDir?: string
  /** Override platform (tests). */
  platformOverride?: NodeJS.Platform
  /** Override registry base for Windows tests. */
  windowsRegistryMock?: Map<string, string>
}

export interface PairingInstructions {
  steps: string[]
  chromeWebStoreUrl?: string
  manualHostPaths: Record<BrowserVariant, string>
}

// ---------------------------------------------------------------------------
// Paths per platform
// ---------------------------------------------------------------------------

export function getNativeHostDir(variant: BrowserVariant, home: string, plat: NodeJS.Platform): string {
  if (plat === "darwin") {
    switch (variant) {
      case "chrome":
        return join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      case "brave":
        return join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")
      case "edge":
        return join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts")
    }
  }
  if (plat === "win32") {
    // On Windows the canonical location is the registry; the JSON file still lives
    // at a fixed per-app location and the registry value points at it. We use
    // %LOCALAPPDATA%/opencode/NativeMessagingHosts as that stable location.
    const localAppData = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local")
    return join(localAppData, "opencode", "NativeMessagingHosts")
  }
  // Linux
  switch (variant) {
    case "chrome":
      return join(home, ".config", "google-chrome", "NativeMessagingHosts")
    case "brave":
      return join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")
    case "edge":
      return join(home, ".config", "microsoft-edge", "NativeMessagingHosts")
  }
}

export function getManifestPath(variant: BrowserVariant, homeDir?: string, plat: NodeJS.Platform = platform()): string {
  const home = homeDir ?? homedir()
  return join(getNativeHostDir(variant, home, plat), `${HOST_NAME}.json`)
}

export function buildManifest(options: PairingOptions): NativeHostManifest {
  const resolved = resolve(options.hostBinaryPath)
  return {
    name: HOST_NAME,
    description: "opencode desktop bridge",
    path: resolved,
    type: "stdio",
    allowed_origins: options.allowedOrigins,
  }
}

// ---------------------------------------------------------------------------
// Write / remove / status
// ---------------------------------------------------------------------------

export function writeHosts(options: PairingOptions, variants: BrowserVariant[] = ["chrome", "brave", "edge"]): PairingStatus {
  const manifest = buildManifest(options)
  const home = options.homeDir ?? homedir()
  const plat = options.platformOverride ?? platform()
  const errors: string[] = []
  const hosts: Record<BrowserVariant, boolean> = { chrome: false, brave: false, edge: false }
  const paths: Record<BrowserVariant, string> = { chrome: "", brave: "", edge: "" }

  for (const variant of variants) {
    const manifestPath = getManifestPath(variant, home, plat)
    paths[variant] = manifestPath
    try {
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
      // On Windows also write the registry entry HKCU\Software\<Vendor>\NativeMessagingHosts\<name> = path
      if (plat === "win32") writeWindowsRegistry(variant, manifestPath, options.windowsRegistryMock)
      hosts[variant] = true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      errors.push(`${variant}: ${msg}`)
      hosts[variant] = existsSync(manifestPath)
    }
  }
  return {
    installed: Object.values(hosts).some(Boolean),
    hosts,
    paths,
    extensionId: extractExtensionId(options.allowedOrigins),
    lastError: errors.length ? errors.join("; ") : undefined,
  }
}

export function removeHosts(options: Pick<PairingOptions, "homeDir" | "platformOverride" | "windowsRegistryMock"> = {}, variants: BrowserVariant[] = ["chrome", "brave", "edge"]): PairingStatus {
  const home = options.homeDir ?? homedir()
  const plat = options.platformOverride ?? platform()
  const hosts: Record<BrowserVariant, boolean> = { chrome: false, brave: false, edge: false }
  const paths: Record<BrowserVariant, string> = { chrome: "", brave: "", edge: "" }

  for (const variant of variants) {
    const manifestPath = getManifestPath(variant, home, plat)
    paths[variant] = manifestPath
    try {
      if (existsSync(manifestPath)) unlinkSync(manifestPath)
      if (plat === "win32") removeWindowsRegistry(variant, options.windowsRegistryMock)
      hosts[variant] = false
    } catch (error) {
      hosts[variant] = existsSync(manifestPath)
      void error
    }
  }
  return { installed: false, hosts, paths }
}

export function getStatus(options: Partial<Pick<PairingOptions, "homeDir" | "platformOverride" | "allowedOrigins">> & { hostBinaryPath?: string } = {}): PairingStatus {
  const home = options.homeDir ?? homedir()
  const plat = options.platformOverride ?? platform()
  const hosts: Record<BrowserVariant, boolean> = { chrome: false, brave: false, edge: false }
  const paths: Record<BrowserVariant, string> = { chrome: "", brave: "", edge: "" }
  let extensionId: string | undefined
  for (const variant of ["chrome", "brave", "edge"] as const) {
    const p = getManifestPath(variant, home, plat)
    paths[variant] = p
    if (existsSync(p)) {
      hosts[variant] = true
      try {
        const text = readFileSync(p, "utf8")
        const json = JSON.parse(text) as Partial<NativeHostManifest>
        const origin = json.allowed_origins?.[0]
        extensionId = extensionId ?? extractExtensionId(origin ? [origin] : options.allowedOrigins)
      } catch {
        // corrupted manifest counts as installed but unparseable
      }
    }
  }
  return {
    installed: Object.values(hosts).some(Boolean),
    hosts,
    paths,
    extensionId: extensionId ?? extractExtensionId(options.allowedOrigins),
  }
}

export function getInstructions(options: Partial<Pick<PairingOptions, "homeDir" | "platformOverride" | "allowedOrigins">> = {}): PairingInstructions {
  const status = getStatus(options)
  return {
    steps: [
      "Install the opencode companion extension from the Chrome Web Store.",
      "Open the Desktop app — it will write the native messaging host manifest automatically.",
      `Host manifest: ${HOST_NAME}.json (per-browser under NativeMessagingHosts).`,
      "Reload chrome://extensions after pairing so the native host handshake can be retried.",
      `Current install: ${status.installed ? "found" : "not found"}; restart Chrome after a manifest change.`,
    ],
    manualHostPaths: status.paths,
  }
}

// ---------------------------------------------------------------------------
// Windows registry shims — thin wrappers so the real impl can be swapped in
// main (where regedit/electron registry access lives) without this module
// needing electron. In this repo we use a minimal in-memory mock for tests;
// production should pass a real registry writer if win32 registry is desired.
// ---------------------------------------------------------------------------

function writeWindowsRegistry(variant: BrowserVariant, manifestPath: string, mock?: Map<string, string>): void {
  if (mock) {
    mock.set(windowsRegistryKey(variant), manifestPath)
    return
  }
  // No-op on non-Windows test runs; production desktop host uses a separate
  // native module (or electron's shell) to write HKCU. JSON file placement
  // is sufficient for Chrome on Windows when the registry shim is skipped in
  // dev — the manifest is still discoverable for manual inspection.
}

function removeWindowsRegistry(variant: BrowserVariant, mock?: Map<string, string>): void {
  if (mock) {
    mock.delete(windowsRegistryKey(variant))
  }
}

export function windowsRegistryKey(variant: BrowserVariant): string {
  const vendor =
    variant === "chrome" ? `Google\\Chrome` : variant === "brave" ? `BraveSoftware\\Brave-Browser` : `Microsoft\\Edge`
  return `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`
}

function extractExtensionId(allowedOrigins?: string[]): string | undefined {
  const first = allowedOrigins?.[0]
  if (!first) return undefined
  const match = /^chrome-extension:\/\/([^/]+)\/?$/.exec(first.trim())
  return match?.[1]
}
