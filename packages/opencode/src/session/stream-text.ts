/**
 * Accumulates provider text without repeatedly copying the entire prefix.
 * Materialization is reserved for snapshots and durable part boundaries.
 */
export class StreamText {
  #chunks: string[] = []
  #length = 0
  #materialized = ""
  #dirty = false

  get length() {
    return this.#length
  }

  append(value: string) {
    if (!value) return
    this.#chunks.push(value)
    this.#length += value.length
    this.#dirty = true
  }

  replace(value: string) {
    this.#chunks = value ? [value] : []
    this.#length = value.length
    this.#materialized = value
    this.#dirty = false
  }

  toString() {
    if (this.#dirty) {
      this.#materialized = this.#chunks.join("")
      this.#chunks = this.#materialized ? [this.#materialized] : []
      this.#dirty = false
    }
    return this.#materialized
  }
}
