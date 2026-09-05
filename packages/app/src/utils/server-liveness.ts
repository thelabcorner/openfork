// Per-server SSE event-stream liveness, shared between the SDK event stream
// (writer) and the health poll (reader). The stream replays `server.connected`
// on every (re)connect and carries a server heartbeat every 10s, so a stream
// that has delivered an event within the window is proof the server is alive —
// the health poll can skip that server instead of firing an extra HTTP request
// every 10s per window. On a genuine stream failure the writer marks the server
// dead and the poll resumes, keeping failure detection at the exact cadence and
// grace period it had before.
//
// The window deliberately matches the poll's own red grace period (2
// consecutive 10s-poll failures ≈ 20s): a heartbeat delayed by transient load
// no longer expires liveness a full cycle before the poll would flip red
// anyway, which was a source of red/green flapping under concurrent sessions.
// Genuine outages still surface no later than before.
const STREAM_LIVE_WINDOW_MS = 20_000
const liveUntil = new Map<string, number>()

export function markServerStreamLive(key: string) {
  liveUntil.set(key, Date.now() + STREAM_LIVE_WINDOW_MS)
}

export function markServerStreamDead(key: string) {
  liveUntil.delete(key)
}

export function isServerStreamLive(key: string) {
  return (liveUntil.get(key) ?? 0) > Date.now()
}

export function forgetServerStreamLiveness(key: string) {
  liveUntil.delete(key)
}