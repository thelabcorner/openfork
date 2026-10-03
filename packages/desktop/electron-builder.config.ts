import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// Older OpenCode-branded builds installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry as a compatibility alias
// while the canonical OpenFork desktop identity is ai.openfork.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.openfork.desktop.dev",
  beta: "ai.openfork.desktop.beta",
  prod: "ai.openfork.desktop",
} as const
const packagedIcons = "icons/prod"

const getBase = (appId: string): Configuration => ({
  artifactName: "openfork-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // OpenFork now publishes installers. Without a provider, electron-builder's
  // update-info step (`computeChannelNames`) dereferences a null publish config
  // and throws after the artifacts are already built. Point the feed at the
  // fork (never anomalyco) and always mark these as prereleases. `--publish
  // never` in CI still prevents electron-builder from uploading; our workflow
  // attaches the artifacts explicitly.
  publish: [
    {
      provider: "github",
      owner: "thelabcorner",
      repo: "openfork",
      releaseType: "prerelease",
    },
  ],
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.openfork.desktop" becomes
  // "ai.openfork.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/openfork-cli*",
    "!resources/opencode-cli*",
    "!resources/tunnel/**/*",
    "!resources/worktree-store/**/*",
  ],
  extraResources: [
    {
      // Debug runs use resources/icons (the green Dev artwork). Installers
      // deliberately ship the blue production artwork instead.
      from: `${packagedIcons}/`,
      to: "icons/",
    },
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["openfork-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      // SnapEye/SnapDOM/SnapDiff and the MIT gifenc stream/LZW primitives are
      // bundled into the lazy browser visual runtime. Ship one canonical notice
      // outside app.asar so installer/package recipients can inspect it directly.
      from: "../browser-visual/THIRD_PARTY_NOTICES.txt",
      to: "licenses/SnapEye-THIRD_PARTY_NOTICES.txt",
    },
    {
      // OXP's pinned OpenAI runtime is a real filesystem executable. Keep it
      // outside app.asar, together with its release license/SBOM sidecars.
      from: "resources/tunnel/",
      to: "tunnel/",
    },
    {
      // The pinned worktree-store sidecar is a real filesystem executable tree
      // staged by scripts/fetch-worktree-store.ts. Keep it outside app.asar
      // with its VERSION/STAGE.json stamps so the packaged verifier can check it.
      from: "resources/worktree-store/",
      to: "worktree-store/",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `${packagedIcons}/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    // Dev pre-releases are unsigned: Apple notarization needs credentials this
    // fork does not have. Set OPENCODE_DESKTOP_NOTARIZE=1 for a signed release.
    notarize: process.env.OPENCODE_DESKTOP_NOTARIZE === "1",
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenFork",
    schemes: ["opencode"],
  },
  win: {
    icon: `${packagedIcons}/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `${packagedIcons}/icon.ico`,
    installerHeaderIcon: `${packagedIcons}/icon.ico`,
  },
  linux: {
    icon: packagedIcons,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenFork Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "openfork-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenFork Beta",
        protocols: { name: "OpenFork Beta", schemes: ["opencode"] },
        // Keep updater metadata on the OpenFork release feed configured above.
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "openfork-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenFork",
        protocols: { name: "OpenFork", schemes: ["opencode"] },
        // Keep updater metadata on the OpenFork release feed configured above.
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "openfork", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
