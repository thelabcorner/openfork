import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

test(
  "testEffect interrupts and finalizes a Bun-timed-out Effect before the following test",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-effect-timeout-"))
    const isolatedMarker = path.join(dir, "isolated-finalized.txt")
    const sharedBodyMarker = path.join(dir, "shared-body-finalized.txt")
    const layerMarker = path.join(dir, "layer-finalized.txt")
    const fixture = path.join(dir, "effect-timeout.fixture.test.ts")
    const helper = pathToFileURL(path.join(import.meta.dir, "effect.ts")).href

    await fs.writeFile(
      fixture,
      [
        'import { expect, test } from "bun:test"',
        'import fs from "fs/promises"',
        'import { Effect, Exit, Layer } from "effect"',
        `import { it, testEffectShared } from ${JSON.stringify(helper)}`,
        "",
        `const isolatedMarker = ${JSON.stringify(isolatedMarker)}`,
        `const sharedBodyMarker = ${JSON.stringify(sharedBodyMarker)}`,
        `const layerMarker = ${JSON.stringify(layerMarker)}`,
        "",
        'it.live("isolated runner times out while holding a scoped finalizer",',
        "  Effect.acquireRelease(",
        "    Effect.void,",
        '    () => Effect.promise(() => fs.writeFile(isolatedMarker, "isolated-finalized")),',
        "  ).pipe(Effect.andThen(Effect.never)),",
        "  { timeout: 50 },",
        ")",
        "",
        'test("following test observes isolated timeout cleanup", async () => {',
        '  expect(await fs.readFile(isolatedMarker, "utf8")).toBe("isolated-finalized")',
        "})",
        "",
        "const sharedLayer = Layer.effectDiscard(",
        "  Effect.acquireRelease(",
        "    Effect.void,",
        "    (_, exit) => Effect.promise(() =>",
        '      fs.writeFile(layerMarker, Exit.isFailure(exit) ? "layer-failure" : "layer-success"),',
        "    ),",
        "  ),",
        ")",
        "const shared = testEffectShared(sharedLayer)",
        "",
        'shared.live("times out while holding body and shared-layer finalizers",',
        "  Effect.acquireRelease(",
        "    Effect.void,",
        '    () => Effect.promise(() => fs.writeFile(sharedBodyMarker, "shared-body-finalized")),',
        "  ).pipe(Effect.andThen(Effect.never)),",
        "  { timeout: 50 },",
        ")",
        "",
        'test("following test observes shared timeout cleanup and failure Exit", async () => {',
        '  expect(await fs.readFile(sharedBodyMarker, "utf8")).toBe("shared-body-finalized")',
        '  expect(await fs.readFile(layerMarker, "utf8")).toBe("layer-failure")',
        "})",
        "",
      ].join("\n"),
    )

    try {
      const child = Bun.spawn([process.execPath, "test", fixture, "--timeout", "2000"], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = stdout + stderr

      expect(exitCode).toBe(1)
      expect(output).toContain("2 pass")
      expect(output).toContain("2 fail")
      expect(output).not.toContain("Unhandled error")
      expect(await fs.readFile(isolatedMarker, "utf8")).toBe("isolated-finalized")
      expect(await fs.readFile(sharedBodyMarker, "utf8")).toBe("shared-body-finalized")
      expect(await fs.readFile(layerMarker, "utf8")).toBe("layer-failure")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  },
  { timeout: 10_000 },
)