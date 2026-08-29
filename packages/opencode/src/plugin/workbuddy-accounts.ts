import { createHash, randomBytes } from "crypto"
import { homedir, tmpdir } from "os"
import { basename, join } from "path"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { WorkBuddyEntitlementGovernor, type EntitlementState } from "./workbuddy-governor"

/** Credential shape written by WorkBuddy/CodeBuddy desktop or OAuth enrollment. */
export type Credential = {
  path: string
  accessToken: string
  refreshToken: string
  domain: string
  uid: string
  enterpriseId: string
  expiresAt: number
  nickname: string
  /** Non-secret enrollment generation; bearer rotation does not change it. */
  enrollmentEpoch?: string
}

export type AccountCatalog = {
  ids: Set<string>
  updatedAt: number
}

export type WorkBuddyAccount = {
  id: string
  uid: string
  nickname: string
  realm: string
  authPath: string
  credential: Credential
  governor: WorkBuddyEntitlementGovernor
  catalog?: AccountCatalog
  mtime: number
  source: "vault" | "desktop-import"
}

/**
 * Human-readable per-account labels for account-qualified model names.
 *
 * Account ids are stable `wb-<uid-slug>-<hash>` strings. They are the correct
 * routing key but a useless picker label: every account looks like
 * `wb-85c380ab-b3d4-4cc7-a9af--149f497950`. The Tencent `nickname` is the
 * user-facing identity and in practice is usually the account email.
 *
 * Nicknames are user-editable and not guaranteed unique or non-empty, so a
 * missing nickname falls back to the UID and a duplicated one gets a short id
 * tail to keep two accounts distinguishable in the model selector.
 *
 * Shared by the model picker (workbuddy.ts's `provider.models()`) and the
 * Limits pane's WorkBuddy quota adapter (quota/providers/workbuddy.ts) so an
 * account is named identically in both places. Takes the minimal shape
 * rather than the full `WorkBuddyAccount` so the quota adapter — which only
 * ever reads `Credential[]` from the vault, never the full governor-backed
 * account object — doesn't need to construct one just to get a label.
 */
export function accountLabels(accounts: Array<Pick<WorkBuddyAccount, "id" | "uid" | "nickname">>): Map<string, string> {
  const base = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const account of accounts) {
    const label = account.nickname.trim() || account.uid.trim() || account.id
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

export type AccountRegistryOptions = {
  /** Test-only or embedding override for current desktop files. */
  authFiles?: string[]
  /** Account-local entitlement-state directory. */
  persistenceDir?: string
  /** OpenFork-owned credential vault. */
  vault?: AccountVault
}

export type StoredCredential = Omit<Credential, "path"> & {
  schema: 1
  enrolledAt: number
  importedFrom?: string
}

function authDirs(): string[] {
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth"]
  if (process.platform === "darwin") return [join(homedir(), "Library", "Application Support", ...rel)]
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return [join(base, ...rel)]
  }
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return [join(base, ...rel)]
}

function candidateFiles(explicit?: string[]): string[] {
  if (explicit) return [...explicit]
  const override = process.env.WORKBUDDY_AUTH_FILE
  if (override) return [override]
  const out: string[] = []
  for (const dir of authDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.toLowerCase().endsWith(".info")) out.push(join(dir, f))
      }
    } catch {
      // directory absent or unreadable
    }
  }
  return out
}

export function parseCredentialFile(path: string): Credential | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    const auth = parsed?.auth ?? parsed
    if (typeof auth?.accessToken !== "string" || !auth.accessToken) return undefined
    const account = parsed?.account ?? parsed
    return {
      path,
      accessToken: auth.accessToken,
      refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
      domain: typeof auth.domain === "string" && auth.domain ? auth.domain : "www.workbuddy.ai",
      uid: typeof account.uid === "string" ? account.uid : "",
      enterpriseId: typeof account.enterpriseId === "string" ? account.enterpriseId : "",
      expiresAt: typeof auth.expiresAt === "number" ? auth.expiresAt : 0,
      nickname: typeof account.nickname === "string" ? account.nickname : "",
      enrollmentEpoch: typeof parsed?.enrollmentEpoch === "string" ? parsed.enrollmentEpoch : undefined,
    }
  } catch {
    return undefined
  }
}

