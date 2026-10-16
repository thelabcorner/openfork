/// <reference types="bun" />
// Arg parsing for the sqlite-acp-cert-20261011 harness. Standalone Bun script
// helper: no repo-relative aliases, no external dependencies.

export type DriverMode = "default" | "optout"

export type CertArgs = {
  readonly binary?: string
  readonly build: boolean
  readonly outputDir?: string
  readonly driver: DriverMode
  readonly driversBoth: boolean
  readonly hosts: number
  readonly rounds: number
  readonly hostTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly phaseTimeoutMs: number
  readonly stallMs: number
  readonly busyHoldMs: number
  readonly probeIntervalMs: number
  readonly skipCancellationPrompt: boolean
  readonly skipBusyHold: boolean
  readonly keep: boolean
  readonly reportPath?: string
  readonly stdoutJson: boolean
}

const DEFAULTS = {
  build: undefined as boolean | undefined,
  driver: "default" as DriverMode,
  driversBoth: false,
  hosts: 1,
  rounds: 6,
  hostTimeoutMs: 180_000,
  requestTimeoutMs: 30_000,
  phaseTimeoutMs: 240_000,
  stallMs: 4_000,
  busyHoldMs: 750,
  probeIntervalMs: 200,
  skipCancellationPrompt: false,
  skipBusyHold: false,
  keep: false,
  stdoutJson: false,
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function takeNumber(argv: readonly string[], index: number, flag: string): number {
  const value = Number(takeValue(argv, index, flag))
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a numeric value`)
  return value
}

export function parseArgs(argv: readonly string[]): CertArgs {
  let binary: string | undefined
  let build: boolean | undefined
  let outputDir: string | undefined
  let driver: DriverMode = DEFAULTS.driver
  let hosts = DEFAULTS.hosts
  let rounds = DEFAULTS.rounds
  let hostTimeoutMs = DEFAULTS.hostTimeoutMs
  let requestTimeoutMs = DEFAULTS.requestTimeoutMs
  let phaseTimeoutMs = DEFAULTS.phaseTimeoutMs
  let stallMs = DEFAULTS.stallMs
  let busyHoldMs = DEFAULTS.busyHoldMs
  let probeIntervalMs = DEFAULTS.probeIntervalMs
  let driversBoth = DEFAULTS.driversBoth
  let skipCancellationPrompt = DEFAULTS.skipCancellationPrompt
  let skipBusyHold = DEFAULTS.skipBusyHold
  let keep = DEFAULTS.keep
  let reportPath: string | undefined
  let stdoutJson = DEFAULTS.stdoutJson

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    switch (flag) {
      case "--binary":
        binary = takeValue(argv, index, flag)
        index++
        break
      case "--build":
        build = true
        break
      case "--no-build":
        build = false
        break
      case "--output-dir":
        outputDir = takeValue(argv, index, flag)
        index++
        break
      case "--driver": {
        const value = takeValue(argv, index, flag)
        if (value !== "default" && value !== "optout") throw new Error(`unknown --driver ${value}`)
        driver = value
        index++
        break
      }
      case "--drivers-both":
        driversBoth = true
        break
      case "--hosts":
        hosts = takeNumber(argv, index, flag)
        index++
        break
      case "--rounds":
        rounds = takeNumber(argv, index, flag)
        index++
        break
      case "--host-timeout-ms":
        hostTimeoutMs = takeNumber(argv, index, flag)
        index++
        break
      case "--request-timeout-ms":
        requestTimeoutMs = takeNumber(argv, index, flag)
        index++
        break
      case "--phase-timeout-ms":
        phaseTimeoutMs = takeNumber(argv, index, flag)
        index++
        break
      case "--stall-ms":
        stallMs = takeNumber(argv, index, flag)
        index++
        break
      case "--busy-hold-ms":
        busyHoldMs = takeNumber(argv, index, flag)
        index++
        break
      case "--probe-interval-ms":
        probeIntervalMs = takeNumber(argv, index, flag)
        index++
        break
      case "--skip-cancellation-prompt":
        skipCancellationPrompt = true
        break
      case "--skip-busy-hold":
        skipBusyHold = true
        break
      case "--keep":
        keep = true
        break
      case "--report":
        reportPath = takeValue(argv, index, flag)
        index++
        break
      case "--stdout-json":
        stdoutJson = true
        break
      default:
        throw new Error(`unknown argument ${flag}`)
    }
  }

  if (hosts < 1 || hosts > 12) throw new Error("--hosts must be between 1 and 12")
  if (rounds < 1 || rounds > 500) throw new Error("--rounds must be between 1 and 500")
  if (build === undefined) build = binary === undefined
  if (!build && binary === undefined) throw new Error("--no-build requires --binary")

  return {
    binary,
    build,
    outputDir,
    driver,
    driversBoth,
    hosts,
    rounds,
    hostTimeoutMs,
    requestTimeoutMs,
    phaseTimeoutMs,
    stallMs,
    busyHoldMs,
    probeIntervalMs,
    skipCancellationPrompt,
    skipBusyHold,
    keep,
    reportPath,
    stdoutJson,
  }
}
