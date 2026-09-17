- Prioritize stability, then simplicity, then measurement overhead.
- Use Playwright for scenario control, isolation, and completion checks.
- Use Chrome Performance traces for generic browser profiling.
- Use Electron `contentTracing` for packaged multi-process profiling.
- Keep custom probes only for product-specific measurements.
- Do not duplicate measurements across the harness, probes, and traces.
- Run benchmarks serially to avoid cross-test contention.
- Run benchmarks against production builds.
- Keep detailed profiling opt-in when it changes workload behavior.
- Preserve raw diagnostic data or use lossless representations.
- Do not enforce machine-dependent performance thresholds.
- Assert scenario completion and metric collection only.
- Keep normal test discovery free of manual benchmarks.
- Match the benchmark state to the reported trigger. Idle startup is not a proxy
  for several simultaneously working sessions, and one visible timeline is not
  a proxy for the complete desktop/sidebar workload.
- For cross-layer desktop regressions, prefer an Electron `contentTracing`
  scenario that includes the real sidecar/server path, then use narrower browser
  and microbenchmarks to attribute the mechanism.
- Record architectural counters alongside timings when relevant: instance
  creations/reasons, message-history hydration requests, active/queued requests,
  event/update rates, listener counts, renderer long tasks, and retained memory.
- Closure requires the negative invariant under the triggering workload (for
  example zero implicit instances or zero metric-only history fetches), not only
  an improved median or an idle scheduler at first paint.
