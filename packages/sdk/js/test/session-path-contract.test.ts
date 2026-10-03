import { expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"

test("generated V1 session methods substitute identities before transport", async () => {
  const paths: string[] = []
  const transport = (async (input: RequestInfo | URL) => {
    paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
    return new Response("null", { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetch: transport })
  await client.global.sessionGet({ sessionID: "ses_path_contract" })
  await client.session.get({ sessionID: "ses_path_contract" })
  await client.session.messages({ sessionID: "ses_path_contract" })
  expect(paths).toEqual([
    "/global/session/ses_path_contract",
    "/session/ses_path_contract",
    "/session/ses_path_contract/message",
  ])
})
