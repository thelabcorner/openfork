import { Database } from "bun:sqlite"
import { SpadDetector } from "../src/session/spad/detector"
import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { makeTurnPolicy } from "../src/session/spad/intent"
import { decideRecovery } from "../src/session/spad/policy"
import { ParameterizedBlockWatch } from "../src/session/spad/parameterized-watch"
import {
  CrossTurnWatch,
  isSpadMutatingTool,
  ToolResultProgressTracker,
  toolResultSignature,
  toolResourceKey,
} from "../src/session/spad/thrash"
import { InformationRecurrenceWatch } from "../src/session/spad/information-watch"
import { RecentThrashWatch } from "../src/session/spad/thrash-v2"
import type { RecentThrashMetrics } from "../src/session/spad/thrash-v2"
import { ToolLoopDetector } from "../src/session/spad/tool-loop"
import { SpadSupervisor } from "../src/session/spad/supervisor"
import type { PeriodDetection, SpadChannel } from "../src/session/spad/types"

type MessageRow = {
  id: string
  session_id: string
  time_created: number
  data: string
}

type PartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  text: string
  type: "text" | "reasoning"
}

type ToolPartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: string
}

type ProgressPartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
}

type CandidateExample = {
  sessionID: string
  messageID: string
  partID: string
  channel: SpadChannel
  lane: string
  source: string
  policyReason: string
  productionEligible: boolean
  period: number
  runLength: number
  exponent: number
  insideCodeFence: boolean
  userExcerpt: string
  candidateExcerpt: string
}

const dbPath = process.argv[2]
if (!dbPath) throw new Error("Usage: bun run script/spad-db-replay.ts <opencode.db> [output.json]")
const outputPath = process.argv[3]
const db = new Database(dbPath, { readonly: true, create: false, strict: true })

const assistantMessages = db
  .query<MessageRow, []>(
    `SELECT id, session_id, time_created, data
       FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
      ORDER BY time_created, id`,
  )
  .all()

const userMessages = db
  .query<MessageRow, []>(
    `SELECT id, session_id, time_created, data
       FROM message
      WHERE json_extract(data, '$.role') = 'user'
      ORDER BY time_created, id`,
  )
  .all()

const userTextRows = db
  .query<{ message_id: string; time_created: number; text: string }, []>(
    `SELECT p.message_id, p.time_created, json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
        AND json_extract(p.data, '$.text') IS NOT NULL
      ORDER BY p.message_id, p.time_created, p.id`,
  )
  .all()

const assistantParts = db
  .query<PartRow, []>(
    `SELECT p.id, p.message_id, p.session_id, p.time_created,
            json_extract(p.data, '$.text') AS text,
            json_extract(p.data, '$.type') AS type
       FROM part p
       JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') IN ('text', 'reasoning')
        AND json_extract(p.data, '$.text') IS NOT NULL
      ORDER BY p.time_created, p.id`,
  )
  .all()

const assistantToolParts = db
  .query<ToolPartRow, []>(
    `SELECT p.id, p.message_id, p.session_id, p.time_created, p.data
       FROM part p
       JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') = 'tool'
      ORDER BY p.time_created, p.id`,
  )
  .all()

const assistantProgressParts = db
  .query<ProgressPartRow, []>(
    `SELECT p.id, p.message_id, p.session_id, p.time_created
       FROM part p
       JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') = 'patch'
      ORDER BY p.time_created, p.id`,
  )
  .all()

const userText = new Map<string, string>()
for (const row of userTextRows) userText.set(row.message_id, `${userText.get(row.message_id) ?? ""}${row.text}`)
const userData = new Map(userMessages.map((row) => [row.id, JSON.parse(row.data) as any]))
const assistantData = new Map(assistantMessages.map((row) => [row.id, JSON.parse(row.data) as any]))

const byChannel = {
  text: { parts: 0, chars: 0, detections: 0 },
  reasoning: { parts: 0, chars: 0, detections: 0 },
}
const byLane = new Map<string, { parts: number; detections: number; productionEligible: number; policyReasons: Map<string, number> }>()
const examples: CandidateExample[] = []
const detectedPartLanes = new Set<string>()

