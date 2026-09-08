// Keep this file intentionally dependency-free at module evaluation time. ACP
// uses stdout as an NDJSON protocol transport, so we must reserve fd 1 before
// importing the CLI graph: user plugins can execute during those imports.
// The runtime guard below only imports node:fs/node:path helpers and runs before
// ACP detection so a helper script whose own arguments happen to contain `acp`
// cannot accidentally have its stdout redirected to the ACP transport.
const nestedScriptExit = await import("./util/javascript-runtime").then((mod) => mod.rerouteNestedStandaloneScript())
if (nestedScriptExit !== undefined) process.exit(nestedScriptExit)

const isACP = process.argv.slice(2).includes("acp")

if (isACP) {
  const protocolWrite = process.stdout.write.bind(process.stdout)
  ;(
    globalThis as typeof globalThis & { __OPENCODE_ACP_PROTOCOL_WRITE__?: typeof process.stdout.write }
  ).__OPENCODE_ACP_PROTOCOL_WRITE__ = protocolWrite

  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  const { Console } = await import("node:console")
  ;(globalThis as any).console = new Console({ stdout: process.stderr, stderr: process.stderr })
  process.env.OPENCODE_CLIENT = "acp"
}

await import("./cli-main")
