/**
 * Standalone Bun build candidate: compile and execute to prove whether an
 * embedded Bun executable can spawn its own eval subprocess. This deliberately
 * refuses recursive execution if -e would relaunch the compiled entrypoint.
 *
 * bun build --compile ./test/database/sqlite-scan-standalone-certification-20261011.ts --outfile ./test/database/.sqlite-scan-standalone-probe.exe
 * ./test/database/.sqlite-scan-standalone-probe.exe
 */
import { Database } from "bun:sqlite"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (process.env.OPENFORK_SCAN_PROCESS_CONFIG) {
  // If this fires, compiled Bun did NOT interpret CLI -e, and is unsafe for
  // using process.execPath to spawn the scanner.
  console.error("STANDALONE_CHILD_DID_NOT_EXECUTE_EVAL")
  process.exit(19)
}
const dir=mkdtempSync(join(tmpdir(),"openfork-bun-packed-sqlite-"))
const filename=join(dir,"probe.db")
const seed=new Database(filename)
seed.run("CREATE TABLE packed(v INTEGER)")
seed.run("INSERT INTO packed VALUES (67)")
seed.close()
try {
  const client=new SqliteScanProcessClient({
    filename,readonly:true,permitLane:"scan",queryTimeoutMs:800,
  })
  try {
    await client.ready
    const result = await client.request<{v:number}[]>({
      kind:"query",query:"SELECT v FROM packed",params:[],arrays:false,safeIntegers:false,
    })
    if(result[0]?.v !== 67) throw Error("Unexpected isolated subprocess result")
    console.log("STANDALONE_BUN_SCAN_PROCESS_OK")
  } finally {
    await client.close()
  }
} finally {
  rmSync(dir,{recursive:true,force:true})
}
