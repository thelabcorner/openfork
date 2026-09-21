export * as ToolOutputRetention from "./tool-output-retention"

import { createWriteStream } from "node:fs"
import { finished } from "node:stream/promises"
import { brotliCompress, createBrotliCompress, constants } from "node:zlib"
import { promisify } from "node:util"

const compressAsync = promisify(brotliCompress)

const options = {
  params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_QUALITY]: 4,
  },
} as const

export function compressText(text: string): Promise<Buffer> {
  return compressAsync(Buffer.from(text, "utf-8"), options) as Promise<Buffer>
}

export interface Writer {
  readonly path: string
  write(text: string): Promise<void>
  close(): Promise<void>
}

/**
 * One-pass Brotli writer for streaming tool output.
 *
 * Each write resolves only after zlib has accepted/processed that chunk, so a
 * fast child process cannot grow an unbounded userland side buffer. close()
 * waits for both compressor and file sink completion before the path is treated
 * as authoritative.
 */
export function createWriter(file: string): Writer {
  const compressor = createBrotliCompress(options)
  const sink = createWriteStream(file, { flags: "wx" })
  compressor.pipe(sink)
  let closed = false
  let closing: Promise<void> | undefined
  let failure: unknown
  let tearingDown = false

  const fail = (error: unknown, source: "compressor" | "sink") => {
    failure ??= error
    if (tearingDown) return
    tearingDown = true
    // A destination failure unpipes the transform. If the transform is left
    // alive, finished(compressor) can wait forever for a readable side that no
    // longer has a consumer. Tear down the peer so both stream owners settle.
    if (source !== "compressor" && !compressor.destroyed) compressor.destroy()
    if (source !== "sink" && !sink.destroyed) sink.destroy()
  }
  compressor.on("error", (error) => fail(error, "compressor"))
  sink.on("error", (error) => fail(error, "sink"))

  // Observe both streams immediately. Waiting until close() to call finished()
  // leaves an asynchronous createWriteStream/open/write failure without an
  // error observer, which can surface as an unhandled stream error and crash
  // the host process. Record the first failure now and rethrow it through the
  // explicit writer contract instead.
  const observe = async (promise: Promise<void>) => {
    try {
      await promise
    } catch (error) {
      failure ??= error
    }
  }
  const compressorDone = observe(finished(compressor))
  const sinkDone = observe(finished(sink))

  return {
    path: file,
    write(text: string) {
      if (closed) return Promise.reject(new Error("tool output writer is closed"))
      if (failure) return Promise.reject(failure)
      if (!text) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        compressor.write(text, "utf-8", (error) => {
          if (error) {
            failure ??= error
            reject(error)
          } else if (failure) reject(failure)
          else resolve()
        })
      })
    },
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        if (!compressor.destroyed) compressor.end()
        await Promise.all([compressorDone, sinkDone])
        if (failure) throw failure
      })()
      return closing
    },
  }
}
