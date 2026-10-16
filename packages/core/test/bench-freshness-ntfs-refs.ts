/**
 * Filesystem freshness harness: NTFS vs ReFS create/rename/delete visibility
 * through the isolated `Everything IPC (OpenFork-SDK3)` instance.
 *
 * Historical ReFS numbers (~36ms create, ~29-30ms rename, ~90ms delete) are
 * one-environment only and RETIRED until remeasured. This harness remeasures
 * them separately per filesystem with an explicit method note.
 *
 * METHOD + RESOLUTION LIMIT (read before quoting any number): visibility is
 * probed by polling searchCandidatePage in a tight loop. Each poll is a full
 * SDK3 IPC round trip, so the resolution floor is one provider query latency
 * (typically tens to low-hundreds of ms on this machine). A reported value is
 * an UPPER BOUND on index-freshness latency (create -> first poll that sees
 * the row), not a kernel event timestamp. Sub-poll precision (e.g. the retired
 * ~29ms rename figure) is NOT resolvable through this public API; claiming it
 * would require ipc-runtime-internal per-frame hooks.
 *
 * Run from packages/core:
 *
 *   bun test/bench-freshness-ntfs-refs.ts
 *
 * Roots (verified out-of-band: C: NTFS, W: ReFS via Get-Volume):
 *   NTFS: C:\Users\slooshied\AppData\Local\Temp\openfork-fresh-ntfs
 *   ReFS: W:\Temp\openfork-fresh-refs
 */

import { Effect } from "effect"
import { searchCandidatePage } from "../src/search/everything"

const NTFS_ROOT = "C:\\Users\\slooshied\\AppData\\Local\\Temp\\openfork-fresh-ntfs"
const REFS_ROOT = "W:\\Temp\\openfork-fresh-refs"
const ROUNDS = 5
const DEADLINE_MS = 30_000
const PAGE_COUNT = 8

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.floor(Math.random() * 0xffffff).toString(36)

async function visible(root: string, name: string): Promise<boolean> {
  const res = await Effect.runPromise(searchCandidatePage({ root, query: name, count: PAGE_COUNT }))
  if (res.status !== "measured") return false
  return res.paths.some((p) => p.path === name)
}

/** Poll until present (want=true) or absent (want=false). Returns elapsed ms or -1 on deadline. */
async function poll(root: string, name: string, want: boolean): Promise<{ ms: number; polls: number; timedOut: boolean }> {
  const t0 = performance.now()
  let polls = 0
  for (;;) {
    polls++
    const seen = await visible(root, name).catch(() => false)
    if (seen === want) return { ms: performance.now() - t0, polls, timedOut: false }
    if (performance.now() - t0 > DEADLINE_MS) return { ms: performance.now() - t0, polls, timedOut: true }
    await sleep(5)
  }
}

async function precheck(root: string, label: string): Promise<boolean> {
  await Bun.write(`${root}\\__precheck__.txt`, "precheck")
  const r = await poll(root, "__precheck__.txt", true)
  await Bun.$`rm -f ${root}/__precheck__.txt`.quiet().catch(() => {})
  console.log(JSON.stringify({ part: "precheck", fs: label, root, visibleMs: Number(r.ms.toFixed(1)), polls: r.polls, covered: !r.timedOut }))
  return !r.timedOut
}

async function benchFs(root: string, label: string) {
  const { mkdir, writeFile, rename, unlink } = await import("node:fs/promises")
  await mkdir(root, { recursive: true })
  console.log(JSON.stringify({ part: "fs-start", fs: label, root, rounds: ROUNDS }))
  const creates: number[] = []
  const renames: number[] = []
  const deletes: number[] = []
  let faults = 0
  for (let i = 0; i < ROUNDS; i++) {
    const tag = `ofk${rand()}${i}`
    const a = `${tag}a.txt`
    const b = `${tag}b.txt`
    await writeFile(`${root}\\${a}`, "freshness")
    const c = await poll(root, a, true)
    if (c.timedOut) {
      faults++
      console.log(JSON.stringify({ part: "fault", fs: label, op: "create", round: i, detail: "deadline without visibility" }))
    } else creates.push(c.ms)
    await rename(`${root}\\${a}`, `${root}\\${b}`)
    const rn = await poll(root, b, true)
    if (rn.timedOut) {
      faults++
      console.log(JSON.stringify({ part: "fault", fs: label, op: "rename-new-visible", round: i, detail: "deadline without visibility" }))
    } else renames.push(rn.ms)
    await unlink(`${root}\\${b}`)
    const d = await poll(root, b, false)
    if (d.timedOut) {
      faults++
      console.log(JSON.stringify({ part: "fault", fs: label, op: "delete-gone", round: i, detail: "deadline without disappearance" }))
    } else deletes.push(d.ms)
    console.log(
      JSON.stringify({
        part: "round",
        fs: label,
        round: i,
        createMs: Number(c.ms.toFixed(1)),
        renameMs: Number(rn.ms.toFixed(1)),
        deleteMs: Number(d.ms.toFixed(1)),
      }),
    )
  }
  const med = (v: number[]) => (v.length === 0 ? -1 : v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)]!)
  console.log(
    JSON.stringify({
      part: "fs-done",
      fs: label,
      createMedianMs: med(creates),
      renameMedianMs: med(renames),
      deleteMedianMs: med(deletes),
      samples: { create: creates.length, rename: renames.length, delete: deletes.length },
      faults,
    }),
  )
}

const ntfsCovered = await precheck(NTFS_ROOT, "NTFS")
const refsCovered = await precheck(REFS_ROOT, "ReFS")
if (ntfsCovered) await benchFs(NTFS_ROOT, "NTFS")
else console.log(JSON.stringify({ part: "skipped", fs: "NTFS", reason: "root not covered by Everything index" }))
if (refsCovered) await benchFs(REFS_ROOT, "ReFS")
else console.log(JSON.stringify({ part: "skipped", fs: "ReFS", reason: "root not covered by Everything index" }))
process.exit(0)
