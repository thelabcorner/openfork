import { createHash, randomBytes } from "crypto"
import { homedir, tmpdir } from "os"
import { join, resolve, sep } from "path"
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { WorkBuddyEntitlementGovernor } from "./workbuddy-governor"

// Very similar to workbuddy-accounts.ts — verdent's multi-account vault/registry/router.
// Reverse-engineered from Verdent 2.12.3 ASAR (dist/index.mjs):
//   - Desktop stores single session in OS keychain service "ai.verdent.deck" account
//     "access-token" as JSON { accessToken } — see loadBundledKeytar() in verdent.ts.
//   - The cloud proxy speaks POST https://llm-proxy.verdent.ai/llm/stream with
//     headers authorization: Bearer <token>, cookie: token=<token>, verdent-proxy-beta,
//     X-Device-ID, X-Team-ID, etc. — token is the only secret; no domain/enterprise
//     routing like WorkBuddy. So a verdent credential is just an accessToken plus
//     optional teamId. UID is derived from JWT sub when possible, otherwise hash.
//   - Auth flow is OAuth PKCE via https://www.verdent.ai/auth?challenge=...&state=...
//     &callback=... (deep link verdent://...). For multi-account we expose the same
//     vault pattern as WorkBuddy: vault is authoritative, desktop keytar is an
//     additive import source, and env tokens are additive.

export type VerdentCredential = {
  path: string
  accessToken: string
  teamId?: string
  uid: string
  nickname: string
  email?: string
  expiresAt: number
  enrollmentEpoch?: string
}

export type VerdentAccount = {
  id: string
  uid: string
  nickname: string
  email?: string
  authPath: string
  credential: VerdentCredential
  governor: WorkBuddyEntitlementGovernor
  mtime: number
  source: "vault" | "desktop-import" | "env"
}

export type VerdentRegistryOptions = {
  authFiles?: string[]
  persistenceDir?: string
  vault?: VerdentVault
}

export type StoredVerdentCredential = Omit<VerdentCredential, "path"> & {
  schema: 1
  enrolledAt: number
  importedFrom?: string
}

function verdentVaultRoot(): string {
  // Keep verdent vault inside opencode's home to avoid colliding with
  // Verdent desktop's single `~/.verdent/agent/auth.json`.
  return join(homedir(), ".opencode", "verdent")
}

function decodeJwtPayloadText(token: string): string | undefined {
  try {
    const parts = token.split(".")
    if (parts.length < 2) return undefined
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4)
    return Buffer.from(padded, "base64").toString("utf8")
  } catch {}
  return undefined
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const json = decodeJwtPayloadText(token)
    if (!json) return undefined
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
  } catch {}
  return undefined
}

function rawJwtClaim(token: string, name: string): string | undefined {
  const payload = decodeJwtPayloadText(token)
  if (!payload) return undefined
  // Do not parse numeric claims through JSON.parse: Verdent user IDs can be
  // larger than Number.MAX_SAFE_INTEGER and must retain their exact digits.
  const numeric = payload.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+)`))?.[1]
  if (numeric) return numeric
  return payload.match(new RegExp(`"${name}"\\s*:\\s*"([^"\\r\\n]*)"`))?.[1]
}

export function uidFromToken(token: string): string {
  for (const claim of ["user_id", "userId", "uid", "sub"]) {
    const value = rawJwtClaim(token, claim)
    if (value) return value
  }

  const payload = decodeJwtPayload(token)
  if (payload) {
    const candidates = [payload.sub, payload.uid, (payload as any).email, (payload as any).userIdString]
    for (const c of candidates) if (typeof c === "string" && c) return c
    if (typeof payload.email === "string" && payload.email) return payload.email
  }
  // Fallback: hash of token prefix (first 24 chars) + last 8 to disambiguate
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 8)
  return `tok-${hash}`
}

