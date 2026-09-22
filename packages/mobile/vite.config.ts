import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import appPlugin from "../app/vite.js"
import { ENV_PROXY_TARGET, ENV_RUN_ID } from "./dev/constants"
import { handshakePath } from "./dev/handshake"
import { privateDevIngressMiddleware, rejectPublicDevUpgrade } from "./dev/ingress"
import { createApiProxy } from "./dev/proxy"
import { createTargetResolver } from "./dev/target"

const API_PREFIXES = [
  "agent",
  "api",
  "auth",
  "command",
  "config",
  "devices",
  "event",
  "experimental",
  "file",
  "find",
  "fork",
  "formatter",
  "fs",
  "global",
  "goal",
  "instance",
  "log",
  "lsp",
  "mcp",
  "pair",
  "path",
  "permission",
  "project",
  "provider",
  "pty",
  "question",
  "quota",
  "session",
  "session-group",
  "skill",
  "sync",
  "tool",
  "tui",
  "usage",
  "vcs",
]

const mobileDir = dirname(fileURLToPath(import.meta.url))
const sdkSourceDir = fileURLToPath(new URL("../sdk/js/src/", import.meta.url))
const appPwaClient = fileURLToPath(new URL("../app/src/pwa-client.tsx", import.meta.url))
const appToast = fileURLToPath(new URL("../app/src/utils/toast.tsx", import.meta.url))
const appToastNormalized = appToast.replaceAll("\\", "/")
const appPwaToast = fileURLToPath(new URL("../app/src/utils/toast-pwa.tsx", import.meta.url))
const sharedStaticAssets = [
  {
    url: "/assets/Inter.ttf",
    fileName: "assets/Inter.ttf",
    contentType: "font/ttf",
    source: readFileSync(new URL("../app/public/assets/Inter.ttf", import.meta.url)),
  },
  {
    url: "/assets/JetBrainsMonoNerdFontMono-Regular.woff2",
    fileName: "assets/JetBrainsMonoNerdFontMono-Regular.woff2",
    contentType: "font/woff2",
    source: readFileSync(new URL("../app/public/assets/JetBrainsMonoNerdFontMono-Regular.woff2", import.meta.url)),
  },
]

const override = ENV_PROXY_TARGET.map((name) => process.env[name]?.trim()).find(Boolean)
const runID = process.env[ENV_RUN_ID]?.trim() || undefined
const allowLan = process.env.OPENCODE_PWA_DEV_LAN?.trim() === "1"

/**
 * The single gate between the PWA and a backend.
 *
 * Historically this proxied to whatever URL a well-known file contained, with
 * no verification at all. On a machine running many opencode processes that
 * meant a stale or recycled port silently attached the phone to an unrelated
 * instance — you would only notice because the sessions belonged to another
 * project. The resolver now requires the target to echo the `instanceID` the
 * desktop minted for this launch before a single request is forwarded.
 */
const resolver = createTargetResolver({
  file: handshakePath(mobileDir),
  override,
  runID,
  // Verify the identity on every request. A 3-second cache is enough time for
  // a dead sidecar's port to be recycled by another process, which is exactly
  // the silent misbinding this proxy is responsible for making impossible.
  revalidateMs: 0,
  onLog: (level, message) => {
    if (level === "warn") console.warn(`[opencode:mobile] ${message}`)
    else console.info(`[opencode:mobile] ${message}`)
  },
})

if (override && runID) {
  console.warn(
    `[opencode:mobile] ignoring proxy override ${override} because this PWA was launched by the desktop handshake (run ${runID}).`,
  )
} else if (override) {
  console.warn(
    `[opencode:mobile] proxy target overridden to ${override} — it is still identity-checked, and pinned to the first instance that answers.`,
  )
}

/**
 * Owns both the verification gate and the forwarding. Deliberately not Vite's
 * `server.proxy`: routing there is fixed at config time, so a per-request
 * verified target cannot be expressed without an option Vite does not have.
 * See dev/proxy.ts.
 */
const api = createApiProxy({
  resolver,
  apiPrefixes: API_PREFIXES,
  onLog: (level, message) => {
    if (level === "warn") console.warn(`[opencode:mobile] ${message}`)
    else console.info(`[opencode:mobile] ${message}`)
  },
})

