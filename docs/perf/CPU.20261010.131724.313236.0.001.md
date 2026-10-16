# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 8.03s | 752 | 1.0ms | 989 |

**Top 10:** `anonymous` 19.8%, `(anonymous)` 6.3%, `(anonymous)` 5.9%, `readdirSync` 3.9%, `Map` 3.9%, `runLoop` 3.1%, `(anonymous)` 2.3%, `all` 2.1%, `(anonymous)` 2.1%, `make` 1.6%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 19.8% | 1.59s | 77.2% | 6.20s | `anonymous` | `[native code]` |
| 6.3% | 513.5ms | 6.3% | 513.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` |
| 5.9% | 477.6ms | 5.9% | 477.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 3.9% | 318.8ms | 7.9% | 637.7ms | `readdirSync` | `[native code]` |
| 3.9% | 316.8ms | 3.9% | 316.8ms | `Map` | `[native code]` |
| 3.1% | 249.3ms | 100.0% | 24.17s | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` |
| 2.3% | 192.7ms | 100.0% | 10.72s | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` |
| 2.1% | 172.6ms | 2.1% | 172.6ms | `all` | `[native code]` |
| 2.1% | 171.0ms | 3.1% | 256.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` |
| 1.6% | 133.3ms | 2.0% | 166.2ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:31` |
| 1.6% | 129.9ms | 1.6% | 129.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` |
| 1.5% | 120.8ms | 1.5% | 120.8ms | `values` | `[native code]` |
| 1.1% | 92.8ms | 1.1% | 92.8ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` |
| 1.1% | 91.0ms | 1.1% | 91.0ms | `stringify` | `[native code]` |
| 1.1% | 90.6ms | 1.3% | 105.7ms | `statSync` | `[native code]` |
| 0.9% | 73.8ms | 0.9% | 73.8ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.9% | 72.7ms | 1.0% | 88.2ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` |
| 0.7% | 62.8ms | 0.7% | 62.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` |
| 0.7% | 62.6ms | 0.7% | 62.6ms | `advanceResponsePipeline` | `node:_http_server:1535` |
| 0.7% | 61.3ms | 0.7% | 61.3ms | `Arrays` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1223` |
| 0.6% | 55.7ms | 0.6% | 55.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` |
| 0.5% | 46.8ms | 0.5% | 46.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.5% | 46.5ms | 0.5% | 46.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:91` |
| 0.5% | 46.1ms | 0.5% | 46.1ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` |
| 0.5% | 44.6ms | 6.9% | 561.0ms | `map` | `[native code]` |
| 0.5% | 44.5ms | 0.5% | 44.5ms | `gen` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.5% | 40.9ms | 0.5% | 40.9ms | `Error` | `[native code]` |
| 0.4% | 40.1ms | 0.4% | 40.1ms | `prepare` | `[native code]` |
| 0.4% | 32.8ms | 0.6% | 48.2ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` |
| 0.3% | 32.0ms | 0.3% | 32.0ms | `Base` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:360` |
| 0.3% | 32.0ms | 0.3% | 32.0ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` |
| 0.3% | 31.6ms | 0.3% | 31.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts` |
| 0.3% | 31.2ms | 0.3% | 31.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` |
| 0.3% | 31.2ms | 0.3% | 31.2ms | `#resumeSocket` | `node:_http_server:1079` |
| 0.3% | 31.2ms | 3.0% | 245.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` |
| 0.3% | 30.8ms | 0.3% | 30.8ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` |
| 0.3% | 30.4ms | 0.3% | 30.4ms | `getReferenceUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` |
| 0.3% | 30.0ms | 0.3% | 30.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` |
| 0.3% | 29.8ms | 1.5% | 120.8ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` |
| 0.3% | 29.7ms | 0.3% | 29.7ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` |
| 0.3% | 29.6ms | 0.3% | 29.6ms | `flatMap` | `[native code]` |
| 0.3% | 29.4ms | 1.2% | 104.3ms | `from` | `[native code]` |
| 0.3% | 29.2ms | 0.3% | 29.2ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:469` |
| 0.3% | 29.2ms | 0.3% | 29.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` |
| 0.3% | 29.0ms | 0.3% | 29.0ms | `inlineLocalReferences` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:197` |
| 0.3% | 28.3ms | 0.7% | 58.3ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` |
| 0.3% | 27.7ms | 0.3% | 27.7ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` |
| 0.3% | 27.5ms | 0.3% | 27.5ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.3% | 26.8ms | 0.3% | 26.8ms | `get` | `[native code]` |
| 0.3% | 26.4ms | 0.3% | 26.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.3% | 25.9ms | 0.3% | 25.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` |
| 0.3% | 25.0ms | 100.0% | 18.58s | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` |
| 0.2% | 18.1ms | 0.2% | 20.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 0.2% | 17.7ms | 0.2% | 17.7ms | `copyDataProperties` | `[native code]` |
| 0.2% | 17.6ms | 0.2% | 17.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` |
| 0.2% | 17.1ms | 0.2% | 17.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:1494` |
| 0.2% | 17.0ms | 0.2% | 17.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\tracer.js:18` |
| 0.2% | 16.8ms | 0.2% | 16.8ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` |
| 0.2% | 16.8ms | 0.2% | 16.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` |
| 0.2% | 16.5ms | 0.5% | 42.9ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.2% | 16.3ms | 0.2% | 16.3ms | `create` | `[native code]` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:435` |
| 0.1% | 16.0ms | 0.9% | 76.3ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1150` |
| 0.1% | 15.9ms | 0.3% | 31.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` |
| 0.1% | 15.9ms | 1.6% | 130.5ms | `forEach` | `[native code]` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:77` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:501` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1196` |
| 0.1% | 15.8ms | 0.5% | 42.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `exists` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js:308` |
| 0.1% | 15.7ms | 3.6% | 296.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `schema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `StringChunk` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:48` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:748` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:249` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `n` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.1% | 15.5ms | 0.3% | 29.1ms | `orderSelectedFields` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:42` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:890` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1399` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\deadline-owner.ts` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `makeProto` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiGroup.js:86` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:133` |
| 0.1% | 15.4ms | 1.0% | 86.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `localeCompare` | `[native code]` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `getOwnPropertyDescriptors` | `[native code]` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `assign` | `[native code]` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:239` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `union` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1763` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `importModule` | `[native code]` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2126` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts:373` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:677` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1540` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `latest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:2129` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:163` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `createScanner` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 0.1% | 15.1ms | 100.0% | 11.41s | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` |
| 0.1% | 15.1ms | 0.3% | 31.1ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1845` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js` |
| 0.1% | 15.1ms | 0.2% | 17.0ms | `callback` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` |
| 0.1% | 15.0ms | 0.8% | 70.7ms | `finalizer` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:132` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `createJoin` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:115` |
| 0.1% | 15.0ms | 6.1% | 496.4ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.1% | 15.0ms | 0.9% | 75.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:824` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `ensureChunkDB` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\chunkdb.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `emitUpdated` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\ofxp\capability.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `bound strict` | `[native code]` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:4` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` |
| 0.1% | 14.9ms | 2.8% | 225.3ms | `getOrElseMemoize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\project\directories.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:45` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1869` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `releaseLock` | `[native code]` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:713` |
| 0.1% | 14.8ms | 0.3% | 29.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` |
| 0.1% | 14.8ms | 1.1% | 92.3ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` |
| 0.1% | 14.8ms | 0.3% | 29.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:65` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1006` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:157` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `hostname` | `[native code]` |
| 0.1% | 14.6ms | 1.9% | 152.7ms | `scopeAddFinalizerExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:811` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6941` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `part` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:106` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `resolve` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:716` |
| 0.1% | 14.3ms | 4.7% | 382.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `custom` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `getTableLikeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:230` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:430` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `hydrateRows` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:117` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `and` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js` |
| 0.1% | 13.9ms | 0.3% | 29.3ms | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `Me` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `sliding` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PubSub.js` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:86` |
| 0.1% | 13.7ms | 0.1% | 13.7ms | `onServerConnection` | `node:_http_server:668` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `isStreamSchema` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\attributes.js:29` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1404` |
| 0.1% | 13.5ms | 0.1% | 13.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` |
| 0.1% | 13.5ms | 0.3% | 29.5ms | `queryWithCache` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:260` |
| 0.1% | 13.4ms | 0.1% | 13.4ms | `ForeignKeyBuilder` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\foreign-keys.js:13` |
| 0.1% | 13.4ms | 0.1% | 13.4ms | `toString` | `[native code]` |
| 0.1% | 13.3ms | 0.1% | 13.3ms | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` |
| 0.1% | 13.3ms | 0.3% | 29.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1115` |
| 0.1% | 13.2ms | 0.1% | 13.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts` |
| 0.1% | 13.2ms | 0.1% | 13.2ms | `fail` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\result.js:70` |
| 0.1% | 13.0ms | 0.1% | 13.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js` |
| 0.1% | 12.9ms | 0.1% | 12.9ms | `stringField` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:118` |
| 0.1% | 12.8ms | 0.1% | 12.8ms | `assertOneOf` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js` |
| 0.1% | 12.3ms | 0.1% | 12.3ms | `push` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\text-tail.ts` |
| 0.1% | 12.1ms | 0.1% | 12.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:129` |
| 0.1% | 12.0ms | 0.1% | 12.0ms | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` |
| 0.1% | 11.3ms | 0.2% | 22.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3819` |
| 0.1% | 10.7ms | 0.1% | 10.7ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` |
| 0.1% | 9.7ms | 0.1% | 9.7ms | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:196` |
| 0.1% | 9.1ms | 0.1% | 9.1ms | `usage` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:58` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `parse` | `[native code]` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` |
| 0.0% | 2.6ms | 0.2% | 17.4ms | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `entries` | `[native code]` |
| 0.0% | 2.0ms | 0.2% | 23.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\run-state.ts` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\internal\utils.js:29` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` |
| 0.0% | 1.1ms | 0.0% | 1.9ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:33` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `replaceAll` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:312` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1614` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:291` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:39880` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `dlopen` | `[native code]` |
| 0.0% | 1.0ms | 0.1% | 15.9ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `functionDeclarationCommon` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js` |
| 0.0% | 1.0ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` |
| 0.0% | 1.0ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1512` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `inlineLocalReferences` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:202` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `SQLiteEffectPreparedQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:81` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\common\html.js:510` |
| 0.0% | 1.0ms | 0.2% | 17.7ms | `filter` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `observe` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `spadTelemetry` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `join` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:275` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:128` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\format\index.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:713` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:24` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:3921` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:541` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:302` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:544` |
| 0.0% | 1.0ms | 1.4% | 119.7ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:265` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `fromEntries` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async flush` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6787` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:492` |
| 0.0% | 998us | 0.0% | 998us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\linkedMap.js:16` |
| 0.0% | 997us | 0.0% | 997us | `makeDispatcher` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:116` |
| 0.0% | 996us | 0.0% | 996us | `createDebug` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` |
| 0.0% | 995us | 0.6% | 50.8ms | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` |
| 0.0% | 995us | 0.0% | 995us | `closeAllContent` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:444` |
| 0.0% | 994us | 0.0% | 994us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:177` |
| 0.0% | 993us | 0.0% | 993us | `encodeUnknownSync` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1183` |
| 0.0% | 988us | 98.8% | 7.94s | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` |
| 0.0% | 984us | 0.0% | 984us | `onPipeShutdownActionFulfilled` | `[native code]` |
| 0.0% | 984us | 0.0% | 984us | `closeIdleConnections` | `[native code]` |
| 0.0% | 983us | 0.0% | 983us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:59` |
| 0.0% | 982us | 0.0% | 982us | `_destroy` | `node:_http_server:1016` |
| 0.0% | 977us | 0.0% | 977us | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:119` |
| 0.0% | 977us | 0.0% | 977us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` |
| 0.0% | 975us | 0.0% | 975us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\worktree\index.ts` |
| 0.0% | 973us | 0.0% | 973us | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` |
| 0.0% | 972us | 0.0% | 972us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:157` |
| 0.0% | 962us | 0.0% | 962us | `getTableColumnsRuntime` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:22` |
| 0.0% | 960us | 0.0% | 960us | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:542` |
| 0.0% | 959us | 0.0% | 959us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:797` |
| 0.0% | 955us | 0.0% | 955us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:576` |
| 0.0% | 949us | 0.0% | 949us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts` |
| 0.0% | 946us | 0.1% | 14.5ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` |
| 0.0% | 945us | 0.0% | 945us | `escapeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` |
| 0.0% | 944us | 0.0% | 944us | `query` | `bun:sqlite:342` |
| 0.0% | 941us | 0.0% | 941us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:736` |
| 0.0% | 939us | 0.0% | 939us | `values` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:151` |
| 0.0% | 936us | 0.0% | 936us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` |
| 0.0% | 934us | 0.0% | 934us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.0% | 928us | 2.8% | 226.7ms | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:846` |
| 0.0% | 928us | 0.0% | 928us | `performProxyObjectGetByVal` | `[native code]` |
| 0.0% | 925us | 0.0% | 925us | `notNull` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column-builder.js:51` |
| 0.0% | 918us | 0.0% | 918us | `locatedKey` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1077` |
| 0.0% | 916us | 0.0% | 916us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3300` |
| 0.0% | 913us | 0.0% | 913us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\job.ts` |
| 0.0% | 913us | 0.0% | 913us | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` |
| 0.0% | 909us | 100.0% | 12.19s | `next` | `[native code]` |
| 0.0% | 908us | 0.0% | 908us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js:8` |
| 0.0% | 905us | 0.0% | 905us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` |
| 0.0% | 903us | 0.0% | 903us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js` |
| 0.0% | 903us | 0.0% | 903us | `constant` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:225` |
| 0.0% | 902us | 1.7% | 139.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:78` |
| 0.0% | 902us | 0.0% | 902us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.0% | 901us | 0.0% | 901us | `selectColor` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` |
| 0.0% | 900us | 0.0% | 900us | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:8` |
| 0.0% | 900us | 0.0% | 900us | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 899us | 0.0% | 4.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` |
| 0.0% | 898us | 0.0% | 898us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:233` |
| 0.0% | 897us | 0.0% | 897us | `async transform` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2290` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\recovery.ts` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts:66` |
| 0.0% | 892us | 0.0% | 892us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1119` |
| 0.0% | 882us | 0.0% | 882us | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` |
| 0.0% | 881us | 0.0% | 881us | `Literal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1421` |
| 0.0% | 877us | 5.1% | 413.6ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` |
| 0.0% | 876us | 0.0% | 876us | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:333` |
| 0.0% | 874us | 0.0% | 874us | `write` | `[native code]` |
| 0.0% | 874us | 0.0% | 874us | `optionalKey` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.0% | 872us | 0.0% | 872us | `async pull` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6873` |
| 0.0% | 870us | 0.0% | 870us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:503` |
| 0.0% | 867us | 0.0% | 867us | `fetch` | `[native code]` |
| 0.0% | 866us | 0.0% | 866us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1750` |
| 0.0% | 864us | 0.0% | 864us | `setHeader` | `node:_http_outgoing:394` |
| 0.0% | 862us | 0.0% | 862us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 860us | 0.0% | 860us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:321` |
| 0.0% | 842us | 0.0% | 842us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:160` |
| 0.0% | 833us | 0.0% | 833us | `makeOption` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:92` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 100.0% | 24.20s | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:412` |
| 100.0% | 24.17s | 3.1% | 249.3ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` |
| 100.0% | 18.58s | 0.3% | 25.0ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` |
| 100.0% | 12.50s | 0.0% | 0us | `generatorResume` | `[native code]` |
| 100.0% | 12.19s | 0.0% | 909us | `next` | `[native code]` |
| 100.0% | 11.41s | 0.1% | 15.1ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` |
| 100.0% | 11.39s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 100.0% | 10.72s | 2.3% | 192.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` |
| 100.0% | 8.28s | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:719` |
| 100.0% | 8.28s | 0.0% | 0us | `bound ` | `[native code]` |
| 100.0% | 8.17s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1914` |
| 98.8% | 7.94s | 0.0% | 988us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` |
| 77.3% | 6.21s | 0.0% | 0us | `bound require` | `[native code]` |
| 77.2% | 6.20s | 19.8% | 1.59s | `anonymous` | `[native code]` |
| 77.1% | 6.20s | 0.0% | 0us | `require` | `[native code]` |
| 63.3% | 5.08s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:723` |
| 23.4% | 1.88s | 0.0% | 0us | `afterScheduled` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:140` |
| 23.4% | 1.88s | 0.0% | 0us | `runTasks` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:150` |
| 20.5% | 1.65s | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:425` |
| 17.5% | 1.41s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:656` |
| 16.2% | 1.30s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1959` |
| 11.4% | 918.9ms | 0.0% | 0us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 7.9% | 637.7ms | 3.9% | 318.8ms | `readdirSync` | `[native code]` |
| 7.6% | 615.4ms | 0.0% | 0us | `guarded` | `internal:shared:114` |
| 7.6% | 614.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8151` |
| 6.9% | 561.0ms | 0.5% | 44.6ms | `map` | `[native code]` |
| 6.9% | 558.6ms | 0.0% | 0us | `doneUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:657` |
| 6.3% | 513.5ms | 6.3% | 513.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` |
| 6.2% | 504.9ms | 0.0% | 0us | `guarded` | `internal:shared:112` |
| 6.1% | 496.4ms | 0.1% | 15.0ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` |
| 6.1% | 495.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:196870` |
| 5.9% | 477.6ms | 5.9% | 477.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 5.5% | 446.8ms | 0.0% | 0us | `processTicksAndRejections` | `[native code]` |
| 5.1% | 413.6ms | 0.0% | 877us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` |
| 5.1% | 412.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:269` |
| 4.7% | 382.0ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` |
| 4.5% | 369.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:147` |
| 3.9% | 320.8ms | 0.0% | 0us | `load` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:28` |
| 3.9% | 320.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\msgpackr-extract@3.0.4\node_modules\msgpackr-extract\index.js:1` |
| 3.9% | 320.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\msgpackr@2.0.2\node_modules\msgpackr\node-index.js:16` |
| 3.9% | 320.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2190` |
| 3.9% | 320.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2179` |
| 3.9% | 320.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2127` |
| 3.9% | 318.8ms | 0.0% | 0us | `readdirSync` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:105` |
| 3.9% | 318.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:60` |
| 3.9% | 318.8ms | 0.0% | 0us | `resolveFile` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:96` |
| 3.9% | 316.8ms | 3.9% | 316.8ms | `Map` | `[native code]` |
| 3.8% | 307.0ms | 0.0% | 0us | `(anonymous)` | `[native code]` |
| 3.7% | 305.1ms | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` |
| 3.7% | 298.8ms | 0.0% | 0us | `releaseTakers` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1451` |
| 3.7% | 298.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:372` |
| 3.6% | 296.7ms | 0.1% | 15.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` |
| 3.6% | 292.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\nopt@9.0.0\node_modules\nopt\lib\nopt.js:1` |
| 3.6% | 292.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\index.js:4` |
| 3.4% | 277.9ms | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:625` |
| 3.3% | 265.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 3.1% | 256.9ms | 2.1% | 171.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` |
| 3.0% | 248.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1117` |
| 3.0% | 245.2ms | 0.3% | 31.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` |
| 2.8% | 226.7ms | 0.0% | 928us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:846` |
| 2.8% | 225.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:123` |
| 2.8% | 225.3ms | 0.1% | 14.9ms | `getOrElseMemoize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` |
| 2.7% | 220.7ms | 0.0% | 0us | `onExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:953` |
| 2.7% | 220.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:964` |
| 2.4% | 197.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:15` |
| 2.2% | 184.3ms | 0.0% | 0us | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:838` |
| 2.2% | 183.6ms | 0.0% | 0us | `_t` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:29` |
| 2.2% | 183.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:171` |
| 2.2% | 183.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:46` |
| 2.2% | 181.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Redis.js:6` |
| 2.2% | 181.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\index.js:4` |
| 2.2% | 180.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:7` |
| 2.2% | 180.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Command.js:6` |
| 2.2% | 180.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\utils\index.js:10` |
| 2.1% | 175.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2106` |
| 2.1% | 173.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:218` |
| 2.1% | 173.1ms | 0.0% | 0us | `inlineLocalReferences` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:218` |
| 2.1% | 172.6ms | 2.1% | 172.6ms | `all` | `[native code]` |
| 2.1% | 172.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:92` |
| 2.0% | 166.2ms | 1.6% | 133.3ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:31` |
| 2.0% | 166.1ms | 0.0% | 0us | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:90` |
| 1.9% | 155.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1655` |
| 1.9% | 153.6ms | 0.0% | 0us | `memoMapReuse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` |
| 1.9% | 153.6ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:159` |
| 1.9% | 152.7ms | 0.1% | 14.6ms | `scopeAddFinalizerExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` |
| 1.8% | 148.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1519` |
| 1.7% | 139.6ms | 0.0% | 902us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:78` |
| 1.6% | 134.2ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:228` |
| 1.6% | 134.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:104` |
| 1.6% | 130.5ms | 0.1% | 15.9ms | `forEach` | `[native code]` |
| 1.6% | 129.9ms | 1.6% | 129.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` |
| 1.6% | 129.1ms | 0.0% | 0us | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1509` |
| 1.5% | 125.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:679` |
| 1.5% | 121.8ms | 0.0% | 0us | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 1.5% | 120.8ms | 0.3% | 29.8ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` |
| 1.5% | 120.8ms | 1.5% | 120.8ms | `values` | `[native code]` |
| 1.4% | 119.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:4` |
| 1.4% | 119.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-hex-encoding@4.3.5\node_modules\@smithy\util-hex-encoding\dist-cjs\index.js:4` |
| 1.4% | 119.7ms | 0.0% | 1.0ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:265` |
| 1.4% | 118.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6687` |
| 1.4% | 116.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:333` |
| 1.4% | 116.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:87` |
| 1.3% | 111.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` |
| 1.3% | 107.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 1.3% | 105.7ms | 1.1% | 90.6ms | `statSync` | `[native code]` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\index.js:78` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\react\buildChildren.js:8` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\utils\react\cleanJSXElementLiteralChild.js:7` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:6` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:418` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\lowercase.js:263` |
| 1.3% | 104.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\validate.js:10` |
| 1.2% | 104.3ms | 0.3% | 29.4ms | `from` | `[native code]` |
| 1.1% | 96.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:76` |
| 1.1% | 94.6ms | 0.0% | 0us | `emit` | `node:events:97` |
| 1.1% | 92.8ms | 1.1% | 92.8ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` |
| 1.1% | 92.3ms | 0.1% | 14.8ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` |
| 1.1% | 92.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8149` |
| 1.1% | 91.0ms | 1.1% | 91.0ms | `stringify` | `[native code]` |
| 1.1% | 90.6ms | 0.0% | 0us | `which` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\which.ts:8` |
| 1.1% | 90.6ms | 0.0% | 0us | `L` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\isexe@4.0.0\node_modules\isexe\dist\commonjs\index.min.js:1` |
| 1.1% | 90.6ms | 0.0% | 0us | `whichSync` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:89` |
| 1.0% | 88.2ms | 0.9% | 72.7ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` |
| 1.0% | 86.1ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.9% | 79.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:674` |
| 0.9% | 78.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\misc.js:4` |
| 0.9% | 76.3ms | 0.1% | 16.0ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` |
| 0.9% | 76.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1991` |
| 0.9% | 76.2ms | 0.0% | 0us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1994` |
| 0.9% | 75.6ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:824` |
| 0.9% | 73.8ms | 0.9% | 73.8ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.8% | 72.2ms | 0.0% | 0us | `flatIntoArrayWithCallback` | `[native code]` |
| 0.8% | 70.7ms | 0.1% | 15.0ms | `finalizer` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:132` |
| 0.8% | 70.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` |
| 0.7% | 64.1ms | 0.0% | 0us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:14` |
| 0.7% | 62.8ms | 0.7% | 62.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` |
| 0.7% | 62.6ms | 0.0% | 0us | `emitResponseFinished` | `node:_http_server:1922` |
| 0.7% | 62.6ms | 0.7% | 62.6ms | `advanceResponsePipeline` | `node:_http_server:1535` |
| 0.7% | 62.6ms | 0.0% | 0us | `emitResponseFinish` | `node:_http_server:1411` |
| 0.7% | 61.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1973` |
| 0.7% | 61.3ms | 0.7% | 61.3ms | `Arrays` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1223` |
| 0.7% | 61.3ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\pty.ts:25` |
| 0.7% | 60.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\picomatch@2.3.2\node_modules\picomatch\lib\picomatch.js:5` |
| 0.7% | 60.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\picomatch@2.3.2\node_modules\picomatch\index.js:3` |
| 0.7% | 60.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@parcel+watcher@2.5.1\node_modules\@parcel\watcher\wrapper.js:2` |
| 0.7% | 60.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:5` |
| 0.7% | 60.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:725` |
| 0.7% | 60.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:3` |
| 0.7% | 60.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1.js:5` |
| 0.7% | 60.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\vapid-helper.js:4` |
| 0.7% | 58.3ms | 0.3% | 28.3ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` |
| 0.6% | 56.2ms | 0.0% | 0us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:161` |
| 0.6% | 56.2ms | 0.0% | 0us | `buildSelection` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:81` |
| 0.6% | 55.7ms | 0.6% | 55.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` |
| 0.6% | 54.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:261` |
| 0.6% | 54.9ms | 0.0% | 0us | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:199` |
| 0.6% | 51.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:682` |
| 0.6% | 50.8ms | 0.0% | 995us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` |
| 0.6% | 50.5ms | 0.0% | 0us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1626` |
| 0.6% | 49.4ms | 0.0% | 0us | `mapResultRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:72` |
| 0.6% | 48.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1141` |
| 0.6% | 48.7ms | 0.0% | 0us | `exit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1432` |
| 0.6% | 48.2ms | 0.4% | 32.8ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` |
| 0.5% | 47.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:947` |
| 0.5% | 47.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1185` |
| 0.5% | 47.7ms | 0.0% | 0us | `~effect/Utils/internal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` |
| 0.5% | 47.0ms | 0.0% | 0us | `all` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:261` |
| 0.5% | 46.8ms | 0.5% | 46.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.5% | 46.5ms | 0.5% | 46.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:91` |
| 0.5% | 46.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:89` |
| 0.5% | 46.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\flow\createFlowUnionType.js:8` |
| 0.5% | 46.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:433` |
| 0.5% | 46.1ms | 0.5% | 46.1ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` |
| 0.5% | 45.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:497` |
| 0.5% | 45.4ms | 0.0% | 0us | `acceptable` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:543` |
| 0.5% | 45.4ms | 0.0% | 0us | `win` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:341` |
| 0.5% | 45.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts:1114` |
| 0.5% | 45.4ms | 0.0% | 0us | `select` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:359` |
| 0.5% | 45.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:959` |
| 0.5% | 44.6ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:167` |
| 0.5% | 44.6ms | 0.0% | 0us | `_traverse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:196` |
| 0.5% | 44.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:7` |
| 0.5% | 44.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\index.js:24` |
| 0.5% | 44.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\traverse-node.js:7` |
| 0.5% | 44.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\context.js:28` |
| 0.5% | 44.5ms | 0.5% | 44.5ms | `gen` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.5% | 44.0ms | 0.0% | 0us | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:125` |
| 0.5% | 44.0ms | 0.0% | 0us | `SQLiteEffectSelectBase` | `[native code]` |
| 0.5% | 42.9ms | 0.2% | 16.5ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.5% | 42.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1592` |
| 0.5% | 42.0ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` |
| 0.5% | 40.9ms | 0.5% | 40.9ms | `Error` | `[native code]` |
| 0.5% | 40.7ms | 0.0% | 0us | `isTitleRequest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:86` |
| 0.4% | 40.1ms | 0.0% | 0us | `[prepareOwned]` | `bun:sqlite:331` |
| 0.4% | 40.1ms | 0.4% | 40.1ms | `prepare` | `[native code]` |
| 0.4% | 40.1ms | 0.0% | 0us | `query` | `bun:sqlite:348` |
| 0.4% | 38.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:109` |
| 0.4% | 35.4ms | 0.0% | 0us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:325` |
| 0.4% | 34.5ms | 0.0% | 0us | `async doStream` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:641` |
| 0.4% | 34.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-preset-solid@1.9.12+2507c47859fdd5f5\node_modules\babel-preset-solid\index.js:1` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:16` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\module-types.js:40` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\index.js:28` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:73` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:173` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\configuration.js:50` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:19` |
| 0.4% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1328` |
| 0.4% | 33.6ms | 0.0% | 0us | `async postJsonToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2342` |
| 0.4% | 33.3ms | 0.0% | 0us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1440` |
| 0.4% | 32.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:579` |
| 0.3% | 32.0ms | 0.0% | 0us | `Base` | `[native code]` |
| 0.3% | 32.0ms | 0.0% | 0us | `PlatformError` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PlatformError.js:109` |
| 0.3% | 32.0ms | 0.3% | 32.0ms | `Base` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:360` |
| 0.3% | 32.0ms | 0.0% | 0us | `systemError` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PlatformError.js:144` |
| 0.3% | 32.0ms | 0.0% | 0us | `endReadableNT` | `internal:streams/readable:901` |
| 0.3% | 32.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeStream.js:142` |
| 0.3% | 32.0ms | 0.3% | 32.0ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` |
| 0.3% | 31.8ms | 0.0% | 0us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:22` |
| 0.3% | 31.8ms | 0.0% | 0us | `Literals` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2138` |
| 0.3% | 31.6ms | 0.3% | 31.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts` |
| 0.3% | 31.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha1.js:4` |
| 0.3% | 31.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:41` |
| 0.3% | 31.2ms | 0.3% | 31.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` |
| 0.3% | 31.2ms | 0.0% | 0us | `_read` | `node:_http_server:1082` |
| 0.3% | 31.2ms | 0.0% | 0us | `resume_` | `internal:streams/readable:590` |
| 0.3% | 31.2ms | 0.0% | 0us | `(anonymous)` | `internal:streams/readable:351` |
| 0.3% | 31.2ms | 0.3% | 31.2ms | `#resumeSocket` | `node:_http_server:1079` |
| 0.3% | 31.1ms | 0.1% | 15.1ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.3% | 31.1ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` |
| 0.3% | 31.0ms | 0.0% | 0us | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` |
| 0.3% | 30.9ms | 0.0% | 0us | `getFrom` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:880` |
| 0.3% | 30.8ms | 0.3% | 30.8ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` |
| 0.3% | 30.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\models-dev.ts:16` |
| 0.3% | 30.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:9` |
| 0.3% | 30.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:6` |
| 0.3% | 30.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1238` |
| 0.3% | 30.5ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:229` |
| 0.3% | 30.4ms | 0.3% | 30.4ms | `getReferenceUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` |
| 0.3% | 30.3ms | 0.0% | 0us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:673` |
| 0.3% | 30.3ms | 0.0% | 0us | `makeEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:69` |
| 0.3% | 30.1ms | 0.0% | 0us | `async AzureAuthPlugin` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\azure.ts:21` |
| 0.3% | 30.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:699` |
| 0.3% | 30.0ms | 0.0% | 0us | `currentTimeNanosUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2499` |
| 0.3% | 30.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2419` |
| 0.3% | 30.0ms | 0.3% | 30.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` |
| 0.3% | 29.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:756` |
| 0.3% | 29.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1165` |
| 0.3% | 29.7ms | 0.3% | 29.7ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` |
| 0.3% | 29.6ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` |
| 0.3% | 29.6ms | 0.3% | 29.6ms | `flatMap` | `[native code]` |
| 0.3% | 29.6ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:65` |
| 0.3% | 29.5ms | 0.1% | 13.5ms | `queryWithCache` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:260` |
| 0.3% | 29.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:221` |
| 0.3% | 29.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\node.js:7` |
| 0.3% | 29.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\main.js:22` |
| 0.3% | 29.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\ril.js:8` |
| 0.3% | 29.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` |
| 0.3% | 29.4ms | 0.0% | 0us | `scopeClose` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 0.3% | 29.3ms | 0.1% | 13.9ms | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` |
| 0.3% | 29.2ms | 0.3% | 29.2ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:469` |
| 0.3% | 29.2ms | 0.3% | 29.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` |
| 0.3% | 29.1ms | 0.1% | 13.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1115` |
| 0.3% | 29.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:593` |
| 0.3% | 29.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\DOMImplementation.js:4` |
| 0.3% | 29.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\index.js:2` |
| 0.3% | 29.1ms | 0.0% | 0us | `createHTMLParser` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:585` |
| 0.3% | 29.1ms | 0.1% | 15.5ms | `orderSelectedFields` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:42` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index-cjs.js:5` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1282` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:9` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:5` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:745` |
| 0.3% | 29.0ms | 0.0% | 0us | `fromSchema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:56` |
| 0.3% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:111` |
| 0.3% | 29.0ms | 0.3% | 29.0ms | `inlineLocalReferences` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:197` |
| 0.3% | 28.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\section-matter@1.0.0\node_modules\section-matter\index.js:4` |
| 0.3% | 28.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:4` |
| 0.3% | 28.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:120` |
| 0.3% | 28.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:137` |
| 0.3% | 28.2ms | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:100` |
| 0.3% | 28.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:170` |
| 0.3% | 28.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:705` |
| 0.3% | 28.1ms | 0.0% | 0us | `pull` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:676` |
| 0.3% | 28.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:104` |
| 0.3% | 28.1ms | 0.0% | 0us | `findIndex` | `[native code]` |
| 0.3% | 28.1ms | 0.0% | 0us | `getSuccessResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:151` |
| 0.3% | 27.9ms | 0.0% | 0us | `_template` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:203` |
| 0.3% | 27.9ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:101` |
| 0.3% | 27.7ms | 0.3% | 27.7ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` |
| 0.3% | 27.5ms | 0.3% | 27.5ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.3% | 27.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:809` |
| 0.3% | 26.8ms | 0.3% | 26.8ms | `get` | `[native code]` |
| 0.3% | 26.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:10` |
| 0.3% | 26.4ms | 0.3% | 26.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.3% | 26.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:89` |
| 0.3% | 25.9ms | 0.3% | 25.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` |
| 0.3% | 25.7ms | 0.0% | 0us | `compile` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:269` |
| 0.2% | 23.6ms | 0.0% | 2.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` |
| 0.2% | 22.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:89` |
| 0.2% | 22.7ms | 0.0% | 0us | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:321` |
| 0.2% | 22.6ms | 0.1% | 11.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3819` |
| 0.2% | 20.0ms | 0.2% | 18.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 0.2% | 19.4ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:11` |
| 0.2% | 19.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1550` |
| 0.2% | 18.7ms | 0.0% | 0us | `mergeAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:728` |
| 0.2% | 18.4ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:23` |
| 0.2% | 18.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1284` |
| 0.2% | 17.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:977` |
| 0.2% | 17.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:41` |
| 0.2% | 17.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\request.js:3` |
| 0.2% | 17.7ms | 0.0% | 1.0ms | `filter` | `[native code]` |
| 0.2% | 17.7ms | 0.2% | 17.7ms | `copyDataProperties` | `[native code]` |
| 0.2% | 17.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:6` |
| 0.2% | 17.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\index.js:14` |
| 0.2% | 17.6ms | 0.2% | 17.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` |
| 0.2% | 17.4ms | 0.0% | 2.6ms | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` |
| 0.2% | 17.4ms | 0.0% | 0us | `makeEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:68` |
| 0.2% | 17.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:8` |
| 0.2% | 17.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:9` |
| 0.2% | 17.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:416` |
| 0.2% | 17.2ms | 0.0% | 0us | `optionalKey` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2427` |
| 0.2% | 17.1ms | 0.0% | 0us | `nullable` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:832` |
| 0.2% | 17.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:827` |
| 0.2% | 17.1ms | 0.0% | 0us | `ZodNullable` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` |
| 0.2% | 17.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:51` |
| 0.2% | 17.1ms | 0.2% | 17.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:1494` |
| 0.2% | 17.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:37` |
| 0.2% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:896` |
| 0.2% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1525` |
| 0.2% | 17.0ms | 0.0% | 0us | `fiberAwaitAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:536` |
| 0.2% | 17.0ms | 0.1% | 15.1ms | `callback` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` |
| 0.2% | 17.0ms | 0.2% | 17.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\tracer.js:18` |
| 0.2% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1128` |
| 0.2% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:813` |
| 0.2% | 16.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:19` |
| 0.2% | 16.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\diag.js:19` |
| 0.2% | 16.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\baggage\utils.js:19` |
| 0.2% | 16.8ms | 0.0% | 0us | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:224` |
| 0.2% | 16.8ms | 0.2% | 16.8ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` |
| 0.2% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:23` |
| 0.2% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:8` |
| 0.2% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:1` |
| 0.2% | 16.8ms | 0.2% | 16.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` |
| 0.2% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:6` |
| 0.2% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4163` |
| 0.2% | 16.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:8` |
| 0.2% | 16.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-modules-commonjs@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-modules-commonjs\lib\index.js:14` |
| 0.2% | 16.7ms | 0.0% | 0us | `Info` | `[native code]` |
| 0.2% | 16.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:214` |
| 0.2% | 16.6ms | 0.0% | 0us | `async scan` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\glob.ts:24` |
| 0.2% | 16.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 16.6ms | 0.0% | 0us | `I` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 16.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:691` |
| 0.2% | 16.6ms | 0.0% | 0us | `async Je` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 16.5ms | 0.0% | 0us | `gitbash` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:366` |
| 0.2% | 16.4ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:14` |
| 0.2% | 16.3ms | 0.2% | 16.3ms | `create` | `[native code]` |
| 0.2% | 16.1ms | 0.0% | 0us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1983` |
| 0.2% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1956` |
| 0.2% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+proxy-addr@5.1.0\node_modules\@fastify\proxy-addr\index.js:26` |
| 0.2% | 16.0ms | 0.0% | 0us | `normalizeWorkerDelegationModel` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:155` |
| 0.2% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:928` |
| 0.2% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:685` |
| 0.2% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:145` |
| 0.2% | 16.0ms | 0.0% | 0us | `workerDelegation` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:197` |
| 0.1% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2415` |
| 0.1% | 16.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:91` |
| 0.1% | 16.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:86` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:435` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1150` |
| 0.1% | 15.9ms | 0.0% | 1.0ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` |
| 0.1% | 15.9ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:32` |
| 0.1% | 15.9ms | 0.0% | 0us | `partData` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:107` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:77` |
| 0.1% | 15.9ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1610` |
| 0.1% | 15.9ms | 0.0% | 0us | `bound optional` | `[native code]` |
| 0.1% | 15.9ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1110` |
| 0.1% | 15.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:867` |
| 0.1% | 15.9ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:125` |
| 0.1% | 15.9ms | 0.0% | 0us | `ZodOptional` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.1% | 15.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1105` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:501` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1196` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:31` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:4` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:39` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\server.js:5` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `exists` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js:308` |
| 0.1% | 15.8ms | 0.0% | 0us | `provideServiceImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1149` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:193` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1145` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2417` |
| 0.1% | 15.8ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\nodes.js:7` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:9` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\printer.js:8` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:11` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:14` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:779` |
| 0.1% | 15.7ms | 0.0% | 0us | `emitListeningNextTick` | `node:_http_server:156` |
| 0.1% | 15.7ms | 0.0% | 0us | `emit` | `node:events:127` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:81` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:116` |
| 0.1% | 15.7ms | 0.0% | 0us | `out` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7272` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `schema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` |
| 0.1% | 15.6ms | 0.0% | 0us | `checkHits` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:152` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:50` |
| 0.1% | 15.6ms | 0.0% | 0us | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:319` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `StringChunk` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:48` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:135` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:748` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:249` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:215` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `n` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.1% | 15.6ms | 0.0% | 0us | `async loadMode` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\agent.ts:36` |
| 0.1% | 15.6ms | 0.0% | 0us | `async loadMode` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\agent.ts:58` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\validate\index.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\errors.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\core.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\validate\boolSchema.js:4` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:281` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:890` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\bootstrap.ts:50` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:8` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\draft7.js:4` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:5` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\validation\index.js:11` |
| 0.1% | 15.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:273` |
| 0.1% | 15.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\task.ts:46` |
| 0.1% | 15.4ms | 0.0% | 0us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:171` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts:349` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1399` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\deadline-owner.ts` |
| 0.1% | 15.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\usage.ts:76` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `makeProto` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiGroup.js:86` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:133` |
| 0.1% | 15.4ms | 0.0% | 0us | `ReasonBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:137` |
| 0.1% | 15.4ms | 0.0% | 0us | `getRef` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:370` |
| 0.1% | 15.4ms | 0.0% | 0us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:498` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts` |
| 0.1% | 15.3ms | 0.0% | 0us | `toSorted` | `[native code]` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:594` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `localeCompare` | `[native code]` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `getOwnPropertyDescriptors` | `[native code]` |
| 0.1% | 15.3ms | 0.0% | 0us | `modifyOwnPropertyDescriptors` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2300` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `assign` | `[native code]` |
| 0.1% | 15.3ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:333` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:654` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:239` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `union` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1763` |
| 0.1% | 15.3ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\v1\question.ts:62` |
| 0.1% | 15.3ms | 0.0% | 0us | `Union` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2119` |
| 0.1% | 15.3ms | 0.0% | 0us | `define` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:85` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:38` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `importModule` | `[native code]` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:39` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1291` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2126` |
| 0.1% | 15.2ms | 0.0% | 0us | `onNodeHTTPRequest` | `node:_http_server:586` |
| 0.1% | 15.2ms | 0.0% | 0us | `handler` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:135` |
| 0.1% | 15.2ms | 0.0% | 0us | `emit` | `node:events:103` |
| 0.1% | 15.2ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:13` |
| 0.1% | 15.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\tui-event.ts:40` |
| 0.1% | 15.2ms | 0.0% | 0us | `define` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:87` |
| 0.1% | 15.2ms | 0.0% | 0us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:871` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts:373` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:677` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1540` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3812` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `latest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:2129` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:39806` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `createScanner` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:163` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:32955` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1845` |
| 0.1% | 15.1ms | 0.0% | 0us | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:60` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts:27` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:101` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:8` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:5` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:15` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:2833` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `createJoin` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:154` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1163` |
| 0.1% | 15.0ms | 0.0% | 0us | `SQLiteSelectQueryBuilderBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:60` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1549` |
| 0.1% | 15.0ms | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2335` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:115` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.1% | 15.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:152` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `ensureChunkDB` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\chunkdb.ts` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts:125` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:6` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts:337` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `emitUpdated` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\ofxp\capability.ts` |
| 0.1% | 14.9ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:120` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `bound strict` | `[native code]` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:4` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:132` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:10` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\scope\index.js:10` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:793` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` |
| 0.1% | 14.9ms | 0.0% | 0us | `currentTurnUploads` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:225` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml.js:5` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\engines.js:3` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:5` |
| 0.1% | 14.9ms | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:320` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\index.js:4` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\defaults.js:3` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\project\directories.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:45` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1869` |
| 0.1% | 14.8ms | 0.0% | 0us | `async cleanup` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:5955` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `releaseLock` | `[native code]` |
| 0.1% | 14.8ms | 0.0% | 0us | `object` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:548` |
| 0.1% | 14.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1134` |
| 0.1% | 14.8ms | 0.0% | 0us | `get value` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js:33` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:872` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:518` |
| 0.1% | 14.8ms | 0.0% | 0us | `ZodObject` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:713` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:7` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\multicast-dns@7.2.5\node_modules\multicast-dns\index.js:3` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:8` |
| 0.1% | 14.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-telemetry.ts:39` |
| 0.1% | 14.8ms | 0.0% | 0us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:847` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1006` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:157` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\index.js:32` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `hostname` | `[native code]` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:47` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\oauth.js:28` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:811` |
| 0.1% | 14.5ms | 0.0% | 0us | `causeDie` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:225` |
| 0.1% | 14.5ms | 0.0% | 0us | `Die` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:205` |
| 0.1% | 14.5ms | 0.0% | 0us | `exitDie` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:330` |
| 0.1% | 14.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ManagedRuntime.js:124` |
| 0.1% | 14.5ms | 0.0% | 946us | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` |
| 0.1% | 14.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:186` |
| 0.1% | 14.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2560` |
| 0.1% | 14.4ms | 0.0% | 0us | `sqliteTableBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:25` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6941` |
| 0.1% | 14.4ms | 0.0% | 0us | `hydrateRows` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:115` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `part` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:106` |
| 0.1% | 14.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:8` |
| 0.1% | 14.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\mcp.ts:79` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `resolve` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` |
| 0.1% | 14.4ms | 0.0% | 0us | `validateSuccessResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:185` |
| 0.1% | 14.4ms | 0.0% | 0us | `getStatusSuccess` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:396` |
| 0.1% | 14.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\websearch.ts:101` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:716` |
| 0.1% | 14.4ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1512` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:10` |
| 0.1% | 14.3ms | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:626` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:10` |
| 0.1% | 14.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:195` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.1% | 14.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:891` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3865` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3063` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `custom` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.1% | 14.0ms | 0.0% | 0us | `SQLiteSelectQueryBuilderBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:75` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1236` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `getTableLikeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:230` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:430` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:4` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\safe-regex2@5.1.1\node_modules\safe-regex2\index.js:3` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\index.js:17` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\route.js:3` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:50` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way@9.6.0\node_modules\find-my-way\index.js:30` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `hydrateRows` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:117` |
| 0.1% | 13.9ms | 0.0% | 0us | `_debug` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:17` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:240` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\index.js:9` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `and` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\index.ts:1703` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\string.js:8` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\builder.js:8` |
| 0.1% | 13.9ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `Me` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\credential.ts:73` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `sliding` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PubSub.js` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\replacement.js:16` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\modification.js:18` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\removal.js:18` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:17` |
| 0.1% | 13.8ms | 0.0% | 0us | `struct` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1749` |
| 0.1% | 13.8ms | 0.0% | 0us | `Struct` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1694` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@6.0.1\node_modules\entities\dist\commonjs\decode.js:10` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:7` |
| 0.1% | 13.8ms | 0.0% | 0us | `executeTransactionStatement` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:115` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:86` |
| 0.1% | 13.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:156` |
| 0.1% | 13.7ms | 0.1% | 13.7ms | `onServerConnection` | `node:_http_server:668` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `isStreamSchema` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js` |
| 0.1% | 13.6ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\browser.ts:1335` |
| 0.1% | 13.6ms | 0.0% | 0us | `validateSuccessResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:167` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\attributes.js:29` |
| 0.1% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:21` |
| 0.1% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\defineElement.js:16` |
| 0.1% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:583` |
| 0.1% | 13.6ms | 0.1% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1404` |
| 0.1% | 13.6ms | 0.0% | 0us | `NotFound` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\local-context.ts:5` |
| 0.1% | 13.6ms | 0.0% | 0us | `captureSync` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\bridge.ts:23` |
| 0.1% | 13.6ms | 0.0% | 0us | `get workspaceID` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace-context.ts:21` |
| 0.1% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\bridge.ts:57` |
| 0.1% | 13.6ms | 0.0% | 0us | `use` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\local-context.ts:15` |
| 0.1% | 13.5ms | 0.1% | 13.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` |
| 0.1% | 13.5ms | 0.0% | 0us | `returning` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:256` |
| 0.1% | 13.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:152` |
| 0.1% | 13.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\sql.ts:110` |
| 0.1% | 13.4ms | 0.1% | 13.4ms | `ForeignKeyBuilder` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\foreign-keys.js:13` |
| 0.1% | 13.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:34` |
| 0.1% | 13.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:29` |
| 0.1% | 13.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:40` |
| 0.1% | 13.4ms | 0.0% | 0us | `ascending` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts:13` |
| 0.1% | 13.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2221` |
| 0.1% | 13.4ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\id\id.ts:69` |
| 0.1% | 13.4ms | 0.1% | 13.4ms | `toString` | `[native code]` |
| 0.1% | 13.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:7` |
| 0.1% | 13.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Element.js:18` |
| 0.1% | 13.3ms | 0.1% | 13.3ms | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` |
| 0.1% | 13.3ms | 0.0% | 0us | `findLast` | `[native code]` |
| 0.1% | 13.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1140` |
| 0.1% | 13.3ms | 0.0% | 0us | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:58` |
| 0.1% | 13.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:18` |
| 0.1% | 13.2ms | 0.1% | 13.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts` |
| 0.1% | 13.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1647` |
| 0.1% | 13.2ms | 0.1% | 13.2ms | `fail` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\result.js:70` |
| 0.1% | 13.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1061` |
| 0.1% | 13.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1157` |
| 0.1% | 13.1ms | 0.0% | 0us | `transaction` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:196` |
| 0.1% | 13.0ms | 0.1% | 13.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js` |
| 0.1% | 13.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:883` |
| 0.1% | 13.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:4440` |
| 0.1% | 13.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+code-frame@7.29.7\node_modules\@babel\code-frame\lib\index.js:5` |
| 0.1% | 13.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:9` |
| 0.1% | 13.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\v1\session.ts:223` |
| 0.1% | 12.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:552` |
| 0.1% | 12.9ms | 0.1% | 12.9ms | `stringField` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:118` |
| 0.1% | 12.9ms | 0.0% | 0us | `workerDelegation` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:201` |
| 0.1% | 12.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2938` |
| 0.1% | 12.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:76` |
| 0.1% | 12.8ms | 0.1% | 12.8ms | `assertOneOf` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js` |
| 0.1% | 12.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:869` |
| 0.1% | 12.5ms | 0.0% | 0us | `checkHits` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:151` |
| 0.1% | 12.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1029` |
| 0.1% | 12.3ms | 0.0% | 0us | `rememberText` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:133` |
| 0.1% | 12.3ms | 0.1% | 12.3ms | `push` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\text-tail.ts` |
| 0.1% | 12.3ms | 0.0% | 0us | `push` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:255` |
| 0.1% | 12.1ms | 0.1% | 12.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:129` |
| 0.1% | 12.0ms | 0.1% | 12.0ms | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` |
| 0.1% | 11.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:557` |
| 0.1% | 10.7ms | 0.0% | 0us | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:65` |
| 0.1% | 10.7ms | 0.1% | 10.7ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` |
| 0.1% | 9.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:365` |
| 0.1% | 9.7ms | 0.1% | 9.7ms | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:196` |
| 0.1% | 9.1ms | 0.1% | 9.1ms | `usage` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:58` |
| 0.1% | 9.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:142` |
| 0.0% | 5.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1856` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `parse` | `[native code]` |
| 0.0% | 4.7ms | 0.0% | 899us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:85` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1121` |
| 0.0% | 2.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\index.js:10` |
| 0.0% | 2.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:8` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1269` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:9` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:8` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `entries` | `[native code]` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:598` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\matchesPattern.js:7` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\buildMatchMemberExpression.js:7` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\react\isReactComponent.js:7` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\run-state.ts` |
| 0.0% | 1.9ms | 0.0% | 1.1ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:33` |
| 0.0% | 1.9ms | 0.0% | 0us | `onSuccess` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpEffect.js:49` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7839` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:3` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1256` |
| 0.0% | 1.8ms | 0.0% | 0us | `async transform` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2294` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:9` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` |
| 0.0% | 1.8ms | 0.0% | 0us | `values` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:155` |
| 0.0% | 1.8ms | 0.0% | 0us | `onPipeChunkDeferredWrite` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1127` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+proxy-addr@5.1.0\node_modules\@fastify\proxy-addr\index.js:27` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\internal\utils.js:29` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` |
| 0.0% | 1.1ms | 0.0% | 0us | `define` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:88` |
| 0.0% | 1.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-status-event.ts:51` |
| 0.0% | 1.1ms | 0.0% | 0us | `escapeHtml` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\html.ts:5` |
| 0.0% | 1.1ms | 0.0% | 0us | `fmt` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:438` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:129` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:442` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `replaceAll` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:51` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\normalize-and-load-metadata.js:11` |
| 0.0% | 1.1ms | 0.0% | 0us | `interruptUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:398` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:312` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1614` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Text.js:6` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:434` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:291` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:803` |
| 0.0% | 1.0ms | 0.0% | 0us | `resolveTools` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:251` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:175` |
| 0.0% | 1.0ms | 0.0% | 0us | `every` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `fullyDenied` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` |
| 0.0% | 1.0ms | 0.0% | 0us | `disabled` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:355` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:40183` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:39880` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `dlopen` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `Literal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1419` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\models-dev.ts:20` |
| 0.0% | 1.0ms | 0.0% | 0us | `parse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `D` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 0us | `fromGlob` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 0us | `async load` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\plugin.ts:21` |
| 0.0% | 1.0ms | 0.0% | 0us | `async load` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\plugin.ts:29` |
| 0.0% | 1.0ms | 0.0% | 0us | `n` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:355` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\validation\options.js:9` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `functionDeclarationCommon` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:328` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `inlineLocalReferences` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:202` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` |
| 0.0% | 1.0ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:227` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1271` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `SQLiteEffectPreparedQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:81` |
| 0.0% | 1.0ms | 0.0% | 0us | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:62` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\common\html.js:510` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:9` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\browser.js:11` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1349` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:41907` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `observe` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `setup` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js:14` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `spadTelemetry` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1030` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `join` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:435` |
| 0.0% | 1.0ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:27` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:275` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1262` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:128` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\format\index.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:201` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\node\index.js:8` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\index.js:8` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\node\HostDetector.js:10` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:652` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:713` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:24` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:783` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:3921` |
| 0.0% | 1.0ms | 0.0% | 0us | `collectIssues` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2813` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:138284` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2244` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:541` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 1.0ms | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2342` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:544` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:302` |
| 0.0% | 1.0ms | 0.0% | 0us | `span` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:229` |
| 0.0% | 1.0ms | 0.0% | 0us | `NativeSpan` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:276` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\task-closure.ts:156` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\ComponentLogger.js:19` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\platform\index.js:28` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:804` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\internal\global-utils.js:19` |
| 0.0% | 1.0ms | 0.0% | 0us | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:107600` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:24` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:768` |
| 0.0% | 1.0ms | 0.0% | 0us | `set` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:187` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `fromEntries` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `async flush` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6834` |
| 0.0% | 1.0ms | 0.0% | 0us | `onPipeWritesFinishedForShutdown` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async flush` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6787` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:492` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:103` |
| 0.0% | 998us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:7` |
| 0.0% | 998us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:37` |
| 0.0% | 998us | 0.0% | 998us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\linkedMap.js:16` |
| 0.0% | 997us | 0.0% | 0us | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2081` |
| 0.0% | 997us | 0.0% | 0us | `currentDispatcher` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:367` |
| 0.0% | 997us | 0.0% | 997us | `makeDispatcher` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:116` |
| 0.0% | 996us | 0.0% | 996us | `createDebug` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` |
| 0.0% | 995us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:588` |
| 0.0% | 995us | 0.0% | 995us | `closeAllContent` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:444` |
| 0.0% | 994us | 0.0% | 0us | `reduce` | `[native code]` |
| 0.0% | 994us | 0.0% | 994us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:177` |
| 0.0% | 994us | 0.0% | 0us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:153` |
| 0.0% | 993us | 0.0% | 993us | `encodeUnknownSync` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1183` |
| 0.0% | 984us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:59` |
| 0.0% | 984us | 0.0% | 0us | `(anonymous)` | `node:_http_server:321` |
| 0.0% | 984us | 0.0% | 984us | `closeIdleConnections` | `[native code]` |
| 0.0% | 984us | 0.0% | 984us | `onPipeShutdownActionFulfilled` | `[native code]` |
| 0.0% | 983us | 0.0% | 0us | `SQLiteColumn` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:53` |
| 0.0% | 983us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\sql.ts:46` |
| 0.0% | 983us | 0.0% | 0us | `Column` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:36` |
| 0.0% | 983us | 0.0% | 0us | `SQLiteText` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:22` |
| 0.0% | 983us | 0.0% | 0us | `build` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:15` |
| 0.0% | 983us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:28` |
| 0.0% | 983us | 0.0% | 983us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:59` |
| 0.0% | 982us | 0.0% | 0us | `_destroy` | `internal:streams/destroy:63` |
| 0.0% | 982us | 0.0% | 0us | `#onClose` | `node:_http_server:986` |
| 0.0% | 982us | 0.0% | 0us | `destroy` | `internal:streams/destroy:41` |
| 0.0% | 982us | 0.0% | 0us | `out` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7275` |
| 0.0% | 982us | 0.0% | 0us | `(anonymous)` | `internal:streams/writable:601` |
| 0.0% | 982us | 0.0% | 982us | `_destroy` | `node:_http_server:1016` |
| 0.0% | 977us | 0.0% | 977us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` |
| 0.0% | 977us | 0.0% | 977us | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:119` |
| 0.0% | 976us | 0.0% | 0us | `fromJsonSchema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:84` |
| 0.0% | 975us | 0.0% | 975us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\worktree\index.ts` |
| 0.0% | 973us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\nopt@9.0.0\node_modules\nopt\lib\nopt-lib.js:1` |
| 0.0% | 973us | 0.0% | 973us | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` |
| 0.0% | 973us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:839` |
| 0.0% | 973us | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` |
| 0.0% | 973us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` |
| 0.0% | 972us | 0.0% | 972us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:157` |
| 0.0% | 972us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1261` |
| 0.0% | 965us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\_md.js:5` |
| 0.0% | 962us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:59` |
| 0.0% | 962us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:100` |
| 0.0% | 962us | 0.0% | 962us | `getTableColumnsRuntime` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:22` |
| 0.0% | 962us | 0.0% | 0us | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:289` |
| 0.0% | 962us | 0.0% | 0us | `mapUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:57` |
| 0.0% | 960us | 0.0% | 960us | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:542` |
| 0.0% | 959us | 0.0% | 959us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:797` |
| 0.0% | 959us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:771` |
| 0.0% | 957us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\quota\schema.ts:57` |
| 0.0% | 955us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1692` |
| 0.0% | 955us | 0.0% | 0us | `toCodecJson` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7836` |
| 0.0% | 955us | 0.0% | 955us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:576` |
| 0.0% | 955us | 0.0% | 0us | `rebuild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1691` |
| 0.0% | 955us | 0.0% | 0us | `getSuccessResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:152` |
| 0.0% | 955us | 0.0% | 0us | `transformResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:266` |
| 0.0% | 955us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:555` |
| 0.0% | 955us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:75` |
| 0.0% | 955us | 0.0% | 0us | `toCodecJsonBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7878` |
| 0.0% | 955us | 0.0% | 0us | `sort` | `[native code]` |
| 0.0% | 955us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:76` |
| 0.0% | 955us | 0.0% | 0us | `mapOrSame` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2393` |
| 0.0% | 951us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:6` |
| 0.0% | 950us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\utils\debug.js:4` |
| 0.0% | 949us | 0.0% | 949us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts` |
| 0.0% | 947us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:669` |
| 0.0% | 946us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\util.js:24` |
| 0.0% | 946us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\tokenizer.js:23` |
| 0.0% | 945us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:96` |
| 0.0% | 945us | 0.0% | 945us | `escapeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` |
| 0.0% | 944us | 0.0% | 944us | `query` | `bun:sqlite:342` |
| 0.0% | 944us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:271` |
| 0.0% | 944us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1120` |
| 0.0% | 941us | 0.0% | 941us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:736` |
| 0.0% | 939us | 0.0% | 939us | `values` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:151` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2563` |
| 0.0% | 939us | 0.0% | 0us | `Objects` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` |
| 0.0% | 939us | 0.0% | 0us | `rebuild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1701` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:802` |
| 0.0% | 939us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\scheduled-task.ts:128` |
| 0.0% | 936us | 0.0% | 0us | `activeGrantEntries` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:870` |
| 0.0% | 936us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:798` |
| 0.0% | 936us | 0.0% | 936us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` |
| 0.0% | 934us | 0.0% | 934us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.0% | 932us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1142` |
| 0.0% | 928us | 0.0% | 0us | `get OPENCODE_SEAL_PRUNE` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\flag\flag.ts:65` |
| 0.0% | 928us | 0.0% | 928us | `performProxyObjectGetByVal` | `[native code]` |
| 0.0% | 928us | 0.0% | 0us | `truthy` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\flag\flag.ts:4` |
| 0.0% | 928us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1297` |
| 0.0% | 925us | 0.0% | 925us | `notNull` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column-builder.js:51` |
| 0.0% | 925us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:8` |
| 0.0% | 925us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\account\sql.ts:30` |
| 0.0% | 919us | 0.0% | 0us | `invalidateAllImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:449` |
| 0.0% | 918us | 0.0% | 918us | `locatedKey` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1077` |
| 0.0% | 918us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1474` |
| 0.0% | 916us | 0.0% | 916us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3300` |
| 0.0% | 913us | 0.0% | 913us | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` |
| 0.0% | 913us | 0.0% | 913us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\job.ts` |
| 0.0% | 912us | 0.0% | 0us | `_parse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:826` |
| 0.0% | 912us | 0.0% | 0us | `async safeParseJSON` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2258` |
| 0.0% | 912us | 0.0% | 0us | `secureJsonParse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:865` |
| 0.0% | 912us | 0.0% | 0us | `async safeParseJSON` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2268` |
| 0.0% | 909us | 0.0% | 0us | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:545` |
| 0.0% | 908us | 0.0% | 908us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js:8` |
| 0.0% | 908us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js:1079` |
| 0.0% | 905us | 0.0% | 905us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` |
| 0.0% | 904us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:255` |
| 0.0% | 903us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\mcp\browser.ts:11` |
| 0.0% | 903us | 0.0% | 903us | `constant` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:225` |
| 0.0% | 903us | 0.0% | 0us | `succeedContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:494` |
| 0.0% | 903us | 0.0% | 903us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js` |
| 0.0% | 903us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js:7` |
| 0.0% | 902us | 0.0% | 902us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.0% | 901us | 0.0% | 0us | `createDebug` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js:118` |
| 0.0% | 901us | 0.0% | 901us | `selectColor` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` |
| 0.0% | 900us | 0.0% | 900us | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:8` |
| 0.0% | 900us | 0.0% | 900us | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 900us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:95` |
| 0.0% | 900us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\websocket-tracker.ts:15` |
| 0.0% | 898us | 0.0% | 898us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:233` |
| 0.0% | 897us | 0.0% | 0us | `finalize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1586` |
| 0.0% | 897us | 0.0% | 0us | `interruptUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:389` |
| 0.0% | 897us | 0.0% | 0us | `causeInterrupt` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:55` |
| 0.0% | 897us | 0.0% | 897us | `async transform` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2290` |
| 0.0% | 897us | 0.0% | 0us | `failCauseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:641` |
| 0.0% | 897us | 0.0% | 0us | `Interrupt` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:33` |
| 0.0% | 896us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:52` |
| 0.0% | 895us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:150` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts:66` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\recovery.ts` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\ResourceImpl.js:9` |
| 0.0% | 892us | 0.0% | 892us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1119` |
| 0.0% | 889us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:46576` |
| 0.0% | 889us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1148` |
| 0.0% | 884us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:46` |
| 0.0% | 882us | 0.0% | 882us | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` |
| 0.0% | 881us | 0.0% | 0us | `toArray` | `[native code]` |
| 0.0% | 881us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\api.ts:76` |
| 0.0% | 881us | 0.0% | 881us | `Literal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1421` |
| 0.0% | 881us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\api.ts:72` |
| 0.0% | 879us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:473` |
| 0.0% | 876us | 0.0% | 876us | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:333` |
| 0.0% | 874us | 0.0% | 0us | `readableAddChunkPushByteMode` | `internal:streams/readable:242` |
| 0.0% | 874us | 0.0% | 0us | `onDataIncomingMessage` | `internal:http:81` |
| 0.0% | 874us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6868` |
| 0.0% | 874us | 0.0% | 874us | `write` | `[native code]` |
| 0.0% | 874us | 0.0% | 874us | `optionalKey` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.0% | 873us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:42` |
| 0.0% | 872us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1057` |
| 0.0% | 872us | 0.0% | 0us | `onRSDefaultControllerPullFulfilled` | `[native code]` |
| 0.0% | 872us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1056` |
| 0.0% | 872us | 0.0% | 872us | `async pull` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6873` |
| 0.0% | 870us | 0.0% | 870us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:503` |
| 0.0% | 870us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1119` |
| 0.0% | 867us | 0.0% | 0us | `async postToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2436` |
| 0.0% | 867us | 0.0% | 867us | `fetch` | `[native code]` |
| 0.0% | 867us | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:219` |
| 0.0% | 867us | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:226` |
| 0.0% | 867us | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2380` |
| 0.0% | 867us | 0.0% | 0us | `async postJsonToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2335` |
| 0.0% | 866us | 0.0% | 866us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1750` |
| 0.0% | 866us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\scheduled-task.ts:272` |
| 0.0% | 864us | 0.0% | 0us | `handleResponse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:394` |
| 0.0% | 864us | 0.0% | 0us | `(anonymous)` | `node:_http_server:2096` |
| 0.0% | 864us | 0.0% | 864us | `setHeader` | `node:_http_outgoing:394` |
| 0.0% | 864us | 0.0% | 0us | `_writeHead` | `node:_http_server:1270` |
| 0.0% | 862us | 0.0% | 0us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:378` |
| 0.0% | 862us | 0.0% | 862us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 862us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:770` |
| 0.0% | 862us | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:362` |
| 0.0% | 862us | 0.0% | 0us | `buildUpdateQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:62` |
| 0.0% | 862us | 0.0% | 0us | `buildUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 860us | 0.0% | 860us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:321` |
| 0.0% | 842us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:150` |
| 0.0% | 842us | 0.0% | 842us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:160` |
| 0.0% | 833us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:810` |
| 0.0% | 833us | 0.0% | 833us | `makeOption` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:92` |

