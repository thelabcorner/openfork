export * as ExchangeRequestDigest from "./request-digest"

import { createHash } from "node:crypto"

function canonical(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite request number")
    return Object.is(value, -0) ? "0" : String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`
  }
  throw new Error(`Unsupported request-digest value: ${typeof value}`)
}

export function sha256(namespace: string, value: unknown) {
  const hash = createHash("sha256")
  hash.update(namespace, "utf8")
  hash.update(Buffer.from([0]))
  hash.update(canonical(value), "utf8")
  return `sha256:${hash.digest("hex")}`
}
