/// <reference types="bun" />
// All disposable build outputs, fixture databases, and report files live under
// this lane's own directory (script/sqlite-acp-cert-20261011/.work). Nothing in
// this harness reads or writes the user's OS temp tree, installed JetBrains
// runtime, or any production OpenFork database.

import { resolve } from "node:path"

export const laneRoot = resolve(import.meta.dir, "..")

export function workRoot(): string {
  return resolve(laneRoot, ".work")
}