function laneStats(lane: string) {
  let value = byLane.get(lane)
  if (!value) {
    value = { parts: 0, detections: 0, productionEligible: 0, policyReasons: new Map() }
    byLane.set(lane, value)
  }
  return value
}

function excerpt(text: string, detection: PeriodDetection) {
  const center = Math.max(0, Math.min(text.length, detection.runEnd || detection.runStart || 0))
  const start = Math.max(0, center - 220)
  return text.slice(start, Math.min(text.length, center + 220)).replace(/\r/g, "")
}

function replayPart(part: PartRow) {
  const channel = part.type
  byChannel[channel].parts++
  byChannel[channel].chars += part.text.length
  const detector = new SpadDetector({ channel, config: DEFAULT_SPAD_CONFIG })
  const assistant = assistantData.get(part.message_id)
  const parentID = typeof assistant?.parentID === "string" ? assistant.parentID : undefined
  const prompt = parentID ? userText.get(parentID) ?? "" : ""
  const parentData = parentID ? userData.get(parentID) : undefined
  const structured = parentData?.format?.type === "json_schema"
  const turn = makeTurnPolicy(prompt, structured)
  const seen = new Set<string>()
  const chunk = 32
  for (let i = 0; i < part.text.length; i += chunk) {
    const detection = detector.push(part.text.slice(i, i + chunk))
    if (!detection) continue
    const laneKey = `${part.id}:${detection.lane}`
    if (seen.has(detection.lane) || detectedPartLanes.has(laneKey)) continue
    seen.add(detection.lane)
    detectedPartLanes.add(laneKey)
    byChannel[channel].detections++
    const policy = decideRecovery({
      config: DEFAULT_SPAD_CONFIG,
      turn,
      partObserveOnly: false,
      evidence: detection,
    })
    const stats = laneStats(detection.lane)
    stats.detections++
    stats.parts++
    if (policy.allowed) stats.productionEligible++
    stats.policyReasons.set(policy.reason, (stats.policyReasons.get(policy.reason) ?? 0) + 1)
    if (examples.length < 120) {
      examples.push({
        sessionID: part.session_id,
        messageID: part.message_id,
        partID: part.id,
        channel,
        lane: detection.lane,
        source: detection.source,
        policyReason: policy.reason,
        productionEligible: policy.allowed,
        period: detection.period,
        runLength: detection.runLength,
        exponent: detection.exponent,
        insideCodeFence: detection.insideCodeFence,
        userExcerpt: prompt.slice(0, 360).replace(/\r/g, ""),
        candidateExcerpt: excerpt(part.text, detection),
      })
    }
  }
}

for (const part of assistantParts) replayPart(part)

// Counterfactual tool/thrash replay. Historical SPAD recoveries injected
// synthetic user messages and therefore split one logical turn in storage.
// Collapse those synthetic recovery messages back into the preceding genuine
// turn before replaying today's observe-only heuristic state machines.
const allMessages = [...userMessages, ...assistantMessages].sort(
  (a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id),
)
const assistantLogicalTurn = new Map<string, string>()
const currentTurnBySession = new Map<string, string>()
const historicalRecoveryTurns = new Map<string, Set<string>>()
const historicalRecoveryInjections = new Map<string, number>()
const historicalSecondThrashTurns = new Set<string>()
function recoveryKind(text: string) {
  if (text.includes("Tool-call")) return "tool"
  if (text.includes("same exploration") || text.includes("repetition continued across attempts")) return "thrash"
  if (text.includes("repetitive output loop") || text.includes("Repetition recurred")) return "raw"
  return "other"
}
for (const message of allMessages) {
  const data = JSON.parse(message.data) as any
  if (data.role === "user") {
    const text = userText.get(message.id) ?? ""
    if (text.startsWith("[Internal recovery")) {
      const turn = currentTurnBySession.get(message.session_id)
      if (turn) {
        const kind = recoveryKind(text)
        if (kind === "thrash" && text.startsWith("[Internal recovery: second attempt]"))
          historicalSecondThrashTurns.add(turn)
        const kinds = historicalRecoveryTurns.get(turn) ?? new Set<string>()
        kinds.add(kind)
        historicalRecoveryTurns.set(turn, kinds)
        historicalRecoveryInjections.set(kind, (historicalRecoveryInjections.get(kind) ?? 0) + 1)
      }
    } else currentTurnBySession.set(message.session_id, message.id)
    continue
  }
  if (data.role !== "assistant") continue
  const logicalTurn = currentTurnBySession.get(message.session_id)
  if (logicalTurn) assistantLogicalTurn.set(message.id, logicalTurn)
}

