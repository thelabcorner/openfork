/**
 * Anchor-Invariant Pane Geometry Kernel
 * Implements the divider-centric model from the handoff doc:
 *   W_i' = W_i + Δ
 *   W_{i+1}' = W_{i+1} - Δ
 *   All other panes unchanged
 *   W_i' + W_{i+1}' = W_i + W_{i+1} (conservation)
 * Pure O(1) arithmetic, no DOM, no allocation in hot path.
 */

export const PANE_EPSILON = 0.5

export interface PairedWidths {
  left: number
  right: number
  delta: number
}

export interface DividerTransaction {
  dividerIndex: number
  startPointerX: number
  startPointerY: number
  leftStartWidth: number
  rightStartWidth: number
  leftMinWidth: number
  rightMinWidth: number
  leftMaxWidth?: number
  rightMaxWidth?: number
}

export function clampDelta(
  requestedDelta: number,
  leftMin: number,
  rightMin: number,
  leftStart: number,
  rightStart: number,
): number {
  const minDelta = leftMin - leftStart
  const maxDelta = rightStart - rightMin
  if (minDelta > maxDelta) return 0
  if (requestedDelta < minDelta) return minDelta
  if (requestedDelta > maxDelta) return maxDelta
  return requestedDelta
}

export function clampDeltaWithMax(
  requestedDelta: number,
  leftMin: number,
  rightMin: number,
  leftMax: number | undefined,
  rightMax: number | undefined,
  leftStart: number,
  rightStart: number,
): number {
  let minDelta = leftMin - leftStart
  let maxDelta = rightStart - rightMin
  if (leftMax !== undefined) maxDelta = Math.min(maxDelta, leftMax - leftStart)
  if (rightMax !== undefined) minDelta = Math.max(minDelta, rightStart - rightMax)
  if (minDelta > maxDelta) return 0
  if (requestedDelta < minDelta) return minDelta
  if (requestedDelta > maxDelta) return maxDelta
  return requestedDelta
}

export function pairedWidths(
  leftStart: number,
  rightStart: number,
  delta: number,
  leftMin: number,
  rightMin: number,
): PairedWidths {
  const clamped = clampDelta(delta, leftMin, rightMin, leftStart, rightStart)
  return {
    left: leftStart + clamped,
    right: rightStart - clamped,
    delta: clamped,
  }
}

export function pairedWidthsWithMax(
  leftStart: number,
  rightStart: number,
  delta: number,
  leftMin: number,
  rightMin: number,
  leftMax?: number,
  rightMax?: number,
): PairedWidths {
  const clamped = clampDeltaWithMax(delta, leftMin, rightMin, leftMax, rightMax, leftStart, rightStart)
  return {
    left: leftStart + clamped,
    right: rightStart - clamped,
    delta: clamped,
  }
}

export function requestedDelta(pointer: number, startPointer: number): number {
  return pointer - startPointer
}

export function verifyPairConservation(
  leftStart: number,
  rightStart: number,
  leftAfter: number,
  rightAfter: number,
): boolean {
  return Math.abs(leftStart + rightStart - (leftAfter + rightAfter)) < PANE_EPSILON
}

export function verifyBoundariesUnchanged(
  before: number[],
  after: number[],
  activeDivider: number,
): boolean {
  for (let i = 0; i < before.length; i++) {
    if (i === activeDivider) continue
    if (Math.abs(before[i] - after[i]) >= PANE_EPSILON) return false
  }
  return true
}

export function boundariesFromWidths(widths: number[], containerLeft: number): number[] {
  const boundaries: number[] = [containerLeft]
  let pos = containerLeft
  for (const w of widths) {
    pos += w
    boundaries.push(pos)
  }
  return boundaries
}

export function roundForCommit(value: number): number {
  return Math.round(value)
}

export interface GroupMember {
  size: number
  min: number
  max?: number
}

/**
 * Clamp a scalar delta against an aggregate group's total capacity and a
 * single opposing pane's min/max, without touching individual group members.
 * Used when a divider's "left" side is a group of panes that should share
 * the delta proportionally rather than a single adjacent pane.
 */
export function clampGroupDelta(
  group: GroupMember[],
  opposingMin: number,
  opposingMax: number | undefined,
  opposingStart: number,
  requestedDelta: number,
): number {
  const groupTotal = group.reduce((s, m) => s + m.size, 0)
  const groupMinTotal = group.reduce((s, m) => s + m.min, 0)
  const groupMaxTotal = group.reduce((s, m) => s + (m.max ?? Infinity), 0)
  let minDelta = groupMinTotal - groupTotal
  let maxDelta = groupMaxTotal === Infinity ? Infinity : groupMaxTotal - groupTotal
  minDelta = Math.max(minDelta, opposingMax !== undefined ? opposingStart - opposingMax : -Infinity)
  maxDelta = Math.min(maxDelta, opposingStart - opposingMin)
  if (minDelta > maxDelta) return 0
  return Math.min(maxDelta, Math.max(minDelta, requestedDelta))
}

export type GroupDistributionMode = "equal" | "weighted"

/**
 * Distribute a total width delta across a group of panes. Members that hit
 * their min/max are fixed and the unapplied remainder is re-distributed
 * across the still-open members, so the full delta is always absorbed
 * unless the group's aggregate capacity is exhausted (in which case
 * `clampGroupDelta` should have already limited the input delta to what the
 * group can actually take).
 *
 * - `"equal"` (default): each open member gets the same absolute share
 *   (delta / n) regardless of its current size -- an even n-way split.
 * - `"weighted"`: each open member's share is proportional to its current
 *   size, so larger panes give up (or gain) more than smaller ones.
 */
export function distributeGroupDelta(
  group: GroupMember[],
  delta: number,
  mode: GroupDistributionMode = "equal",
): number[] {
  const values = group.map((m) => m.size)
  const fixed = new Array(group.length).fill(false)
  let remaining = delta
  for (let pass = 0; pass < group.length + 1 && Math.abs(remaining) > PANE_EPSILON; pass++) {
    const openIdx = values.map((_, i) => i).filter((i) => !fixed[i])
    if (openIdx.length === 0) break
    const weightTotal = mode === "weighted" ? openIdx.reduce((s, i) => s + values[i], 0) : 0
    let applied = 0
    for (const i of openIdx) {
      const share =
        mode === "weighted"
          ? weightTotal > 0
            ? remaining * (values[i] / weightTotal)
            : remaining / openIdx.length
          : remaining / openIdx.length
      const min = group[i].min
      const max = group[i].max ?? Infinity
      const next = values[i] + share
      if (next < min) {
        applied += min - values[i]
        values[i] = min
        fixed[i] = true
      } else if (next > max) {
        applied += max - values[i]
        values[i] = max
        fixed[i] = true
      } else {
        applied += share
        values[i] = next
      }
    }
    remaining -= applied
    if (Math.abs(applied) < PANE_EPSILON) break
  }
  return values
}