function nicknameFromToken(token: string, fallbackUid: string): string {
  const payload = decodeJwtPayload(token)
  if (payload) {
    const n =
      (payload as any).nickname ??
      (payload as any).name ??
      (payload as any).email ??
      (payload as any).preferred_username
    if (typeof n === "string" && n.trim()) return n.trim()
  }
  return fallbackUid
}

function normalizeCredential(credential: VerdentCredential): VerdentCredential {
  const accessToken = credential.accessToken.trim()
  if (!accessToken) throw new Error("Verdent account requires accessToken")

  const suppliedUid = credential.uid.trim()
  const derivedUid = uidFromToken(accessToken)
  // Opaque tokens cannot provide an identity, so retain an explicitly supplied
  // UID for those credentials. JWT identities always come from the current
  // token, which makes token rotation update the account instead of orphaning it.
  const uid = derivedUid.startsWith("tok-") && suppliedUid ? suppliedUid : derivedUid
  // Explicit metadata (for example `/user/center/info`'s email) is fresher
  // than claims embedded in an access token and should win when available.
  const suppliedNickname = credential.nickname.trim()
  const tokenNickname = nicknameFromToken(accessToken, "")
  const nickname = suppliedNickname || tokenNickname || uid
  const email = credential.email?.trim() || (suppliedNickname.includes("@") ? suppliedNickname : undefined)

  return {
    ...credential,
    accessToken,
    teamId: credential.teamId?.trim() || undefined,
    uid,
    nickname,
    ...(email ? { email } : {}),
    expiresAt: Number.isFinite(credential.expiresAt) ? credential.expiresAt : 0,
    enrollmentEpoch: credential.enrollmentEpoch?.trim() || undefined,
  }
}

export function stableVerdentIdentity(credential: VerdentCredential): string {
  // Prefer uid, fall back to token hash. Never include nickname or filename:
  // both are mutable and would orphan the account's persisted entitlement state.
  const durable = credential.uid
    ? `uid:${credential.uid}`
    : `tok:${createHash("sha256").update(credential.accessToken).digest("hex").slice(0, 12)}`
  const hash = createHash("sha256")
    .update(`${durable}|${credential.teamId ?? ""}`)
    .digest("hex")
    .slice(0, 10)
  const label =
    (credential.uid || `tok-${createHash("sha256").update(credential.accessToken).digest("hex").slice(0, 8)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "account"
  return `vd-${label}-${hash}`
}

function accountFileName(credential: VerdentCredential): string {
  return `verdent-${stableVerdentIdentity(credential)}.json`
}

function persistenceFile(dir: string, accountId: string): string {
  return join(dir, `${accountId}-verdent-entitlement.json`)
}

export function verdentAccountLabels(
  accounts: Array<
    Pick<VerdentAccount, "id" | "uid" | "nickname" | "email"> & { credential?: Pick<VerdentCredential, "email"> }
  >,
): Map<string, string> {
  const base = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const account of accounts) {
    const email = (account as any).email?.trim() || (account as any).credential?.email?.trim()
    const rawNickname = account.nickname.trim()
    const isNumericNickname = rawNickname === account.uid.trim() && /^\d+$/.test(rawNickname)
    const label =
      (!isNumericNickname && rawNickname ? rawNickname : email || rawNickname) || account.uid.trim() || account.id
    base.set(account.id, label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const labels = new Map<string, string>()
  for (const account of accounts) {
    const label = base.get(account.id)!
    labels.set(account.id, (counts.get(label) ?? 0) > 1 ? `${label} #${account.id.slice(-4)}` : label)
  }
  return labels
}

export class VerdentVault {
  readonly root: string
  readonly accountsDir: string

  constructor(root = join(verdentVaultRoot(), "accounts")) {
    this.root = root
    this.accountsDir = root
    mkdirSync(this.accountsDir, { recursive: true })
  }

  private pathFor(credential: VerdentCredential): string {
    return join(this.accountsDir, accountFileName(credential))
  }

  private isOwnedPath(path: string): boolean {
    const root = resolve(this.accountsDir)
    const target = resolve(path)
    return target.startsWith(`${root}${sep}`)
  }

