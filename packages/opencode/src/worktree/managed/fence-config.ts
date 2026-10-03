import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "node:path"
import { Effect, Schema } from "effect"

/**
 * Safe provisioning of the worktree-store activity-fence client configuration.
 *
 * worktree-store owns the frozen contract: `openfork-activity-fence.json` lives
 * in the control-plane root (a directory explicitly named `worktree-store`) and
 * names the exact expected OpenFork instance/realm plus an optional
 * authorization header value. OpenFork owns *provisioning* that file because
 * only OpenFork knows its own per-launch identity and credentials.
 *
 * Safety rules:
 * - the destination root must already exist and be an explicitly named
 *   `worktree-store` directory; provisioning never creates or guesses one;
 * - a file that cannot be strictly parsed as this exact config version is never
 *   overwritten (unknown state stays authoritative);
 * - a config naming a *different instance* is only rotated when that instance
 *   is provably not live (no descriptor whose process is still alive) or when
 *   the caller explicitly asserts takeover; this process's own instance may
 *   always rotate its own credentials;
 * - writes go through a sibling temp file plus an atomic replace with owner-only
 *   permissions where the platform permits, so a crash can never leave a
 *   truncated credential file;
 * - the authorization value is a secret: it is never echoed in an error, a
 *   message, or a returned detail.
 */
export const OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME = "openfork-activity-fence.json"
export const OPENFORK_ACTIVITY_FENCE_CONFIG_VERSION = 1 as const
export const WORKTREE_STORE_DIRECTORY_NAME = "worktree-store"
export const OPENFORK_SERVICE_DISCOVERY_SCHEMA_VERSION = 2

export class FenceConfigError extends Schema.TaggedErrorClass<FenceConfigError>()("ManagedWorktreeFenceConfigError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface OpenForkActivityFenceConfig {
  readonly configVersion: typeof OPENFORK_ACTIVITY_FENCE_CONFIG_VERSION
  readonly expectedInstanceID: string
  readonly expectedRealmID?: string
  readonly authorization?: string
}

export interface ProvisionOptions {
  readonly controlPlaneRoot: string
  readonly config: OpenForkActivityFenceConfig
  /**
   * Directory of OpenFork service descriptors used to prove that a config
   * naming another instance is stale before replacing it. Required whenever the
   * existing config names a different instance than the desired one.
   */
  readonly discoveryDirectory?: string
  /**
   * Explicit assertion that a mismatched config may be replaced even though its
   * instance still looks live. Defaults to false (fail closed).
   */
  readonly allowLiveInstanceTakeover?: boolean
}

export interface ProvisionResult {
  readonly state: "written" | "unchanged"
  readonly file: string
}

export type ProcessLivenessProbe = (pid: number) => boolean

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_IDENTITY_LENGTH = 256
const MAX_AUTHORIZATION_LENGTH = 4096
const REQUIRED_KEYS = ["configVersion", "expectedInstanceID"] as const
const OPTIONAL_KEYS = ["expectedRealmID", "authorization"] as const

function fenceError(code: string, message: string): FenceConfigError {
  return new FenceConfigError({ code, message })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value)
  )
}

/**
 * Strict parser mirroring the worktree-store reader. Only the documented keys
 * are accepted; messages name fields, never values, so a malformed
 * authorization credential can never reach a log or an error surface.
 */
export function parseOpenForkActivityFenceConfig(raw: unknown): OpenForkActivityFenceConfig {
  if (!isPlainRecord(raw)) {
    throw fenceError("config-invalid", "Activity-fence configuration must be a JSON object.")
  }
  for (const key of Object.keys(raw)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key) && !(OPTIONAL_KEYS as readonly string[]).includes(key)) {
      throw fenceError("config-invalid", "Activity-fence configuration contains an unknown key.")
    }
  }
  if (raw.configVersion !== OPENFORK_ACTIVITY_FENCE_CONFIG_VERSION) {
    throw fenceError("config-invalid", "Activity-fence configuration version is unsupported.")
  }
  if (!isBoundedString(raw.expectedInstanceID, MAX_IDENTITY_LENGTH)) {
    throw fenceError(
      "config-invalid",
      "Activity-fence configuration expectedInstanceID must be a non-empty bounded identity.",
    )
  }
  if (raw.expectedRealmID !== undefined && !isBoundedString(raw.expectedRealmID, MAX_IDENTITY_LENGTH)) {
    throw fenceError(
      "config-invalid",
      "Activity-fence configuration expectedRealmID must be a non-empty bounded identity when present.",
    )
  }
  if (raw.authorization !== undefined && !isBoundedString(raw.authorization, MAX_AUTHORIZATION_LENGTH)) {
    throw fenceError(
      "config-invalid",
      "Activity-fence configuration authorization must be a non-empty bounded header value when present.",
    )
  }
  return Object.freeze({
    configVersion: OPENFORK_ACTIVITY_FENCE_CONFIG_VERSION,
    expectedInstanceID: raw.expectedInstanceID,
    ...(raw.expectedRealmID === undefined ? {} : { expectedRealmID: raw.expectedRealmID }),
    ...(raw.authorization === undefined ? {} : { authorization: raw.authorization }),
  })
}

