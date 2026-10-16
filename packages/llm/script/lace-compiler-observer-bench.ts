/**
 * Offline native compiler cost comparison. Same LLMClient.prepare() pipeline
 * either observed or not, no provider calls or transport streams executed.
 * Measures a prototype witness that hashes the already-prepared body.
 */
import { Effect } from "effect"
import { LLM, Message } from "../src"
import { LLMClient } from "../src/route"
import * as OpenAI from "../src/providers/openai"
import { createRequestWitnessObserver } from "../src/cache-request-witness"
const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "not-real" }).responses("gpt-5.6")
const median = (ns: number[]) => ns.toSorted((a,b)=>a-b)[Math.floor(ns.length/2)]!
const output = []
for (const size of [16384,131072]) {
  const request = LLM.request({
    model, system: "Stable developer policy", cache: "none",
    messages: [Message.user("z".repeat(size))],
  })
  const observer = createRequestWitnessObserver(4)
  const note = (body: unknown) => observer.observe({
    owner: "bench/owner", session: "bench/session", model: "gpt-5.6",
    provider: "openai", route: "openai-responses", runtime: "native",
    protocol: "openai-responses", body: body as Record<string, unknown>,
  })
  for (let i=0;i<20;i++) { const p=await Effect.runPromise(LLMClient.prepare(request)); note(p.body) }
  const samples = [[],[]] as [number[],number[]]
  for(let batch=0;batch<9;batch++) {
    for (const mode of batch%2===0 ? [0,1] : [1,0]) {
      const start=performance.now()
      for (let i=0;i<50;i++) {
        const p = await Effect.runPromise(LLMClient.prepare(request))
        if(mode===1) note(p.body)
      }
      samples[mode]!.push((performance.now()-start)*1000/50)
    }
  }
  const baseline=median(samples[0]), withObserver=median(samples[1])
  output.push({
    messageChars:size, iterationsPerMode:450, baselinePrepareMedianUs:+baseline.toFixed(2),
    preparePlusWitnessMedianUs:+withObserver.toFixed(2),
    addedCostMedianUs:+(withObserver-baseline).toFixed(2),
    observedOverheadPercent:+(100*(withObserver-baseline)/baseline).toFixed(1),
  })
}
console.log(JSON.stringify(output,null,2))
