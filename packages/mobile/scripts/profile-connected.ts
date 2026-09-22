import { existsSync, readFileSync } from "node:fs"

process.env.NODE_ENV = "production"

const { build } = await import("vite")

const result = await build({
  logLevel: "silent",
  build: {
    write: false,
  },
})

const outputs = Array.isArray(result) ? result : [result]
const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk")
const connected = chunks.find((item) => item.fileName.startsWith("assets/pwa-client-") && item.fileName.endsWith(".js"))

if (!connected || connected.type !== "chunk") {
  throw new Error("connected pwa-client chunk not found")
}

console.log(`[pwa-profile] connected chunk: ${connected.fileName} (${connected.code.length} raw bytes)`)
const rows = Object.entries(connected.modules)
  .map(([id, info]) => ({ id, rendered: info.renderedLength }))
  .sort((a, b) => b.rendered - a.rendered)

for (const row of rows.slice(0, 80)) {
  console.log(`${String(row.rendered).padStart(8)}  ${row.id}`)
}

const importNeedles = [
  "@opencode-ai/ui/icon",
  "@opencode-ai/ui/v2/icon",
  "@opencode-ai/ui/toast",
  "./icon",
  "../components/icon",
] as const

console.log("[pwa-profile] connected icon/toast importers:")
for (const id of Object.keys(connected.modules)) {
  const path = id.split("?", 1)[0] ?? id
  if (!existsSync(path)) continue

  let source = ""
  try {
    source = readFileSync(path, "utf8")
  } catch {
    continue
  }

  const needles = importNeedles.filter((needle) => source.includes(needle))
  if (needles.length === 0) continue
  console.log(`  ${path} :: ${needles.join(", ")}`)
}
