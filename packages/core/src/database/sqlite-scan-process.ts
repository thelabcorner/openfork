/**
 * Killable, read-only SQLite analytics. A synchronous SQLite C call in a
 * worker_thread cannot be interrupted reliably by Worker.terminate(), so a
 * runaway scan must live across an OS *process* boundary.
 *
 * NEVER use for a writer/transaction owner. Hard deadlines deliberately fail
 * the caller rather than automatically replaying possibly stateful operations.
 * The next query starts a clean read-only SQLite handle.
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { SqliteWorkerOptions } from "./sqlite-worker-client"
import type { SqlitePlanDiagnostic } from "./sqlite-query-forensics"
import { sqliteStatementClass } from "./sqlite-diagnostics"

type Query = {
  kind: "query"
  query: string
  params: ReadonlyArray<unknown>
  arrays: boolean
  safeIntegers: boolean
  diagnosePlan?: string
}
type Request = Query | { kind: "close" } | { kind: "extension"; path: string } | { kind: "serialize" }
type Job = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }
type Frame = { ready?: boolean; id?: number; value?: unknown; error?: { name?: string; message?: string; code?: string }; planDiagnostic?: SqlitePlanDiagnostic }

// Bun's child_process IPC does not negotiate V8's advanced serializer.
// Production Node uses advanced structured clone; the Bun test harness falls
// back to explicit tagged precision-preserving JSON encoding.
const wireTag = "__openforkSqliteWireV1__"
function encodeWire(value: unknown): unknown {
  if (typeof value === "bigint") return { [wireTag]: "int", v: value.toString() }
  if (value instanceof Uint8Array) return { [wireTag]: "bytes", v: Array.from(value) }
  if (Array.isArray(value)) return value.map(encodeWire)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]))
  return value
}
function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire)
  if (value === null || typeof value !== "object") return value
  const obj = value as Record<string, unknown>
  if (obj[wireTag] === "int" && typeof obj.v === "string") return BigInt(obj.v)
  if (obj[wireTag] === "bytes" && Array.isArray(obj.v)) return Uint8Array.from(obj.v)
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, decodeWire(item)]))
}

const workerSource = String.raw`
const { DatabaseSync, constants } = require("node:sqlite");
const cfg = JSON.parse(process.env.OPENFORK_SCAN_PROCESS_CONFIG);
// An orphaned subprocess must not retain a WAL snapshot after its supervising
// sidecar crashes. The native SELECT blocks THIS JS thread, so watchdog checks
// require a separate thread that can kill the entire process independently.
const { Worker } = require("node:worker_threads");
function watchParent() {
  const { workerData } = require("node:worker_threads");
  setInterval(() => {
    try { process.kill(workerData.parentPid, 0); }
    catch { process.kill(process.pid, "SIGKILL"); }
  }, 500);
}
if (Number.isSafeInteger(cfg.parentPid) && cfg.parentPid > 0) {
  const guardian = new Worker("(" + watchParent.toString() + ")()", {
    eval:true,workerData:{parentPid:cfg.parentPid}
  });
  guardian.unref();
}
const db = new DatabaseSync(cfg.filename, {readOnly:true, open:true, enableForeignKeyConstraints:true, timeout:cfg.timeout ?? 100});
// Defense inside SQLite's parser, not a textual SQL regex. The database is
// read-only, but ATTACH or VACUUM INTO can target *other* files; no external
// writes or DDL may be authorized by a disposable query subprocess.
const forbidden = new Set([
  constants.SQLITE_ATTACH, constants.SQLITE_DETACH,
  constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE,
  constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_VIEW, constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_VIEW, constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_DROP_TABLE, constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_VIEW, constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_TEMP_TABLE, constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_VIEW, constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_ALTER_TABLE, constants.SQLITE_REINDEX,
  constants.SQLITE_ANALYZE, constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_VTABLE,
]);
// Node v24 correctly rejects authorizer-denied SQL synchronously. Bun 1.4.3's
// node:sqlite compatibility callback can deadlock on SQLITE_DENY; leave the
// natively readOnly Bun connection protected by parent admission, rather than
// making an invalid statement monopolize its subprocess deadline.
if (!process.versions.bun) {
  db.setAuthorizer((action) => forbidden.has(action) ? constants.SQLITE_DENY : constants.SQLITE_OK);
}
const cache = new Map();
const diagnosed = new Set();
const wireTag = "__openforkSqliteWireV1__";
function pack(value) {
  if (typeof value === "bigint") return {[wireTag]:"int",v:value.toString()};
  if (value instanceof Uint8Array) return {[wireTag]:"bytes",v:Array.from(value)};
  if (Array.isArray(value)) return value.map(pack);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,pack(item)]));
  }
  return value;
}
function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (value === null || typeof value !== "object") return value;
  if (value[wireTag] === "int") return BigInt(value.v);
  if (value[wireTag] === "bytes") return Uint8Array.from(value.v);
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,unpack(item)]));
}
const respond = (message) => { if (process.connected) process.send(cfg.wireJson ? pack(message) : message); };
respond({ ready: true });
process.on("message", (request) => {
  if (!request || !Number.isSafeInteger(request.id)) return;
  if (request.kind === "close") {
    try { db.close(); respond({ id:request.id, value:null }); } catch {}
    process.disconnect();
    return;
  }
  if (request.kind !== "query") {
    respond({ id:request.id, error:{name:"Error",message:"Read-only scanner rejects non-query worker actions"} });
    return;
  }
  try {
    const params = cfg.wireJson ? request.params.map(unpack) : request.params;
    if (request.diagnosePlan && !diagnosed.has(request.diagnosePlan)) {
      diagnosed.add(request.diagnosePlan);
      const plan = {hash:request.diagnosePlan,steps:0,scans:0,searches:0,tempSorts:0,covering:0,automaticIndexes:0,status:"unavailable"};
      try {
        const rows = db.prepare("EXPLAIN QUERY PLAN " + request.query).all(...params);
        plan.steps=rows.length;
        for (const row of rows) {
          const d=String(row.detail || "").toUpperCase();
          if (/^SCAN\b/.test(d)) plan.scans++;
          if (/^SEARCH\b/.test(d)) plan.searches++;
          if (d.includes("USE TEMP B-TREE")) plan.tempSorts++;
          if (d.includes("COVERING INDEX")) plan.covering++;
          if (d.includes("AUTOMATIC INDEX")) plan.automaticIndexes++;
        }
        plan.status="ok";
      } catch {}
      respond({planDiagnostic:plan});
    }
    const key=(request.arrays?"a:":"o:")+request.query;
    let statement=cache.get(key);
    if (!statement) {
      statement=db.prepare(request.query);
      if (request.arrays) statement.setReturnArrays(true);
      if (request.query.length <= 16384) {
        cache.set(key,statement);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
      }
    }
    statement.setReadBigInts(request.safeIntegers);
    respond({id:request.id,value:statement.all(...params)});
  } catch (error) {
    respond({id:request.id,error:{name:error?.name,message:error?.message,code:error?.code}});
  }
});
process.on("disconnect", () => process.exit(0));
`

/**
 * Only the read-only lane's actual initialization pragmas and bounded
 * introspection operations belong here. An unconstrained PRAGMA runs SQLite
 * administrative verbs, including WAL checkpoint and connection policy
 * mutations, and can make an analytics caller compete with maintenance.
 */
