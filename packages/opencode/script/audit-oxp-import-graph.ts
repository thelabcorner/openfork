/**
 * Audit the source-level *eager* local import graph of OXP.
 * Direct external-package runtime imports are reported separately, not
 * counted as equivalent dependencies. Dynamic import() edges are excluded.
 *
 * bun packages/opencode/script/audit-oxp-import-graph.ts
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

// This verifier is invoked both from repo root and packages/opencode by the
// release matrix. Never resolve source against the caller's cwd.
const source = path.resolve(import.meta.dir, "../src")
const entry = [
  "oxp/host.ts",
  "oxp/active-runtime.ts",
  "oxp/server.ts",
  "oxp/surface.ts",
  "oxp/capability.ts",
  "oxp/transport-manifest.ts",
  "oxp/transport-pagination.ts",
  "oxp/transport-protocol.ts",
  "oxp/transport-listener.ts",
  "oxp/transport-incident.ts",
]
const known = new Map<string, { imports: string[]; packages: string[]; bytes: number }>()
function resolveLocal(from: string, specifier: string) {
  let abs: string | undefined
  if (specifier.startsWith(".")) abs = path.resolve(path.dirname(from), specifier)
  else if (specifier.startsWith("@/")) abs = path.resolve(source, specifier.slice(2))
  else return undefined
  if (!abs.startsWith(source + path.sep)) return undefined
  for (const candidate of [abs, abs + ".ts", abs + ".tsx", abs + ".js", path.join(abs, "index.ts"), path.join(abs, "index.tsx")]) {
    try { if (fs.statSync(candidate).isFile()) return candidate } catch {}
  }
  return undefined
}
function isRuntimeImport(stmt: ts.ImportDeclaration | ts.ExportDeclaration) {
  if (ts.isExportDeclaration(stmt)) return !stmt.isTypeOnly
  const clause = stmt.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name || !clause.namedBindings) return true
  const named = clause.namedBindings
  if (ts.isNamespaceImport(named)) return true
  return named.elements.some((element) => !element.isTypeOnly)
}
function parse(file: string) {
  const existing = known.get(file)
  if (existing) return existing
  if (known.size > 4_000) throw new Error("Import graph exceeded 4,000 bounded modules")
  const code = fs.readFileSync(file, "utf8")
  const syntax = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const imports = new Set<string>()
  const packages = new Set<string>()
  for (const statement of syntax.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
    if (!isRuntimeImport(statement)) continue
    const node = statement.moduleSpecifier
    if (!node || !ts.isStringLiteral(node)) continue
    const local = resolveLocal(file, node.text)
    if (local && local !== file) imports.add(local)
    else if (!node.text.startsWith(".") && !node.text.startsWith("@/")) packages.add(node.text)
  }
  const result = { imports: [...imports], packages: [...packages], bytes: Buffer.byteLength(code) }
  known.set(file, result)
  return result
}
function scan(start: string) {
  const visited = new Set<string>()
  const walk = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    for (const dependency of parse(file).imports) walk(dependency)
  }
  walk(start)
  if (process.argv.includes("--assert-transport-purity") && (
    start.endsWith("transport-protocol.ts") ||
    start.endsWith("transport-pagination.ts") ||
    start.endsWith("transport-manifest.ts") ||
    start.endsWith("transport-listener.ts") ||
    start.endsWith("transport-incident.ts")
  )) {
    const forbidden = [...visited].map((file) => path.relative(source, file).replace(/\\/g, "/"))
      .filter((file) => /^(?:oxp\/(?:server|surface|capability|host|active-runtime|session|worker|authority|config|root)(?:\.|-)|session\/|tool\/|server\/)/.test(file))
    if (forbidden.length > 0 || visited.size > 12) {
      throw new Error(`OXP transport-plane eager dependency regression: ${JSON.stringify({ entry: path.basename(start), modules: visited.size, forbidden })}`)
    }
  }
  if (process.argv.includes("--assert-transport-purity") &&
      path.basename(start) === "host.ts" && path.basename(path.dirname(start)) === "oxp") {
    const imports = [...visited].map((file) => path.relative(source, file).replace(/\\/g, "/"))
    const forbidden = imports.filter((name) =>
      /^oxp\/(?:active-runtime|server|surface|capability)(?:\.|-)/.test(name) ||
      name.startsWith("session/") || name.startsWith("server/"),
    )
    if (forbidden.length || visited.size > 30) {
      throw new Error(`OXP host eagerly imported the privileged execution graph: ${JSON.stringify({ modules: visited.size, forbidden })}`)
    }
  }
  const packages = new Set([...visited].flatMap((file) => parse(file).packages))
  return {
    entry: path.relative(source, start).replace(/\\/g, "/"),
    localModules: visited.size,
    localSourceKiB: Math.round([...visited].reduce((sum, file) => sum + parse(file).bytes, 0) / 1024),
    externalImportSpecifiers: packages.size,
    directRuntimeImports: parse(start).imports.map((file) => path.relative(source, file).replace(/\\/g, "/")),
  }
}
for (const item of entry) console.log(JSON.stringify(scan(path.resolve(source, item))))
console.log(JSON.stringify({ note: "Conservative source graph: excludes external package transitives, dynamic imports and bundler tree shaking.", totalLocalParsed: known.size }))
