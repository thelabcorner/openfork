import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"
import {
  CONFIG_BASENAME,
  LEGACY_STORAGE_NAMESPACE,
  LEGACY_CONFIG_BASENAME,
  STORAGE_NAMESPACE,
  migrateLegacyDatabaseNames,
  migrateLegacyNamedFile,
  migrateLegacyStorageDirectory,
} from "./storage-identity"

const app = STORAGE_NAMESPACE
const legacyApp = LEGACY_STORAGE_NAMESPACE
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)
const legacy = {
  data: path.join(xdgData!, legacyApp),
  cache: path.join(xdgCache!, legacyApp),
  config: path.join(xdgConfig!, legacyApp),
  state: path.join(xdgState!, legacyApp),
}

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

// Persistence and configuration are fork-owned local contracts. Adopt legacy
// OpenCode-named roots once, moving only entries that do not already exist in
// the OpenFork destination. This makes migration idempotent and never overwrites
// state a newer OpenFork build has already created.
await migrateLegacyStorageDirectory(legacy.data, Path.data)
await migrateLegacyStorageDirectory(legacy.config, Path.config)
await migrateLegacyStorageDirectory(legacy.state, Path.state)
await migrateLegacyStorageDirectory(legacy.cache, Path.cache)
await migrateLegacyDatabaseNames(Path.data)
await migrateLegacyNamedFile(
  path.join(Path.config, `${LEGACY_CONFIG_BASENAME}.json`),
  path.join(Path.config, `${CONFIG_BASENAME}.json`),
)
await migrateLegacyNamedFile(
  path.join(Path.config, `${LEGACY_CONFIG_BASENAME}.jsonc`),
  path.join(Path.config, `${CONFIG_BASENAME}.jsonc`),
)
await migrateLegacyNamedFile(path.join(Path.log, "opencode.log"), path.join(Path.log, "openfork.log"))

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
