import { describe, expect, test } from "bun:test"
import { denseWorkingIndicatorClass } from "./spinner"

describe("DenseWorkingIndicator", () => {
  test("assigns an animation class to only the selected row indicator", () => {
    const classes = [denseWorkingIndicatorClass(true), denseWorkingIndicatorClass(false), denseWorkingIndicatorClass(false)]
    expect(classes.filter((value) => value.includes("animate-pulse"))).toHaveLength(1)
    expect(classes[1]).not.toContain("animate-pulse")
    expect(classes[2]).not.toContain("animate-pulse")
  })
})
