// Local type stub so the bisection copies are self-contained. Type-only; the
// runtime shape is owned by the real production module.
export interface SqliteWorkerOptions {
  readonly filename: string
  readonly readonly?: boolean
  readonly readwrite?: boolean
  readonly create?: boolean
  readonly disableWAL?: boolean
  readonly checkpointOnClose?: boolean
  readonly createTimePragmas?: Record<string, number | string>
  readonly permitLane?: string
  readonly busyTimeoutMs?: number
}