type ReplayEvent =
  | { readonly kind: "narration"; readonly time: number; readonly channel: SpadChannel; readonly text: string }
  | { readonly kind: "tool"; readonly time: number; readonly tool: string; readonly input: unknown }
  | { readonly kind: "toolResult"; readonly time: number; readonly tool: string; readonly input: unknown; readonly output: string }
  | { readonly kind: "progress"; readonly time: number }

const eventsByMessage = new Map<string, ReplayEvent[]>()
for (const part of assistantParts) {
  const events = eventsByMessage.get(part.message_id) ?? []
  events.push({ kind: "narration", time: part.time_created, channel: part.type, text: part.text })
  eventsByMessage.set(part.message_id, events)
}
for (const part of assistantToolParts) {
  const data = JSON.parse(part.data) as any
  const events = eventsByMessage.get(part.message_id) ?? []
  events.push({
    kind: "tool",
    time: part.time_created,
    tool: typeof data.tool === "string" ? data.tool : "unknown",
    input: data.state?.input,
  })
  const state = data.state
  if (state?.status === "completed" && typeof state.output === "string") {
    events.push({
      kind: "toolResult",
      time: typeof state.time?.end === "number" ? state.time.end : part.time_created + 0.5,
      tool: typeof data.tool === "string" ? data.tool : "unknown",
      input: state.input,
      output: state.output,
    })
  } else if (state?.status === "error") {
    events.push({
      kind: "toolResult",
      time: typeof state.time?.end === "number" ? state.time.end : part.time_created + 0.5,
      tool: typeof data.tool === "string" ? data.tool : "unknown",
      input: state.input,
      output: `[tool-error] ${String(state.error ?? "unknown")}`,
    })
  }
  eventsByMessage.set(part.message_id, events)
}
for (const part of assistantProgressParts) {
  const events = eventsByMessage.get(part.message_id) ?? []
  events.push({ kind: "progress", time: part.time_created })
  eventsByMessage.set(part.message_id, events)
}
for (const events of eventsByMessage.values()) events.sort((a, b) => a.time - b.time)

const generationsByTurn = new Map<string, MessageRow[]>()
for (const message of assistantMessages) {
  const turn = assistantLogicalTurn.get(message.id)
  if (!turn) continue
  const list = generationsByTurn.get(turn) ?? []
  list.push(message)
  generationsByTurn.set(turn, list)
}
for (const list of generationsByTurn.values()) list.sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))

