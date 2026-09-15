export type VisualRuntimeTemperature = "cold" | "warm"

export interface VisualRuntimeLoaderOptions {
  probe(tabId: number): Promise<boolean>
  inject(tabId: number): Promise<void>
}

/**
 * Lazy per-document visual runtime loader.
 *
 * The page's isolated world is the source of truth: navigation destroys that
 * world, so a probe naturally turns the next operation cold without keeping a
 * stale tab/document cache in the service worker. The in-flight map exists only
 * to collapse concurrent cold starts on the same tab into one bundle parse.
 */
export class VisualRuntimeLoader {
  private readonly installing = new Map<number, Promise<void>>()

  constructor(private readonly options: VisualRuntimeLoaderOptions) {}

  async ensure(tabId: number): Promise<VisualRuntimeTemperature> {
    if (await this.options.probe(tabId)) return "warm"

    let install = this.installing.get(tabId)
    if (!install) {
      const pending = Promise.resolve()
        .then(() => this.options.inject(tabId))
        .then(async () => {
          if (!(await this.options.probe(tabId))) throw new Error("Chrome visual runtime did not become ready after injection")
        })
        .finally(() => {
          if (this.installing.get(tabId) === pending) this.installing.delete(tabId)
        })
      install = pending
      this.installing.set(tabId, install)
    }
    await install
    return "cold"
  }
}