/** Stable identity: prefer Tencent UID; fall back to realm/tenant identity. */
export function stableAccountIdentity(credential: Credential): string {
  const durable = credential.uid
    ? `uid:${credential.uid}`
    : `realm:${credential.domain}|enterprise:${credential.enterpriseId}|file:${basename(credential.path)}`
  const hash = createHash("sha256").update(`${credential.domain}|${credential.enterpriseId}|${durable}`).digest("hex").slice(0, 10)
  // The human-readable label must not change the durable identity. Nicknames
  // can be edited by Tencent; UID + realm + enterprise are the stable key.
  const label = (credential.uid || credential.nickname || basename(credential.path, ".info"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "account"
  return `wb-${label}-${hash}`
}

function accountFileName(credential: Credential): string {
  // The stable identity includes realm and enterprise identity, preventing a
  // Global/CN same-UID collision on disk.
  return `workbuddy-${stableAccountIdentity(credential)}.json`
}

function persistenceFile(dir: string, accountId: string): string {
  return join(dir, `${accountId}-entitlement.json`)
}

/**
 * OpenFork-owned durable credential vault.
 *
 * The official desktop `workbuddy-desktop.info` is an import source only. This
 * vault is the authoritative multi-account store, so switching the desktop UI
 * from A to B cannot remove A from OpenFork's account pool.
 */
export class AccountVault {
  readonly root: string
  readonly accountsDir: string

  constructor(root = join(homedir(), ".workbuddy-ai", "workbuddy")) {
    this.root = root
    this.accountsDir = join(root, "accounts")
    mkdirSync(this.accountsDir, { recursive: true })
  }

  private pathFor(credential: Credential): string {
    return join(this.accountsDir, accountFileName(credential))
  }

  private storedToCredential(path: string, stored: StoredCredential): Credential {
    return {
      path,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      domain: stored.domain,
      uid: stored.uid,
      enterpriseId: stored.enterpriseId,
      expiresAt: stored.expiresAt,
      nickname: stored.nickname,
      enrollmentEpoch: stored.enrollmentEpoch,
    }
  }

  list(): Credential[] {
    const result: Credential[] = []
    try {
      for (const name of readdirSync(this.accountsDir)) {
        if (!/^workbuddy-[^/\\]+\.json$/i.test(name)) continue
        const path = join(this.accountsDir, name)
        try {
          const stored = JSON.parse(readFileSync(path, "utf8")) as StoredCredential
          if (stored?.schema !== 1 || !stored.accessToken) continue
          result.push(this.storedToCredential(path, stored))
        } catch {
          // Ignore malformed account records; one bad account must not hide others.
        }
      }
    } catch {
      // vault is empty/unavailable
    }
    return result
  }

  /** Persist one account, replacing only that account's own record. */
  save(credential: Credential, importedFrom?: string): Credential {
    const path = credential.path.startsWith(this.accountsDir) ? credential.path : this.pathFor(credential)
    const stored: StoredCredential = {
      schema: 1,
      enrolledAt: Date.now(),
      importedFrom,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      domain: credential.domain,
      uid: credential.uid,
      enterpriseId: credential.enterpriseId,
      expiresAt: credential.expiresAt,
      nickname: credential.nickname,
      enrollmentEpoch: credential.enrollmentEpoch,
    }
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 })
    try {
      renameSync(temp, path)
    } catch {
      // Windows may reject replacing an existing file. The target is this one
      // account record only; fall back to a direct replacement.
      writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 })
      try { unlinkSync(temp) } catch { /* no-op */ }
    }
    return { ...credential, path }
  }

  /** Import the current desktop account into the vault without switching it. */
  importCredential(credential: Credential, importedFrom = credential.path): Credential {
    if (!credential.uid) throw new Error("WorkBuddy account import requires Tencent UID")
    const canonicalPath = this.pathFor(credential)
    const existing = this.list().find((item) => stableAccountIdentity(item) === stableAccountIdentity(credential))
    if (existing) {
      // Import/update never creates a new entitlement epoch. Migrate legacy
      // UID-only filenames to the stable identity filename when encountered.
      const saved = this.save({ ...credential, path: canonicalPath, enrollmentEpoch: existing.enrollmentEpoch }, importedFrom)
      if (existing.path !== canonicalPath) {
        try { unlinkSync(existing.path) } catch { /* best effort */ }
      }
      return saved
    }
    return this.save({
      ...credential,
      path: canonicalPath,
      enrollmentEpoch: credential.enrollmentEpoch ?? randomBytes(16).toString("hex"),
    }, importedFrom)
  }

  remove(accountId: string): boolean {
    const credential = this.list().find((item) => stableAccountIdentity(item) === accountId)
    if (!credential) return false
    // Remove only the exact enrolled account file selected by stable identity.
    try {
      unlinkSync(credential.path)
      return true
    } catch {
      return false
    }
  }
}