let replayGenerations = 0
let replayToolCalls = 0
let replayMutations = 0
let toolLoopTurns = 0
let thrashTurns = 0
let recentThrashTurns = 0
const informationThresholds = [3, 4, 5] as const
const informationTurns = new Map<number, Set<string>>(informationThresholds.map((threshold) => [threshold, new Set<string>()]))
const informationExamples = new Map<number, Array<Record<string, unknown>>>(
  informationThresholds.map((threshold) => [threshold, []]),
)
const currentToolTurns = new Set<string>()
const currentThrashTurns = new Set<string>()
const currentRecentThrashTurns = new Set<string>()
const supervisorLaneTurns = new Map<string, Set<string>>()
const supervisorAuditSourceTurns = new Map<string, Set<string>>()
const recentThrashBestByTurn = new Map<string, RecentThrashMetrics>()
const recentTraceByTurn = new Map<string, Array<Record<string, unknown>>>()
const pushTrace = (turnID: string, entry: Record<string, unknown>) => {
  const trace = recentTraceByTurn.get(turnID) ?? []
  trace.push(entry)
  while (trace.length > 32) trace.shift()
  recentTraceByTurn.set(turnID, trace)
}
const recentMetricScore = (m: RecentThrashMetrics) => {
  if (m.generations < 4 || m.mutations > 0 || m.toolCalls < 4 || m.resourceObservations < 4) return -1
  const fullPeriod =
    m.periodComparisons >= 2 &&
    m.recurringResourcePairs === m.periodComparisons &&
    m.recurringNarrationPairs === m.periodComparisons
  return (
    (fullPeriod ? 100 : 0) +
    m.reaccessRatio +
    m.meanResourceJaccard +
    m.meanNarrationDice +
    Math.min(1, m.recurringResourcePairs / 3)
  )
}
const retainRecentMetrics = (turnID: string, watch: RecentThrashWatch) => {
  const metrics = watch.metrics()
  const previous = recentThrashBestByTurn.get(turnID)
  if (!previous || recentMetricScore(metrics) > recentMetricScore(previous)) recentThrashBestByTurn.set(turnID, metrics)
}
const heuristicExamples: Array<Record<string, unknown>> = []
for (const [turnID, generations] of generationsByTurn) {
  const replayTurnPolicy = makeTurnPolicy(userText.get(turnID) ?? "")
  const supervisor = new SpadSupervisor({ ...DEFAULT_SPAD_CONFIG, autoRecoverRaw: false })
  supervisor.beginTurn(replayTurnPolicy)
  const recordSupervisorAction = (action: ReturnType<SpadSupervisor["push"]>) => {
    if (!action) return
    const lane = action.detection.lane
    const turns = supervisorLaneTurns.get(lane) ?? new Set<string>()
    turns.add(turnID)
    supervisorLaneTurns.set(lane, turns)
  }
  const thrash = new CrossTurnWatch(DEFAULT_SPAD_CONFIG)
  const recentThrash = new RecentThrashWatch()
  const tools = new ToolLoopDetector()
  const toolResults = new ToolResultProgressTracker()
  const informationWatches = new Map(
    informationThresholds.map((threshold) => [
      threshold,
      new InformationRecurrenceWatch({ minConsecutiveGenerations: threshold }),
    ]),
  )
  let toolHit = false
  let thrashHit = false
  let recentThrashHit = false
  let turnTools = 0
  let turnMutations = 0
  for (let generationIndex = 0; generationIndex < generations.length; generationIndex++) {
    const generation = generations[generationIndex]!
    replayGenerations++
    supervisor.markGeneration()
    thrash.markGeneration()
    recentThrash.markGeneration()
    for (const watch of informationWatches.values()) watch.markGeneration()
    const events = eventsByMessage.get(generation.id) ?? []
    for (const event of events) {
      if (event.kind === "progress") {
        pushTrace(turnID, { generationIndex, kind: "progress" })
        thrash.markProgress()
        recentThrash.markProgress()
        tools.markProgress()
        toolResults.reset()
        for (const watch of informationWatches.values()) watch.markProgress()
        supervisor.markProgress()
        continue
      }
      if (event.kind === "narration") {
        const compact = event.text.replace(/\s+/g, " ").trim()
        if (compact)
          pushTrace(turnID, {
            generationIndex,
            kind: "narration",
            channel: event.channel,
            text: compact.slice(0, 240),
          })
        thrash.pushNarration(event.text)
        recentThrash.pushNarration(event.text)
        supervisor.startPart(event.channel)
        recordSupervisorAction(supervisor.push(event.text))
        retainRecentMetrics(turnID, recentThrash)
        continue
      }
      if (event.kind === "toolResult") {
        const resource = toolResourceKey(event.tool, event.input)
        const signature = toolResultSignature(event.output)
        const isMutatingResult = isSpadMutatingTool(event.tool)
        const changed = !isMutatingResult && toolResults.observeSignature(resource, signature)
        pushTrace(turnID, { generationIndex, kind: "toolResult", tool: event.tool, resource, changed })
        if (!isMutatingResult) recentThrash.pushResult(resource, signature)
        if (changed) {
          thrash.markProgress()
          tools.markProgress()
        }
        if (!isMutatingResult) {
          for (const [threshold, watch] of informationWatches) {
            const hit = watch.pushSignature(resource, signature)
            if (!hit) continue
            const turns = informationTurns.get(threshold)!
            if (turns.has(turnID)) continue
            turns.add(turnID)
            const examples = informationExamples.get(threshold)!
            if (examples.length < 40)
              examples.push({
                turnID,
                sessionID: generation.session_id,
                generationID: generation.id,
                generationIndex,
                generationCount: generations.length,
                tool: event.tool,
                resource,
                recurrences: hit.recurrences,
                startGeneration: hit.startGeneration,
                endGeneration: hit.endGeneration,
                mutationForbidden: replayTurnPolicy.mutationForbidden,
                userPrompt: (userText.get(turnID) ?? "").replace(/\s+/g, " ").slice(0, 600),
                recentTrace: [...(recentTraceByTurn.get(turnID) ?? [])],
              })
          }
        }
        recordSupervisorAction(supervisor.pushToolResult(resource, event.output, isMutatingResult))
        if (!replayTurnPolicy.mutationForbidden && !thrashHit && thrash.evaluate("text")) {
          thrashHit = true
          if (heuristicExamples.length < 80)
            heuristicExamples.push({
              kind: "thrash",
              sessionID: generation.session_id,
              turnID,
              generationID: generation.id,
              generationIndex,
              generationCount: generations.length,
              toolCalls: turnTools,
              mutations: turnMutations,
              userPrompt: (userText.get(turnID) ?? "").replace(/\s+/g, " ").slice(0, 600),
              recentTrace: [...(recentTraceByTurn.get(turnID) ?? [])],
            })
        }
        if (!recentThrashHit && recentThrash.evaluate("text")) recentThrashHit = true
        retainRecentMetrics(turnID, recentThrash)
        continue
      }
      replayToolCalls++
      turnTools++
      const isMutating = isSpadMutatingTool(event.tool)
      if (isMutating) {
        replayMutations++
        turnMutations++
      }
      const resource = toolResourceKey(event.tool, event.input)
      pushTrace(turnID, {
        generationIndex,
        kind: "tool",
        tool: event.tool,
        mutating: isMutating,
        resource,
      })
      thrash.pushTool(event.tool, isMutating, resource)
      recentThrash.pushTool(event.tool, isMutating, resource)
      recordSupervisorAction(supervisor.pushTool(event.tool, isMutating, resource))
      retainRecentMetrics(turnID, recentThrash)
      if (!toolHit && tools.push(event.tool, isMutating, resource)) {
        toolHit = true
        if (heuristicExamples.length < 80)
          heuristicExamples.push({
            kind: "tool",
            sessionID: generation.session_id,
            turnID,
            generationID: generation.id,
            generationIndex,
            generationCount: generations.length,
            toolCalls: turnTools,
            mutations: turnMutations,
            tool: event.tool,
            resource,
            userPrompt: (userText.get(turnID) ?? "").replace(/\s+/g, " ").slice(0, 600),
            recentTrace: [...(recentTraceByTurn.get(turnID) ?? [])],
          })
      }
    }
  }
  if (toolHit) toolLoopTurns++
  if (toolHit) currentToolTurns.add(turnID)
  if (thrashHit) {
    thrashTurns++
    currentThrashTurns.add(turnID)
  }
  if (recentThrashHit) {
    recentThrashTurns++
    currentRecentThrashTurns.add(turnID)
  }
  for (const audit of supervisor.takeAuditCases()) {
    const source = audit.detection.source
    const turns = supervisorAuditSourceTurns.get(source) ?? new Set<string>()
    turns.add(turnID)
    supervisorAuditSourceTurns.set(source, turns)
  }
}

