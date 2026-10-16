import { Database } from "bun:sqlite"

let connection: Database | undefined
let scan: ReturnType<Database["prepare"]> | undefined
type Task = { kind: "task"; id: number; since: number; until: number }
self.onmessage = (event: MessageEvent<{ kind: "init"; file: string } | Task | { kind: "close" }>) => {
  const item = event.data
  if (item.kind === "init") {
    connection = new Database(item.file, { readonly: true })
    connection.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=20; PRAGMA cache_size=-16000")
    scan = connection.prepare(`
      SELECT session_id,provider_id,model_id,variant,cost_usd,input_tokens,
             cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,
             completed_at
      FROM usage_record WHERE completed_at >= ? AND completed_at < ?
      ORDER BY completed_at ASC, rowid ASC
    `)
    postMessage({kind:"ready"})
    return
  }
  if (item.kind === "close") { connection?.close(); postMessage({kind:"closed"}); return }
  if (!scan) { postMessage({kind:"error",id:item.id,error:"not initialized"}); return }
  const rows=scan.all(item.since,item.until) as Array<{
    session_id:string,provider_id:string,model_id:string,variant:string|null,cost_usd:number|null,
    input_tokens:number,cache_read_tokens:number,cache_write_tokens:number,output_tokens:number,
    reasoning_tokens:number,completed_at:number
  }>
  let count=0,cost=0,tokens=0
  const providers=new Map<string,number>()
  const sessions=new Set<string>()
  for(const row of rows){
    count++
    cost+=row.cost_usd??0
    tokens+=row.input_tokens+row.cache_read_tokens+row.cache_write_tokens+
      row.output_tokens+row.reasoning_tokens
    providers.set(row.provider_id,(providers.get(row.provider_id)??0)+1)
    sessions.add(row.session_id)
  }
  postMessage({kind:"done",id:item.id,count,cost,tokens,providers:providers.size,sessions:sessions.size})
}
