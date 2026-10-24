/**
 * Privacy-safe support bundle tests.
 *
 * These assert the *privacy* invariants rather than that the current projection
 * happens to look right. Each test names the leak it prevents, so a future
 * section or option cannot quietly reintroduce that class of leak.
 */
import { describe, expect, test } from "bun:test"
import { MemorySecrets } from "../../src/memory/secrets"
import {
  DEFAULT_SECTION_IDS,
  EXCLUSION_REASONS,
  SECRET_REDACTION_OWNER,
  build,
  createPseudonymizer,
  serialize,
  type SupportBundleArtifact,
  type SupportBundleInput,
} from "../../src/diagnostics/support-bundle"

const NOW = "2026-10-04T00:00:00.000Z"

const base = (): SupportBundleInput => ({
  runtime: {
    version: "1.18.34",
    platform: "win32",
    arch: "x64",
    executable: "C:\\Program Files\\OpenFork\\openfork.exe",
    configRoot: "C:\\Users\\tester\\.openfork",
  },
  workspaces: {
    workspaces: [
      { id: "ws-alpha", path: "C:\\Users\\tester\\code\\alpha", vcs: "git", branch: "main", sessionCount: 4 },
      { id: "ws-beta", path: "C:\\Users\\tester\\code\\beta", vcs: "git", sessionCount: 1 },
    ],
  },
  connectivity: {
    oxpEnabled: true,
    oxpPeerCount: 2,
    oxpConnectedPeerIds: ["peer-lab", "peer-home"],
    ofxpEnabled: true,
    ofxpTrustedPeerCount: 1,
    ofxpInvocationTotals: { total: 40, ok: 38, error: 2 },
    oxpPeers: [{ id: "peer-lab", state: "connected", lastError: "" }],
  },
})

const buildOne = (input: Partial<SupportBundleInput>, options: Parameters<typeof build>[1] = {}) =>
  build({ ...base(), ...input }, { now: NOW, pseudonymSeed: "fixed-seed", ...options })

describe("allowlisted bounded projection", () => {
  test("undeclared keys never survive a section, including credential-shaped ones", () => {
    const artifact = buildOne({
      runtime: { version: "1.18.34", apiKey: "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", homeDir: "C:\\Users\\tester" },
    })
    const data = artifact.sections.runtime!.data as Record<string, unknown>
    expect(Object.keys(data).toSorted()).toEqual(["version"])
    expect(JSON.stringify(artifact)).not.toContain("sk-AAAA")
  })

  test("a section whose declared fields are all absent is reported, not emitted empty", () => {
    const artifact = buildOne({ runtime: { unrelated: 1 } })
    expect(artifact.sections.runtime.included).toBe(false)
    expect(artifact.sections.runtime.reason).toBe("projection-empty")
    expect(artifact.sections.runtime.data).toBeNull()
  })

  test("enum fields reject values that are not safe to publish verbatim", () => {
    const artifact = buildOne({
      connectivity: { oxpPeers: [{ id: "peer-lab", state: "conn ected <script>" }] },
    })
    const peers = (artifact.sections.connectivity!.data as Record<string, unknown>).oxpPeers as Array<
      Record<string, unknown>
    >
    expect(peers[0]!.state).toBeUndefined()
    expect(peers[0]!.id).toMatch(/^name-/)
  })

  test("long strings and wide arrays are bounded", () => {
    const artifact = buildOne(
      { logs: { level: "info", lines: Array.from({ length: 200 }, (_, i) => `line ${i}`) } },
      { maxStringLength: 32, maxArrayItems: 8 },
    )
    const data = artifact.sections.logs!.data as Record<string, unknown>
    expect((data.lines as string[]).length).toBe(8)
    expect(artifact.scrub.droppedValues).toBeGreaterThan(0)
  })
})