const historicalTurnSet = (kind: string) =>
  new Set([...historicalRecoveryTurns.entries()].filter(([, kinds]) => kinds.has(kind)).map(([turn]) => turn))
const historicalThrashTurns = historicalTurnSet("thrash")
const historicalToolTurns = historicalTurnSet("tool")
const historicalRawTurns = historicalTurnSet("raw")
const overlapCount = (a: Set<string>, b: Set<string>) => [...a].filter((value) => b.has(value)).length

// Structural matching is intentionally code-specific. Replay only fenced JS/TS
// bodies and reset the sustained watch at each fence boundary.
const jsFence = /```(?:ts|tsx|typescript|js|jsx|javascript)\s*\r?\n([\s\S]*?)```/gi
let codeFences = 0
let codeLines = 0
let structuralDetections = 0
const structuralExamples: Array<Record<string, unknown>> = []
for (const part of assistantParts) {
  if (part.type !== "text" || !part.text.includes("```")) continue
  jsFence.lastIndex = 0
  for (;;) {
    const match = jsFence.exec(part.text)
    if (!match) break
    codeFences++
    const watch = new ParameterizedBlockWatch()
    const body = match[1] ?? ""
    const lines = body.split(/\r?\n/)
    codeLines += lines.length
    for (const line of lines) {
      const detection = watch.pushLine(line)
      if (!detection) continue
      structuralDetections++
      if (structuralExamples.length < 40) {
        structuralExamples.push({
          sessionID: part.session_id,
          messageID: part.message_id,
          partID: part.id,
          startLine: detection.startLine,
          previousStartLine: detection.previousStartLine,
          recurrence: detection.recurrence,
          evidence: detection.evidence,
          excerpt: lines.slice(Math.max(0, detection.startLine - 9), detection.startLine + 8).join("\n").slice(0, 1800),
        })
      }
    }
  }
}

