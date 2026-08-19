import { createMemo, For, Show, Switch, Match } from "solid-js"
import { CodeView, SmartToolOutput } from "./tool-output"

type ParsedTable = {
  preamble: string[]
  columns: string[]
  rows: string[][]
  footer?: string
}

function isNumericColumn(rows: string[][], index: number) {
  if (rows.length === 0) return false
  return rows.every((row) => {
    const cell = row[index]
    if (cell === undefined || cell === "") return true
    return /^-?\d+(\.\d+)?$/.test(cell)
  })
}

function parseAsciiTable(text: string): ParsedTable | undefined {
  const lines = text.split("\n")
  const sepIndex = lines.findIndex((l) => /^[\s+-]+$/.test(l) && l.includes("-"))
  if (sepIndex <= 0) return undefined
  const headerLine = lines[sepIndex - 1]!
  const preamble = lines.slice(0, sepIndex - 1).filter((l) => l.trim().length > 0)
  const columns = headerLine
    .trim()
    .split(/\s*\|\s*/)
    .map((c) => c.trim())
  let footer: string | undefined
  const rows: string[][] = []
  for (let i = sepIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("(")) {
      footer = trimmed
      continue
    }
    rows.push(
      trimmed
        .replace(/\s*\(truncated\)\s*$/, "")
        .split(/\s*\|\s*/)
        .map((c) => c.trim()),
    )
  }
  if (columns.length === 0) return undefined
  return { preamble, columns, rows, footer }
}

function SqliteTable(props: { table: ParsedTable }) {
  const numericColumns = createMemo(() =>
    props.table.columns.map((_, index) => isNumericColumn(props.table.rows, index)),
  )
  return (
    <div data-component="sqlite-table-wrap">
      <For each={props.table.preamble}>{(line) => <div data-slot="sqlite-preamble-line">{line}</div>}</For>
      <div data-component="sqlite-table-scroll" data-scrollable>
        <table data-component="sqlite-table">
          <thead>
            <tr>
              <For each={props.table.columns}>
                {(col, i) => <th data-align={numericColumns()[i()] ? "right" : "left"}>{col}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.table.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell, i) => <td data-align={numericColumns()[i()] ? "right" : "left"}>{cell || "·"}</td>}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={props.table.footer}>
        <div data-slot="sqlite-table-footer">{props.table.footer}</div>
      </Show>
    </div>
  )
}

export function SqliteOutput(props: { action: string; output: string }) {
  const table = createMemo(() => parseAsciiTable(props.output))

  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={props.action === "schema"}>
        <CodeView contents={props.output} filename="schema.sql" />
      </Match>
      <Match when={table()}>
        <SqliteTable table={table()!} />
      </Match>
      <Match when={props.action === "export"}>
        <div data-component="sqlite-export-banner">{props.output}</div>
      </Match>
    </Switch>
  )
}
