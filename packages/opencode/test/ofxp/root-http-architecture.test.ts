import { describe, expect, test } from "bun:test"

describe("OFXP root HTTP ownership", () => {
  test("delegates operator root approval to the canonical root owner", async () => {
    const source = await Bun.file(
      new URL("../../src/server/routes/instance/httpapi/handlers/ofxp.ts", import.meta.url),
    ).text()
    const rootAdd = source.slice(source.indexOf('.handle("rootAdd"'), source.indexOf('.handle("rootRemove"'))

    expect(source).toContain('import { OfxpRoot } from "@/ofxp/root"')
    expect(source).toContain("const roots = yield* OfxpRoot.Service")
    expect(rootAdd).toContain("roots")
    expect(rootAdd).toContain(".approve(")
    expect(rootAdd).toContain("payload.expectedRevision")
    expect(rootAdd).not.toContain("peers.approveRoot")
  })
})
