import { describe, expect, test } from "bun:test"
import { GIFEncoder, applyPalette, quantize } from "./gifenc-safe"

describe("OpenFork safe gifenc replacement", () => {
  test("adaptive palettes are deterministic and preserve sparse UI colors exactly", () => {
    const rgba = new Uint8ClampedArray([
      15, 23, 42, 255,
      30, 41, 59, 255,
      59, 130, 246, 255,
      34, 197, 94, 255,
      239, 68, 68, 255,
    ])
    const first = quantize(rgba, 256)
    const second = quantize(rgba, 256)
    expect(first).toEqual(second)
    expect(first).toHaveLength(5)
    const mapped = applyPalette(rgba, first)
    for (let pixel = 0; pixel < mapped.length; pixel++) {
      const color = first[mapped[pixel]!]!
      const offset = pixel * 4
      expect([...color]).toEqual([rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!])
    }
  })

  test("adaptive quantization keeps a smooth gradient within a bounded error", () => {
    const width = 256
    const rgba = new Uint8ClampedArray(width * 4)
    for (let x = 0; x < width; x++) {
      const offset = x * 4
      rgba[offset] = x
      rgba[offset + 1] = 255 - x
      rgba[offset + 2] = Math.round(x / 2)
      rgba[offset + 3] = 255
    }
    const palette = quantize(rgba, 256)
    const mapped = applyPalette(rgba, palette)
    let squaredError = 0
    for (let pixel = 0; pixel < mapped.length; pixel++) {
      const color = palette[mapped[pixel]!]!
      const offset = pixel * 4
      for (let channel = 0; channel < 3; channel++) {
        const delta = rgba[offset + channel]! - color[channel]!
        squaredError += delta * delta
      }
    }
    const rmse = Math.sqrt(squaredError / (mapped.length * 3))
    expect(rmse).toBeLessThan(4)
  })

  test("writes a valid deterministic GIF89a stream", () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ])
    const palette = quantize(rgba, 256)
    const index = applyPalette(rgba, palette)
    const encode = () => {
      const encoder = GIFEncoder()
      encoder.writeFrame(index, 2, 2, { palette, delay: 100 })
      encoder.finish()
      return encoder.bytes()
    }
    const first = encode()
    const second = encode()
    expect(new TextDecoder().decode(first.slice(0, 6))).toBe("GIF89a")
    expect(first.at(-1)).toBe(0x3b)
    expect(first).toEqual(second)
  })
})
