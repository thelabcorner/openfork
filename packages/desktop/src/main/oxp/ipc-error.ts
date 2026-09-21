const PUBLIC_MESSAGES = [
  /^Tunnel ID must use the tunnel_<32 lowercase hex> format\.$/,
  /^Enable OXP before connecting the Secure MCP Tunnel\.$/,
  /^Save a valid OpenAI Secure MCP Tunnel ID first\.$/,
  /^Save an OXP OpenAI API key first\.$/,
  /^Secure OS credential storage is unavailable\.$/,
  /^Secure credential state is unavailable; refusing to overwrite it\.$/,
  /^OpenAI tunnel-client is not installed in this OpenFork build\.$/,
  /^Enter a valid OpenAI Secure MCP Tunnel ID\.$/,
  /^Save an OXP OpenAI API key before connecting\.$/,
  /^The previous tunnel client process tree could not be proven stopped\.$/,
  /^Credential alias is already in use$/,
  /^Credential reference is unavailable$/,
  /^Credential service must be one HTTPS origin$/,
  /^Credential header name is not allowed$/,
  /^Invalid credential (?:alias|service origin|header name|prefix|account label|secret|reference)$/,
] as const

const GENERIC = "OpenAI Exchange operation failed. No privileged error details were exposed."

export function projectOxpIpcError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "")
  if (PUBLIC_MESSAGES.some((pattern) => pattern.test(message))) return new Error(message)
  if (/^(Invalid|Unknown) (?:OXP|OpenAI Exchange)/.test(message)) return new Error("Invalid OpenAI Exchange input.")
  return new Error(GENERIC)
}