## Function Details

### `anonymous`
`[native code]` | Self: 19.8% (1.59s) | Total: 77.2% (6.20s) | Samples: 86

**Called by:**
- `require` (430)
- `bound require` (1)

**Calls:**
- `(anonymous)` (15)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` | Self: 6.3% (513.5ms) | Total: 6.3% (513.5ms) | Samples: 59

**Called by:**
- `(anonymous)` (21)
- `runLoop` (11)
- `exit` (8)
- `scopeClose` (3)
- `scopeAddFinalizerExit` (3)
- `(anonymous)` (2)
- `callback` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `memoMapReuse` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` | Self: 5.9% (477.6ms) | Total: 5.9% (477.6ms) | Samples: 4

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `readdirSync`
`[native code]` | Self: 3.9% (318.8ms) | Total: 7.9% (637.7ms) | Samples: 1

**Called by:**
- `readdirSync` (1)
- `readdirSync` (1)

**Calls:**
- `readdirSync` (1)

### `Map`
`[native code]` | Self: 3.9% (316.8ms) | Total: 3.9% (316.8ms) | Samples: 42

**Called by:**
- `withMapUnsafe` (28)
- `scopeAddFinalizerUnsafe` (14)

### `runLoop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` | Self: 3.1% (249.3ms) | Total: 100.0% (24.17s) | Samples: 27

