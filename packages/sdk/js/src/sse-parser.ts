export interface SseFrame {
  readonly data?: string
  readonly hasData: boolean
  readonly event?: string
  readonly id?: string
  readonly retry?: number
}

export class SseParseError extends Error {
  override readonly name = "SseParseError"
}

interface SseParser {
  push(text: string, done?: boolean): ReadonlyArray<SseFrame>
}

// UTF-8 bytes of field contents, excluding line delimiters. Field names and
// comments count too, so even a frame containing no data remains bounded.
const MAX_EVENT_SIZE = 8 * 1024 * 1024

/**
 * Incrementally parses the wire format without repeatedly normalizing or
 * splitting the complete unread response. The caller owns the stream reader,
 * so returned frames can be yielded immediately and the next read will not be
 * pulled until the consumer asks for another event.
 */
export function createSseParser(): SseParser {
  // Network chunks frequently split a long SSE line into many tiny pieces.
  // Joining on every chunk makes a growing string quadratic; retain pieces and
  // materialize only when the terminating newline arrives.
  let lineParts: string[] = []
  let lineSize = 0
  let dataParts: string[] | undefined
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined
  let skipLineFeed = false
  let size = 0
  let blockStarted = false
  let highSurrogate = false
  const lineEnding = /[\r\n]/g

  const append = (value: string) => {
    if (value === "") return
    lineParts.push(value)
    lineSize += value.length
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      // A surrogate pair costs four bytes, including when split across pushes.
      size += code < 0x80 ? 1 : code < 0x800 ? 2 : highSurrogate && code >= 0xdc00 && code <= 0xdfff ? 1 : 3
      highSurrogate = code >= 0xd800 && code <= 0xdbff
    }
    if (size > MAX_EVENT_SIZE) throw new SseParseError("SSE event exceeds the 8 MiB limit")
  }

  const finishLine = (frames: SseFrame[]) => {
    highSurrogate = false
    if (lineSize === 0) {
      if (blockStarted) {
        const data = dataParts === undefined ? undefined : dataParts.join("\n")
        frames.push({ data, hasData: dataParts !== undefined, event, id, retry })
        dataParts = undefined
        event = undefined
        id = undefined
        retry = undefined
        size = 0
        blockStarted = false
      }
      return
    }

    const line = lineParts.join("")
    lineParts = []
    lineSize = 0
    blockStarted = true
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") {
      ;(dataParts ??= []).push(value)
    } else if (field === "event") {
      event = value
    } else if (field === "id") {
      if (!value.includes("\0")) id = value
    } else if (field === "retry") {
      const parsed = Number(value)
      if (/^\d+$/.test(value) && Number.isSafeInteger(parsed)) retry = parsed
    }
  }

  return {
    push(text, done = false) {
      const frames: SseFrame[] = []
      let start = 0
      while (start < text.length) {
        if (skipLineFeed) {
          skipLineFeed = false
          if (text.charCodeAt(start) === 10) {
            start++
            continue
          }
        }

        // One forward scan; two independent indexOf calls rescanned the
        // entire suffix for every LF in a chunk containing no CR (quadratic).
        lineEnding.lastIndex = start
        const end = lineEnding.exec(text)?.index ?? -1

        if (end === -1) {
          append(text.slice(start))
          break
        }

        append(text.slice(start, end))
        finishLine(frames)
        skipLineFeed = text.charCodeAt(end) === 13
        start = end + 1
      }

      if (done) {
        if (lineSize !== 0) finishLine(frames)
        if (blockStarted) {
          const data = dataParts === undefined ? undefined : dataParts.join("\n")
          frames.push({ data, hasData: dataParts !== undefined, event, id, retry })
          lineParts = []
          lineSize = 0
          dataParts = undefined
          event = undefined
          id = undefined
          retry = undefined
          skipLineFeed = false
          size = 0
          blockStarted = false
        }
      }
      return frames
    },
  }
}
