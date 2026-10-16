#!/usr/bin/env bun
/**
 * Bounded synthetic query-plan microbenchmark, not an end-to-end Session
 * benchmark. Run from packages/core: bun script/bench-session-tool-recall.ts
 * Uses an in-memory schema with the production sidecar/FTS access indexes.
 */
import { Database } from "bun:sqlite"

const db = new Database(":memory:")
db.exec(`
  PRAGMA journal_mode=MEMORY;
  PRAGMA synchronous=OFF;
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
  CREATE INDEX session_directory_idx ON session(directory);
  CREATE TABLE session_tool_recall (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, tool TEXT NOT NULL, time_created INTEGER NOT NULL,
    search_text TEXT NOT NULL
  );
  CREATE INDEX session_tool_recall_tool_time_idx
    ON session_tool_recall(tool, time_created, id);
  CREATE INDEX session_tool_recall_session_tool_time_idx
    ON session_tool_recall(session_id, tool, time_created, id);
  CREATE VIRTUAL TABLE session_tool_recall_fts USING fts5(
    tool, search_text, content='session_tool_recall',
    content_rowid='id', tokenize='unicode61'
  );
  CREATE TRIGGER session_tool_recall_ai AFTER INSERT ON session_tool_recall BEGIN
    INSERT INTO session_tool_recall_fts(rowid, tool, search_text)
    VALUES (new.id, new.tool, new.search_text);
  END;
`)

const SESSIONS = 1_000
const CALLS = 50_000
const ROUNDS = 12
const insertSession = db.prepare("INSERT INTO session(id,directory) VALUES (?,?)")
const insertTool = db.prepare(
  "INSERT INTO session_tool_recall(session_id,tool,time_created,search_text) VALUES (?,?,?,?)",
)
const tools = ["read", "edit", "write", "find", "git"]
db.transaction(() => {
  for (let i = 0; i < SESSIONS; i++) {
    insertSession.run(`ses_${i}`, i < 100 ? "/narrow" : "/other")
  }
  for (let i = 0; i < CALLS; i++) {
    insertTool.run(
      `ses_${i % SESSIONS}`,
      tools[i % tools.length],
      i,
      `payload ${i}${i % 5 === 0 ? " needle" : ""}${i % 991 === 0 ? " raretoken" : ""}`,
    )
  }
})()

const global = db.prepare(`
  SELECT t.id FROM session_tool_recall t INDEXED BY session_tool_recall_tool_time_idx
  JOIN session s ON s.id=t.session_id
  WHERE t.tool=? ORDER BY t.time_created DESC, t.id DESC LIMIT 20
`)
const scoped = db.prepare(`
  SELECT t.id FROM session s
  CROSS JOIN session_tool_recall t INDEXED BY session_tool_recall_session_tool_time_idx
  WHERE t.session_id=s.id AND t.tool=? AND s.directory=?
  ORDER BY t.time_created DESC, t.id DESC LIMIT 20
`)
const combined = db.prepare(`
  SELECT t.id FROM session_tool_recall_fts
  CROSS JOIN session_tool_recall t NOT INDEXED ON t.id=session_tool_recall_fts.rowid
  JOIN session s ON s.id=t.session_id
  WHERE session_tool_recall_fts MATCH ? AND t.tool=?
  ORDER BY t.time_created DESC, t.id DESC LIMIT 20
`)

function measure(statement: ReturnType<typeof db.prepare>, args: string[]) {
  for (let i = 0; i < 3; i++) statement.all(...args)
  const samples: number[] = []
  for (let i = 0; i < ROUNDS; i++) {
    const started = performance.now()
    statement.all(...args)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return {
    meanMs: Number((samples.reduce((a, b) => a + b, 0) / ROUNDS).toFixed(4)),
    medianMs: Number(samples[Math.floor(ROUNDS / 2)]!.toFixed(4)),
    p95Ms: Number(samples[Math.ceil(ROUNDS * 0.95) - 1]!.toFixed(4)),
  }
}

const result = {
  kind: "synthetic-in-memory-sqlite-query-microbenchmark",
  rows: CALLS,
  sessions: SESSIONS,
  rounds: ROUNDS,
  globalToolOnly: measure(global, ["read"]),
  scopedToolOnly: measure(scoped, ["read", "/narrow"]),
  commonCombined: measure(combined, ["{tool} : (read*) AND {search_text} : (needle*)", "read"]),
  rareCombined: measure(combined, ["{tool} : (read*) AND {search_text} : (raretoken*)", "read"]),
}
console.log(JSON.stringify(result, null, 2))
db.close()