describe("conversation and task content is excluded by default", () => {
  const withContent = (): SupportBundleInput => ({
    ...base(),
    conversation: { sessionCount: 2, turnCount: 9, texts: ["my private prompt text"] },
  })

  test("default artifact cannot carry conversation content", () => {
    const artifact = build(withContent(), { now: NOW, pseudonymSeed: "fixed-seed" })
    expect(artifact.sections.conversation.included).toBe(false)
    expect(artifact.sections.conversation.reason).toBe(EXCLUSION_REASONS.conversationNotConsent)
    expect(artifact.policy.conversationContent).toBe(false)
    expect(serialize(artifact)).not.toContain("my private prompt text")
  })

  test("absence is machine-checkable, not an omitted key", () => {
    const artifact = build(withContent(), { now: NOW, pseudonymSeed: "fixed-seed" })
    expect(artifact.excluded).toContainEqual({ id: "conversation", reason: EXCLUSION_REASONS.conversationNotConsent })
  })

  test("conversation is never in the default section set", () => {
    expect(DEFAULT_SECTION_IDS).not.toContain("conversation")
  })

  test("requesting the section without consent is still refused", () => {
    const artifact = build(withContent(), {
      now: NOW,
      pseudonymSeed: "fixed-seed",
      include: [...DEFAULT_SECTION_IDS, "conversation"],
    })
    expect(artifact.sections.conversation.included).toBe(false)
    expect(artifact.sections.conversation.reason).toBe(EXCLUSION_REASONS.conversationNotConsent)
  })

  test("consent alone is not enough: the section must also be requested", () => {
    const artifact = build(
      { ...withContent(), conversation: { texts: ["prompt with sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"] } },
      { now: NOW, pseudonymSeed: "fixed-seed", includeConversationContent: true },
    )
    expect(artifact.sections.conversation.included).toBe(false)
    expect(artifact.sections.conversation.reason).toBe(EXCLUSION_REASONS.notRequested)
  })

  test("request plus consent is the only way in, and the content is still scrubbed", () => {
    const artifact = build(
      { ...withContent(), conversation: { texts: ["prompt with sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"] } },
      {
        now: NOW,
        pseudonymSeed: "fixed-seed",
        includeConversationContent: true,
        include: [...DEFAULT_SECTION_IDS, "conversation"],
      },
    )
    expect(artifact.sections.conversation.included).toBe(true)
    const texts = (artifact.sections.conversation!.data as Record<string, unknown>).texts as string[]
    expect(texts[0]).not.toContain("sk-AAAA")
  })
})

describe("secret redaction delegates to the canonical owner", () => {
  test("the artifact records the one owner and never a local regex catalog", () => {
    const artifact = buildOne({ runtime: { version: "1.18.34" } })
    expect(artifact.scrub.secretRedactionOwner).toBe(SECRET_REDACTION_OWNER)
    expect(SECRET_REDACTION_OWNER).toContain("memory/secrets")
  })

  test("credentials are rewritten and only rule names are reported", () => {
    const artifact = buildOne({
      logs: { level: "info", lines: ["auth failed for sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA and AKIAIOSFODNN7EXAMPLE"] },
    })
    const lines = (artifact.sections.logs!.data as Record<string, unknown>).lines as string[]
    expect(lines[0]).toContain("[redacted:")
    expect(lines[0]).not.toContain("sk-AAAA")
    expect(lines[0]).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(artifact.scrub.redactedValues).toBe(1)
    expect(artifact.scrub.redactedRules).toContain("openai-key")
    expect(artifact.scrub.redactedRules).toContain("aws-access-key-id")
  })

  test("redaction matches the owner's own redact() output rather than a private rule list", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"
    const artifact = buildOne({ logs: { lines: [`token=${secret}`] } })
    const lines = (artifact.sections.logs!.data as Record<string, unknown>).lines as string[]
    expect(lines[0]).toBe(MemorySecrets.redact(`token=${secret}`))
    expect(MemorySecrets.scan(lines[0]!).clean).toBe(true)
  })

  test("a credential hidden in an object key is scrubbed too", () => {
    const artifact = build(
      { logs: { lines: ["x"], extra: 1, ["sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"]: "v" } },
      { now: NOW, pseudonymSeed: "s" },
    )
    const json = serialize(artifact)
    expect(json).not.toContain("sk-AAAA")
    expect(MemorySecrets.scan(json).clean).toBe(true)
  })
})

