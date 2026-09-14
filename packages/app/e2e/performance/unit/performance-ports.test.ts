import { expect, test } from "bun:test"
import { performanceBackendUrl, performancePorts } from "../performance-ports"

test("keeps the frontend and mocked backend on distinct default ports", () => {
  expect(performancePorts({})).toEqual({ appPort: 3000, serverPort: 4096 })
})

test("preserves an explicit mocked backend port instead of deriving it from the frontend port", () => {
  expect(performancePorts({ PLAYWRIGHT_PORT: "3107", PLAYWRIGHT_SERVER_PORT: "4196" })).toEqual({
    appPort: 3107,
    serverPort: 4196,
  })
})

test("fails closed when frontend and mocked backend ports alias", () => {
  expect(() => performancePorts({ PLAYWRIGHT_PORT: "4096", PLAYWRIGHT_SERVER_PORT: "4096" })).toThrow(
    "must differ from mocked OpenCode server port",
  )
})

test("production performance fixtures resolve the mocked backend independently of the frontend origin", () => {
  expect(performanceBackendUrl({ PLAYWRIGHT_PORT: "3021", PLAYWRIGHT_SERVER_PORT: "4096" })).toBe(
    "http://127.0.0.1:4096",
  )
  expect(
    performanceBackendUrl({
      PLAYWRIGHT_PORT: "3021",
      PLAYWRIGHT_SERVER_PORT: "4196",
      PLAYWRIGHT_SERVER_HOST: "localhost",
    }),
  ).toBe("http://localhost:4196")
})
