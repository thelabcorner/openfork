import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH } from "./desktop-native"

describe("desktop sidecar liveness copy", () => {
  test("ships every renderer-consumed liveness string", () => {
    expect(DESKTOP_NATIVE_ENGLISH["desktop.sidecar.unresponsive.title"]).toBeTruthy()
    expect(DESKTOP_NATIVE_ENGLISH["desktop.sidecar.unresponsive.description"]).toBeTruthy()
    expect(DESKTOP_NATIVE_ENGLISH["desktop.sidecar.recovered.title"]).toBeTruthy()
    expect(DESKTOP_NATIVE_ENGLISH["desktop.sidecar.recovered.description"]).toBeTruthy()
  })
})