export default defineConfig(({ command }) => ({
  define: {
    "import.meta.env.VITE_OPENCODE_PWA": JSON.stringify("true"),
  },
  resolve: {
    // Never let a parent shell's NODE_ENV contaminate production package
    // condition resolution. This checkout commonly runs with NODE_ENV=development
    // for the desktop dev stack, but a mobile build must still resolve production
    // Solid/package branches. Dev keeps Vite/plugin defaults and HMR semantics.
    conditions: command === "build" ? ["module", "browser", "production"] : undefined,
    // Runtime/HMR consumes the live source. TypeScript resolves the same public
    // specifier to packages/app's independently generated declarations, so the
    // mobile compiler never reinterprets the app tree under mobile settings.
    alias: {
      "@opencode-ai/app/pwa-client": appPwaClient,
      "@/utils/toast": appPwaToast,
    },
  },
  plugins: [
    {
      name: "openfork:pwa-runtime-specializations",
      enforce: "pre",
      resolveId(source) {
        if (
          source === "@/utils/toast" ||
          source === appToast ||
          source.replaceAll("\\", "/") === appToastNormalized
        ) {
          return appPwaToast
        }
      },
    },
    {
      name: "openfork:pwa-startup-module-boundary",
      generateBundle(_options, bundle) {
        const entry = Object.values(bundle).find(
          (item) => item.type === "chunk" && /^assets\/pwa-client-[^.]+\.js$/.test(item.fileName),
        )
        if (!entry || entry.type !== "chunk") {
          this.error("connected pwa-client chunk missing; cannot verify startup module boundary")
          return
        }

        const forbidden = Object.keys(entry.modules).filter(
          (id) =>
            id.includes("/packages/sdk/js/src/v2/") ||
            id.includes("\\packages\\sdk\\js\\src\\v2\\") ||
            id.includes("@opencode-ai+client") ||
            id.includes("@opencode-ai/client"),
        )
        if (forbidden.length > 0) {
          this.error(
            "deferred API clients leaked into connected startup:\n" +
              forbidden
                .slice(0, 20)
                .map((id) => "  " + id)
                .join("\n"),
          )
        }
      },
    },
    {
      name: "openfork:workspace-sdk-source-js",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return
        const importerPath = importer.split("?", 1)[0] ?? importer
        const fromSdk = relative(sdkSourceDir, importerPath)
        if (fromSdk.startsWith("..") || isAbsolute(fromSdk)) return

        const candidate = resolve(dirname(importerPath), `${source.slice(0, -3)}.ts`)
        const withinSdk = relative(sdkSourceDir, candidate)
        if (withinSdk.startsWith("..") || isAbsolute(withinSdk) || !existsSync(candidate)) return
        return candidate
      },
    },
    {
      name: "openfork:private-mobile-dev-ingress",
      enforce: "pre",
      configureServer(server) {
        // This is a development server with source/HMR and a privileged API
        // proxy behind it. It must never become a public ingress endpoint.
        server.middlewares.use(privateDevIngressMiddleware)
        server.httpServer?.prependListener("upgrade", (request, socket) => {
          rejectPublicDevUpgrade(request, socket)
        })
      },
    },
    {
      name: "openfork:shared-pwa-static-assets",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = request.url?.split("?", 1)[0]
          const asset = sharedStaticAssets.find((item) => item.url === pathname)
          if (!asset) return next()
          response.statusCode = 200
          response.setHeader("Content-Type", asset.contentType)
          response.setHeader("Cache-Control", "no-cache")
          response.end(asset.source)
        })
      },
      generateBundle() {
        for (const asset of sharedStaticAssets) {
          this.emitFile({ type: "asset", fileName: asset.fileName, source: asset.source })
        }
      },
    },
    {
      name: "opencode:verified-sidecar-binding",
      configureServer(server) {
        // Registered inside configureServer (not in a returned thunk) so it runs
        // *before* Vite's own stack — nothing reaches the SPA fallback until the
        // target has proven its identity, and nothing is forwarded at all until
        // then.
        server.middlewares.use((request, response, next) => api.handle(request, response, next))
        server.httpServer?.on("upgrade", (request, socket, head) => {
          if (rejectPublicDevUpgrade(request, socket)) return
          api.handleUpgrade(request, socket, head)
        })
      },
    },
    ...appPlugin,
  ],
  server: {
    // Loopback is the safe default. LAN development requires an explicit opt-in
    // and is still protected by the private-network ingress firewall above.
    host: allowLan ? "0.0.0.0" : "127.0.0.1",
    port: 3301,
    // Fail loudly instead of drifting to 3302. A second dev stack silently
    // taking the next port is how a phone bookmarked at :3301 ends up driving
    // a different checkout's backend.
    strictPort: true,
    // Keep Vite's own Host validation enabled. `true` makes arbitrary public
    // hostnames valid and allowed the dev server to be published by a tunnel.
    allowedHosts: [],
    // No `proxy` key: API traffic is forwarded by the plugin above, which is
    // the only place that knows which backend has been verified.
  },
  build: {
    target: "esnext",
  },
}))
