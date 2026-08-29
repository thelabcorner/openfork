// Scan the installed WorkBuddy app bundle for backend API URLs.
// The app is the authoritative source for the GLOBAL realm (www.workbuddy.ai),
// which is what the local desktop credential is actually scoped to.
import { openSync, readSync, closeSync, fstatSync } from "node:fs"

const path = process.argv[2]
const fd = openSync(path, "r")
const size = fstatSync(fd).size
const CHUNK = 8 * 1024 * 1024
const OVERLAP = 4096

const patterns = [
  /https:\/\/[a-z0-9][a-z0-9.\-]*(?:workbuddy|tencent|hunyuan|copilot|hyai|yuanbao)[a-z0-9.\-]*(?:\.[a-z]{2,})?(?:\/[A-Za-z0-9_\-./{}]*)?/gi,
  /\/v[0-9]+(?:\.[0-9]+)?\/[A-Za-z0-9_\-./{}]{2,80}/g,
  /\b(?:chat\/completions|models|refresh|token|userinfo|credit|trial|checkin|quota|balance)\b/gi,
]

const found = new Map()
let carry = Buffer.alloc(0)
let offset = 0

while (offset < size) {
  const len = Math.min(CHUNK, size - offset)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, offset)
  const text = Buffer.concat([carry, buf]).toString("latin1")
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const s = m[0]
      if (s.length < 6 || s.length > 220) continue
      // skip obvious source-map / node_modules noise
      if (/node_modules|\.map$|\.tsx?$|\.css$/i.test(s)) continue
      found.set(s, (found.get(s) || 0) + 1)
    }
  }
  carry = buf.subarray(Math.max(0, len - OVERLAP))
  offset += len
}
closeSync(fd)

const urls = [...found.entries()]
  .filter(([s]) => s.startsWith("http"))
  .sort((a, b) => b[1] - a[1])
const paths = [...found.entries()]
  .filter(([s]) => s.startsWith("/"))
  .sort((a, b) => b[1] - a[1])

console.log(`scanned ${(size / 1048576).toFixed(0)} MiB from ${path}\n`)
console.log(`=== HOSTS / FULL URLS (${urls.length}) ===`)
for (const [u, n] of urls.slice(0, 60)) console.log(`${String(n).padStart(6)}  ${u}`)

console.log(`\n=== API PATHS (${paths.length}) ===`)
for (const [p, n] of paths.slice(0, 80)) console.log(`${String(n).padStart(6)}  ${p}`)
