import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const OPENCODE_SERVER_DIST = fileURLToPath(new URL("../opencode/dist/node", import.meta.url))
const OPENCODE_SERVER_FILE = fileURLToPath(new URL("../opencode/dist/node/node.js", import.meta.url))
const APP_SRC = fileURLToPath(new URL("../app/src", import.meta.url))

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig(({ command }) => ({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        external: ["electron"],
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id !== "virtual:opencode-server") return
          if (command === "serve") return { id: pathToFileURL(OPENCODE_SERVER_FILE).href, external: true }
          return this.resolve(OPENCODE_SERVER_FILE)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          if (command === "serve") return
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: "src/preload/index.ts",
          // Browser-guest preload: loaded inside each <webview> guest via the
          // preload attribute; the path is handed to the renderer through
          // window.api.browser.getGuestPreloadPath().
          preview: "src/guest/preview-preload.ts",
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    // Keep Shiki's language registry out of Vite's dependency prebundle. The
    // package's normal entrypoint references every grammar (hundreds of
    // dynamic imports), so optimizing it turns a renderer startup into a
    // multi-thousand-file cold build. Shiki is already loaded lazily by the
    // markdown worker/viewer; serving that entrypoint through Vite preserves
    // the same runtime behavior while keeping grammars on demand.
    optimizeDeps: {
      exclude: ["shiki"],
      // These are reached from worker/dynamic import graphs. Declaring them
      // here prevents Vite's late "new dependencies optimized" pass and its
      // forced renderer reload during dev startup.
      include: ["@shikijs/stream", "remend"],
    },
    resolve: {
      // electron-vite resolves the renderer from its nested root. Keep the
      // workspace app package resolvable even when its workspace symlink has
      // not been created yet (for example after a fresh checkout on Windows).
      alias: [
        { find: /^@opencode-ai\/app$/, replacement: `${APP_SRC}/index.ts` },
        { find: /^@opencode-ai\/app\/(.+)$/, replacement: `${APP_SRC}/$1` },
      ],
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
}))
