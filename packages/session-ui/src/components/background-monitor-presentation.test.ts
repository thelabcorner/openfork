import { describe, expect, test } from "bun:test"
import { backgroundShape, parseMonitorBlock } from "./background-monitor-presentation"

/** The shape `BackgroundTool` records for `action: "monitor"`, verbatim. */
const RECORDED_MONITOR = [
  '<monitor job="job_01KABC" state="monitoring">',
  "  <summary>Monitoring dev server readiness</summary>",
  "  <command>bun run dev --port &lt;free&gt;</command>",
  "  Each meaningful stdout line may wake this session in a future turn.",
  "  Do not poll this job. Use background status/read/send/wait/kill with the returned id when management is needed.",
  "  Full output: /data/opencode/job-output/job_01KABC.log",
  "  Persistent: runs until killed.",
  "</monitor>",
].join("\n")

const RECORDED_JOB_STATUS = [
  '<job id="job_01KABC" status="completed" kind="shell">',
  "<command>bun run dev</command>",
  "Kind: shell",
  "Status: completed (exit 0)",
  "Started: 2026-10-04T09:00:00.000Z",
  "Log: /data/opencode/job-output/job_01KABC.log",
  "</job>",
].join("\n")

describe("backgroundShape", () => {
  // Regression: `background({ action: "monitor" })` records a <monitor> block, and
  // no tool is ever named "monitor" - the built-in renderer that understands this
  // block was registered under that nonexistent tool name, so every real monitor
  // part fell through to the markdown fallback instead.
  test("routes a recorded monitor to the monitor shape, not the markdown fallback", () => {
    expect(backgroundShape({ action: "monitor", output: RECORDED_MONITOR })).toBe("monitor")
    expect(backgroundShape({ action: "monitor", output: RECORDED_MONITOR })).not.toBe("text")
  })

  test("a monitor whose output lost its block degrades to the text fallback", () => {
    expect(backgroundShape({ action: "monitor", output: "No background jobs." })).toBe("text")
  })

  test("a monitor block is recognised even without recorded attributes", () => {
    expect(backgroundShape({ action: "monitor", output: "<monitor></monitor>" })).toBe("monitor")
  })

  test("status and wait still route by their recorded job block", () => {
    expect(backgroundShape({ action: "status", output: RECORDED_JOB_STATUS })).toBe("job")
    expect(backgroundShape({ action: "wait", output: RECORDED_JOB_STATUS })).toBe("job")
  })

  test("list and read keep their action-driven shapes", () => {
    expect(backgroundShape({ action: "list", output: "Job  Status" })).toBe("list")
    expect(backgroundShape({ action: "read", output: "raw log text" })).toBe("read")
  })

  test("send and kill stay one-line text", () => {
    expect(backgroundShape({ action: "send", output: "Sent input to job job_01KABC." })).toBe("text")
    expect(backgroundShape({ action: "kill", output: "Killed job job_01KABC. Status: cancelled." })).toBe("text")
  })

  test("a job block outranks the read action, matching the rendered switch", () => {
    expect(backgroundShape({ action: "read", output: RECORDED_JOB_STATUS })).toBe("job")
  })

  test("only the recorded part decides the shape", () => {
    // No live process fields are consulted: the shape is a function of the recorded
    // output alone, and a part with no recorded text falls back.
    expect(backgroundShape({ output: "" })).toBe("text")
    expect(backgroundShape({ action: 7, output: "" })).toBe("text")
  })
})

describe("parseMonitorBlock", () => {
  test("reuses the recorded job id, state, command and log path", () => {
    expect(parseMonitorBlock(RECORDED_MONITOR)).toEqual({
      jobId: "job_01KABC",
      state: "monitoring",
      description: "dev server readiness",
      command: "bun run dev --port <free>",
      logPath: "/data/opencode/job-output/job_01KABC.log",
    })
  })

  test("reads the watched condition out of the recorded summary", () => {
    expect(parseMonitorBlock(RECORDED_MONITOR)?.description).toBe("dev server readiness")
  })

  test("an explicit description element wins over the summary", () => {
    const output = [
      '<monitor job="bg1" state="monitoring">',
      "  <description>gh CI for the PR</description>",
      "  <summary>Monitoring dev server readiness</summary>",
      "</monitor>",
    ].join("\n")
    expect(parseMonitorBlock(output)?.description).toBe("gh CI for the PR")
  })

  test("omits fields the part never recorded instead of inventing them", () => {
    expect(parseMonitorBlock("<monitor></monitor>")).toEqual({
      jobId: undefined,
      state: undefined,
      description: undefined,
      command: undefined,
      logPath: undefined,
    })
  })

  test("ignores agent-facing hint prose when reading the log path", () => {
    const output = [
      '<monitor job="bg1">',
      "  <command>watch</command>",
      "  Full output:   /tmp/a b/job.log  ",
      "</monitor>",
    ].join("\n")
    expect(parseMonitorBlock(output)?.logPath).toBe("/tmp/a b/job.log")
  })

  test("returns undefined when no monitor block was recorded", () => {
    expect(parseMonitorBlock(RECORDED_JOB_STATUS)).toBeUndefined()
    expect(parseMonitorBlock("")).toBeUndefined()
  })

  test("historical parts render from recorded evidence alone", () => {
    // A bounded monitor has long since exited and its live process state is gone;
    // the recorded part still resolves the same ids and path, with no re-read.
    const historical = RECORDED_MONITOR.replace(
      "Persistent: runs until killed.",
      "Bounded monitor: exits at timeout unless it finishes first.",
    )
    expect(parseMonitorBlock(historical)).toEqual(parseMonitorBlock(RECORDED_MONITOR))
  })
})