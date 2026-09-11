// Install helper — writes NativeMessagingHosts manifest JSON per OS/browser.
// Mirrors Codex (com.openai.codexextension at ~/.codex/plugins/cache...) and
// Claude (com.anthropic.claude_code_browser_extension) patterns from research.md.
// Supports Chrome, Brave, Edge; polyfills per-browser dirs as community polyfill does.

import { homedir, platform } from "node:os"
import { join, dirname, resolve } from "node:path"
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"

export const HOST_NAME = "com.opencode.desktop"

interface InstallOptions {
  extensionId: string
  hostPath: string // absolute path to native-host executable/script
  browsers?: Array<"chrome" | "chrome-beta" | "chrome-canary" | "brave" | "edge" | "chromium">
  dryRun?: boolean
}

interface ManifestJson {
  name: string
  description: string
  path: string
  type: "stdio"
  allowed_origins: string[]
}

// Per-OS manifest locations (user-level). Matches native-messaging spec:
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
function manifestDirs(browser: string): string[] {
  const home = homedir()
  const plat = platform()
  if (plat === "darwin") {
    const base: Record<string, string> = {
      chrome: join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      "chrome-beta": join(home, "Library", "Application Support", "Google", "Chrome Beta", "NativeMessagingHosts"),
      "chrome-canary": join(home, "Library", "Application Support", "Google", "Chrome Canary", "NativeMessagingHosts"),
      brave: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      edge: join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      chromium: join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
    }
    return base[browser] ? [base[browser]] : []
  }
  if (plat === "win32") {
    // Windows uses registry key HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>
    // We return a sentinel so caller knows to write registry; JSON file still lives beside host.
    // For file-based install we use the same relative dir under AppData for manual verification.
    const base: Record<string, string> = {
      chrome: join(home, "AppData", "Local", "Google", "Chrome", "User Data", "NativeMessagingHosts"),
      brave: join(home, "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data", "NativeMessagingHosts"),
      edge: join(home, "AppData", "Local", "Microsoft", "Edge", "User Data", "NativeMessagingHosts"),
    }
    return base[browser] ? [base[browser]] : []
  }
  // linux
  const base: Record<string, string> = {
    chrome: join(home, ".config", "google-chrome", "NativeMessagingHosts"),
    "chrome-beta": join(home, ".config", "google-chrome-beta", "NativeMessagingHosts"),
    brave: join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    edge: join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
    chromium: join(home, ".config", "chromium", "NativeMessagingHosts"),
  }
  return base[browser] ? [base[browser]] : []
}

function buildManifest(extensionId: string, hostPath: string): ManifestJson {
  return {
    name: HOST_NAME,
    description: "opencode native messaging host — bridges the Chrome extension to the desktop app",
    path: resolve(hostPath),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
}

export function installManifests(opts: InstallOptions): { written: string[]; manifests: ManifestJson[] } {
  const browsers = opts.browsers ?? (["chrome", "brave", "edge"] as const as string[])
  const written: string[] = []
  const manifests: ManifestJson[] = []

  for (const browser of browsers) {
    const dirs = manifestDirs(browser)
    for (const dir of dirs) {
      const manifest = buildManifest(opts.extensionId, opts.hostPath)
      const filePath = join(dir, `${HOST_NAME}.json`)
      manifests.push(manifest)
      if (opts.dryRun) {
        written.push(filePath + " (dry-run)")
        continue
      }
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
        written.push(filePath)
      } catch (e) {
        // Best-effort per browser — one failure shouldn't block others
        console.error(`[install] failed for ${browser} at ${filePath}:`, e)
      }
    }
  }

  // Windows registry instruction (cannot write via fs alone — document for user)
  if (platform() === "win32" && !opts.dryRun) {
    const manifest = buildManifest(opts.extensionId, opts.hostPath)
    // Write a reference manifest beside the host so reg import can point at it
    const refDir = dirname(resolve(opts.hostPath))
    const refPath = join(refDir, `${HOST_NAME}.json`)
    try {
      writeFileSync(refPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
      written.push(refPath + " (win ref)")
    } catch {}
    const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
    console.log(`[install] Windows: create registry key ${regKey} with default value -> ${refPath}`)
    console.log(`[install]   reg add "${regKey}" /ve /t REG_SZ /d "${refPath}" /f`)
    // Also note: registry write could be done via `reg` spawn if desired — we log instruction for now
  }

  return { written, manifests }
}

// Template filler for com.opencode.desktop.json.template
export function fillTemplate(templatePath: string, extensionId: string, hostPath: string): ManifestJson {
  const raw = readFileSync(templatePath, "utf8")
  const filled = raw.replaceAll("__EXTENSION_ID__", extensionId).replaceAll("__HOST_PATH__", resolve(hostPath))
  return JSON.parse(filled) as ManifestJson
}

// ---- CLI ----
if (import.meta.main) {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dryRun = args.includes("--dry-run")
  const extensionId = get("--extension-id") ?? process.env.OPENCODE_EXTENSION_ID
  const hostPath = get("--host-path") ?? get("--host") ?? join(process.cwd(), "native-host.js")

  if (!extensionId) {
    console.error("Usage: bun host/install.ts --extension-id <chrome-extension-id> [--host-path <path>] [--dry-run]")
    console.error("  Or set OPENCODE_EXTENSION_ID env.")
    process.exit(1)
  }
  if (!existsSync(hostPath) && !dryRun) {
    console.warn(`[install] host path does not exist yet: ${hostPath} — manifest will still be written`)
  }
  const result = installManifests({ extensionId, hostPath, dryRun })
  console.log(`[install] wrote ${result.written.length} manifest(s):`)
  for (const p of result.written) console.log(`  - ${p}`)
}
