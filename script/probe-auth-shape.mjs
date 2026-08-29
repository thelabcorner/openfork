// Probe the SHAPE of the local WorkBuddy/CodeBuddy desktop credential store.
// Prints JSON structure (keys + types) ONLY. Never prints secret values.
// Used to design a client against the real on-disk format without handling secrets.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[2]
const REDACT = new Set([
  "token", "access_token", "refresh_token", "accessToken", "refreshToken",
  "api_key", "apiKey", "key", "secret", "password", "authorization",
  "id_token", "idToken", "session", "cookie", "signature", "client_secret",
])

function shape(v, depth = 0, keyName = "") {
  const pad = "  ".repeat(depth)
  if (v === null || v === undefined) return `${pad}${keyName}: <${v}>`
  if (Array.isArray(v)) {
    let out = `${pad}${keyName}: Array(${v.length})`
    if (v.length) out += "\n" + shape(v[0], depth + 1, "[0]")
    return out
  }
  if (typeof v === "object") {
    // Always descend into objects so we learn the KEY NAMES (that is the whole
    // point of this probe). Secrets are redacted at the string-leaf level below.
    let out = `${pad}${keyName}: {`
    for (const [k, val] of Object.entries(v)) {
      out += "\n" + shape(val, depth + 1, k)
    }
    return out + `\n${pad}}`
  }
  if (typeof v === "string") {
    const isSensitive = REDACT.has(keyName) || /(token|secret|key|password|auth)/i.test(keyName)
    return `${pad}${keyName}: ${isSensitive ? "<redacted>" : `String(len=${v.length}) preview="${v.slice(0, 40).replace(/\n/g, "\\n")}"`}`
  }
  return `${pad}${keyName}: ${typeof v} (${v})`
}

let files
try { files = readdirSync(dir) } catch (e) { console.error("cannot read dir:", e.message); process.exit(1) }
console.log(`dir: ${dir}`)
console.log(`files: ${files.join(", ")}\n`)

for (const f of files) {
  if (!/\.(info|json)$/i.test(f)) continue
  const raw = readFileSync(join(dir, f), "utf8")
  console.log(`=== ${f} (${raw.length} bytes) ===`)
  // try JSON, else try newline-delimited JSON, else guess
  try {
    console.log(shape(JSON.parse(raw)))
  } catch {
    try {
      const parts = raw.split("\n").filter(Boolean).map((l, i) => JSON.parse(l))
      console.log(`(newline-delimited JSON, ${parts.length} records)`)
      parts.forEach((p, i) => console.log(`--- record ${i} ---\n` + shape(p)))
    } catch {
      console.log("(not JSON; showing first 200 chars, redacted)")
      console.log(raw.slice(0, 200).replace(/[A-Za-z0-9_\-]{24,}/g, "<REDACTED>"))
    }
  }
  console.log()
}
