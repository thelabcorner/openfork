import { describe, expect, test } from "bun:test"
import { aggregateSessionContextByModel } from "@/components/session/session-context-model-metrics"
import { compareSessionTime, projectForSession } from "@/pages/layout/helpers"
import type { AssistantMessage, Message, Part, Session } from "@opencode-ai/sdk/v2/client"

/**
 * Micro-benchmarks for the chat-sidebar-pane hot paths (o2-cache).
 * Run: bun test --conditions=solid bench/chat-sidebar-cache-bench.test.ts
 * These are throughput probes, not correctness tests — assertions only check
 * sanity of the outputs so the engine doesn't dead-code-eliminate the work.
 */

let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

function syntheticParts(messageID: string, count: number): Part[] {
  const parts: Part[] = []
  for (let i = 0; i < count; i++) {
    if (i % 4 === 3) {
      parts.push({
        id: `${messageID}-tool-${i}`,
        messageID,
        type: "tool",
        state: {
          status: "completed",
          time: { start: 1_000_000 + i * 900, end: 1_000_000 + i * 900 + 400 + rand() * 3000 },
        },
      } as unknown as Part)
      continue
    }
    parts.push({
      id: `${messageID}-txt-${i}`,
      messageID,
      type: "text",
      time: { start: 1_000_000 + i * 700, end: 1_000_000 + i * 700 + 500 + rand() * 2500 },
      synthetic: false,
      ignored: false,
    } as unknown as Part)
  }
  return parts
}

function syntheticSession(messageCount: number): { messages: Message[]; parts: Record<string, Part[]> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  for (let i = 0; i < messageCount; i++) {
    const id = `msg_${i}`
    if (i % 3 === 0) {
      messages.push({
        id,
        sessionID: "ses_bench",
        role: "user",
        time: { created: 1_000_000 + i * 5000 },
      } as unknown as Message)
      continue
    }
    const msg = {
      id,
      sessionID: "ses_bench",
      role: "assistant",
      providerID: "anthropic",
      modelID: i % 2 ? "claude-sonnet-4" : "claude-haiku-4",
      tokens: {
        input: 800 + Math.floor(rand() * 400),
        output: 300 + Math.floor(rand() * 900),
        reasoning: Math.floor(rand() * 200),
        cache: { read: 4000 + Math.floor(rand() * 2000), write: 100 },
      },
      cost: 0.004 + rand() * 0.01,
      time: { created: 1_000_000 + i * 5000, completed: 1_000_000 + i * 5000 + 4200, firstTokenAt: 1_000_000 + i * 5000 + 300 },
    } as unknown as AssistantMessage
    messages.push(msg)
    parts[id] = syntheticParts(id, 12)
  }
  return { messages, parts }
}

function syntheticSessions(count: number): Session[] {
  const sessions: Session[] = []
  for (let i = 0; i < count; i++) {
    sessions.push({
      id: `ses_${String(i).padStart(4, "0")}`,
      projectID: "proj_x",
      directory: "C:/repos/opencode",
      title: `Session ${i}`,
      time: { created: 1_700_000_000_000 + i * 60_000, updated: 1_700_000_000_000 + i * 60_000 + Math.floor(rand() * 5000) },
    } as unknown as Session)
  }
  return sessions
}

function syntheticProjects(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `proj_${i}`,
    worktree: `C:/repos/project-${i}`,
    sandboxes: [`C:/repos/project-${i}/sbx-a`, `C:/repos/project-${i}/sbx-b`],
  }))
}

const timeMs = (fn: () => unknown, iterations: number) => {
  // warmup
  for (let i = 0; i < 3; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations
}

describe("chat sidebar cache bench", () => {
  test("aggregateSessionContextByModel — 300-message session", () => {
    const { messages, parts } = syntheticSession(300)
    const ms = timeMs(() => {
      const result = aggregateSessionContextByModel(messages, parts, [])
      return result.session.cost
    }, 50)
    expect(ms).toBeGreaterThanOrEqual(0)
    console.log(`[bench] aggregate 300 msgs: ${ms.toFixed(3)} ms/call`)
  })

  test("aggregateSessionContextByModel — 60-message session (typical sidebar row)", () => {
    const { messages, parts } = syntheticSession(60)
    const ms = timeMs(() => {
      const result = aggregateSessionContextByModel(messages, parts, [])
      return result.session.cost
    }, 200)
    expect(ms).toBeGreaterThanOrEqual(0)
    console.log(`[bench] aggregate 60 msgs: ${ms.toFixed(3)} ms/call`)
  })

  test("sort + compareSessionTime — 200 sessions", () => {
    const sessions = syntheticSessions(200)
    const ms = timeMs(() => [...sessions].sort(compareSessionTime).length, 500)
    expect(ms).toBeGreaterThanOrEqual(0)
    console.log(`[bench] sort 200 sessions: ${ms.toFixed(4)} ms/call`)
  })

  test("projectForSession — 50 projects, default-param Map allocation", () => {
    const projects = syntheticProjects(50)
    const session = syntheticSessions(1)[0]
    session.directory = "C:/repos/project-33/sbx-a"
    const ms = timeMs(() => projectForSession(session, projects), 500)
    expect(ms).toBeGreaterThanOrEqual(0)
    console.log(`[bench] projectForSession 50 projects: ${ms.toFixed(4)} ms/call`)
  })
})
