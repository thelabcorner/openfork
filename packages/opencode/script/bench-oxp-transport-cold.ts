/**
 * Cold-process probe of the standalone OXP protocol/listener plane.
 * This is deliberately NOT the production host: a mock execution callback
 * fails closed and no user roots, Sessions, processes or live tunnel are used.
 *
 * Run from monorepo root:
 *   bun packages/opencode/script/bench-oxp-transport-cold.ts
 *
 * Measures eager imports, ephemeral listener bind, actual modern MCP
 * initialize and tools/list, with fresh Bun processes for each of 5 samples.
 */
const samples = 5

async function sample() {
  const importedAt = performance.now()
  const [{ createOxpTransportProtocol }, { paginateToolList, registerLegacyManifest }, { sendMcpResponse }, { createServer }] = await Promise.all([
    import("../src/oxp/transport-protocol"),
    import("../src/oxp/transport-pagination"),
    import("../src/oxp/response-stream"),
    import("node:http"),
  ])
  const importsMs = performance.now() - importedAt
  const proto = createOxpTransportProtocol({
    paginate: paginateToolList,
    registerLegacy: registerLegacyManifest,
    async execute() { throw new Error("No executable capability runtime in the cold transport probe") },
    internalError() { return { isError: true, content: [{ type: "text", text: "EXECUTOR_NOT_INSTALLED" }] } },
  })
  const listenAt = performance.now()
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === "content-length" || value === undefined) continue
        if (Array.isArray(value)) for (const item of value) headers.append(key, item)
        else headers.set(key, value)
      }
      const request = new Request("http://127.0.0.1/mcp", {
        method: req.method, headers, body: Buffer.concat(chunks).toString("utf8"),
      })
      await sendMcpResponse(res, await proto.handler.fetch(request))
    })().catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const listenMs = performance.now() - listenAt
  const address = server.address() as { port: number }
  const sdkAt = performance.now()
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client")
  const sdkMs = performance.now() - sdkAt
  const client = new Client(
    { name: "oxp-transport-benchmark", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  try {
    const connectAt = performance.now()
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
    const connectMs = performance.now() - connectAt
    const listAt = performance.now()
    const listed = await client.listTools()
    const listMs = performance.now() - listAt
    if (listed.tools.length !== 14) throw new Error(`Expected 14 static OXP tools, got ${listed.tools.length}`)
    return {
      importsMs, listenMs, sdkMs, connectMs, listMs,
      totalMs: performance.now() - importedAt,
      heapMiB: process.memoryUsage().heapUsed / 1048576,
    }
  } finally {
    await client.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

if (process.argv.includes("--sample")) {
  console.log(JSON.stringify(await sample()))
} else {
  const values: Array<Record<string, number>> = []
  for (let i = 0; i < samples; i++) {
    const proc = Bun.spawn([process.execPath, import.meta.path, "--sample"], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe", stdin: "ignore",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    if (exit !== 0) throw new Error(`OXP cold transport sample ${i} failed: ${stderr.slice(0, 2000)}`)
    const row = JSON.parse(stdout.trim()) as Record<string, number>
    for (const key of ["importsMs", "listenMs", "sdkMs", "connectMs", "listMs", "totalMs", "heapMiB"]) {
      if (!Number.isFinite(row[key]) || row[key]! < 0) throw new Error(`Invalid cold transport measurement ${key}`)
    }
    values.push(row)
  }
  const fields = Object.keys(values[0]!)
  const measured = Object.fromEntries(fields.map((key) => {
    const rows = values.map((entry) => entry[key]!).sort((a, b) => a - b)
    const round = (value: number) => Math.round(value * 1000) / 1000
    return [key, { median: round(rows[Math.floor(rows.length / 2)]!), min: round(rows[0]!), max: round(rows.at(-1)!) }]
  }))
  console.log(JSON.stringify({
    workload: "standalone OXP transport initialized/listed over ephemeral modern MCP loopback",
    samples, measurements: measured,
    caveat: "No authorized execution runtime, config root verification, actual tunnel, user Session, or production server readiness.",
  }))
}
