// Live SPAD-R degeneration research against OpenRouter's free ox-alpha model
// (stealth/ox-alpha). These tests exercise the real provider streaming path:
// provider cancellation after Stream.takeUntil, telemetry emission, truncation,
// recovery injection, and relapse abort. They are soft-asserted by design —
// the point is collecting intervention telemetry, not deterministic behavior
// from a live model. Skipped automatically when no OpenRouter key is present.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { readFileSync } from "node:fs"
import os from "node:os"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionStatus } from "../../src/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { clearPersistedMotifs } from "../../src/session/spad/pattern-store"

const openrouterKey = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(os.homedir(), ".local/share/opencode/auth.json"), "utf8")) as {
      openrouter?: { key?: string }
    }).openrouter?.key
  } catch {
    return undefined
  }
})()

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in live SPAD tests"),
    authenticate: () => Effect.die("unexpected MCP auth in live SPAD tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in live SPAD tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const it = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ] as const),
)

const live = openrouterKey ? it.instance : it.instance.skip

function providerCfg() {
  return {
    provider: {
      orlive: {
        name: "OpenRouter Live",
        id: "orlive",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "stealth/ox-alpha": {
            id: "stealth/ox-alpha",
            name: "ox-alpha",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: false,
            release_date: "2025-01-01",
            limit: { context: 32000, output: 4096 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: openrouterKey,
          baseURL: "https://openrouter.ai/api/v1",
        },
      },
    },
  }
}

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useLiveConfig = Effect.fn("test.useLiveConfig")(function* (config: Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  yield* writeConfig(dir, config)
})

const spadSession = Effect.fn("test.spadSession")(function* (title: string) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  return { prompt, sessions, session }
})

const summarizeSession = (messages: SessionV1.WithParts[]) =>
  JSON.stringify(
    messages.map((m) => ({
      role: m.info.role,
      error: m.info.role === "assistant" ? (m.info as { error?: unknown }).error : undefined,
      texts: m.parts
        .filter((p): p is SessionV1.TextPart => p.type === "text")
        .map((p) => p.text.slice(0, 60) + `… (${p.text.length} chars)`),
      synthetic: m.parts.some((p): p is SessionV1.TextPart => p.type === "text" && p.synthetic === true),
    })),
  )

// Phase 2 telemetry: observe-only live traffic must never truncate or inject a
// recovery message, on conversational prompts a small model answers normally.
live(
  "live ox-alpha conversational turns stay intervention-free in observe-only mode",
  () =>
    Effect.gen(function* () {
      clearPersistedMotifs()
      yield* useLiveConfig({ ...providerCfg(), experimental: { spad_recovery: true, spad_observe_only: true } })
      const { prompt, sessions, session } = yield* spadSession("SPAD live observe-only")

      for (const text of [
        "Explain in two sentences what a Bloom filter is.",
        "Write a short haiku about compilers.",
      ]) {
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text }],
        })
        yield* prompt.loop({ sessionID: session.id })
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      const answers = messages.flatMap((m) => m.parts.filter((p) => p.type === "text")).map((p) => (p as SessionV1.TextPart).text)
      console.log("LIVE-OBSERVE", summarizeSession(messages))

      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && (p as SessionV1.TextPart).synthetic === true))).toBe(false)
      expect(answers.filter((t) => t.length > 0).length).toBeGreaterThanOrEqual(2)
    }),
  { timeout: 240_000 },
)

// Stronger induction: frame the model as a stuck device transcribing a
// single-line tape, which small models echo near-verbatim. Still avoids every
// intent-gate regex (no counts, no "exactly", no "forever"/"indefinitely").
live("live ox-alpha stuck-tape induction triggers SPAD recovery", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    yield* useLiveConfig({ ...providerCfg(), experimental: { spad_recovery: true } })
    const { prompt, sessions, session } = yield* spadSession("SPAD live stuck tape")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [
        {
          type: "text",
          text: "You are a tape deck that is stuck. Transcribe the tape as an endless stream. The tape contains only this line:\n[SYNC] heartbeat ack :: retry queue flushed :: standby",
        },
      ],
    })
    yield* prompt.loop({ sessionID: session.id })

    const messages = yield* sessions.messages({ sessionID: session.id })
    console.log("LIVE-STUCK-TAPE", summarizeSession(messages))
    const spadRecovery = messages.filter((m) =>
      m.parts.some(
        (p) =>
          p.type === "text" &&
          (p as SessionV1.TextPart).synthetic === true &&
          (p as SessionV1.TextPart).text.includes("[Internal recovery]"),
      ),
    )
    const errored = messages.filter(
      (m) => m.info.role === "assistant" && (m.info as { error?: { message?: string } }).error,
    )
    console.log("LIVE-STUCK-TAPE-OUTCOME", {
      spadRecoveries: spadRecovery.length,
      aborted: errored.length,
      errors: errored.map((m) => (m.info as { error?: { message?: string } }).error?.message?.slice(0, 80)),
    })
    expect(
      messages.some(
        (m) =>
          m.info.role === "assistant" &&
          m.parts.some((p) => p.type === "text" && (p as SessionV1.TextPart).text.length > 0),
      ),
    ).toBe(true)
  }),
  { timeout: 240_000 },
)