  private storedToCredential(path: string, stored: StoredVerdentCredential): VerdentCredential {
    return normalizeCredential({
      path,
      accessToken: stored.accessToken,
      teamId: typeof stored.teamId === "string" ? stored.teamId : undefined,
      uid: typeof stored.uid === "string" ? stored.uid : "",
      nickname: typeof stored.nickname === "string" ? stored.nickname : "",
      email: typeof (stored as any).email === "string" ? (stored as any).email : undefined,
      expiresAt: typeof stored.expiresAt === "number" && Number.isFinite(stored.expiresAt) ? stored.expiresAt : 0,
      enrollmentEpoch: stored.enrollmentEpoch,
    })
  }

  list(): VerdentCredential[] {
    const result: VerdentCredential[] = []
    try {
      for (const name of readdirSync(this.accountsDir)) {
        if (!/^verdent-[^/\\]+\.json$/i.test(name)) continue
        const path = join(this.accountsDir, name)
        try {
          const stored = JSON.parse(readFileSync(path, "utf8")) as StoredVerdentCredential
          if (stored?.schema !== 1 || typeof stored.accessToken !== "string" || !stored.accessToken.trim()) continue
          result.push(this.storedToCredential(path, stored))
        } catch {}
      }
    } catch {}
    return result
  }

  /** Read the pre-normalization identity from a legacy record, if present. */
  legacyIdentityForToken(accessToken: string): string | undefined {
    try {
      for (const name of readdirSync(this.accountsDir)) {
        if (!/^verdent-[^/\\]+\.json$/i.test(name)) continue
        const path = join(this.accountsDir, name)
        try {
          const stored = JSON.parse(readFileSync(path, "utf8")) as StoredVerdentCredential
          if (stored?.schema !== 1 || stored.accessToken !== accessToken || typeof stored.uid !== "string") continue
          return stableVerdentIdentity({
            path,
            accessToken: stored.accessToken,
            teamId: typeof stored.teamId === "string" ? stored.teamId : undefined,
            uid: stored.uid,
            nickname: typeof stored.nickname === "string" ? stored.nickname : "",
            expiresAt: typeof stored.expiresAt === "number" ? stored.expiresAt : 0,
            enrollmentEpoch: stored.enrollmentEpoch,
          })
        } catch {}
      }
    } catch {}
    return undefined
  }

  save(credential: VerdentCredential, importedFrom?: string): VerdentCredential {
    const normalized = normalizeCredential(credential)
    const path = this.isOwnedPath(normalized.path) ? normalized.path : this.pathFor(normalized)
    const stored: StoredVerdentCredential = {
      schema: 1,
      enrolledAt: Date.now(),
      importedFrom,
      accessToken: normalized.accessToken,
      teamId: normalized.teamId,
      uid: normalized.uid,
      nickname: normalized.nickname,
      ...(normalized.email ? { email: normalized.email } : {}),
      expiresAt: normalized.expiresAt,
      enrollmentEpoch: normalized.enrollmentEpoch,
    } as StoredVerdentCredential
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 })
    try {
      renameSync(temp, path)
    } catch {
      writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 })
      try {
        unlinkSync(temp)
      } catch {}
    }
    return { ...normalized, path }
  }

  importCredential(credential: VerdentCredential, importedFrom = credential.path): VerdentCredential {
    const normalized = normalizeCredential(credential)
    const canonicalPath = this.pathFor(normalized)
    const existing = this.list().find(
      (item) =>
        stableVerdentIdentity(item) === stableVerdentIdentity(normalized) ||
        item.accessToken === normalized.accessToken,
    )
    if (existing) {
      const saved = this.save(
        { ...normalized, path: canonicalPath, enrollmentEpoch: existing.enrollmentEpoch },
        importedFrom,
      )
      if (existing.path !== canonicalPath)
        try {
          unlinkSync(existing.path)
        } catch {}
      return saved
    }
    return this.save(
      {
        ...normalized,
        path: canonicalPath,
        enrollmentEpoch: normalized.enrollmentEpoch ?? randomBytes(16).toString("hex"),
      },
      importedFrom,
    )
  }

  remove(accountId: string): boolean {
    const credential = this.list().find((item) => stableVerdentIdentity(item) === accountId)
    if (!credential) return false
    try {
      unlinkSync(credential.path)
      return true
    } catch {
      return false
    }
  }
}

