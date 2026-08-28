import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { shouldEnableClaudeFirstParty } from "@/plugin/shared"
import { CliLoginRelay, installCli } from "@/claude/auth"
import { resolveCliPath } from "@/claude/availability"
import { nodeProcessPort } from "@/claude/process"

const PROVIDER_ID = "claude"

let relay: CliLoginRelay | undefined

function relayFor(directory: string) {
  const binaryPath = resolveCliPath() ?? "claude"
  if (!relay) {
    relay = new CliLoginRelay({
      process: nodeProcessPort,
      binaryPath,
      cwd: directory,
    })
  }
  return relay
}

function alreadySignedInResponse() {
  return {
    url: "",
    instructions:
      "Claude Code CLI is already signed in. Click Complete — or sign in from a terminal instead with `claude auth login --claudeai`.",
    method: "auto" as const,
    async callback() {
      return { type: "success" as const, key: "claude" }
    },
  }
}

function manualInstallResponse(launchMessage: string) {
  return {
    url: "",
    instructions: `${launchMessage}
Install Claude Code, sign in, then click Complete:

  npm install -g @anthropic-ai/claude-code
  claude auth login --claudeai

Or use the “Install Claude Code CLI and sign in” action here instead.`,
    method: "auto" as const,
    async callback() {
      const { checkAvailability } = await import("@/claude/availability")
      const deadline = Date.now() + 10 * 60_000
      while (Date.now() < deadline) {
        const report = await checkAvailability({ process: nodeProcessPort })
        if (report.loggedIn) return { type: "success" as const, key: "claude" }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      return { type: "failed" as const }
    },
  }
}

async function relayOrFallback(login: CliLoginRelay) {
  const state = await login.start()
  if (state.state === "awaiting-code") {
    return {
      url: state.url,
      instructions:
        "Sign in on the Claude page that opened and paste the code it shows here — or sign in from a terminal instead with `claude auth login --claudeai` and start this sign-in again. If the page did not open, use the sign-in link above.",
      method: "code" as const,
      async callback(code: string) {
        const submitted = await login.submitCode(code)
        if (submitted.ok) return { type: "success" as const, key: "claude" }
        const { checkAvailability } = await import("@/claude/availability")
        const verified = await checkAvailability({ process: nodeProcessPort })
        if (verified.loggedIn) return { type: "success" as const, key: "claude" }
        return { type: "failed" as const }
      },
    }
  }
  const message = state.state === "failed" ? state.message : "Claude Code CLI did not report a sign-in URL."
  return manualInstallResponse(message)
}

export function buildClaudeAuthMethods(cliPresent: boolean, directory: string) {
  if (!cliPresent) {
    return [
      {
        type: "oauth" as const,
        label: "Install Claude Code CLI and sign in",
        async authorize() {
          const { checkAvailability } = await import("@/claude/availability")
          const detection = await checkAvailability({ process: nodeProcessPort })
          if (detection.loggedIn) return alreadySignedInResponse()
          if (detection.readiness === "missing-cli") {
            const install = await installCli({ process: nodeProcessPort, cwd: directory })
            if (!install.ok) return manualInstallResponse(install.message ?? "Claude CLI install failed")
          } else if (detection.readiness === "missing-sdk") {
            return manualInstallResponse(
              "The Claude Agent SDK is unavailable. Reinstall optional dependency @anthropic-ai/claude-agent-sdk, then sign in again.",
            )
          }
          return relayOrFallback(relayFor(directory))
        },
      },
    ]
  }

  return [
    {
      type: "oauth" as const,
      label: "Sign in with Claude Code CLI",
      async authorize() {
        const { checkAvailability } = await import("@/claude/availability")
        const detection = await checkAvailability({ process: nodeProcessPort })
        if (detection.loggedIn) return alreadySignedInResponse()
        return relayOrFallback(relayFor(directory))
      },
    },
  ]
}

export async function ClaudeAuthPlugin(input: PluginInput): Promise<Hooks> {
  if (!shouldEnableClaudeFirstParty()) return {}
  const cliPresent = Boolean(resolveCliPath())
  return {
    auth: {
      provider: PROVIDER_ID,
      methods: buildClaudeAuthMethods(cliPresent, input.directory),
    },
  }
}