/** OAuth realm configuration. */
export type WorkBuddyOAuthRealm = "global" | "cn"

export function oauthBackend(realm: WorkBuddyOAuthRealm): string {
  return realm === "cn" ? "https://copilot.tencent.com" : "https://www.workbuddy.ai"
}

function envelopeData(body: any): any {
  return body?.data ?? body
}

function setCookies(target: Map<string, string>, response: Response) {
  const values = typeof (response.headers as any).getSetCookie === "function"
    ? (response.headers as any).getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean)
  for (const raw of values) {
    const pair = String(raw).split(";", 1)[0]
    const index = pair.indexOf("=")
    if (index > 0) target.set(pair.slice(0, index), pair.slice(index + 1))
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
}

type OAuthFlow = {
  realm: WorkBuddyOAuthRealm
  state: string
  url: string
  cookies: Map<string, string>
  expiresAt: number
}

const oauthFlows = new Map<string, OAuthFlow>()

/**
 * Start Tencent's normal OAuth flow. No account is created; the user must
 * authorize in the returned browser URL. Each flow has isolated cookies.
 */
export async function startWorkBuddyOAuth(realm: WorkBuddyOAuthRealm = "global"): Promise<{ url: string; state: string; expiresAt: number }> {
  const cookies = new Map<string, string>()
  const base = oauthBackend(realm)
  const origin = realm === "cn" ? "https://www.codebuddy.cn" : "https://www.workbuddy.ai"
  const response = await fetch(`${base}/v2/plugin/auth/state?platform=CLI`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: origin,
      Referer: `${origin}/`,
      "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    },
    body: "{}",
  })
  setCookies(cookies, response)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.code && body.code !== 0) throw new Error(`WorkBuddy OAuth state failed (${response.status})`)
  const data = envelopeData(body)
  const state = String(data?.state ?? "")
  const url = String(data?.authUrl ?? data?.url ?? "")
  if (!state || !url) throw new Error("WorkBuddy OAuth response omitted state or auth URL")
  const expiresAt = Date.now() + 5 * 60_000
  oauthFlows.set(state, { realm, state, url, cookies, expiresAt })
  return { url, state, expiresAt }
}

/** Poll one OAuth flow once; the host/UI should call this until it succeeds. */
export async function pollWorkBuddyOAuth(state: string, vault: AccountVault): Promise<
  | { status: "pending"; message: string }
  | { status: "success"; credential: Credential }
