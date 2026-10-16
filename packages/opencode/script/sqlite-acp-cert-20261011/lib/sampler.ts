/// <reference types="bun" />
// One shared OS process-metrics sampler for all host PIDs. On Windows this is a
// single long-lived PowerShell process reading a PID list file, so N hosts cost
// one sampler rather than N per-host pollers. Sampling is read-only observation
// of processes this harness itself spawned. When no PowerShell runtime is
// available the sampler degrades to `unavailable` and metrics are reported null.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export type ProcessSample = { t: number; pid: number; rssBytes: number; cpuMs: number }

type SamplerState = "idle" | "running" | "unavailable" | "stopped"

const CANDIDATES = ["pwsh", "powershell.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.EXE"]

export class ProcessSampler {
  readonly samples: ProcessSample[] = []
  state: SamplerState = "idle"
  private readonly pidFile: string
  private proc: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined
  private pids: number[] = []
  private reading: Promise<void> | undefined

  constructor(dir: string, private readonly intervalMs = 500) {
    this.pidFile = join(dir, `sampler-pids-${process.pid}.json`)
  }

  async start(): Promise<void> {
    await this.setPids([])
    const script = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `$file='${this.pidFile.replace(/'/g, "''")}'`,
      `while($true){`,
      `  $raw=$null; try{$raw=Get-Content -LiteralPath $file -Raw}catch{}`,
      `  $ids=@(); if($raw){ try{$ids=@($raw | ConvertFrom-Json)}catch{} }`,
      `  foreach($procId in $ids){`,
      `    $p=Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue`,
      `    if($p){ $cpu=[double]$p.CPU*1000; [Console]::WriteLine('S,'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+','+[int]$procId+','+[long]$p.WorkingSet64+','+[math]::Round($cpu)) }`,
      `  }`,
      `  Start-Sleep -Milliseconds ${Math.max(100, Math.floor(this.intervalMs))}`,
      `}`,
    ].join("\n")
    for (const candidate of CANDIDATES) {
      try {
        const proc = Bun.spawn([candidate, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        })
        this.proc = proc
        this.state = "running"
        this.reading = this.readStdout(proc.stdout)
        return
      } catch {
        this.proc = undefined
      }
    }
    this.state = "unavailable"
  }

  private async readStdout(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const index = buffer.indexOf("\n")
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          this.handleLine(line)
        }
      }
    } catch {
      // sampler teardown
    }
  }

  private handleLine(line: string) {
    if (!line.startsWith("S,")) return
    const parts = line.slice(2).split(",")
    if (parts.length !== 4) return
    const [t, pid, rss, cpu] = parts
    const sample: ProcessSample = {
      t: Number(t),
      pid: Number(pid),
      rssBytes: Number(rss),
      cpuMs: Number(cpu),
    }
    if (Number.isFinite(sample.pid) && Number.isFinite(sample.rssBytes)) this.samples.push(sample)
  }

  async setPids(pids: number[]): Promise<void> {
    this.pids = [...pids]
    if (this.state !== "running") return
    await writeFile(this.pidFile, JSON.stringify(this.pids), "utf8").catch(() => {})
  }

  async stop(): Promise<ProcessSample[]> {
    if (this.state !== "running") return this.samples
    this.state = "stopped"
    try {
      this.proc?.kill()
    } catch {}
    if (this.proc) {
      await Promise.race([
        this.proc.exited,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]).catch(() => {})
    }
    if (this.reading) {
      await Promise.race([this.reading, new Promise((resolve) => setTimeout(resolve, 500))]).catch(() => {})
    }
    return this.samples
  }
}

export type ProcessMetric = {
  pid: number
  samples: number
  rssMaxBytes: number
  rssFirstBytes: number
  rssLastBytes: number
  cpuMsDelta: number
}

export function aggregateProcessMetrics(samples: readonly ProcessSample[]): ProcessMetric[] {
  const byPid = new Map<number, ProcessSample[]>()
  for (const sample of samples) {
    const list = byPid.get(sample.pid)
    if (list) list.push(sample)
    else byPid.set(sample.pid, [sample])
  }
  const metrics: ProcessMetric[] = []
  for (const [pid, list] of byPid) {
    const sorted = [...list].sort((a, b) => a.t - b.t)
    const cpuValues = sorted.filter((sample) => Number.isFinite(sample.cpuMs)).map((sample) => sample.cpuMs)
    const cpuDelta = cpuValues.length >= 2 ? cpuValues[cpuValues.length - 1]! - cpuValues[0]! : 0
    metrics.push({
      pid,
      samples: sorted.length,
      rssMaxBytes: Math.max(...sorted.map((sample) => sample.rssBytes)),
      rssFirstBytes: sorted[0]!.rssBytes,
      rssLastBytes: sorted[sorted.length - 1]!.rssBytes,
      cpuMsDelta: Math.max(0, cpuDelta),
    })
  }
  return metrics.sort((a, b) => a.pid - b.pid)
}