const productionInformationTurns = informationTurns.get(3) ?? new Set<string>()
const replacementUnionTurns = new Set<string>([...productionInformationTurns, ...currentRecentThrashTurns])
const uncoveredLegacyThrashTurns = [...currentThrashTurns].filter((turn) => !replacementUnionTurns.has(turn))

const report = {
  schemaVersion: 1,
  database: dbPath,
  assistantMessages: assistantMessages.length,
  assistantParts: assistantParts.length,
  channels: byChannel,
  lanes: Object.fromEntries(
    [...byLane.entries()].map(([lane, value]) => [
      lane,
      {
        parts: value.parts,
        detections: value.detections,
        productionEligible: value.productionEligible,
        policyReasons: Object.fromEntries([...value.policyReasons.entries()].sort((a, b) => b[1] - a[1])),
      },
    ]),
  ),
  structural: {
    jsTsCodeFences: codeFences,
    codeLines,
    detections: structuralDetections,
    examples: structuralExamples,
  },
  heuristicReplay: {
    logicalTurns: generationsByTurn.size,
    generations: replayGenerations,
    toolCalls: replayToolCalls,
    mutations: replayMutations,
    toolLoopTurns,
    toolLoopTurnRate: generationsByTurn.size ? toolLoopTurns / generationsByTurn.size : 0,
    thrashTurns,
    thrashTurnRate: generationsByTurn.size ? thrashTurns / generationsByTurn.size : 0,
    recentThrashTurns,
    recentThrashTurnRate: generationsByTurn.size ? recentThrashTurns / generationsByTurn.size : 0,
    replacementCoverage: {
      legacyCumulativeThrashTurns: currentThrashTurns.size,
      passiveInformationTurns: productionInformationTurns.size,
      boundedStateCycleTurns: currentRecentThrashTurns.size,
      legacyCoveredByInformation: overlapCount(currentThrashTurns, productionInformationTurns),
      legacyCoveredByStateCycle: overlapCount(currentThrashTurns, currentRecentThrashTurns),
      legacyCoveredByUnion: overlapCount(currentThrashTurns, replacementUnionTurns),
      uncoveredLegacyThrashTurns,
    },
    productionSupervisorReplay: {
      actionLaneTurns: Object.fromEntries([...supervisorLaneTurns].map(([lane, turns]) => [lane, turns.size])),
      survivingAuditSourceTurns: Object.fromEntries(
        [...supervisorAuditSourceTurns].map(([source, turns]) => [source, turns.size]),
      ),
    },
    informationRecurrence: Object.fromEntries(
      informationThresholds.map((threshold) => {
        const turns = informationTurns.get(threshold)!
        return [
          threshold,
          {
            turns: turns.size,
            turnRate: generationsByTurn.size ? turns.size / generationsByTurn.size : 0,
            historicalThrashOverlap: overlapCount(turns, historicalThrashTurns),
            examples: informationExamples.get(threshold),
          },
        ]
      }),
    ),
    recentThrashCalibration: [...recentThrashBestByTurn.entries()].map(([turnID, metrics]) => ({
      turnID,
      historicalThrash: historicalThrashTurns.has(turnID),
      historicalSecondThrash: historicalSecondThrashTurns.has(turnID),
      ...metrics,
    })),
    historicalRecovery: {
      injections: Object.fromEntries(historicalRecoveryInjections),
      turns: {
        raw: historicalRawTurns.size,
        tool: historicalToolTurns.size,
        thrash: historicalThrashTurns.size,
      },
      overlap: {
        currentToolWithHistoricalTool: overlapCount(currentToolTurns, historicalToolTurns),
        currentThrashWithHistoricalThrash: overlapCount(currentThrashTurns, historicalThrashTurns),
        currentThrashWithoutHistoricalThrash: [...currentThrashTurns].filter((turn) => !historicalThrashTurns.has(turn)).length,
        recentThrashWithHistoricalThrash: overlapCount(currentRecentThrashTurns, historicalThrashTurns),
        recentThrashWithoutHistoricalThrash: [...currentRecentThrashTurns].filter((turn) => !historicalThrashTurns.has(turn)).length,
      },
    },
    examples: heuristicExamples,
  },
  examples,
}