// Candidate auth files for Verdent: allow an explicit override, otherwise scan
// the optional agent auth file (keytar remains the primary desktop source).
// WorkBuddy scans CodeBuddyExtension auth/*.info files; Verdent desktop uses keytar
// service ai.verdent.deck plus optional ~/.verdent/agent/auth.json (pi agent).
function candidateFiles(explicit?: string[]): string[] {
  if (explicit) return [...explicit]
  const override = process.env.VERDENT_AUTH_FILE
  if (override) return [override]
  return [join(homedir(), ".verdent", "agent", "auth.json")]
}

function parseVerdentAuthJson(path: string): VerdentCredential | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    const direct = [
      parsed?.accessToken,
      parsed?.access_token,
      parsed?.token,
      parsed?.auth?.accessToken,
      parsed?.auth?.access_token,
      parsed?.oauth?.accessToken,
      parsed?.oauth?.access_token,
      parsed?.account?.accessToken,
      parsed?.account?.access_token,
      parsed?.credential?.accessToken,
      parsed?.credential?.access_token,
      parsed?.credentials?.accessToken,
      parsed?.credentials?.access_token,
    ]
    const token = direct.find((value) => typeof value === "string" && value.trim()) as string | undefined
    if (!token) return undefined
    const uid =
      typeof parsed?.uid === "string"
        ? parsed.uid
        : typeof parsed?.account?.uid === "string"
          ? parsed.account.uid
          : uidFromToken(token)
    return {
      path,
      accessToken: token.trim(),
      teamId:
        typeof parsed?.teamId === "string"
          ? parsed.teamId
          : typeof parsed?.account?.teamId === "string"
            ? parsed.account.teamId
            : undefined,
      uid,
      nickname:
        typeof parsed?.nickname === "string"
          ? parsed.nickname
          : typeof parsed?.account?.nickname === "string"
            ? parsed.account.nickname
            : nicknameFromToken(token, uid),
      expiresAt: typeof parsed?.expiresAt === "number" ? parsed.expiresAt : 0,
    }
  } catch {
    return undefined
  }
}

export class VerdentRegistry {
  private readonly explicitFiles?: string[]
  private readonly persistenceDir: string
  readonly vault: VerdentVault
  private accountsById = new Map<string, VerdentAccount>()
  private lastScan: string[] = []
  private discoveredAt = 0

  constructor(options: VerdentRegistryOptions = {}) {
    this.explicitFiles = options.authFiles
    this.persistenceDir = options.persistenceDir ?? join(tmpdir(), "opencode-verdent-accounts")
    this.vault = options.vault ?? new VerdentVault()
    mkdirSync(this.persistenceDir, { recursive: true })
  }

  private accountFrom(credential: VerdentCredential, source: VerdentAccount["source"], mtime: number): VerdentAccount {
    const id = stableVerdentIdentity(credential)
    const prior = this.accountsById.get(id)
    if (prior) {
      Object.assign(prior.credential, credential)
      prior.authPath = credential.path
      prior.uid = credential.uid
      prior.nickname = credential.nickname
      ;(prior as any).email = credential.email
      prior.mtime = mtime
      prior.source = source
      return prior
    }
    return {
      id,
      uid: credential.uid,
      nickname: credential.nickname,
      ...(credential.email ? { email: credential.email } : {}),
      authPath: credential.path,
      credential,
      governor: new WorkBuddyEntitlementGovernor({ persistenceFile: persistenceFile(this.persistenceDir, id) }),
      mtime,
      source,
    } as VerdentAccount
  }

