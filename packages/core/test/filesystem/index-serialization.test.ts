import { expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { IndexSerialization } from "@opencode-ai/core/filesystem/index-serialization"

const input: IndexSerialization.IndexBlobInput = {
  schemaVersion: 1,
  builtAt: 1_700_000_000_000,
  root: "/home/user/project",
  rootStat: { mtimeMs: 1_700_000_000_000, size: 4096, ino: 12345 },
  subtrees: {
    "": {
      at: 1_700_000_000_000,
      entries: [
        { path: "src/", type: "directory" },
        { path: "README.md", type: "file" },
      ],
    },
    "src": {
      at: 1_700_000_000_000,
      entries: [{ path: "src/main.ts", type: "file" }],
    },
  },
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

const runFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSync(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const failure = Cause.findErrorOption(exit.cause)
    expect(failure._tag).toBe("Some")
    if (failure._tag === "Some") return failure.value
  }
  throw new Error("expected failure")
}

test("encode -> decode round-trips the blob", () => {
  const bytes = IndexSerialization.encode(input)
  const decoded = run(IndexSerialization.decode(bytes))
  expect(decoded.schemaVersion).toBe(1)
  expect(decoded.root).toBe(input.root)
  expect(decoded.rootStat).toEqual(input.rootStat)
  expect(decoded.subtrees).toEqual(input.subtrees)
  expect(decoded.digest).toBeTruthy()
})

test("digest is byte-reproducible regardless of key insertion order", () => {
  const a = IndexSerialization.encode(input)
  const reordered = {
    ...input,
    subtrees: {
      "src": input.subtrees["src"],
      "": input.subtrees[""],
    },
  }
  const b = IndexSerialization.encode(reordered)
  expect(a).toEqual(b)
})

test("tampering with the digest fails the checksum", () => {
  const bytes = IndexSerialization.encode(input)
  const text = new TextDecoder("utf-8").decode(bytes)
  // corrupt one hex digit of the stored digest so the recomputed digest mismatches
  const tampered = text.replace(/"digest":"([0-9a-f])/, (_m, first: string) => `"digest":"${first === "0" ? "1" : "0"}`)
  expect(tampered).not.toBe(text)
  expect(runFailure(IndexSerialization.decode(new TextEncoder().encode(tampered))).reason).toBe("checksum")
})

test("unsupported schemaVersion is rejected as version", () => {
  const bytes = IndexSerialization.encode(input)
  const text = new TextDecoder("utf-8").decode(bytes)
  const bumped = text.replace('"schemaVersion":1', '"schemaVersion":2')
  expect(runFailure(IndexSerialization.decode(new TextEncoder().encode(bumped))).reason).toBe("version")
})

test("invalid JSON is rejected as invalid", () => {
  expect(runFailure(IndexSerialization.decode(new TextEncoder().encode("{not json"))).reason).toBe("invalid")
})

test("compact encode stores file size/mtime as a 4-tuple and dirs as a 2-tuple", () => {
  const subtrees = new Map([
    [
      "src",
      {
        at: 1,
        entries: [
          { path: "src/a.ts", type: "file" as const, size: 1280, mtime: 1_700_000_000_000 },
          { path: "src/lib", type: "directory" as const },
        ],
      },
    ],
  ])
  const bytes = IndexSerialization.encodeCompact({
    builtAt: 2,
    root: "/repo",
    rootStat: { mtimeMs: 3, size: 4, ino: 5 },
    subtrees,
  })
  const decoded = IndexSerialization.decodeCompact(bytes)
  expect(decoded?.root).toBe("/repo")
  expect(decoded?.subtrees.get("src")?.entries).toEqual([
    { path: "src/a.ts", type: "file", size: 1280, mtime: 1_700_000_000_000 },
    { path: "src/lib", type: "directory" },
  ])
})

test("compact decode accepts legacy 2-tuple file entries without size", () => {
  const blob = {
    v: 2,
    b: 1,
    r: "/repo",
    s: [1, 2, 3],
    d: [["", 1, [[0, "README.md"], [1, "src"]]]],
  }
  const decoded = IndexSerialization.decodeCompact(new TextEncoder().encode(JSON.stringify(blob)))
  expect(decoded?.subtrees.get("")?.entries).toEqual([
    { path: "README.md", type: "file", size: undefined, mtime: undefined },
    { path: "src", type: "directory" },
  ])
})

test("canonical JSON sorts keys and omits whitespace", () => {
  const json = IndexSerialization.canonicalJson({ b: 1, a: { d: 2, c: 3 } })
  expect(json).toBe('{"a":{"c":3,"d":2},"b":1}')
})
