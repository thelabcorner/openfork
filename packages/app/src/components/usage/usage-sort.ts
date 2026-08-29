import { createSignal } from "solid-js"

export type SortDirection = "asc" | "desc"

/**
 * Column-sort state for a table, keyed by an arbitrary string column id.
 * `getValue` resolves a row to the comparable value for whichever column is
 * active, so callers pass one getter per column instead of hand-rolling a
 * comparator per table.
 */
export function createColumnSort<Row, Col extends string>(
  defaultColumn: Col,
  getValue: (row: Row, column: Col) => number | string,
) {
  const [column, setColumn] = createSignal<Col>(defaultColumn)
  const [direction, setDirection] = createSignal<SortDirection>("desc")
  let touched = false

  const toggle = (next: Col) => {
    touched = true
    if (column() === next) {
      setDirection((prev) => (prev === "desc" ? "asc" : "desc"))
      return
    }
    setColumn(() => next)
    setDirection("desc")
  }

  /** Keeps the default sort column following an external signal (e.g. a cost/tokens toggle) until the user explicitly picks a column of their own. */
  const syncDefault = (col: Col) => {
    if (touched) return
    setColumn(() => col)
    setDirection("desc")
  }

  const sort = (rows: Row[]): Row[] => {
    const col = column()
    const dir = direction() === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = getValue(a, col)
      const bv = getValue(b, col)
      if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir
      return (av - bv) * dir
    })
  }

  return { column, direction, toggle, syncDefault, sort }
}