  private migrateGovernorStateIds(from: string, to: string) {
    if (from === to) return
    const source = persistenceFile(this.persistenceDir, from)
    const target = persistenceFile(this.persistenceDir, to)
    try {
      renameSync(source, target)
    } catch {
      // If a current-identity state already exists, it is authoritative. Do
      // not overwrite it, but remove the old duplicate when possible.
      try {
        if (statSync(target).isFile()) unlinkSync(source)
      } catch {}
    }
  }

  private migrateGovernorState(previous: VerdentCredential, current: VerdentCredential) {
    this.migrateGovernorStateIds(stableVerdentIdentity(previous), stableVerdentIdentity(current))
  }

  private saveCredential(credential: VerdentCredential, importedFrom: string): VerdentCredential {
    const normalized = normalizeCredential(credential)
    const legacyId = this.vault.legacyIdentityForToken(normalized.accessToken)
    const previous = this.vault
      .list()
      .find(
        (item) =>
          stableVerdentIdentity(item) === stableVerdentIdentity(normalized) ||
          item.accessToken === normalized.accessToken,
      )
    const saved = this.vault.importCredential(normalized, importedFrom)
    if (previous) {
      this.migrateGovernorState(previous, saved)
      const previousId = stableVerdentIdentity(previous)
      if (previousId !== stableVerdentIdentity(saved)) this.accountsById.delete(previousId)
    }
    if (legacyId) this.migrateGovernorStateIds(legacyId, stableVerdentIdentity(saved))
    return saved
  }

  discover(): VerdentAccount[] {
    const now = Date.now()
    // Account discovery is synchronous filesystem work. Keep a short cache so
    // every streamed generation does not rescan the vault and recreate arrays;
    // explicit imports still update the in-memory map immediately below.
    if (now - this.discoveredAt < 1000) return [...this.accountsById.values()]
    const next = new Map<string, VerdentAccount>()

    // Vault is authoritative.
    for (const credential of this.vault.list()) {
      const id = stableVerdentIdentity(credential)
      const prior = this.accountsById.get(id)
      const account = this.accountFrom(credential, "vault", prior?.mtime ?? 0)
      next.set(id, account)
    }

    // Env tokens: VERDENT_ACCESS_TOKEN, VERDENT_ACCESS_TOKEN_2, VERDENT_TOKENS (comma), plus legacy single.
    const envCreds: VerdentCredential[] = []
    const pushEnvToken = (raw: string | undefined, tag: string) => {
      if (!raw) return
      const t = raw.trim()
      if (!t) return
      for (const tok of t.split(",")) {
        const token = tok.trim().replace(/^"+|"+$/g, "")
        if (!token) continue
        const uid = uidFromToken(token)
        envCreds.push({
          path: `env:${tag}`,
          accessToken: token,
          uid,
          nickname: nicknameFromToken(token, uid),
          expiresAt: 0,
        })
      }
    }
    pushEnvToken(process.env.VERDENT_ACCESS_TOKEN, "VERDENT_ACCESS_TOKEN")
    // Also support VERDENT_TOKENS and numbered variants for multi-account env.
    pushEnvToken(process.env.VERDENT_TOKENS, "VERDENT_TOKENS")
    for (let i = 2; i <= 10; i++)
      pushEnvToken((process.env as any)[`VERDENT_ACCESS_TOKEN_${i}`], `VERDENT_ACCESS_TOKEN_${i}`)
    // Legacy VERDENT_TOKEN (used by ASAR) — treat as env as well.
    pushEnvToken(process.env.VERDENT_TOKEN, "VERDENT_TOKEN")

    for (const cred of envCreds) {
      const id = stableVerdentIdentity(cred)
      if (next.has(id)) continue
      // Env tokens are ephemeral: do not persist to vault, just add to next map via accountFrom vault-like but source env.
      // Create a synthetic account without vault persistence.
      const account = this.accountFrom({ ...cred, path: `env:${id}` }, "env", now)
      // Keep env accounts distinct from vault; they live only in memory for this process.
      next.set(id, account)
    }

    // Desktop keytar import is additive if not already enrolled.
    // We import lazily via the caller (importCurrentDesktopAccount), but we also
    // scan for explicit authFiles if provided.
    const paths = candidateFiles(this.explicitFiles)
    this.lastScan = paths
    for (const path of paths) {
      const credential = parseVerdentAuthJson(path)
      if (!credential || !credential.uid) continue
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {}
      const id = stableVerdentIdentity(credential)
      if (next.has(id)) continue
      const enrolled = this.saveCredential(credential, path)
      next.set(id, this.accountFrom(enrolled, "desktop-import", mtime))
    }

    this.accountsById = next
    this.discoveredAt = now
    return [...next.values()]
  }

