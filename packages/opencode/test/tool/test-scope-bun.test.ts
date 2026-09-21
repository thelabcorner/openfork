import { describe, expect, test } from "bun:test"
import { TestScope } from "@/tool/test-scope"

describe("TestScope Bun reporter parsing", () => {
  test("parses ANSI-colored Bun 1.3 singular summaries", () => {
    const raw = [
      "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.3.14 (0d9b296a)\u001b[0m",
      "",
      "probe.test.ts:",
      "\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m oxp test probe\u001b[0m \u001b[0m\u001b[2m[0.04ms\u001b[0m\u001b[2m]\u001b[0m",
      "",
      "\u001b[0m\u001b[32m 1 pass\u001b[0m",
      "\u001b[0m\u001b[2m 0 fail\u001b[0m",
      " 1 expect() calls",
      "Ran 1 test across 1 file. \u001b[0m\u001b[2m[\u001b[1m33.00ms\u001b[0m\u001b[2m]\u001b[0m",
    ].join("\n")

    const summary = TestScope.parseReporter(raw, "bun", 0)

    expect(summary).toMatchObject({
      harness: "bun",
      passed: 1,
      failed: 0,
      skipped: 0,
      total: 1,
      durationMs: 33,
      parsed: true,
      exitCode: 0,
    })
    expect(summary.tests).toEqual([
      expect.objectContaining({
        fullName: "oxp test probe",
        status: "passed",
        file: "probe.test.ts",
      }),
    ])
  })

  test("parses current ANSI failure markers without losing the assertion context", () => {
    const raw = [
      "probe.test.ts:",
      "\u001b[31merror: expected true to be false\u001b[0m",
      "\u001b[31m✗\u001b[0m broken probe [1.25ms]",
      "",
      "\u001b[31m 0 pass\u001b[0m",
      "\u001b[31m 1 fail\u001b[0m",
      "Ran 1 test across 1 file. [4.00ms]",
    ].join("\n")

    const summary = TestScope.parseReporter(raw, "bun", 1)

    expect(summary).toMatchObject({
      passed: 0,
      failed: 1,
      total: 1,
      durationMs: 4,
      parsed: true,
      exitCode: 1,
    })
    expect(summary.failures[0]).toMatchObject({
      fullName: "broken probe",
      status: "failed",
      assertion: "expected true to be false",
    })
  })

  test("retains support for the older parenthesized Bun markers", () => {
    const summary = TestScope.parseReporter(
      [
        "legacy.test.ts:",
        "(pass) legacy probe [0.10ms]",
        " 1 pass",
        " 0 fail",
        "Ran 1 test across 1 file. [2.00ms]",
      ].join("\n"),
      "bun",
      0,
    )

    expect(summary).toMatchObject({
      passed: 1,
      failed: 0,
      parsed: true,
    })
  })
})
