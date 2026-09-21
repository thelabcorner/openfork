import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const VERSION = "0.0.14"
const executableName = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client"

async function find(root: string, target: string, depth = 0): Promise<string[]> {
  if (depth > 8 || !existsSync(root)) return []
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name === target) result.push(full)
    else if (entry.isDirectory() && !entry.name.endsWith(".asar.unpacked")) result.push(...(await find(full, target, depth + 1)))
  }
  return result
}

const dist = path.resolve(process.argv[2] ?? "dist")
const binaries = await find(dist, executableName)
if (binaries.length !== 1) {
  throw new Error(`Expected exactly one packaged OXP ${executableName} under ${dist}; found ${binaries.length}`)
}
const executable = binaries[0]!
const tunnelDir = path.dirname(executable)
for (const required of ["VERSION", "LICENSE", "NOTICE"]) {
  const file = path.join(tunnelDir, required)
  if (!existsSync(file) || !(await stat(file)).isFile()) throw new Error(`Packaged OXP runtime is missing ${required}`)
}
const evidence = (await readdir(tunnelDir)).filter((name) => name.endsWith(".spdx.json") || name.endsWith("-licenses.txt"))
if (evidence.length < 2) throw new Error("Packaged OXP runtime is missing release SBOM/license evidence")

const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
if (probe.error) throw probe.error
const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`
if (probe.status !== 0 || !output.includes(VERSION)) {
  throw new Error(`Packaged tunnel-client runtime smoke failed: ${output.trim()}`)
}
console.log(`Packaged OXP tunnel-client ${VERSION} verified at ${path.relative(dist, executable)}`)
