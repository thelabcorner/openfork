// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// create a real db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-e2e-'));
const dbPath = path.join(dir, 'sample.db');
console.log('dir', dir);

const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, active INTEGER); INSERT INTO users(name,active) VALUES ("alice",1),("bob",0),("carol",1); CREATE TABLE logs(id INTEGER PRIMARY KEY, msg TEXT);');
db.close();
console.log('db at', dbPath, 'exists', fs.existsSync(dbPath));

import { Effect, Layer } from 'effect';
import { SqliteTool } from 'opencode/src/tool/sqlite.ts';
import { InstanceRef } from 'opencode/src/effect/instance-ref.ts';

const ctx = {
  sessionID: 'ses_test' as any,
  messageID: 'msg_test' as any,
  callID: 'test-call',
  agent: 'build',
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req: any) => Effect.sync(() => {
    console.log('[ask]', req.permission, JSON.stringify(req.metadata));
  }),
} as any;

const program = Effect.gen(function* () {
  const toolInfo = yield* SqliteTool;
  const tool = yield* toolInfo.init();
  // SqliteTool.execute does NOT use ChildProcessSpawner anywhere now
  const tables = yield* tool.execute({ action: "tables", db: "sample.db" }, ctx);
  console.log('=== TABLES ===');
  console.log(tables.output);
  console.log('metadata', JSON.stringify(tables.metadata));

  const schema = yield* tool.execute({ action: "schema", db: "sample.db" }, ctx);
  console.log('=== SCHEMA ===');
  console.log(schema.output);

  const query = yield* tool.execute({ action: "query", db: "sample.db", sql: "SELECT name, active FROM users WHERE active = ? ORDER BY name", params: [1] }, ctx);
  console.log('=== QUERY active=1 ===');
  console.log(query.output);
  console.log('metadata', JSON.stringify(query.metadata));

  const dry = yield* tool.execute({ action: "run", db: "sample.db", sql: "INSERT INTO users(name, active) VALUES ('dave', 1)" }, ctx);
  console.log('=== RUN dryRun ===');
  console.log(dry.output);

  const commit = yield* tool.execute({ action: "run", db: "sample.db", sql: "INSERT INTO users(name, active) VALUES ('eve', 1)", dryRun: false }, ctx);
  console.log('=== RUN commit ===');
  console.log(commit.output);

  const exp = yield* tool.execute({ action: "explain", db: "sample.db", sql: "SELECT * FROM users WHERE active = 1" }, ctx);
  console.log('=== EXPLAIN ===');
  console.log(exp.output);

  const expCsv = yield* tool.execute({ action: "export", db: "sample.db", sql: "SELECT name, active FROM users ORDER BY name", format: "csv", outputPath: "out/users.csv" }, ctx);
  console.log('=== EXPORT ===');
  console.log(expCsv.output);
  console.log('csv content', fs.readFileSync(path.join(dir, 'out', 'users.csv'), 'utf8'));

  return 'done';
});

const layer = Layer.succeed(InstanceRef, {
  directory: dir,
  worktree: dir,
} as any);

const final = Effect.provide(layer)(program);
const result = await Effect.runPromise(final);
console.log('RESULT', result);
console.log('ALL DONE');
// verify db changes
{
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  console.log('final users', verify.prepare('SELECT * FROM users').all());
  verify.close();
}
fs.rmSync(dir, { recursive: true, force: true });
