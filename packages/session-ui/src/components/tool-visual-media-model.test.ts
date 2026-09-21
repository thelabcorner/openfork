import { describe, expect, test } from "bun:test"
import { visualToolPresentation } from "./tool-visual-media-model"

describe("visualToolPresentation", () => {
  test("projects browser screenshots from embedded image metadata", () => {
    const result = visualToolPresentation(
      "browser",
      { action: "call", operation: "screenshot", args: {} },
      { operation: "screenshot", op: "screenshot", mime: "image/png", data: "AAAA", width: 1440, height: 900 },
    )
    expect(result).toMatchObject({
      kind: "screenshot",
      origin: "browser",
      width: 1440,
      height: 900,
      initialSource: "screenshot",
      sources: [{ kind: "screenshot", inline: { mime: "image/png", data: "AAAA" } }],
    })
  })

  test("projects a SnapEye diff into lazy baseline/current/diff requests", () => {
    const result = visualToolPresentation(
      "browser",
      { action: "call", operation: "visual_diff", args: { name: "settings" } },
      {
        operation: "visual_diff",
        op: "visual_diff",
        runId: "run_1",
        status: "ok",
        name: "settings",
        image: { pixelWidth: 1200, pixelHeight: 800 },
        diff: { changed: true, changedRatio: 0.0125, regionCount: 3, regionsTruncated: false },
        artifacts: {
          baseline: "../../baselines/settings.png",
          current: "current.png",
          diff: "diff.png",
        },
      },
    )
    expect(result?.kind).toBe("diff")
    expect(result?.initialSource).toBe("run:run_1:diff")
    expect(result?.diff).toEqual({
      changed: true,
      changedRatio: 0.0125,
      regionCount: 3,
      regionsTruncated: false,
    })
    expect(result?.sources.map((source) => source.kind)).toEqual(["baseline", "current", "diff"])
    expect(result?.sources.map((source) => source.artifact)).toEqual([
      { source: "baseline", name: "settings" },
      { source: "run", runId: "run_1", artifact: "current" },
      { source: "run", runId: "run_1", artifact: "diff" },
    ])
  })

  test("projects capture baseline without copying artifact bytes into message metadata", () => {
    const result = visualToolPresentation(
      "browser_visual_capture",
      { name: "editor" },
      {
        op: "visual_capture",
        runId: "run_2",
        status: "ok",
        name: "editor",
        artifacts: { baseline: "../../baselines/editor.png" },
      },
    )
    expect(result?.sources).toEqual([
      {
        key: "baseline:editor:image",
        kind: "baseline",
        artifact: { source: "baseline", name: "editor" },
      },
    ])
  })

  test("projects recording GIF and filmstrip but does not inline video", () => {
    const result = visualToolPresentation(
      "browser",
      { action: "call", operation: "visual_record", args: { name: "motion" } },
      {
        operation: "visual_record",
        op: "visual_record",
        runId: "run_3",
        status: "ok",
        artifacts: { gif: "recording.gif", frames: "frames.png", video: "recording.webm" },
      },
    )
    expect(result?.sources.map((source) => source.kind)).toEqual(["gif", "frames"])
  })

  test("does not present failed SnapEye runs as image cards", () => {
    expect(
      visualToolPresentation(
        "browser",
        { action: "call", operation: "visual_diff", args: { name: "missing" } },
        { operation: "visual_diff", op: "visual_diff", runId: "run_4", status: "error" },
      ),
    ).toBeUndefined()
  })
})
