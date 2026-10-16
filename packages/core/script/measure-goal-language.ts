/**
 * Deterministic Goal-language hot-path probe. No model/API requests.
 * Run from packages/core: bun script/measure-goal-language.ts
 *
 * Measurements are approximate local JavaScript execution times, not end-to-end
 * Goal completion, inference latency, or production success probability.
 */
import { GoalCreationPolicy as Goal } from "../src/goal/creation-policy"

type Turn = Parameters<typeof Goal.authorize>[0]
const simple: Turn = { userMessageID: "simple", userText: "Please make this project a Goal." }
const explanatory: Turn = {
  userMessageID: "explanation",
  userText: "Could you explain how to create a Goal? The docs say \"create a goal\".",
}
const mixed: Turn = {
  userMessageID: "mixed",
  userText: "What does Goal Mode do? Okay, um, please make the migration a durable Goal, but don't start it yet.",
}
const history: Turn = {
  userMessageID: "current",
  userText: "Continue with the implementation.",
  priorUserTurns: [
    ...Array.from({ length: 62 }, (_, n) => ({
      userMessageID: `previous-${n}`,
      userText: `Review the workstream ${n}; then continue.`,
    })),
    { userMessageID: "original", userText: "Create a Goal for this entire implementation." },
  ],
}
const long: Turn = {
  userMessageID: "long",
  userText: Array.from({ length: 170 }, () => "Review the code and explain the test failures. ").join("") +
    "\nPlease make this a Goal.",
}

function measure(name: string, turn: Turn, iterations: number, expectAllowed: boolean) {
  for (let i = 0; i < 64; i++) Goal.authorize(turn)
  const samples: number[] = []
  let allowed = 0
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    if (Goal.authorize(turn).allowed) allowed++
    samples.push((performance.now() - start) * 1000)
  }
  samples.sort((a, b) => a - b)
  if (allowed !== (expectAllowed ? iterations : 0)) {
    throw new Error(`Goal-language benchmark correctness failure: ${name} produced ${allowed}/${iterations} allowed`)
  }
  const pct = (p: number) => Number(samples[Math.floor((samples.length - 1) * p)]!.toFixed(3))
  return {
    name, iterations, allowed,
    medianUs: pct(0.5), p95Us: pct(0.95),
    meanUs: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)),
  }
}

console.log(JSON.stringify({
  runtime: typeof Bun !== "undefined" ? Bun.version : "JS",
  measures: [
    measure("simple creation", simple, 5000, true),
    measure("explanatory abstention", explanatory, 5000, false),
    measure("mixed instructions", mixed, 5000, true),
    measure("64-turn bounded history", history, 300, true),
    measure("long human message", long, 300, true),
  ],
}, null, 2))
