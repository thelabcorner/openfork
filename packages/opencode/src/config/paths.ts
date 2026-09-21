export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  CONFIG_BASENAME,
  CONFIG_BASENAMES,
  PROJECT_CONFIG_DIRNAME,
  PROJECT_CONFIG_DIRNAMES,
} from "@opencode-ai/core/storage-identity"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const serverFiles = Effect.fn("ConfigPaths.serverFiles")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  // `up()` emits start -> root and respects target order. Reverse the whole
  // sequence so ancestors are applied before descendants, and legacy files are
  // applied before canonical OpenFork files at each scope.
  return (
    yield* afs.up({
      targets: [
        `${CONFIG_BASENAME}.jsonc`,
        `${CONFIG_BASENAME}.json`,
        ...CONFIG_BASENAMES.filter((name) => name !== CONFIG_BASENAME).flatMap((name) => [
          `${name}.jsonc`,
          `${name}.json`,
        ]),
      ],
      start: directory,
      stop: worktree,
    })
  ).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [...PROJECT_CONFIG_DIRNAMES],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [...PROJECT_CONFIG_DIRNAMES],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

export function serverFilesInDirectory(dir: string) {
  return CONFIG_BASENAMES.flatMap((name) => fileInDirectory(dir, name))
}

export function isServerConfigDirectory(dir: string) {
  return PROJECT_CONFIG_DIRNAMES.includes(path.basename(dir) as (typeof PROJECT_CONFIG_DIRNAMES)[number])
}

export function projectConfigDirectory(root: string) {
  return path.join(root, PROJECT_CONFIG_DIRNAME)
}
