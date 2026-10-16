import { test, expect } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { OxpActivity } from "../src/oxp-activity/activity"
import { OxpActivityInspection } from "../src/oxp-activity/inspection"
import { Effect } from "effect"

test("file-backed OXP provenance survives 40 parallel invocations, WAL writer contention, and idempotent links", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-oxp-wal-link-stress-"))
  const filename=join(dir,"activity.sqlite")
  const graph=AppNodeBuilder.build(LayerNode.group([
    Database.node,EventV2.node,OxpActivity.node,OxpActivityInspection.node,
  ]),[[Database.node,Database.layerFromPath(filename)]])
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const activity=yield* OxpActivity.Service
      const db=yield* Database.Service
      const peer=new Native(filename)
      peer.exec("BEGIN IMMEDIATE")
      let timer:ReturnType<typeof setTimeout>|undefined
      let released=false
      try {
        timer=setTimeout(() => {
          peer.exec("COMMIT")
          released=true
        },180)
        const admitted=yield* Effect.forEach(Array.from({length:40},(_,i)=>i),
          ()=>activity.begin({
            correlation:{scheme:"mcp-session-id",digest:"file-backed-stress",scope:"unknown"},
            hostRunID:"host-file-stress",plane:"augmentation",tool:"read",
          }),{concurrency:12}).pipe(Effect.timeout("10 seconds"))
        expect(released).toBe(true)
        yield* Effect.forEach(admitted,(handle)=>
          activity.linkMany([
            {invocationID:handle.invocationID,kind:"root",ref:"root-loaded",relation:"target"},
            {invocationID:handle.invocationID,kind:"worker_session",ref:"ses_"+handle.invocationID,relation:"observed"},
          ]),{concurrency:10,discard:true})
        yield* Effect.forEach(admitted,(handle)=>
          activity.linkMany([
            {invocationID:handle.invocationID,kind:"root",ref:"root-loaded",relation:"target"},
            {invocationID:handle.invocationID,kind:"worker_session",ref:"ses_"+handle.invocationID,relation:"observed"},
          ]),{concurrency:10,discard:true})
        yield* Effect.forEach(admitted,(handle)=>activity.settle({
          invocationID:handle.invocationID,status:"committed",
          mutationAttempted:false,mutationCommitted:false,
        }),{concurrency:10,discard:true})
        const got=yield* db.db.get<{invocations:number;completed:number}>(
          "SELECT COUNT(*) AS invocations, SUM(status='committed') AS completed FROM oxp_invocation")
        expect(got).toEqual({invocations:40,completed:40})
        const links=yield* db.db.get<{links:number}>("SELECT COUNT(*) AS links FROM oxp_invocation_link")
        expect(links).toEqual({links:80})
        const parents=yield* db.db.get<{calls:number}>(
          "SELECT call_count AS calls FROM oxp_parent_activity")
        expect(parents).toEqual({calls:40})
      } finally {
        if(timer)clearTimeout(timer)
        if(!released)try{peer.exec("ROLLBACK")}catch{}
        peer.close()
      }
    }).pipe(Effect.provide(graph))))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:90})
  }
},25_000)
