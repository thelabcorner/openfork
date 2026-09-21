export * as ExchangeProcessEnvironment from "./process-environment"

const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|APIKEY|ACCESS_?KEY(?:_ID)?|SECRET_?ACCESS_?KEY|TOKEN|AUTHTOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?TOKEN|BEARER|CREDENTIALS?)(?:_|$)/i

function credentialBearingUrl(value: string) {
  try {
    const url = new URL(value)
    return !!url.username || !!url.password
  } catch {
    return false
  }
}

/** External process execution inherits ordinary toolchain state, never ambient credentials. */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const normalized = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    if (SECRET_ENV_NAME.test(normalized)) continue
    if (credentialBearingUrl(value)) continue
    env[key] = value
  }
  return env
}

