import { createServerRequestScheduler } from '../../../packages/app/src/utils/server-request-scheduler'
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const scheduler = createServerRequestScheduler({ concurrency: 5, backgroundConcurrency: 2 })
const holds = Array.from({ length: 4 }, deferred)
const tasks = holds.map((hold, index) => scheduler.schedule('interactive', () => hold.promise, { kind: `catalog-${index}` }))
await Promise.resolve()
let streamStarted = false
const stream = scheduler.schedule('interactive', async () => { streamStarted = true }, { kind: 'stream-interest' })
let criticalStarted = false
const critical = scheduler.schedule('critical', async () => { criticalStarted = true }, { kind: 'prompt-admission' })
await critical
const result = { criticalStarted, streamStartedBeforeCatalogRelease: streamStarted, queuedInteractive: scheduler.snapshot().queuedInteractive }
holds.forEach(hold => hold.resolve())
await Promise.all([...tasks, stream])
console.log(JSON.stringify({ scenario: 'Four interactive jobs occupy noncritical capacity; visible stream interest cannot use critical reserve', ...result, streamStartedAfterRelease: streamStarted }, null, 2))
if (!result.criticalStarted || result.streamStartedBeforeCatalogRelease || !streamStarted) throw new Error('Unexpected scheduler behavior')
