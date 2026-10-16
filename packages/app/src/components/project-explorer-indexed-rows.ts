/**
 * Indexed preorder sequence for large Explorer trees.
 *
 * Unlike Array.slice(...).concat(...) on every localized watcher edit,
 * the weight-augmented implicit treap moves whole 128-row chunks in expected
 * O(log chunks) work, with O(k) materialization for k inserted/deleted rows.
 *
 * A path points to the chunk containing it, so indexOf(path) walks parent
 * weights instead of searching 50k visible rows. The index is presentation-
 * only; filesystem ownership stays with the domain tree store.
 *
 * Deliberately mutable, one owner per view; do not share instances between
 * workspaces, generations or async projection versions. Row objects remain
 * immutable references, preserving virtualizer key and focus identity.
 */
export class IndexedRowSequence<T extends { node: { path: string } }> {
  private static readonly WIDTH = 128
  private root?: Chunk<T>
  // One packed primitive per visible path instead of 50k allocated
  // {chunk,offset} objects. IDs remain stable through treap rotations.
  private positions = new Map<string, number>()
  private chunks = new Map<number, Chunk<T>>()
  private nextChunkID = 1
  private randomState = 0x7f4a7c15
  private revision = 0
  private keyRevision = 0
  private cursor?: { chunk: Chunk<T>; start: number }
  private rebases = 0

  constructor(rows: readonly T[] = [], private readonly options?: { compact?: boolean }) {
    this.root = this.fromRows(rows)
    this.root && (this.root.parent = undefined)
  }

