/*
 * OpenFork's deterministic GIF adapter for SnapEye.
 *
 * SnapEye 0.4 imports the `gifenc` package at module evaluation time. gifenc's
 * default quantizer is derived from MPL-2.0 PnnQuant.js; bundling that default
 * module would therefore pull MPL-covered source into OpenFork's browser
 * runtime even though visual recording only needs a bounded GIF encoder.
 *
 * This module is aliased over the TOP-LEVEL `gifenc` import in shipping browser
 * bundles. It deliberately reuses only gifenc's MIT-licensed stream/LZW
 * primitives and replaces the quantizer/palette mapping with first-party code.
 * See THIRD_PARTY_NOTICES.txt in the Chrome extension/Desktop resources.
 *
 * Palette design is adaptive but temporally stable. OpenFork samples a bounded
 * subset of the complete recording into a 5-bit RGB histogram, median-cuts it
 * once, and reuses that global palette for every frame. That avoids the
 * per-frame palette churn/local-table overhead of SnapEye's default encoder
 * while preserving substantially more UI/gradient fidelity than a fixed cube.
 */

// gifenc 1.0.3 intentionally ships no TypeScript declarations. These are the
// only two private primitives we consume, exact-pinned by browser-visual.
// @ts-expect-error gifenc internal MIT primitive has no declaration file
import lzwEncodeRaw from "gifenc/src/lzwEncode.js"
// @ts-expect-error gifenc internal MIT primitive has no declaration file
import createStream from "gifenc/src/stream.js"

type Palette = ReadonlyArray<readonly [number, number, number]>
type Rgba = Uint8Array | Uint8ClampedArray
type ColorBin = { key: number; r: number; g: number; b: number; count: number }
type ColorBox = {
  bins: ColorBin[]
  total: number
  minR: number
  maxR: number
  minG: number
  maxG: number
  minB: number
  maxB: number
  minKey: number
}

type ByteStream = {
  readonly buffer: ArrayBuffer
  reset(): void
  bytes(): Uint8Array
  bytesView(): Uint8Array
  writeByte(byte: number): void
  writeBytes(data: ArrayLike<number>, offset?: number, byteLength?: number): void
  writeBytesView(data: Uint8Array, offset?: number, byteLength?: number): void
}

const MAX_GIF_BYTES = 64 * 1024 * 1024
const MAX_PALETTE_COLORS = 256
const HISTOGRAM_BITS = 5
const HISTOGRAM_LEVELS = 1 << HISTOGRAM_BITS
const HISTOGRAM_SIZE = HISTOGRAM_LEVELS ** 3
const HISTOGRAM_SHIFT = 8 - HISTOGRAM_BITS
const MAX_PALETTE_SAMPLE_PIXELS = 262_144
const MAX_PALETTE_SAMPLE_FRAMES = 8

/**
 * gifenc-compatible quantize(). SnapEye's static import requires this surface
 * even though OpenFork's record path injects encodeGifFrames() below. Keeping
 * it adaptive also makes direct callers deterministic and quality-preserving.
 */
export function quantize(rgba: Rgba, maxColors = MAX_PALETTE_COLORS): Palette {
  validateRgba(rgba)
  if (!Number.isFinite(maxColors) || maxColors < 2) throw new RangeError("GIF palette requires at least 2 colors")
  return adaptivePaletteFromArrays([rgba], Math.min(MAX_PALETTE_COLORS, Math.floor(maxColors)))
}

/** Map RGBA pixels to a palette with a deterministic 5-bit lookup cache. */
export function applyPalette(
  rgba: Rgba,
  palette: Palette,
): Uint8Array {
  validateRgba(rgba)
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 256) {
    throw new RangeError("GIF palette must contain 2-256 colors")
  }
  return applyPaletteWithMapper(rgba, createPaletteMapper(palette))
}

/**
 * SnapEye dependency hook. One adaptive palette is learned from at most eight
 * evenly distributed frames and at most 262k sampled pixels, then shared by
 * every encoded frame. No captured canvas pixels are retained between passes.
 */
