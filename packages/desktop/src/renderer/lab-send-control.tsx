/**
 * DEV-ONLY shim so the already-running electron-vite renderer dev server can
 * serve the app-owned send/stop concept lab. It only re-enters the app module —
 * the prototypes themselves live in `packages/app/src/lab/send-control`, because
 * that is the package that owns the composer.
 *
 * Reached only from `lab-send-control.html`, which is not part of the renderer
 * build input (`main: "src/renderer/index.html"`), so it never ships. It does not
 * touch `window.api`, so unlike the real renderer entry it loads fine in an
 * ordinary browser.
 */
import "@opencode-ai/app/lab/send-control/mount"
