import type { ConnectionCredentialInfo, ConnectionInfo } from "@opencode-ai/sdk/v2/client"

export function credentialAccounts(connections: readonly ConnectionInfo[]) {
  return connections.filter((connection): connection is ConnectionCredentialInfo => connection.type === "credential")
}

export function activeCredentialAccount(connections: readonly ConnectionInfo[]) {
  const accounts = credentialAccounts(connections)
  return accounts.find((account) => account.active) ?? accounts[0]
}