export async function encodeGifFrames(
  frames: HTMLCanvasElement[],
  timestampsMs: number[],
  options: { fps?: number; durationMs?: number; maxColors?: number; repeat?: number } = {},
): Promise<Blob> {
  if (!frames.length) throw new Error("Cannot encode a GIF without frames")
  const maxColors = Math.max(2, Math.min(MAX_PALETTE_COLORS, Math.floor(options.maxColors ?? MAX_PALETTE_COLORS)))
  const palette = adaptivePaletteFromCanvases(frames, maxColors)
  const mapper = createPaletteMapper(palette)
  const encoder = GIFEncoder()
  const fallbackDelay = Math.max(20, Math.round(1000 / (options.fps || 10)))

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const canvas = frames[frameIndex]!
    const context = canvas.getContext("2d")
    if (!context) throw new Error("GIF encoding requires a 2D canvas context")
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    const indexed = applyPaletteWithMapper(rgba, mapper)
    const measuredDelay = frameDelay(timestampsMs, frameIndex, options.durationMs)
    encoder.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      delay: Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay,
      repeat: options.repeat ?? 0,
    })
  }

  encoder.finish()
  const encoded = encoder.bytes()
  const owned = new Uint8Array(encoded.byteLength)
  owned.set(encoded)
  return new Blob([owned.buffer], { type: "image/gif" })
}

function applyPaletteWithMapper(rgba: Rgba, mapper: ReturnType<typeof createPaletteMapper>): Uint8Array {
  const pixels = rgba.byteLength >>> 2
  const indexed = new Uint8Array(pixels)
  for (let pixel = 0, offset = 0; pixel < pixels; pixel++, offset += 4) {
    indexed[pixel] = mapper(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!)
  }
  return indexed
}

export function GIFEncoder(options: { initialCapacity?: number; auto?: boolean } = {}) {
  const initialCapacity = boundedPositiveInt(options.initialCapacity ?? 4096, "initialCapacity")
  const auto = options.auto !== false
  const raw = createStream(initialCapacity) as ByteStream
  const stream = boundedStream(raw)
  const accum = new Uint8Array(256)
  const htab = new Int32Array(5003)
  const codetab = new Int32Array(5003)
  let initialized = false
  let globalPalette: Palette | null = null

  return {
    reset() {
      raw.reset()
      initialized = false
      globalPalette = null
    },
    finish() {
      stream.writeByte(0x3b)
    },
    bytes() {
      return raw.bytes()
    },
    bytesView() {
      return raw.bytesView()
    },
    get buffer() {
      return raw.buffer
    },
    get stream() {
      return stream
    },
    writeHeader() {
      writeAscii(stream, "GIF89a")
    },
    writeFrame(
      index: Uint8Array,
      widthInput: number,
      heightInput: number,
      frame: {
        transparent?: boolean
        transparentIndex?: number
        delay?: number
        palette?: Palette | null
        repeat?: number
        colorDepth?: number
        dispose?: number
        first?: boolean
      } = {},
    ) {
      const width = gifDimension(widthInput, "width")
      const height = gifDimension(heightInput, "height")
      if (!(index instanceof Uint8Array) || index.byteLength !== width * height) {
        throw new RangeError(`GIF frame index length ${index?.byteLength ?? 0} does not match ${width}x${height}`)
      }
      const palette = frame.palette ?? null
      const colorDepth = Math.max(2, Math.min(8, Math.floor(frame.colorDepth ?? 8)))
      let first = false
      if (auto) {
        if (!initialized) {
          first = true
          writeAscii(stream, "GIF89a")
          initialized = true
        }
      } else {
        first = frame.first === true
      }
      if (first) {
        if (!palette) throw new Error("First GIF frame requires a palette")
        globalPalette = palette
        logicalScreenDescriptor(stream, width, height, palette, colorDepth)
        colorTable(stream, palette)
        if ((frame.repeat ?? 0) >= 0) netscapeLoop(stream, frame.repeat ?? 0)
      }

      graphicControlExtension(
        stream,
        Math.floor(frame.dispose ?? -1),
        Math.round(Math.max(0, frame.delay ?? 0) / 10),
        frame.transparent === true,
        Math.floor(frame.transparentIndex ?? 0),
      )
      // SnapEye asks quantize() for every frame. Our canonical quantizer returns
      // the same frozen palette object, so subsequent frames can reuse the GIF
      // global color table instead of paying another 768-byte local table.
      const localPalette = palette && !first && palette !== globalPalette ? palette : null
      imageDescriptor(stream, width, height, localPalette)
      if (localPalette) colorTable(stream, localPalette)
      encodePixels(stream, index, width, height, colorDepth, accum, htab, codetab)
    },
  }
}

export default GIFEncoder

