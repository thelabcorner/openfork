import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  PROVIDER_ID,
  host,
  readGskCliApiKey,
} from "@/genspark/models"

// Genspark provider auth. The runtime provider is a built-in database entry
// wired through @/genspark/catalog; this plugin contributes the credential
// flows shown in the connect dialog. The primary flow mirrors `gsk login`
// (device-code at `POST {host}/api/cli_auth/device_code`, poll
// `GET {host}/api/cli_auth/token`) so users can click a link like WorkBuddy —
// no `npm i -g @genspark/cli` required.
//
// Auth is the same `X-Api-Key: gsk-...` the LLM proxy uses. Credits are
// $20 / 7500 = 375/$1 (pack valid 3 months); the quota adapter hits
// `GET /api/tool_cli/me` (credit_balance) with the same key and caps.

async function requestDeviceCode(base: string): Promise<{
  device_code: string
  auth_url: string
  poll_interval: number
  expires_in: number
}> {
  const res = await fetch(`${base}/api/cli_auth/device_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })
  if (!res.ok) throw new Error(`device_code ${res.status}`)
  const json = (await res.json()) as Record<string, unknown>
  const device_code = json.device_code
  const auth_url = json.auth_url
  if (typeof device_code !== "string" || typeof auth_url !== "string") throw new Error("bad device_code payload")
  const poll = typeof json.poll_interval === "number" ? json.poll_interval : 5
  const exp = typeof json.expires_in === "number" ? json.expires_in : 300
  return { device_code, auth_url, poll_interval: poll, expires_in: exp }
}

export async function GensparkAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Genspark",
          async authorize() {
            const base = host()
            try {
              const device = await requestDeviceCode(base)
              return {
                url: device.auth_url,
                instructions:
                  "Click the link to sign in with Genspark. Approve the code in the browser and Opencode will auto-save the key.",
                method: "auto" as const,
                async callback() {
                  const start = Date.now()
                  const timeout = device.expires_in * 1000
                  const interval = Math.max(2_000, device.poll_interval * 1000)
                  while (Date.now() - start < timeout) {
                    await new Promise((r) => setTimeout(r, interval))
                    try {
                      const r = await fetch(
                        `${base}/api/cli_auth/token?code=${encodeURIComponent(device.device_code)}`,
                      )
                      if (!r.ok) continue
                      const j = (await r.json()) as Record<string, unknown>
                      if (j.status === "approved" && typeof j.api_key === "string" && j.api_key.trim()) {
                        return { type: "success" as const, key: j.api_key.trim(), metadata: { source: "device-code" } }
                      }
                      if (j.status === "expired") return { type: "failed" as const }
                      // pending -> keep polling
                    } catch {
                      // transient network hiccup — keep polling
                    }
                  }
                  return { type: "failed" as const }
                },
              }
            } catch {
              return {
                url: "",
                instructions:
                  "Could not start Genspark device login. Check your network or use 'Import gsk CLI login' / 'Manually enter API key' instead.",
                method: "auto" as const,
                async callback() {
                  return { type: "failed" as const }
                },
              }
            }
          },
        },
        {
          type: "oauth",
          label: "Import gsk CLI login",
          async authorize() {
            const existing = await readGskCliApiKey()
            return {
              url: "",
              instructions: existing
                ? "Using the Genspark API key saved by `gsk login` (~/.genspark-tool-cli/config.json)."
                : "No gsk CLI login found. Run `gsk login` (npm i -g @genspark/cli) first, or use 'Manually enter API key' instead.",
              method: "auto" as const,
              async callback() {
                const key = await readGskCliApiKey()
                if (!key) return { type: "failed" as const }
                return { type: "success" as const, key, metadata: { source: "gsk-cli" } }
              },
            }
          },
        },
        {
          type: "api",
          label: "Manually enter API key",
        },
      ],
    },
  }
}