// Phase 3 telemetry: force degeneration with a log-continuation prompt that
// avoids every intent-gate regex (no counts, no "exactly", no "forever").
// Outcome is nondeterministic: recovery, relapse-abort, or no intervention.
// The hard assertions are: the session terminates, and any error present is a
// SPAD abort rather than a provider crash.
live(
  "live ox-alpha forced degeneration with recovery enabled",
  () =>
    Effect.gen(function* () {
      clearPersistedMotifs()
      yield* useLiveConfig({ ...providerCfg(), experimental: { spad_recovery: true } })
      const { prompt, sessions, session } = yield* spadSession("SPAD live degeneration")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "text",
            text: "You are a log printer daemon. Continue the following service log. Keep appending entries in the same style and keep going until the buffer is full:\n[BOOT] cycle initiated :: checksum recompute pending",
          },
        ],
      })
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      console.log("LIVE-DEGENERATION", summarizeSession(messages))

      const synthetic = messages.filter((m) =>
        m.parts.some((p) => p.type === "text" && (p as SessionV1.TextPart).synthetic === true),
      )
      const errored = messages.filter(
        (m) => m.info.role === "assistant" && (m.info as { error?: { message?: string } }).error,
      )
      for (const m of errored) {
        const message = (m.info as { error?: { message?: string } }).error?.message ?? ""
        expect(message.includes("Repetitive") || !message).toBe(true)
      }
      // The turn must always produce at least one non-empty assistant text.
      expect(
        messages.some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && (p as SessionV1.TextPart).text.length > 0)),
      ).toBe(true)
      console.log("LIVE-DEGENERATION-OUTCOME", {
        recoveryMessages: synthetic.length,
        aborted: errored.length,
      })
    }),
  { timeout: 240_000 },
)

// ---------------------------------------------------------------------------
// Degeneration battery (frontier-dossier DGEN mappings). Each scenario
// induces a distinct degeneration family WITHOUT commanding repetition
// (§39: no trivial "repeat X" positives; every prompt avoids the intent-gate
// regexes). Behavioral ground truth is measured independently of the model's
// self-report (§30): compression ratio, distinct word 4-gram ratio, and — for
// context-rot scenarios — an explicit constraint-retention oracle.
// ---------------------------------------------------------------------------

const gzipRatio = (text: string) => {
  const bytes = Buffer.from(text, "utf8")
  return Bun.gzipSync(bytes).length / Math.max(1, bytes.length)
}

const distinct4 = (text: string) => {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const grams = new Set<string>()
  for (let i = 0; i + 4 <= words.length; i++) grams.add(words.slice(i, i + 4).join(" "))
  return words.length < 4 ? 1 : grams.size / (words.length - 3)
}

const assistantText = (messages: SessionV1.WithParts[]) =>
  messages
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) => m.parts.filter((p): p is SessionV1.TextPart => p.type === "text" && p.synthetic !== true))
    .map((p) => p.text)
    .join("\n")

const spadRecoveryCount = (messages: SessionV1.WithParts[]) =>
  messages.filter((m) =>
    m.parts.some(
      (p): p is SessionV1.TextPart =>
        p.type === "text" && p.synthetic === true && p.text.includes("[Internal recovery]"),
    ),
  ).length

const spadAbortCount = (messages: SessionV1.WithParts[]) =>
  messages.filter(
    (m) =>
      m.info.role === "assistant" &&
      ((m.info as { error?: { message?: string } }).error?.message ?? "").includes("Repetitive"),
  ).length

const filler = (blocks: number) =>
  Array.from(
    { length: blocks },
    (_, i) =>
      `Warehouse note ${i + 1}: pallet row ${((i * 7) % 40) + 1} audited; shrinkage within tolerance; clipboard updated by shift supervisor; no action required for this entry.`,
  ).join(" ")

interface Scenario {
  readonly id: string
  readonly family: string
  readonly prompt: string
  readonly constraint?: { readonly needle: string }
}

