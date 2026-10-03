import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Installation,
  isDirectInstallPath,
  openForkDirectUpgradeScript,
  releaseVersionForChannel,
} from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("release selection", () => {
    test("selects stable latest without crossing into prereleases", () => {
      expect(
        releaseVersionForChannel(
          [
            { tag_name: "v2.0.0-dev.4", draft: false, prerelease: true },
            { tag_name: "v1.9.0", draft: false, prerelease: false },
          ],
          "latest",
        ),
      ).toBe("1.9.0")
    })

    test("selects only the requested prerelease channel and ignores drafts", () => {
      expect(
        releaseVersionForChannel(
          [
            { tag_name: "v9.0.0-dev.999", draft: true, prerelease: true },
            { tag_name: "v3.0.0-beta.2", draft: false, prerelease: true },
            { tag_name: "v0.0.0-dev.42+abc1234", draft: false, prerelease: true },
            { tag_name: "v2.9.0", draft: false, prerelease: false },
          ],
          "dev",
        ),
      ).toBe("0.0.0-dev.42+abc1234")
    })

    const requests: string[] = []
    const currentChannelVersion =
      InstallationChannel === "latest" ? "1.2.3" : `1.2.3-${InstallationChannel}.1`
    testEffect(
      testLayer((request) => {
        requests.push(request.url)
        return jsonResponse([
          {
            tag_name: `v${currentChannelVersion}`,
            draft: false,
            prerelease: InstallationChannel !== "latest",
          },
        ])
      }),
    ).effect("reads versions only from OpenFork GitHub releases", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe(currentChannelVersion)
        expect(requests).toEqual(["https://api.github.com/repos/thelabcorner/openfork/releases?per_page=50"])
        expect(requests.some((url) => url.includes("anomalyco/opencode"))).toBe(false)
        expect(requests.some((url) => url.includes("registry.npmjs.org/opencode-ai"))).toBe(false)
      }),
    )
  })

  describe("direct installation ownership", () => {
    test("recognizes the canonical OpenFork direct path and its legacy migration source", () => {
      expect(isDirectInstallPath("/home/me/.openfork/bin/openfork", "linux")).toBe(true)
      expect(isDirectInstallPath("/Users/me/.openfork/bin/openfork", "darwin")).toBe(true)
      expect(isDirectInstallPath("/home/me/.openfork/bin/opencode", "linux")).toBe(true)
      expect(isDirectInstallPath("/Users/me/.openfork/bin/opencode", "darwin")).toBe(true)
      expect(isDirectInstallPath("/home/me/.opencode/bin/opencode", "linux")).toBe(true)
      expect(isDirectInstallPath("/Users/me/.opencode/bin/opencode", "darwin")).toBe(true)
      expect(isDirectInstallPath("/home/me/.opencode/bin/opencode-helper", "linux")).toBe(false)
      expect(isDirectInstallPath("/home/me/.local/bin/opencode", "linux")).toBe(false)
      expect(isDirectInstallPath("C:\\Users\\me\\.opencode\\bin\\opencode.exe", "win32")).toBe(false)
    })

    test("builds a self-contained OpenFork release installer without upstream distribution channels", () => {
      const script = openForkDirectUpgradeScript({
        version: "v1.18.30",
        target: "/home/me/.openfork/bin/openfork",
      })

      expect(script).toContain("https://github.com/thelabcorner/openfork")
      expect(script).toContain('asset="openfork-linux-x64${baseline}${libc}.tar.gz"')
      expect(script).toContain('asset="openfork-linux-arm64${libc}.tar.gz"')
      expect(script).toContain('asset="openfork-darwin-x64${baseline}.zip"')
      expect(script).toContain('openfork-darwin-arm64.zip')
      expect(script).toContain('baseline="-baseline"')
      expect(script).toContain('libc="-musl"')
      expect(script).toContain('install -m 0755 "$tmp/openfork" "$staged"')
      expect(script).toContain('test "$staged_version" = "$version"')
      expect(script).toContain('mv -f "$staged" "$target"')
      expect(script).toContain('test "$actual" = "$version"')
      expect(script).not.toContain("opencode.ai/install")
      expect(script).not.toContain("anomalyco/opencode")
      expect(script).not.toContain("npm install")
      expect(script).not.toContain("brew upgrade")
      expect(script).not.toContain("choco")
      expect(script).not.toContain("scoop")
    })
  })

  describe("upgrade", () => {
    testEffect(testLayer(() => jsonResponse([]))).effect("rejects externally managed installations without spawning", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("unknown", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toContain("does not use upstream package-manager channels")
        expect(error.stderr).toContain("github.com/thelabcorner/openfork/releases")
      }),
    )

    testEffect(testLayer(() => jsonResponse([]))).effect("rejects invalid release versions before launching a shell", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "not-a-release"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Invalid OpenFork release version: not-a-release")
      }),
    )

    testEffect(testLayer(() => jsonResponse([]))).effect(
      "fails closed when the running executable is not a fork-managed direct install",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain("cannot update this installation in place")
          expect(error.stderr).toContain("github.com/thelabcorner/openfork/releases")
        }),
    )
  })
})
