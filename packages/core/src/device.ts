export * as Device from "./device"

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { asc, eq } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { DeviceTable } from "./device/sql"
import { Identifier } from "./id/id"

// Pairing codes use a 32-symbol alphabet without visually ambiguous glyphs
// (no 0/O/1/I) so a phone-typed fallback code survives hand transcription.
const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
const PAIR_CODE_LENGTH = 6
const PAIR_TTL_MS = 90_000
// Per-client and process-wide token buckets protect the unauthenticated claim
// route. The global bucket remains effective when a proxy header is spoofed.
const CLAIM_IP_BURST = 10
const CLAIM_IP_REFILL_PER_MINUTE = 10
const CLAIM_GLOBAL_BURST = 30
const CLAIM_GLOBAL_REFILL_PER_MINUTE = 30
const CLAIM_BUCKET_CAPACITY = 1024
const TOKEN_BYTES = 32
const TOKEN_PREFIX_LENGTH = 8
const DEFAULT_DEVICE_NAME = "Paired device"
// How long a dead/expired pairing code remains observable as "exhausted"/
// "expired" before pruning. Bounded and unrelated to the live TTL.
const PAIR_TOMBSTONE_MS = 10 * 60_000

export const PAIRING = {
  codeLength: PAIR_CODE_LENGTH,
  alphabet: PAIR_ALPHABET,
  ttlMs: PAIR_TTL_MS,
} as const

export const CLAIM_RATE_LIMIT = {
  burst: CLAIM_IP_BURST,
  refillPerMinute: CLAIM_IP_REFILL_PER_MINUTE,
  globalBurst: CLAIM_GLOBAL_BURST,
  globalRefillPerMinute: CLAIM_GLOBAL_REFILL_PER_MINUTE,
} as const

export class Info extends Schema.Class<Info>("Device.Info")({
  id: Schema.String,
  name: Schema.String,
  tokenPrefix: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
}) {}

export class Pairing extends Schema.Class<Pairing>("Device.Pairing")({
  code: Schema.String,
  expiresAt: Schema.String,
}) {}

export type Created = {
  readonly device: Info
  /** Plaintext device token — returned exactly once, never stored. */
  readonly token: string
}

export class PairCodeError extends Schema.TaggedErrorClass<PairCodeError>()("PairCodeError", {
  reason: Schema.Literals(["invalid", "expired", "exhausted"]),
}) {}

export class ClaimRateLimitedError extends Schema.TaggedErrorClass<ClaimRateLimitedError>()(
  "ClaimRateLimitedError",
  { retryAfterMs: Schema.Number },
) {}

export interface Interface {
  /** Mints a new device token and registers it. The plaintext token is returned once. */
  readonly create: (input?: { readonly name?: string }) => Effect.Effect<Created>
  /** Lists every registered device, oldest first. */
  readonly list: () => Effect.Effect<Info[]>
  /** Soft-revokes one device; revoked tokens fail verification. False when unknown. */
  readonly revoke: (id: string) => Effect.Effect<boolean>
  /** Resolves a plaintext token to its device, or undefined when unknown or revoked. */
  readonly verify: (token: string) => Effect.Effect<Info | undefined>
  /** Records successful token use. */
  readonly touch: (id: string) => Effect.Effect<void>
  /** Mints a single-use pairing code that expires after PAIRING.ttlMs. */
  readonly beginPairing: () => Effect.Effect<Pairing>
  /** Exchanges a pairing code for a one-time device token. */
  readonly claim: (input: {
    readonly code: string
    readonly ip?: string
    readonly name?: string
  }) => Effect.Effect<Created, PairCodeError | ClaimRateLimitedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/Device") {}

type PairingSession = {
  readonly codeHash: Buffer
  readonly expiresAt: number
}

function hashHex(input: string) {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

function hashDigest(input: string) {
  return createHash("sha256").update(input, "utf8").digest()
}

// Codes are normalized (uppercase, whitespace/dash separators removed) before
// hashing so phone-typed input like "ab cd-ef" still matches.
function normalizeCode(code: string) {
  return code.trim().toUpperCase().replaceAll(/[\s-]+/g, "")
}

type Bucket = { tokens: number; updatedAt: number }

function takeToken(buckets: Map<string, Bucket>, key: string, now: number, burst: number, refillPerMinute: number) {
  const refillPerMs = refillPerMinute / 60_000
  const bucket = buckets.get(key)
  if (!bucket) {
    while (buckets.size >= CLAIM_BUCKET_CAPACITY) buckets.delete(buckets.keys().next().value!)
    buckets.set(key, { tokens: burst - 1, updatedAt: now })
    return { ok: true as const, retryAfterMs: 0 }
  }
  const tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) * refillPerMs)
  if (tokens < 1) return { ok: false as const, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) }
  bucket.tokens = tokens - 1
  bucket.updatedAt = now
  return { ok: true as const, retryAfterMs: 0 }
}

const IP_BUCKET_IDLE_MS = 10 * 60_000