export function parseOpenForkActivityFenceConfigText(text: string): OpenForkActivityFenceConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw fenceError("config-invalid", "Activity-fence configuration is not valid JSON.")
  }
  return parseOpenForkActivityFenceConfig(parsed)
}

export function serializeOpenForkActivityFenceConfig(config: OpenForkActivityFenceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * The control-plane root must be an explicitly named `worktree-store` directory
 * so a config can never land in a filesystem root or an ambiguous location.
 */
export function openForkActivityFenceConfigPath(controlPlaneRoot: string): string {
  if (typeof controlPlaneRoot !== "string" || controlPlaneRoot.length === 0 || !path.isAbsolute(controlPlaneRoot)) {
    throw fenceError("config-path-invalid", "Activity-fence configuration root must be an absolute path.")
  }
  const resolved = path.resolve(controlPlaneRoot)
  if (path.basename(resolved).toLocaleLowerCase("en-US") !== WORKTREE_STORE_DIRECTORY_NAME) {
    throw fenceError(
      "config-path-invalid",
      `Activity-fence configuration root must be an explicitly named ${WORKTREE_STORE_DIRECTORY_NAME} directory.`,
    )
  }
  if (path.dirname(resolved) === resolved) {
    throw fenceError("config-path-invalid", "Refusing to use a filesystem root as the activity-fence configuration root.")
  }
  return path.join(resolved, OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME)
}

/**
 * Compose the authorization header the worktree-store fence adapter will send,
 * from this launch's desktop/server credentials. Absent credentials mean an
 * unauthenticated server, so no header is provisioned.
 */
export function openForkActivityFenceAuthorization(env: Record<string, string | undefined>): string | undefined {
  const username = env["OPENCODE_SERVER_USERNAME"]?.trim()
  const password = env["OPENCODE_SERVER_PASSWORD"]
  if (!username || !password) return undefined
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

export function defaultProcessLivenessProbe(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Prove whether the instance named by an existing config still looks live, by
 * scanning published service descriptors and probing the recorded process. Any
 * unreadable descriptor is ignored; only a positively live process blocks
 * rotation.
 */
export function configOwnerLooksLive(
  fs: FSUtil.Interface,
  input: {
    readonly discoveryDirectory: string
    readonly instanceID: string
    readonly isAlive?: ProcessLivenessProbe
  },
): Effect.Effect<boolean> {
  const isAlive = input.isAlive ?? defaultProcessLivenessProbe
  return Effect.gen(function* () {
    const entries = yield* fs
      .readDirectoryEntries(input.discoveryDirectory)
      .pipe(Effect.orElseSucceed((): FSUtil.DirEntry[] => []))
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue
      const text = yield* fs.readFileStringSafe(path.join(input.discoveryDirectory, entry.name)).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) continue
      let value: unknown
      try {
        value = JSON.parse(text) as unknown
      } catch {
        continue
      }
      if (!isPlainRecord(value)) continue
      if (value.schemaVersion !== OPENFORK_SERVICE_DISCOVERY_SCHEMA_VERSION) continue
      if (value.instanceID !== input.instanceID) continue
      if (typeof value.processID === "number" && isAlive(value.processID)) return true
    }
    return false
  })
}

/**
 * Provision the config atomically.
 *
 * `written` means a new config replaced an existing same-contract file;
 * `unchanged` means the exact desired bytes were already present, so a repeat
 * launch is a no-op. Anything else fails closed:
 * - an unparseable existing file is never replaced;
 * - a config naming a different instance is only replaced when that instance is
 *   provably not live, or when the caller explicitly allows takeover.
 */
export function provisionOpenForkActivityFenceConfig(
  fs: FSUtil.Interface,
  options: ProvisionOptions,
): Effect.Effect<ProvisionResult, FenceConfigError> {
  return Effect.gen(function* () {
    const root = yield* Effect.try({
      try: () => {
        if (
          typeof options.controlPlaneRoot !== "string" ||
          options.controlPlaneRoot.length === 0 ||
          !path.isAbsolute(options.controlPlaneRoot)
        ) {
          throw fenceError("config-path-invalid", "Activity-fence configuration root must be an absolute path.")
        }
        return path.resolve(options.controlPlaneRoot)
      },
      catch: (cause) => (cause instanceof FenceConfigError ? cause : fenceError("config-path-invalid", "invalid root")),
    })
    const file = yield* Effect.try({
      try: () => openForkActivityFenceConfigPath(root),
      catch: (cause) => (cause instanceof FenceConfigError ? cause : fenceError("config-path-invalid", "invalid root")),
    })
    const desired = yield* Effect.try({
      try: () => serializeOpenForkActivityFenceConfig(parseOpenForkActivityFenceConfig(options.config)),
      catch: (cause) => (cause instanceof FenceConfigError ? cause : fenceError("config-invalid", "invalid config")),
    })

    if (!(yield* fs.isDir(root))) {
      return yield* fenceError("config-root-missing", `the worktree-store control-plane root does not exist: ${root}.`)
    }

    const existing = yield* fs.readFileStringSafe(file).pipe(
      Effect.catch(() =>
        Effect.fail(
          fenceError("config-unreadable", "an existing activity-fence configuration could not be read."),
        ),
      ),
    )
    if (existing !== undefined) {
      const parsed = yield* Effect.try({
        try: () => parseOpenForkActivityFenceConfigText(existing),
        catch: () =>
          fenceError(
            "config-unreadable",
            "an existing activity-fence configuration could not be strictly parsed; refusing to overwrite unknown state.",
          ),
      })
      if (serializeOpenForkActivityFenceConfig(parsed) === desired) return { state: "unchanged", file } as const

      if (parsed.expectedInstanceID !== options.config.expectedInstanceID) {
        if (options.allowLiveInstanceTakeover !== true) {
          const discoveryDirectory = options.discoveryDirectory
          if (discoveryDirectory === undefined || discoveryDirectory.length === 0) {
            return yield* fenceError(
              "config-owner-unverifiable",
              "an existing activity-fence configuration names a different instance and no service-discovery directory is available to prove it is stale.",
            )
          }
          const live = yield* configOwnerLooksLive(fs, {
            discoveryDirectory: path.resolve(discoveryDirectory),
            instanceID: parsed.expectedInstanceID,
          })
          if (live) {
            return yield* fenceError(
              "config-owned-by-live-instance",
              "an existing activity-fence configuration names a different OpenFork instance that still looks live; refusing to replace it.",
            )
          }
        }
      }
    }

    const temporary = `${file}.${process.pid}.tmp`
    yield* fs.writeWithDirs(temporary, desired, 0o600).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          fenceError("config-unwritable", `the activity-fence configuration could not be staged (${cause.message}).`),
        ),
      ),
    )
    yield* fs.copyFileAtomic(temporary, file).pipe(
      Effect.catch((cause) => {
        return Effect.gen(function* () {
          yield* fs.remove(temporary).pipe(Effect.ignore)
          return yield* fenceError(
            "config-unwritable",
            `the activity-fence configuration could not be committed (${cause.message}).`,
          )
        })
      }),
    )
    yield* fs.remove(temporary).pipe(Effect.ignore)
    return { state: "written", file } as const
  })
}

/** Safe projection for diagnostics: the credential never leaves as a value. */
export function redactedOpenForkActivityFenceConfig(config: OpenForkActivityFenceConfig): Record<string, unknown> {
  return {
    configVersion: config.configVersion,
    expectedInstanceID: config.expectedInstanceID,
    ...(config.expectedRealmID === undefined ? {} : { expectedRealmID: config.expectedRealmID }),
    ...(config.authorization === undefined ? {} : { authorization: "[redacted]" }),
  }
}

export * as ManagedFenceConfig from "./fence-config"
