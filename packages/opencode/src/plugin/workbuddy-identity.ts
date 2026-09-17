/**
 * Static identity the official WorkBuddy desktop presents upstream.
 *
 * Extracted from the installed bundle (2026-09-16): the desktop spawns its
 * agent CLI with `CLIENT_INFO_*` env vars (`main/client-info-env.js`,
 * `WORKBUDDY_PLATFORM = "WorkBuddy"`), the CLI composes its User-Agent as
 * `<platform>/<version> <productName>/<version> <userAgentExtension>`
 * (`codebuddy.js` `UserAgentHttpInterceptor.buildUserAgent`), stamps
 * `X-Product: <deploymentType|"SaaS">` (`ProductEndpointHttpInterceptor`)
 * and `X-IDE-Type/Name/Version` from client info.
 *
 * This module reproduces ONLY that static application identity. It
 * deliberately does NOT fabricate per-device attestation (Qimei36,
 * machineId, `X-Private-Data`) — that is first-party evidence we cannot
 * honestly produce, and forging it would be circumventing enforcement rather
 * than removing gratuitous fingerprints.
 */

import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export type WorkBuddyIdentity = {
  platform: string
  productName: string
  appVersion: string
  cliVersion: string
  product: string
}

const FALLBACK: WorkBuddyIdentity = {
  platform: "WorkBuddy",
  productName: "WorkBuddy AI",
  appVersion: "5.5.2",
  cliVersion: "2.137.1",
  product: "SaaS",
}

function candidateRoots(): string[] {
  const roots: string[] = []
  if (process.env.WORKBUDDY_INSTALL_DIR) roots.push(process.env.WORKBUDDY_INSTALL_DIR)
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    roots.push(join(local, "Programs", "WorkBuddyAI"), join(local, "Programs", "Tencent WorkBuddy"))
    if (process.env.PROGRAMFILES) roots.push(join(process.env.PROGRAMFILES, "WorkBuddyAI"))
  } else if (process.platform === "darwin") {
    roots.push(
      "/Applications/WorkBuddy AI.app/Contents/Resources",
      "/Applications/Tencent WorkBuddy.app/Contents/Resources",
      join(homedir(), "Applications", "WorkBuddy AI.app", "Contents", "Resources"),
    )
  } else {
    roots.push("/opt/WorkBuddyAI/resources", join(homedir(), ".local", "share", "WorkBuddyAI", "resources"))
  }
  return roots
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** The CLI bundle's own version lives under the @tencent-ai/codebuddy-code key. */
function deepFindCliVersion(node: unknown, depth = 0): string | undefined {
  if (!node || typeof node !== "object" || depth > 6) return undefined
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "@tencent-ai/codebuddy-code" && value && typeof value === "object") {
      const version = (value as Record<string, unknown>).version
      if (typeof version === "string" && version) return version
    }
    const found = deepFindCliVersion(value, depth + 1)
    if (found) return found
  }
  return undefined
}

let cached: WorkBuddyIdentity | undefined

/** Resolve the installed app/CLI versions, falling back to known-good values. */
export function resolveWorkBuddyIdentity(): WorkBuddyIdentity {
  if (cached) return cached
  const identity = { ...FALLBACK }
  for (const root of candidateRoots()) {
    const resources = root.endsWith("resources") ? root : join(root, "resources")
    if (!existsSync(resources)) continue
    const manifest = readJson(join(resources, "install-manifest.json"))
    if (manifest?.appVersion) identity.appVersion = String(manifest.appVersion)
    const cliPkg = readJson(join(resources, "app.asar.unpacked", "cli", "package.json"))
    const cliVersion = deepFindCliVersion(cliPkg)
    if (cliVersion) identity.cliVersion = cliVersion
    break
  }
  cached = identity
  return identity
}

/**
 * The exact User-Agent the official desktop CLI sends on REST calls.
 * Verified live 2026-09-16: the `/v3/config` UA gate accepts this value and
 * still returns the full model catalog.
 */
export function workBuddyUserAgent(): string {
  const id = resolveWorkBuddyIdentity()
  return `${id.platform}/${id.appVersion} ${id.productName}/${id.appVersion} CLI/${id.cliVersion}`
}

/** Static first-party application headers (never device attestation). */
export function workBuddyClientHeaders(): Record<string, string> {
  const id = resolveWorkBuddyIdentity()
  return {
    "X-Product": id.product,
    "X-IDE-Type": id.platform,
    "X-IDE-Name": id.platform,
    "X-IDE-Version": id.appVersion,
  }
}