function pruneBuckets(buckets: Map<string, Bucket>, now: number) {
  for (const [ip, bucket] of buckets) {
    if (now - bucket.updatedAt > IP_BUCKET_IDLE_MS) buckets.delete(ip)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Pairing sessions live in memory only: they are single-use and expire in
    // 90 seconds, so surviving a server restart mid-ceremony has no value.
    const pairings = new Map<string, PairingSession>()
    const ipBuckets = new Map<string, Bucket>()
    const globalBuckets = new Map<string, Bucket>()

    const info = (row: typeof DeviceTable.$inferSelect) =>
      new Info({
        id: row.id,
        name: row.name,
        tokenPrefix: row.token_prefix,
        createdAt: new Date(row.created_at).toISOString(),
        lastSeenAt: row.last_seen_at === null ? undefined : new Date(row.last_seen_at).toISOString(),
        revokedAt: row.revoked_at === null ? undefined : new Date(row.revoked_at).toISOString(),
      })

    const insertDevice = Effect.fn("Device.insert")(function* (name: string) {
      const token = randomBytes(TOKEN_BYTES).toString("base64url")
      const row = {
        id: Identifier.create("dev", "ascending"),
        name,
        token_hash: hashHex(token),
        token_prefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        created_at: Date.now(),
        last_seen_at: null,
        revoked_at: null,
      }
      yield* db.insert(DeviceTable).values(row).run().pipe(Effect.orDie)
      return { device: info(row), token } satisfies Created
    })

    // Expired codes stay as tombstones for a grace window so a late correct
    // guess reports "expired" instead of "invalid"; pruning keeps memory bounded.
    const prunePairings = (now: number) => {
      for (const [key, session] of pairings) {
        if (session.expiresAt + PAIR_TOMBSTONE_MS <= now) pairings.delete(key)
      }
    }

    return Service.of({
      create: Effect.fn("Device.create")(function* (input) {
        return yield* insertDevice(input?.name ?? DEFAULT_DEVICE_NAME)
      }),
      list: Effect.fn("Device.list")(function* () {
        const rows = yield* db.select().from(DeviceTable).orderBy(asc(DeviceTable.created_at)).all().pipe(Effect.orDie)
        return rows.map(info)
      }),
      revoke: Effect.fn("Device.revoke")(function* (id) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db.select().from(DeviceTable).where(eq(DeviceTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return false
        if (row.revoked_at === null) {
          yield* db.update(DeviceTable).set({ revoked_at: now }).where(eq(DeviceTable.id, id)).run().pipe(Effect.orDie)
        }
        return true
      }),
      verify: Effect.fn("Device.verify")(function* (token) {
        const row = yield* db
          .select()
          .from(DeviceTable)
          .where(eq(DeviceTable.token_hash, hashHex(token)))
          .get()
          .pipe(Effect.orDie)
        if (!row || row.revoked_at !== null) return undefined
        return info(row)
      }),
      touch: Effect.fn("Device.touch")(function* (id) {
        const now = yield* DateTime.nowAsDate
        yield* db
          .update(DeviceTable)
          .set({ last_seen_at: now.getTime() })
          .where(eq(DeviceTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      beginPairing: Effect.fn("Device.beginPairing")(function* () {
        const now = yield* Clock.currentTimeMillis
        prunePairings(now)
        let code = ""
        for (let i = 0; i < PAIR_CODE_LENGTH; i++) code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]
        const expiresAt = now + PAIR_TTL_MS
        pairings.set(hashHex(code), { codeHash: hashDigest(code), expiresAt })
        return new Pairing({ code, expiresAt: new Date(expiresAt).toISOString() })
      }),
      claim: Effect.fn("Device.claim")(function* (input) {
        const now = yield* Clock.currentTimeMillis
        prunePairings(now)
        pruneBuckets(ipBuckets, now)
        const global = takeToken(globalBuckets, "claim", now, CLAIM_GLOBAL_BURST, CLAIM_GLOBAL_REFILL_PER_MINUTE)
        if (!global.ok) return yield* new ClaimRateLimitedError({ retryAfterMs: global.retryAfterMs })
        const client = takeToken(
          ipBuckets,
          input.ip ?? "unknown",
          now,
          CLAIM_IP_BURST,
          CLAIM_IP_REFILL_PER_MINUTE,
        )
        if (!client.ok) return yield* new ClaimRateLimitedError({ retryAfterMs: client.retryAfterMs })
        // Constant-time comparison: the provided code is hashed once and its
        // fixed-length digest is compared against every live session digest
        // with timingSafeEqual — no variable-time byte comparison over secret
        // material ever runs. Unmatched guesses never mutate live pairings;
        // otherwise an anonymous attacker could invalidate every active OTP.
        const provided = hashDigest(normalizeCode(input.code))
        let matchedKey: string | undefined
        for (const [key, session] of pairings) {
          if (timingSafeEqual(provided, session.codeHash)) {
            matchedKey = key
            break
          }
        }
        if (!matchedKey) {
          return yield* new PairCodeError({ reason: "invalid" })
        }
        const session = pairings.get(matchedKey)
        pairings.delete(matchedKey)
        if (!session) return yield* new PairCodeError({ reason: "invalid" })
        if (session.expiresAt <= now) return yield* new PairCodeError({ reason: "expired" })
        return yield* insertDevice(input.name ?? DEFAULT_DEVICE_NAME)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
