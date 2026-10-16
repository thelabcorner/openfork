/**
 * Electron packager smoke harness: build to temporary .mjs and invoke the
 * Desktop-installed electron.exe with ELECTRON_RUN_AS_NODE=1 at bootstrap.
 * Deliberately clear that inherited flag before spawning the SQL subprocess
 * so only SqliteScanProcessClient's runtime selection can make it work.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"

if (!process.versions.electron) throw Error("This test requires the actual Electron executable")
delete process.env.ELECTRON_RUN_AS_NODE
const dir=mkdtempSync(join(tmpdir(),"openfork-sqlite-electron-"))
const file=join(dir,"electron.sqlite")
const db=new DatabaseSync(file)
db.exec("CREATE TABLE proof(x INTEGER); INSERT INTO proof VALUES(215)")
db.close()
const client=new SqliteScanProcessClient({filename:file,readonly:true,permitLane:"scan",queryTimeoutMs:600})
try {
  await client.ready
  const rows=await client.request<Array<{x:number}>>({
    kind:"query",query:"SELECT x FROM proof",params:[],arrays:false,safeIntegers:false,
  })
  if (rows[0]?.x !== 215) throw Error("Electron subprocess returned the wrong row")
  console.log("ELECTRON_SCAN_SUBPROCESS_OK electron="+process.versions.electron)
} finally {
  await client.close()
  rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