function allowedReadPragma(query: string): boolean {
  const input = query.trim().replace(/;$/, "").trim()
  // Required for Database.layerFromPath reader initialization.
  if (/^PRAGMA\s+query_only\s*=\s*ON$/i.test(input)) return true
  if (/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(input)) return true
  const busy = /^PRAGMA\s+busy_timeout\s*=\s*(\d+)$/i.exec(input)
  if (busy) return Number(busy[1]) <= 1_000
  const cache = /^PRAGMA\s+cache_size\s*=\s*(-?\d+)$/i.exec(input)
  if (cache) return Math.abs(Number(cache[1])) <= 128_000
  // Read-only observation. Do not admit functions that mutate WAL or schema.
  return /^PRAGMA\s+(?:main\.)?(?:query_only|foreign_keys|busy_timeout|cache_size|data_version|schema_version|user_version|page_count|freelist_count|journal_mode|database_list|compile_options|integrity_check|quick_check|foreign_key_check)\s*$/i.test(input) ||
    /^PRAGMA\s+(?:main\.)?(?:table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list)\s*\(\s*(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\w+)\s*\)\s*$/i.test(input)
}

/**
 * Reject write-capable tokens hidden behind WITH/EXPLAIN before sending SQL to
 * a Bun subprocess. SQLite's natively read-only connection remains the final
 * authority; this tokenizer is defense-in-depth for ATTACH and other
 * cross-database operations, not a replacement for a SQL parser.
 */
