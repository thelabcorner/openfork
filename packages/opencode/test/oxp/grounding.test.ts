import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { OxpGrounding } from "@/oxp/grounding"
import { OxpSchema } from "@/oxp/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(OxpGrounding.node))

describe("OxpGrounding", () => {
  it.live("namespaces stale-read evidence by connector and root rather than pretending either is a Session", Effect.gen(function* () {
    const grounding = yield* OxpGrounding.Service
    const connectorA = OxpSchema.ConnectorID.make("11111111-1111-4111-8111-111111111111")
    const connectorB = OxpSchema.ConnectorID.make("22222222-2222-4222-8222-222222222222")
    const rootA = OxpSchema.RootID.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    const rootB = OxpSchema.RootID.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")

    grounding.scoped(connectorA).note(rootA, "C:/repo/a.ts", "1:10")

    expect(grounding.scoped(connectorA).get(rootA, "C:/repo/a.ts")).toBe("1:10")
    expect(grounding.scoped(connectorA).get(rootB, "C:/repo/a.ts")).toBeUndefined()
    expect(grounding.scoped(connectorB).get(rootA, "C:/repo/a.ts")).toBeUndefined()
  }))
})