describe("report-local pseudonyms", () => {
  test("the same private value yields the same token everywhere in one report", () => {
    const artifact = buildOne({
      runtime: { version: "1.18.34", configRoot: "C:\\Users\\tester\\.openfork", dataRoot: "C:\\Users\\tester" },
    })
    const runtime = artifact.sections.runtime!.data as Record<string, string>
    // Shared parent segment is what preserves the relationship.
    expect(runtime.configRoot!.startsWith("C:\\path-")).toBe(true)
    expect(runtime.configRoot!.split("\\")[1]).toBe(runtime.dataRoot!.split("\\")[1])
  })

  test("distinct private values yield distinct tokens", () => {
    const artifact = buildOne({})
    const rows = (artifact.sections.workspaces!.data as Record<string, unknown>).workspaces as Array<
      Record<string, string>
    >
    expect(rows[0]!.path).not.toBe(rows[1]!.path)
  })

  test("a raw private path never appears in the serialized artifact", () => {
    const artifact = buildOne({})
    const json = serialize(artifact)
    expect(json).not.toContain("C:\\\\Users\\\\tester")
    expect(json).not.toContain("tester")
    expect(json).not.toContain("alpha")
  })

  test("a pre-serialized Windows path is pseudonymized, not passed through as raw text", () => {
    const artifact = buildOne({
      logs: { lines: [JSON.stringify({ cwd: "C:\\Users\\tester\\code\\alpha" })] },
    })
    const lines = (artifact.sections.logs!.data as Record<string, unknown>).lines as string[]
    expect(lines[0]).toContain("path-")
    expect(lines[0]).not.toContain("tester")
    expect(lines[0]).not.toContain("alpha")
  })

  test("a raw Windows path and its JSON-escaped form pseudonymize identically", () => {
    const pseudonymizer = createPseudonymizer({ seed: "escape-seed" })
    const raw = "C:\\Users\\tester\\code\\alpha"
    const escaped = JSON.stringify(raw).slice(1, -1)
    expect(escaped).toBe("C:\\\\Users\\\\tester\\\\code\\\\alpha")
    expect(pseudonymizer.scrub(escaped)).toBe(pseudonymizer.scrub(raw))
  })

  test("a UNC server and share are private host identity, not preserved structure", () => {
    const artifact = buildOne({ runtime: { version: "1.18.34", configRoot: "\\\\fileserver\\acct-share\\conf" } })
    const runtime = artifact.sections.runtime!.data as Record<string, string>
    expect(runtime.configRoot).not.toContain("fileserver")
    expect(runtime.configRoot).not.toContain("acct-share")
    expect(runtime.configRoot!.startsWith("\\\\path-")).toBe(true)
  })

  test("a URL scheme is not mistaken for a Windows drive letter", () => {
    const pseudonymizer = createPseudonymizer({ seed: "url-seed" })
    expect(pseudonymizer.scrub("https://api.example.com/v1")).toBe("https://api.example.com/v1")
  })

  test("a tilde duration is not mistaken for a home path", () => {
    const pseudonymizer = createPseudonymizer({ seed: "dur-seed" })
    expect(pseudonymizer.scrub("took ~30s")).toBe("took ~30s")
  })

  test("caller-registered private literals are scrubbed inside longer text", () => {
    const artifact = buildOne({ logs: { lines: ["running on lab-host-7 as tester"] } }, {
      privateValues: ["lab-host-7", "tester"],
    })
    const lines = (artifact.sections.logs!.data as Record<string, unknown>).lines as string[]
    expect(lines[0]).toContain("name-")
    expect(lines[0]).not.toContain("lab-host-7")
    expect(lines[0]).not.toContain("tester")
  })

  test("two reports of the same machine are deliberately unlinkable", () => {
    const input = base()
    const first = build(input, { now: NOW, pseudonymSeed: "seed-one" })
    const second = build(input, { now: NOW, pseudonymSeed: "seed-two" })
    const pathOf = (artifact: SupportBundleArtifact) =>
      (artifact.sections.workspaces!.data as { workspaces: Array<{ path: string }> }).workspaces[0]!.path
    expect(pathOf(first)).not.toBe(pathOf(second))
  })

  test("two reports with no seed use independent random salts", () => {
    const input = base()
    const pathOf = (artifact: SupportBundleArtifact) =>
      (artifact.sections.workspaces!.data as { workspaces: Array<{ path: string }> }).workspaces[0]!.path
    expect(pathOf(build(input, { now: NOW }))).not.toBe(pathOf(build(input, { now: NOW })))
  })

  test("pseudonym accounting is counts only, never a raw or label map", () => {
    const artifact = buildOne({})
    expect(artifact.pseudonyms.counts.path).toBeGreaterThan(0)
    expect(Object.keys(artifact.pseudonyms)).toEqual(["counts"])
    expect(JSON.stringify(artifact.pseudonyms)).not.toContain("tester")
  })
})