function hasHiddenWriteCommand(sql: string): boolean {
  const forbidden = new Set(["INSERT","UPDATE","DELETE","REPLACE","CREATE",
    "ALTER","DROP","ATTACH","DETACH","VACUUM","REINDEX","ANALYZE"])
  for (let i=0; i<sql.length;) {
    const ch=sql[i]!
    if (ch==="-" && sql[i+1]==="-") {
      const end=sql.indexOf("\n",i+2);i=end<0?sql.length:end+1;continue
    }
    if (ch==="/" && sql[i+1]==="*") {
      const end=sql.indexOf("*/",i+2);i=end<0?sql.length:end+2;continue
    }
    if (ch==="'" || ch==='"' || ch==="`" || ch==="[") {
      const close=ch==="["?"]":ch
      i++
      while(i<sql.length) {
        if(sql[i]===close) {
          if(sql[i+1]===close) {i+=2;continue}
          i++;break
        }
        i++
      }
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end=i+1
      while(end<sql.length && /[A-Za-z0-9_]/.test(sql[end]!))end++
      if(forbidden.has(sql.slice(i,end).toUpperCase()))return true
      i=end
      continue
    }
    i++
  }
  return false
}

function revive(value: { name?: string; message?: string; code?: string }) {
  const error = new Error(value.message ?? "Isolated SQLite scanner failed")
  error.name = value.name ?? "SqliteScanProcessError"
  if (value.code) Object.assign(error, { code: value.code })
  return error
}

export class SqliteScanProcessClient {
  private child?: ChildProcess
  private readyPromise?: Promise<void>
  private jobs = new Map<number, Job>()
  private nextID = 0
  private stopping = false
  private closePromise?: Promise<void>
  // A deadline clears this.child immediately so the next request can recover,
  // but SIGKILL is not proof of OS exit (especially on Windows). Retain *all*
  // subprocess generations until their IPC/OS handles have actually closed.
  private readonly liveChildren = new Set<Promise<void>>()
  private inFlight = "none"
  private discardedReadTransaction = false
  private readonly budget: number
  readonly ready: Promise<void>

  constructor(
    private readonly options: SqliteWorkerOptions & { readonly queryTimeoutMs?: number; readonly processBinary?: string },
    private readonly onPlanDiagnostic?: (plan: SqlitePlanDiagnostic) => void,
  ) {
    if (options.readonly !== true || !["scan", "scan-pool", "interactive"].includes(options.permitLane ?? "")) {
      throw new Error("Killable SQLite is restricted to approved read-only lanes")
    }
    this.budget = Math.max(100, Math.min(60_000, options.queryTimeoutMs ?? 10_000))
    this.ready = this.start()
  }