function createPaletteMapper(palette: Palette) {
  const cache = new Int16Array(HISTOGRAM_SIZE)
  cache.fill(-1)
  return (r: number, g: number, b: number): number => {
    const key = histogramKey(r, g, b)
    const cached = cache[key]!
    if (cached >= 0) return cached
    const qr = Math.min(255, (((key >>> 10) & 31) << HISTOGRAM_SHIFT) + (1 << (HISTOGRAM_SHIFT - 1)))
    const qg = Math.min(255, (((key >>> 5) & 31) << HISTOGRAM_SHIFT) + (1 << (HISTOGRAM_SHIFT - 1)))
    const qb = Math.min(255, ((key & 31) << HISTOGRAM_SHIFT) + (1 << (HISTOGRAM_SHIFT - 1)))
    const index = nearestPaletteIndex(qr, qg, qb, palette)
    cache[key] = index
    return index
  }
}

function nearestPaletteIndex(r: number, g: number, b: number, palette: Palette): number {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  for (let index = 0; index < palette.length; index++) {
    const color = palette[index]!
    const next = sq(r - color[0]) + sq(g - color[1]) + sq(b - color[2])
    if (next >= distance) continue
    distance = next
    best = index
  }
  return best
}

function adaptivePaletteFromArrays(arrays: readonly Rgba[], maxColors: number): Palette {
  const totalPixels = arrays.reduce((total, rgba) => total + (rgba.byteLength >>> 2), 0)
  const stride = Math.max(1, Math.ceil(totalPixels / MAX_PALETTE_SAMPLE_PIXELS))
  const histogram = createHistogram()
  let globalPixelOffset = 0
  for (const rgba of arrays) {
    validateRgba(rgba)
    accumulateHistogram(histogram, rgba, stride, globalPixelOffset)
    globalPixelOffset += rgba.byteLength >>> 2
  }
  return paletteFromHistogram(histogram, maxColors)
}

function adaptivePaletteFromCanvases(frames: readonly HTMLCanvasElement[], maxColors: number): Palette {
  const indices = paletteFrameIndices(frames.length)
  const totalPixels = indices.reduce((total, index) => {
    const frame = frames[index]!
    return total + frame.width * frame.height
  }, 0)
  const stride = Math.max(1, Math.ceil(totalPixels / MAX_PALETTE_SAMPLE_PIXELS))
  const histogram = createHistogram()
  let globalPixelOffset = 0
  for (const index of indices) {
    const frame = frames[index]!
    const context = frame.getContext("2d")
    if (!context) throw new Error("GIF palette analysis requires a 2D canvas context")
    const rgba = context.getImageData(0, 0, frame.width, frame.height).data
    accumulateHistogram(histogram, rgba, stride, globalPixelOffset)
    globalPixelOffset += rgba.byteLength >>> 2
  }
  return paletteFromHistogram(histogram, maxColors)
}

function paletteFrameIndices(frameCount: number): number[] {
  if (frameCount <= MAX_PALETTE_SAMPLE_FRAMES) return Array.from({ length: frameCount }, (_, index) => index)
  const indices = new Set<number>([0, frameCount - 1])
  for (let slot = 1; slot < MAX_PALETTE_SAMPLE_FRAMES - 1; slot++) {
    indices.add(Math.round((slot * (frameCount - 1)) / (MAX_PALETTE_SAMPLE_FRAMES - 1)))
  }
  return [...indices].sort((left, right) => left - right)
}

type Histogram = {
  counts: Uint32Array
  sumsR: Uint32Array
  sumsG: Uint32Array
  sumsB: Uint32Array
}

function createHistogram(): Histogram {
  return {
    counts: new Uint32Array(HISTOGRAM_SIZE),
    sumsR: new Uint32Array(HISTOGRAM_SIZE),
    sumsG: new Uint32Array(HISTOGRAM_SIZE),
    sumsB: new Uint32Array(HISTOGRAM_SIZE),
  }
}

function accumulateHistogram(histogram: Histogram, rgba: Rgba, stride: number, globalPixelOffset: number): void {
  const pixels = rgba.byteLength >>> 2
  const first = (stride - (globalPixelOffset % stride)) % stride
  for (let pixel = first; pixel < pixels; pixel += stride) {
    const offset = pixel << 2
    const r = rgba[offset]!
    const g = rgba[offset + 1]!
    const b = rgba[offset + 2]!
    const key = histogramKey(r, g, b)
    histogram.counts[key] = histogram.counts[key]! + 1
    histogram.sumsR[key] = histogram.sumsR[key]! + r
    histogram.sumsG[key] = histogram.sumsG[key]! + g
    histogram.sumsB[key] = histogram.sumsB[key]! + b
  }
}

