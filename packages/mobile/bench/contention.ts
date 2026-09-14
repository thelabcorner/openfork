import { boundedToolPreview, parseToolText } from "../src/components/tools/parse"
import { parseShellOutput } from "../src/components/tools/ansi"
import { project } from "../src/markdown/stream"
import { MessageStreamProjection, reduceMessageEvent } from "../src/messageStream"

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function bench(name: string, fn: () => void, iterations = 5) {
  fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  console.log(`${name}: ${median(samples).toFixed(3)} ms median`)
}

function bundle(id: string, text = "history") {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "assistant",
      parentID: "",
      providerID: "openai",
      modelID: "model",
      mode: "build",
      agent: "build",
      path: { cwd: "", root: "" },
      time: { created: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text, time: { start: 1 } }],
  } as any
}

function reducerCase(history: number, delta: string, rounds = 500) {
  let messages = Array.from({ length: history }, (_, i) => bundle(`m${i}`))
  const messageID = `m${history - 1}`
  const partID = `p-${messageID}`
  const start = performance.now()
  for (let i = 0; i < rounds; i++) {
    messages = reduceMessageEvent(messages, "message.part.delta", {
      sessionID: "s1",
      messageID,
      partID,
      field: "text",
      delta,
    }).messages
  }
  return ((performance.now() - start) * 1000) / rounds
}

function projectionCase(history: number, delta: string, rounds = 500) {
  const projection = new MessageStreamProjection(Array.from({ length: history }, (_, i) => bundle(`m${i}`)))
  const messageID = `m${history - 1}`
  const partID = `p-${messageID}`
  const start = performance.now()
  for (let i = 0; i < rounds; i++) {
    projection.apply("message.part.delta", { sessionID: "s1", messageID, partID, field: "text", delta })
  }
  return ((performance.now() - start) * 1000) / rounds
}

console.log("\nReducer hot-tail cost")
for (const history of [100, 1_000, 5_000]) {
  console.log(`${history} messages, 1-char: ${reducerCase(history, "x").toFixed(2)} us/admitted delta`)
  console.log(`${history} messages, 64-char: ${reducerCase(history, "x".repeat(64)).toFixed(2)} us/admitted delta`)
  console.log(`${history} messages, renderer projection 1-char: ${projectionCase(history, "x").toFixed(2)} us/admitted delta`)
}

console.log("\nMarkdown 100 KiB append-only prose")
const target = 100 * 1024
const chunk = "ordinary prose without structural markdown tokens ".repeat(2)
bench("incremental projection", () => {
  let text = ""
  let projection: ReturnType<typeof project> | undefined
  while (text.length < target) {
    const appendFrom = projection?.text.length
    text += chunk
    projection = project(projection, text, true, appendFrom, chunk)
  }
})

console.log("\nMarkdown 100 KiB open TypeScript fence")
const codeChunk = "const value: number = 42; console.log(value)\n".repeat(2)
bench("incremental code projection", () => {
  let text = "```ts\n"
  let projection = project(undefined, text, true)
  while (text.length < target) {
    const appendFrom = projection.text.length
    text += codeChunk
    projection = project(projection, text, true, appendFrom, codeChunk)
  }
})

console.log("\n8 MiB generic tool output")
const eightMiB = ("line 123: abcdefghijklmnopqrstuvwxyz\n").repeat(240_000).slice(0, 8 * 1024 * 1024)
bench("full ANSI + structure parse", () => {
  parseToolText(parseShellOutput(eightMiB).text)
}, 3)
const preview = boundedToolPreview(eightMiB)
console.log(`bounded preview: ${preview.text.length} chars retained of ${eightMiB.length}`)
bench("bounded ANSI + structure parse", () => {
  parseToolText(parseShellOutput(preview.text).text)
}, 7)