  get length() { return size(this.root) }
  get version() { return this.revision }
  get keysVersion() { return this.keyRevision }
  get chunkCount() { return this.chunks.size }
  get compactions() { return this.rebases }

  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return
    const cursor = this.cursor
    if (cursor) {
      const offset = index - cursor.start
      if (offset >= 0 && offset < cursor.chunk.items.length) {
        return cursor.chunk.items[offset]
      }
      if (offset === cursor.chunk.items.length) {
        // TanStack reads its 50k item keys sequentially when measurements
        // are invalidated. Most reads hit the same 128-item leaf. Advancing
        // to the next leaf is O(log chunks) only once per leaf, amortizing
        // key scans to almost array-speed without copying all row pointers.
        let node: Chunk<T> | undefined = cursor.chunk
        if (node.right) {
          node = node.right
          while (node.left) node = node.left
        } else {
          while (node.parent && node.parent.right === node) node = node.parent
          node = node.parent
        }
        if (node) {
          this.cursor = { chunk: node, start: index }
          return node.items[0]
        }
      }
    }
    const requested = index
    let node = this.root
    while (node) {
      const left = size(node.left)
      if (index < left) {
        node = node.left
        continue
      }
      if (index < left + node.items.length) {
        this.cursor = { chunk: node, start: requested - (index - left) }
        return node.items[index - left]
      }
      index -= left + node.items.length
      node = node.right
    }
  }

  row(path: string): T | undefined {
    const address = this.positions.get(path)
    if (address === undefined) return
    const id = Math.floor(address / IndexedRowSequence.WIDTH)
    return this.chunks.get(id)?.items[address % IndexedRowSequence.WIDTH]
  }

  indexOf(path: string): number {
    const address = this.positions.get(path)
    if (address === undefined) return -1
    let node = this.chunks.get(Math.floor(address / IndexedRowSequence.WIDTH))
    if (!node) return -1
    let index = size(node.left) + address % IndexedRowSequence.WIDTH
    while (node.parent) {
      if (node.parent.right === node) {
        index += size(node.parent.left) + node.parent.items.length
      }
      node = node.parent
    }
    return index
  }

  /**
   * Semantics match Array.splice(position, deleteCount, ...replacement),
   * except invalid indices and duplicate paths explicitly throw.
   *
   * A single changed directory typically removes/reinserts a few rows.
   * A sorted path key may appear at most once in a flattened Explorer tree.
   */
  splice(position: number, deleteCount: number, replacement: readonly T[] = []) {
    if (!Number.isInteger(position) || position < 0 || position > this.length) {
      throw new RangeError("Invalid Explorer row splice position")
    }
    if (!Number.isInteger(deleteCount) || deleteCount < 0 || position + deleteCount > this.length) {
      throw new RangeError("Invalid Explorer row splice count")
    }
    if (deleteCount === 0 && replacement.length === 0) return
    const replacementKeys = new Set<string>()
    for (const row of replacement) {
      const path = row.node.path
      if (replacementKeys.has(path)) throw new Error(`Duplicate Explorer row: ${path}`)
      replacementKeys.add(path)
      const existing = this.indexOf(path)
      if (existing !== -1 && (existing < position || existing >= position + deleteCount)) {
        throw new Error(`Explorer row is already visible: ${path}`)
      }
    }
    let sameKeys = deleteCount === replacement.length
    if (sameKeys) {
      for (let offset = 0; offset < deleteCount; offset++) {
        if (this.get(position + offset)?.node.path !== replacement[offset]?.node.path) {
          sameKeys = false
          break
        }
      }
    }
    if (sameKeys && deleteCount <= 256) {
      // Metadata-only filesystem notifications are overwhelmingly common.
      // Replacing wrappers in existing chunks is sufficient: the ordering,
      // path index, subtree sizes, cursor and virtualizer measurement keys
      // are unchanged. Avoid two treap splits, several merges and all new
      // allocations on this hottest editor path.
      for (let offset = 0; offset < deleteCount; offset++) {
        const location = this.chunkAt(position + offset)!
        location.chunk.items[position + offset - location.start] = replacement[offset]!
      }
      this.revision++
      return
    }
    this.cursor = undefined

    const [head, tail] = this.split(this.root, position)
    const [removed, rest] = this.split(tail, deleteCount)
    this.removePositions(removed)
    const inserted = this.fromRows(replacement)
    this.root = this.merge(this.merge(head, inserted), rest)
    if (this.root) this.root.parent = undefined
    // Split boundaries produce small adjacent chunks even when a localized
    // metadata update keeps the row count unchanged. Merge fitting neighbors
    // at the two edit boundaries before considering a global compaction.
    // This prevents a long-running watcher workload from accumulating
    // thousands of tiny chunks between its originally wide leaves.
    this.coalesceAt(position)
    this.coalesceAt(position + replacement.length)
    this.coalesceAt(position)
    this.revision++
    if (!sameKeys) this.keyRevision++
    // Arbitrary watch/move edits can split two existing 128-row chunks for
    // every operation. Without reclamation a 50k-row tree reached 7,862
    // chunks after 5k random edits (vs 391 initially). Periodically rebuild
    // the private index at a bounded 3x fragmentation ceiling; the row and
    // ordered-key identities, public version and read semantics do not change.
    // The cost is amortized across hundreds of edits, not paid on each one.
    if (this.options?.compact !== false &&
      this.chunks.size > Math.max(128, Math.ceil(this.length / IndexedRowSequence.WIDTH) * 3)) {
      this.compact()
    }
  }

  compact() {
    if (this.chunks.size <= Math.ceil(this.length / IndexedRowSequence.WIDTH)) return
    const rows = this.toArray()
    this.positions.clear()
    this.chunks.clear()
    this.cursor = undefined
    this.root = this.fromRows(rows)
    if (this.root) this.root.parent = undefined
    this.rebases++
  }

  private chunkAt(index: number): { chunk: Chunk<T>; start: number } | undefined {
    if (index < 0 || index >= this.length) return
    let node = this.root
    let start = 0
    while (node) {
      const left = size(node.left)
      if (index < start + left) {
        node = node.left
        continue
      }
      start += left
      if (index < start + node.items.length) return { chunk: node, start }
      start += node.items.length
      node = node.right
    }
  }

  private coalesceAt(boundary: number): boolean {
    if (boundary < 1 || boundary >= this.length) return false
    const left = this.chunkAt(boundary - 1)
    const right = this.chunkAt(boundary)
    if (!left || !right || left.chunk === right.chunk) return false
    if (left.chunk.items.length + right.chunk.items.length > IndexedRowSequence.WIDTH) return false
    const start = left.start
    const count = left.chunk.items.length + right.chunk.items.length
    const items = left.chunk.items.concat(right.chunk.items)
    const [head, tail] = this.split(this.root, start)
    const [removed, rest] = this.split(tail, count)
    this.removePositions(removed)
    this.root = this.merge(this.merge(head, this.chunk(items)), rest)
    if (this.root) this.root.parent = undefined
    this.cursor = undefined
    return true
  }

  toArray(): T[] {
    const rows: T[] = []
    const stack: Chunk<T>[] = []
    let node = this.root
    while (node || stack.length) {
      while (node) {
        stack.push(node)
        node = node.left
      }
      node = stack.pop()!
      for (const item of node.items) rows.push(item)
      node = node.right
    }
    return rows
  }

  // Depth of an indexed search view is bounded by randomized balancing.
  // This diagnostic is useful when benchmarking adversarial file order.
  maxDepth() {
    if (!this.root) return 0
    let maximum = 0
    const pending: Array<{ node: Chunk<T>; depth: number }> = [{ node: this.root, depth: 1 }]
    while (pending.length) {
      const { node, depth } = pending.pop()!
      maximum = Math.max(maximum, depth)
      if (node.left) pending.push({ node: node.left, depth: depth + 1 })
      if (node.right) pending.push({ node: node.right, depth: depth + 1 })
    }
    return maximum
  }

  private priority() {
    let x = this.randomState
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.randomState = x
    return x >>> 0
  }

  private chunk(items: T[], priority = this.priority()) {
    const id = this.nextChunkID++
    const chunk: Chunk<T> = { id, items, priority, count: items.length }
    this.chunks.set(id, chunk)
    for (let i = 0; i < items.length; i++) {
      this.positions.set(items[i]!.node.path, id * IndexedRowSequence.WIDTH + i)
    }
    return chunk
  }

  private fromRows(rows: readonly T[]) {
    let root: Chunk<T> | undefined
    for (let start = 0; start < rows.length; start += IndexedRowSequence.WIDTH) {
      root = this.merge(root, this.chunk(rows.slice(start, start + IndexedRowSequence.WIDTH)))
    }
    if (root) root.parent = undefined
    return root
  }

  private removePositions(node?: Chunk<T>) {
    if (!node) return
    const stack = [node]
    while (stack.length) {
      const current = stack.pop()!
      for (const row of current.items) this.positions.delete(row.node.path)
      this.chunks.delete(current.id)
      if (current.left) stack.push(current.left)
      if (current.right) stack.push(current.right)
    }
  }

  private merge(a?: Chunk<T>, b?: Chunk<T>): Chunk<T> | undefined {
    if (!a) return b
    if (!b) return a
    if (a.priority < b.priority) {
      a.right = this.merge(a.right, b)
      if (a.right) a.right.parent = a
      recount(a)
      return a
    }
    b.left = this.merge(a, b.left)
    if (b.left) b.left.parent = b
    recount(b)
    return b
  }

  private split(node: Chunk<T> | undefined, index: number): [Chunk<T> | undefined, Chunk<T> | undefined] {
    if (!node) return [undefined, undefined]
    const leftSize = size(node.left)
    const ownEnd = leftSize + node.items.length
    if (index < leftSize) {
      const [a, b] = this.split(node.left, index)
      node.left = b
      if (b) b.parent = node
      recount(node)
      node.parent = undefined
      if (a) a.parent = undefined
      return [a, node]
    }
    if (index > ownEnd) {
      const [a, b] = this.split(node.right, index - ownEnd)
      node.right = a
      if (a) a.parent = node
      recount(node)
      node.parent = undefined
      if (b) b.parent = undefined
      return [node, b]
    }
    if (index === leftSize) {
      const detached = node.left
      node.left = undefined
      recount(node)
      if (detached) detached.parent = undefined
      node.parent = undefined
      return [detached, node]
    }
    if (index === ownEnd) {
      const detached = node.right
      node.right = undefined
      recount(node)
      if (detached) detached.parent = undefined
      node.parent = undefined
      return [node, detached]
    }

    // Only the boundary chunk splits; the other ~50k paths remain in the
    // original chunks. Reindex at most 128 rows for this operation.
    const offset = index - leftSize
    const left = node.left
    const right = node.right
    this.chunks.delete(node.id)
    if (left) left.parent = undefined
    if (right) right.parent = undefined
    const a = this.merge(left, this.chunk(node.items.slice(0, offset)))
    const b = this.merge(this.chunk(node.items.slice(offset)), right)
    if (a) a.parent = undefined
    if (b) b.parent = undefined
    return [a, b]
  }
}

type Chunk<T> = {
  id: number
  items: T[]
  priority: number
  count: number
  parent?: Chunk<T>
  left?: Chunk<T>
  right?: Chunk<T>
}

function size<T>(node?: Chunk<T>) {
  return node?.count ?? 0
}
function recount<T>(node: Chunk<T>) {
  node.count = node.items.length + size(node.left) + size(node.right)
}