function paletteFromHistogram(histogram: Histogram, maxColors: number): Palette {
  const bins: ColorBin[] = []
  for (let key = 0; key < HISTOGRAM_SIZE; key++) {
    const count = histogram.counts[key]!
    if (!count) continue
    bins.push({
      key,
      count,
      r: Math.round(histogram.sumsR[key]! / count),
      g: Math.round(histogram.sumsG[key]! / count),
      b: Math.round(histogram.sumsB[key]! / count),
    })
  }
  if (!bins.length) return Object.freeze([[0, 0, 0], [255, 255, 255]] as const)
  if (bins.length <= maxColors) {
    const exact = bins.map((bin) => Object.freeze([bin.r, bin.g, bin.b] as const))
    while (exact.length < 2) exact.push(exact[0]!)
    return Object.freeze(exact)
  }

  const boxes: ColorBox[] = [makeColorBox(bins)]
  while (boxes.length < maxColors) {
    const splitIndex = selectSplitBox(boxes)
    if (splitIndex < 0) break
    const split = splitColorBox(boxes[splitIndex]!)
    if (!split) break
    boxes.splice(splitIndex, 1, split[0], split[1])
  }

  const palette = boxes.map((box) => {
    let r = 0
    let g = 0
    let b = 0
    for (const bin of box.bins) {
      r += bin.r * bin.count
      g += bin.g * bin.count
      b += bin.b * bin.count
    }
    return Object.freeze([
      Math.round(r / box.total),
      Math.round(g / box.total),
      Math.round(b / box.total),
    ] as const)
  })
  palette.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2])
  while (palette.length < 2) palette.push(palette[0]!)
  return Object.freeze(palette)
}

function makeColorBox(bins: ColorBin[]): ColorBox {
  let total = 0
  let minR = 255
  let minG = 255
  let minB = 255
  let maxR = 0
  let maxG = 0
  let maxB = 0
  let minKey = Number.POSITIVE_INFINITY
  for (const bin of bins) {
    total += bin.count
    minR = Math.min(minR, bin.r)
    maxR = Math.max(maxR, bin.r)
    minG = Math.min(minG, bin.g)
    maxG = Math.max(maxG, bin.g)
    minB = Math.min(minB, bin.b)
    maxB = Math.max(maxB, bin.b)
    minKey = Math.min(minKey, bin.key)
  }
  return { bins, total, minR, maxR, minG, maxG, minB, maxB, minKey }
}

function selectSplitBox(boxes: readonly ColorBox[]): number {
  let selected = -1
  let selectedScore = -1
  let selectedKey = Number.POSITIVE_INFINITY
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]!
    if (box.bins.length < 2) continue
    const range = Math.max(box.maxR - box.minR, box.maxG - box.minG, box.maxB - box.minB)
    const score = range * box.total
    if (score > selectedScore || (score === selectedScore && box.minKey < selectedKey)) {
      selected = index
      selectedScore = score
      selectedKey = box.minKey
    }
  }
  return selected
}

function splitColorBox(box: ColorBox): readonly [ColorBox, ColorBox] | null {
  if (box.bins.length < 2) return null
  const rangeR = box.maxR - box.minR
  const rangeG = box.maxG - box.minG
  const rangeB = box.maxB - box.minB
  const channel: "r" | "g" | "b" = rangeR >= rangeG && rangeR >= rangeB ? "r" : rangeG >= rangeB ? "g" : "b"
  const sorted = [...box.bins].sort((left, right) => left[channel] - right[channel] || left.key - right.key)
  const midpoint = box.total / 2
  let accumulated = 0
  let splitAt = 1
  for (let index = 0; index < sorted.length - 1; index++) {
    accumulated += sorted[index]!.count
    splitAt = index + 1
    if (accumulated >= midpoint) break
  }
  splitAt = Math.max(1, Math.min(sorted.length - 1, splitAt))
  return [makeColorBox(sorted.slice(0, splitAt)), makeColorBox(sorted.slice(splitAt))]
}

function histogramKey(r: number, g: number, b: number): number {
  return (r >>> HISTOGRAM_SHIFT) << 10 | (g >>> HISTOGRAM_SHIFT) << 5 | (b >>> HISTOGRAM_SHIFT)
}

function frameDelay(timestampsMs: readonly number[], index: number, durationMs?: number): number {
  const current = timestampsMs[index]
  const next = timestampsMs[index + 1]
  if (Number.isFinite(current) && Number.isFinite(next)) return next! - current!
  if (Number.isFinite(current) && Number.isFinite(durationMs)) return durationMs! - current!
  return Number.NaN
}

function validateRgba(rgba: Uint8Array | Uint8ClampedArray): void {
  if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
    throw new TypeError("GIF quantization requires Uint8Array RGBA data")
  }
  if ((rgba.byteLength & 3) !== 0) throw new RangeError("RGBA byte length must be divisible by four")
}

