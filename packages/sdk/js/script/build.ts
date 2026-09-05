#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

const patchSseParser = async (path: string, importPath: string) => {
  let source = await Bun.file(path).text()
  const importLine = 'import { createSseParser } from "' + importPath + '"\n'
  if (!source.includes(importLine)) {
    const importMarker = source.match(/import type \{ Config \} from ['"]\.\/types\.gen\.js['"];?\r?\n/)
    if (!importMarker) throw new Error("SSE parser import marker changed (" + path + ")")
    source = source.replace(importMarker[0], importLine + importMarker[0])
  }

  if (!source.includes("const parser = createSseParser()")) {
    const bufferMarker = source.match(/        let buffer = ['"]{2};?\r?\n/)
    const start = bufferMarker?.index ?? -1
    const end = source.indexOf("        } finally {", start)
    if (start === -1 || end === -1) throw new Error("SSE parser shape changed (" + path + ")")
    const replacement = [
      "        const parser = createSseParser()",
      "",
      "        const abortHandler = () => {",
      "          try {",
      "            reader.cancel()",
      "          } catch {",
      "            // noop",
      "          }",
      "        }",
      "",
      "        signal.addEventListener(\"abort\", abortHandler)",
      "",
      "        try {",
      "          while (true) {",
      "            const { done, value } = await reader.read()",
      "            for (const frame of parser.push(value ?? \"\", done)) {",
      "              let data: unknown",
      "              let parsedJson = false",
      "              if (frame.hasData) {",
      "                const rawData = frame.data ?? \"\"",
      "                try {",
      "                  data = JSON.parse(rawData)",
      "                  parsedJson = true",
      "                } catch {",
      "                  data = rawData",
      "                }",
      "              }",
      "",
      "              if (parsedJson) {",
      "                if (responseValidator) {",
      "                  await responseValidator(data)",
      "                }",
      "",
      "                if (responseTransformer) {",
      "                  data = await responseTransformer(data)",
      "                }",
      "              }",
      "",
      "              if (frame.id !== undefined) lastEventId = frame.id",
      "              if (frame.retry !== undefined) retryDelay = frame.retry",
      "              onSseEvent?.({",
      "                data,",
      "                event: frame.event,",
      "                id: lastEventId,",
      "                retry: retryDelay,",
      "              })",
      "",
      "              if (frame.hasData) {",
      "                yield data as any",
      "              }",
      "            }",
      "            if (done) break",
      "          }",
    ].join("\n")
    source = source.slice(0, start) + replacement + "\n" + source.slice(end)
  }
  // Keep transport hardening in the generator so regeneration cannot silently
  // remove heartbeat-based recovery, jitter or reader cancellation.
  source = source.replace(/const reader = response\.body\s*\.pipeThrough\(new TextDecoderStream\(\)\)\s*\.getReader\(\);?/, "const reader = response.body.getReader()\n        const decoder = new TextDecoder()")
  if (!source.includes("const decoder = new TextDecoder()")) throw new Error("SSE byte reader patch did not apply: " + path)
  source = source.replace('parser.push(value ?? "", done)', 'parser.push(decoder.decode(value, { stream: !done }), done)')
  if (!source.includes("let connectedAt = 0")) {
    source = source.replace(/let attempt = 0;?/, "let attempt = 0\n    let connectedAt = 0")
  }
  if (!source.includes("connectedAt = Date.now()\n        const reader")) {
    source = source.replace("const reader = response.body", "connectedAt = Date.now()\n        const reader = response.body")
  }
  if (!source.includes("Date.now() - connectedAt >= 30_000")) {
    source = source.replace("if (frame.hasData) {\n                yield", [
      "// Any complete frame, including a heartbeat, proves socket liveness.",
      "              if (Date.now() - connectedAt >= 30_000) {",
      "                attempt = 1",
      "                connectedAt = Date.now()",
      "              }",
      "              if (frame.hasData) {",
      "                yield",
    ].join("\n"))
  }
  source = source.replace(/await sleep\(backoff(?: \/ 2 \+ Math.random\(\) \* \(backoff \/ 2\))?\)/g, "await sleep(Math.random() * backoff)")
  source = source.replace(/(if \(Date.now\(\) - connectedAt >= 30_000\) \{\s*)attempt = 0\s*retryDelay = sseDefaultRetryDelay \?\? 3000/, "$1attempt = 1")
  source = source.replace(/(?<!await |void )reader.cancel\(\);?/g, "void reader.cancel().catch(() => {})")
  source = source.replace(/(?<!await reader.cancel\(\).catch\(\(\) => \{\}\)\n          )reader.releaseLock\(\);?/, "await reader.cancel().catch(() => {})\n          reader.releaseLock()")
  await Bun.write(path, source)
}

await patchSseParser("./src/gen/core/serverSentEvents.gen.ts", "../../sse-parser.js")
await patchSseParser("./src/v2/gen/core/serverSentEvents.gen.ts", "../../../sse-parser.js")

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