**Called by:**
- `evaluate` (2826)

**Calls:**
- `~effect/Effect/evaluate` (1363)
- `~effect/Effect/evaluate` (896)
- `~effect/Effect/successCont` (115)
- `~effect/Effect/successCont` (62)
- `(anonymous)` (43)
- `(anonymous)` (37)
- `~effect/Effect/evaluate` (31)
- `(anonymous)` (28)
- `(anonymous)` (28)
- `(anonymous)` (25)
- `(anonymous)` (15)
- `(anonymous)` (13)
- `(anonymous)` (11)
- `(anonymous)` (8)
- `~effect/Effect/evaluate` (8)
- `(anonymous)` (8)
- `~effect/Effect/successCont` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `~effect/Effect/evaluate` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `~effect/Effect/successCont` (5)
- `~effect/Effect/successCont` (5)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `~effect/Effect/successCont` (2)
- `(anonymous)` (2)
- `onSuccess` (2)
- `~effect/Effect/successCont` (2)
- `(anonymous)` (2)
- `pipeArguments` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `evaluate` (1)
- `~effect/Effect/evaluate` (1)
- `invalidateAllImpl` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` | Self: 2.3% (192.7ms) | Total: 100.0% (10.72s) | Samples: 4

**Called by:**
- `generatorResume` (1267)

**Calls:**
- `forkUnsafe` (1252)
- `forkUnsafe` (7)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `forkUnsafe` (1)

### `all`
`[native code]` | Self: 2.1% (172.6ms) | Total: 2.1% (172.6ms) | Samples: 25

**Called by:**
- `(anonymous)` (25)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` | Self: 2.1% (171.0ms) | Total: 3.1% (256.9ms) | Samples: 25