function boundedStream(raw: ByteStream): ByteStream {
  const ensure = (additional: number) => {
    if (raw.bytesView().byteLength + additional > MAX_GIF_BYTES) {
      throw new RangeError(`GIF exceeded OpenFork's ${MAX_GIF_BYTES}-byte artifact ceiling`)
    }
  }
  return {
    get buffer() { return raw.buffer },
    reset: () => raw.reset(),
    bytes: () => raw.bytes(),
    bytesView: () => raw.bytesView(),
    writeByte(byte) {
      ensure(1)
      raw.writeByte(byte)
    },
    writeBytes(data, offset = 0, byteLength = data.length - offset) {
      ensure(byteLength)
      raw.writeBytes(data, offset, byteLength)
    },
    writeBytesView(data, offset = 0, byteLength = data.byteLength - offset) {
      ensure(byteLength)
      raw.writeBytesView(data, offset, byteLength)
    },
  }
}

function encodePixels(
  stream: ByteStream,
  index: Uint8Array,
  width: number,
  height: number,
  colorDepth: number,
  accum: Uint8Array,
  htab: Int32Array,
  codetab: Int32Array,
): void {
  // gifenc's MIT primitive signature is (width, height, pixels, colorDepth,
  // stream, accum, htab, codetab).
  lzwEncodePrimitive(width, height, index, colorDepth, stream, accum, htab, codetab)
}

const lzwEncodePrimitive = lzwEncodeRaw as unknown as (
  width: number,
  height: number,
  pixels: Uint8Array,
  colorDepth: number,
  stream: ByteStream,
  accum: Uint8Array,
  htab: Int32Array,
  codetab: Int32Array,
) => Uint8Array

function logicalScreenDescriptor(stream: ByteStream, width: number, height: number, palette: Palette, colorDepth: number) {
  writeUInt16(stream, width)
  writeUInt16(stream, height)
  const tableSize = colorTableSize(palette.length) - 1
  stream.writeBytes([(1 << 7) | ((colorDepth - 1) << 4) | tableSize, 0, 0])
}

function netscapeLoop(stream: ByteStream, repeat: number) {
  stream.writeBytes([0x21, 0xff, 11])
  writeAscii(stream, "NETSCAPE2.0")
  stream.writeBytes([3, 1])
  writeUInt16(stream, repeat)
  stream.writeByte(0)
}

function graphicControlExtension(
  stream: ByteStream,
  dispose: number,
  delayCentiseconds: number,
  transparent: boolean,
  transparentIndex: number,
) {
  if (transparentIndex < 0) {
    transparentIndex = 0
    transparent = false
  }
  let disposal = transparent ? 2 : 0
  if (dispose >= 0) disposal = dispose & 7
  stream.writeBytes([0x21, 0xf9, 4, (disposal << 2) | (transparent ? 1 : 0)])
  writeUInt16(stream, Math.min(0xffff, Math.max(0, delayCentiseconds)))
  stream.writeBytes([transparentIndex & 0xff, 0])
}

function imageDescriptor(stream: ByteStream, width: number, height: number, palette: Palette | null) {
  stream.writeByte(0x2c)
  writeUInt16(stream, 0)
  writeUInt16(stream, 0)
  writeUInt16(stream, width)
  writeUInt16(stream, height)
  stream.writeByte(palette ? 0x80 | (colorTableSize(palette.length) - 1) : 0)
}

function colorTable(stream: ByteStream, palette: Palette) {
  if (palette.length < 2 || palette.length > 256) throw new RangeError("GIF palette must contain 2-256 colors")
  const length = 1 << colorTableSize(palette.length)
  for (let index = 0; index < length; index++) {
    const color = palette[index] ?? ([0, 0, 0] as const)
    stream.writeBytes(color)
  }
}

function writeUInt16(stream: ByteStream, value: number) {
  stream.writeBytes([value & 0xff, (value >>> 8) & 0xff])
}

function writeAscii(stream: ByteStream, text: string) {
  for (let index = 0; index < text.length; index++) stream.writeByte(text.charCodeAt(index))
}

function colorTableSize(length: number): number {
  return Math.max(Math.ceil(Math.log2(length)), 1)
}

function gifDimension(value: number, label: string): number {
  const rounded = Math.floor(value)
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 0xffff) {
    throw new RangeError(`GIF ${label} must be 1-65535`)
  }
  return rounded
}

function boundedPositiveInt(value: number, label: string): number {
  const rounded = Math.floor(value)
  if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > MAX_GIF_BYTES) {
    throw new RangeError(`${label} must be a positive safe integer <= ${MAX_GIF_BYTES}`)
  }
  return rounded
}

const sq = (value: number): number => value * value
