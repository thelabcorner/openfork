#!/usr/bin/env bun

import { execFileSync } from "node:child_process"

type ProcessInfo = {
  pid: number
  commandLine: string
}

const port = process.env.OPENCODE_DEV_SERVER_PORT ?? "4096"

if (!/^\d+$/.test(port)) {
  throw new Error(`Invalid OPENCODE_DEV_SERVER_PORT: ${port}`)
}

function processIsDevBackend(commandLine: string) {
  return /(?:^|[\\/\s])src[\\/]index\.ts\s+serve(?:\s|$)/i.test(commandLine)
}

function windowsProcesses(): ProcessInfo[] {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$connections = @(Get-NetTCPConnection -State Listen -LocalPort ${port})`,
    "$result = foreach ($connection in $connections) {",
    '  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"',
    "  if ($process) { [pscustomobject]@{ pid = $process.ProcessId; commandLine = $process.CommandLine } }",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("; ")

  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim()
  if (!output) return []
  const parsed = JSON.parse(output) as ProcessInfo | ProcessInfo[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function unixProcesses(): ProcessInfo[] {
  let output = ""
  try {
    output = execFileSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`], {
      encoding: "utf8",
    }).trim()
  } catch {
    return []
  }

  return output
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((pid) => {
      try {
        const commandLine = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim()
        return commandLine ? [{ pid: Number(pid), commandLine }] : []
      } catch {
        return []
      }
    })
}

function stop(pid: number) {
  if (process.platform === "win32") {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  process.kill(pid, "SIGTERM")
}

const processes = process.platform === "win32" ? windowsProcesses() : unixProcesses()
for (const candidate of processes) {
  if (!candidate.pid || candidate.pid === process.pid || !processIsDevBackend(candidate.commandLine)) continue
  stop(candidate.pid)
  console.log(`Stopped stale OpenCode dev backend on port ${port} (PID ${candidate.pid}).`)
}
