import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"

test("invalid IPC parameters never register a ghost statement or orphan the SQLite file handle", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-invalid-ipc-"))
  const filename=join(dir,"test.db")
  const seed=new Native(filename)
  seed.run("CREATE TABLE proof(v INTEGER)")
  seed.run("INSERT INTO proof VALUES(9)")
  seed.close()
  Bun.gc(true)
  const client=new SqliteScanProcessClient({filename,readonly:true,permitLane:"scan",queryTimeoutMs:400})
  try {
    await client.ready
    const cyclic:{self?:unknown}={}
    cyclic.self=cyclic
    const started=performance.now()
    await expect(client.request({
      kind:"query",query:"SELECT ? AS value",params:[cyclic],
      arrays:false,safeIntegers:false,
    })).rejects.toThrow()
    expect(performance.now()-started).toBeLessThan(1_000)
    expect(client.activitySnapshot()).toContain("processPending=0")
    const rows=await client.request<Array<{v:number}>>({
      kind:"query",query:"SELECT v FROM proof",params:[],
      arrays:false,safeIntegers:false,
    })
    expect(rows).toEqual([{v:9}])
    await client.close()
    await unlink(filename)
  } finally {
    await client.close()
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:60})
  }
},10_000)
