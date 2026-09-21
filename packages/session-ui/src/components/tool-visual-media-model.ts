export type VisualArtifactRequest =
  | { source: "baseline"; name: string; artifact?: "image" | "metadata"; timeoutMs?: number }
  | {
      source: "run"
      runId: string
      artifact: "current" | "svg" | "diff" | "frames" | "gif" | "video" | "result"
      timeoutMs?: number
    }

export type VisualArtifactPreview = {
  descriptor: {
    kind: string
    path: string
    mime: string
    byteLength: number
  }
  bytes: Uint8Array
  sha256: string
}

export type VisualArtifactPreviewResolver = (
  input: VisualArtifactRequest,
) => Promise<VisualArtifactPreview | null>

export type VisualMediaSourceKind = "screenshot" | "baseline" | "current" | "diff" | "frames" | "gif"

export type VisualMediaSource = {
  key: string
  kind: VisualMediaSourceKind
  inline?: {
    mime: string
    data: string
  }
  artifact?: VisualArtifactRequest
}

export type VisualDiffSummary = {
  changed: boolean
  changedRatio?: number
  regionCount?: number
  regionsTruncated?: boolean
}

export type VisualToolPresentation = {
  kind: "screenshot" | "capture" | "diff" | "record"
  origin: "browser" | "snapeye"
  name?: string
  runId?: string
  width?: number
  height?: number
  captureMs?: number
  diff?: VisualDiffSummary
  sources: VisualMediaSource[]
  initialSource: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function browserInput(input: Record<string, unknown>) {
  if (input.action !== "call") return input
  return record(input.args) ?? input
}

function operation(tool: string, metadata: Record<string, unknown>) {
  const explicit = text(metadata.op) ?? text(metadata.operation)
  if (explicit === "screenshot" || explicit === "visual_capture" || explicit === "visual_diff" || explicit === "visual_record") {
    return explicit
  }
  if (tool === "browser_screenshot") return "screenshot"
  if (tool === "browser_visual_capture") return "visual_capture"
  if (tool === "browser_visual_diff") return "visual_diff"
  if (tool === "browser_visual_record") return "visual_record"
}

function imageDimensions(metadata: Record<string, unknown>) {
  const image = record(metadata.image)
  const width = number(metadata.width) ?? number(image?.pixelWidth) ?? number(image?.cssWidth)
  const height = number(metadata.height) ?? number(image?.pixelHeight) ?? number(image?.cssHeight)
  return { width, height }
}

function artifactSource(
  kind: Exclude<VisualMediaSourceKind, "screenshot">,
  request: VisualArtifactRequest,
): VisualMediaSource {
  const id =
    request.source === "baseline"
      ? `baseline:${request.name}:${request.artifact ?? "image"}`
      : `run:${request.runId}:${request.artifact}`
  return { key: id, kind, artifact: request }
}

export function visualToolPresentation(
  tool: string,
  rawInput: Record<string, unknown>,
  metadata: Record<string, unknown>,
): VisualToolPresentation | undefined {
  const op = operation(tool, metadata)
  if (!op) return

  const input = browserInput(rawInput)
  const dimensions = imageDimensions(metadata)

  if (op === "screenshot") {
    const mime = text(metadata.mime)
    const data = text(metadata.data)
    if (!mime?.startsWith("image/") || !data) return
    const source: VisualMediaSource = {
      key: "screenshot",
      kind: "screenshot",
      inline: { mime, data },
    }
    return {
      kind: "screenshot",
      origin: "browser",
      ...dimensions,
      sources: [source],
      initialSource: source.key,
    }
  }

  if (metadata.status === "error") return
  const runId = text(metadata.runId)
  const name = text(metadata.name) ?? text(input.name)
  const artifacts = record(metadata.artifacts) ?? {}
  const sources: VisualMediaSource[] = []

  if (op === "visual_capture") {
    if (name && text(artifacts.baseline)) {
      sources.push(artifactSource("baseline", { source: "baseline", name }))
    } else if (runId && text(artifacts.current)) {
      sources.push(artifactSource("current", { source: "run", runId, artifact: "current" }))
    }
    if (!sources.length) return
    return {
      kind: "capture",
      origin: "snapeye",
      name,
      runId,
      ...dimensions,
      captureMs: number(record(metadata.timing)?.captureMs),
      sources,
      initialSource: sources[0]!.key,
    }
  }

  if (!runId) return

  if (op === "visual_diff") {
    if (name && text(artifacts.baseline)) {
      sources.push(artifactSource("baseline", { source: "baseline", name }))
    }
    if (text(artifacts.current)) {
      sources.push(artifactSource("current", { source: "run", runId, artifact: "current" }))
    }
    if (text(artifacts.diff)) {
      sources.push(artifactSource("diff", { source: "run", runId, artifact: "diff" }))
    }
    if (!sources.length) return
    const diff = record(metadata.diff)
    const summary =
      typeof diff?.changed === "boolean"
        ? {
            changed: diff.changed,
            changedRatio: number(diff.changedRatio),
            regionCount: number(diff.regionCount),
            regionsTruncated: typeof diff.regionsTruncated === "boolean" ? diff.regionsTruncated : undefined,
          }
        : undefined
    const initial = sources.find((source) => source.kind === "diff") ?? sources.find((source) => source.kind === "current") ?? sources[0]!
    return {
      kind: "diff",
      origin: "snapeye",
      name,
      runId,
      ...dimensions,
      captureMs: number(record(metadata.timing)?.captureMs),
      diff: summary,
      sources,
      initialSource: initial.key,
    }
  }

  if (text(artifacts.gif)) {
    sources.push(artifactSource("gif", { source: "run", runId, artifact: "gif" }))
  }
  if (text(artifacts.frames)) {
    sources.push(artifactSource("frames", { source: "run", runId, artifact: "frames" }))
  }
  if (text(artifacts.current)) {
    sources.push(artifactSource("current", { source: "run", runId, artifact: "current" }))
  }
  if (!sources.length) return
  return {
    kind: "record",
    origin: "snapeye",
    name,
    runId,
    ...dimensions,
    captureMs: number(record(metadata.timing)?.captureMs),
    sources,
    initialSource: sources[0]!.key,
  }
}