  private fail(reason: Error, child?: ChildProcess) {
    if (child && this.child !== child) return
    if (this.child === child) {
      this.child = undefined
      this.readyPromise = undefined
    }
    this.inFlight = "none"
    // If a query-only subprocess died mid-WAL snapshot, SQLite/OS already
    // abandoned its read transaction. A subsequent framework ROLLBACK is
    // cleanup, not a new native operation against a newly opened connection.
    if (this.jobs.size > 0) this.discardedReadTransaction = true
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer)
      job.reject(reason)
    }
    this.jobs.clear()
  }

  private start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    const command = this.options.processBinary ??
      process.execPath
    const env = {
      // A Bun --compile executable otherwise reruns its *embedded app* when
      // spawned with -e, instead of interpreting the isolated scanner source.
      // Bun's documented standalone runtime override restores CLI mode.
      BUN_BE_BUN: process.versions.bun ? "1" : undefined,
      // The Electron binary is not a Node CLI unless this flag is set.
      // Never inherit or assume the outer desktop process set it.
      ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : undefined,
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      OPENFORK_SCAN_PROCESS_CONFIG: JSON.stringify({
        filename:this.options.filename, timeout:this.options.timeout,
        parentPid:process.pid, wireJson: Boolean(process.versions.bun),
      }),
    }
    // Keep result-hydration failures inside this disposable process. This is
    // a V8 heap ceiling, NOT an OS-wide RSS cap on native SQLite allocations.
    const child = spawn(command, ["--max-old-space-size=256", "-e", workerSource], {
      // V8 advanced IPC preserves SQLite bigint/blob result types and query
      // parameter semantics; default JSON IPC cannot serialize BigInt.
      windowsHide:true, stdio:["ignore","ignore","ignore","ipc"],
      serialization:process.versions.bun ? "json" : "advanced", env,
    })
    this.child = child
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    this.liveChildren.add(exited)
    void exited.then(() => this.liveChildren.delete(exited))
    const ready = new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => {
        const error = new Error("SQLite read-only scan process startup exceeded 5s")
        this.fail(error, child)
        child.kill("SIGKILL")
        reject(error)
      },5000)
      let settled=false
      const started = () => {
        if (settled) return
        settled=true
        clearTimeout(timer)
        resolve()
      }
      const failed = (error: Error) => {
        if (!settled) {
          settled=true
          clearTimeout(timer)
          reject(error)
        }
        this.fail(error, child)
      }
      child.on("message",(message: Frame) => {
        if (message.ready) { started(); return }
        if (message.planDiagnostic) {
          this.onPlanDiagnostic?.(message.planDiagnostic)
          return
        }
        const job = this.jobs.get(message.id ?? -1)
        if (!job) return
        this.jobs.delete(message.id!)
        clearTimeout(job.timer)
        this.inFlight="none"
        message.error ? job.reject(revive(message.error))
          : job.resolve(process.versions.bun ? decodeWire(message.value) : message.value)
      })
      child.on("error",failed)
      child.on("exit",(code,signal) => failed(new Error(
        "SQLite read-only scan process exited ("+String(code ?? signal)+")",
      )))
    })
    this.readyPromise = ready
    return ready
  }

  activitySnapshot() {
    return `processStage=${this.inFlight==="none"?"idle":"executing"} processSql=${this.inFlight} processPending=${this.jobs.size}`
  }

  /** Cancellation is safe ONLY for isolated, query-only analytics. */
  cancelActive() {
    const child = this.child
    if (!child || this.jobs.size === 0) return
    this.fail(Object.assign(new Error("SQLite read-only scan cancelled"), {
      name: "SqliteScanCancelled", code: "SQLITE_SCAN_CANCELLED",
    }), child)
    child.kill("SIGKILL")
  }

  async request<T = unknown>(request: Request): Promise<T> {
    if (this.stopping) throw new Error("SQLite scan process is closing")
    if (request.kind === "extension" || request.kind === "serialize")
      throw new Error("SQLite scan process refuses extension and export actions")
    if (request.kind === "close") return this.close() as Promise<T>
    // Defense in depth: native readOnly protects the main DB, but ATTACH,
    // VACUUM INTO, and other write-capable SQL must never be admitted to an
    // expendable analytics process that can be killed without acknowledgment.
    const command = sqliteStatementClass(request.query)
    if (!["SELECT", "WITH", "EXPLAIN", "PRAGMA", "TRANSACTION"].includes(command) ||
      (command === "PRAGMA" && !allowedReadPragma(request.query)) ||
      ((command === "WITH" || command === "EXPLAIN") && hasHiddenWriteCommand(request.query))) {
      throw Object.assign(new Error("Read-only scan SQL admission rejected " + command), {
        code: "SQLITE_SCAN_READONLY_ADMISSION",
      })
    }
    if (this.discardedReadTransaction && /^\s*ROLLBACK\b/i.test(request.query)) {
      this.discardedReadTransaction = false
      return [] as T
    }
    this.discardedReadTransaction = false
    await this.start()
    const child = this.child
    if (!child || !child.connected) throw new Error("SQLite scan subprocess not connected")
    if (this.jobs.size > 0) throw new Error("SQLite isolated scan requires exclusive statement admission")
    const id = ++this.nextID
    // Prepare the IPC payload *before* registering a job/deadline. JSON IPC
    // serialization can throw synchronously (e.g. a circular bind object);
    // that must never strand the native reader or leave a ghost pending job.
    const payload = { ...request, id,
      params: process.versions.bun ? encodeWire(request.params) : request.params,
    }
    this.inFlight=sqliteStatementClass(request.query)
    return new Promise<T>((resolve,reject) => {
      const timer=setTimeout(() => {
        if (!this.jobs.has(id)) return
        const error=Object.assign(new Error("SQLite read-only query exceeded "+this.budget+"ms; isolated process terminated"),{
          name:"SqliteScanDeadlineExceeded",code:"SQLITE_SCAN_DEADLINE",
        })
        this.fail(error,child)
        child.kill("SIGKILL")
      },this.budget)
      this.jobs.set(id,{resolve:(value) => resolve(value as T),reject,timer})
      try {
        child.send(payload,(error) => {
          if (!error || !this.jobs.has(id)) return
          this.fail(error, child)
          child.kill("SIGKILL")
        })
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error("SQLite IPC send failed"), child)
        child.kill("SIGKILL")
      }
    })
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeOnce()
  }

  private async closeOnce(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (child) {
      this.fail(new Error("SQLite scan process is closing"), child)
      child.kill("SIGKILL")
    }
    // Include already-timed-out/cancelled predecessors. Their client handle was
    // retired to admit a replacement, but an old PID may still own a WAL file.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.liveChildren]),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() =>
            reject(new Error("SQLite subprocess generations failed to exit after termination")), 5_000)
        }),
      ])
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
}
