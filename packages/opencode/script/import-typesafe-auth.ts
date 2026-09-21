import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Auth } from "../src/auth"

const source = process.argv[2]
if (!source) throw new Error("usage: bun script/import-typesafe-auth.ts <credential-file> [--remove-source]")

const raw = await readFile(source, "utf8")
const lines = raw
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))

if (lines.length !== 1) throw new Error("credential file must contain exactly one non-comment line")
const line = lines[0]!
const key = (line.startsWith("TYPESAFE_API_KEY=") ? line.slice("TYPESAFE_API_KEY=".length) : line)
  .trim()
  .replace(/^['"]|['"]$/g, "")

if (!/^apikey_[A-Za-z0-9_]+$/.test(key)) throw new Error("credential file does not contain a TypeSafe API key")

const runtime = makeRuntime(Auth.Service, AppNodeBuilder.build(Auth.node))
await runtime.runPromise((auth) =>
  auth.set("typesafe", {
    type: "api",
    key,
    metadata: {
      label: "TypeSafe",
      source: "local-file",
      baseURL: "https://api.typesafe.ai/v1",
    },
  }),
)

const credentialRef = "typesafe-" + createHash("sha256").update(key).digest("hex").slice(0, 12)
if (process.argv.includes("--remove-source")) await rm(source, { force: true })

process.stdout.write(
  JSON.stringify({
    providerID: "typesafe",
    credentialRef,
    sourceRemoved: process.argv.includes("--remove-source"),
  }) + "\n",
)
process.exit(0)