**Called by:**
- `generatorResume` (37)

**Calls:**
- `from` (12)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:31` | Self: 1.6% (133.3ms) | Total: 2.0% (166.2ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `optional` (1)
- `(module)` (1)

**Calls:**
- `makeEffect` (4)
- `makeEffect` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` | Self: 1.6% (129.9ms) | Total: 1.6% (129.9ms) | Samples: 19

**Called by:**
- `(anonymous)` (14)
- `runLoop` (3)
- `(anonymous)` (2)

### `values`
`[native code]` | Self: 1.5% (120.8ms) | Total: 1.5% (120.8ms) | Samples: 12

**Called by:**
- `(anonymous)` (12)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` | Self: 1.1% (92.8ms) | Total: 1.1% (92.8ms) | Samples: 13

**Called by:**
- `(anonymous)` (13)

### `stringify`
`[native code]` | Self: 1.1% (91.0ms) | Total: 1.1% (91.0ms) | Samples: 12

**Called by:**
- `async postJsonToApi` (6)
- `isTitleRequest` (4)
- `(anonymous)` (1)
- `checkHits` (1)

### `statSync`
`[native code]` | Self: 1.1% (90.6ms) | Total: 1.3% (105.7ms) | Samples: 10

**Called by:**
- `L` (10)
- `statSync` (1)

**Calls:**
- `statSync` (1)

### `arrayFromFastWithoutMapFn`
`[native code]` | Self: 0.9% (73.8ms) | Total: 0.9% (73.8ms) | Samples: 10

**Called by:**
- `from` (10)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` | Self: 0.9% (72.7ms) | Total: 1.0% (88.2ms) | Samples: 4

**Called by:**
- `runLoop` (8)