> {
  const flow = oauthFlows.get(state)
  if (!flow || Date.now() >= flow.expiresAt) {
    oauthFlows.delete(state)
    throw new Error("WorkBuddy OAuth flow expired; start it again")
  }
  const base = oauthBackend(flow.realm)
  const headers: Record<string, string> = { Accept: "application/json" }
  const cookie = cookieHeader(flow.cookies)
  if (cookie) headers.Cookie = cookie
  const response = await fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { headers })
  setCookies(flow.cookies, response)
  const body = await response.json().catch(() => ({}))
  const code = body?.code
  if (!response.ok && response.status >= 500) throw new Error(`WorkBuddy OAuth token poll failed (${response.status})`)
  if (code && code !== 0) return { status: "pending", message: body?.msg ?? "waiting for login" }
  const token = envelopeData(body)
  if (!token?.accessToken) return { status: "pending", message: "waiting for login" }

  let account: any = {}
  const accountResponse = await fetch(`${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    headers: { ...headers, Authorization: `Bearer ${token.accessToken}` },
  })
  const accountBody = await accountResponse.json().catch(() => ({}))
  if (accountResponse.ok && (!accountBody?.code || accountBody.code === 0)) account = envelopeData(accountBody) ?? {}

  const credential: Credential = {
    path: "",
    accessToken: String(token.accessToken),
    refreshToken: String(token.refreshToken ?? ""),
    domain: String(token.domain ?? (flow.realm === "cn" ? "www.codebuddy.cn" : "www.workbuddy.ai")),
    uid: String(account.uid ?? token.uid ?? ""),
    enterpriseId: String(account.enterpriseId ?? token.enterpriseId ?? ""),
    expiresAt: Date.now() + (Number(token.expiresIn) || 3600) * 1000,
    nickname: String(account.nickname ?? token.nickname ?? ""),
    enrollmentEpoch: randomBytes(16).toString("hex"),
  }
  if (!credential.uid) throw new Error("WorkBuddy OAuth completed without Tencent UID")
  const saved = vault.save(credential)
  oauthFlows.delete(state)
  return { status: "success", credential: saved }
}

/**
 * Discovers all enrolled accounts plus the currently active desktop login.
 * Desktop import is additive and never replaces an enrolled credential unless
 * the user explicitly calls importCurrentDesktopAccount(). This prevents a
 * stale or switched `.info` file from overwriting a refreshed vault token.
 */
export class AccountRegistry {
  private readonly explicitFiles?: string[]
  private readonly persistenceDir: string
  readonly vault: AccountVault
  private accountsById = new Map<string, WorkBuddyAccount>()
  private lastScan: string[] = []

  constructor(options: AccountRegistryOptions = {}) {
    this.explicitFiles = options.authFiles
    this.persistenceDir = options.persistenceDir ?? join(tmpdir(), "opencode-workbuddy-accounts")
    this.vault = options.vault ?? new AccountVault()
    mkdirSync(this.persistenceDir, { recursive: true })
  }

  private accountFrom(credential: Credential, source: WorkBuddyAccount["source"], mtime: number): WorkBuddyAccount {
    const id = stableAccountIdentity(credential)
    const prior = this.accountsById.get(id)
    if (prior) {
      // Vault credentials are authoritative and long-lived. A registry scan
      // must not replace the object captured by an active transport; refreshes
      // mutate this object and persist it to the vault instead.
      if (prior.source === "vault") return prior
      Object.assign(prior.credential, credential)
      prior.authPath = credential.path
      prior.uid = credential.uid
      prior.nickname = credential.nickname
      prior.realm = credential.domain
      prior.mtime = mtime
      prior.source = source
      return prior
    }
    return {
      id,
      uid: credential.uid,
      nickname: credential.nickname,
      realm: credential.domain,
      authPath: credential.path,
      credential,
      governor: new WorkBuddyEntitlementGovernor({ persistenceFile: persistenceFile(this.persistenceDir, id) }),
      mtime,
      source,
    }
  }

  discover(): WorkBuddyAccount[] {
    const next = new Map<string, WorkBuddyAccount>()

    // Vault is authoritative. Refreshes and OAuth-enrolled accounts survive
    // official desktop sign-out/account switching.
    for (const credential of this.vault.list()) {
      const id = stableAccountIdentity(credential)
      const prior = this.accountsById.get(id)
      const account = this.accountFrom(credential, "vault", prior?.mtime ?? 0)
      next.set(id, account)
    }

    // Import current desktop login additively if it is not already enrolled.
    const paths = candidateFiles(this.explicitFiles)
    this.lastScan = paths
    const desktopCandidates: Array<{ path: string; credential: Credential; mtime: number }> = []
    for (const path of paths) {
      const credential = parseCredentialFile(path)
      if (!credential || !credential.uid) continue
      let mtime = 0
      try { mtime = statSync(path).mtimeMs } catch { /* best effort */ }
      desktopCandidates.push({ path, credential, mtime })
    }
    // If a test harness or future desktop build exposes duplicate .info files,
    // import the newest copy first; the vault still remains authoritative after
    // this one-time import.
    desktopCandidates.sort((a, b) => b.mtime - a.mtime)
    for (const candidate of desktopCandidates) {
      const id = stableAccountIdentity(candidate.credential)
      if (next.has(id)) continue
      const enrolled = this.vault.importCredential(candidate.credential, candidate.path)
      next.set(id, this.accountFrom(enrolled, "desktop-import", candidate.mtime))
    }

    this.accountsById = next
    return [...next.values()]
  }

  /** Explicitly import the currently authenticated desktop identity. */
  importCurrentDesktopAccount(path?: string): WorkBuddyAccount {
    const source = path ?? candidateFiles(this.explicitFiles)[0]
    if (!source) throw new Error("No current WorkBuddy desktop .info login found")
    const credential = parseCredentialFile(source)
    if (!credential) throw new Error("Current WorkBuddy desktop credential is invalid")
    if (!credential.uid) throw new Error("Current WorkBuddy desktop credential has no Tencent UID")
    const saved = this.vault.importCredential(credential, source)
    const account = this.accountFrom(saved, "desktop-import", Date.now())
    this.accountsById.set(account.id, account)
    return account
  }

  /** Add one OAuth-enrolled credential; explicit re-enrollment creates a new epoch. */
  enrollCredential(credential: Credential): WorkBuddyAccount {
    if (!credential.uid) throw new Error("WorkBuddy enrollment requires Tencent UID")
    const existing = this.vault.list().find((item) => stableAccountIdentity(item) === stableAccountIdentity(credential))
    const saved = this.vault.save({
      ...credential,
      path: existing?.path ?? credential.path,
      enrollmentEpoch: credential.enrollmentEpoch ?? randomBytes(16).toString("hex"),
    })
    const account = this.accountFrom(saved, "vault", Date.now())
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "vault"
    this.accountsById.set(account.id, account)
    return account
  }

  /** Persist only this account's latest token pair/expiry. */
  persistCredential(account: WorkBuddyAccount) {
    const saved = account.source === "vault"
      ? this.vault.save(account.credential)
      : this.vault.importCredential(account.credential, account.authPath)
    // Preserve object identity for transports that already captured the
    // credential reference during a concurrent generation.
    Object.assign(account.credential, saved)
    account.authPath = saved.path
    account.source = "vault"
  }

  all(): WorkBuddyAccount[] { return this.discover() }

  get(id: string): WorkBuddyAccount | undefined {
    this.discover()
    return this.accountsById.get(id)
  }

  remove(id: string): boolean {
    const account = this.get(id)
    if (!account) return false
    const removed = this.vault.remove(id)
    if (removed) this.accountsById.delete(id)
    return removed
  }

  scanned(): string[] { return [...this.lastScan] }

  snapshot() {
    return this.all().map((account) => ({
      id: account.id,
      uid: account.uid,
      nickname: account.nickname,
      realm: account.realm,
      authPath: account.authPath,
      source: account.source,
      catalog: account.catalog ? [...account.catalog.ids] : [],
      governor: account.governor.metrics(),
    }))
  }
}

type RouterOptions = { registry: AccountRegistry }

export type AccountSelection = {
  account: WorkBuddyAccount
  bound: boolean
  reason: "explicit" | "affinity" | "automatic"
}

/**
 * Session-level account router.
 *
 * Automatic routing binds once and never moves a session. An explicit account
 * choice (an account-qualified model id, or `X-WorkBuddy-Account`) rebinds it —
 * that is a deliberate user action, not account hopping.
 */
export class AccountRouter {
  private readonly registry: AccountRegistry
  private bindings = new Map<string, string>()

  constructor(options: RouterOptions) { this.registry = options.registry }

  bind(session: string, accountId: string): WorkBuddyAccount | undefined {
    const account = this.registry.get(accountId)
    if (!account) return undefined
    this.bindings.set(session, account.id)
    return account
  }

  unbind(session: string) { this.bindings.delete(session) }
  binding(session: string): string | undefined { return this.bindings.get(session) }

  select(session: string, requestedModel: string, explicitAccountId?: string): AccountSelection | undefined {
    const accounts = this.registry.all()

    // Explicit user intent is checked FIRST and rebinds the session.
    //
    // Session affinity exists to stop *automatic* account hopping — a session
    // must not silently drift from A to B because A hit a rate limit. It was
    // never meant to override the user picking a different account in the model
    // selector. Checking affinity first made every account-qualified model id
    // (`hy4-preview@wb-...`) a no-op once the session was already bound, so
    // selecting account B kept serving account A (and A's rate limit).
    if (explicitAccountId) {
      const account = accounts.find((item) => item.id === explicitAccountId)
      if (!account) return undefined
      this.bindings.set(session, account.id)
      return { account, bound: true, reason: "explicit" }
    }

    // Only fall back to affinity when the user did not name an account.
    const existing = this.bindings.get(session)
    if (existing) {
      const account = accounts.find((item) => item.id === existing)
      if (!account) return undefined
      return { account, bound: true, reason: "affinity" }
    }

    const eligible = accounts.filter((account) => {
      const state = account.governor.metrics().state as EntitlementState
      if (state === "QUOTA_EXHAUSTED") return false
      if (!account.governor.canAdmitModel(requestedModel)) return false
      if (account.catalog && !account.catalog.ids.has(requestedModel)) return false
      return true
    })
    if (!eligible.length) return undefined
    eligible.sort((a, b) => {
      const am = a.governor.metrics()
      const bm = b.governor.metrics()
      const aLoad = am.active + am.queued + (am.state === "READY" ? 0 : 1000)
      const bLoad = bm.active + bm.queued + (bm.state === "READY" ? 0 : 1000)
      return aLoad - bLoad || a.id.localeCompare(b.id)
    })
    const account = eligible[0]
    this.bindings.set(session, account.id)
    return { account, bound: true, reason: "automatic" }
  }

  bindingsSnapshot() { return [...this.bindings.entries()].map(([session, account]) => ({ session, account })) }
}
