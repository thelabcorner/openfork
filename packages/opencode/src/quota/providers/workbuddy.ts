import { Effect } from "effect"
import { AccountVault, accountLabels, stableAccountIdentity, type Credential } from "@/plugin/workbuddy-accounts"
import { discoverWorkBuddyCatalog, workBuddyLimitSnapshot, recordWorkBuddyPackageCredits } from "@/plugin/workbuddy"
import { asObject, buildResult, toNumber, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import type { UsageWindow } from "../schema"
import { createQuotaCache } from "./http"

async function mapLimited<A, B>(items: readonly A[], fn: (item: A) => Promise<B>, concurrency = 4): Promise<B[]> {
  const results: B[] = []
  results.length = items.length
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * WorkBuddy / CodeBuddy (Tencent) per-account credit-package quota.
 *
 * Unlike every other adapter here, WorkBuddy is genuinely multi-account: the
 * plugin's `AccountVault` can hold several enrolled Tencent identities at
 * once (see workbuddy-accounts.ts), and each has its own independent Free/Pro
 * plan, base credits, gift/activity bonus, and paid top-up packages. There is
 * no per-account slot in the quota wire contract (`ProviderResult` is one
 * result per adapter id), so every enrolled account is folded into a single
 * result using a small key grammar the frontend (`limits-format.ts`'s
 * `parseWorkBuddyKey`, `limits-panel.tsx`'s workbuddy-specific rendering)
 * parses back apart:
 *
 *   "aggregate:basic" | "aggregate:gift" | "aggregate:extra" | "aggregate:combined"
 *       Summed across every enrolled account. WorkBuddy credits are additive,
 *       NOT tiered like most other providers here: Tencent draws down Basic
 *       first, then Extra (top-ups), then Gift (activity) last, but a request
 *       still succeeds as long as ANY of the three still has balance. So
 *       Basic hitting 0% does not mean the account is exhausted —
 *       `aggregate:combined` (Basic+Extra+Gift totals summed together) is the
 *       ONLY window that participates in the provider's tier-gate;
 *       `basic`/`gift`/`extra` individually never gate, because none of them
 *       alone determines whether the account can still be used.
 *
 *   "account:<label>:Basic" | "account:<label>:Gift" | "account:<label>:Extra" | "account:<label>:Combined"
 *       One account's breakdown, rendered nested under that account in the
 *       collapsible per-account section. `Combined` is the same
 *       Basic+Extra+Gift sum as above, scoped to one account — it drives that
 *       account's own header row (remaining %, tone, "exhausted" tag) instead
 *       of Basic alone, for the same additive reason. None of the four
 *       participate in the provider-wide gate (the aggregate is the single
 *       source of truth for the card's tone) — otherwise N accounts each
 *       contributing a gating candidate reintroduces exactly the "one
 *       exhausted alt account paints everything red" problem the aggregate
 *       exists to fix.
 *
 * `<label>` is produced by `accountLabels()` (workbuddy-accounts.ts) — the
 * same disambiguation the model picker uses, so an account reads identically
 * in both places.
 *
 * Endpoint contract (`/v2/billing/meter/get-user-resource` etc.) is an
 * UNDOCUMENTED Tencent product endpoint, reverse-engineered from several
 * independent community clients (Cockpit Tools, FoxRouters, 9router, the
 * CodeBuddy Usage VS Code extension) — see
 * WORKBUDDY_USAGE_API_RESEARCH.md for the full trail. Response field names
 * are therefore parsed defensively (loose numeric coercion, several field
 * name candidates, a recursive search for the package array) rather than
 * assumed exact, and a failure here must never be surfaced as louder than
 * "usage unavailable" — it never gates inference.
 *
 * Credit-to-USD: WorkBuddy's own pricing page (workbuddy.ai/docs/workbuddy/pricing,
 * verified live 2026-08-29) publishes a real top-up price — $15 for 500 Pro
 * credits — so `pointsLabel` reports "top-up value" using that rate rather
 * than inventing one. This is deliberately NOT the effective in-subscription
 * cost per credit (bundled Pro credits are cheaper than buying a top-up), so
 * it is labeled "top-up value", not "worth" or "cost".
 */

const ID = "workbuddy"
const NAME = "WorkBuddy"
const ALIASES = ["workbuddy", "codebuddy"]
const REQUEST_TIMEOUT_MS = 10_000
/** WorkBuddy Pro top-up: $15 / 500 credits. workbuddy.ai/docs/workbuddy/pricing, verified 2026-08-29. */
const TOPUP_USD_PER_CREDIT = 15 / 500

const BACKENDS: Record<string, string> = {
  "www.workbuddy.ai": "https://www.workbuddy.ai",
  "staging.workbuddy.ai": "https://staging.workbuddy.ai",
  "www.workbuddy.cn": "https://copilot.tencent.com",
  "www.codebuddy.cn": "https://copilot.tencent.com",
}
const DEFAULT_BACKEND = "https://www.workbuddy.ai"

function backendFor(cred: Credential): string {
  return BACKENDS[cred.domain] ?? DEFAULT_BACKEND
}

function headersFor(cred: Credential): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Authorization: `Bearer ${cred.accessToken}`,
    "X-User-Id": cred.uid,
    "X-Enterprise-Id": cred.enterpriseId,
    "X-Tenant-Id": cred.enterpriseId,
    "X-Domain": cred.domain,
  }
}

function formatTencentDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export type WorkBuddyFetch = (input: string, init: RequestInit) => Promise<Response>

type PostOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; message: string }