**Calls:**
- `getCont` (3)
- `getCont` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` | Self: 0.7% (62.8ms) | Total: 0.7% (62.8ms) | Samples: 9

**Called by:**
- `~effect/Effect/successCont` (5)
- `~effect/Effect/successCont` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `advanceResponsePipeline`
`node:_http_server:1535` | Self: 0.7% (62.6ms) | Total: 0.7% (62.6ms) | Samples: 1

**Called by:**
- `emitResponseFinish` (1)

### `Arrays`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1223` | Self: 0.7% (61.3ms) | Total: 0.7% (61.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` | Self: 0.6% (55.7ms) | Total: 0.6% (55.7ms) | Samples: 6

**Called by:**
- `finalizer` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.5% (46.8ms) | Total: 0.5% (46.8ms) | Samples: 6

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (1)
- `evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:91` | Self: 0.5% (46.5ms) | Total: 0.5% (46.5ms) | Samples: 1

**Called by:**
- `forEach` (1)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` | Self: 0.5% (46.1ms) | Total: 0.5% (46.1ms) | Samples: 4

**Called by:**
- `scopeForkUnsafe` (3)
- `(anonymous)` (1)

### `map`
`[native code]` | Self: 0.5% (44.6ms) | Total: 6.9% (561.0ms) | Samples: 3

**Called by:**
- `buildQueryFromSourceParams` (28)
- `inlineLocalReferences` (11)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `I` (2)
- `(anonymous)` (2)
- `struct` (2)
- `sqliteTableBase` (2)
- `Literals` (2)
- `values` (2)
- `compile` (2)
- `map` (1)
- `make` (1)
- `(anonymous)` (1)
- `mapUpdateSet` (1)
- `(anonymous)` (1)
- `Objects` (1)
- `getSuccessResponse` (1)

**Calls:**
- `buildQueryFromSourceParams` (15)
- `(anonymous)` (11)
- `recur` (5)
- `buildQueryFromSourceParams` (3)
- `inlineLocalReferences` (2)
- `(anonymous)` (2)
- `buildQueryFromSourceParams` (2)
- `(anonymous)` (2)
- `mapResultRow` (2)
- `(anonymous)` (1)
- `recur` (1)
- `map` (1)
- `mergeQueries` (1)
- `(anonymous)` (1)
- `parse` (1)
- `(anonymous)` (1)
- `inlineLocalReferences` (1)
- `(anonymous)` (1)
- `transformResponse` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `Literal` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `gen`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` | Self: 0.5% (44.5ms) | Total: 0.5% (44.5ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `transaction` (1)
- `queryWithCache` (1)

### `Error`
`[native code]` | Self: 0.5% (40.9ms) | Total: 0.5% (40.9ms) | Samples: 3

**Called by:**
- `(anonymous)` (2)
- `NotFound` (1)

### `prepare`
`[native code]` | Self: 0.4% (40.1ms) | Total: 0.4% (40.1ms) | Samples: 6

**Called by:**
- `[prepareOwned]` (6)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` | Self: 0.4% (32.8ms) | Total: 0.6% (48.2ms) | Samples: 4

**Called by:**
- `forkUnsafe` (5)

**Calls:**
- `setContext` (1)

### `Base`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:360` | Self: 0.3% (32.0ms) | Total: 0.3% (32.0ms) | Samples: 1

**Called by:**
- `Base` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` | Self: 0.3% (32.0ms) | Total: 0.3% (32.0ms) | Samples: 5

**Called by:**
- `runLoop` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts` | Self: 0.3% (31.6ms) | Total: 0.3% (31.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` | Self: 0.3% (31.2ms) | Total: 0.3% (31.2ms) | Samples: 6

**Called by:**
- `generatorResume` (6)

### `#resumeSocket`
`node:_http_server:1079` | Self: 0.3% (31.2ms) | Total: 0.3% (31.2ms) | Samples: 1

**Called by:**
- `_read` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` | Self: 0.3% (31.2ms) | Total: 3.0% (245.2ms) | Samples: 7

**Called by:**
- `scopeCloseUnsafe` (19)
- `runLoop` (15)

**Calls:**
- `(anonymous)` (21)
- `(anonymous)` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` | Self: 0.3% (30.8ms) | Total: 0.3% (30.8ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getReferenceUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` | Self: 0.3% (30.4ms) | Total: 0.3% (30.4ms) | Samples: 2

**Called by:**
- `getRef` (1)
- `makeSpanUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` | Self: 0.3% (30.0ms) | Total: 0.3% (30.0ms) | Samples: 2

**Called by:**
- `currentTimeNanosUnsafe` (2)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` | Self: 0.3% (29.8ms) | Total: 1.5% (120.8ms) | Samples: 2

**Called by:**
- `scopeForkUnsafe` (16)

**Calls:**
- `Map` (14)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` | Self: 0.3% (29.7ms) | Total: 0.3% (29.7ms) | Samples: 2

**Called by:**
- `buildSelectQuery` (1)
- `_prepare` (1)

### `flatMap`
`[native code]` | Self: 0.3% (29.6ms) | Total: 0.3% (29.6ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `orderSelectedFields` (1)

### `from`
`[native code]` | Self: 0.3% (29.4ms) | Total: 1.2% (104.3ms) | Samples: 4

**Called by:**
- `(anonymous)` (12)
- `create` (3)

**Calls:**
- `arrayFromFastWithoutMapFn` (10)
- `(anonymous)` (1)

### `getCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:469` | Self: 0.3% (29.2ms) | Total: 0.3% (29.2ms) | Samples: 2

**Called by:**
- `~effect/Effect/evaluate` (1)
- `~effect/Effect/evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` | Self: 0.3% (29.2ms) | Total: 0.3% (29.2ms) | Samples: 2

**Called by:**
- `evaluate` (1)
- `(anonymous)` (1)

### `inlineLocalReferences`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:197` | Self: 0.3% (29.0ms) | Total: 0.3% (29.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `map` (1)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` | Self: 0.3% (28.3ms) | Total: 0.7% (58.3ms) | Samples: 2

**Called by:**
- `go` (6)

**Calls:**
- `(anonymous)` (4)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` | Self: 0.3% (27.7ms) | Total: 0.3% (27.7ms) | Samples: 4

**Called by:**
- `(anonymous)` (4)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.3% (27.5ms) | Total: 0.3% (27.5ms) | Samples: 3

**Called by:**
- `forkUnsafe` (3)

### `get`
`[native code]` | Self: 0.3% (26.8ms) | Total: 0.3% (26.8ms) | Samples: 2

**Called by:**
- `require` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` | Self: 0.3% (26.4ms) | Total: 0.3% (26.4ms) | Samples: 4

**Called by:**
- `(anonymous)` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` | Self: 0.3% (25.9ms) | Total: 0.3% (25.9ms) | Samples: 3

**Called by:**
- `(anonymous)` (2)
- `runLoop` (1)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` | Self: 0.3% (25.0ms) | Total: 100.0% (18.58s) | Samples: 4

**Called by:**
- `(anonymous)` (1252)
- `go` (845)
- `(anonymous)` (28)
- `(anonymous)` (5)
- `invalidateAllImpl` (1)

**Calls:**
- `evaluate` (2127)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` | Self: 0.2% (18.1ms) | Total: 0.2% (20.0ms) | Samples: 4

**Called by:**
- `~effect/Effect/evaluate` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (2)

### `copyDataProperties`
`[native code]` | Self: 0.2% (17.7ms) | Total: 0.2% (17.7ms) | Samples: 3

**Called by:**
- `out` (1)
- `(anonymous)` (1)
- `partData` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` | Self: 0.2% (17.6ms) | Total: 0.2% (17.6ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:1494` | Self: 0.2% (17.1ms) | Total: 0.2% (17.1ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\tracer.js:18` | Self: 0.2% (17.0ms) | Total: 0.2% (17.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `mergeQueries`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` | Self: 0.2% (16.8ms) | Total: 0.2% (16.8ms) | Samples: 3

**Called by:**
- `buildQueryFromSourceParams` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` | Self: 0.2% (16.8ms) | Total: 0.2% (16.8ms) | Samples: 3

**Called by:**
- `makeEffect` (2)
- `run` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` | Self: 0.2% (16.5ms) | Total: 0.5% (42.9ms) | Samples: 2

**Called by:**
- `runLoop` (6)

**Calls:**
- `(anonymous)` (4)

### `create`
`[native code]` | Self: 0.2% (16.3ms) | Total: 0.2% (16.3ms) | Samples: 2

**Called by:**
- `optionalKey` (2)

### `runLoop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:435` | Self: 0.1% (16.0ms) | Total: 0.1% (16.0ms) | Samples: 1

**Called by:**
- `evaluate` (1)

### `mergeAllEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` | Self: 0.1% (16.0ms) | Total: 0.9% (76.3ms) | Samples: 2

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `scopeForkUnsafe` (3)
- `scopeForkUnsafe` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1150` | Self: 0.1% (15.9ms) | Total: 0.1% (15.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` | Self: 0.1% (15.9ms) | Total: 0.3% (31.1ms) | Samples: 1

**Called by:**
- `mergeAllEffect` (1)
- `pipeArguments` (1)

**Calls:**
- `(anonymous)` (1)

### `forEach`
`[native code]` | Self: 0.1% (15.9ms) | Total: 1.6% (130.5ms) | Samples: 2

**Called by:**
- `mergeAll` (5)
- `mapResultRow` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:77` | Self: 0.1% (15.9ms) | Total: 0.1% (15.9ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:501` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1196` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` | Self: 0.1% (15.8ms) | Total: 0.5% (42.0ms) | Samples: 1

**Called by:**
- `getOrElseMemoize` (4)

**Calls:**
- `(anonymous)` (3)

### `exists`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js:308` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` | Self: 0.1% (15.7ms) | Total: 3.6% (296.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (13)
- `runLoop` (7)

**Calls:**
- `mergeAllEffect` (7)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `mergeAllEffect` (2)
- `(anonymous)` (1)

### `schema`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` | Self: 0.1% (15.7ms) | Total: 0.1% (15.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `StringChunk`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:48` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `sql` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:748` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:249` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `n`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `orderSelectedFields`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:42` | Self: 0.1% (15.5ms) | Total: 0.3% (29.1ms) | Samples: 1

**Called by:**
- `_prepare` (1)
- `returning` (1)

**Calls:**
- `flatMap` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:890` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1399` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\deadline-owner.ts` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `makeProto`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiGroup.js:86` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:133` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 2

**Called by:**
- `ReasonBase` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` | Self: 0.1% (15.4ms) | Total: 1.0% (86.1ms) | Samples: 1

**Called by:**
- `onItem` (8)
- `runLoop` (1)

**Calls:**
- `scopeForkUnsafe` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `localeCompare`
`[native code]` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `toSorted` (1)

### `getOwnPropertyDescriptors`
`[native code]` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 2

**Called by:**
- `modifyOwnPropertyDescriptors` (2)

### `assign`
`[native code]` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `buildQueryFromSourceParams` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:239` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `union`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1763` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `Union` (1)

### `importModule`
`[native code]` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 2

**Called by:**
- `(module)` (1)
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2126` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `handler` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts:373` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:677` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1540` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `latest`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:2129` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:163` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `map` (1)

### `createScanner`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` | Self: 0.1% (15.1ms) | Total: 100.0% (11.41s) | Samples: 3

**Called by:**
- `runLoop` (1363)

**Calls:**
- `(anonymous)` (1360)

### `mergeAllEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` | Self: 0.1% (15.1ms) | Total: 0.3% (31.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1845` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `callback`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` | Self: 0.1% (15.1ms) | Total: 0.2% (17.0ms) | Samples: 1

**Called by:**
- `fiberAwaitAll` (3)

**Calls:**
- `(anonymous)` (2)

### `finalizer`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:132` | Self: 0.1% (15.0ms) | Total: 0.8% (70.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `(anonymous)` (6)

### `[Symbol.iterator]`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `createJoin`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:115` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` | Self: 0.1% (15.0ms) | Total: 6.1% (496.4ms) | Samples: 2

**Called by:**
- `(anonymous)` (28)
- `(anonymous)` (22)
- `(anonymous)` (10)
- `(anonymous)` (6)
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (19)
- `fromIteratorEagerUnsafe` (12)
- `onItem` (8)
- `onItem` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (3)
- `fromIteratorEagerUnsafe` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:824` | Self: 0.1% (15.0ms) | Total: 0.9% (75.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (7)
- `go` (1)

**Calls:**
- `fromIteratorEagerUnsafe` (7)

### `ensureChunkDB`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\chunkdb.ts` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `emitUpdated`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\ofxp\capability.ts` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `generatorResume` (1)

### `bound strict`
`[native code]` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:4` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `SQLiteEffectSelectBase` (1)

### `mergeQueries`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `map` (1)

### `getOrElseMemoize`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` | Self: 0.1% (14.9ms) | Total: 2.8% (225.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (12)

**Calls:**
- `get` (6)
- `(anonymous)` (4)
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\project\directories.ts` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:45` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `flatIntoArrayWithCallback` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1869` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `releaseLock`
`[native code]` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `async cleanup` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `get value` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:713` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` | Self: 0.1% (14.8ms) | Total: 0.3% (29.6ms) | Samples: 1

**Called by:**
- `forEach` (1)
- `withMapUnsafe` (1)

**Calls:**
- `forEach` (1)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` | Self: 0.1% (14.8ms) | Total: 1.1% (92.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (7)
- `go` (4)

**Calls:**
- `FiberImpl` (5)
- `FiberImpl` (3)
- `FiberImpl` (1)
- `FiberImpl` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:65` | Self: 0.1% (14.8ms) | Total: 0.3% (29.6ms) | Samples: 1

**Called by:**
- `filter` (1)
- `generatorResume` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1006` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `fromIteratorEagerUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:157` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `getOrElseMemoize` (1)

### `hostname`
`[native code]` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `scopeAddFinalizerExit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` | Self: 0.1% (14.6ms) | Total: 1.9% (152.7ms) | Samples: 2

**Called by:**
- `memoMapReuse` (5)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:811` | Self: 0.1% (14.5ms) | Total: 0.1% (14.5ms) | Samples: 1

**Called by:**
- `go` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6941` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

### `part`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:106` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `hydrateRows` (1)

### `resolve`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:716` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` | Self: 0.1% (14.3ms) | Total: 4.7% (382.0ms) | Samples: 1

**Called by:**
- `go` (19)
- `runLoop` (6)
- `(anonymous)` (4)
- `~effect/Effect/successCont` (1)

**Calls:**
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (2)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` | Self: 0.1% (14.2ms) | Total: 0.1% (14.2ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `custom`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` | Self: 0.1% (14.1ms) | Total: 0.1% (14.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `getTableLikeName`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:230` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `SQLiteSelectQueryBuilderBase` (1)

### `runLoop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:430` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `evaluate` (1)

### `hydrateRows`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:117` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `and`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` | Self: 0.1% (13.9ms) | Total: 0.3% (29.3ms) | Samples: 2

**Called by:**
- `map` (3)

**Calls:**
- `assign` (1)

### `Me`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `sliding`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PubSub.js` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:86` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `executeTransactionStatement` (1)

### `onServerConnection`
`node:_http_server:668` | Self: 0.1% (13.7ms) | Total: 0.1% (13.7ms) | Samples: 1

### `isStreamSchema`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js` | Self: 0.1% (13.6ms) | Total: 0.1% (13.6ms) | Samples: 1

**Called by:**
- `validateSuccessResponse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\attributes.js:29` | Self: 0.1% (13.6ms) | Total: 0.1% (13.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1404` | Self: 0.1% (13.6ms) | Total: 0.1% (13.6ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` | Self: 0.1% (13.5ms) | Total: 0.1% (13.5ms) | Samples: 2

**Called by:**
- `getCont` (2)

### `queryWithCache`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:260` | Self: 0.1% (13.5ms) | Total: 0.3% (29.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `gen` (1)

### `ForeignKeyBuilder`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\foreign-keys.js:13` | Self: 0.1% (13.4ms) | Total: 0.1% (13.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `toString`
`[native code]` | Self: 0.1% (13.4ms) | Total: 0.1% (13.4ms) | Samples: 1

**Called by:**
- `create` (1)

### `[Symbol.iterator]`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` | Self: 0.1% (13.3ms) | Total: 0.1% (13.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1115` | Self: 0.1% (13.3ms) | Total: 0.3% (29.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts` | Self: 0.1% (13.2ms) | Total: 0.1% (13.2ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `fail`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\result.js:70` | Self: 0.1% (13.2ms) | Total: 0.1% (13.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js` | Self: 0.1% (13.0ms) | Total: 0.1% (13.0ms) | Samples: 1

**Called by:**
- `~effect/Effect/successCont` (1)

### `stringField`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:118` | Self: 0.1% (12.9ms) | Total: 0.1% (12.9ms) | Samples: 1

**Called by:**
- `workerDelegation` (1)

### `assertOneOf`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js` | Self: 0.1% (12.8ms) | Total: 0.1% (12.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `push`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\text-tail.ts` | Self: 0.1% (12.3ms) | Total: 0.1% (12.3ms) | Samples: 1

**Called by:**
- `rememberText` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:129` | Self: 0.1% (12.1ms) | Total: 0.1% (12.1ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `SQL`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` | Self: 0.1% (12.0ms) | Total: 0.1% (12.0ms) | Samples: 1

**Called by:**
- `sql` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3819` | Self: 0.1% (11.3ms) | Total: 0.2% (22.6ms) | Samples: 1

**Called by:**
- `generatorResume` (1)
- `findLast` (1)

**Calls:**
- `findLast` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` | Self: 0.1% (10.7ms) | Total: 0.1% (10.7ms) | Samples: 1

**Called by:**
- `SQL` (1)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:196` | Self: 0.1% (9.7ms) | Total: 0.1% (9.7ms) | Samples: 1

**Called by:**
- `map` (1)

### `usage`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:58` | Self: 0.1% (9.1ms) | Total: 0.1% (9.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `parse`
`[native code]` | Self: 0.0% (5.7ms) | Total: 0.0% (5.7ms) | Samples: 6

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `_parse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `generatorResume` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `forEach` (3)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `fromIteratorEagerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` | Self: 0.0% (2.6ms) | Total: 0.2% (17.4ms) | Samples: 3

**Called by:**
- `go` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `runLoop` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `go` (2)

### `entries`
`[native code]` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `buildInsertQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` | Self: 0.0% (2.0ms) | Total: 0.2% (23.6ms) | Samples: 2

**Called by:**
- `runLoop` (8)
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (2)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\run-state.ts` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\internal\utils.js:29` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `flatIntoArrayWithCallback` (2)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:33` | Self: 0.0% (1.1ms) | Total: 0.0% (1.9ms) | Samples: 1

**Called by:**
- `define` (1)
- `(module)` (1)

**Calls:**
- `makeOption` (1)

### `replaceAll`
`[native code]` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `escapeHtml` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:312` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1614` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `onConflictDoUpdate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:291` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `match`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:39880` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `dlopen`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` | Self: 0.0% (1.0ms) | Total: 0.1% (15.9ms) | Samples: 1

**Called by:**
- `make` (2)

**Calls:**
- `makeEffect` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `n` (1)

### `functionDeclarationCommon`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` | Self: 0.0% (1.0ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `map` (2)

**Calls:**
- `is` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1512` | Self: 0.0% (1.0ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `generatorResume` (2)

**Calls:**
- `[Symbol.iterator]` (1)

### `inlineLocalReferences`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:202` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `onSuccess` (1)

### `SQLiteEffectPreparedQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:81` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `prepareQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\common\html.js:510` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `filter`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.2% (17.7ms) | Samples: 1

**Called by:**
- `disabled` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `buildUpdateSet` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `every` (1)

### `observe`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `spadTelemetry`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `join`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `create` (1)

### `onConflictDoUpdate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:275` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:128` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\format\index.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:713` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:24` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `from` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:3921` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `scopeForkUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `loop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:541` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:302` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `NativeSpan` (1)

### `loop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:544` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:265` | Self: 0.0% (1.0ms) | Total: 1.4% (119.7ms) | Samples: 1

**Called by:**
- `getFrom` (5)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `_prepare` (12)
- `_prepare` (2)
- `_prepare` (1)

### `fromEntries`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `set` (1)

### `async flush`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6787` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `async flush` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:492` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\linkedMap.js:16` | Self: 0.0% (998us) | Total: 0.0% (998us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `makeDispatcher`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:116` | Self: 0.0% (997us) | Total: 0.0% (997us) | Samples: 1

**Called by:**
- `currentDispatcher` (1)

### `createDebug`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` | Self: 0.0% (996us) | Total: 0.0% (996us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` | Self: 0.0% (995us) | Total: 0.6% (50.8ms) | Samples: 1

**Called by:**
- `run` (8)
- `get` (1)

**Calls:**
- `(anonymous)` (6)
- `sql` (1)
- `buildInsertQuery` (1)

### `closeAllContent`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:444` | Self: 0.0% (995us) | Total: 0.0% (995us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:177` | Self: 0.0% (994us) | Total: 0.0% (994us) | Samples: 1

**Called by:**
- `reduce` (1)

### `encodeUnknownSync`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1183` | Self: 0.0% (993us) | Total: 0.0% (993us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` | Self: 0.0% (988us) | Total: 98.8% (7.94s) | Samples: 1

**Called by:**
- `(anonymous)` (850)

**Calls:**
- `forkUnsafe` (845)
- `forkUnsafe` (4)

### `onPipeShutdownActionFulfilled`
`[native code]` | Self: 0.0% (984us) | Total: 0.0% (984us) | Samples: 1

### `closeIdleConnections`
`[native code]` | Self: 0.0% (984us) | Total: 0.0% (984us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:59` | Self: 0.0% (983us) | Total: 0.0% (983us) | Samples: 1

**Called by:**
- `Column` (1)

### `_destroy`
`node:_http_server:1016` | Self: 0.0% (982us) | Total: 0.0% (982us) | Samples: 1

**Called by:**
- `_destroy` (1)

### `from`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:119` | Self: 0.0% (977us) | Total: 0.0% (977us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` | Self: 0.0% (977us) | Total: 0.0% (977us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\worktree\index.ts` | Self: 0.0% (975us) | Total: 0.0% (975us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `match`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` | Self: 0.0% (973us) | Total: 0.0% (973us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:157` | Self: 0.0% (972us) | Total: 0.0% (972us) | Samples: 1

**Called by:**
- `map` (1)

### `getTableColumnsRuntime`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:22` | Self: 0.0% (962us) | Total: 0.0% (962us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `loop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:542` | Self: 0.0% (960us) | Total: 0.0% (960us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:797` | Self: 0.0% (959us) | Total: 0.0% (959us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:576` | Self: 0.0% (955us) | Total: 0.0% (955us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts` | Self: 0.0% (949us) | Total: 0.0% (949us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `getCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` | Self: 0.0% (946us) | Total: 0.1% (14.5ms) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (3)

**Calls:**
- `(anonymous)` (2)

### `escapeName`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` | Self: 0.0% (945us) | Total: 0.0% (945us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `query`
`bun:sqlite:342` | Self: 0.0% (944us) | Total: 0.0% (944us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:736` | Self: 0.0% (941us) | Total: 0.0% (941us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `values`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:151` | Self: 0.0% (939us) | Total: 0.0% (939us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` | Self: 0.0% (936us) | Total: 0.0% (936us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` | Self: 0.0% (934us) | Total: 0.0% (934us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `withMapUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:846` | Self: 0.0% (928us) | Total: 2.8% (226.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (16)
- `(anonymous)` (13)

**Calls:**
- `Map` (28)

### `performProxyObjectGetByVal`
`[native code]` | Self: 0.0% (928us) | Total: 0.0% (928us) | Samples: 1

**Called by:**
- `truthy` (1)

### `notNull`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column-builder.js:51` | Self: 0.0% (925us) | Total: 0.0% (925us) | Samples: 1

**Called by:**
- `(module)` (1)

### `locatedKey`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1077` | Self: 0.0% (918us) | Total: 0.0% (918us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3300` | Self: 0.0% (916us) | Total: 0.0% (916us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\job.ts` | Self: 0.0% (913us) | Total: 0.0% (913us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` | Self: 0.0% (913us) | Total: 0.0% (913us) | Samples: 1

**Called by:**
- `forkUnsafe` (1)

### `next`
`[native code]` | Self: 0.0% (909us) | Total: 100.0% (12.19s) | Samples: 1

**Called by:**
- `(anonymous)` (1360)
- `~effect/Effect/successCont` (96)
- `fromIteratorEagerUnsafe` (7)
- `loop` (1)

**Calls:**
- `generatorResume` (1463)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js:8` | Self: 0.0% (908us) | Total: 0.0% (908us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` | Self: 0.0% (905us) | Total: 0.0% (905us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js` | Self: 0.0% (903us) | Total: 0.0% (903us) | Samples: 1

**Called by:**
- `forEach` (1)

### `constant`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:225` | Self: 0.0% (903us) | Total: 0.0% (903us) | Samples: 1

**Called by:**
- `succeedContext` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:78` | Self: 0.0% (902us) | Total: 1.7% (139.6ms) | Samples: 1

**Called by:**
- `~effect/Effect/successCont` (7)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `provideServiceImpl` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (14)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` | Self: 0.0% (902us) | Total: 0.0% (902us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `selectColor`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` | Self: 0.0% (901us) | Total: 0.0% (901us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:8` | Self: 0.0% (900us) | Total: 0.0% (900us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `setPrototypeDirectOrThrow`
`[native code]` | Self: 0.0% (900us) | Total: 0.0% (900us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` | Self: 0.0% (899us) | Total: 0.0% (4.7ms) | Samples: 1

**Called by:**
- `bound ` (5)

**Calls:**
- `loop` (1)
- `loop` (1)
- `loop` (1)
- `loop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:233` | Self: 0.0% (898us) | Total: 0.0% (898us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `async transform`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2290` | Self: 0.0% (897us) | Total: 0.0% (897us) | Samples: 1

**Called by:**
- `onPipeChunkDeferredWrite` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\recovery.ts` | Self: 0.0% (894us) | Total: 0.0% (894us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts:66` | Self: 0.0% (894us) | Total: 0.0% (894us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1119` | Self: 0.0% (892us) | Total: 0.0% (892us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `getCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` | Self: 0.0% (882us) | Total: 0.0% (882us) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1)

### `Literal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1421` | Self: 0.0% (881us) | Total: 0.0% (881us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` | Self: 0.0% (877us) | Total: 5.1% (413.6ms) | Samples: 1

**Called by:**
- `runLoop` (62)

**Calls:**
- `(anonymous)` (55)
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:333` | Self: 0.0% (876us) | Total: 0.0% (876us) | Samples: 1

**Called by:**
- `forkUnsafe` (1)

### `write`
`[native code]` | Self: 0.0% (874us) | Total: 0.0% (874us) | Samples: 1

**Called by:**
- `readableAddChunkPushByteMode` (1)

### `optionalKey`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` | Self: 0.0% (874us) | Total: 0.0% (874us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async pull`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6873` | Self: 0.0% (872us) | Total: 0.0% (872us) | Samples: 1

**Called by:**
- `onRSDefaultControllerPullFulfilled` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:503` | Self: 0.0% (870us) | Total: 0.0% (870us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `fetch`
`[native code]` | Self: 0.0% (867us) | Total: 0.0% (867us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1750` | Self: 0.0% (866us) | Total: 0.0% (866us) | Samples: 1

**Called by:**
- `map` (1)

### `setHeader`
`node:_http_outgoing:394` | Self: 0.0% (864us) | Total: 0.0% (864us) | Samples: 1

**Called by:**
- `_writeHead` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` | Self: 0.0% (862us) | Total: 0.0% (862us) | Samples: 1

**Called by:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:321` | Self: 0.0% (860us) | Total: 0.0% (860us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:160` | Self: 0.0% (842us) | Total: 0.0% (842us) | Samples: 1

**Called by:**
- `map` (1)

### `makeOption`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:92` | Self: 0.0% (833us) | Total: 0.0% (833us) | Samples: 1

**Called by:**
- `make` (1)

### `fullyDenied`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `every` (1)

**Calls:**
- `findLast` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:142` | Self: 0.0% (0us) | Total: 0.1% (9.1ms) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `usage` (1)

### `_traverse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:196` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Called by:**
- `get` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml.js:5` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `SQLiteText`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:22` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `build` (1)

**Calls:**
- `SQLiteColumn` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:87` | Self: 0.0% (0us) | Total: 1.4% (116.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (13)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1142` | Self: 0.0% (0us) | Total: 0.0% (932us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `stringify` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:964` | Self: 0.0% (0us) | Total: 2.7% (220.7ms) | Samples: 0

**Called by:**
- `evaluate` (32)

**Calls:**
- `onExit` (32)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2106` | Self: 0.0% (0us) | Total: 2.1% (175.0ms) | Samples: 0

**Called by:**
- `runLoop` (28)

**Calls:**
- `forkUnsafe` (28)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:137` | Self: 0.0% (0us) | Total: 0.3% (28.4ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `hydrateRows` (1)
- `hydrateRows` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `findLast` (1)

**Calls:**
- `match` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2244` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `collectIssues` (1)

**Calls:**
- `(anonymous)` (1)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:23` | Self: 0.0% (0us) | Total: 0.2% (18.4ms) | Samples: 0

**Called by:**
- `create` (3)

**Calls:**
- `from` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2417` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:21` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1030` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `spadTelemetry` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\builder.js:8` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` | Self: 0.0% (0us) | Total: 3.7% (305.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (46)

**Calls:**
- `(anonymous)` (46)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:59` | Self: 0.0% (0us) | Total: 0.0% (984us) | Samples: 0

**Called by:**
- `bound ` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\utils\debug.js:4` | Self: 0.0% (0us) | Total: 0.0% (950us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1.js:5` | Self: 0.0% (0us) | Total: 0.7% (60.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:947` | Self: 0.0% (0us) | Total: 0.5% (47.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `(anonymous)` (8)

### `validateSuccessResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:167` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `getSuccessResponse` (1)

**Calls:**
- `isStreamSchema` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:6` | Self: 0.0% (0us) | Total: 0.3% (30.5ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:7` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\DOMImplementation.js:4` | Self: 0.0% (0us) | Total: 0.3% (29.1ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:4` | Self: 0.0% (0us) | Total: 1.4% (119.9ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1057` | Self: 0.0% (0us) | Total: 0.0% (872us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `copyDataProperties` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:76` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `sort` (1)

**Calls:**
- `(anonymous)` (1)

### `findLast`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `evaluate` (1)
- `fullyDenied` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `ascending`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts:13` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `create` (1)

### `loop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:545` | Self: 0.0% (0us) | Total: 0.0% (909us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `next` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` | Self: 0.0% (0us) | Total: 1.3% (107.7ms) | Samples: 0

**Called by:**
- `runLoop` (8)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `whichSync`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:89` | Self: 0.0% (0us) | Total: 1.1% (90.6ms) | Samples: 0

**Called by:**
- `which` (10)

**Calls:**
- `L` (10)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:40` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:7` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:101` | Self: 0.0% (0us) | Total: 0.3% (27.9ms) | Samples: 0

**Calls:**
- `_template` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:679` | Self: 0.0% (0us) | Total: 1.5% (125.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (17)

**Calls:**
- `withMapUnsafe` (16)
- `withMapUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts:27` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `pipeArguments` (1)

### `toSorted`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `localeCompare` (1)

### `partData`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:107` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `copyDataProperties` (1)

### `createDebug`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js:118` | Self: 0.0% (0us) | Total: 0.0% (901us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `selectColor` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeStream.js:142` | Self: 0.0% (0us) | Total: 0.3% (32.0ms) | Samples: 0

**Called by:**
- `emit` (7)

**Calls:**
- `(anonymous)` (7)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` | Self: 0.0% (0us) | Total: 1.5% (121.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)
- `(anonymous)` (6)
- `mergeAllEffect` (3)

**Calls:**
- `scopeAddFinalizerUnsafe` (16)
- `scopeAddFinalizerUnsafe` (1)

### `Literals`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2138` | Self: 0.0% (0us) | Total: 0.3% (31.8ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `map` (2)

### `resolveFile`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:96` | Self: 0.0% (0us) | Total: 3.9% (318.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `readdirSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\defineElement.js:16` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:150` | Self: 0.0% (0us) | Total: 0.0% (895us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `isTitleRequest`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:86` | Self: 0.0% (0us) | Total: 0.5% (40.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `checkHits` (1)

**Calls:**
- `stringify` (4)

### `failCauseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:641` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `finalize` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1328` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `optional` (2)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (3)
- `Union` (1)
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:656` | Self: 0.0% (0us) | Total: 17.5% (1.41s) | Samples: 0

**Called by:**
- `runTasks` (176)

**Calls:**
- `evaluate` (176)

### `interruptUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:389` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `causeInterrupt` (1)

### `causeInterrupt`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:55` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `interruptUnsafe` (1)

**Calls:**
- `Interrupt` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` | Self: 0.0% (0us) | Total: 100.0% (11.39s) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1360)

**Calls:**
- `next` (1360)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:51` | Self: 0.0% (0us) | Total: 0.2% (17.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `nullable` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\usage.ts:76` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Calls:**
- `makeProto` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3812` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `latest` (1)

### `endReadableNT`
`internal:streams/readable:901` | Self: 0.0% (0us) | Total: 0.3% (32.0ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (7)

**Calls:**
- `emit` (7)

### `use`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\local-context.ts:15` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `get workspaceID` (1)

**Calls:**
- `NotFound` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1117` | Self: 0.0% (0us) | Total: 3.0% (248.3ms) | Samples: 0

**Called by:**
- `runLoop` (28)

**Calls:**
- `(anonymous)` (17)
- `(anonymous)` (6)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:19` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1261` | Self: 0.0% (0us) | Total: 0.0% (972us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `values` (1)

### `set`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:187` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `fromEntries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:497` | Self: 0.0% (0us) | Total: 0.5% (45.7ms) | Samples: 0

**Called by:**
- `generatorResume` (4)

**Calls:**
- `fromSchema` (2)
- `schema` (1)
- `fromJsonSchema` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:977` | Self: 0.0% (0us) | Total: 0.2% (17.9ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `getFrom` (3)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:199` | Self: 0.0% (0us) | Total: 0.6% (54.9ms) | Samples: 0

**Called by:**
- `map` (5)

**Calls:**
- `(anonymous)` (5)

### `onPipeChunkDeferredWrite`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Calls:**
- `async transform` (1)
- `async transform` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\v1\session.ts:223` | Self: 0.0% (0us) | Total: 0.1% (13.0ms) | Samples: 0

**Calls:**
- `Struct` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:273` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:813` | Self: 0.0% (0us) | Total: 0.2% (17.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\vapid-helper.js:4` | Self: 0.0% (0us) | Total: 0.7% (60.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:17` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:46576` | Self: 0.0% (0us) | Total: 0.0% (889us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:186` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:221` | Self: 0.0% (0us) | Total: 0.3% (29.5ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `queryWithCache` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:691` | Self: 0.0% (0us) | Total: 0.2% (16.6ms) | Samples: 0

**Called by:**
- `bound ` (2)

**Calls:**
- `~effect/Utils/internal` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\node\index.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `Column`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:36` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `SQLiteColumn` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\server.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1141` | Self: 0.0% (0us) | Total: 0.6% (48.8ms) | Samples: 0

**Called by:**
- `generatorResume` (9)

**Calls:**
- `(anonymous)` (8)
- `encodeUnknownSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\route.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1269` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `run` (2)

### `truthy`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\flag\flag.ts:4` | Self: 0.0% (0us) | Total: 0.0% (928us) | Samples: 0

**Called by:**
- `get OPENCODE_SEAL_PRUNE` (1)

**Calls:**
- `performProxyObjectGetByVal` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:86` | Self: 0.0% (0us) | Total: 0.1% (16.0ms) | Samples: 0

**Called by:**
- `flatIntoArrayWithCallback` (1)

**Calls:**
- `is` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\quota\schema.ts:57` | Self: 0.0% (0us) | Total: 0.0% (957us) | Samples: 0

**Calls:**
- `make` (1)

### `afterScheduled`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:140` | Self: 0.0% (0us) | Total: 23.4% (1.88s) | Samples: 0

**Calls:**
- `runTasks` (236)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:9` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1271` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `reduce`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (994us) | Samples: 0

**Called by:**
- `buildSelectQuery` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\mcp.ts:79` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `finalize`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1586` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `failCauseUnsafe` (1)

**Calls:**
- `(anonymous)` (1)

### `sqliteTableBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:25` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:804` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `run` (1)

### `SQLiteEffectSelectBase`
`[native code]` | Self: 0.0% (0us) | Total: 0.5% (44.0ms) | Samples: 0

**Called by:**
- `from` (3)

**Calls:**
- `SQLiteSelectQueryBuilderBase` (1)
- `(anonymous)` (1)
- `SQLiteSelectQueryBuilderBase` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\picomatch@2.3.2\node_modules\picomatch\lib\picomatch.js:5` | Self: 0.0% (0us) | Total: 0.7% (60.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1647` | Self: 0.0% (0us) | Total: 0.1% (13.2ms) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (1)

**Calls:**
- `fail` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\react\isReactComponent.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:333` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `_prepare` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:10` | Self: 0.0% (0us) | Total: 0.3% (26.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\api.ts:72` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `Literal` (1)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` | Self: 0.0% (0us) | Total: 0.3% (31.0ms) | Samples: 0

**Called by:**
- `mergeAllEffect` (2)
- `(anonymous)` (1)

**Calls:**
- `scopeAddFinalizerUnsafe` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (16.6ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `n` (1)
- `D` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\request.js:3` | Self: 0.0% (0us) | Total: 0.2% (17.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `which`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\which.ts:8` | Self: 0.0% (0us) | Total: 1.1% (90.6ms) | Samples: 0

**Called by:**
- `async AzureAuthPlugin` (4)
- `gitbash` (3)
- `win` (2)
- `~effect/Effect/evaluate` (1)

**Calls:**
- `whichSync` (10)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\task-closure.ts:156` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Command.js:6` | Self: 0.0% (0us) | Total: 2.2% (180.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:14` | Self: 0.0% (0us) | Total: 0.7% (64.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `ZodNullable` (1)
- `ZodObject` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1110` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `optional` (1)

**Calls:**
- `ZodOptional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1119` | Self: 0.0% (0us) | Total: 0.0% (870us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `setContext` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@parcel+watcher@2.5.1\node_modules\@parcel\watcher\wrapper.js:2` | Self: 0.0% (0us) | Total: 0.7% (60.9ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`node:_http_server:2096` | Self: 0.0% (0us) | Total: 0.0% (864us) | Samples: 0

**Called by:**
- `handleResponse` (1)

**Calls:**
- `_writeHead` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:498` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `FiberImpl` (1)

**Calls:**
- `getRef` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:75` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `toCodecJsonBase` (1)

**Calls:**
- `sort` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:39806` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:8` | Self: 0.0% (0us) | Total: 0.0% (925us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1655` | Self: 0.0% (0us) | Total: 1.9% (155.2ms) | Samples: 0

**Called by:**
- `generatorResume` (22)

**Calls:**
- `go` (22)

### `releaseTakers`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1451` | Self: 0.0% (0us) | Total: 3.7% (298.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (43)

**Calls:**
- `(anonymous)` (43)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:73` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1626` | Self: 0.0% (0us) | Total: 0.6% (50.5ms) | Samples: 0

**Called by:**
- `runLoop` (7)

**Calls:**
- `(anonymous)` (7)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2335` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getReferenceUnsafe` (1)

### `compile`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:269` | Self: 0.0% (0us) | Total: 0.3% (25.7ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `map` (2)

### `async Je`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (16.6ms) | Samples: 0

**Called by:**
- `async scan` (2)

**Calls:**
- `I` (2)

### `ReasonBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:137` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `Interrupt` (1)
- `Die` (1)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\modification.js:18` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `Info`
`[native code]` | Self: 0.0% (0us) | Total: 0.2% (16.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `out` (2)
- `out` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:156` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `executeTransactionStatement` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\picomatch@2.3.2\node_modules\picomatch\index.js:3` | Self: 0.0% (0us) | Total: 0.7% (60.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\index.js:2` | Self: 0.0% (0us) | Total: 0.3% (29.1ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `getFrom`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:880` | Self: 0.0% (0us) | Total: 0.3% (30.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)

**Calls:**
- `get` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\msgpackr@2.0.2\node_modules\msgpackr\node-index.js:16` | Self: 0.0% (0us) | Total: 3.9% (320.8ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:41` | Self: 0.0% (0us) | Total: 0.3% (31.4ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `query`
`bun:sqlite:348` | Self: 0.0% (0us) | Total: 0.4% (40.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (2)

**Calls:**
- `[prepareOwned]` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:103` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `onPipeWritesFinishedForShutdown`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `async flush` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:10` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:171` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `sql` (1)

### `bound `
`[native code]` | Self: 0.0% (0us) | Total: 100.0% (8.28s) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (896)

**Calls:**
- `(anonymous)` (878)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:652` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:15` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:793` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `currentTurnUploads` (1)

### `buildUpdateQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:62` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `buildUpdateSet` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:839` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `evaluate` (1)

### `inlineLocalReferences`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:218` | Self: 0.0% (0us) | Total: 2.1% (173.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)
- `map` (2)
- `fromSchema` (2)
- `fromJsonSchema` (1)

**Calls:**
- `map` (11)

### `modifyOwnPropertyDescriptors`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2300` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `optionalKey` (1)

**Calls:**
- `getOwnPropertyDescriptors` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1134` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `object` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:152` | Self: 0.0% (0us) | Total: 0.1% (13.5ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `returning` (1)

### `async AzureAuthPlugin`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\azure.ts:21` | Self: 0.0% (0us) | Total: 0.3% (30.1ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (4)

**Calls:**
- `which` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:333` | Self: 0.0% (0us) | Total: 1.4% (116.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (13)

**Calls:**
- `withMapUnsafe` (13)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:76` | Self: 0.0% (0us) | Total: 0.1% (12.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `assertOneOf` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:60` | Self: 0.0% (0us) | Total: 3.9% (318.8ms) | Samples: 0

**Called by:**
- `load` (1)

**Calls:**
- `resolveFile` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:372` | Self: 0.0% (0us) | Total: 3.7% (298.8ms) | Samples: 0

**Called by:**
- `runLoop` (43)

**Calls:**
- `releaseTakers` (43)

### `resolveTools`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:251` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `disabled` (1)

### `withMapUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:847` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:214` | Self: 0.0% (0us) | Total: 0.2% (16.7ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `Info` (3)

### `(anonymous)`
`[native code]` | Self: 0.0% (0us) | Total: 3.8% (307.0ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (46)
- `bound require` (1)
- `generatorResume` (1)

**Calls:**
- `async (anonymous)` (46)
- `(anonymous)` (1)
- `dlopen` (1)

### `[prepareOwned]`
`bun:sqlite:331` | Self: 0.0% (0us) | Total: 0.4% (40.1ms) | Samples: 0

**Called by:**
- `query` (6)

**Calls:**
- `prepare` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1256` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `memoMapReuse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` | Self: 0.0% (0us) | Total: 1.9% (153.6ms) | Samples: 0

**Called by:**
- `get` (6)

**Calls:**
- `scopeAddFinalizerExit` (5)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:6` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:171` | Self: 0.0% (0us) | Total: 2.2% (183.6ms) | Samples: 0

**Calls:**
- `bound require` (15)

### `every`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `fullyDenied` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:37` | Self: 0.0% (0us) | Total: 0.0% (998us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Element.js:18` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:6` | Self: 0.0% (0us) | Total: 0.2% (17.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\sql.ts:46` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Calls:**
- `sqliteTableBase` (1)

### `win`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:341` | Self: 0.0% (0us) | Total: 0.5% (45.4ms) | Samples: 0

**Called by:**
- `select` (5)

**Calls:**
- `gitbash` (3)
- `which` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1959` | Self: 0.0% (0us) | Total: 16.2% (1.30s) | Samples: 0

**Called by:**
- `evaluate` (137)

**Calls:**
- `(anonymous)` (137)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way@9.6.0\node_modules\find-my-way\index.js:30` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\errors.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\defaults.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `ZodObject`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `object` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\scope\index.js:10` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\nodes.js:7` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `exitDie`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:330` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `causeDie` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:196870` | Self: 0.0% (0us) | Total: 6.1% (495.9ms) | Samples: 0

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:8` | Self: 0.0% (0us) | Total: 0.2% (17.3ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:76` | Self: 0.0% (0us) | Total: 1.1% (96.0ms) | Samples: 0

**Called by:**
- `_prepare` (8)
- `_prepare` (6)

**Calls:**
- `buildQueryFromSourceParams` (13)
- `buildQueryFromSourceParams` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:101` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `runLoop` (3)

**Calls:**
- `query` (2)
- `query` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\index.js:14` | Self: 0.0% (0us) | Total: 0.2% (17.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Redis.js:6` | Self: 0.0% (0us) | Total: 2.2% (181.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\index.js:32` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `emit`
`node:events:103` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `onNodeHTTPRequest` (1)

**Calls:**
- `handler` (1)

### `_destroy`
`internal:streams/destroy:63` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `destroy` (1)

**Calls:**
- `_destroy` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts:125` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `ensureChunkDB` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:435` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`internal:streams/readable:351` | Self: 0.0% (0us) | Total: 0.3% (31.2ms) | Samples: 0

**Called by:**
- `resume_` (1)

**Calls:**
- `_read` (1)

### `guarded`
`internal:shared:112` | Self: 0.0% (0us) | Total: 6.2% (504.9ms) | Samples: 0

**Calls:**
- `(anonymous)` (57)
- `(anonymous)` (5)

### `normalizeWorkerDelegationModel`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:155` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `workerDelegation` (2)

**Calls:**
- `(anonymous)` (2)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:167` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Calls:**
- `_traverse` (4)

### `onConflictDoUpdate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:289` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `mapUpdateSet` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:552` | Self: 0.0% (0us) | Total: 0.1% (12.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1973` | Self: 0.0% (0us) | Total: 0.7% (61.3ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `Arrays` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:150` | Self: 0.0% (0us) | Total: 0.0% (842us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `values` (1)

### `escapeHtml`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\html.ts:5` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `replaceAll` (1)

### `async scan`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\glob.ts:24` | Self: 0.0% (0us) | Total: 0.2% (16.6ms) | Samples: 0

**Called by:**
- `async load` (1)
- `async loadMode` (1)

**Calls:**
- `async Je` (2)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:719` | Self: 0.0% (0us) | Total: 100.0% (8.28s) | Samples: 0

**Called by:**
- `runLoop` (896)

**Calls:**
- `bound ` (896)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1994` | Self: 0.0% (0us) | Total: 0.9% (76.2ms) | Samples: 0

**Called by:**
- `go` (8)

**Calls:**
- `(anonymous)` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1185` | Self: 0.0% (0us) | Total: 0.5% (47.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `(anonymous)` (8)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:100` | Self: 0.0% (0us) | Total: 0.3% (28.2ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:173` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1127` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:594` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `toSorted` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\browser.ts:1335` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `currentTurnUploads`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:225` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `all` (1)

### `fromGlob`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `parse` (1)

**Calls:**
- `n` (1)

### `onRSDefaultControllerPullFulfilled`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (872us) | Samples: 0

**Calls:**
- `async pull` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3063` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `custom` (1)

### `~effect/Utils/internal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` | Self: 0.0% (0us) | Total: 0.5% (47.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `async AzureAuthPlugin` (4)
- `async load` (1)
- `mapResultRow` (1)
- `async loadMode` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:4` | Self: 0.0% (0us) | Total: 0.3% (28.5ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:827` | Self: 0.0% (0us) | Total: 0.2% (17.1ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\utils\index.js:10` | Self: 0.0% (0us) | Total: 2.2% (180.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:27` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `create` (1)

**Calls:**
- `join` (1)

### `D`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `make` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:229` | Self: 0.0% (0us) | Total: 0.3% (30.5ms) | Samples: 0

**Called by:**
- `get` (2)

**Calls:**
- `flatIntoArrayWithCallback` (1)
- `orderSelectedFields` (1)

### `fromSchema`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:56` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `inlineLocalReferences` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:928` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `workerDelegation` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@6.0.1\node_modules\entities\dist\commonjs\decode.js:10` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\index.js:24` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:654` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1105` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:10` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\models-dev.ts:20` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `Literals` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha1.js:4` | Self: 0.0% (0us) | Total: 0.3% (31.4ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `getRef`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:370` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `setContext` (1)

**Calls:**
- `getReferenceUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:7` | Self: 0.0% (0us) | Total: 0.0% (998us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:9` | Self: 0.0% (0us) | Total: 0.3% (30.5ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:18` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `createHTMLParser`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:585` | Self: 0.0% (0us) | Total: 0.3% (29.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\utils\react\cleanJSXElementLiteralChild.js:7` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2221` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `ascending` (1)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2342` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `span` (1)

### `collectIssues`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2813` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `invalidateAllImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:449` | Self: 0.0% (0us) | Total: 0.0% (919us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `forkUnsafe` (1)

### `async postToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2436` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `async postJsonToApi` (1)

**Calls:**
- `async (anonymous)` (1)

### `interruptUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:398` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:269` | Self: 0.0% (0us) | Total: 5.1% (412.7ms) | Samples: 0

**Called by:**
- `guarded` (57)

**Calls:**
- `(anonymous)` (56)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:34` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `ForeignKeyBuilder` (1)

### `Struct`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1694` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `struct` (2)

### `fromIteratorEagerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:838` | Self: 0.0% (0us) | Total: 2.2% (184.3ms) | Samples: 0

**Called by:**
- `go` (12)
- `(anonymous)` (7)
- `(anonymous)` (6)

**Calls:**
- `generatorResume` (18)
- `next` (7)

### `provideServiceImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1149` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1610` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Calls:**
- `bound optional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1592` | Self: 0.0% (0us) | Total: 0.5% (42.3ms) | Samples: 0

**Called by:**
- `runLoop` (6)

**Calls:**
- `(anonymous)` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:107600` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `entries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:891` | Self: 0.0% (0us) | Total: 0.1% (14.2ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\validate.js:10` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `get OPENCODE_SEAL_PRUNE`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\flag\flag.ts:65` | Self: 0.0% (0us) | Total: 0.0% (928us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `truthy` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\validate\boolSchema.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\validation\options.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `handler`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:135` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `emit` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:8` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:50` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `SQL`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:65` | Self: 0.0% (0us) | Total: 0.1% (10.7ms) | Samples: 0

**Called by:**
- `sql` (1)

**Calls:**
- `is` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `findLast` (1)

### `emitResponseFinish`
`node:_http_server:1411` | Self: 0.0% (0us) | Total: 0.7% (62.6ms) | Samples: 0

**Called by:**
- `emit` (1)

**Calls:**
- `advanceResponsePipeline` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2127` | Self: 0.0% (0us) | Total: 3.9% (320.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (48)

**Calls:**
- `evaluate` (48)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:281` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:7` | Self: 0.0% (0us) | Total: 2.2% (180.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`node:_http_server:321` | Self: 0.0% (0us) | Total: 0.0% (984us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `closeIdleConnections` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:593` | Self: 0.0% (0us) | Total: 0.3% (29.1ms) | Samples: 0

**Calls:**
- `createHTMLParser` (4)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1983` | Self: 0.0% (0us) | Total: 0.2% (16.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:425` | Self: 0.0% (0us) | Total: 20.5% (1.65s) | Samples: 0

**Called by:**
- `(anonymous)` (189)

**Calls:**
- `(anonymous)` (137)
- `(anonymous)` (32)
- `(anonymous)` (17)
- `(anonymous)` (2)
- `(anonymous)` (1)

### `prepareQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:62` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `SQLiteEffectPreparedQuery` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:90` | Self: 0.0% (0us) | Total: 2.0% (166.1ms) | Samples: 0

**Called by:**
- `map` (15)
- `(anonymous)` (13)

**Calls:**
- `map` (28)

### `_template`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:203` | Self: 0.0% (0us) | Total: 0.3% (27.9ms) | Samples: 0

**Called by:**
- `get` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:38` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:138284` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `NativeSpan`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:276` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `span` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:6` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1284` | Self: 0.0% (0us) | Total: 0.2% (18.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(module)` (1)

**Calls:**
- `optionalKey` (3)
- `optionalKey` (1)

### `onDataIncomingMessage`
`internal:http:81` | Self: 0.0% (0us) | Total: 0.0% (874us) | Samples: 0

**Calls:**
- `readableAddChunkPushByteMode` (1)

### `checkHits`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:151` | Self: 0.0% (0us) | Total: 0.1% (12.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `isTitleRequest` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:8` | Self: 0.0% (0us) | Total: 0.2% (16.7ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:9` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1956` | Self: 0.0% (0us) | Total: 0.2% (16.1ms) | Samples: 0

**Called by:**
- `evaluate` (2)

**Calls:**
- `go` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\draft7.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:378` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `_prepare` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:518` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:92` | Self: 0.0% (0us) | Total: 2.1% (172.6ms) | Samples: 0

**Called by:**
- `runLoop` (25)

**Calls:**
- `all` (25)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:159` | Self: 0.0% (0us) | Total: 1.9% (153.6ms) | Samples: 0

**Called by:**
- `getOrElseMemoize` (6)

**Calls:**
- `memoMapReuse` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:798` | Self: 0.0% (0us) | Total: 0.0% (936us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `activeGrantEntries` (1)

### `mapUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:57` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `onConflictDoUpdate` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\string.js:8` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:91` | Self: 0.0% (0us) | Total: 0.1% (16.0ms) | Samples: 0

**Calls:**
- `compile` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:89` | Self: 0.0% (0us) | Total: 0.3% (26.0ms) | Samples: 0

**Called by:**
- `runLoop` (4)

**Calls:**
- `query` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\main.js:22` | Self: 0.0% (0us) | Total: 0.3% (29.4ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2179` | Self: 0.0% (0us) | Total: 3.9% (320.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (48)

**Calls:**
- `(anonymous)` (48)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:41907` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `filter` (1)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:13` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `define` (1)

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` | Self: 0.0% (0us) | Total: 3.3% (265.2ms) | Samples: 0

**Called by:**
- `runLoop` (37)

**Calls:**
- `scopeCloseUnsafe` (19)
- `scopeCloseUnsafe` (13)
- `scopeCloseUnsafe` (4)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1856` | Self: 0.0% (0us) | Total: 0.0% (5.9ms) | Samples: 0

**Called by:**
- `runLoop` (6)

**Calls:**
- `go` (6)

### `async safeParseJSON`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2258` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `async safeParseJSON` (1)

**Calls:**
- `secureJsonParse` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `D` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\core.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:109` | Self: 0.0% (0us) | Total: 0.4% (38.4ms) | Samples: 0

**Called by:**
- `flatIntoArrayWithCallback` (3)

**Calls:**
- `sql` (2)
- `sql` (1)

### `flatIntoArrayWithCallback`
`[native code]` | Self: 0.0% (0us) | Total: 0.8% (72.2ms) | Samples: 0

**Called by:**
- `buildSelection` (6)
- `_prepare` (1)
- `fmt` (1)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:47` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `bound optional`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `optional` (1)

### `L`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\isexe@4.0.0\node_modules\isexe\dist\commonjs\index.min.js:1` | Self: 0.0% (0us) | Total: 1.1% (90.6ms) | Samples: 0

**Called by:**
- `whichSync` (10)

**Calls:**
- `statSync` (10)

### `async load`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\plugin.ts:29` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (1)

**Calls:**
- `async load` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:261` | Self: 0.0% (0us) | Total: 0.6% (54.9ms) | Samples: 0

**Called by:**
- `recur` (5)

**Calls:**
- `map` (4)
- `flatMap` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\replacement.js:16` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `onNodeHTTPRequest`
`node:_http_server:586` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Calls:**
- `emit` (1)

### `out`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7275` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `Info` (1)

**Calls:**
- `copyDataProperties` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ManagedRuntime.js:124` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `exitDie` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1165` | Self: 0.0% (0us) | Total: 0.3% (29.8ms) | Samples: 0

**Called by:**
- `generatorResume` (4)

**Calls:**
- `get` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:4440` | Self: 0.0% (0us) | Total: 0.1% (13.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `pull`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:676` | Self: 0.0% (0us) | Total: 0.3% (28.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `findIndex` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6868` | Self: 0.0% (0us) | Total: 0.0% (874us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `emit`
`node:events:97` | Self: 0.0% (0us) | Total: 1.1% (94.6ms) | Samples: 0

**Called by:**
- `endReadableNT` (7)
- `emitResponseFinished` (1)

**Calls:**
- `(anonymous)` (7)
- `emitResponseFinish` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:725` | Self: 0.0% (0us) | Total: 0.7% (60.6ms) | Samples: 0

**Called by:**
- `onItem` (4)
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (7)

### `SQLiteSelectQueryBuilderBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:60` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `SQLiteEffectSelectBase` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:52` | Self: 0.0% (0us) | Total: 0.0% (896us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:6` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:434` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:705` | Self: 0.0% (0us) | Total: 0.3% (28.1ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `pull` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1349` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `observe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:32955` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `createScanner` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:685` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `buildUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `buildUpdateQuery` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:89` | Self: 0.0% (0us) | Total: 0.2% (22.8ms) | Samples: 0

**Called by:**
- `go` (5)
- `runLoop` (2)
- `(anonymous)` (1)

**Calls:**
- `scopeForkUnsafe` (6)
- `scopeForkUnsafe` (1)
- `scopeForkUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts:349` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\bootstrap.ts:50` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `gen` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\lowercase.js:263` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:170` | Self: 0.0% (0us) | Total: 0.3% (28.2ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `checkHits` (1)
- `checkHits` (1)

### `async transform`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2294` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `onPipeChunkDeferredWrite` (1)
- `async transform` (1)

**Calls:**
- `async safeParseJSON` (1)
- `async transform` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-modules-commonjs@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-modules-commonjs\lib\index.js:14` | Self: 0.0% (0us) | Total: 0.2% (16.7ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\oauth.js:28` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `hostname` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:473` | Self: 0.0% (0us) | Total: 0.0% (879us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\configuration.js:50` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\compile\validate\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:6` | Self: 0.0% (0us) | Total: 0.0% (951us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:104` | Self: 0.0% (0us) | Total: 1.6% (134.2ms) | Samples: 0

**Called by:**
- `runLoop` (13)

**Calls:**
- `values` (12)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:116` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `out` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+code-frame@7.29.7\node_modules\@babel\code-frame\lib\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (13.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async loadMode`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\agent.ts:36` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `async loadMode` (1)

**Calls:**
- `async scan` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\nopt@9.0.0\node_modules\nopt\lib\nopt-lib.js:1` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:9` | Self: 0.0% (0us) | Total: 0.1% (13.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:50` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `struct`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1749` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `Struct` (2)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:699` | Self: 0.0% (0us) | Total: 0.3% (30.1ms) | Samples: 0

**Called by:**
- `bound ` (4)

**Calls:**
- `~effect/Utils/internal` (4)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:255` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\tui-event.ts:40` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Calls:**
- `define` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:19` | Self: 0.0% (0us) | Total: 0.2% (16.9ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\websearch.ts:101` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Calls:**
- `make` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` | Self: 0.0% (0us) | Total: 11.4% (918.9ms) | Samples: 0

**Called by:**
- `runLoop` (115)

**Calls:**
- `next` (96)
- `generatorResume` (19)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `findLast` (1)

**Calls:**
- `match` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:201` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `Die`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:205` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `causeDie` (1)

**Calls:**
- `ReasonBase` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:215` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `doneUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:657` | Self: 0.0% (0us) | Total: 6.9% (558.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (55)
- `~effect/Effect/evaluate` (21)

**Calls:**
- `(anonymous)` (76)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:195` | Self: 0.0% (0us) | Total: 0.1% (14.2ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:3` | Self: 0.0% (0us) | Total: 0.7% (60.2ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `setup`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js:14` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `bound require` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:227` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `get` (1)

**Calls:**
- `prepareQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\traverse-node.js:7` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1120` | Self: 0.0% (0us) | Total: 0.0% (944us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\engines.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `load`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:28` | Self: 0.0% (0us) | Total: 3.9% (320.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\websocket-tracker.ts:15` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:2833` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `[Symbol.iterator]` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\msgpackr-extract@3.0.4\node_modules\msgpackr-extract\index.js:1` | Self: 0.0% (0us) | Total: 3.9% (320.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `load` (3)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:871` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2560` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `modifyOwnPropertyDescriptors` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:669` | Self: 0.0% (0us) | Total: 0.0% (947us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Calls:**
- `Me` (1)

### `toCodecJson`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7836` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `transformResponse` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:418` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:135` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `Base`
`[native code]` | Self: 0.0% (0us) | Total: 0.3% (32.0ms) | Samples: 0

**Called by:**
- `PlatformError` (1)

**Calls:**
- `Base` (1)

### `currentDispatcher`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:367` | Self: 0.0% (0us) | Total: 0.0% (997us) | Samples: 0

**Called by:**
- `forkUnsafe` (1)

**Calls:**
- `makeDispatcher` (1)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:14` | Self: 0.0% (0us) | Total: 0.2% (16.4ms) | Samples: 0

**Called by:**
- `define` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (2)

### `select`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:359` | Self: 0.0% (0us) | Total: 0.5% (45.4ms) | Samples: 0

**Called by:**
- `acceptable` (5)

**Calls:**
- `win` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1238` | Self: 0.0% (0us) | Total: 0.3% (30.5ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `get` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:783` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `collectIssues` (1)

### `async loadMode`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\agent.ts:58` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (1)

**Calls:**
- `async loadMode` (1)

### `processTicksAndRejections`
`[native code]` | Self: 0.0% (0us) | Total: 5.5% (446.8ms) | Samples: 0

**Calls:**
- `(anonymous)` (46)
- `endReadableNT` (7)
- `emitListeningNextTick` (1)
- `resume_` (1)
- `emitResponseFinished` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\models-dev.ts:16` | Self: 0.0% (0us) | Total: 0.3% (30.7ms) | Samples: 0

**Calls:**
- `Literals` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:226` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `async (anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2415` | Self: 0.0% (0us) | Total: 0.1% (16.0ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `makeSpanUnsafe` (1)
- `makeSpanUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:59` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `getTableColumnsRuntime` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:46` | Self: 0.0% (0us) | Total: 2.2% (183.6ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `_t` (15)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:145` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `normalizeWorkerDelegationModel` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2938` | Self: 0.0% (0us) | Total: 0.1% (12.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `workerDelegation` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:756` | Self: 0.0% (0us) | Total: 0.3% (29.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `go` (1)

**Calls:**
- `(anonymous)` (3)
- `fromIteratorEagerUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:85` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `forEach` (3)

**Calls:**
- `parse` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:7` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `buildInsertQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `entries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-preset-solid@1.9.12+2507c47859fdd5f5\node_modules\babel-preset-solid\index.js:1` | Self: 0.0% (0us) | Total: 0.4% (34.5ms) | Samples: 0

**Calls:**
- `bound require` (5)

### `async load`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\plugin.ts:21` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async load` (1)

**Calls:**
- `async scan` (1)

### `secureJsonParse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:865` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `async safeParseJSON` (1)

**Calls:**
- `_parse` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:320` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `getCont` (1)

### `async doStream`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:641` | Self: 0.0% (0us) | Total: 0.4% (34.5ms) | Samples: 0

**Calls:**
- `async postJsonToApi` (6)
- `async postJsonToApi` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:770` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `run` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:557` | Self: 0.0% (0us) | Total: 0.1% (11.7ms) | Samples: 0

**Called by:**
- `bound ` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\v1\question.ts:62` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Calls:**
- `define` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\section-matter@1.0.0\node_modules\section-matter\index.js:4` | Self: 0.0% (0us) | Total: 0.3% (28.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `_parse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:826` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `secureJsonParse` (1)

**Calls:**
- `parse` (1)

### `currentTimeNanosUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2499` | Self: 0.0% (0us) | Total: 0.3% (30.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3865` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1236` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1550` | Self: 0.0% (0us) | Total: 0.2% (19.4ms) | Samples: 0

**Called by:**
- `generatorResume` (4)

**Calls:**
- `create` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:29` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `map` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:219` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `fetch` (1)

### `emitListeningNextTick`
`node:_http_server:156` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (1)

**Calls:**
- `emit` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\account\sql.ts:30` | Self: 0.0% (0us) | Total: 0.0% (925us) | Samples: 0

**Calls:**
- `notNull` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:362` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `run` (1)

**Calls:**
- `buildUpdateQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:869` | Self: 0.0% (0us) | Total: 0.1% (12.6ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `get` (2)
- `from` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:626` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `getCont` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2380` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `async postToApi` (1)

**Calls:**
- `async (anonymous)` (1)

### `onSuccess`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpEffect.js:49` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (1)
- `handleResponse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:11` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:959` | Self: 0.0% (0us) | Total: 0.5% (45.2ms) | Samples: 0

**Called by:**
- `bound ` (5)

**Calls:**
- `forkUnsafe` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1140` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `pipeArguments` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:5` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `buildSelection`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:81` | Self: 0.0% (0us) | Total: 0.6% (56.2ms) | Samples: 0

**Called by:**
- `buildSelectQuery` (6)

**Calls:**
- `flatIntoArrayWithCallback` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2190` | Self: 0.0% (0us) | Total: 3.9% (320.6ms) | Samples: 0

**Called by:**
- `async (anonymous)` (46)
- `(module)` (2)

**Calls:**
- `(anonymous)` (48)

### `values`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:155` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:745` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `go` (3)

**Calls:**
- `(anonymous)` (3)

### `#onClose`
`node:_http_server:986` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `ZodOptional`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `optional` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1056` | Self: 0.0% (0us) | Total: 0.0% (872us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\node.js:7` | Self: 0.0% (0us) | Total: 0.3% (29.4ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\index.js:78` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` | Self: 0.0% (0us) | Total: 0.8% (70.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `finalizer` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\index.ts:1703` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `and` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `getStatusSuccess` (1)

**Calls:**
- `resolve` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1474` | Self: 0.0% (0us) | Total: 0.0% (918us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `locatedKey` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\index.js:4` | Self: 0.0% (0us) | Total: 2.2% (181.4ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:51` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\ResourceImpl.js:9` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1549` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `scopeAddFinalizerUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:95` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `is` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:723` | Self: 0.0% (0us) | Total: 63.3% (5.08s) | Samples: 0

**Called by:**
- `(anonymous)` (137)
- `doneUnsafe` (76)
- `(anonymous)` (65)
- `(anonymous)` (56)
- `releaseTakers` (43)
- `onExit` (32)
- `evaluate` (17)
- `(anonymous)` (7)
- `(anonymous)` (4)
- `go` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `finalize` (1)

**Calls:**
- `evaluate` (416)
- `evaluate` (189)

### `PlatformError`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PlatformError.js:109` | Self: 0.0% (0us) | Total: 0.3% (32.0ms) | Samples: 0

**Called by:**
- `systemError` (1)

**Calls:**
- `Base` (1)

### `get value`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js:33` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\id\id.ts:69` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Called by:**
- `ascending` (1)

**Calls:**
- `toString` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:355` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `optional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7839` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `toCodecJsonBase` (1)
- `rebuild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-hex-encoding@4.3.5\node_modules\@smithy\util-hex-encoding\dist-cjs\index.js:4` | Self: 0.0% (0us) | Total: 1.4% (119.9ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1029` | Self: 0.0% (0us) | Total: 0.1% (12.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `push` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\module-types.js:40` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:28` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `build` (1)

### `define`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:87` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `optional` (1)

### `acceptable`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:543` | Self: 0.0% (0us) | Total: 0.5% (45.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `select` (5)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-status-event.ts:51` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `define` (1)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:319` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `StringChunk` (1)

### `runTasks`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:150` | Self: 0.0% (0us) | Total: 23.4% (1.88s) | Samples: 0

**Called by:**
- `afterScheduled` (236)

**Calls:**
- `(anonymous)` (176)
- `evaluate` (60)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:218` | Self: 0.0% (0us) | Total: 2.1% (173.1ms) | Samples: 0

**Called by:**
- `map` (11)

**Calls:**
- `inlineLocalReferences` (6)
- `map` (3)
- `inlineLocalReferences` (1)
- `inlineLocalReferences` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\scheduled-task.ts:128` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Calls:**
- `make` (1)

### `hydrateRows`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:115` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `part` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:154` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `SQLiteSelectQueryBuilderBase` (1)

**Calls:**
- `createJoin` (1)

### `all`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:261` | Self: 0.0% (0us) | Total: 0.5% (47.0ms) | Samples: 0

**Called by:**
- `activeGrantEntries` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `currentTurnUploads` (1)

**Calls:**
- `_prepare` (4)

### `scopeClose`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` | Self: 0.0% (0us) | Total: 0.3% (29.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (3)

### `guarded`
`internal:shared:114` | Self: 0.0% (0us) | Total: 7.6% (615.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (65)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` | Self: 0.0% (0us) | Total: 1.3% (111.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)
- `(anonymous)` (5)
- `~effect/Effect/evaluate` (4)
- `(anonymous)` (1)

**Calls:**
- `mergeAll` (5)
- `(anonymous)` (4)
- `parse` (2)
- `map` (2)
- `mapResultRow` (1)
- `(anonymous)` (1)

### `fiberAwaitAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:536` | Self: 0.0% (0us) | Total: 0.2% (17.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `callback` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\platform\index.js:28` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `define`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:88` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `make` (1)

### `_read`
`node:_http_server:1082` | Self: 0.0% (0us) | Total: 0.3% (31.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `#resumeSocket` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\node\HostDetector.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\util.js:24` | Self: 0.0% (0us) | Total: 0.0% (946us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:896` | Self: 0.0% (0us) | Total: 0.2% (17.0ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `run` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\validation\index.js:11` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:147` | Self: 0.0% (0us) | Total: 4.5% (369.2ms) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (55)

**Calls:**
- `doneUnsafe` (55)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1525` | Self: 0.0% (0us) | Total: 0.2% (17.0ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `fiberAwaitAll` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:100` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `onConflictDoUpdate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\baggage\utils.js:19` | Self: 0.0% (0us) | Total: 0.2% (16.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `handleResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:394` | Self: 0.0% (0us) | Total: 0.0% (864us) | Samples: 0

**Called by:**
- `onSuccess` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:129` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `fmt` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\misc.js:4` | Self: 0.0% (0us) | Total: 0.9% (78.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:1` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `activeGrantEntries`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:870` | Self: 0.0% (0us) | Total: 0.0% (936us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\nopt@9.0.0\node_modules\nopt\lib\nopt.js:1` | Self: 0.0% (0us) | Total: 3.6% (292.2ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `span`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:229` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `makeSpanUnsafe` (1)

**Calls:**
- `NativeSpan` (1)

### `rebuild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1701` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `Objects` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts:337` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `emitUpdated` (1)

### `out`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7272` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `Info` (2)

**Calls:**
- `(anonymous)` (2)

### `onExit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:953` | Self: 0.0% (0us) | Total: 2.7% (220.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (32)

**Calls:**
- `(anonymous)` (32)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:872` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `get value` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:111` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `getSuccessResponse` (2)
- `getSuccessResponse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\ril.js:8` | Self: 0.0% (0us) | Total: 0.3% (29.4ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `mapOrSame`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2393` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `rebuild` (1)

**Calls:**
- `(anonymous)` (1)

### `NotFound`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\util\local-context.ts:5` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `use` (1)

**Calls:**
- `Error` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\scheduled-task.ts:272` | Self: 0.0% (0us) | Total: 0.0% (866us) | Samples: 0

**Calls:**
- `Struct` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\index.js:9` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `nullable`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:832` | Self: 0.0% (0us) | Total: 0.2% (17.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `ZodNullable` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:16` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:779` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `go` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\_md.js:5` | Self: 0.0% (0us) | Total: 0.0% (965us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:24` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\pty.ts:25` | Self: 0.0% (0us) | Total: 0.7% (61.3ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:803` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `onConflictDoUpdate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1163` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1148` | Self: 0.0% (0us) | Total: 0.0% (889us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:125` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `bound optional` (1)

**Calls:**
- `optional` (1)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2081` | Self: 0.0% (0us) | Total: 0.0% (997us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `currentDispatcher` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` | Self: 0.0% (0us) | Total: 0.3% (29.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `scopeClose` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-telemetry.ts:39` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `make` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\mcp\browser.ts:11` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Calls:**
- `succeedContext` (1)

### `_writeHead`
`node:_http_server:1270` | Self: 0.0% (0us) | Total: 0.0% (864us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `setHeader` (1)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 77.3% (6.21s) | Samples: 0

**Called by:**
- `(anonymous)` (15)
- `_t` (15)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (5)
- `_template` (5)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `_traverse` (4)
- `createHTMLParser` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(module)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `_debug` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `load` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `setup` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (431)
- `anonymous` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1121` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (3)

**Calls:**
- `setContext` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:883` | Self: 0.0% (0us) | Total: 0.1% (13.0ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `getFrom` (2)

### `emitResponseFinished`
`node:_http_server:1922` | Self: 0.0% (0us) | Total: 0.7% (62.6ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (1)

**Calls:**
- `emit` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:867` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `partData` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1440` | Self: 0.0% (0us) | Total: 0.4% (33.3ms) | Samples: 0

**Called by:**
- `runLoop` (5)

**Calls:**
- `(anonymous)` (5)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:58` | Self: 0.0% (0us) | Total: 0.1% (13.3ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `workerDelegation`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:201` | Self: 0.0% (0us) | Total: 0.1% (12.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `stringField` (1)

### `object`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:548` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodObject` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:32` | Self: 0.0% (0us) | Total: 0.1% (15.9ms) | Samples: 0

**Called by:**
- `Literal` (1)
- `(module)` (1)

**Calls:**
- `make` (2)

### `Objects`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `rebuild` (1)

**Calls:**
- `map` (1)

### `getSuccessResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:152` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `map` (1)

### `causeDie`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:225` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `exitDie` (1)

**Calls:**
- `Die` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:271` | Self: 0.0% (0us) | Total: 0.0% (944us) | Samples: 0

**Called by:**
- `guarded` (1)

**Calls:**
- `(anonymous)` (1)

### `fmt`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:438` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `flatIntoArrayWithCallback` (1)

### `emit`
`node:events:127` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `emitListeningNextTick` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\ComponentLogger.js:19` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:682` | Self: 0.0% (0us) | Total: 0.6% (51.4ms) | Samples: 0

**Called by:**
- `runLoop` (6)

**Calls:**
- `(anonymous)` (5)
- `~effect/Utils/internal` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:802` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `values` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:5` | Self: 0.0% (0us) | Total: 0.7% (60.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `toCodecJsonBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7878` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\bridge.ts:57` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `captureSync` (1)

### `exit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1432` | Self: 0.0% (0us) | Total: 0.6% (48.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `(anonymous)` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\platform\index.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:8` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `mapResultRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:72` | Self: 0.0% (0us) | Total: 0.6% (49.4ms) | Samples: 0

**Called by:**
- `map` (2)
- `(anonymous)` (1)
- `~effect/Utils/internal` (1)

**Calls:**
- `forEach` (4)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:153` | Self: 0.0% (0us) | Total: 0.0% (994us) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `reduce` (1)

### `async postJsonToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2335` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `async doStream` (1)

**Calls:**
- `async postToApi` (1)

### `toArray`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\tokenizer.js:23` | Self: 0.0% (0us) | Total: 0.0% (946us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\flow\createFlowUnionType.js:8` | Self: 0.0% (0us) | Total: 0.5% (46.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+proxy-addr@5.1.0\node_modules\@fastify\proxy-addr\index.js:26` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `I`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (16.6ms) | Samples: 0

**Called by:**
- `async Je` (2)

**Calls:**
- `map` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:365` | Self: 0.0% (0us) | Total: 0.1% (9.7ms) | Samples: 0

**Calls:**
- `compile` (1)

### `rebuild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1691` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `mapOrSame` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:674` | Self: 0.0% (0us) | Total: 0.9% (79.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)
- `(anonymous)` (2)
- `(anonymous)` (2)

**Calls:**
- `fromIteratorEagerUnsafe` (6)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `fromIteratorEagerUnsafe` (1)

### `workerDelegation`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:197` | Self: 0.0% (0us) | Total: 0.2% (16.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `normalizeWorkerDelegationModel` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:37` | Self: 0.0% (0us) | Total: 0.2% (17.1ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `mergeAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:728` | Self: 0.0% (0us) | Total: 0.2% (18.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `forEach` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:39` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `push`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:255` | Self: 0.0% (0us) | Total: 0.1% (12.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `rememberText` (1)

### `async safeParseJSON`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2268` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `async transform` (1)

**Calls:**
- `async safeParseJSON` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\api.ts:76` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Calls:**
- `toArray` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4163` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1128` | Self: 0.0% (0us) | Total: 0.2% (17.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:132` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `fromJsonSchema`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:84` | Self: 0.0% (0us) | Total: 0.0% (976us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `inlineLocalReferences` (1)

### `get workspaceID`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace-context.ts:21` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `captureSync` (1)

**Calls:**
- `use` (1)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:11` | Self: 0.0% (0us) | Total: 0.2% (19.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `create` (3)
- `create` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\credential.ts:73` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `sliding` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\diag.js:19` | Self: 0.0% (0us) | Total: 0.2% (16.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `getSuccessResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:151` | Self: 0.0% (0us) | Total: 0.3% (28.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `validateSuccessResponse` (1)
- `validateSuccessResponse` (1)

### `readdirSync`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\node-gyp-build-optional-packages@5.2.2\node_modules\node-gyp-build-optional-packages\node-gyp-build.js:105` | Self: 0.0% (0us) | Total: 3.9% (318.8ms) | Samples: 0

**Called by:**
- `resolveFile` (1)

**Calls:**
- `readdirSync` (1)

### `succeedContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:494` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `constant` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:433` | Self: 0.0% (0us) | Total: 0.5% (46.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:240` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `setup` (1)
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:193` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `exists` (1)

### `captureSync`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\bridge.ts:23` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `get workspaceID` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2419` | Self: 0.0% (0us) | Total: 0.3% (30.0ms) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (2)

**Calls:**
- `currentTimeNanosUnsafe` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\removal.js:18` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `returning`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:256` | Self: 0.0% (0us) | Total: 0.1% (13.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `orderSelectedFields` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\safe-regex2@5.1.1\node_modules\safe-regex2\index.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\internal\global-utils.js:19` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1519` | Self: 0.0% (0us) | Total: 1.8% (148.8ms) | Samples: 0

**Called by:**
- `generatorResume` (18)

**Calls:**
- `exit` (8)
- `(anonymous)` (7)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:89` | Self: 0.0% (0us) | Total: 0.5% (46.5ms) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:39` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `makeEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:68` | Self: 0.0% (0us) | Total: 0.2% (17.4ms) | Samples: 0

**Called by:**
- `make` (4)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1145` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `provideServiceImpl` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\task.ts:46` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `async cleanup`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:5955` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `releaseLock` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:442` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `flatIntoArrayWithCallback` (1)

**Calls:**
- `escapeHtml` (1)

### `makeEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:69` | Self: 0.0% (0us) | Total: 0.3% (30.3ms) | Samples: 0

**Called by:**
- `make` (2)
- `make` (1)

**Calls:**
- `run` (3)

### `Union`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2119` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `union` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:46` | Self: 0.0% (0us) | Total: 0.0% (884us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:325` | Self: 0.0% (0us) | Total: 0.4% (35.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `_prepare` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8149` | Self: 0.0% (0us) | Total: 1.1% (92.1ms) | Samples: 0

**Called by:**
- `guarded` (5)

**Calls:**
- `(anonymous)` (4)
- `systemError` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:224` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Called by:**
- `map` (2)
- `(anonymous)` (1)

**Calls:**
- `mergeQueries` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts:1114` | Self: 0.0% (0us) | Total: 0.5% (45.4ms) | Samples: 0

**Called by:**
- `generatorResume` (5)

**Calls:**
- `acceptable` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:96` | Self: 0.0% (0us) | Total: 0.0% (945us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `escapeName` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\buildMatchMemberExpression.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js:1079` | Self: 0.0% (0us) | Total: 0.0% (908us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:598` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `interruptUnsafe` (1)
- `interruptUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\matchesPattern.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `checkHits`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:152` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `stringify` (1)

### `SQLiteSelectQueryBuilderBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:75` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `SQLiteEffectSelectBase` (1)

**Calls:**
- `getTableLikeName` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\multicast-dns@7.2.5\node_modules\multicast-dns\index.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:14` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `findIndex`
`[native code]` | Self: 0.0% (0us) | Total: 0.3% (28.1ms) | Samples: 0

**Called by:**
- `pull` (3)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:104` | Self: 0.0% (0us) | Total: 0.3% (28.1ms) | Samples: 0

**Called by:**
- `findIndex` (3)

**Calls:**
- `isTitleRequest` (3)

### `async flush`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6834` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `onPipeWritesFinishedForShutdown` (1)

**Calls:**
- `async flush` (1)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:60` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `async postJsonToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2342` | Self: 0.0% (0us) | Total: 0.4% (33.6ms) | Samples: 0

**Called by:**
- `async doStream` (6)

**Calls:**
- `stringify` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index-cjs.js:5` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:120` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Calls:**
- `bound strict` (1)

### `Literal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1419` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1061` | Self: 0.0% (0us) | Total: 0.1% (13.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:23` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:40183` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `sort`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6687` | Self: 0.0% (0us) | Total: 1.4% (118.1ms) | Samples: 0

**Calls:**
- `make` (1)

### `_debug`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:17` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Text.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1291` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `run` (2)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:228` | Self: 0.0% (0us) | Total: 1.6% (134.2ms) | Samples: 0

**Called by:**
- `get` (12)
- `all` (4)

**Calls:**
- `(anonymous)` (8)
- `buildSelectQuery` (6)
- `buildSelectQuery` (1)
- `buildSelectQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:328` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `functionDeclarationCommon` (1)

### `_t`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:29` | Self: 0.0% (0us) | Total: 2.2% (183.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:81` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `emit` (1)

**Calls:**
- `(anonymous)` (1)

### `n`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `fromGlob` (1)

**Calls:**
- `(anonymous)` (1)

### `gitbash`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:366` | Self: 0.0% (0us) | Total: 0.2% (16.5ms) | Samples: 0

**Called by:**
- `win` (3)

**Calls:**
- `which` (3)

### `require`
`[native code]` | Self: 0.0% (0us) | Total: 77.1% (6.20s) | Samples: 0

**Called by:**
- `bound require` (431)

**Calls:**
- `anonymous` (430)
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1157` | Self: 0.0% (0us) | Total: 0.1% (13.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `transaction` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:810` | Self: 0.0% (0us) | Total: 0.0% (833us) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\normalize-and-load-metadata.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:120` | Self: 0.0% (0us) | Total: 0.3% (28.4ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\browser.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `SQLiteColumn`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:53` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `SQLiteText` (1)

**Calls:**
- `Column` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:9` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1262` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `onConflictDoUpdate` (1)

### `disabled`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:355` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `resolveTools` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:42` | Self: 0.0% (0us) | Total: 0.0% (873us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `validateSuccessResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:185` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `getSuccessResponse` (1)

**Calls:**
- `getStatusSuccess` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:123` | Self: 0.0% (0us) | Total: 2.8% (225.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (12)

**Calls:**
- `getOrElseMemoize` (12)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:7` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:8` | Self: 0.0% (0us) | Total: 0.2% (16.8ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2563` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `rebuild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1282` | Self: 0.0% (0us) | Total: 0.3% (29.0ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `go` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\index.js:17` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1914` | Self: 0.0% (0us) | Total: 100.0% (8.17s) | Samples: 0

**Called by:**
- `bound ` (878)

**Calls:**
- `go` (850)
- `go` (28)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:10` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:22` | Self: 0.0% (0us) | Total: 0.3% (31.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `ZodOptional` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `build`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:15` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `SQLiteText` (1)

### `systemError`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PlatformError.js:144` | Self: 0.0% (0us) | Total: 0.3% (32.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `PlatformError` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\index.js:4` | Self: 0.0% (0us) | Total: 3.6% (292.2ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `destroy`
`internal:streams/destroy:41` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `_destroy` (1)

### `Interrupt`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:33` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `causeInterrupt` (1)

**Calls:**
- `ReasonBase` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:583` | Self: 0.0% (0us) | Total: 0.1% (13.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:175` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `resolveTools` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:9` | Self: 0.0% (0us) | Total: 0.2% (17.3ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1991` | Self: 0.0% (0us) | Total: 0.9% (76.2ms) | Samples: 0

**Called by:**
- `go` (5)
- `(anonymous)` (3)
- `(anonymous)` (2)

**Calls:**
- `go` (10)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:416` | Self: 0.0% (0us) | Total: 0.2% (17.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1297` | Self: 0.0% (0us) | Total: 0.0% (928us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get OPENCODE_SEAL_PRUNE` (1)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1509` | Self: 0.0% (0us) | Total: 1.6% (129.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (19)

**Calls:**
- `(anonymous)` (19)

### `transformResponse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:266` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `toCodecJson` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\react\buildChildren.js:8` | Self: 0.0% (0us) | Total: 1.3% (104.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:771` | Self: 0.0% (0us) | Total: 0.0% (959us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:555` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\sql.ts:110` | Self: 0.0% (0us) | Total: 0.1% (13.4ms) | Samples: 0

**Calls:**
- `sqliteTableBase` (1)

### `resume_`
`internal:streams/readable:590` | Self: 0.0% (0us) | Total: 0.3% (31.2ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:41` | Self: 0.0% (0us) | Total: 0.2% (17.8ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+proxy-addr@5.1.0\node_modules\@fastify\proxy-addr\index.js:27` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `getStatusSuccess`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:396` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `validateSuccessResponse` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:579` | Self: 0.0% (0us) | Total: 0.4% (32.7ms) | Samples: 0

**Called by:**
- `run` (2)
- `makeEffect` (2)
- `toCodecJson` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `optionalKey`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2427` | Self: 0.0% (0us) | Total: 0.2% (17.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `create` (2)
- `modifyOwnPropertyDescriptors` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detectors\index.js:10` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:625` | Self: 0.0% (0us) | Total: 3.4% (277.9ms) | Samples: 0

**Called by:**
- `runLoop` (31)

**Calls:**
- `doneUnsafe` (21)
- `(anonymous)` (4)
- `(anonymous)` (2)
- `failCauseUnsafe` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `which` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js:7` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1692` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Called by:**
- `mapOrSame` (1)

**Calls:**
- `(anonymous)` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:412` | Self: 0.0% (0us) | Total: 100.0% (24.20s) | Samples: 0

**Called by:**
- `forkUnsafe` (2127)
- `(anonymous)` (416)
- `(anonymous)` (176)
- `runTasks` (60)
- `(anonymous)` (48)
- `interruptUnsafe` (1)

**Calls:**
- `runLoop` (2826)
- `runLoop` (1)
- `runLoop` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:161` | Self: 0.0% (0us) | Total: 0.6% (56.2ms) | Samples: 0

**Called by:**
- `_prepare` (6)

**Calls:**
- `buildSelection` (6)

### `parse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `fromGlob` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\printer.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `define`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:85` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `optional` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\global.ts:152` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `generatorResume`
`[native code]` | Self: 0.0% (0us) | Total: 100.0% (12.50s) | Samples: 0

**Called by:**
- `next` (1463)
- `~effect/Effect/successCont` (19)
- `fromIteratorEagerUnsafe` (18)
- `toArray` (1)

**Calls:**
- `(anonymous)` (1267)
- `(anonymous)` (37)
- `(anonymous)` (22)
- `(anonymous)` (18)
- `(anonymous)` (9)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:31` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `_debug` (2)
- `createDebug` (1)
- `createDebug` (1)

### `readableAddChunkPushByteMode`
`internal:streams/readable:242` | Self: 0.0% (0us) | Total: 0.0% (874us) | Samples: 0

**Called by:**
- `onDataIncomingMessage` (1)

**Calls:**
- `write` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:588` | Self: 0.0% (0us) | Total: 0.0% (995us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `closeAllContent` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\index.js:28` | Self: 0.0% (0us) | Total: 0.4% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`internal:streams/writable:601` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `#onClose` (1)

**Calls:**
- `destroy` (1)

### `from`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:125` | Self: 0.0% (0us) | Total: 0.5% (44.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `SQLiteEffectSelectBase` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:321` | Self: 0.0% (0us) | Total: 0.2% (22.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `SQL` (1)
- `SQL` (1)

### `ZodNullable`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` | Self: 0.0% (0us) | Total: 0.2% (17.1ms) | Samples: 0

**Called by:**
- `nullable` (1)

**Calls:**
- `init` (1)

### `rememberText`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:133` | Self: 0.0% (0us) | Total: 0.1% (12.3ms) | Samples: 0

**Called by:**
- `push` (1)

**Calls:**
- `push` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:768` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `set` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8151` | Self: 0.0% (0us) | Total: 7.6% (614.4ms) | Samples: 0

**Called by:**
- `guarded` (65)

**Calls:**
- `(anonymous)` (65)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:673` | Self: 0.0% (0us) | Total: 0.3% (30.3ms) | Samples: 0

**Called by:**
- `makeEffect` (3)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\context.js:28` | Self: 0.0% (0us) | Total: 0.5% (44.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:15` | Self: 0.0% (0us) | Total: 2.4% (197.4ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:809` | Self: 0.0% (0us) | Total: 0.3% (27.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `Error` (2)

### `executeTransactionStatement`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:115` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `run` (1)

### `transaction`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:196` | Self: 0.0% (0us) | Total: 0.1% (13.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `gen` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 39.5% | 3.17s | `[native code]` |
| 21.1% | 1.69s | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 9.7% | 781.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 6.1% | 493.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 1.6% | 134.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js` |
| 1.5% | 121.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js` |
| 1.5% | 121.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js` |
| 1.5% | 121.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 1.3% | 108.5ms | `node:_http_server` |
| 1.1% | 94.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js` |
| 0.9% | 78.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts` |
| 0.5% | 47.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts` |
| 0.5% | 45.7ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts` |
| 0.5% | 43.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts` |
| 0.5% | 42.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js` |
| 0.4% | 37.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js` |
| 0.3% | 31.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts` |
| 0.3% | 31.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts` |
| 0.3% | 30.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js` |
| 0.3% | 30.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts` |
| 0.2% | 19.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js` |
| 0.2% | 17.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.2% | 17.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js` |
| 0.2% | 17.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js` |
| 0.2% | 17.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\tracer.js` |
| 0.2% | 16.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts` |
| 0.2% | 16.7ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts` |
| 0.2% | 16.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs` |
| 0.2% | 16.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.1% | 16.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.1% | 15.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js` |
| 0.1% | 15.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js` |
| 0.1% | 15.7ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts` |
| 0.1% | 15.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts` |
| 0.1% | 15.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\deadline-owner.ts` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiGroup.js` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\chunkdb.ts` |
| 0.1% | 14.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\project\project.ts` |
| 0.1% | 14.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\ofxp\capability.ts` |
| 0.1% | 14.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\project\directories.ts` |
| 0.1% | 14.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\util.js` |
| 0.1% | 14.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js` |
| 0.1% | 14.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts` |
| 0.1% | 14.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js` |
| 0.1% | 14.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.1% | 13.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js` |
| 0.1% | 13.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\PubSub.js` |
| 0.1% | 13.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.1% | 13.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts` |
| 0.1% | 13.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js` |
| 0.1% | 13.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\attributes.js` |
| 0.1% | 13.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\foreign-keys.js` |
| 0.1% | 13.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts` |
| 0.1% | 13.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\result.js` |
| 0.1% | 13.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js` |
| 0.1% | 12.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts` |
| 0.1% | 12.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js` |
| 0.1% | 12.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\text-tail.ts` |
| 0.1% | 12.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.1% | 11.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts` |
| 0.1% | 9.7ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts` |
| 0.1% | 9.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts` |
| 0.0% | 5.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts` |
| 0.0% | 3.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 3.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js` |
| 0.0% | 2.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts` |
| 0.0% | 1.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\run-state.ts` |
| 0.0% | 1.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\first-content-deadline.ts` |
| 0.0% | 1.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\common.js` |
| 0.0% | 1.7ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\internal\utils.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\common\html.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\format\index.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js` |
| 0.0% | 998us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\linkedMap.js` |
| 0.0% | 997us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js` |
| 0.0% | 995us | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts` |
| 0.0% | 983us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js` |
| 0.0% | 975us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\worktree\index.ts` |
| 0.0% | 949us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts` |
| 0.0% | 944us | `bun:sqlite` |
| 0.0% | 925us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column-builder.js` |
| 0.0% | 913us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\job.ts` |
| 0.0% | 908us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ipaddr.js@2.4.0\node_modules\ipaddr.js\lib\ipaddr.js` |
| 0.0% | 903us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\generators\index.js` |
| 0.0% | 897us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs` |
| 0.0% | 894us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\recovery.ts` |
| 0.0% | 864us | `node:_http_outgoing` |