const encoded = JSON.stringify(report, null, 2)
if (outputPath) await Bun.write(outputPath, encoded)
const concise = {
  schemaVersion: report.schemaVersion,
  database: report.database,
  assistantMessages: report.assistantMessages,
  assistantParts: report.assistantParts,
  channels: report.channels,
  lanes: report.lanes,
  structural: {
    jsTsCodeFences: report.structural.jsTsCodeFences,
    codeLines: report.structural.codeLines,
    detections: report.structural.detections,
  },
  heuristicReplay: {
    logicalTurns: report.heuristicReplay.logicalTurns,
    generations: report.heuristicReplay.generations,
    toolCalls: report.heuristicReplay.toolCalls,
    mutations: report.heuristicReplay.mutations,
    toolLoopTurns: report.heuristicReplay.toolLoopTurns,
    thrashTurns: report.heuristicReplay.thrashTurns,
    recentThrashTurns: report.heuristicReplay.recentThrashTurns,
    productionSupervisorReplay: report.heuristicReplay.productionSupervisorReplay,
    informationRecurrence: Object.fromEntries(
      Object.entries(report.heuristicReplay.informationRecurrence).map(([threshold, value]) => [
        threshold,
        {
          turns: value.turns,
          turnRate: value.turnRate,
          historicalThrashOverlap: value.historicalThrashOverlap,
        },
      ]),
    ),
    historicalRecovery: report.heuristicReplay.historicalRecovery,
  },
}
// When an output path is supplied, keep the full forensic report in the file
// and print only the actionable summary. Omitting the path retains the original
// stdout behavior for ad-hoc inspection.
console.log(outputPath ? JSON.stringify(concise, null, 2) : encoded)
db.close()
