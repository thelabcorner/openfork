import { afterEach, expect, test } from "bun:test"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("production server graph provides OFXP peer state to the root handler", async () => {
  const response = await HttpApiApp.webHandler().handler(
    new Request("http://localhost/ofxp/state"),
    HttpApiApp.context,
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: { active: false, discovery: "disabled" },
    candidates: [],
    pairings: [],
    peers: [],
    activity: [],
  })
})