async function postJson(url: string, headers: Record<string, string>, body: unknown, fetchImpl: WorkBuddyFetch): Promise<PostOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` }
    const json = await res.json().catch(() => undefined)
    if (json === undefined) return { ok: false, status: res.status, message: "Invalid response" }
    return { ok: true, body: json }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// --- loose response parsing ---------------------------------------------------
// Schema is not publicly documented (see file header); recurse into the
// envelope and grab the first array whose entries look like resource packages.

function looksLikePackage(value: unknown): value is Record<string, unknown> {
  const obj = asObject(value)
  if (!obj) return false
  return "PackageCode" in obj || "PackageName" in obj || "CapacitySizePrecise" in obj || "CapacityRemainPrecise" in obj
}

function findPackageArray(value: unknown, depth = 0): Record<string, unknown>[] | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(looksLikePackage)) return value as Record<string, unknown>[]
    for (const item of value) {
      const found = findPackageArray(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findPackageArray(v, depth + 1)
    if (found) return found
  }
  return undefined
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = toNumber(obj[key])
    if (n !== null) return n
  }
  return null
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === "string" && v.length > 0) return v
    if (typeof v === "number") return String(v)
  }
  return undefined
}

type PackageKind = "base" | "activity" | "extra" | "other"

function classifyPackage(raw: Record<string, unknown>): PackageKind {
  const label = `${firstString(raw, ["PackageCode"]) ?? ""} ${firstString(raw, ["PackageName"]) ?? ""}`.toLowerCase()
  if (/gift|activity|bonus|promo|赠送|活动/.test(label)) return "activity"
  if (/extra|top.?up|add.?on|加量/.test(label)) return "extra"
  if (/basic|base|free|pro|套餐|基础/.test(label)) return "base"
  return "other"
}

type NormalizedPackage = {
  kind: PackageKind
  total: number | null
  remaining: number | null
  used: number | null
  expiresAt: number | null
  status: number | null
}

function normalizePackage(raw: Record<string, unknown>): NormalizedPackage {
  const total = firstNumber(raw, ["CycleCapacitySizePrecise", "CapacitySizePrecise", "CycleCapacitySize", "CapacitySize"])
  const remaining = firstNumber(raw, ["CycleCapacityRemainPrecise", "CapacityRemainPrecise", "CycleCapacityRemain", "CapacityRemain"])
  const usedRaw = firstNumber(raw, ["CycleCapacityUsedPrecise", "CapacityUsedPrecise", "CycleCapacityUsed", "CapacityUsed"])
  const used = usedRaw ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null)
  const expiryRaw = raw.ExpiredTime ?? raw.CycleResetTime ?? raw.CycleEndTime ?? raw.PackageEndTime
  const expiresAt = typeof expiryRaw === "string" ? Date.parse(expiryRaw.replace(" ", "T") + (expiryRaw.includes("T") ? "" : "Z")) : null
  const status = firstNumber(raw, ["Status"])
  return {
    kind: classifyPackage(raw),
    total,
    remaining,
    used,
    expiresAt: Number.isFinite(expiresAt) ? (expiresAt as number) : null,
    status,
  }
}

/** Sums a bucket of same-kind packages into one display row. */
function mergeBucket(packages: NormalizedPackage[]): { total: number | null; remaining: number | null; used: number | null; expiresAt: number | null } {
  if (packages.length === 0) return { total: null, remaining: null, used: null, expiresAt: null }
  let total: number | null = null
  let remaining: number | null = null
  let used: number | null = null
  let expiresAt: number | null = null
  for (const p of packages) {
    if (p.total !== null) total = (total ?? 0) + p.total
    if (p.remaining !== null) remaining = (remaining ?? 0) + p.remaining
    if (p.used !== null) used = (used ?? 0) + p.used
    if (p.expiresAt !== null && (expiresAt === null || p.expiresAt < expiresAt)) expiresAt = p.expiresAt
  }
  return { total, remaining, used, expiresAt }
}

function usedPercentOf(total: number | null, used: number | null, remaining: number | null): number | null {
  if (total === null || total <= 0) return null
  if (used !== null) return (used / total) * 100
  if (remaining !== null) return 100 - (remaining / total) * 100
  return null
}

function pointsLabel(total: number | null, remaining: number | null, used: number | null): string | undefined {
  if (total === null) return undefined
  const usedValue = used ?? (remaining !== null ? Math.max(0, total - remaining) : null)
  const remainingValue = remaining ?? (usedValue !== null ? Math.max(0, total - usedValue) : null)
  const usdSuffix = remainingValue !== null && remainingValue > 0 ? ` (top-up value ~$${(remainingValue * TOPUP_USD_PER_CREDIT).toFixed(2)})` : ""
  if (usedValue === null) return `${Math.round(total)} pts${usdSuffix}`
  return `${Math.round(usedValue)} / ${Math.round(total)} pts${usdSuffix}`
}

type PackageBucket = { total: number | null; remaining: number | null; used: number | null; expiresAt: number | null }

function windowFromBucket(bucket: PackageBucket, opts?: { fallbackWindowSeconds?: number; emptyLabel?: string }): UsageWindow | undefined {
  if (bucket.total === null && bucket.remaining === null) {
    return opts?.emptyLabel ? toUsageWindow({ usedPercent: null, valueLabel: opts.emptyLabel }) : undefined
  }
  return toUsageWindow({
    usedPercent: usedPercentOf(bucket.total, bucket.used, bucket.remaining),
    windowSeconds: bucket.expiresAt ? null : opts?.fallbackWindowSeconds,
    resetAt: bucket.expiresAt,
    valueLabel: pointsLabel(bucket.total, bucket.remaining, bucket.used),
  })
}

/** Basic+Extra+Gift combined into one additive pool — see the file header comment. */
function combinedBucket(packages: NormalizedPackage[]) {
  return mergeBucket(packages.filter((p) => p.kind === "base" || p.kind === "activity" || p.kind === "extra"))
}

/** One account's Basic/Gift/Extra/Combined rows, nested under it in the per-account section. Never gates. */
function accountWindows(label: string, packages: NormalizedPackage[]): Record<string, UsageWindow> {
  const windows: Record<string, UsageWindow> = {}
  const base = windowFromBucket(mergeBucket(packages.filter((p) => p.kind === "base")), { fallbackWindowSeconds: 2_592_000 })
  if (base) windows[`account:${label}:Basic`] = base
  const activity = windowFromBucket(mergeBucket(packages.filter((p) => p.kind === "activity")))
  if (activity) windows[`account:${label}:Gift`] = activity
  windows[`account:${label}:Extra`] = windowFromBucket(mergeBucket(packages.filter((p) => p.kind === "extra")), {
    emptyLabel: "No extra packs available",
  })!
  const combined = windowFromBucket(combinedBucket(packages), { fallbackWindowSeconds: 2_592_000 })
  if (combined) windows[`account:${label}:Combined`] = combined
  return windows
}

/** Summed across every enrolled account. Only `aggregate:combined` participates in the tier-gate. */
function aggregateWindows(allPackages: NormalizedPackage[]): Record<string, UsageWindow> {
  const windows: Record<string, UsageWindow> = {}
  const base = windowFromBucket(mergeBucket(allPackages.filter((p) => p.kind === "base")), { fallbackWindowSeconds: 2_592_000 })
  if (base) windows["aggregate:basic"] = base
  const activity = windowFromBucket(mergeBucket(allPackages.filter((p) => p.kind === "activity")))
  if (activity) windows["aggregate:gift"] = activity
  windows["aggregate:extra"] = windowFromBucket(mergeBucket(allPackages.filter((p) => p.kind === "extra")), {
    emptyLabel: "No extra packs available",
  })!
  const combined = windowFromBucket(combinedBucket(allPackages), { fallbackWindowSeconds: 2_592_000 })
  if (combined) windows["aggregate:combined"] = combined
  return windows
}

function planLabelFrom(paymentTypeBody: unknown): string | undefined {
  const data = asObject(asObject(paymentTypeBody)?.data) ?? asObject(paymentTypeBody)
  const raw = data ? firstString(data, ["paymentType", "PaymentType", "plan", "planName"]) : undefined
  if (!raw) return undefined
  if (/free|trial/i.test(raw)) return "Free"
  if (/pro|paid|enterprise/i.test(raw)) return "Pro"
  return raw
}

/**
 * Raw per-account fetch, deliberately NOT keyed by label — the label can
 * change between calls (a second account enrolling changes disambiguation
 * suffixes via `accountLabels()`), and this is what the cache stores, so a
 * stale label must never get baked into a cached result.
 */
type AccountFetchResult = { packages: NormalizedPackage[]; planLabel?: string; error?: string }

async function fetchAccountUsage(cred: Credential, fetchImpl: WorkBuddyFetch): Promise<AccountFetchResult> {
  const base = backendFor(cred)
  const headers = headersFor(cred)
  const now = new Date()
  const farFuture = new Date(now)
  farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 100)

  const [resource, payment] = await Promise.all([
    postJson(`${base}/v2/billing/meter/get-user-resource`, headers, {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: formatTencentDate(now),
      PackageEndTimeRangeEnd: formatTencentDate(farFuture),
    }, fetchImpl),
    postJson(`${base}/v2/billing/meter/get-payment-type`, headers, {}, fetchImpl),
  ])

  if (!resource.ok) {
    const reauth = resource.status === 401 || resource.status === 403
    return { packages: [], error: reauth ? "Session expired — please re-authenticate with WorkBuddy" : resource.message }
  }

  const rawPackages = findPackageArray(resource.body) ?? []
  const packages = rawPackages.map(normalizePackage).filter((p) => p.status === null || p.status === 0 || p.status === 3)
  const planLabel = payment.ok ? planLabelFrom(payment.body) : undefined
  return { packages, planLabel }
}

/** Test-only vault root override, mirroring the plugin's setTestAccountStore. */
export const workbuddy = (fetchImpl: WorkBuddyFetch = globalThis.fetch.bind(globalThis), vaultRoot?: string): Adapter => {
  const caches = new Map<string, ReturnType<typeof createQuotaCache<AccountFetchResult>>>()
  const cacheFor = (id: string) => {
    let c = caches.get(id)
    if (!c) {
      c = createQuotaCache<AccountFetchResult>(id)
      caches.set(id, c)
    }
    return c
  }
  const vault = () => new AccountVault(vaultRoot)

  return {
    id: ID,
    name: NAME,
    aliases: ALIASES,
    configured: () => Effect.sync(() => vault().list().length > 0),
    fetch: () =>
      Effect.promise(async () => {
        const accounts = vault().list()
        if (accounts.length === 0) {
          return buildResult({ providerId: ID, providerName: NAME, ok: false, configured: false, error: "Not configured" })
        }

        // Same labeling scheme as the model picker (workbuddy.ts's
        // `provider.models()`), so an account reads identically there and here.
        const labels = accountLabels(
          accounts.map((cred) => ({ id: stableAccountIdentity(cred), uid: cred.uid, nickname: cred.nickname })),
        )

        // Each account carries its own cache (and therefore its own
        // next-refresh time); the provider as a whole can only be refreshed
        // usefully once the SLOWEST account is re-readable.
        const settled = await mapLimited(accounts, async (cred) => {
          const id = stableAccountIdentity(cred)
          const cache = cacheFor(id)
          const fresh = cache.fresh(cred.accessToken)
          if (fresh) return { result: fresh, nextRefreshAt: cache.nextRefreshAt() }
          if (cache.isCoolingDown()) {
            const cached = cache.cachedResult()
            return {
              result: cached ?? { packages: [], error: "Rate limited — WorkBuddy is throttling usage checks" },
              nextRefreshAt: cache.nextRefreshAt(),
            }
          }
          const result = await fetchAccountUsage(cred, fetchImpl)
          if (result.error && /rate limit|429/i.test(result.error)) {
            cache.coolDown(result, undefined, cred.accessToken)
          } else {
            cache.store(result, cred.accessToken)
          }
          return { result, nextRefreshAt: cache.nextRefreshAt() }
        })
        const nextRefreshAt = settled.reduce((latest, entry) => Math.max(latest, entry.nextRefreshAt), 0)
        const results = settled.map((entry) => entry.result)

        const windows: Record<string, UsageWindow> = {}
        const errors: string[] = []
        const allPackages: NormalizedPackage[] = []
        let anyOk = false
        results.forEach((r, index) => {
          if (r.packages.length > 0 || !r.error) {
            const accountId = stableAccountIdentity(accounts[index]!)
            const label = labels.get(accountId) ?? accountId
            Object.assign(windows, accountWindows(label, r.packages))
            allPackages.push(...r.packages)
            anyOk = true
            // Opportunistically push the combined balance to the router so
            // automatic account selection can avoid a 0-credit account
            // instead of learning it the hard way via a wasted 402 — see
            // `recordWorkBuddyPackageCredits`.
            const combined = combinedBucket(r.packages)
            if (combined.remaining !== null) recordWorkBuddyPackageCredits(accountId, combined.remaining)
          }
          if (r.error) errors.push(r.error)
        })
        if (anyOk) Object.assign(windows, aggregateWindows(allPackages))

        // Per-model consumption rates, so the model picker can turn "this
        // account has N credits left" into "≈ M requests on this model".
        // Best-effort: a catalog failure must not take down the quota card —
        // the picker simply shows no bar rather than an error.
        const models: Record<string, { windows: Record<string, UsageWindow>; rate?: number; rateFree?: boolean; rateLabel?: string | null; promotionLabel?: string | null }> = {}
        const catalog = await discoverWorkBuddyCatalog(accounts[0]!).catch(() => undefined)
        for (const [id, entry] of catalog ?? []) {
          if (entry.credits <= 0 && !entry.creditsFree) continue
          models[id] = {
            windows: {},
            rate: entry.credits,
            rateFree: entry.creditsFree,
            rateLabel: entry.creditsLabel || null,
            promotionLabel: entry.promotionLabel ?? null,
          }
        }

        const planLabel = accounts.length === 1 ? results[0]?.planLabel : undefined
        const workbuddyAccounts = workBuddyLimitSnapshot()
        // hy3/hy4-preview always get a placeholder entry (zero observed, no
        // window hit yet) even on an account that has never routed a single
        // request through it — that placeholder must not count as "we have
        // data" and mask a real package-credit fetch failure (401/5xx).
        const hasModelSignal = workbuddyAccounts.some((a) => a.models.some((m) => m.usedObserved > 0 || m.exhaustedObserved))
        if (!anyOk && !hasModelSignal) {
          return buildResult({
            providerId: ID,
            providerName: NAME,
            ok: false,
            configured: true,
            error: errors[0] ?? "Usage data unavailable",
            nextRefreshAt,
          })
        }
        return buildResult({
          providerId: ID,
          providerName: NAME,
          ok: true,
          configured: true,
          usage: {
            windows,
            ...(Object.keys(models).length > 0 ? { models } : {}),
            // Publish the stable-id -> display-label pairing so the model picker
            // can resolve an account-qualified model id (`hy4-preview@wb-<uid>`)
            // to the quota window that funds it. The two are not string-derivable.
            ...(labels.size > 0 ? { accountLabels: Object.fromEntries(labels) } : {}),
            ...(workbuddyAccounts.length > 0 ? { workbuddyAccounts } : {}),
          },
          fetchedAt: Date.now(),
          nextRefreshAt,
          ...(planLabel ? { planLabel } : {}),
        })
      }),
  }
}