  /** Import the current desktop keytar login into the vault. */
  async importCurrentDesktopAccount(
    getToken: () => Promise<string | null>,
    getProfile?: (
      token: string,
    ) => Promise<{ uid?: string; nickname?: string; teamId?: string; expiresAt?: number } | undefined>,
  ): Promise<VerdentAccount> {
    const token = await getToken()
    if (!token)
      throw new Error("No Verdent desktop login found. Open the Verdent app and sign in, or set VERDENT_ACCESS_TOKEN.")
    const trimmed = token.trim()
    if (!trimmed) throw new Error("Verdent desktop login returned an empty token")
    const uid = uidFromToken(trimmed)
    const profile = getProfile ? await getProfile(trimmed).catch(() => undefined) : undefined
    const credential: VerdentCredential = {
      path: "",
      accessToken: trimmed,
      // Keep the exact JWT-derived identity. In particular, never replace a
      // large numeric user_id with a JSON-decoded API number.
      uid,
      nickname: profile?.nickname?.trim() || nicknameFromToken(trimmed, uid),
      teamId: profile?.teamId,
      expiresAt: profile?.expiresAt ?? 0,
    }
    const saved = this.saveCredential(credential, "desktop-import")
    const account = this.accountFrom(saved, "desktop-import", Date.now())
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "desktop-import"
    this.accountsById.set(account.id, account)
    this.discoveredAt = Date.now()
    return account
  }

  importToken(token: string, teamId?: string, nickname?: string): VerdentAccount {
    const trimmed = token.trim()
    if (!trimmed) throw new Error("Verdent token is empty")
    const uid = uidFromToken(trimmed)
    const cred: VerdentCredential = {
      path: "",
      accessToken: trimmed,
      teamId,
      uid,
      nickname: nickname ?? nicknameFromToken(trimmed, uid),
      expiresAt: 0,
      enrollmentEpoch: randomBytes(16).toString("hex"),
    }
    const saved = this.saveCredential(cred, "manual-import")
    const account = this.accountFrom(saved, "vault", Date.now())
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "vault"
    this.accountsById.set(account.id, account)
    this.discoveredAt = Date.now()
    return account
  }

  enrollCredential(credential: VerdentCredential): VerdentAccount {
    const normalized = normalizeCredential(credential)
    const saved = this.saveCredential(
      {
        ...normalized,
        enrollmentEpoch: normalized.enrollmentEpoch ?? randomBytes(16).toString("hex"),
      },
      "oauth",
    )
    const account = this.accountFrom(saved, "vault", Date.now())
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "vault"
    this.accountsById.set(account.id, account)
    this.discoveredAt = Date.now()
    return account
  }

  persistCredential(account: VerdentAccount) {
    const saved = this.vault.save(account.credential)
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "vault"
  }

  all(): VerdentAccount[] {
    return this.discover()
  }

  get(id: string): VerdentAccount | undefined {
    this.discover()
    return this.accountsById.get(id)
  }

  remove(id: string): boolean {
    const account = this.get(id)
    if (!account) return false
    // Env-only accounts cannot be removed via vault.
    if (account.source === "env") {
      this.accountsById.delete(id)
      this.discoveredAt = Date.now()
      return true
    }
    const removed = this.vault.remove(id)
    if (removed) {
      this.accountsById.delete(id)
      this.discoveredAt = Date.now()
    }
    return removed
  }

