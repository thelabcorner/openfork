import { expect, test } from "bun:test"
import { performanceBuildEnv } from "../performance-environment"

test("performance builds ignore an ambient development NODE_ENV", () => {
  expect(performanceBuildEnv({ NODE_ENV: "development", OPENCODE_CHANNEL: "dev" })).toEqual({
    NODE_ENV: "production",
    OPENCODE_CHANNEL: "prod",
  })
})

test("an explicit benchmark channel does not re-enable development mode", () => {
  expect(performanceBuildEnv({ NODE_ENV: "development", OPENCODE_PERFORMANCE_CHANNEL: "beta" })).toEqual({
    NODE_ENV: "production",
    OPENCODE_CHANNEL: "beta",
  })
})