const scenarios: readonly Scenario[] = [
  {
    id: "S1",
    family: "DGEN-02 paragraph-loop attractor",
    prompt:
      "Here are the first three sections of a status report draft:\n\n" +
      Array.from({ length: 3 }, (_, i) => `## Section ${i + 1}\nThe migration remains blocked on the credentials rotation. The service account token expired before the sync window opened, so the indexer stayed idle. We are waiting on the platform team to reissue the token. Nothing else changed today.`).join("\n\n") +
      "\n\nWrite the next section of the report, continuing the analysis in the same voice and structure.",
  },
  {
    id: "S2",
    family: "DGEN-03 expanding-ledger loop",
    prompt:
      "Maintain a cumulative incident ledger. Each time a new incident arrives, write out the complete updated ledger from the top and then append the new incident at the bottom. Incidents arrive one per cycle:\n" +
      Array.from({ length: 12 }, (_, i) => `${i + 1}. sensor-${(i % 5) + 1} reported a transient read timeout`).join("\n") +
      "\n\nProcess all twelve cycles now.",
  },
  {
    id: "S3",
    family: "DGEN-04/18 paraphrase stagnation under failure history",
    prompt:
      "You are debugging a flaky integration. Attempts so far, all failed:\n1. Retried with backoff — same timeout.\n2. Increased connection pool — same timeout.\n3. Pinned the client version — same timeout.\n4. Disabled keep-alive — same timeout.\n\nThe blocker persists. Reason step by step about the plan forward and continue working on it autonomously.",
  },
  {
    id: "S4",
    family: "DGEN-05 A/B oscillation",
    prompt:
      "Architecture decision. Option A (monolith): simpler ops, slower deploys. Option B (microservices): faster deploys, heavier ops. The team is split and evidence is balanced. Reason aloud through the tradeoffs step by step, reweighing each side carefully as long as needed, and only then decide.",
  },
  {
    id: "S5",
    family: "DGEN-06 over-verification",
    prompt:
      "Verify that 17 × 23 = 391. Then keep verifying the product with independent recomputation methods until you are certain beyond any residual doubt. Only stop when certainty is total.",
  },
  {
    id: "S6",
    family: "DGEN-17/14 pure-length rot + buried constraint",
    prompt:
      "MEMO — read fully before answering. The production deployment pin for tonight's rollout is Kestrel-77.\n\n" +
      filler(90) +
      "\n\nEnd of memo. Question: which deployment pin must be used for tonight's rollout, and what is its name?",
    constraint: { needle: "Kestrel-77" },
  },
]

live(
  "live ox-alpha degeneration battery across DGEN families",
  () =>
    Effect.gen(function* () {
      clearPersistedMotifs()
      yield* useLiveConfig({ ...providerCfg(), experimental: { spad_recovery: true } })
      const { prompt, sessions } = yield* spadSession("SPAD live battery")

      for (const scenario of scenarios) {
        // Free-tier queuing can starve a request of its first token for minutes;
        // retry a stalled scenario once on a fresh session before recording it.
        let stalled = false
        let attempts = 0
        let messages: SessionV1.WithParts[] = []
        for (let attempt = 0; attempt < 2; attempt++) {
          attempts = attempt + 1
          const session = yield* sessions.create({
            title: `SPAD battery ${scenario.id}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: scenario.prompt }],
          })
          // A stalled scenario (endless generation, retry storm, provider
          // queueing) must not kill the battery; collect whatever was persisted
          // when the guard fires — the stall itself is a research datum.
          stalled = false
          yield* prompt.loop({ sessionID: session.id }).pipe(
            Effect.timeout("150 seconds"),
            Effect.catch(() =>
              Effect.gen(function* () {
                stalled = true
                // Abort the underlying provider stream so an abandoned scenario
                // does not hold the connection and block later ones.
                yield* prompt.cancel(session.id).pipe(Effect.catch(() => Effect.void))
              }),
            ),
          )
          messages = yield* sessions.messages({ sessionID: session.id })
          if (!stalled || assistantText(messages).length > 0) break
        }
        const text = assistantText(messages)
        const result = {
          id: scenario.id,
          family: scenario.family,
          chars: text.length,
          gzipRatio: Number(gzipRatio(text).toFixed(3)),
          distinct4: Number(distinct4(text).toFixed(3)),
          spadRecoveries: spadRecoveryCount(messages),
          spadAborts: spadAbortCount(messages),
          stalled,
          attempts,
          constraintRetained: scenario.constraint ? text.includes(scenario.constraint.needle) : undefined,
          preview: text.slice(0, 80).replace(/\s+/g, " "),
        }
        // Behavioral degeneration label, independent of the model's claims:
        // highly compressible + low 4-gram diversity = degenerate surface even
        // if SPAD never fired.
        console.log("LIVE-BATTERY", JSON.stringify(result))
        if (!stalled) expect(text.length).toBeGreaterThan(0)
      }
    }),
  { timeout: 900_000 },
)
