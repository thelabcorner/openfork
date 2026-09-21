import { describe, expect, test } from "bun:test"
import { boundedResponseText, readMetric } from "./tunnel-health"

describe("OXP tunnel health metrics", () => {
  test("aggregates Prometheus samples without accepting prefix collisions", () => {
    const metrics = [
      "commands_poll_errors_total 2",
      'commands_poll_errors_total{channel="main"} 3',
      "commands_poll_errors_total_extra 100",
      "# commands_poll_errors_total 500",
    ].join("\n")
    expect(readMetric(metrics, "commands_poll_errors_total")).toBe(5)
  })

  test("bounds local health response bodies even when content-length is absent", async () => {
    const response = new Response("x".repeat(33), { status: 200 })
    response.headers.delete("content-length")
    expect(await boundedResponseText(response, 32)).toBeNull()
  })

  test("rejects declared oversized health bodies before consuming them", async () => {
    const response = new Response("small", { headers: { "content-length": "9999" } })
    expect(await boundedResponseText(response, 32)).toBeNull()
  })
})
