export type PendingOAuthTransport = {
  close(): Promise<void>
}

export type PendingOAuthEntry<T extends PendingOAuthTransport, P> = {
  transport: T
  provider?: P
}

/** Owns incomplete remote OAuth transports for one MCP service lifetime. */
export class PendingOAuthTransportStore<T extends PendingOAuthTransport, P> {
  private readonly entries = new Map<string, PendingOAuthEntry<T, P>>()

  get(name: string) {
    return this.entries.get(name)
  }

  async replace(name: string, entry: PendingOAuthEntry<T, P>) {
    await this.close(name)
    this.entries.set(name, entry)
  }

  async close(name: string) {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    await entry.transport.close().catch(() => undefined)
  }

  async closeAll() {
    await Promise.all([...this.entries.keys()].map((name) => this.close(name)))
  }
}
