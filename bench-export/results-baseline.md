# Session Export Benchmark — Baseline (pre-change)

Env: node v24.3.0 / bun 1.3.14, Windows x64, `bun --smol`.
Harness: `bench-export/bench.ts` — deterministic synthetic sessions (seeded), realistic part mix
(text/reasoning/tool outputs; ~3% base64 screenshot blobs).

## Scales

| scale | messages | compact JSON | pretty JSON (today's output) |
|---|---|---|---|
| small | 20 | 0.08 MB | 0.09 MB |
| medium | 300 | 2.03 MB | 2.17 MB |
| large | 1500 | 9.56 MB | 10.27 MB |
| xl | 8000 | 55.57 MB | 59.38 MB |

## Measured (median)

### Today's path — `JSON.stringify(data, null, 2)` + Blob (all on UI thread)

| scale | stringify ms | blob ms | output |
|---|---|---|---|
| small | ~0 | ~0 | 0.09 MB |
| medium | 5 | 1 | 4.34 MB utf16 |
| large | 21 | 4 | 20.5 MB utf16 |
| xl | 134 | 13 | 118.8 MB utf16 alloc |

Note: isolated bun numbers understate real-world jank — in the Electron renderer the
118 MB UTF-16 string allocation triggers GC pressure spikes far worse than these medians,
and writes a ~60 MB+ file to disk uncompressed.

### Candidate operations (xl scale)

| op | ms | notes |
|---|---|---|
| compact stringify | 61 | 2.2x faster than pretty |
| structuredClone(data) (IPC-object proxy) | 198 | REJECTED — costs more than stringify itself |
| Buffer.from(str) (string-handoff encode proxy) | 13 | cheap; IPC string copy similar order |
| brotliSync q1 / q2 / q4 / q6 | 192 / 309 / 686 / 1406 | ratio 2.3–2.4x on this mix |
| brotli ASYNC (libuv threadpool) q2 | 375 | off-thread — zero UI/main-loop blocking |

## Decision (validated by numbers)

- **Compact stringify** everywhere: halves allocation, 2x faster.
- **Desktop**: renderer stringifies (~61ms @ xl), ships the STRING over IPC (not the object),
  main process runs ASYNC `brotliCompress` on the libuv threadpool (never blocks main loop or UI).
  Renderer blocking at xl: ~74ms vs ~147ms today (-50%), no giant retained string,
  disk artifact ~24 MB instead of ~59 MB.
- **Level policy**: rawLen < 1 MiB → quality 5 (negligible absolute cost, best small-file ratio);
  ≥ 1 MiB → quality 2 (q4/q6 cost 2-4.7x for <1% smaller output).
- **Web/PWA fallback**: compact JSON, plain `.json` (no native brotli available without new deps).
- Filename gets `.br` appended when compressed; download returns the actual saved filename so
  success toasts stay truthful.

## Post-change comparison

Re-run `bun --smol bench-export/bench.ts` after implementation — expected parity with baseline
(harness measures the same primitives the implementation uses); correctness verified via unit
tests + roundtrip checks.
