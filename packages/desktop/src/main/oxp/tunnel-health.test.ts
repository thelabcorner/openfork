import { describe, expect, test } from "bun:test"
import { boundedResponseText, parsePollHealth, readMetric } from "./tunnel-health"

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

  test("extracts tunnel health and process uptime in one metrics pass", () => {
    const metrics = [
      "# HELP commands_poll_errors_total ignored documentation",
      'commands_poll_last_successful_timestamp_seconds{channel="main"} 1700000000',
      "commands_poll_cycles_total 12",
      'commands_poll_errors_total{channel="main"} 2',
      "process_start_time_seconds 1699999900",
      "commands_poll_last_successful_timestamp_seconds_extra 9999999999",
    ].join("\n")
    expect(parsePollHealth(metrics, 1_700_000_120_000)).toEqual({
      lastSuccessMs: 1_700_000_000_000,
      polls: 12,
      errors: 2,
      uptimeSeconds: 220,
    })
    expect(parsePollHealth("# no poll metric\nprocess_start_time_seconds 1")).toBeNull()
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