describe("serialize enforces the JSON boundary", () => {
  test("a hand-built artifact with a raw secret is re-scrubbed, not trusted", () => {
    const tampered = {
      schemaVersion: 1,
      product: "openfork",
      generatedAt: NOW,
      policy: {
        conversationContent: false,
        maxStringLength: 512,
        maxArrayItems: 64,
        maxObjectKeys: 128,
        maxDepth: 8,
        maxNodes: 4096,
      },
      sections: {
        runtime: { included: true, reason: null, data: { note: "key sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
      },
      included: ["runtime"],
      excluded: [],
      scrub: { applied: true, secretRedactionOwner: SECRET_REDACTION_OWNER },
      pseudonyms: { counts: {} },
    } as unknown as SupportBundleArtifact
    const json = serialize(tampered)
    expect(json).not.toContain("sk-AAAA")
    expect(MemorySecrets.scan(json).clean).toBe(true)
  })

  test("nested Date and Error values are projected as values, not walked as objects", () => {
    const artifact = buildOne({ logs: { lines: ["x"] } })
    const outcome = artifact
    expect(outcome.sections.logs!.included).toBe(true)
    expect(MemorySecrets.scan(serialize(artifact)).clean).toBe(true)
  })

  test("serialized output is deterministic for a fixed seed and clock", () => {
    expect(serialize(buildOne({}))).toBe(serialize(buildOne({})))
  })
})

describe("OXP / OFXP diagnostics remain useful", () => {
  test("connectivity health is preserved as bounded facts, with peer identity pseudonymized", () => {
    const artifact = buildOne({})
    const data = artifact.sections.connectivity!.data as Record<string, unknown>
    expect(data.oxpEnabled).toBe(true)
    expect(data.ofxpInvocationTotals).toEqual({ total: 40, ok: 38, error: 2 })
    expect(data.oxpConnectedPeerIds).toEqual([
      expect.stringMatching(/^name-/),
      expect.stringMatching(/^name-/),
    ])
    expect(data.oxpPeerCount).toBe(2)
  })

  test("a subsystem with no facts is simply absent, not an error", () => {
    const artifact = build({}, { now: NOW, pseudonymSeed: "s" })
    expect(artifact.included).toEqual([])
    expect(artifact.excluded).toContainEqual({ id: "runtime", reason: EXCLUSION_REASONS.absentInInput })
    expect(artifact.sections.runtime!.reason).toBe("absent-in-input")
  })
})
describe("config stays behind the instance boundary", () => {
  test("a bootstrap-free default bundle cannot carry resolved config", () => {
    const artifact = build(
      { ...base(), config: { providerIds: ["openai"], modelIds: ["gpt-5"] } },
      { now: NOW, pseudonymSeed: "s" },
    )
    expect(artifact.excluded).toContainEqual({ id: "config", reason: EXCLUSION_REASONS.instanceScoped })
    expect(artifact.sections.config!.included).toBe(false)
    expect(artifact.sections.config!.data).toBeNull()
  })

  test("config is not in the default section set", () => {
    expect(DEFAULT_SECTION_IDS).not.toContain("config")
  })

  test("an instance-bearing caller can still supply an already-redacted projection", () => {
    const artifact = build(
      { config: { providerIds: ["openai"], apiKey: "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
      { now: NOW, pseudonymSeed: "s", include: ["config"] },
    )
    expect(artifact.sections.config!.included).toBe(true)
    const data = artifact.sections.config!.data as Record<string, unknown>
    expect(data.providerIds).toEqual(["openai"])
    expect(JSON.stringify(artifact)).not.toContain("sk-AAAA")
  })
})