  scanned(): string[] {
    return [...this.lastScan]
  }

  snapshot() {
    return this.all().map((account) => ({
      id: account.id,
      uid: account.uid,
      nickname: account.nickname,
      authPath: account.authPath,
      source: account.source,
      governor: account.governor.metrics(),
    }))
  }
}

export type VerdentSelection = {
  account: VerdentAccount
  bound: boolean
  reason: "explicit" | "affinity" | "automatic"
}

export class VerdentRouter {
  private readonly registry: VerdentRegistry
  private bindings = new Map<string, string>()

  constructor(options: { registry: VerdentRegistry }) {
    this.registry = options.registry
  }

  bind(session: string, accountId: string): VerdentAccount | undefined {
    const account = this.registry.get(accountId)
    if (!account) return undefined
    this.bindings.set(session, account.id)
    return account
  }

  unbind(session: string) {
    this.bindings.delete(session)
  }
  binding(session: string): string | undefined {
    return this.bindings.get(session)
  }

  select(session: string, requestedModel: string, explicitAccountId?: string): VerdentSelection | undefined {
    const accounts = this.registry.all()
    if (explicitAccountId) {
      const account = accounts.find((item) => item.id === explicitAccountId)
      if (!account) return undefined
      this.bindings.set(session, account.id)
      return { account, bound: true, reason: "explicit" }
    }

    const existing = this.bindings.get(session)
    if (existing) {
      const account = accounts.find((item) => item.id === existing)
      if (!account) return undefined
      const now = Date.now()
      const metrics: any = account.governor.metrics()
      const blocked =
        metrics.state === "QUOTA_EXHAUSTED" ||
        !account.governor.canAdmitModel(requestedModel, now) ||
        !!(metrics.cooldownUntil && now < metrics.cooldownUntil) ||
        !account.governor.hasKnownCredits()
      if (blocked) {
        this.unbind(session)
      } else {
        return { account, bound: true, reason: "affinity" }
      }
    }

    const eligible = accounts.filter((account) => {
      const state = account.governor.metrics().state as string
      if (state === "QUOTA_EXHAUSTED") return false
      if (!account.governor.canAdmitModel(requestedModel)) return false
      return true
    })
    if (!eligible.length) {
      // If all accounts are QUOTA_EXHAUSTED but we have accounts, still allow the least-bad
      // — otherwise we'd return no eligible and the caller would 429. For verdent free,
      // quota exhausted means weekly window, but the other account might still be ok.
      // If none eligible, fall back to any account (let upstream return 429 and be learned).
      if (accounts.length) {
        // Prefer the one with earliest reset.
        const sorted = [...accounts].sort((a, b) => {
          const am = a.governor.metrics() as any
          const bm = b.governor.metrics() as any
          const ar = am.resetAt ?? Infinity
          const br = bm.resetAt ?? Infinity
          return ar - br
        })
        const account = sorted[0]
        this.bindings.set(session, account.id)
        return { account, bound: true, reason: "automatic" }
      }
      return undefined
    }
    const funded = eligible.filter((account) => account.governor.hasKnownCredits())
    const pool = funded.length > 0 ? funded : eligible
    pool.sort((a, b) => {
      const am: any = a.governor.metrics()
      const bm: any = b.governor.metrics()
      const aLoad = am.active + am.queued + (am.state === "READY" ? 0 : 1000)
      const bLoad = bm.active + bm.queued + (bm.state === "READY" ? 0 : 1000)
      return aLoad - bLoad || a.id.localeCompare(b.id)
    })
    const account = pool[0]
    this.bindings.set(session, account.id)
    return { account, bound: true, reason: "automatic" }
  }

  bindingsSnapshot() {
    return [...this.bindings.entries()].map(([session, account]) => ({ session, account }))
  }
}
