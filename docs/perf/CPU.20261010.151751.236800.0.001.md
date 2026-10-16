# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 13.74s | 1346 | 1.0ms | 1338 |

**Top 10:** `anonymous` 15.6%, `Map` 10.5%, `(anonymous)` 4.7%, `(anonymous)` 3.4%, `write` 3.0%, `FinalizationRegistry` 2.8%, `all` 2.3%, `values` 2.2%, `forEachMimeType` 2.1%, `(anonymous)` 1.8%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 15.6% | 2.14s | 56.4% | 7.75s | `anonymous` | `[native code]` |
| 10.5% | 1.45s | 10.5% | 1.45s | `Map` | `[native code]` |
| 4.7% | 648.8ms | 4.8% | 664.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` |
| 3.4% | 476.1ms | 3.4% | 476.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 3.0% | 417.2ms | 3.0% | 417.2ms | `write` | `[native code]` |
| 2.8% | 385.9ms | 2.8% | 385.9ms | `FinalizationRegistry` | `[native code]` |
| 2.3% | 321.3ms | 2.3% | 321.3ms | `all` | `[native code]` |
| 2.2% | 310.6ms | 2.2% | 310.6ms | `values` | `[native code]` |
| 2.1% | 292.0ms | 2.1% | 292.0ms | `forEachMimeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:164` |
| 1.8% | 254.8ms | 1.8% | 254.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` |
| 1.6% | 220.9ms | 2.0% | 284.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` |
| 1.5% | 217.7ms | 100.0% | 36.48s | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` |
| 1.3% | 184.6ms | 1.3% | 184.6ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaIssue.js:41` |
| 1.1% | 152.0ms | 1.1% | 152.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` |
| 1.0% | 139.9ms | 1.0% | 139.9ms | `stringify` | `[native code]` |
| 0.9% | 129.2ms | 0.9% | 129.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` |
| 0.8% | 115.9ms | 0.8% | 115.9ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` |
| 0.7% | 105.2ms | 0.8% | 119.7ms | `statSync` | `[native code]` |
| 0.7% | 102.5ms | 0.7% | 102.5ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` |
| 0.5% | 79.2ms | 100.0% | 14.73s | `generatorResume` | `[native code]` |
| 0.5% | 78.2ms | 0.7% | 105.8ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1533` |
| 0.5% | 74.1ms | 0.5% | 74.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` |
| 0.5% | 73.7ms | 0.5% | 73.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` |
| 0.5% | 68.8ms | 0.5% | 68.8ms | `importModule` | `[native code]` |
| 0.4% | 64.6ms | 3.2% | 441.4ms | `forEach` | `[native code]` |
| 0.4% | 62.2ms | 0.4% | 62.2ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.4% | 62.1ms | 0.4% | 62.1ms | `Option` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.4% | 61.9ms | 0.5% | 75.7ms | `lstatSync` | `[native code]` |
| 0.4% | 60.5ms | 0.4% | 60.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:107` |
| 0.4% | 57.9ms | 1.0% | 146.2ms | `filter` | `[native code]` |
| 0.4% | 57.2ms | 0.4% | 57.2ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` |
| 0.3% | 50.6ms | 0.3% | 50.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:92` |
| 0.3% | 50.2ms | 0.4% | 64.2ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` |
| 0.3% | 47.9ms | 0.3% | 47.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.3% | 47.0ms | 0.3% | 47.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.3% | 46.9ms | 2.0% | 276.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` |
| 0.3% | 46.9ms | 2.6% | 369.4ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` |
| 0.3% | 46.5ms | 0.3% | 46.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts` |
| 0.3% | 45.8ms | 0.8% | 120.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` |
| 0.3% | 45.2ms | 0.3% | 45.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.3% | 43.9ms | 0.5% | 74.7ms | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:65` |
| 0.2% | 35.5ms | 0.4% | 65.0ms | `callback` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` |
| 0.2% | 34.8ms | 0.2% | 34.8ms | `scopeAddFinalizerExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` |
| 0.2% | 33.6ms | 0.3% | 47.4ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` |
| 0.2% | 33.3ms | 0.2% | 33.3ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` |
| 0.2% | 33.2ms | 0.2% | 33.2ms | `copyDataProperties` | `[native code]` |
| 0.2% | 32.7ms | 7.8% | 1.07s | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` |
| 0.2% | 32.2ms | 0.4% | 64.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` |
| 0.2% | 32.2ms | 6.2% | 857.3ms | `map` | `[native code]` |
| 0.2% | 31.7ms | 0.2% | 31.7ms | `prepare` | `[native code]` |
| 0.2% | 31.6ms | 0.2% | 31.6ms | `cloneObject` | `[native code]` |
| 0.2% | 31.6ms | 0.4% | 57.9ms | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` |
| 0.2% | 31.5ms | 0.2% | 31.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` |
| 0.2% | 31.3ms | 0.2% | 31.3ms | `readdirCB` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:537` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:152` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `realpathNativeSync` | `[native code]` |
| 0.2% | 30.8ms | 0.6% | 87.5ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` |
| 0.2% | 30.6ms | 0.2% | 30.6ms | `pipe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:35` |
| 0.2% | 30.6ms | 0.2% | 30.6ms | `next` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:57` |
| 0.2% | 30.4ms | 0.2% | 30.4ms | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:185` |
| 0.2% | 30.2ms | 0.2% | 30.2ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2075` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `next` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:54` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `defineFunctionLength` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:775` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `query` | `bun:sqlite:342` |
| 0.2% | 29.8ms | 0.2% | 29.8ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` |
| 0.2% | 29.8ms | 0.2% | 29.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` |
| 0.2% | 29.7ms | 1.1% | 152.8ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` |
| 0.2% | 29.7ms | 0.2% | 29.7ms | `assign` | `[native code]` |
| 0.2% | 29.5ms | 0.2% | 29.5ms | `indexOf` | `[native code]` |
| 0.2% | 29.4ms | 1.4% | 195.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` |
| 0.2% | 29.3ms | 0.4% | 65.7ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` |
| 0.2% | 29.3ms | 0.2% | 29.3ms | `layerFromPath` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts` |
| 0.2% | 29.2ms | 0.2% | 29.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.2% | 29.1ms | 100.0% | 25.85s | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` |
| 0.2% | 28.4ms | 0.2% | 29.4ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` |
| 0.2% | 28.3ms | 0.2% | 28.3ms | `Error` | `[native code]` |
| 0.2% | 28.1ms | 0.2% | 28.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js` |
| 0.2% | 28.0ms | 0.2% | 28.0ms | `slice` | `[native code]` |
| 0.1% | 27.3ms | 0.1% | 27.3ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:25` |
| 0.1% | 26.7ms | 0.1% | 26.7ms | `create` | `[native code]` |
| 0.1% | 26.6ms | 0.1% | 26.6ms | `get` | `[native code]` |
| 0.1% | 26.3ms | 0.1% | 26.3ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:627` |
| 0.1% | 25.7ms | 0.1% | 25.7ms | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:220` |
| 0.1% | 23.6ms | 0.1% | 23.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` |
| 0.1% | 21.8ms | 0.1% | 21.8ms | `escapeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` |
| 0.1% | 18.8ms | 0.1% | 18.8ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 18.2ms | 0.1% | 18.2ms | `flatIntoArray` | `[native code]` |
| 0.1% | 18.0ms | 0.1% | 18.0ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` |
| 0.1% | 18.0ms | 0.1% | 18.0ms | `getReferenceUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` |
| 0.1% | 17.9ms | 0.5% | 78.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 0.1% | 17.8ms | 0.1% | 17.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\config.ts` |
| 0.1% | 17.8ms | 92.9% | 12.77s | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` |
| 0.1% | 17.7ms | 0.1% | 17.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.1% | 17.3ms | 0.1% | 17.3ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `exitAsVoidAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1089` |
| 0.1% | 17.1ms | 3.7% | 522.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\Envelope.js:189` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `rmSync` | `[native code]` |
| 0.1% | 16.7ms | 0.7% | 106.7ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` |
| 0.1% | 16.7ms | 0.1% | 16.7ms | `parse` | `[native code]` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:222` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `Int32Array` | `[native code]` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1893` |
| 0.1% | 16.5ms | 0.1% | 16.5ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1719` |
| 0.1% | 16.5ms | 0.1% | 16.5ms | `(unknown)` | `[native code]` |
| 0.1% | 16.3ms | 0.1% | 16.3ms | `scopeMakeUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1574` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:64` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:562` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `join` | `[native code]` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1523` |
| 0.1% | 16.0ms | 0.1% | 17.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:85` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `nominal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Brand.js` |
| 0.1% | 16.0ms | 1.2% | 171.7ms | `getOrElseMemoize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2843` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3499` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `streamText` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6381` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:86` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:128` |
| 0.1% | 15.8ms | 92.8% | 12.76s | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 0.1% | 15.8ms | 100.0% | 14.68s | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1914` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `attribute` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:287` |
| 0.1% | 15.8ms | 0.1% | 16.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `buildOrderBy` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:137` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1395` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:52` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:296` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `addObserver` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:373` |
| 0.1% | 15.6ms | 0.1% | 16.5ms | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:100` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `retrySqliteBusyCause` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:106` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `DelayedPromise` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:114` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `collectJsonSchemaChecks` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `defineProperty` | `[native code]` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:112` |
| 0.1% | 15.4ms | 0.1% | 21.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1120` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\utils\bedrock-media.ts:13` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts:288` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `internal:worker/messaging` | `internal:worker/messaging:2` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `assertNodeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js:103` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1358` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:109` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `resolve` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:125806` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `immutableURLSetter` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js` |
| 0.1% | 15.2ms | 0.1% | 16.2ms | `filterDisablePropagation` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2321` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `createSetOperator` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:266` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\scheduled-task\executor.ts:87` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts:29` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `SQLiteEffectPreparedQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:52` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:566` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:545` |
| 0.1% | 15.2ms | 11.2% | 1.54s | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `buildUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:48` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\clone\cloneNode.js:3` |
| 0.1% | 15.2ms | 0.2% | 30.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2563` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:167` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `fromIterable` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Array.js:218` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:81` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:98` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `onSuccess` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:336` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `triggerForEvent` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts:282` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `Immer2` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:636` |
| 0.1% | 15.1ms | 83.1% | 11.42s | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:11` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1160` |
| 0.1% | 15.0ms | 0.2% | 30.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:51` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:1363` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `scopeRemoveFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1569` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `async pull` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:146` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1336` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2189` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\symbols.ts` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1538` |
| 0.1% | 14.9ms | 0.1% | 15.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:120` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js` |
| 0.1% | 14.9ms | 100.0% | 36.50s | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:412` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `exitAsVoidAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:962` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:334` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:231` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs` |
| 0.1% | 14.7ms | 1.9% | 262.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` |
| 0.1% | 14.7ms | 2.1% | 300.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1608` |
| 0.1% | 14.7ms | 53.2% | 7.32s | `bound require` | `[native code]` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `number` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `Duplex` | `internal:streams/duplex:6` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:7` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `Channel` | `node:diagnostics_channel` |
| 0.1% | 14.5ms | 0.3% | 44.9ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1440` |
| 0.1% | 14.5ms | 0.2% | 30.7ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1155` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `async start` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6340` |
| 0.1% | 14.4ms | 2.0% | 277.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1519` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:242` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:25` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:27` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:357` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SynchronizedRef.js:214` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `Set` | `[native code]` |
| 0.1% | 14.2ms | 0.3% | 45.8ms | `findIndex` | `[native code]` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:138` |
| 0.1% | 14.2ms | 0.1% | 15.2ms | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:21` |
| 0.1% | 14.1ms | 0.2% | 30.1ms | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:154` |
| 0.1% | 14.1ms | 3.0% | 419.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `getOwnPropertyDescriptors` | `[native code]` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:319` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\lsp\lsp.ts` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `mergeAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:29` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:73` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `push` | `[native code]` |
| 0.1% | 13.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\MutableHashMap.js:193` |
| 0.1% | 13.8ms | 0.6% | 89.1ms | `scopeClose` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `createLaceAISdkObserver` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\lace-ai-sdk-observer.ts` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.1% | 13.7ms | 0.1% | 13.7ms | `~effect/Effect/ensureCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` |
| 0.0% | 13.7ms | 0.0% | 13.7ms | `has` | `[native code]` |
| 0.0% | 13.6ms | 0.5% | 79.4ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1626` |
| 0.0% | 13.6ms | 0.0% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.0% | 13.5ms | 0.4% | 60.5ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `onTSSinkWriteBackpressureChangeFulfilled` | `[native code]` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `existsSync` | `[native code]` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1882` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `entries` | `[native code]` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:567` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `gen` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts:20` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:105` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:52` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+server@2.0.0\node_modules\@modelcontextprotocol\server\dist\src-CX2iR2pK.mjs:5914` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `captureSqliteQuerySite` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts` |
| 0.0% | 13.1ms | 0.2% | 28.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1507` |
| 0.0% | 13.0ms | 0.3% | 42.7ms | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` |
| 0.0% | 13.0ms | 0.0% | 13.0ms | `async return` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:5983` |
| 0.0% | 12.8ms | 0.0% | 12.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:162` |
| 0.0% | 12.8ms | 0.7% | 100.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:756` |
| 0.0% | 12.8ms | 0.0% | 12.8ms | `networkInterfaces` | `[native code]` |
| 0.0% | 12.7ms | 0.0% | 12.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpPlatform.js` |
| 0.0% | 12.7ms | 0.0% | 12.7ms | `mapGetResult` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:166` |
| 0.0% | 12.6ms | 0.0% | 12.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\fork\credentials.ts` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1568` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `WeakRef` | `[native code]` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `createJoin` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` |
| 0.0% | 12.2ms | 100.0% | 14.26s | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` |
| 0.0% | 11.8ms | 0.0% | 11.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\member-session.ts` |
| 0.0% | 11.8ms | 100.0% | 14.90s | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:719` |
| 0.0% | 11.8ms | 0.0% | 11.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.0% | 11.8ms | 0.9% | 126.0ms | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:325` |
| 0.0% | 11.7ms | 0.6% | 88.3ms | `from` | `[native code]` |
| 0.0% | 11.5ms | 0.0% | 11.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js:6` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `scopeMakeUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1576` |
| 0.0% | 10.6ms | 0.0% | 10.6ms | `flat` | `[native code]` |
| 0.0% | 10.4ms | 0.0% | 10.4ms | `bigint` | `[native code]` |
| 0.0% | 10.3ms | 0.0% | 10.3ms | `hostname` | `[native code]` |
| 0.0% | 9.2ms | 0.0% | 9.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:116` |
| 0.0% | 4.5ms | 0.0% | 4.5ms | `all` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` |
| 0.0% | 3.8ms | 7.6% | 1.04s | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` |
| 0.0% | 2.9ms | 0.2% | 30.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:95` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:286` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:297` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1865` |
| 0.0% | 1.9ms | 0.8% | 117.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.0% | 1.9ms | 6.0% | 831.9ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:625` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `sqliteStatementClass` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-diagnostics.ts:18` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:21` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\htmlparser2@8.0.2\node_modules\htmlparser2\lib\esm\Parser.js:21` |
| 0.0% | 1.7ms | 0.0% | 12.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `getCandidates` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1910` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1602` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `mapFromDriverValue` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:44` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:174` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2244` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `takeAuditCases` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:416` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1909` |
| 0.0% | 1.0ms | 0.2% | 30.4ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:27` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `doneExitFromCause` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pull.js:168` |
| 0.0% | 1.0ms | 0.2% | 36.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2415` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `q` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:681` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:922` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `walk` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:180` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1837` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `sdkKey` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:43` |
| 0.0% | 1.0ms | 0.0% | 2.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1122` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `RunnerAddress` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `patch` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1775` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `mapAllResult` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:137` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `topP` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:550` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `BigInt` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` |
| 0.0% | 1.0ms | 0.2% | 30.3ms | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:62` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:521` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Service` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2598` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2159` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `causeFilterInterruptors` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `reconcile` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration\20260908003500_event_compaction.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\directory-activity-fence.ts:141` |
| 0.0% | 1.0ms | 0.2% | 28.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:798` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:98` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js:7411` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1127` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `toMillis` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:612` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `schema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:938` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ripgrep\binary.ts:36` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `RegExp` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:276` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:905` |
| 0.0% | 1.0ms | 0.9% | 137.2ms | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` |
| 0.0% | 1.0ms | 2.2% | 311.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:111` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:741` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Getter` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js` |
| 0.0% | 999us | 0.0% | 999us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:715` |
| 0.0% | 997us | 0.0% | 997us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:8` |
| 0.0% | 996us | 0.0% | 996us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:609` |
| 0.0% | 996us | 0.0% | 996us | `interruptUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:391` |
| 0.0% | 994us | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:199` |
| 0.0% | 993us | 0.1% | 16.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1119` |
| 0.0% | 991us | 0.0% | 991us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:848` |
| 0.0% | 991us | 0.0% | 991us | `forEachMimeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:169` |
| 0.0% | 990us | 0.0% | 990us | `fromRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:145` |
| 0.0% | 990us | 0.0% | 990us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\server.ts:85` |
| 0.0% | 988us | 0.0% | 988us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.0% | 986us | 2.3% | 322.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:96` |
| 0.0% | 986us | 0.2% | 32.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1121` |
| 0.0% | 986us | 0.0% | 986us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1247` |
| 0.0% | 985us | 0.0% | 985us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` |
| 0.0% | 985us | 0.2% | 33.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1692` |
| 0.0% | 985us | 0.0% | 985us | `policy` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\retry.ts:412` |
| 0.0% | 984us | 0.0% | 984us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:812` |
| 0.0% | 983us | 0.0% | 983us | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` |
| 0.0% | 983us | 0.0% | 983us | `StringChunk` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:49` |
| 0.0% | 981us | 0.0% | 981us | `mapOrSame` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2390` |
| 0.0% | 981us | 0.0% | 981us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:106` |
| 0.0% | 979us | 0.0% | 979us | `buildForeignKeys` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:32` |
| 0.0% | 979us | 0.0% | 979us | `fn` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:782` |
| 0.0% | 977us | 0.0% | 977us | `getDefaultValue` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:578` |
| 0.0% | 975us | 0.0% | 975us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:513` |
| 0.0% | 974us | 0.0% | 974us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:142` |
| 0.0% | 973us | 0.0% | 973us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:2164` |
| 0.0% | 971us | 0.0% | 971us | `pruneStates` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:303` |
| 0.0% | 969us | 0.0% | 969us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts` |
| 0.0% | 967us | 0.0% | 967us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` |
| 0.0% | 967us | 0.0% | 967us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 966us | 0.0% | 966us | `async GensparkAuthPlugin` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\genspark.ts:42` |
| 0.0% | 962us | 0.0% | 962us | `max` | `[native code]` |
| 0.0% | 958us | 1.7% | 235.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:89` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:211` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\runtime-retention.ts` |
| 0.0% | 955us | 0.0% | 955us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:364` |
| 0.0% | 955us | 0.0% | 955us | `flow` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:461` |
| 0.0% | 954us | 0.0% | 954us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:188` |
| 0.0% | 952us | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` |
| 0.0% | 951us | 0.0% | 951us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1894` |
| 0.0% | 950us | 0.0% | 950us | `includes` | `[native code]` |
| 0.0% | 949us | 0.0% | 949us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1221` |
| 0.0% | 948us | 0.0% | 948us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1895` |
| 0.0% | 947us | 0.0% | 947us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` |
| 0.0% | 947us | 0.0% | 947us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1159` |
| 0.0% | 945us | 0.0% | 945us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:502` |
| 0.0% | 945us | 0.0% | 945us | `some` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\option.js:79` |
| 0.0% | 942us | 0.0% | 1.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:59` |
| 0.0% | 940us | 0.2% | 32.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` |
| 0.0% | 933us | 0.0% | 933us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:27` |
| 0.0% | 932us | 0.0% | 932us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1305` |
| 0.0% | 932us | 0.0% | 932us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1147` |
| 0.0% | 929us | 0.0% | 929us | `fixedBase64` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js` |
| 0.0% | 929us | 0.0% | 929us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:728` |
| 0.0% | 927us | 0.0% | 927us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:1042` |
| 0.0% | 926us | 0.0% | 926us | `@lazy` | `[native code]` |
| 0.0% | 925us | 0.0% | 925us | `interruptible` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1732` |
| 0.0% | 923us | 0.0% | 923us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` |
| 0.0% | 923us | 0.0% | 923us | `fromRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:116` |
| 0.0% | 921us | 0.0% | 921us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 0.0% | 920us | 0.0% | 920us | `shouldDisableInsert` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:67` |
| 0.0% | 919us | 0.0% | 919us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1260` |
| 0.0% | 915us | 0.0% | 1.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:89` |
| 0.0% | 914us | 0.0% | 1.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` |
| 0.0% | 912us | 0.2% | 30.4ms | `Objects` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` |
| 0.0% | 912us | 0.0% | 912us | `annotate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2328` |
| 0.0% | 911us | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1076` |
| 0.0% | 906us | 0.0% | 906us | `structuredClone` | `[native code]` |
| 0.0% | 905us | 0.0% | 2.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:783` |
| 0.0% | 902us | 0.0% | 902us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\shell-job.ts` |
| 0.0% | 897us | 0.0% | 897us | `sessionRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:64` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1676` |
| 0.0% | 894us | 0.0% | 894us | `resolveInfo` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts:160` |
| 0.0% | 894us | 0.0% | 894us | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` |
| 0.0% | 893us | 0.0% | 893us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:79` |
| 0.0% | 893us | 0.0% | 893us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:2832` |
| 0.0% | 893us | 0.1% | 17.4ms | `run` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:673` |
| 0.0% | 891us | 0.3% | 49.2ms | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:58` |
| 0.0% | 891us | 0.0% | 891us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:959` |
| 0.0% | 891us | 0.0% | 891us | `flipEncoding` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2601` |
| 0.0% | 890us | 0.0% | 890us | `createQuerySerializer` | `C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts` |
| 0.0% | 889us | 0.0% | 889us | `isArray` | `[native code]` |
| 0.0% | 887us | 0.0% | 887us | `toStepWithMetadata` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js:203` |
| 0.0% | 885us | 0.0% | 885us | `captureSqliteQuerySite` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts:42` |
| 0.0% | 882us | 0.4% | 57.7ms | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:171` |
| 0.0% | 882us | 0.0% | 882us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3181` |
| 0.0% | 882us | 0.0% | 882us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:224` |
| 0.0% | 881us | 1.8% | 253.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.0% | 881us | 0.0% | 881us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:99` |
| 0.0% | 880us | 0.0% | 880us | `restoreDiff` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js:4` |
| 0.0% | 878us | 0.0% | 878us | `Param` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:304` |
| 0.0% | 878us | 0.0% | 1.8ms | `buildUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 873us | 0.0% | 873us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:172` |
| 0.0% | 867us | 1.0% | 140.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1856` |
| 0.0% | 865us | 0.0% | 865us | `getImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:204` |
| 0.0% | 859us | 0.0% | 859us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:813` |
| 0.0% | 857us | 0.2% | 28.4ms | `SQLiteEffectSelectBase` | `[native code]` |
| 0.0% | 856us | 0.0% | 856us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` |
| 0.0% | 850us | 0.4% | 61.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:116` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 100.0% | 36.50s | 0.1% | 14.9ms | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:412` |
| 100.0% | 36.48s | 1.5% | 217.7ms | `runLoop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` |
| 100.0% | 25.85s | 0.2% | 29.1ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` |
| 100.0% | 14.90s | 0.0% | 11.8ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:719` |
| 100.0% | 14.89s | 0.0% | 0us | `bound ` | `[native code]` |
| 100.0% | 14.73s | 0.5% | 79.2ms | `generatorResume` | `[native code]` |
| 100.0% | 14.68s | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1914` |
| 100.0% | 14.29s | 0.0% | 0us | `next` | `[native code]` |
| 100.0% | 14.26s | 0.0% | 12.2ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` |
| 92.9% | 12.77s | 0.1% | 17.8ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` |
| 92.8% | 12.76s | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 83.1% | 11.42s | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` |
| 80.4% | 11.05s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:723` |
| 56.4% | 7.75s | 15.6% | 2.14s | `anonymous` | `[native code]` |
| 53.2% | 7.32s | 0.1% | 14.7ms | `bound require` | `[native code]` |
| 52.8% | 7.26s | 0.0% | 0us | `require` | `[native code]` |
| 26.3% | 3.62s | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:425` |
| 20.1% | 2.77s | 0.0% | 0us | `afterScheduled` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:140` |
| 20.1% | 2.77s | 0.0% | 0us | `runTasks` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:150` |
| 16.0% | 2.20s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1959` |
| 14.8% | 2.04s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:656` |
| 12.6% | 1.74s | 0.0% | 0us | `doneUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:657` |
| 11.2% | 1.54s | 0.1% | 15.2ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` |
| 10.5% | 1.45s | 10.5% | 1.45s | `Map` | `[native code]` |
| 8.5% | 1.17s | 0.0% | 0us | `guarded` | `internal:shared:114` |
| 8.1% | 1.12s | 0.0% | 0us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:846` |
| 8.1% | 1.12s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1117` |
| 8.1% | 1.11s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8151` |
| 8.0% | 1.10s | 0.0% | 0us | `guarded` | `internal:shared:112` |
| 7.8% | 1.07s | 0.2% | 32.7ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` |
| 7.6% | 1.04s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:269` |
| 7.6% | 1.04s | 0.0% | 3.8ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` |
| 7.3% | 1.01s | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:147` |
| 7.1% | 978.4ms | 0.0% | 0us | `onExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:953` |
| 7.1% | 978.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:964` |
| 6.2% | 857.3ms | 0.2% | 32.2ms | `map` | `[native code]` |
| 6.0% | 831.9ms | 0.0% | 1.9ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:625` |
| 4.8% | 664.6ms | 4.7% | 648.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` |
| 4.6% | 641.8ms | 0.0% | 0us | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:90` |
| 4.1% | 572.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:679` |
| 4.1% | 568.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:333` |
| 4.1% | 568.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:87` |
| 3.7% | 522.3ms | 0.1% | 17.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` |
| 3.7% | 518.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\index.js:1` |
| 3.6% | 505.7ms | 0.0% | 0us | `processTicksAndRejections` | `[native code]` |
| 3.6% | 499.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2127` |
| 3.5% | 491.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:196870` |
| 3.4% | 476.1ms | 3.4% | 476.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 3.4% | 472.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2179` |
| 3.4% | 472.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2190` |
| 3.3% | 457.3ms | 0.0% | 0us | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:838` |
| 3.2% | 447.4ms | 0.0% | 0us | `releaseTakers` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1451` |
| 3.2% | 443.3ms | 0.0% | 0us | `(anonymous)` | `[native code]` |
| 3.2% | 442.4ms | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` |
| 3.2% | 441.4ms | 0.4% | 64.6ms | `forEach` | `[native code]` |
| 3.0% | 419.3ms | 0.1% | 14.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` |
| 3.0% | 418.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:372` |
| 3.0% | 417.2ms | 3.0% | 417.2ms | `write` | `[native code]` |
| 2.9% | 403.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2106` |
| 2.8% | 387.0ms | 0.0% | 0us | `async tmpdir` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\fixture\fixture.ts:102` |
| 2.8% | 385.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpClient.js:625` |
| 2.8% | 385.9ms | 2.8% | 385.9ms | `FinalizationRegistry` | `[native code]` |
| 2.8% | 385.9ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpClient.js:648` |
| 2.7% | 374.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1655` |
| 2.6% | 369.4ms | 0.3% | 46.9ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` |
| 2.6% | 369.3ms | 0.0% | 0us | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 2.6% | 364.9ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:228` |
| 2.3% | 322.3ms | 0.0% | 986us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:96` |
| 2.3% | 321.3ms | 2.3% | 321.3ms | `all` | `[native code]` |
| 2.2% | 311.6ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:111` |
| 2.2% | 310.6ms | 2.2% | 310.6ms | `values` | `[native code]` |
| 2.2% | 303.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:76` |
| 2.1% | 300.8ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 2.1% | 293.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:42` |
| 2.1% | 293.0ms | 0.0% | 0us | `populateMaps` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:155` |
| 2.1% | 292.0ms | 2.1% | 292.0ms | `forEachMimeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:164` |
| 2.0% | 284.1ms | 1.6% | 220.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` |
| 2.0% | 277.8ms | 0.0% | 0us | `undici` | `undici:2` |
| 2.0% | 277.2ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1519` |
| 2.0% | 276.4ms | 0.3% | 46.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` |
| 1.9% | 274.7ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:265` |
| 1.9% | 274.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1130` |
| 1.9% | 262.3ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` |
| 1.8% | 254.8ms | 1.8% | 254.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` |
| 1.8% | 253.5ms | 0.0% | 881us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 1.7% | 244.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:674` |
| 1.7% | 235.7ms | 0.0% | 958us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:89` |
| 1.4% | 203.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-preset-solid@1.9.12+2507c47859fdd5f5\node_modules\babel-preset-solid\index.js:1` |
| 1.4% | 195.1ms | 0.2% | 29.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` |
| 1.3% | 184.6ms | 1.3% | 184.6ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaIssue.js:41` |
| 1.2% | 176.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:78` |
| 1.2% | 174.4ms | 0.0% | 0us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1994` |
| 1.2% | 171.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:123` |
| 1.2% | 171.7ms | 0.1% | 16.0ms | `getOrElseMemoize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` |
| 1.1% | 156.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:725` |
| 1.1% | 155.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:3` |
| 1.1% | 154.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+crc32@5.2.0\node_modules\@aws-crypto\crc32\build\main\index.js:5` |
| 1.1% | 154.3ms | 0.0% | 0us | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1509` |
| 1.1% | 153.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-utf8@2.3.0\node_modules\@smithy\util-utf8\dist-cjs\index.js:30` |
| 1.1% | 153.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\convertToBuffer.js:6` |
| 1.1% | 153.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-buffer-from@2.2.0\node_modules\@smithy\util-buffer-from\dist-cjs\index.js:27` |
| 1.1% | 153.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\index.js:6` |
| 1.1% | 152.8ms | 0.2% | 29.7ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` |
| 1.1% | 152.0ms | 1.1% | 152.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` |
| 1.0% | 146.2ms | 0.4% | 57.9ms | `filter` | `[native code]` |
| 1.0% | 142.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:6` |
| 1.0% | 142.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\index.js:14` |
| 1.0% | 141.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:824` |
| 1.0% | 140.8ms | 0.0% | 867us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1856` |
| 1.0% | 139.9ms | 1.0% | 139.9ms | `stringify` | `[native code]` |
| 1.0% | 139.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\index.js:32` |
| 0.9% | 137.2ms | 0.0% | 1.0ms | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` |
| 0.9% | 135.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:947` |
| 0.9% | 135.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1185` |
| 0.9% | 135.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1141` |
| 0.9% | 129.2ms | 0.9% | 129.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` |
| 0.9% | 128.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:46` |
| 0.9% | 126.0ms | 0.0% | 11.8ms | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:325` |
| 0.9% | 124.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:46` |
| 0.9% | 124.0ms | 0.0% | 0us | `_t` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:29` |
| 0.9% | 124.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:171` |
| 0.8% | 121.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1991` |
| 0.8% | 120.8ms | 0.3% | 45.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` |
| 0.8% | 119.7ms | 0.7% | 105.2ms | `statSync` | `[native code]` |
| 0.8% | 117.3ms | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.8% | 115.9ms | 0.8% | 115.9ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` |
| 0.8% | 114.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:579` |
| 0.7% | 107.4ms | 0.0% | 0us | `all` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:261` |
| 0.7% | 107.0ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:31` |
| 0.7% | 106.7ms | 0.1% | 16.7ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` |
| 0.7% | 105.8ms | 0.5% | 78.2ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1533` |
| 0.7% | 105.2ms | 0.0% | 0us | `L` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\isexe@4.0.0\node_modules\isexe\dist\commonjs\index.min.js:1` |
| 0.7% | 105.2ms | 0.0% | 0us | `which` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\which.ts:8` |
| 0.7% | 105.2ms | 0.0% | 0us | `whichSync` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:89` |
| 0.7% | 104.2ms | 0.0% | 0us | `~effect/Utils/internal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` |
| 0.7% | 104.2ms | 0.0% | 0us | `makeEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:68` |
| 0.7% | 102.5ms | 0.7% | 102.5ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` |
| 0.7% | 101.5ms | 0.0% | 0us | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` |
| 0.7% | 101.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:691` |
| 0.7% | 100.4ms | 0.0% | 12.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:756` |
| 0.7% | 97.9ms | 0.0% | 0us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:22` |
| 0.6% | 95.9ms | 0.0% | 0us | `flatIntoArrayWithCallback` | `[native code]` |
| 0.6% | 93.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:3` |
| 0.6% | 93.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1.js:7` |
| 0.6% | 93.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\vapid-helper.js:4` |
| 0.6% | 92.9ms | 0.0% | 0us | `resolve` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:270` |
| 0.6% | 92.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:173` |
| 0.6% | 92.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\api.js:3` |
| 0.6% | 92.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\encoders\der.js:8` |
| 0.6% | 92.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\encoders\index.js:5` |
| 0.6% | 89.1ms | 0.1% | 13.8ms | `scopeClose` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` |
| 0.6% | 89.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` |
| 0.6% | 88.3ms | 0.0% | 11.7ms | `from` | `[native code]` |
| 0.6% | 87.5ms | 0.2% | 30.8ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` |
| 0.5% | 79.4ms | 0.0% | 13.6ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1626` |
| 0.5% | 78.7ms | 0.0% | 0us | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:224` |
| 0.5% | 78.7ms | 0.1% | 17.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` |
| 0.5% | 77.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\context.js:28` |
| 0.5% | 77.7ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:167` |
| 0.5% | 77.7ms | 0.0% | 0us | `_traverse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:196` |
| 0.5% | 77.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\index.js:24` |
| 0.5% | 77.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\traverse-node.js:7` |
| 0.5% | 76.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:7` |
| 0.5% | 75.7ms | 0.4% | 61.9ms | `lstatSync` | `[native code]` |
| 0.5% | 75.3ms | 0.0% | 0us | `finalizer` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:132` |
| 0.5% | 74.7ms | 0.3% | 43.9ms | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:65` |
| 0.5% | 74.1ms | 0.5% | 74.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` |
| 0.5% | 73.7ms | 0.5% | 73.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` |
| 0.5% | 68.8ms | 0.5% | 68.8ms | `importModule` | `[native code]` |
| 0.4% | 66.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:682` |
| 0.4% | 65.7ms | 0.2% | 29.3ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` |
| 0.4% | 65.0ms | 0.2% | 35.5ms | `callback` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` |
| 0.4% | 64.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\index.js:4` |
| 0.4% | 64.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\parse.js:4` |
| 0.4% | 64.4ms | 0.2% | 32.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` |
| 0.4% | 64.2ms | 0.3% | 50.2ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` |
| 0.4% | 62.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\util\resolveCommand.js:4` |
| 0.4% | 62.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@2.0.2\node_modules\which\which.js:7` |
| 0.4% | 62.4ms | 0.0% | 0us | `emit` | `node:events:97` |
| 0.4% | 62.2ms | 0.4% | 62.2ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.4% | 62.1ms | 0.4% | 62.1ms | `Option` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.4% | 62.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\MessageStorage.js:534` |
| 0.4% | 62.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:5` |
| 0.4% | 62.0ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:362` |
| 0.4% | 62.0ms | 0.0% | 0us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:378` |
| 0.4% | 61.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1427` |
| 0.4% | 61.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.4% | 61.4ms | 0.0% | 850us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:116` |
| 0.4% | 60.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:170` |
| 0.4% | 60.5ms | 0.0% | 13.5ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.4% | 60.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\session.ts:367` |
| 0.4% | 60.5ms | 0.4% | 60.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:107` |
| 0.4% | 60.4ms | 0.0% | 0us | `isTitleRequest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:86` |
| 0.4% | 60.3ms | 0.0% | 0us | `findLast` | `[native code]` |
| 0.4% | 60.2ms | 0.0% | 0us | `win` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:341` |
| 0.4% | 60.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts:1114` |
| 0.4% | 60.2ms | 0.0% | 0us | `select` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:359` |
| 0.4% | 60.2ms | 0.0% | 0us | `acceptable` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:543` |
| 0.4% | 59.4ms | 0.0% | 0us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1983` |
| 0.4% | 59.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1956` |
| 0.4% | 59.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1165` |
| 0.4% | 59.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\utils\react\cleanJSXElementLiteralChild.js:7` |
| 0.4% | 59.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:418` |
| 0.4% | 59.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\react\buildChildren.js:8` |
| 0.4% | 59.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1291` |
| 0.4% | 58.8ms | 0.0% | 0us | `resolveTools` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:251` |
| 0.4% | 58.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:175` |
| 0.4% | 58.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:271` |
| 0.4% | 57.9ms | 0.2% | 31.6ms | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` |
| 0.4% | 57.7ms | 0.0% | 0us | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:321` |
| 0.4% | 57.7ms | 0.0% | 882us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:171` |
| 0.4% | 57.2ms | 0.4% | 57.2ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` |
| 0.4% | 57.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:73` |
| 0.4% | 57.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\module-types.js:40` |
| 0.4% | 57.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\configuration.js:50` |
| 0.4% | 55.1ms | 0.0% | 0us | `exit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1432` |
| 0.3% | 54.4ms | 0.0% | 0us | `workerDelegation` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:197` |
| 0.3% | 54.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1238` |
| 0.3% | 52.9ms | 0.0% | 0us | `getFrom` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:880` |
| 0.3% | 50.6ms | 0.3% | 50.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:92` |
| 0.3% | 49.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:745` |
| 0.3% | 49.3ms | 0.0% | 0us | `endReadableNT` | `internal:streams/readable:901` |
| 0.3% | 49.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeStream.js:142` |
| 0.3% | 49.3ms | 0.0% | 0us | `mapOrSame` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2393` |
| 0.3% | 49.2ms | 0.0% | 891us | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:58` |
| 0.3% | 48.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:593` |
| 0.3% | 48.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2637` |
| 0.3% | 48.8ms | 0.0% | 0us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:161` |
| 0.3% | 48.1ms | 0.0% | 0us | `realpathSync` | `node:fs:376` |
| 0.3% | 48.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:685` |
| 0.3% | 48.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:145` |
| 0.3% | 48.0ms | 0.0% | 0us | `normalizeWorkerDelegationModel` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:155` |
| 0.3% | 47.9ms | 0.0% | 0us | `buildSelection` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:81` |
| 0.3% | 47.9ms | 0.3% | 47.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.3% | 47.9ms | 0.0% | 0us | `mergeAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:728` |
| 0.3% | 47.4ms | 0.2% | 33.6ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` |
| 0.3% | 47.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:195` |
| 0.3% | 47.0ms | 0.3% | 47.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` |
| 0.3% | 46.7ms | 0.0% | 0us | `async doStream` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:641` |
| 0.3% | 46.7ms | 0.0% | 0us | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:871` |
| 0.3% | 46.5ms | 0.3% | 46.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts` |
| 0.3% | 45.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Redis.js:6` |
| 0.3% | 45.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\index.js:4` |
| 0.3% | 45.8ms | 0.1% | 14.2ms | `findIndex` | `[native code]` |
| 0.3% | 45.5ms | 0.0% | 0us | `out` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7272` |
| 0.3% | 45.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:6` |
| 0.3% | 45.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\validate.js:10` |
| 0.3% | 45.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\lowercase.js:263` |
| 0.3% | 45.2ms | 0.3% | 45.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.3% | 45.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:699` |
| 0.3% | 44.9ms | 0.1% | 14.5ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1440` |
| 0.3% | 44.7ms | 0.0% | 0us | `_template` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:203` |
| 0.3% | 44.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\string.js:8` |
| 0.3% | 44.7ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:101` |
| 0.3% | 44.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:8` |
| 0.3% | 44.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\builder.js:8` |
| 0.3% | 44.5ms | 0.0% | 0us | `Info` | `[native code]` |
| 0.3% | 44.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:214` |
| 0.3% | 44.5ms | 0.0% | 0us | `disabled` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:355` |
| 0.3% | 44.5ms | 0.0% | 0us | `fullyDenied` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` |
| 0.3% | 44.0ms | 0.0% | 0us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:380` |
| 0.3% | 43.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\lru-cache@11.5.1\node_modules\lru-cache\dist\commonjs\node\index.min.js:1` |
| 0.3% | 42.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:14` |
| 0.3% | 42.7ms | 0.0% | 13.0ms | `buildQueryFromSourceParams` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` |
| 0.3% | 42.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:6` |
| 0.3% | 42.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1550` |
| 0.3% | 42.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:9` |
| 0.3% | 41.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\index.js:28` |
| 0.3% | 41.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:16` |
| 0.3% | 41.3ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:11` |
| 0.3% | 41.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4163` |
| 0.3% | 41.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:470` |
| 0.2% | 37.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1282` |
| 0.2% | 37.4ms | 0.0% | 0us | `isHumanControllableWorker` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:227` |
| 0.2% | 36.8ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2415` |
| 0.2% | 36.2ms | 0.0% | 0us | `mapResultRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:72` |
| 0.2% | 34.8ms | 0.2% | 34.8ms | `scopeAddFinalizerExit` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` |
| 0.2% | 34.8ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:159` |
| 0.2% | 34.8ms | 0.0% | 0us | `memoMapReuse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` |
| 0.2% | 33.9ms | 0.0% | 0us | `rebuild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1691` |
| 0.2% | 33.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:416` |
| 0.2% | 33.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1256` |
| 0.2% | 33.6ms | 0.0% | 0us | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:333` |
| 0.2% | 33.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:883` |
| 0.2% | 33.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8149` |
| 0.2% | 33.3ms | 0.2% | 33.3ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` |
| 0.2% | 33.2ms | 0.2% | 33.2ms | `copyDataProperties` | `[native code]` |
| 0.2% | 33.0ms | 0.0% | 985us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1692` |
| 0.2% | 32.9ms | 0.0% | 940us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` |
| 0.2% | 32.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@parcel+watcher@2.5.1\node_modules\@parcel\watcher\wrapper.js:2` |
| 0.2% | 32.8ms | 0.0% | 986us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1121` |
| 0.2% | 32.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:393` |
| 0.2% | 32.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1269` |
| 0.2% | 32.3ms | 0.0% | 0us | `createHTMLParser` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:585` |
| 0.2% | 32.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\DOMImplementation.js:4` |
| 0.2% | 32.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\index.js:2` |
| 0.2% | 32.3ms | 0.0% | 0us | `walkCB2` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 32.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\index.js:78` |
| 0.2% | 32.0ms | 0.0% | 0us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:847` |
| 0.2% | 31.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:4` |
| 0.2% | 31.9ms | 0.0% | 0us | `async postJsonToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2342` |
| 0.2% | 31.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:770` |
| 0.2% | 31.7ms | 0.0% | 0us | `fiberAwaitAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:536` |
| 0.2% | 31.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1525` |
| 0.2% | 31.7ms | 0.0% | 0us | `query` | `bun:sqlite:348` |
| 0.2% | 31.7ms | 0.0% | 0us | `[prepareOwned]` | `bun:sqlite:331` |
| 0.2% | 31.7ms | 0.2% | 31.7ms | `prepare` | `[native code]` |
| 0.2% | 31.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:330` |
| 0.2% | 31.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:332` |
| 0.2% | 31.6ms | 0.2% | 31.6ms | `cloneObject` | `[native code]` |
| 0.2% | 31.6ms | 0.0% | 0us | `cloneInfo` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:264` |
| 0.2% | 31.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1979` |
| 0.2% | 31.5ms | 0.2% | 31.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` |
| 0.2% | 31.5ms | 0.0% | 0us | `pull` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:676` |
| 0.2% | 31.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:104` |
| 0.2% | 31.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:705` |
| 0.2% | 31.5ms | 0.0% | 0us | `compile` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:269` |
| 0.2% | 31.3ms | 0.2% | 31.3ms | `readdirCB` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 31.3ms | 0.0% | 0us | `#H` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 31.3ms | 0.0% | 0us | `walkCB3` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 31.2ms | 0.0% | 0us | `body` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1871` |
| 0.2% | 31.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:108` |
| 0.2% | 31.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:4` |
| 0.2% | 31.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\section-matter@1.0.0\node_modules\section-matter\index.js:3` |
| 0.2% | 31.1ms | 0.0% | 0us | `async get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\auto-accept-policy.ts:37` |
| 0.2% | 31.0ms | 0.0% | 0us | `checkHits` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:152` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:537` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:152` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` |
| 0.2% | 31.0ms | 0.2% | 31.0ms | `realpathNativeSync` | `[native code]` |
| 0.2% | 31.0ms | 0.0% | 0us | `bound realpathNativeSync` | `[native code]` |
| 0.2% | 31.0ms | 0.0% | 0us | `normalizePath` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:252` |
| 0.2% | 30.7ms | 0.0% | 0us | `node:http` | `node:http:2` |
| 0.2% | 30.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\printer.js:8` |
| 0.2% | 30.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:9` |
| 0.2% | 30.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:8` |
| 0.2% | 30.7ms | 0.1% | 14.5ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` |
| 0.2% | 30.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2112` |
| 0.2% | 30.6ms | 0.2% | 30.6ms | `pipe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:35` |
| 0.2% | 30.6ms | 0.0% | 0us | `async AzureAuthPlugin` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\azure.ts:21` |
| 0.2% | 30.6ms | 0.2% | 30.6ms | `next` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:57` |
| 0.2% | 30.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\utils.js:11` |
| 0.2% | 30.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha1.js:4` |
| 0.2% | 30.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:41` |
| 0.2% | 30.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\_md.js:5` |
| 0.2% | 30.6ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:62` |
| 0.2% | 30.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:93` |
| 0.2% | 30.4ms | 0.0% | 1.0ms | `mergeAllEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` |
| 0.2% | 30.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:365` |
| 0.2% | 30.4ms | 0.2% | 30.4ms | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:185` |
| 0.2% | 30.4ms | 0.0% | 912us | `Objects` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` |
| 0.2% | 30.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\main.js:22` |
| 0.2% | 30.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\messageReader.js:11` |
| 0.2% | 30.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\node.js:7` |
| 0.2% | 30.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\ril.js:8` |
| 0.2% | 30.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:52` |
| 0.2% | 30.3ms | 0.0% | 1.0ms | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:62` |
| 0.2% | 30.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2563` |
| 0.2% | 30.2ms | 0.2% | 30.2ms | `forkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2075` |
| 0.2% | 30.2ms | 0.0% | 2.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:95` |
| 0.2% | 30.2ms | 0.0% | 0us | `readableAddChunkPushByteMode` | `internal:streams/readable:242` |
| 0.2% | 30.2ms | 0.0% | 0us | `onDataIncomingMessage` | `internal:http:81` |
| 0.2% | 30.1ms | 0.1% | 14.1ms | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:154` |
| 0.2% | 30.1ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:51` |
| 0.2% | 30.1ms | 0.0% | 0us | `clone` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\util.js:262` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `next` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:54` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `defineFunctionLength` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:775` |
| 0.2% | 30.0ms | 0.2% | 30.0ms | `query` | `bun:sqlite:342` |
| 0.2% | 30.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:19` |
| 0.2% | 30.0ms | 0.0% | 0us | `_debug` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:17` |
| 0.2% | 30.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:31` |
| 0.2% | 30.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\index.js:9` |
| 0.2% | 29.9ms | 0.0% | 0us | `getCandidates` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1919` |
| 0.2% | 29.8ms | 0.2% | 29.8ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` |
| 0.2% | 29.8ms | 0.0% | 0us | `checkHits` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:151` |
| 0.2% | 29.8ms | 0.2% | 29.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` |
| 0.2% | 29.7ms | 0.2% | 29.7ms | `assign` | `[native code]` |
| 0.2% | 29.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:4` |
| 0.2% | 29.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fill-range@7.1.1\node_modules\fill-range\index.js:11` |
| 0.2% | 29.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\to-regex-range@5.0.1\node_modules\to-regex-range\index.js:10` |
| 0.2% | 29.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\lib\compile.js:3` |
| 0.2% | 29.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` |
| 0.2% | 29.5ms | 0.0% | 0us | `rebuild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1701` |
| 0.2% | 29.5ms | 0.2% | 29.5ms | `indexOf` | `[native code]` |
| 0.2% | 29.4ms | 0.2% | 28.4ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` |
| 0.2% | 29.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:869` |
| 0.2% | 29.3ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts:391` |
| 0.2% | 29.3ms | 0.2% | 29.3ms | `layerFromPath` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts` |
| 0.2% | 29.2ms | 0.2% | 29.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.2% | 29.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:1150` |
| 0.2% | 28.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\bash.ts:24` |
| 0.2% | 28.6ms | 0.0% | 0us | `gitbash` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:366` |
| 0.2% | 28.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\core.js:22` |
| 0.2% | 28.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:4` |
| 0.2% | 28.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\runtime\uri.js:3` |
| 0.2% | 28.4ms | 0.0% | 0us | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:125` |
| 0.2% | 28.4ms | 0.0% | 857us | `SQLiteEffectSelectBase` | `[native code]` |
| 0.2% | 28.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1328` |
| 0.2% | 28.3ms | 0.0% | 13.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` |
| 0.2% | 28.3ms | 0.2% | 28.3ms | `Error` | `[native code]` |
| 0.2% | 28.1ms | 0.2% | 28.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js` |
| 0.2% | 28.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:798` |
| 0.2% | 28.0ms | 0.0% | 0us | `D` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.2% | 28.0ms | 0.0% | 0us | `ht` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.2% | 28.0ms | 0.2% | 28.0ms | `slice` | `[native code]` |
| 0.2% | 28.0ms | 0.0% | 0us | `async Je` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 28.0ms | 0.0% | 0us | `async scan` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\glob.ts:24` |
| 0.2% | 28.0ms | 0.0% | 0us | `I` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.2% | 28.0ms | 0.0% | 0us | `async load` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\command.ts:38` |
| 0.2% | 28.0ms | 0.0% | 0us | `async load` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\command.ts:15` |
| 0.2% | 28.0ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.2% | 28.0ms | 0.0% | 0us | `ge` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.2% | 28.0ms | 0.0% | 0us | `Gt` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` |
| 0.2% | 27.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1549` |
| 0.2% | 27.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:9` |
| 0.2% | 27.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:39` |
| 0.2% | 27.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` |
| 0.2% | 27.5ms | 0.0% | 0us | `SQLiteSelectQueryBuilderBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:60` |
| 0.1% | 27.3ms | 0.1% | 27.3ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:25` |
| 0.1% | 26.9ms | 0.0% | 0us | `channel` | `node:diagnostics_channel:139` |
| 0.1% | 26.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1592` |
| 0.1% | 26.7ms | 0.1% | 26.7ms | `create` | `[native code]` |
| 0.1% | 26.6ms | 0.1% | 26.6ms | `get` | `[native code]` |
| 0.1% | 26.3ms | 0.1% | 26.3ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:627` |
| 0.1% | 25.7ms | 0.1% | 25.7ms | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:220` |
| 0.1% | 25.1ms | 0.0% | 0us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:23` |
| 0.1% | 24.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index-cjs.js:5` |
| 0.1% | 23.6ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\MessageStorage.js:530` |
| 0.1% | 23.6ms | 0.1% | 23.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` |
| 0.1% | 23.6ms | 0.0% | 0us | `effectImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:637` |
| 0.1% | 23.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:423` |
| 0.1% | 22.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:885` |
| 0.1% | 22.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:5` |
| 0.1% | 21.8ms | 0.1% | 21.8ms | `escapeName` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` |
| 0.1% | 21.7ms | 0.0% | 0us | `fromRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:137` |
| 0.1% | 21.2ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1120` |
| 0.1% | 19.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:96` |
| 0.1% | 19.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\utils.js:8` |
| 0.1% | 19.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\package.js:14` |
| 0.1% | 19.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:72` |
| 0.1% | 19.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\gensync-utils\fs.js:22` |
| 0.1% | 19.7ms | 0.0% | 0us | `_fs` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\gensync-utils\fs.js:8` |
| 0.1% | 19.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:977` |
| 0.1% | 18.8ms | 0.1% | 18.8ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 18.6ms | 0.0% | 0us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1327` |
| 0.1% | 18.2ms | 0.1% | 18.2ms | `flatIntoArray` | `[native code]` |
| 0.1% | 18.0ms | 0.1% | 18.0ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` |
| 0.1% | 18.0ms | 0.1% | 18.0ms | `getReferenceUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` |
| 0.1% | 18.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:896` |
| 0.1% | 17.9ms | 0.0% | 0us | `join` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:342` |
| 0.1% | 17.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:5` |
| 0.1% | 17.8ms | 0.1% | 17.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\config.ts` |
| 0.1% | 17.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:734` |
| 0.1% | 17.7ms | 0.1% | 17.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.1% | 17.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:50` |
| 0.1% | 17.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\route.js:3` |
| 0.1% | 17.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way@9.6.0\node_modules\find-my-way\index.js:30` |
| 0.1% | 17.4ms | 0.0% | 893us | `run` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:673` |
| 0.1% | 17.4ms | 0.0% | 0us | `makeEffect` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:69` |
| 0.1% | 17.3ms | 0.1% | 17.3ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` |
| 0.1% | 17.3ms | 0.1% | 16.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:85` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `exitAsVoidAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1089` |
| 0.1% | 17.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:325` |
| 0.1% | 17.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts:625` |
| 0.1% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\index.ts:264` |
| 0.1% | 17.0ms | 0.0% | 0us | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:287` |
| 0.1% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1869` |
| 0.1% | 17.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:928` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\Envelope.js:189` |
| 0.1% | 17.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:285` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `rmSync` | `[native code]` |
| 0.1% | 16.9ms | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2350` |
| 0.1% | 16.8ms | 0.0% | 0us | `internal:fs/streams` | `internal:fs/streams:2` |
| 0.1% | 16.8ms | 0.0% | 0us | `internal:streams/pipeline` | `internal:streams/pipeline:2` |
| 0.1% | 16.8ms | 0.0% | 0us | `internal:streams/compose` | `internal:streams/compose:2` |
| 0.1% | 16.8ms | 0.0% | 0us | `node:stream` | `node:stream:2` |
| 0.1% | 16.8ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.1% | 16.8ms | 0.0% | 0us | `node:tty` | `node:tty:7` |
| 0.1% | 16.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:5` |
| 0.1% | 16.8ms | 0.0% | 0us | `internal:stream` | `internal:stream:2` |
| 0.1% | 16.7ms | 0.1% | 16.7ms | `parse` | `[native code]` |
| 0.1% | 16.7ms | 0.0% | 0us | `ZodString` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.1% | 16.7ms | 0.0% | 0us | `_string` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\api.js:7` |
| 0.1% | 16.7ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:222` |
| 0.1% | 16.6ms | 0.0% | 0us | `startPart` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:114` |
| 0.1% | 16.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3872` |
| 0.1% | 16.6ms | 0.0% | 0us | `beginTurn` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:83` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `Int32Array` | `[native code]` |
| 0.1% | 16.6ms | 0.0% | 0us | `SpadDetector` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\detector.ts:61` |
| 0.1% | 16.6ms | 0.0% | 0us | `currentTurnUploads` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:225` |
| 0.1% | 16.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:793` |
| 0.1% | 16.6ms | 0.1% | 16.6ms | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1893` |
| 0.1% | 16.5ms | 0.1% | 15.6ms | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:100` |
| 0.1% | 16.5ms | 0.1% | 16.5ms | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1719` |
| 0.1% | 16.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:809` |
| 0.1% | 16.5ms | 0.0% | 0us | `canParseHTMLNatively` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:573` |
| 0.1% | 16.5ms | 0.1% | 16.5ms | `(unknown)` | `[native code]` |
| 0.1% | 16.5ms | 0.0% | 0us | `streamText` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6414` |
| 0.1% | 16.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1142` |
| 0.1% | 16.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:44` |
| 0.1% | 16.3ms | 0.0% | 993us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1119` |
| 0.1% | 16.3ms | 0.1% | 16.3ms | `scopeMakeUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1574` |
| 0.1% | 16.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:497` |
| 0.1% | 16.3ms | 0.0% | 0us | `fromJsonString` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6346` |
| 0.1% | 16.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2598` |
| 0.1% | 16.3ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\event.ts:108` |
| 0.1% | 16.3ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\event.ts:92` |
| 0.1% | 16.3ms | 0.0% | 0us | `rebuild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2001` |
| 0.1% | 16.3ms | 0.0% | 0us | `StreamSse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:154` |
| 0.1% | 16.3ms | 0.0% | 0us | `sseDataJsonSchema` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:171` |
| 0.1% | 16.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` |
| 0.1% | 16.2ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:14` |
| 0.1% | 16.2ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:229` |
| 0.1% | 16.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2697` |
| 0.1% | 16.2ms | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2326` |
| 0.1% | 16.2ms | 0.1% | 15.2ms | `filterDisablePropagation` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2321` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:21` |
| 0.1% | 16.1ms | 0.0% | 0us | `buildUpdateQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:62` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\serializer\index.js:6` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:11` |
| 0.1% | 16.1ms | 0.0% | 0us | `ZodObject` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:64` |
| 0.1% | 16.1ms | 0.0% | 0us | `object` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:791` |
| 0.1% | 16.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1020` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:738` |
| 0.1% | 16.1ms | 0.0% | 0us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1910` |
| 0.1% | 16.1ms | 0.0% | 952us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts` |
| 0.1% | 16.1ms | 0.1% | 16.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:562` |
| 0.1% | 16.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:782` |
| 0.1% | 16.1ms | 0.0% | 0us | `bound max` | `[native code]` |
| 0.1% | 16.1ms | 0.0% | 0us | `bound clone` | `[native code]` |
| 0.1% | 16.1ms | 0.0% | 0us | `ZodNumber` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.1% | 16.1ms | 0.0% | 0us | `bound check` | `[native code]` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\propagation-api.js:21` |
| 0.1% | 16.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:69` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `join` | `[native code]` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1523` |
| 0.1% | 16.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js:599` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `nominal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Brand.js` |
| 0.1% | 16.0ms | 0.1% | 16.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2843` |
| 0.1% | 16.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\skill.ts:36` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3499` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `streamText` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6381` |
| 0.1% | 15.9ms | 0.1% | 15.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:86` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:128` |
| 0.1% | 15.8ms | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpMiddleware.js:155` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `attribute` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:287` |
| 0.1% | 15.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:37` |
| 0.1% | 15.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:154` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:598` |
| 0.1% | 15.7ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:120` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `buildOrderBy` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:137` |
| 0.1% | 15.7ms | 0.1% | 15.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1395` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:150` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:203` |
| 0.1% | 15.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:259` |
| 0.1% | 15.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:234` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\index.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:5` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\defaults.js:3` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml.js:4` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\loader.js:9` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\engines.js:3` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\schema\default_full.js:20` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\type\js\function.js:15` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:912` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:840` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:74` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:5` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `~effect/Effect/successCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:9` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:52` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:296` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\db.ts:212` |
| 0.1% | 15.6ms | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\effect-core\query-effect.js:8` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\db.ts:221` |
| 0.1% | 15.6ms | 0.0% | 0us | `ExpansionLane` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:77` |
| 0.1% | 15.6ms | 0.1% | 15.6ms | `addObserver` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:373` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1271` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:538` |
| 0.1% | 15.6ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:33` |
| 0.1% | 15.6ms | 0.0% | 0us | `define` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:91` |
| 0.1% | 15.6ms | 0.0% | 0us | `makeOption` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:92` |
| 0.1% | 15.6ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:542` |
| 0.1% | 15.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:3` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `retrySqliteBusyCause` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:106` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1156` |
| 0.1% | 15.5ms | 0.0% | 0us | `DefaultStreamTextResult` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6567` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `DelayedPromise` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:114` |
| 0.1% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:9` |
| 0.1% | 15.5ms | 0.0% | 0us | `toJsonSchemaDocument` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7818` |
| 0.1% | 15.5ms | 0.0% | 0us | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:320` |
| 0.1% | 15.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-runtime.ts:568` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `collectJsonSchemaChecks` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js` |
| 0.1% | 15.5ms | 0.0% | 0us | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:331` |
| 0.1% | 15.5ms | 0.0% | 0us | `describeDefinition` | `C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-runtime.ts:449` |
| 0.1% | 15.5ms | 0.0% | 0us | `toJsonSchemaDocument` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:297` |
| 0.1% | 15.5ms | 0.0% | 0us | `on` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:534` |
| 0.1% | 15.5ms | 0.0% | 0us | `toJsonSchemaMultiDocument` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:316` |
| 0.1% | 15.5ms | 0.0% | 0us | `toTypeScript` | `C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-schema.ts:201` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `defineProperty` | `[native code]` |
| 0.1% | 15.5ms | 0.1% | 15.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:112` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:804` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\index.js:14` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:17` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:5` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\utils\bedrock-media.ts:13` |
| 0.1% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:165` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts:288` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:182` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts` |
| 0.1% | 15.3ms | 0.0% | 0us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:492` |
| 0.1% | 15.3ms | 0.0% | 0us | `getRef` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:370` |
| 0.1% | 15.3ms | 0.0% | 0us | `node:worker_threads` | `node:worker_threads:366` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `internal:worker/messaging` | `internal:worker/messaging:2` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `assertNodeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js:103` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\flow.js:346` |
| 0.1% | 15.3ms | 0.0% | 0us | `validateType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js:49` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1358` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:109` |
| 0.1% | 15.3ms | 0.0% | 0us | `Literal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1419` |
| 0.1% | 15.3ms | 0.0% | 0us | `Literals` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2138` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:40` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\reply.js:36` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\handle-request.js:5` |
| 0.1% | 15.3ms | 0.0% | 0us | `on` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:202` |
| 0.1% | 15.3ms | 0.0% | 0us | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:51` |
| 0.1% | 15.3ms | 0.0% | 0us | `recur` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:86` |
| 0.1% | 15.3ms | 0.0% | 0us | `fromSchema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:48` |
| 0.1% | 15.3ms | 0.0% | 0us | `toJsonSchemaDocument` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7817` |
| 0.1% | 15.3ms | 0.0% | 0us | `fromASTs` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:28` |
| 0.1% | 15.3ms | 0.0% | 0us | `fromAST` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:16` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:8` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:206` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `resolve` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1497` |
| 0.1% | 15.3ms | 0.1% | 15.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:125806` |
| 0.1% | 15.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:11` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `immutableURLSetter` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js` |
| 0.1% | 15.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js:107` |
| 0.1% | 15.2ms | 0.1% | 14.2ms | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:21` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `createSetOperator` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:266` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:303` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\index.ts:229` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\scheduled-task\executor.ts:87` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts:29` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `SQLiteEffectPreparedQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:52` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:272` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `get` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:566` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `loop` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:545` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:262` |
| 0.1% | 15.2ms | 0.0% | 0us | `_await` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:79` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `buildUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:48` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:803` |
| 0.1% | 15.2ms | 0.1% | 15.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\clone\cloneNode.js:3` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:459` |
| 0.1% | 15.2ms | 0.0% | 0us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1720` |
| 0.1% | 15.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\input.ts:92` |
| 0.1% | 15.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\exchange\sqlite.ts:70` |
| 0.1% | 15.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\websearch.ts:113` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:167` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:17` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `fromIterable` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Array.js:218` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:81` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\group.ts:918` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:98` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `onSuccess` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:336` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `triggerForEvent` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts:282` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts:695` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:89` |
| 0.1% | 15.1ms | 0.0% | 0us | `observeYieldStatistic` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield-statistics.ts:214` |
| 0.1% | 15.1ms | 0.0% | 0us | `observeMoments` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield-statistics.ts:146` |
| 0.1% | 15.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs:1624` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `Immer2` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1111` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:636` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:74` |
| 0.1% | 15.1ms | 0.1% | 15.1ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:11` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\nodes.js:8` |
| 0.1% | 15.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:11` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1160` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:599` |
| 0.1% | 15.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:368` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:1363` |
| 0.1% | 15.0ms | 0.0% | 0us | `annotate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:14` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `scopeRemoveFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1569` |
| 0.1% | 15.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\project.ts:30` |
| 0.1% | 15.0ms | 0.0% | 0us | `async pull` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:171` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `async pull` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:146` |
| 0.1% | 15.0ms | 0.0% | 0us | `onRSDefaultControllerPullFulfilled` | `[native code]` |
| 0.1% | 15.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\goal.ts:23` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1336` |
| 0.1% | 15.0ms | 0.1% | 15.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2189` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:153` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\symbols.ts` |
| 0.1% | 14.9ms | 0.0% | 0us | `getImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:201` |
| 0.1% | 14.9ms | 0.1% | 13.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\MutableHashMap.js:193` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:7` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:6` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@6.0.1\node_modules\entities\dist\commonjs\decode.js:9` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:4` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:10` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:31` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `scopeForkUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1538` |
| 0.1% | 14.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1237` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js` |
| 0.1% | 14.9ms | 0.1% | 14.9ms | `exitAsVoidAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm-session-projector.ts:33` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:962` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:541` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-modules-commonjs@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-modules-commonjs\lib\index.js:14` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:8` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\normalize-and-load-metadata.js:11` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:51` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:334` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:231` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:669` |
| 0.1% | 14.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:48` |
| 0.1% | 14.8ms | 0.0% | 0us | `async postJsonToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2335` |
| 0.1% | 14.8ms | 0.1% | 14.8ms | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs` |
| 0.1% | 14.8ms | 0.0% | 0us | `async postToApi` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2436` |
| 0.1% | 14.8ms | 0.0% | 0us | `interruptUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:398` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:5` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\applicator\index.js:18` |
| 0.1% | 14.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\draft7.js:5` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:829` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1608` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:13` |
| 0.1% | 14.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\namespace.js:8` |
| 0.1% | 14.7ms | 0.0% | 0us | `positiveInteger` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\runtime-flags.ts:6` |
| 0.1% | 14.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\runtime-flags.ts:82` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `number` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` |
| 0.1% | 14.7ms | 0.0% | 0us | `Socket` | `node:net:901` |
| 0.1% | 14.7ms | 0.0% | 0us | `onServerConnection` | `node:_http_server:668` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `Duplex` | `internal:streams/duplex:6` |
| 0.1% | 14.7ms | 0.0% | 0us | `Socket` | `node:_http_server:899` |
| 0.1% | 14.7ms | 0.1% | 14.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts` |
| 0.1% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1553` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts` |
| 0.1% | 14.6ms | 0.1% | 14.6ms | `match` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:7` |
| 0.1% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:8` |
| 0.1% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+core@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\core\build\src\index.js:35` |
| 0.1% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:9` |
| 0.1% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\ResourceImpl.js:9` |
| 0.1% | 14.6ms | 0.0% | 0us | `buildSelectQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:153` |
| 0.1% | 14.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:3` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `Channel` | `node:diagnostics_channel` |
| 0.1% | 14.5ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\input.ts:1205` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1155` |
| 0.1% | 14.5ms | 0.0% | 0us | `ReadableStream` | `[native code]` |
| 0.1% | 14.5ms | 0.1% | 14.5ms | `async start` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6340` |
| 0.1% | 14.5ms | 0.0% | 0us | `async streamStep` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:7219` |
| 0.1% | 14.5ms | 0.0% | 0us | `runToolsTransformation` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6338` |
| 0.1% | 14.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:21` |
| 0.1% | 14.4ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\effect-flock.ts:283` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:242` |
| 0.1% | 14.4ms | 0.0% | 0us | `exponential` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js:1454` |
| 0.1% | 14.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\effect-flock.ts:49` |
| 0.1% | 14.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:110` |
| 0.1% | 14.4ms | 0.0% | 0us | `getPayload` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:141` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:25` |
| 0.1% | 14.4ms | 0.1% | 14.4ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:27` |
| 0.1% | 14.3ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\browser.ts:721` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:357` |
| 0.1% | 14.3ms | 0.0% | 0us | `getNextNode` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:412` |
| 0.1% | 14.3ms | 0.0% | 0us | `find` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:212` |
| 0.1% | 14.3ms | 0.0% | 0us | `onNodeHTTPRequest` | `node:_http_server:586` |
| 0.1% | 14.3ms | 0.0% | 0us | `emit` | `node:events:103` |
| 0.1% | 14.3ms | 0.0% | 0us | `findStaticMatchingChild` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:304` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpRouter.js:108` |
| 0.1% | 14.3ms | 0.0% | 0us | `handler` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:135` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:95` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:12` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:26` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:18` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SynchronizedRef.js:214` |
| 0.1% | 14.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:361` |
| 0.1% | 14.3ms | 0.0% | 0us | `disabled` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:354` |
| 0.1% | 14.3ms | 0.1% | 14.3ms | `Set` | `[native code]` |
| 0.1% | 14.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js:4321` |
| 0.1% | 14.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:27` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts` |
| 0.1% | 14.2ms | 0.1% | 14.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:138` |
| 0.1% | 14.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiError.js:166` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:11` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `getOwnPropertyDescriptors` | `[native code]` |
| 0.1% | 14.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:72` |
| 0.1% | 14.1ms | 0.0% | 0us | `modifyOwnPropertyDescriptors` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2300` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:109` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `sql` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:319` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:8` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:7` |
| 0.1% | 14.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\multicast-dns@7.2.5\node_modules\multicast-dns\index.js:3` |
| 0.1% | 14.1ms | 0.1% | 14.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts` |
| 0.1% | 14.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-limit-recovery.ts:15` |
| 0.1% | 14.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-attachment.ts:211` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:65` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:11` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\transaction.js:6` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:839` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\lsp\lsp.ts` |
| 0.1% | 14.0ms | 0.0% | 0us | `SQLiteEffectPreparedQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:79` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js:42` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\internal\logLevelLogger.js:19` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:19` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\baggage\utils.js:19` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:9` |
| 0.1% | 14.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\diag.js:20` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `mergeAll` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js` |
| 0.1% | 14.0ms | 0.0% | 0us | `bound extend` | `[native code]` |
| 0.1% | 14.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1810` |
| 0.1% | 14.0ms | 0.1% | 14.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:29` |
| 0.1% | 14.0ms | 0.0% | 0us | `ZodObject` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:44` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:73` |
| 0.1% | 13.9ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:17` |
| 0.1% | 13.9ms | 0.1% | 13.9ms | `push` | `[native code]` |
| 0.1% | 13.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:17` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `createLaceAISdkObserver` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\lace-ai-sdk-observer.ts` |
| 0.1% | 13.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:48` |
| 0.1% | 13.8ms | 0.1% | 13.8ms | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.1% | 13.7ms | 0.0% | 0us | `realpathSync` | `node:fs:358` |
| 0.1% | 13.7ms | 0.1% | 13.7ms | `~effect/Effect/ensureCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` |
| 0.1% | 13.7ms | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:320` |
| 0.1% | 13.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:525` |
| 0.1% | 13.7ms | 0.0% | 0us | `stateFor` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:366` |
| 0.0% | 13.7ms | 0.0% | 13.7ms | `has` | `[native code]` |
| 0.0% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:5` |
| 0.0% | 13.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:891` |
| 0.0% | 13.6ms | 0.0% | 13.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` |
| 0.0% | 13.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\session-limit-recovery.ts:55` |
| 0.0% | 13.5ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:32` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `onTSSinkWriteBackpressureChangeFulfilled` | `[native code]` |
| 0.0% | 13.5ms | 0.0% | 0us | `async ClaudeAuthPlugin` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\claude.ts:131` |
| 0.0% | 13.5ms | 0.0% | 0us | `exists` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\claude\availability.ts:78` |
| 0.0% | 13.5ms | 0.0% | 13.5ms | `existsSync` | `[native code]` |
| 0.0% | 13.5ms | 0.0% | 0us | `resolveCliPath` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\claude\availability.ts:85` |
| 0.0% | 13.5ms | 0.0% | 0us | `existsSync` | `node:fs:217` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `scopeAddFinalizerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1882` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `entries` | `[native code]` |
| 0.0% | 13.4ms | 0.0% | 0us | `orderSelectedFields` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:174` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:567` |
| 0.0% | 13.3ms | 0.0% | 0us | `publishEvent` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1335` |
| 0.0% | 13.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1547` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `gen` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `FiberImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts:20` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:105` |
| 0.0% | 13.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\supports-color@8.1.1\node_modules\supports-color\index.js:4` |
| 0.0% | 13.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:32` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:52` |
| 0.0% | 13.1ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaRepresentation.js:523` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+server@2.0.0\node_modules\@modelcontextprotocol\server\dist\src-CX2iR2pK.mjs:5914` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `captureSqliteQuerySite` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts` |
| 0.0% | 13.1ms | 0.0% | 0us | `applyUsage` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:139` |
| 0.0% | 13.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:912` |
| 0.0% | 13.1ms | 0.0% | 0us | `markListenerGenerationClosed` | `node:_http_server:91` |
| 0.0% | 13.1ms | 0.0% | 0us | `emitCloseServer` | `node:_http_server:88` |
| 0.0% | 13.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:63` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `scopeCloseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1507` |
| 0.0% | 13.0ms | 0.0% | 13.0ms | `async return` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:5983` |
| 0.0% | 12.8ms | 0.0% | 0us | `ownerKeys` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:81` |
| 0.0% | 12.8ms | 0.0% | 0us | `registerOwned` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:85` |
| 0.0% | 12.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:455` |
| 0.0% | 12.8ms | 0.0% | 12.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:162` |
| 0.0% | 12.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:409` |
| 0.0% | 12.8ms | 0.0% | 0us | `or` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js:69` |
| 0.0% | 12.8ms | 0.0% | 0us | `getLocalAddresses` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\definitions.js:67` |
| 0.0% | 12.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\definitions.js:1209` |
| 0.0% | 12.8ms | 0.0% | 12.8ms | `networkInterfaces` | `[native code]` |
| 0.0% | 12.7ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:252` |
| 0.0% | 12.7ms | 0.0% | 12.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpPlatform.js` |
| 0.0% | 12.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ManagedRuntime.js:101` |
| 0.0% | 12.7ms | 0.0% | 0us | `async scenario` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:244` |
| 0.0% | 12.7ms | 0.0% | 0us | `async scenario` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:95` |
| 0.0% | 12.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:13` |
| 0.0% | 12.7ms | 0.0% | 12.7ms | `mapGetResult` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:166` |
| 0.0% | 12.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3065` |
| 0.0% | 12.6ms | 0.0% | 12.6ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\fork\credentials.ts` |
| 0.0% | 12.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:37` |
| 0.0% | 12.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:1282` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1568` |
| 0.0% | 12.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1670` |
| 0.0% | 12.3ms | 0.0% | 0us | `set` | `node:diagnostics_channel:22` |
| 0.0% | 12.3ms | 0.0% | 0us | `WeakReference` | `[native code]` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `WeakRef` | `[native code]` |
| 0.0% | 12.3ms | 0.0% | 0us | `Channel` | `node:diagnostics_channel:106` |
| 0.0% | 12.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:83` |
| 0.0% | 12.3ms | 0.0% | 12.3ms | `createJoin` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` |
| 0.0% | 12.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:411` |
| 0.0% | 12.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:210` |
| 0.0% | 12.2ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:1206` |
| 0.0% | 12.2ms | 0.0% | 0us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:14` |
| 0.0% | 12.2ms | 0.0% | 1.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` |
| 0.0% | 12.2ms | 0.0% | 0us | `currentTimeNanosUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2499` |
| 0.0% | 12.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:8` |
| 0.0% | 12.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1781` |
| 0.0% | 11.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts:444` |
| 0.0% | 11.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:4` |
| 0.0% | 11.8ms | 0.0% | 11.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\member-session.ts` |
| 0.0% | 11.8ms | 0.0% | 11.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.0% | 11.7ms | 0.0% | 0us | `fn` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:787` |
| 0.0% | 11.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js:6` |
| 0.0% | 11.5ms | 0.0% | 11.5ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js:6` |
| 0.0% | 11.5ms | 0.0% | 0us | `prepareQuery` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:75` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-descriptors.js:16` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\item.js:16` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:18` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\is-core-module@2.16.2\node_modules\is-core-module\index.js:3` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\resolve@1.22.12\node_modules\resolve\index.js:1` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:11` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\resolve@1.22.12\node_modules\resolve\lib\async.js:7` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\utils.js:14` |
| 0.0% | 11.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:11` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `scopeMakeUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1576` |
| 0.0% | 11.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+core@3.24.5\node_modules\@smithy\core\dist-cjs\submodules\serde\index.js:6` |
| 0.0% | 11.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-hex-encoding@4.3.5\node_modules\@smithy\util-hex-encoding\dist-cjs\index.js:4` |
| 0.0% | 11.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+core@3.24.5\node_modules\@smithy\core\dist-cjs\submodules\endpoints\index.js:3` |
| 0.0% | 10.8ms | 0.0% | 0us | `optional` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:13` |
| 0.0% | 10.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1284` |
| 0.0% | 10.8ms | 0.0% | 0us | `optionalKey` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2427` |
| 0.0% | 10.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\project.ts:15` |
| 0.0% | 10.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\scheduled-task\session-binding.ts:143` |
| 0.0% | 10.6ms | 0.0% | 10.6ms | `flat` | `[native code]` |
| 0.0% | 10.6ms | 0.0% | 0us | `evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:47` |
| 0.0% | 10.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Ref.js:370` |
| 0.0% | 10.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:364` |
| 0.0% | 10.4ms | 0.0% | 10.4ms | `bigint` | `[native code]` |
| 0.0% | 10.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2419` |
| 0.0% | 10.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\avvio@9.2.0\node_modules\avvio\boot.js:24` |
| 0.0% | 10.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:47` |
| 0.0% | 10.3ms | 0.0% | 10.3ms | `hostname` | `[native code]` |
| 0.0% | 10.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\oauth.js:28` |
| 0.0% | 9.2ms | 0.0% | 0us | `ZodString` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` |
| 0.0% | 9.2ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1334` |
| 0.0% | 9.2ms | 0.0% | 0us | `_string` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\api.js:5` |
| 0.0% | 9.2ms | 0.0% | 9.2ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:116` |
| 0.0% | 8.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:10` |
| 0.0% | 8.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkg-up@3.1.0\node_modules\pkg-up\index.js:2` |
| 0.0% | 8.4ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-up@3.0.0\node_modules\find-up\index.js:3` |
| 0.0% | 6.4ms | 0.0% | 0us | `normalizeWorkerDelegationModel` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:168` |
| 0.0% | 4.5ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\ShardingConfig.js:112` |
| 0.0% | 4.5ms | 0.0% | 4.5ms | `all` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `is` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` |
| 0.0% | 3.6ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:8` |
| 0.0% | 3.1ms | 0.0% | 0us | `reduce` | `[native code]` |
| 0.0% | 2.9ms | 0.0% | 0us | `node:fs` | `node:fs:8` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:286` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:882` |
| 0.0% | 2.8ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:66` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:959` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:36` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:5` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:297` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `getCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` |
| 0.0% | 2.1ms | 0.0% | 0us | `~effect/Effect/failureCont` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1630` |
| 0.0% | 2.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1122` |
| 0.0% | 2.0ms | 0.0% | 0us | `async doTransform` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11936` |
| 0.0% | 2.0ms | 0.0% | 905us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:783` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:779` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\util\resolveCommand.js:5` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1865` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:33` |
| 0.0% | 1.9ms | 0.0% | 0us | `boundedSqlitePermit` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts:19` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\safe-regex2@5.1.1\node_modules\safe-regex2\index.js:3` |
| 0.0% | 1.9ms | 0.0% | 994us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:199` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\react\isReactComponent.js:7` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\automation.ts:595` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\locate-path@3.0.0\node_modules\locate-path\index.js:4` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `sqliteStatementClass` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-diagnostics.ts:18` |
| 0.0% | 1.8ms | 0.0% | 0us | `statement` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:48` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:22` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1544` |
| 0.0% | 1.8ms | 0.0% | 878us | `buildUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 1.8ms | 0.0% | 915us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:89` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1128` |
| 0.0% | 1.8ms | 0.0% | 0us | `string` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:290` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:21` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\htmlparser2@8.0.2\node_modules\htmlparser2\lib\esm\Parser.js:21` |
| 0.0% | 1.8ms | 0.0% | 942us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:59` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:768` |
| 0.0% | 1.8ms | 0.0% | 0us | `set` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:187` |
| 0.0% | 1.8ms | 0.0% | 0us | `mapUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:57` |
| 0.0% | 1.8ms | 0.0% | 914us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` |
| 0.0% | 1.8ms | 0.0% | 0us | `async transform` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2294` |
| 0.0% | 1.7ms | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2347` |
| 0.0% | 1.7ms | 0.0% | 911us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1076` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `getCandidates` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1910` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:13` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1602` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:5` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `mapFromDriverValue` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:44` |
| 0.0% | 1.1ms | 0.0% | 0us | `__name` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+is-array-buffer@2.2.0\node_modules\@smithy\is-array-buffer\dist-cjs\index.js:5` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+is-array-buffer@2.2.0\node_modules\@smithy\is-array-buffer\dist-cjs\index.js:26` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:174` |
| 0.0% | 1.1ms | 0.0% | 0us | `collectIssues` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2813` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2244` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:4356` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `takeAuditCases` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:416` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1909` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:28` |
| 0.0% | 1.0ms | 0.0% | 0us | `define` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:85` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:27` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:573` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `doneExitFromCause` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pull.js:168` |
| 0.0% | 1.0ms | 0.0% | 0us | `onCause` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:160` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:8` |
| 0.0% | 1.0ms | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 0.0% | 1.0ms | 0.0% | 0us | `from` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:117` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:148` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\locate-path@3.0.0\node_modules\locate-path\index.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `set` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `children` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `walkCB` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `q` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `Promise` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `processPatterns` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `async walk` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `#N` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `child` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:238` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1061` |
| 0.0% | 1.0ms | 0.0% | 0us | `ZodArray` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:681` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:922` |
| 0.0% | 1.0ms | 0.0% | 0us | `_array` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\api.js:712` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:706` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts:359` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `walk` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:180` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `every` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `async transformParams` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:454` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `sdkKey` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:43` |
| 0.0% | 1.0ms | 0.0% | 0us | `message` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:487` |
| 0.0% | 1.0ms | 0.0% | 0us | `async doStream` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11955` |
| 0.0% | 1.0ms | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:7205` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1837` |
| 0.0% | 1.0ms | 0.0% | 0us | `async doStream` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11958` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\defineElement.js:21` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:583` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\index.js:15` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:124` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\credential.ts:106` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\ShardingConfig.js:29` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1796` |
| 0.0% | 1.0ms | 0.0% | 0us | `make` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7298` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `RunnerAddress` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `mapAllResult` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:137` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `patch` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1775` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `topP` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:550` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:151` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3770` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `BigInt` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:72` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:521` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `mergeQueries` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` |
| 0.0% | 1.0ms | 0.0% | 0us | `_prepare` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:227` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Service` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2598` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\auth.ts:17` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:42` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha2.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:129` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2159` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts:298` |
| 0.0% | 1.0ms | 0.0% | 0us | `node:_http_client` | `node:_http_client:10` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1664` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `causeFilterInterruptors` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `reconcile` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration\20260908003500_event_compaction.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1145` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2417` |
| 0.0% | 1.0ms | 0.0% | 0us | `provideServiceImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1149` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1115` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:143` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:41` |
| 0.0% | 1.0ms | 0.0% | 0us | `ExpansionLane` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:65` |
| 0.0% | 1.0ms | 0.0% | 0us | `mapUpdateSet` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:53` |
| 0.0% | 1.0ms | 0.0% | 0us | `onConflictDoUpdate` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:289` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\directory-activity-fence.ts:141` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:98` |
| 0.0% | 1.0ms | 0.0% | 0us | `fromIteratorEagerUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:840` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1127` |
| 0.0% | 1.0ms | 0.0% | 0us | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:62` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js:7411` |
| 0.0% | 1.0ms | 0.0% | 0us | `onSuccess` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpEffect.js:49` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `toMillis` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:612` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\account\account.ts:81` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\index.js:10` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `schema` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:597` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:969` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:588` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:938` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `ZodDiscriminatedUnion` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` |
| 0.0% | 1.0ms | 0.0% | 0us | `discriminatedUnion` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:592` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1343` |
| 0.0% | 1.0ms | 0.0% | 0us | `compile` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:254` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1029` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `RegExp` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:858` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:1685` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ripgrep\binary.ts:36` |
| 0.0% | 1.0ms | 0.0% | 0us | `literal` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1043` |
| 0.0% | 1.0ms | 0.0% | 0us | `createRoutes` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:681` |
| 0.0% | 1.0ms | 0.0% | 0us | `replacementMapFrom` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:276` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:711` |
| 0.0% | 1.0ms | 0.0% | 0us | `ZodLiteral` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:276` |
| 0.0% | 1.0ms | 0.0% | 0us | `finalize` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1586` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:905` |
| 0.0% | 1.0ms | 0.0% | 0us | `failCauseUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:641` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+crc32@5.2.0\node_modules\@aws-crypto\crc32\build\main\index.js:106` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Getter` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaTransformation.js:622` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:741` |
| 0.0% | 1.0ms | 0.0% | 0us | `transformOptional` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js:441` |
| 0.0% | 999us | 0.0% | 999us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:715` |
| 0.0% | 999us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:60` |
| 0.0% | 997us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:797` |
| 0.0% | 997us | 0.0% | 997us | `init` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:8` |
| 0.0% | 996us | 0.0% | 996us | `interruptUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:391` |
| 0.0% | 996us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:4` |
| 0.0% | 996us | 0.0% | 996us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:609` |
| 0.0% | 991us | 0.0% | 991us | `forEachMimeType` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:169` |
| 0.0% | 991us | 0.0% | 991us | `withMapUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:848` |
| 0.0% | 990us | 0.0% | 990us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\server.ts:85` |
| 0.0% | 990us | 0.0% | 990us | `fromRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:145` |
| 0.0% | 989us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4` |
| 0.0% | 988us | 0.0% | 0us | `GenerationOptions` | `[native code]` |
| 0.0% | 988us | 0.0% | 0us | `mergeRouteDefaults` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\route\client.ts:112` |
| 0.0% | 988us | 0.0% | 988us | `onItem` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.0% | 988us | 0.0% | 0us | `mergeGenerationOptions` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\schema\options.ts:111` |
| 0.0% | 988us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:1051` |
| 0.0% | 988us | 0.0% | 0us | `makeFromTransport` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\route\client.ts:314` |
| 0.0% | 986us | 0.0% | 986us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1247` |
| 0.0% | 985us | 0.0% | 0us | `pipeArguments` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:60` |
| 0.0% | 985us | 0.0% | 985us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` |
| 0.0% | 985us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1420` |
| 0.0% | 985us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:300` |
| 0.0% | 985us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:334` |
| 0.0% | 985us | 0.0% | 985us | `policy` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\retry.ts:412` |
| 0.0% | 984us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\propagation.js:22` |
| 0.0% | 984us | 0.0% | 984us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:812` |
| 0.0% | 983us | 0.0% | 0us | `and` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js:59` |
| 0.0% | 983us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:461` |
| 0.0% | 983us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:462` |
| 0.0% | 983us | 0.0% | 983us | `SQL` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` |
| 0.0% | 983us | 0.0% | 983us | `StringChunk` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:49` |
| 0.0% | 982us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1472` |
| 0.0% | 982us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:890` |
| 0.0% | 981us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:172` |
| 0.0% | 981us | 0.0% | 981us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:106` |
| 0.0% | 981us | 0.0% | 981us | `mapOrSame` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2390` |
| 0.0% | 980us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\avvio@9.2.0\node_modules\avvio\boot.js:3` |
| 0.0% | 979us | 0.0% | 0us | `sqliteTableBase` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:25` |
| 0.0% | 979us | 0.0% | 979us | `buildForeignKeys` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:32` |
| 0.0% | 979us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:330` |
| 0.0% | 979us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:29` |
| 0.0% | 979us | 0.0% | 979us | `fn` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:782` |
| 0.0% | 979us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\limit-recovery.sql.ts:4` |
| 0.0% | 977us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:489` |
| 0.0% | 977us | 0.0% | 977us | `getDefaultValue` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:578` |
| 0.0% | 975us | 0.0% | 975us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:513` |
| 0.0% | 974us | 0.0% | 974us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:142` |
| 0.0% | 973us | 0.0% | 0us | `DefaultStreamTextResult` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6898` |
| 0.0% | 973us | 0.0% | 0us | `getBaseTelemetryAttributes` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:2155` |
| 0.0% | 973us | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 973us | 0.0% | 973us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:2164` |
| 0.0% | 971us | 0.0% | 0us | `touch` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:409` |
| 0.0% | 971us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:581` |
| 0.0% | 971us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:235` |
| 0.0% | 971us | 0.0% | 971us | `pruneStates` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:303` |
| 0.0% | 969us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts:10` |
| 0.0% | 969us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:23` |
| 0.0% | 969us | 0.0% | 969us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts` |
| 0.0% | 969us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\api.js:4` |
| 0.0% | 967us | 0.0% | 967us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` |
| 0.0% | 967us | 0.0% | 967us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` |
| 0.0% | 966us | 0.0% | 966us | `async GensparkAuthPlugin` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\genspark.ts:42` |
| 0.0% | 963us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:994` |
| 0.0% | 963us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:110` |
| 0.0% | 963us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1072` |
| 0.0% | 962us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+rate-limit@10.3.0\node_modules\@fastify\rate-limit\index.js:3` |
| 0.0% | 962us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:252` |
| 0.0% | 962us | 0.0% | 962us | `max` | `[native code]` |
| 0.0% | 962us | 0.0% | 0us | `hasLegacyConsumer` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:124` |
| 0.0% | 960us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\scheduled-task\lease.ts:292` |
| 0.0% | 959us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:91` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:211` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.0% | 957us | 0.0% | 957us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\runtime-retention.ts` |
| 0.0% | 955us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js:603` |
| 0.0% | 955us | 0.0% | 955us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:364` |
| 0.0% | 955us | 0.0% | 955us | `flow` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:461` |
| 0.0% | 954us | 0.0% | 954us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:188` |
| 0.0% | 951us | 0.0% | 951us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1894` |
| 0.0% | 951us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:592` |
| 0.0% | 951us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:591` |
| 0.0% | 950us | 0.0% | 950us | `includes` | `[native code]` |
| 0.0% | 949us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1239` |
| 0.0% | 949us | 0.0% | 949us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1221` |
| 0.0% | 948us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:4` |
| 0.0% | 948us | 0.0% | 948us | `go` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1895` |
| 0.0% | 948us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:10` |
| 0.0% | 947us | 0.0% | 947us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` |
| 0.0% | 947us | 0.0% | 947us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1159` |
| 0.0% | 947us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:14` |
| 0.0% | 945us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:139` |
| 0.0% | 945us | 0.0% | 945us | `some` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\option.js:79` |
| 0.0% | 945us | 0.0% | 945us | `setContext` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:502` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:798` |
| 0.0% | 939us | 0.0% | 0us | `activeGrantEntries` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:870` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\matchesPattern.js:7` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\buildMatchMemberExpression.js:7` |
| 0.0% | 933us | 0.0% | 933us | `create` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:27` |
| 0.0% | 932us | 0.0% | 932us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1305` |
| 0.0% | 932us | 0.0% | 932us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1147` |
| 0.0% | 931us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:106` |
| 0.0% | 929us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiError.js:278` |
| 0.0% | 929us | 0.0% | 929us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:728` |
| 0.0% | 929us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js:110` |
| 0.0% | 929us | 0.0% | 929us | `fixedBase64` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js` |
| 0.0% | 928us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:12` |
| 0.0% | 927us | 0.0% | 927us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:1042` |
| 0.0% | 926us | 0.0% | 926us | `@lazy` | `[native code]` |
| 0.0% | 926us | 0.0% | 0us | `internal:fs/binding` | `internal:fs/binding:3` |
| 0.0% | 926us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:242` |
| 0.0% | 925us | 0.0% | 925us | `interruptible` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1732` |
| 0.0% | 925us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:14` |
| 0.0% | 923us | 0.0% | 923us | `fromRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:116` |
| 0.0% | 923us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:979` |
| 0.0% | 923us | 0.0% | 923us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` |
| 0.0% | 922us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:6` |
| 0.0% | 921us | 0.0% | 921us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 0.0% | 921us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1541` |
| 0.0% | 920us | 0.0% | 920us | `shouldDisableInsert` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:67` |
| 0.0% | 920us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` |
| 0.0% | 920us | 0.0% | 0us | `buildInsertQuery` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` |
| 0.0% | 919us | 0.0% | 919us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1260` |
| 0.0% | 914us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:253` |
| 0.0% | 912us | 0.0% | 912us | `annotate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2328` |
| 0.0% | 912us | 0.0% | 0us | `Struct` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1694` |
| 0.0% | 912us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\pty.ts:31` |
| 0.0% | 912us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\bedrock-converse.ts:127` |
| 0.0% | 912us | 0.0% | 0us | `struct` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1749` |
| 0.0% | 907us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:335` |
| 0.0% | 906us | 0.0% | 906us | `structuredClone` | `[native code]` |
| 0.0% | 906us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1156` |
| 0.0% | 905us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:17` |
| 0.0% | 904us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:988` |
| 0.0% | 904us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:13` |
| 0.0% | 903us | 0.0% | 0us | `onPipeChunkDeferredWrite` | `[native code]` |
| 0.0% | 903us | 0.0% | 0us | `async safeParseJSON` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2258` |
| 0.0% | 903us | 0.0% | 0us | `_parse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:826` |
| 0.0% | 903us | 0.0% | 0us | `secureJsonParse` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:865` |
| 0.0% | 903us | 0.0% | 0us | `async safeParseJSON` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2268` |
| 0.0% | 902us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:30` |
| 0.0% | 902us | 0.0% | 902us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\shell-job.ts` |
| 0.0% | 901us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:20` |
| 0.0% | 900us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:7` |
| 0.0% | 897us | 0.0% | 897us | `sessionRow` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:64` |
| 0.0% | 897us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:731` |
| 0.0% | 894us | 0.0% | 0us | `latest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:2167` |
| 0.0% | 894us | 0.0% | 894us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1676` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:156` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1166` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3175` |
| 0.0% | 894us | 0.0% | 894us | `resolveInfo` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts:160` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3812` |
| 0.0% | 894us | 0.0% | 894us | `[Symbol.iterator]` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` |
| 0.0% | 894us | 0.0% | 0us | `isHistoricalInfo` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts:233` |
| 0.0% | 893us | 0.0% | 893us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:2832` |
| 0.0% | 893us | 0.0% | 893us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:79` |
| 0.0% | 893us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3302` |
| 0.0% | 893us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\control.ts:39` |
| 0.0% | 891us | 0.0% | 891us | `flipEncoding` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2601` |
| 0.0% | 891us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:29` |
| 0.0% | 891us | 0.0% | 891us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:959` |
| 0.0% | 890us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts:263` |
| 0.0% | 890us | 0.0% | 890us | `createQuerySerializer` | `C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts` |
| 0.0% | 889us | 0.0% | 889us | `isArray` | `[native code]` |
| 0.0% | 889us | 0.0% | 0us | `isTitleRequest` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:615` |
| 0.0% | 889us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:687` |
| 0.0% | 887us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schedule.js:18` |
| 0.0% | 887us | 0.0% | 887us | `toStepWithMetadata` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js:203` |
| 0.0% | 885us | 0.0% | 885us | `captureSqliteQuerySite` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts:42` |
| 0.0% | 884us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1608` |
| 0.0% | 882us | 0.0% | 882us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:224` |
| 0.0% | 882us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts:131` |
| 0.0% | 882us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\provider-route.ts:298` |
| 0.0% | 882us | 0.0% | 882us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3181` |
| 0.0% | 881us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:229` |
| 0.0% | 881us | 0.0% | 0us | `~effect/Effect/evaluate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:315` |
| 0.0% | 881us | 0.0% | 881us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:99` |
| 0.0% | 881us | 0.0% | 0us | `annotate` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:151` |
| 0.0% | 880us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js:9` |
| 0.0% | 880us | 0.0% | 880us | `restoreDiff` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js:4` |
| 0.0% | 880us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1096` |
| 0.0% | 878us | 0.0% | 878us | `Param` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:304` |
| 0.0% | 874us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\dom-serializer@2.0.0\node_modules\dom-serializer\lib\esm\foreignNames.js:40` |
| 0.0% | 873us | 0.0% | 873us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:172` |
| 0.0% | 866us | 0.0% | 0us | `async (anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:260` |
| 0.0% | 866us | 0.0% | 0us | `(module)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:279` |
| 0.0% | 866us | 0.0% | 0us | `async dispose` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` |
| 0.0% | 865us | 0.0% | 865us | `getImpl` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:204` |
| 0.0% | 859us | 0.0% | 859us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:813` |
| 0.0% | 859us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1785` |
| 0.0% | 857us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\index.ts:1700` |
| 0.0% | 856us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:66` |
| 0.0% | 856us | 0.0% | 856us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` |
| 0.0% | 850us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:654` |
| 0.0% | 850us | 0.0% | 0us | `makeSpanUnsafe` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2325` |
| 0.0% | 850us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:270` |
| 0.0% | 843us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:420` |
| 0.0% | 841us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:24` |
| 0.0% | 837us | 0.0% | 0us | `(anonymous)` | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:7` |

## Function Details

### `anonymous`
`[native code]` | Self: 15.6% (2.14s) | Total: 56.4% (7.75s) | Samples: 137

**Called by:**
- `require` (587)
- `bound require` (9)
- `internal:fs/streams` (3)
- `internal:streams/pipeline` (3)
- `node:tty` (3)
- `internal:stream` (3)
- `node:fs` (3)
- `internal:streams/compose` (3)
- `internal:streams/duplex` (3)
- `node:stream` (3)
- `node:http` (2)
- `node:_http_client` (1)
- `internal:validators` (1)
- `internal:streams/legacy` (1)
- `undici` (1)
- `node:worker_threads` (1)

**Calls:**
- `(anonymous)` (18)
- `(anonymous)` (15)
- `(anonymous)` (13)
- `(anonymous)` (11)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
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
- `(anonymous)` (4)
- `internal:streams/pipeline` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `internal:streams/compose` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `internal:stream` (3)
- `(anonymous)` (3)
- `internal:fs/streams` (3)
- `(anonymous)` (3)
- `node:fs` (3)
- `node:tty` (3)
- `node:stream` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `internal:streams/duplex` (3)
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
- `internal:worker/messaging` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:streams/legacy` (1)
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
- `internal:fs/binding` (1)
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
- `internal:validators` (1)
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
- `node:_http_client` (1)
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
- `node:_http_common` (1)

### `Map`
`[native code]` | Self: 10.5% (1.45s) | Total: 10.5% (1.45s) | Samples: 168

**Called by:**
- `withMapUnsafe` (134)
- `scopeAddFinalizerUnsafe` (32)
- `annotate` (1)
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:253` | Self: 4.7% (648.8ms) | Total: 4.8% (664.6ms) | Samples: 72

**Called by:**
- `(anonymous)` (23)
- `scopeClose` (7)
- `exit` (7)
- `(anonymous)` (6)
- `runLoop` (5)
- `go` (3)
- `finalizer` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `mergeAllEffect` (2)
- `callback` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `pipeArguments` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/successCont` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` | Self: 3.4% (476.1ms) | Total: 3.4% (476.1ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `write`
`[native code]` | Self: 3.0% (417.2ms) | Total: 3.0% (417.2ms) | Samples: 4

**Called by:**
- `readableAddChunkPushByteMode` (2)
- `async tmpdir` (2)

### `FinalizationRegistry`
`[native code]` | Self: 2.8% (385.9ms) | Total: 2.8% (385.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `all`
`[native code]` | Self: 2.3% (321.3ms) | Total: 2.3% (321.3ms) | Samples: 42

**Called by:**
- `(anonymous)` (42)

### `values`
`[native code]` | Self: 2.2% (310.6ms) | Total: 2.2% (310.6ms) | Samples: 25

**Called by:**
- `(anonymous)` (25)

### `forEachMimeType`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:164` | Self: 2.1% (292.0ms) | Total: 2.1% (292.0ms) | Samples: 1

**Called by:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:984` | Self: 1.8% (254.8ms) | Total: 1.8% (254.8ms) | Samples: 32

**Called by:**
- `(anonymous)` (21)
- `runLoop` (6)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1514` | Self: 1.6% (220.9ms) | Total: 2.0% (284.1ms) | Samples: 32

**Called by:**
- `generatorResume` (39)

**Calls:**
- `from` (7)

### `runLoop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:444` | Self: 1.5% (217.7ms) | Total: 100.0% (36.48s) | Samples: 28

**Called by:**
- `evaluate` (4471)

**Calls:**
- `~effect/Effect/evaluate` (1739)
- `~effect/Effect/evaluate` (1604)
- `~effect/Effect/successCont` (221)
- `~effect/Effect/successCont` (161)
- `(anonymous)` (129)
- `~effect/Effect/evaluate` (83)
- `(anonymous)` (57)
- `(anonymous)` (47)
- `(anonymous)` (43)
- `(anonymous)` (31)
- `(anonymous)` (31)
- `(anonymous)` (26)
- `(anonymous)` (23)
- `(anonymous)` (22)
- `(anonymous)` (20)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `~effect/Effect/evaluate` (11)
- `(anonymous)` (11)
- `(anonymous)` (9)
- `~effect/Effect/successCont` (9)
- `(anonymous)` (9)
- `~effect/Effect/evaluate` (8)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `~effect/Effect/successCont` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `~effect/Effect/successCont` (4)
- `~effect/Effect/successCont` (3)
- `(anonymous)` (3)
- `~effect/Effect/evaluate` (3)
- `pipeArguments` (3)
- `evaluate` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `body` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `pipeArguments` (2)
- `(anonymous)` (2)
- `run` (2)
- `(anonymous)` (2)
- `~effect/Effect/failureCont` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `evaluate` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `onSuccess` (1)
- `callback` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `~effect/Effect/successCont` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `reconcile` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)
- `(anonymous)` (1)
- `onSuccess` (1)
- `(anonymous)` (1)
- `~effect/Effect/evaluate` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaIssue.js:41` | Self: 1.3% (184.6ms) | Total: 1.3% (184.6ms) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:285` | Self: 1.1% (152.0ms) | Total: 1.1% (152.0ms) | Samples: 18

**Called by:**
- `(anonymous)` (5)
- `~effect/Effect/successCont` (4)
- `~effect/Effect/successCont` (3)
- `(anonymous)` (2)
- `runLoop` (2)
- `fromIteratorEagerUnsafe` (1)
- `(anonymous)` (1)

### `stringify`
`[native code]` | Self: 1.0% (139.9ms) | Total: 1.0% (139.9ms) | Samples: 15

**Called by:**
- `checkHits` (5)
- `isTitleRequest` (4)
- `async postJsonToApi` (4)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js:1` | Self: 0.9% (129.2ms) | Total: 0.9% (129.2ms) | Samples: 3

**Called by:**
- `anonymous` (3)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1563` | Self: 0.8% (115.9ms) | Total: 0.8% (115.9ms) | Samples: 11

**Called by:**
- `scopeForkUnsafe` (10)
- `(anonymous)` (1)

### `statSync`
`[native code]` | Self: 0.7% (105.2ms) | Total: 0.8% (119.7ms) | Samples: 14

**Called by:**
- `L` (14)
- `statSync` (1)

**Calls:**
- `statSync` (1)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1503` | Self: 0.7% (102.5ms) | Total: 0.7% (102.5ms) | Samples: 11

**Called by:**
- `(anonymous)` (11)

### `generatorResume`
`[native code]` | Self: 0.5% (79.2ms) | Total: 100.0% (14.73s) | Samples: 8

**Called by:**
- `next` (1814)
- `fromIteratorEagerUnsafe` (50)
- `~effect/Effect/successCont` (32)

**Calls:**
- `(anonymous)` (1427)
- `(anonymous)` (63)
- `(anonymous)` (39)
- `(anonymous)` (31)
- `(anonymous)` (23)
- `(anonymous)` (12)
- `(anonymous)` (10)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
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

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1533` | Self: 0.5% (78.2ms) | Total: 0.7% (105.8ms) | Samples: 9

**Called by:**
- `mergeAllEffect` (6)
- `(anonymous)` (4)
- `(anonymous)` (3)

**Calls:**
- `scopeMakeUnsafe` (3)
- `scopeMakeUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:254` | Self: 0.5% (74.1ms) | Total: 0.5% (74.1ms) | Samples: 9

**Called by:**
- `finalizer` (7)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:580` | Self: 0.5% (73.7ms) | Total: 0.5% (73.7ms) | Samples: 4

**Called by:**
- `makeEffect` (3)
- `run` (1)

### `importModule`
`[native code]` | Self: 0.5% (68.8ms) | Total: 0.5% (68.8ms) | Samples: 8

**Called by:**
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `async (anonymous)` (1)
- `(module)` (1)
- `(module)` (1)
- `(anonymous)` (1)
- `(module)` (1)

### `forEach`
`[native code]` | Self: 0.4% (64.6ms) | Total: 3.2% (441.4ms) | Samples: 9

**Called by:**
- `mergeAll` (8)
- `mapResultRow` (7)
- `(anonymous)` (3)
- `populateMaps` (2)
- `(anonymous)` (1)
- `#H` (1)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `walkCB3` (1)
- `forEachMimeType` (1)
- `forEachMimeType` (1)

### `arrayFromFastWithoutMapFn`
`[native code]` | Self: 0.4% (62.2ms) | Total: 0.4% (62.2ms) | Samples: 6

**Called by:**
- `from` (6)

### `Option`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` | Self: 0.4% (62.1ms) | Total: 0.4% (62.1ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `lstatSync`
`[native code]` | Self: 0.4% (61.9ms) | Total: 0.5% (75.7ms) | Samples: 7

**Called by:**
- `realpathSync` (6)
- `lstatSync` (1)
- `realpathSync` (1)

**Calls:**
- `lstatSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:107` | Self: 0.4% (60.5ms) | Total: 0.4% (60.5ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `filter`
`[native code]` | Self: 0.4% (57.9ms) | Total: 1.0% (146.2ms) | Samples: 5

**Called by:**
- `disabled` (5)
- `Objects` (2)
- `getCandidates` (2)
- `(anonymous)` (2)
- `buildInsertQuery` (1)
- `(anonymous)` (1)
- `mapUpdateSet` (1)
- `buildUpdateSet` (1)
- `(anonymous)` (1)
- `ownerKeys` (1)

**Calls:**
- `fullyDenied` (5)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:5` | Self: 0.4% (57.2ms) | Total: 0.4% (57.2ms) | Samples: 4

**Called by:**
- `SQL` (2)
- `buildSelectQuery` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:92` | Self: 0.3% (50.6ms) | Total: 0.3% (50.6ms) | Samples: 12

**Called by:**
- `map` (12)

### `mergeQueries`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:28` | Self: 0.3% (50.2ms) | Total: 0.4% (64.2ms) | Samples: 8

**Called by:**
- `buildQueryFromSourceParams` (8)
- `map` (1)

**Calls:**
- `push` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.3% (47.9ms) | Total: 0.3% (47.9ms) | Samples: 6

**Called by:**
- `(anonymous)` (2)
- `runLoop` (1)
- `mergeAllEffect` (1)
- `(anonymous)` (1)
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` | Self: 0.3% (47.0ms) | Total: 0.3% (47.0ms) | Samples: 6

**Called by:**
- `(anonymous)` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:765` | Self: 0.3% (46.9ms) | Total: 2.0% (276.4ms) | Samples: 7

**Called by:**
- `runLoop` (20)
- `scopeCloseUnsafe` (16)

**Calls:**
- `(anonymous)` (23)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `scopeCloseUnsafe` (1)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1560` | Self: 0.3% (46.9ms) | Total: 2.6% (369.4ms) | Samples: 4

**Called by:**
- `scopeForkUnsafe` (35)
- `(anonymous)` (1)

**Calls:**
- `Map` (32)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts` | Self: 0.3% (46.5ms) | Total: 0.3% (46.5ms) | Samples: 2

**Called by:**
- `generatorResume` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:901` | Self: 0.3% (45.8ms) | Total: 0.8% (120.8ms) | Samples: 3

**Called by:**
- `getOrElseMemoize` (10)

**Calls:**
- `(anonymous)` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` | Self: 0.3% (45.2ms) | Total: 0.3% (45.2ms) | Samples: 5

**Called by:**
- `generatorResume` (4)
- `(anonymous)` (1)

### `SQL`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:65` | Self: 0.3% (43.9ms) | Total: 0.5% (74.7ms) | Samples: 3

**Called by:**
- `sql` (5)
- `join` (2)

**Calls:**
- `is` (2)
- `is` (1)
- `is` (1)

### `callback`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:757` | Self: 0.2% (35.5ms) | Total: 0.4% (65.0ms) | Samples: 8

**Called by:**
- `fiberAwaitAll` (5)
- `go` (2)
- `(anonymous)` (1)
- `runLoop` (1)
- `_await` (1)

**Calls:**
- `(anonymous)` (2)

### `scopeAddFinalizerExit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1545` | Self: 0.2% (34.8ms) | Total: 0.2% (34.8ms) | Samples: 7

**Called by:**
- `memoMapReuse` (7)

### `getCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:471` | Self: 0.2% (33.6ms) | Total: 0.3% (47.4ms) | Samples: 5

**Called by:**
- `~effect/Effect/evaluate` (5)
- `~effect/Effect/evaluate` (1)

**Calls:**
- `~effect/Effect/ensureCont` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:491` | Self: 0.2% (33.3ms) | Total: 0.2% (33.3ms) | Samples: 4

**Called by:**
- `FiberImpl` (2)
- `(anonymous)` (2)

### `copyDataProperties`
`[native code]` | Self: 0.2% (33.2ms) | Total: 0.2% (33.2ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `normalizeWorkerDelegationModel` (1)
- `(anonymous)` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1625` | Self: 0.2% (32.7ms) | Total: 7.8% (1.07s) | Samples: 6

**Called by:**
- `runLoop` (161)

**Calls:**
- `(anonymous)` (148)
- `(anonymous)` (4)
- `scopeCloseUnsafe` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1527` | Self: 0.2% (32.2ms) | Total: 0.4% (64.4ms) | Samples: 4

**Called by:**
- `generatorResume` (8)

**Calls:**
- `exitAsVoidAll` (3)
- `exitAsVoidAll` (1)

### `map`
`[native code]` | Self: 0.2% (32.2ms) | Total: 6.2% (857.3ms) | Samples: 6

**Called by:**
- `buildQueryFromSourceParams` (128)
- `(anonymous)` (7)
- `Literals` (2)
- `mapUpdateSet` (2)
- `compile` (2)
- `I` (1)
- `observeYieldStatistic` (1)
- `on` (1)
- `sqliteTableBase` (1)
- `observeMoments` (1)
- `toJsonSchemaMultiDocument` (1)
- `(anonymous)` (1)
- `or` (1)
- `(module)` (1)
- `fromASTs` (1)

**Calls:**
- `buildQueryFromSourceParams` (76)
- `(anonymous)` (12)
- `buildQueryFromSourceParams` (9)
- `buildQueryFromSourceParams` (7)
- `mapResultRow` (6)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `Literal` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `observeMoments` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `mergeQueries` (1)
- `(anonymous)` (1)
- `recur` (1)
- `(anonymous)` (1)
- `recur` (1)
- `annotate` (1)
- `(anonymous)` (1)
- `walk` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `sql` (1)
- `(anonymous)` (1)
- `recur` (1)

### `prepare`
`[native code]` | Self: 0.2% (31.7ms) | Total: 0.2% (31.7ms) | Samples: 3

**Called by:**
- `[prepareOwned]` (3)

### `cloneObject`
`[native code]` | Self: 0.2% (31.6ms) | Total: 0.2% (31.6ms) | Samples: 3

**Called by:**
- `cloneInfo` (3)

### `fromIteratorEagerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:834` | Self: 0.2% (31.6ms) | Total: 0.4% (57.9ms) | Samples: 4

**Called by:**
- `(anonymous)` (4)
- `go` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:91` | Self: 0.2% (31.5ms) | Total: 0.2% (31.5ms) | Samples: 3

**Called by:**
- `map` (3)

### `readdirCB`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.2% (31.3ms) | Total: 0.2% (31.3ms) | Samples: 1

**Called by:**
- `walkCB2` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:537` | Self: 0.2% (31.0ms) | Total: 0.2% (31.0ms) | Samples: 4

**Called by:**
- `bound ` (4)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:152` | Self: 0.2% (31.0ms) | Total: 0.2% (31.0ms) | Samples: 2

**Called by:**
- `_prepare` (2)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:327` | Self: 0.2% (31.0ms) | Total: 0.2% (31.0ms) | Samples: 3

**Called by:**
- `forkUnsafe` (3)

### `realpathNativeSync`
`[native code]` | Self: 0.2% (31.0ms) | Total: 0.2% (31.0ms) | Samples: 3

**Called by:**
- `bound realpathNativeSync` (3)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2044` | Self: 0.2% (30.8ms) | Total: 0.6% (87.5ms) | Samples: 2

**Called by:**
- `go` (15)

**Calls:**
- `(anonymous)` (13)

### `pipe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:35` | Self: 0.2% (30.6ms) | Total: 0.2% (30.6ms) | Samples: 3

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `next`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:57` | Self: 0.2% (30.6ms) | Total: 0.2% (30.6ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:185` | Self: 0.2% (30.4ms) | Total: 0.2% (30.4ms) | Samples: 1

**Called by:**
- `map` (1)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2075` | Self: 0.2% (30.2ms) | Total: 0.2% (30.2ms) | Samples: 3

**Called by:**
- `go` (2)
- `(anonymous)` (1)

### `next`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:54` | Self: 0.2% (30.0ms) | Total: 0.2% (30.0ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `defineFunctionLength`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:775` | Self: 0.2% (30.0ms) | Total: 0.2% (30.0ms) | Samples: 2

**Called by:**
- `(module)` (1)
- `(anonymous)` (1)

### `query`
`bun:sqlite:342` | Self: 0.2% (30.0ms) | Total: 0.2% (30.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `match`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:8` | Self: 0.2% (29.8ms) | Total: 0.2% (29.8ms) | Samples: 4

**Called by:**
- `(anonymous)` (2)
- `findLast` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:217` | Self: 0.2% (29.8ms) | Total: 0.2% (29.8ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `mergeAllEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:767` | Self: 0.2% (29.7ms) | Total: 1.1% (152.8ms) | Samples: 3

**Called by:**
- `(anonymous)` (16)

**Calls:**
- `scopeForkUnsafe` (6)
- `scopeForkUnsafe` (6)
- `scopeForkUnsafe` (1)

### `assign`
`[native code]` | Self: 0.2% (29.7ms) | Total: 0.2% (29.7ms) | Samples: 6

**Called by:**
- `buildQueryFromSourceParams` (6)

### `indexOf`
`[native code]` | Self: 0.2% (29.5ms) | Total: 0.2% (29.5ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1016` | Self: 0.2% (29.4ms) | Total: 1.4% (195.1ms) | Samples: 5

**Called by:**
- `runLoop` (22)
- `(anonymous)` (4)
- `prepareQuery` (1)

**Calls:**
- `(anonymous)` (12)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:295` | Self: 0.2% (29.3ms) | Total: 0.4% (65.7ms) | Samples: 3

**Called by:**
- `runLoop` (11)

**Calls:**
- `getCont` (5)
- `getCont` (3)

### `layerFromPath`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts` | Self: 0.2% (29.3ms) | Total: 0.2% (29.3ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` | Self: 0.2% (29.2ms) | Total: 0.2% (29.2ms) | Samples: 2

**Called by:**
- `fromIteratorEagerUnsafe` (1)
- `generatorResume` (1)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2079` | Self: 0.2% (29.1ms) | Total: 100.0% (25.85s) | Samples: 2

**Called by:**
- `go` (1661)
- `(anonymous)` (1412)
- `(anonymous)` (47)
- `(anonymous)` (3)

**Calls:**
- `evaluate` (3120)
- `evaluate` (1)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:320` | Self: 0.2% (28.4ms) | Total: 0.2% (29.4ms) | Samples: 3

**Called by:**
- `_prepare` (3)
- `buildSelectQuery` (1)

**Calls:**
- `StringChunk` (1)

### `Error`
`[native code]` | Self: 0.2% (28.3ms) | Total: 0.2% (28.3ms) | Samples: 4

**Called by:**
- `fn` (2)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js` | Self: 0.2% (28.1ms) | Total: 0.2% (28.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `slice`
`[native code]` | Self: 0.2% (28.0ms) | Total: 0.2% (28.0ms) | Samples: 1

**Called by:**
- `Gt` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:25` | Self: 0.1% (27.3ms) | Total: 0.1% (27.3ms) | Samples: 2

**Called by:**
- `(module)` (1)
- `(anonymous)` (1)

### `create`
`[native code]` | Self: 0.1% (26.7ms) | Total: 0.1% (26.7ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `optionalKey` (1)

### `get`
`[native code]` | Self: 0.1% (26.6ms) | Total: 0.1% (26.6ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:627` | Self: 0.1% (26.3ms) | Total: 0.1% (26.3ms) | Samples: 3

**Called by:**
- `runLoop` (3)

### `buildInsertQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:220` | Self: 0.1% (25.7ms) | Total: 0.1% (25.7ms) | Samples: 2

**Called by:**
- `_prepare` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:982` | Self: 0.1% (23.6ms) | Total: 0.1% (23.6ms) | Samples: 1

**Called by:**
- `effectImpl` (1)

### `escapeName`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:24` | Self: 0.1% (21.8ms) | Total: 0.1% (21.8ms) | Samples: 7

**Called by:**
- `(anonymous)` (5)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.1% (18.8ms) | Total: 0.1% (18.8ms) | Samples: 5

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (1)

### `flatIntoArray`
`[native code]` | Self: 0.1% (18.2ms) | Total: 0.1% (18.2ms) | Samples: 3

**Called by:**
- `flatIntoArrayWithCallback` (3)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1491` | Self: 0.1% (18.0ms) | Total: 0.1% (18.0ms) | Samples: 4

**Called by:**
- `(anonymous)` (3)
- `~effect/Effect/successCont` (1)

### `getReferenceUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:568` | Self: 0.1% (18.0ms) | Total: 0.1% (18.0ms) | Samples: 4

**Called by:**
- `makeSpanUnsafe` (2)
- `makeSpanUnsafe` (1)
- `getRef` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` | Self: 0.1% (17.9ms) | Total: 0.5% (78.7ms) | Samples: 4

**Called by:**
- `(anonymous)` (6)
- `~effect/Effect/evaluate` (4)

**Calls:**
- `(anonymous)` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\config.ts` | Self: 0.1% (17.8ms) | Total: 0.1% (17.8ms) | Samples: 3

**Called by:**
- `generatorResume` (3)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:882` | Self: 0.1% (17.8ms) | Total: 92.9% (12.77s) | Samples: 4

**Called by:**
- `runLoop` (1604)

**Calls:**
- `(anonymous)` (1600)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` | Self: 0.1% (17.7ms) | Total: 0.1% (17.7ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:868` | Self: 0.1% (17.3ms) | Total: 0.1% (17.3ms) | Samples: 3

**Called by:**
- `runLoop` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:730` | Self: 0.1% (17.2ms) | Total: 0.1% (17.2ms) | Samples: 3

**Called by:**
- `go` (3)

### `exitAsVoidAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1089` | Self: 0.1% (17.2ms) | Total: 0.1% (17.2ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:861` | Self: 0.1% (17.1ms) | Total: 3.7% (522.3ms) | Samples: 4

**Called by:**
- `runLoop` (31)
- `(anonymous)` (26)

**Calls:**
- `mergeAllEffect` (16)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (4)
- `mergeAllEffect` (4)
- `pipe` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\Envelope.js:189` | Self: 0.1% (17.0ms) | Total: 0.1% (17.0ms) | Samples: 1

### `rmSync`
`[native code]` | Self: 0.1% (17.0ms) | Total: 0.1% (17.0ms) | Samples: 3

**Called by:**
- `(module)` (3)

### `forkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2077` | Self: 0.1% (16.7ms) | Total: 0.7% (106.7ms) | Samples: 2

**Called by:**
- `go` (9)
- `(anonymous)` (6)

**Calls:**
- `FiberImpl` (6)
- `FiberImpl` (3)
- `FiberImpl` (3)
- `FiberImpl` (1)

### `parse`
`[native code]` | Self: 0.1% (16.7ms) | Total: 0.1% (16.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `_parse` (1)

### `buildInsertQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:222` | Self: 0.1% (16.6ms) | Total: 0.1% (16.6ms) | Samples: 2

**Called by:**
- `_prepare` (2)

### `Int32Array`
`[native code]` | Self: 0.1% (16.6ms) | Total: 0.1% (16.6ms) | Samples: 2

**Called by:**
- `ExpansionLane` (1)
- `(anonymous)` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1893` | Self: 0.1% (16.6ms) | Total: 0.1% (16.6ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1719` | Self: 0.1% (16.5ms) | Total: 0.1% (16.5ms) | Samples: 2

**Called by:**
- `go` (2)

### `(unknown)`
`[native code]` | Self: 0.1% (16.5ms) | Total: 0.1% (16.5ms) | Samples: 1

**Called by:**
- `canParseHTMLNatively` (1)

### `scopeMakeUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1574` | Self: 0.1% (16.3ms) | Total: 0.1% (16.3ms) | Samples: 3

**Called by:**
- `scopeForkUnsafe` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:729` | Self: 0.1% (16.1ms) | Total: 0.1% (16.1ms) | Samples: 3

**Called by:**
- `forEach` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:64` | Self: 0.1% (16.1ms) | Total: 0.1% (16.1ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts` | Self: 0.1% (16.1ms) | Total: 0.1% (16.1ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:562` | Self: 0.1% (16.1ms) | Total: 0.1% (16.1ms) | Samples: 1

**Called by:**
- `init` (1)

### `join`
`[native code]` | Self: 0.1% (16.0ms) | Total: 0.1% (16.0ms) | Samples: 2

**Called by:**
- `(module)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1523` | Self: 0.1% (16.0ms) | Total: 0.1% (16.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:85` | Self: 0.1% (16.0ms) | Total: 0.1% (17.3ms) | Samples: 1

**Called by:**
- `forEach` (2)

**Calls:**
- `mapFromDriverValue` (1)

### `nominal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Brand.js` | Self: 0.1% (16.0ms) | Total: 0.1% (16.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `getOrElseMemoize`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:164` | Self: 0.1% (16.0ms) | Total: 1.2% (171.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (19)

**Calls:**
- `(anonymous)` (10)
- `get` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2843` | Self: 0.1% (16.0ms) | Total: 0.1% (16.0ms) | Samples: 1

**Called by:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3499` | Self: 0.1% (15.9ms) | Total: 0.1% (15.9ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `streamText`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6381` | Self: 0.1% (15.9ms) | Total: 0.1% (15.9ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:86` | Self: 0.1% (15.9ms) | Total: 0.1% (15.9ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `go` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:128` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` | Self: 0.1% (15.8ms) | Total: 92.8% (12.76s) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1600)

**Calls:**
- `next` (1599)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1914` | Self: 0.1% (15.8ms) | Total: 100.0% (14.68s) | Samples: 1

**Called by:**
- `bound ` (1716)

**Calls:**
- `go` (1673)
- `go` (42)

### `match`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:13` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `attribute`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js:287` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:83` | Self: 0.1% (15.8ms) | Total: 0.1% (16.7ms) | Samples: 3

**Called by:**
- `flatIntoArrayWithCallback` (4)

**Calls:**
- `is` (1)

### `buildOrderBy`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:137` | Self: 0.1% (15.7ms) | Total: 0.1% (15.7ms) | Samples: 1

**Called by:**
- `buildSelectQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1395` | Self: 0.1% (15.7ms) | Total: 0.1% (15.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1828` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:52` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 3

**Called by:**
- `runLoop` (2)
- `(module)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:296` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `addObserver`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:373` | Self: 0.1% (15.6ms) | Total: 0.1% (15.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:100` | Self: 0.1% (15.6ms) | Total: 0.1% (16.5ms) | Samples: 1

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (1)

### `retrySqliteBusyCause`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:106` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `DelayedPromise`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:114` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `DefaultStreamTextResult` (1)

### `collectJsonSchemaChecks`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `recur` (1)

### `defineProperty`
`[native code]` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `__name` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:112` | Self: 0.1% (15.5ms) | Total: 0.1% (15.5ms) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1120` | Self: 0.1% (15.4ms) | Total: 0.1% (21.2ms) | Samples: 1

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\utils\bedrock-media.ts:13` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts:288` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `internal:worker/messaging`
`internal:worker/messaging:2` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `assertNodeType`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js:103` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `validateType` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1358` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:109` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `getFrom` (1)

### `resolve`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:4` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:125806` | Self: 0.1% (15.3ms) | Total: 0.1% (15.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `immutableURLSetter`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `filterDisablePropagation`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2321` | Self: 0.1% (15.2ms) | Total: 0.1% (16.2ms) | Samples: 1

**Called by:**
- `makeSpanUnsafe` (2)

**Calls:**
- `some` (1)

### `createSetOperator`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:266` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\scheduled-task\executor.ts:87` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts:29` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `SQLiteEffectPreparedQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:52` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `prepareQuery` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:566` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `loop`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:545` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:870` | Self: 0.1% (15.2ms) | Total: 11.2% (1.54s) | Samples: 2

**Called by:**
- `runLoop` (221)

**Calls:**
- `next` (187)
- `generatorResume` (32)

### `buildUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:48` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `onConflictDoUpdate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\clone\cloneNode.js:3` | Self: 0.1% (15.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2563` | Self: 0.1% (15.2ms) | Total: 0.2% (30.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `rebuild` (1)
- `rebuild` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:167` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `fromIterable`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Array.js:218` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:81` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `prepareQuery` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:98` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `flatIntoArrayWithCallback` (1)

### `onSuccess`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:336` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `triggerForEvent`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts:282` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `Immer2`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:636` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1521` | Self: 0.1% (15.1ms) | Total: 83.1% (11.42s) | Samples: 2

**Called by:**
- `generatorResume` (1427)

**Calls:**
- `forkUnsafe` (1412)
- `(anonymous)` (6)
- `forkUnsafe` (6)
- `forkUnsafe` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:11` | Self: 0.1% (15.1ms) | Total: 0.1% (15.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1160` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:51` | Self: 0.1% (15.0ms) | Total: 0.2% (30.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:1363` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `scopeRemoveFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1569` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async pull`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:146` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `async pull` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1336` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2189` | Self: 0.1% (15.0ms) | Total: 0.1% (15.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\symbols.ts` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1538` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts:120` | Self: 0.1% (14.9ms) | Total: 0.1% (15.7ms) | Samples: 1

**Called by:**
- `generatorResume` (2)

**Calls:**
- `(anonymous)` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `SQL` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:412` | Self: 0.1% (14.9ms) | Total: 100.0% (36.50s) | Samples: 1

**Called by:**
- `forkUnsafe` (3120)
- `(anonymous)` (937)
- `(anonymous)` (268)
- `runTasks` (87)
- `(anonymous)` (58)
- `interruptUnsafe` (2)

**Calls:**
- `runLoop` (4471)

### `exitAsVoidAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.1% (14.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:962` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `evaluate` (1)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:334` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `forkUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:231` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs` | Self: 0.1% (14.8ms) | Total: 0.1% (14.8ms) | Samples: 1

**Called by:**
- `async postToApi` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` | Self: 0.1% (14.7ms) | Total: 1.9% (262.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (12)
- `(anonymous)` (12)
- `~effect/Effect/evaluate` (6)
- `(anonymous)` (3)
- `(anonymous)` (1)

**Calls:**
- `mergeAll` (8)
- `map` (7)
- `(anonymous)` (6)
- `mapGetResult` (2)
- `mapAllResult` (1)
- `mergeAll` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `mapResultRow` (1)
- `parse` (1)
- `(anonymous)` (1)
- `async return` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` | Self: 0.1% (14.7ms) | Total: 2.1% (300.8ms) | Samples: 1

**Called by:**
- `runLoop` (31)

**Calls:**
- `scopeCloseUnsafe` (15)
- `scopeCloseUnsafe` (11)
- `scopeCloseUnsafe` (3)
- `scopeCloseUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1608` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `bound require`
`[native code]` | Self: 0.1% (14.7ms) | Total: 53.2% (7.32s) | Samples: 1

**Called by:**
- `(anonymous)` (24)
- `(anonymous)` (18)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `_t` (11)
- `_traverse` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `createHTMLParser` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `_fs` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
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
- `_template` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `_debug` (4)
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
- `require` (587)
- `anonymous` (9)

### `number`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `positiveInteger` (1)

### `Duplex`
`internal:streams/duplex:6` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `Socket` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:216` | Self: 0.1% (14.7ms) | Total: 0.1% (14.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts` | Self: 0.1% (14.6ms) | Total: 0.1% (14.6ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.1% (14.6ms) | Total: 0.1% (14.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts` | Self: 0.1% (14.6ms) | Total: 0.1% (14.6ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `match`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts:7` | Self: 0.1% (14.6ms) | Total: 0.1% (14.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `Channel`
`node:diagnostics_channel` | Self: 0.1% (14.5ms) | Total: 0.1% (14.5ms) | Samples: 1

**Called by:**
- `channel` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1440` | Self: 0.1% (14.5ms) | Total: 0.3% (44.9ms) | Samples: 1

**Called by:**
- `runLoop` (5)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (1)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:329` | Self: 0.1% (14.5ms) | Total: 0.2% (30.7ms) | Samples: 4

**Called by:**
- `forkUnsafe` (6)

**Calls:**
- `setContext` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1155` | Self: 0.1% (14.5ms) | Total: 0.1% (14.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async start`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6340` | Self: 0.1% (14.5ms) | Total: 0.1% (14.5ms) | Samples: 1

**Called by:**
- `ReadableStream` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1519` | Self: 0.1% (14.4ms) | Total: 2.0% (277.2ms) | Samples: 1

**Called by:**
- `generatorResume` (31)

**Calls:**
- `exit` (7)
- `finalizer` (7)
- `(anonymous)` (6)
- `(anonymous)` (3)
- `next` (2)
- `(anonymous)` (2)
- `next` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:242` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `exponential` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:25` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `from` (1)

### `mergeQueries`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:27` | Self: 0.1% (14.4ms) | Total: 0.1% (14.4ms) | Samples: 1

**Called by:**
- `buildQueryFromSourceParams` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:357` | Self: 0.1% (14.3ms) | Total: 0.1% (14.3ms) | Samples: 1

**Called by:**
- `findStaticMatchingChild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:488` | Self: 0.1% (14.3ms) | Total: 0.1% (14.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SynchronizedRef.js:214` | Self: 0.1% (14.3ms) | Total: 0.1% (14.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `Set`
`[native code]` | Self: 0.1% (14.3ms) | Total: 0.1% (14.3ms) | Samples: 1

**Called by:**
- `disabled` (1)

### `findIndex`
`[native code]` | Self: 0.1% (14.2ms) | Total: 0.3% (45.8ms) | Samples: 1

**Called by:**
- `pull` (3)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts` | Self: 0.1% (14.2ms) | Total: 0.1% (14.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:138` | Self: 0.1% (14.2ms) | Total: 0.1% (14.2ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:21` | Self: 0.1% (14.2ms) | Total: 0.1% (15.2ms) | Samples: 1

**Called by:**
- `create` (2)

**Calls:**
- `BigInt` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:154` | Self: 0.1% (14.1ms) | Total: 0.2% (30.1ms) | Samples: 1

**Called by:**
- `_prepare` (3)

**Calls:**
- `is` (1)
- `is` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:90` | Self: 0.1% (14.1ms) | Total: 3.0% (419.3ms) | Samples: 1

**Called by:**
- `go` (26)
- `(anonymous)` (13)
- `runLoop` (9)

**Calls:**
- `(anonymous)` (26)
- `(anonymous)` (19)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getOwnPropertyDescriptors`
`[native code]` | Self: 0.1% (14.1ms) | Total: 0.1% (14.1ms) | Samples: 1

**Called by:**
- `modifyOwnPropertyDescriptors` (1)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:319` | Self: 0.1% (14.1ms) | Total: 0.1% (14.1ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts` | Self: 0.1% (14.1ms) | Total: 0.1% (14.1ms) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\lsp\lsp.ts` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `mergeAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:29` | Self: 0.1% (14.0ms) | Total: 0.1% (14.0ms) | Samples: 1

**Called by:**
- `ZodObject` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:73` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `init` (1)

### `push`
`[native code]` | Self: 0.1% (13.9ms) | Total: 0.1% (13.9ms) | Samples: 1

**Called by:**
- `mergeQueries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\MutableHashMap.js:193` | Self: 0.1% (13.9ms) | Total: 0.1% (14.9ms) | Samples: 1

**Called by:**
- `getImpl` (2)

**Calls:**
- `has` (1)

### `scopeClose`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1488` | Self: 0.1% (13.8ms) | Total: 0.6% (89.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `(anonymous)` (7)

### `createLaceAISdkObserver`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\lace-ai-sdk-observer.ts` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `prepareQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` | Self: 0.1% (13.8ms) | Total: 0.1% (13.8ms) | Samples: 1

**Called by:**
- `run` (1)

### `~effect/Effect/ensureCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1618` | Self: 0.1% (13.7ms) | Total: 0.1% (13.7ms) | Samples: 1

**Called by:**
- `getCont` (1)

### `has`
`[native code]` | Self: 0.0% (13.7ms) | Total: 0.0% (13.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1626` | Self: 0.0% (13.6ms) | Total: 0.5% (79.4ms) | Samples: 1

**Called by:**
- `runLoop` (9)

**Calls:**
- `(anonymous)` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` | Self: 0.0% (13.6ms) | Total: 0.0% (13.6ms) | Samples: 5

**Called by:**
- `generatorResume` (5)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:715` | Self: 0.0% (13.5ms) | Total: 0.4% (60.5ms) | Samples: 2

**Called by:**
- `runLoop` (8)

**Calls:**
- `(anonymous)` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts` | Self: 0.0% (13.5ms) | Total: 0.0% (13.5ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:114` | Self: 0.0% (13.5ms) | Total: 0.0% (13.5ms) | Samples: 1

**Called by:**
- `make` (1)

### `onTSSinkWriteBackpressureChangeFulfilled`
`[native code]` | Self: 0.0% (13.5ms) | Total: 0.0% (13.5ms) | Samples: 1

### `existsSync`
`[native code]` | Self: 0.0% (13.5ms) | Total: 0.0% (13.5ms) | Samples: 1

**Called by:**
- `existsSync` (1)

### `scopeAddFinalizerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1558` | Self: 0.0% (13.4ms) | Total: 0.0% (13.4ms) | Samples: 1

**Called by:**
- `scopeForkUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1882` | Self: 0.0% (13.4ms) | Total: 0.0% (13.4ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `entries`
`[native code]` | Self: 0.0% (13.4ms) | Total: 0.0% (13.4ms) | Samples: 1

**Called by:**
- `orderSelectedFields` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:567` | Self: 0.0% (13.4ms) | Total: 0.0% (13.4ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `gen`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` | Self: 0.0% (13.3ms) | Total: 0.0% (13.3ms) | Samples: 1

**Called by:**
- `publishEvent` (1)

### `FiberImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.0% (13.3ms) | Total: 0.0% (13.3ms) | Samples: 3

**Called by:**
- `forkUnsafe` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts:20` | Self: 0.0% (13.3ms) | Total: 0.0% (13.3ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `from`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:105` | Self: 0.0% (13.2ms) | Total: 0.0% (13.2ms) | Samples: 1

**Called by:**
- `getFrom` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:52` | Self: 0.0% (13.2ms) | Total: 0.0% (13.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+server@2.0.0\node_modules\@modelcontextprotocol\server\dist\src-CX2iR2pK.mjs:5914` | Self: 0.0% (13.1ms) | Total: 0.0% (13.1ms) | Samples: 2

### `captureSqliteQuerySite`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts` | Self: 0.0% (13.1ms) | Total: 0.0% (13.1ms) | Samples: 1

**Called by:**
- `SQLiteEffectPreparedQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:556` | Self: 0.0% (13.1ms) | Total: 0.2% (28.3ms) | Samples: 1

**Called by:**
- `bound ` (2)

**Calls:**
- `loop` (1)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1507` | Self: 0.0% (13.1ms) | Total: 0.0% (13.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:85` | Self: 0.0% (13.0ms) | Total: 0.3% (42.7ms) | Samples: 3

**Called by:**
- `map` (9)

**Calls:**
- `assign` (6)

### `async return`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:5983` | Self: 0.0% (13.0ms) | Total: 0.0% (13.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:162` | Self: 0.0% (12.8ms) | Total: 0.0% (12.8ms) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:756` | Self: 0.0% (12.8ms) | Total: 0.7% (100.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (10)
- `go` (10)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (12)
- `fromIteratorEagerUnsafe` (6)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `networkInterfaces`
`[native code]` | Self: 0.0% (12.8ms) | Total: 0.0% (12.8ms) | Samples: 2

**Called by:**
- `getLocalAddresses` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpPlatform.js` | Self: 0.0% (12.7ms) | Total: 0.0% (12.7ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `mapGetResult`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:166` | Self: 0.0% (12.7ms) | Total: 0.0% (12.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\fork\credentials.ts` | Self: 0.0% (12.6ms) | Total: 0.0% (12.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1568` | Self: 0.0% (12.3ms) | Total: 0.0% (12.3ms) | Samples: 1

**Called by:**
- `fromIteratorEagerUnsafe` (1)

### `WeakRef`
`[native code]` | Self: 0.0% (12.3ms) | Total: 0.0% (12.3ms) | Samples: 1

**Called by:**
- `WeakReference` (1)

### `createJoin`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:83` | Self: 0.0% (12.3ms) | Total: 0.0% (12.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1926` | Self: 0.0% (12.2ms) | Total: 100.0% (14.26s) | Samples: 1

**Called by:**
- `(anonymous)` (1673)

**Calls:**
- `forkUnsafe` (1661)
- `forkUnsafe` (9)
- `forkUnsafe` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\member-session.ts` | Self: 0.0% (11.8ms) | Total: 0.0% (11.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:719` | Self: 0.0% (11.8ms) | Total: 100.0% (14.90s) | Samples: 1

**Called by:**
- `runLoop` (1739)

**Calls:**
- `bound ` (1738)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` | Self: 0.0% (11.8ms) | Total: 0.0% (11.8ms) | Samples: 1

**Called by:**
- `~effect/Effect/evaluate` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:325` | Self: 0.0% (11.8ms) | Total: 0.9% (126.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (12)
- `(anonymous)` (7)
- `(anonymous)` (5)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `_prepare` (24)
- `prepareQuery` (1)

### `from`
`[native code]` | Self: 0.0% (11.7ms) | Total: 0.6% (88.3ms) | Samples: 2

**Called by:**
- `(anonymous)` (7)
- `create` (2)

**Calls:**
- `arrayFromFastWithoutMapFn` (6)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js:6` | Self: 0.0% (11.5ms) | Total: 0.0% (11.5ms) | Samples: 1

**Called by:**
- `map` (1)

### `scopeMakeUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1576` | Self: 0.0% (11.2ms) | Total: 0.0% (11.2ms) | Samples: 1

**Called by:**
- `scopeForkUnsafe` (1)

### `flat`
`[native code]` | Self: 0.0% (10.6ms) | Total: 0.0% (10.6ms) | Samples: 1

**Called by:**
- `evaluate` (1)

### `bigint`
`[native code]` | Self: 0.0% (10.4ms) | Total: 0.0% (10.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `hostname`
`[native code]` | Self: 0.0% (10.3ms) | Total: 0.0% (10.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:116` | Self: 0.0% (9.2ms) | Total: 0.0% (9.2ms) | Samples: 1

**Called by:**
- `init` (1)

### `all`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` | Self: 0.0% (4.5ms) | Total: 0.0% (4.5ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `is`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js:6` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 4

**Called by:**
- `SQL` (1)
- `buildSelectQuery` (1)
- `(anonymous)` (1)
- `from` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1896` | Self: 0.0% (3.8ms) | Total: 7.6% (1.04s) | Samples: 3

**Called by:**
- `(anonymous)` (60)
- `(anonymous)` (42)
- `(anonymous)` (22)
- `(anonymous)` (17)
- `(anonymous)` (9)
- `(anonymous)` (1)

**Calls:**
- `fromIteratorEagerUnsafe` (31)
- `(anonymous)` (26)
- `onItem` (17)
- `onItem` (15)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (8)
- `onItem` (5)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `onItem` (2)
- `fromIteratorEagerUnsafe` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `onItem` (1)
- `(anonymous)` (1)
- `onItem` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:95` | Self: 0.0% (2.9ms) | Total: 0.2% (30.2ms) | Samples: 3

**Called by:**
- `map` (4)

**Calls:**
- `is` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:286` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `~effect/Effect/successCont` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1511` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:297` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `getCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:477` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 3

**Called by:**
- `~effect/Effect/evaluate` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1865` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 2

**Called by:**
- `runLoop` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:761` | Self: 0.0% (1.9ms) | Total: 0.8% (117.3ms) | Samples: 2

**Called by:**
- `runLoop` (13)

**Calls:**
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

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:625` | Self: 0.0% (1.9ms) | Total: 6.0% (831.9ms) | Samples: 2

**Called by:**
- `runLoop` (83)

**Calls:**
- `doneUnsafe` (69)
- `(anonymous)` (4)
- `failCauseUnsafe` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `which` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `sqliteStatementClass`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-diagnostics.ts:18` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 2

**Called by:**
- `statement` (2)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:21` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\htmlparser2@8.0.2\node_modules\htmlparser2\lib\esm\Parser.js:21` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2528` | Self: 0.0% (1.7ms) | Total: 0.0% (12.2ms) | Samples: 2

**Called by:**
- `currentTimeNanosUnsafe` (3)

**Calls:**
- `bigint` (1)

### `getCandidates`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1910` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1602` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `mapFromDriverValue`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js:44` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:174` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `reduce` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2244` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `collectIssues` (1)

### `takeAuditCases`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:416` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1909` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

### `mergeAllEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` | Self: 0.0% (1.0ms) | Total: 0.2% (30.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:27` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `optional` (1)

### `doneExitFromCause`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pull.js:168` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `onCause` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2415` | Self: 0.0% (1.0ms) | Total: 0.2% (36.8ms) | Samples: 1

**Called by:**
- `runLoop` (9)

**Calls:**
- `makeSpanUnsafe` (3)
- `makeSpanUnsafe` (2)
- `makeSpanUnsafe` (2)
- `makeSpanUnsafe` (1)

### `q`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:681` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:922` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `walk`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:180` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1837` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `sdkKey`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:43` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `message` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:1122` | Self: 0.0% (1.0ms) | Total: 0.0% (2.0ms) | Samples: 1

**Called by:**
- `every` (1)
- `generatorResume` (1)

**Calls:**
- `every` (1)

### `RunnerAddress`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `make` (1)

### `patch`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1775` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `mapAllResult`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:137` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `topP`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:550` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `BigInt`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `create` (1)

### `mergeQueries`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:26` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `buildQueryFromSourceParams` (1)

### `prepareQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:62` | Self: 0.0% (1.0ms) | Total: 0.2% (30.3ms) | Samples: 1

**Called by:**
- `run` (3)
- `_prepare` (1)

**Calls:**
- `SQLiteEffectPreparedQuery` (2)
- `SQLiteEffectPreparedQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:521` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `Service`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:2598` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2159` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `node:_http_common`
`node:_http_common:2` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `causeFilterInterruptors`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `reconcile`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration\20260908003500_event_compaction.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\directory-activity-fence.ts:141` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:798` | Self: 0.0% (1.0ms) | Total: 0.2% (28.0ms) | Samples: 1

**Called by:**
- `runLoop` (3)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:98` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js:7411` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1127` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `toMillis`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js:612` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `schema`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:1681` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:938` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ripgrep\binary.ts:36` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `RegExp`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:276` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `reduce` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:905` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `runLoop` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:309` | Self: 0.0% (1.0ms) | Total: 0.9% (137.2ms) | Samples: 1

**Called by:**
- `run` (24)
- `get` (5)

**Calls:**
- `(anonymous)` (20)
- `sql` (3)
- `buildInsertQuery` (2)
- `buildInsertQuery` (2)
- `buildInsertQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:111` | Self: 0.0% (1.0ms) | Total: 2.2% (311.6ms) | Samples: 1

**Called by:**
- `runLoop` (26)

**Calls:**
- `values` (25)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:741` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `go` (1)

### `Getter`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `transformOptional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:715` | Self: 0.0% (999us) | Total: 0.0% (999us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:8` | Self: 0.0% (997us) | Total: 0.0% (997us) | Samples: 1

**Called by:**
- `ZodString` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:609` | Self: 0.0% (996us) | Total: 0.0% (996us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `interruptUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:391` | Self: 0.0% (996us) | Total: 0.0% (996us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:199` | Self: 0.0% (994us) | Total: 0.0% (1.9ms) | Samples: 1

**Called by:**
- `generatorResume` (2)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1119` | Self: 0.0% (993us) | Total: 0.1% (16.3ms) | Samples: 1

**Called by:**
- `runLoop` (2)

**Calls:**
- `setContext` (1)

### `withMapUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:848` | Self: 0.0% (991us) | Total: 0.0% (991us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `forEachMimeType`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:169` | Self: 0.0% (991us) | Total: 0.0% (991us) | Samples: 1

**Called by:**
- `forEach` (1)

### `fromRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:145` | Self: 0.0% (990us) | Total: 0.0% (990us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\server.ts:85` | Self: 0.0% (990us) | Total: 0.0% (990us) | Samples: 1

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` | Self: 0.0% (988us) | Total: 0.0% (988us) | Samples: 1

**Called by:**
- `go` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:96` | Self: 0.0% (986us) | Total: 2.3% (322.3ms) | Samples: 1

**Called by:**
- `runLoop` (43)

**Calls:**
- `all` (42)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1121` | Self: 0.0% (986us) | Total: 0.2% (32.8ms) | Samples: 1

**Called by:**
- `~effect/Effect/successCont` (4)

**Calls:**
- `setContext` (2)
- `setContext` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1247` | Self: 0.0% (986us) | Total: 0.0% (986us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1384` | Self: 0.0% (985us) | Total: 0.0% (985us) | Samples: 1

**Called by:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1692` | Self: 0.0% (985us) | Total: 0.2% (33.0ms) | Samples: 1

**Called by:**
- `mapOrSame` (5)

**Calls:**
- `(anonymous)` (3)
- `create` (1)

### `policy`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\retry.ts:412` | Self: 0.0% (985us) | Total: 0.0% (985us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:812` | Self: 0.0% (984us) | Total: 0.0% (984us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `SQL`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:63` | Self: 0.0% (983us) | Total: 0.0% (983us) | Samples: 1

**Called by:**
- `join` (1)

### `StringChunk`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:49` | Self: 0.0% (983us) | Total: 0.0% (983us) | Samples: 1

**Called by:**
- `sql` (1)

### `mapOrSame`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2390` | Self: 0.0% (981us) | Total: 0.0% (981us) | Samples: 1

**Called by:**
- `rebuild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:106` | Self: 0.0% (981us) | Total: 0.0% (981us) | Samples: 1

**Called by:**
- `map` (1)

### `buildForeignKeys`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js:32` | Self: 0.0% (979us) | Total: 0.0% (979us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `fn`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:782` | Self: 0.0% (979us) | Total: 0.0% (979us) | Samples: 1

**Called by:**
- `(module)` (1)

### `getDefaultValue`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:578` | Self: 0.0% (977us) | Total: 0.0% (977us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:513` | Self: 0.0% (975us) | Total: 0.0% (975us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:142` | Self: 0.0% (974us) | Total: 0.0% (974us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:2164` | Self: 0.0% (973us) | Total: 0.0% (973us) | Samples: 1

**Called by:**
- `reduce` (1)

### `pruneStates`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:303` | Self: 0.0% (971us) | Total: 0.0% (971us) | Samples: 1

**Called by:**
- `touch` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts` | Self: 0.0% (969us) | Total: 0.0% (969us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:77` | Self: 0.0% (967us) | Total: 0.0% (967us) | Samples: 1

**Called by:**
- `boundedSqlitePermit` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` | Self: 0.0% (967us) | Total: 0.0% (967us) | Samples: 1

**Called by:**
- `filter` (1)

### `async GensparkAuthPlugin`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\genspark.ts:42` | Self: 0.0% (966us) | Total: 0.0% (966us) | Samples: 1

**Called by:**
- `~effect/Utils/internal` (1)

### `max`
`[native code]` | Self: 0.0% (962us) | Total: 0.0% (962us) | Samples: 1

**Called by:**
- `hasLegacyConsumer` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:89` | Self: 0.0% (958us) | Total: 1.7% (235.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (14)
- `go` (10)
- `runLoop` (5)
- `(anonymous)` (1)

**Calls:**
- `scopeForkUnsafe` (18)
- `scopeForkUnsafe` (4)
- `scopeForkUnsafe` (4)
- `scopeForkUnsafe` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:211` | Self: 0.0% (957us) | Total: 0.0% (957us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` | Self: 0.0% (957us) | Total: 0.0% (957us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\runtime-retention.ts` | Self: 0.0% (957us) | Total: 0.0% (957us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:364` | Self: 0.0% (955us) | Total: 0.0% (955us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `flow`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:461` | Self: 0.0% (955us) | Total: 0.0% (955us) | Samples: 1

**Called by:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:188` | Self: 0.0% (954us) | Total: 0.0% (954us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1850` | Self: 0.0% (952us) | Total: 0.1% (16.1ms) | Samples: 1

**Called by:**
- `runLoop` (2)

**Calls:**
- `fromIterable` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1894` | Self: 0.0% (951us) | Total: 0.0% (951us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `includes`
`[native code]` | Self: 0.0% (950us) | Total: 0.0% (950us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1221` | Self: 0.0% (949us) | Total: 0.0% (949us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1895` | Self: 0.0% (948us) | Total: 0.0% (948us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:420` | Self: 0.0% (947us) | Total: 0.0% (947us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1159` | Self: 0.0% (947us) | Total: 0.0% (947us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:502` | Self: 0.0% (945us) | Total: 0.0% (945us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `some`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\option.js:79` | Self: 0.0% (945us) | Total: 0.0% (945us) | Samples: 1

**Called by:**
- `filterDisablePropagation` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:59` | Self: 0.0% (942us) | Total: 0.0% (1.8ms) | Samples: 1

**Called by:**
- `map` (2)

**Calls:**
- `Param` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:680` | Self: 0.0% (940us) | Total: 0.2% (32.9ms) | Samples: 1

**Called by:**
- `withMapUnsafe` (3)
- `forEach` (1)

**Calls:**
- `forEach` (3)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:27` | Self: 0.0% (933us) | Total: 0.0% (933us) | Samples: 1

**Called by:**
- `create` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1305` | Self: 0.0% (932us) | Total: 0.0% (932us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1147` | Self: 0.0% (932us) | Total: 0.0% (932us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `fixedBase64`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js` | Self: 0.0% (929us) | Total: 0.0% (929us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:728` | Self: 0.0% (929us) | Total: 0.0% (929us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:1042` | Self: 0.0% (927us) | Total: 0.0% (927us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `@lazy`
`[native code]` | Self: 0.0% (926us) | Total: 0.0% (926us) | Samples: 1

**Called by:**
- `internal:fs/binding` (1)

### `interruptible`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1732` | Self: 0.0% (925us) | Total: 0.0% (925us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:990` | Self: 0.0% (923us) | Total: 0.0% (923us) | Samples: 1

**Called by:**
- `runLoop` (1)

### `fromRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:116` | Self: 0.0% (923us) | Total: 0.0% (923us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` | Self: 0.0% (921us) | Total: 0.0% (921us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `shouldDisableInsert`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js:67` | Self: 0.0% (920us) | Total: 0.0% (920us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1260` | Self: 0.0% (919us) | Total: 0.0% (919us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:89` | Self: 0.0% (915us) | Total: 0.0% (1.8ms) | Samples: 1

**Called by:**
- `forEach` (2)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:136` | Self: 0.0% (914us) | Total: 0.0% (1.8ms) | Samples: 1

**Called by:**
- `map` (2)

**Calls:**
- `escapeName` (1)

### `Objects`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` | Self: 0.0% (912us) | Total: 0.2% (30.4ms) | Samples: 1

**Called by:**
- `rebuild` (2)
- `struct` (1)

**Calls:**
- `filter` (2)

### `annotate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2328` | Self: 0.0% (912us) | Total: 0.0% (912us) | Samples: 1

**Called by:**
- `annotate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1076` | Self: 0.0% (911us) | Total: 0.0% (1.7ms) | Samples: 1

**Called by:**
- `runLoop` (2)

**Calls:**
- `callback` (1)

### `structuredClone`
`[native code]` | Self: 0.0% (906us) | Total: 0.0% (906us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:783` | Self: 0.0% (905us) | Total: 0.0% (2.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `collectIssues` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\shell-job.ts` | Self: 0.0% (902us) | Total: 0.0% (902us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `sessionRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:64` | Self: 0.0% (897us) | Total: 0.0% (897us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1676` | Self: 0.0% (894us) | Total: 0.0% (894us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `resolveInfo`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts:160` | Self: 0.0% (894us) | Total: 0.0% (894us) | Samples: 1

**Called by:**
- `isHistoricalInfo` (1)

### `[Symbol.iterator]`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:74` | Self: 0.0% (894us) | Total: 0.0% (894us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:79` | Self: 0.0% (893us) | Total: 0.0% (893us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:2832` | Self: 0.0% (893us) | Total: 0.0% (893us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:673` | Self: 0.0% (893us) | Total: 0.1% (17.4ms) | Samples: 1

**Called by:**
- `makeEffect` (3)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:58` | Self: 0.0% (891us) | Total: 0.3% (49.2ms) | Samples: 1

**Called by:**
- `runLoop` (3)
- `(anonymous)` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts:959` | Self: 0.0% (891us) | Total: 0.0% (891us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `flipEncoding`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2601` | Self: 0.0% (891us) | Total: 0.0% (891us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `createQuerySerializer`
`C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts` | Self: 0.0% (890us) | Total: 0.0% (890us) | Samples: 1

**Called by:**
- `(module)` (1)

### `isArray`
`[native code]` | Self: 0.0% (889us) | Total: 0.0% (889us) | Samples: 1

**Called by:**
- `isTitleRequest` (1)

### `toStepWithMetadata`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js:203` | Self: 0.0% (887us) | Total: 0.0% (887us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `captureSqliteQuerySite`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts:42` | Self: 0.0% (885us) | Total: 0.0% (885us) | Samples: 1

**Called by:**
- `SQLiteEffectPreparedQuery` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:171` | Self: 0.0% (882us) | Total: 0.4% (57.7ms) | Samples: 1

**Called by:**
- `_prepare` (5)

**Calls:**
- `sql` (2)
- `buildOrderBy` (1)
- `sql` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3181` | Self: 0.0% (882us) | Total: 0.0% (882us) | Samples: 1

**Called by:**
- `generatorResume` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:224` | Self: 0.0% (882us) | Total: 0.0% (882us) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:768` | Self: 0.0% (881us) | Total: 1.8% (253.5ms) | Samples: 1

**Called by:**
- `onItem` (17)
- `runLoop` (4)
- `body` (3)

**Calls:**
- `scopeForkUnsafe` (12)
- `scopeForkUnsafe` (6)
- `scopeForkUnsafe` (3)
- `scopeForkUnsafe` (1)
- `scopeForkUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:99` | Self: 0.0% (881us) | Total: 0.0% (881us) | Samples: 1

**Called by:**
- `map` (1)

### `restoreDiff`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js:4` | Self: 0.0% (880us) | Total: 0.0% (880us) | Samples: 1

**Called by:**
- `(module)` (1)

### `Param`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:304` | Self: 0.0% (878us) | Total: 0.0% (878us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:49` | Self: 0.0% (878us) | Total: 0.0% (1.8ms) | Samples: 1

**Called by:**
- `onConflictDoUpdate` (2)

**Calls:**
- `filter` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:172` | Self: 0.0% (873us) | Total: 0.0% (873us) | Samples: 1

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1856` | Self: 0.0% (867us) | Total: 1.0% (140.8ms) | Samples: 1

**Called by:**
- `runLoop` (23)

**Calls:**
- `go` (17)
- `go` (2)
- `(anonymous)` (1)
- `go` (1)
- `(anonymous)` (1)

### `getImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:204` | Self: 0.0% (865us) | Total: 0.0% (865us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:813` | Self: 0.0% (859us) | Total: 0.0% (859us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `SQLiteEffectSelectBase`
`[native code]` | Self: 0.0% (857us) | Total: 0.2% (28.4ms) | Samples: 1

**Called by:**
- `from` (3)

**Calls:**
- `SQLiteSelectQueryBuilderBase` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:68` | Self: 0.0% (856us) | Total: 0.0% (856us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:116` | Self: 0.0% (850us) | Total: 0.4% (61.4ms) | Samples: 1

**Called by:**
- `out` (5)
- `stateFor` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:9` | Self: 0.0% (0us) | Total: 0.2% (27.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:11` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `collectIssues`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2813` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `async postToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2436` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `async postJsonToApi` (1)

**Calls:**
- `async (anonymous)` (1)

### `async load`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\command.ts:38` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (1)

**Calls:**
- `async load` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:269` | Self: 0.0% (0us) | Total: 7.6% (1.04s) | Samples: 0

**Called by:**
- `guarded` (155)

**Calls:**
- `(anonymous)` (155)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:462` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `and` (1)

### `fromIteratorEagerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:838` | Self: 0.0% (0us) | Total: 3.3% (457.3ms) | Samples: 0

**Called by:**
- `go` (31)
- `(anonymous)` (23)
- `(anonymous)` (18)
- `(anonymous)` (6)

**Calls:**
- `generatorResume` (50)
- `next` (28)

### `Struct`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1694` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `struct` (1)

### `disabled`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:354` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `resolveTools` (1)

**Calls:**
- `Set` (1)

### `bound check`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `bound max` (1)

**Calls:**
- `bound clone` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\MessageStorage.js:530` | Self: 0.0% (0us) | Total: 0.1% (23.6ms) | Samples: 0

**Calls:**
- `effectImpl` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:335` | Self: 0.0% (0us) | Total: 0.0% (907us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `sql` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2697` | Self: 0.0% (0us) | Total: 0.1% (16.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2127` | Self: 0.0% (0us) | Total: 3.6% (499.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (56)
- `handler` (1)
- `(anonymous)` (1)

**Calls:**
- `evaluate` (58)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1983` | Self: 0.0% (0us) | Total: 0.4% (59.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (9)

**Calls:**
- `(anonymous)` (9)

### `internal:streams/pipeline`
`internal:streams/pipeline:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `_template`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:203` | Self: 0.0% (0us) | Total: 0.3% (44.7ms) | Samples: 0

**Called by:**
- `get` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:17` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1284` | Self: 0.0% (0us) | Total: 0.0% (10.8ms) | Samples: 0

**Called by:**
- `optional` (1)

**Calls:**
- `optionalKey` (1)

### `onDataIncomingMessage`
`internal:http:81` | Self: 0.0% (0us) | Total: 0.2% (30.2ms) | Samples: 0

**Calls:**
- `readableAddChunkPushByteMode` (2)

### `checkHits`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:151` | Self: 0.0% (0us) | Total: 0.2% (29.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `isTitleRequest` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1956` | Self: 0.0% (0us) | Total: 0.4% (59.4ms) | Samples: 0

**Called by:**
- `evaluate` (9)

**Calls:**
- `go` (9)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:378` | Self: 0.0% (0us) | Total: 0.4% (62.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)
- `(anonymous)` (2)
- `applyUsage` (1)

**Calls:**
- `_prepare` (8)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\npm.ts:359` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `compile` (1)

### `Channel`
`node:diagnostics_channel:106` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `channel` (1)

**Calls:**
- `set` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:592` | Self: 0.0% (0us) | Total: 0.0% (951us) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `evaluate` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:159` | Self: 0.0% (0us) | Total: 0.2% (34.8ms) | Samples: 0

**Called by:**
- `getOrElseMemoize` (7)

**Calls:**
- `memoMapReuse` (7)

### `mapUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:57` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `set` (2)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\main.js:22` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:334` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:5` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `makeOption`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:92` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `make` (1)

**Calls:**
- `makeEffect` (1)

### `flatIntoArrayWithCallback`
`[native code]` | Self: 0.0% (0us) | Total: 0.6% (95.9ms) | Samples: 0

**Called by:**
- `buildSelection` (9)
- `(anonymous)` (3)
- `_prepare` (1)

**Calls:**
- `(anonymous)` (4)
- `(anonymous)` (3)
- `flatIntoArray` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)

### `walkCB2`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (32.3ms) | Samples: 0

**Called by:**
- `walkCB3` (1)
- `walkCB` (1)

**Calls:**
- `processPatterns` (1)
- `readdirCB` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:455` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `registerOwned` (1)

### `walkCB3`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (31.3ms) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `walkCB2` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@2.0.2\node_modules\which\which.js:7` | Self: 0.0% (0us) | Total: 0.4% (62.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1553` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `copyDataProperties` (1)

### `pull`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:676` | Self: 0.0% (0us) | Total: 0.2% (31.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `findIndex` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:6` | Self: 0.0% (0us) | Total: 0.3% (45.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:685` | Self: 0.0% (0us) | Total: 0.3% (48.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)

**Calls:**
- `(anonymous)` (6)

### `async scenario`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:95` | Self: 0.0% (0us) | Total: 0.0% (12.7ms) | Samples: 0

**Called by:**
- `async scenario` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1541` | Self: 0.0% (0us) | Total: 0.0% (921us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:170` | Self: 0.0% (0us) | Total: 0.4% (60.9ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `checkHits` (5)
- `checkHits` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts:391` | Self: 0.0% (0us) | Total: 0.2% (29.3ms) | Samples: 0

**Calls:**
- `layerFromPath` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\is-core-module@2.16.2\node_modules\is-core-module\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs:1624` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Calls:**
- `Immer2` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm-session-projector.ts:33` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `defineFunctionLength` (1)

### `on`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:202` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `recur` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:50` | Self: 0.0% (0us) | Total: 0.1% (17.5ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `onConflictDoUpdate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:287` | Self: 0.0% (0us) | Total: 0.1% (17.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `buildUpdateSet` (2)
- `buildUpdateSet` (1)

### `or`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js:69` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `map` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts:263` | Self: 0.0% (0us) | Total: 0.0% (890us) | Samples: 0

**Calls:**
- `createQuerySerializer` (1)

### `internal:stream`
`internal:stream:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `async walk`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `Promise` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\traverse-node.js:7` | Self: 0.0% (0us) | Total: 0.5% (77.7ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `ZodDiscriminatedUnion`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `discriminatedUnion` (1)

**Calls:**
- `init` (1)

### `object`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:791` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodObject` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\encoders\index.js:5` | Self: 0.0% (0us) | Total: 0.6% (92.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:17` | Self: 0.0% (0us) | Total: 0.0% (905us) | Samples: 0

**Calls:**
- `bound require` (1)

### `ZodObject`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `object` (1)

**Calls:**
- `init` (1)

### `~effect/Effect/successCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:871` | Self: 0.0% (0us) | Total: 0.3% (46.7ms) | Samples: 0

**Called by:**
- `runLoop` (4)

**Calls:**
- `(anonymous)` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (13.6ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-attachment.ts:211` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1238` | Self: 0.0% (0us) | Total: 0.3% (54.0ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `get` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:203` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `init` (3)

**Calls:**
- `init` (2)
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\index.js:8` | Self: 0.0% (0us) | Total: 0.3% (44.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:31` | Self: 0.0% (0us) | Total: 0.7% (107.0ms) | Samples: 0

**Called by:**
- `Literal` (2)
- `(module)` (1)
- `(anonymous)` (1)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `(module)` (1)
- `getPayload` (1)
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `makeEffect` (8)
- `makeEffect` (2)
- `flow` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:145` | Self: 0.0% (0us) | Total: 0.3% (48.0ms) | Samples: 0

**Called by:**
- `normalizeWorkerDelegationModel` (6)

**Calls:**
- `(anonymous)` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\input.ts:92` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `get` (2)

### `Socket`
`node:net:901` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `Socket` (1)

**Calls:**
- `Duplex` (1)

### `buildInsertQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` | Self: 0.0% (0us) | Total: 0.0% (920us) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:65` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `filter` (1)

### `async doStream`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb\node_modules\@ai-sdk\openai-compatible\dist\index.mjs:641` | Self: 0.0% (0us) | Total: 0.3% (46.7ms) | Samples: 0

**Calls:**
- `async postJsonToApi` (4)
- `async postJsonToApi` (1)

### `bound extend`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `clone` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1420` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `policy` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:22` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:869` | Self: 0.0% (0us) | Total: 0.2% (29.3ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `get` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:14` | Self: 0.0% (0us) | Total: 0.0% (925us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async scenario`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:244` | Self: 0.0% (0us) | Total: 0.0% (12.7ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async scenario` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:11` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:303` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `SQLiteSelectQueryBuilderBase` (1)

**Calls:**
- `createSetOperator` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:23` | Self: 0.0% (0us) | Total: 0.0% (969us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:959` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `bound ` (3)

**Calls:**
- `forkUnsafe` (3)

### `resolveCliPath`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\claude\availability.ts:85` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Called by:**
- `async ClaudeAuthPlugin` (1)

**Calls:**
- `exists` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\index.js:5` | Self: 0.0% (0us) | Total: 0.4% (62.1ms) | Samples: 0

**Calls:**
- `bound require` (24)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\control.ts:39` | Self: 0.0% (0us) | Total: 0.0% (893us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `__name`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+is-array-buffer@2.2.0\node_modules\@smithy\is-array-buffer\dist-cjs\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:270` | Self: 0.0% (0us) | Total: 0.0% (850us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `next` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `finalizer` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js:9` | Self: 0.0% (0us) | Total: 0.0% (880us) | Samples: 0

**Calls:**
- `restoreDiff` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpRouter.js:108` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `find` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\messageReader.js:11` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:14` | Self: 0.0% (0us) | Total: 0.0% (947us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts:10` | Self: 0.0% (0us) | Total: 0.0% (969us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `node:http`
`node:http:2` | Self: 0.0% (0us) | Total: 0.2% (30.7ms) | Samples: 0

**Calls:**
- `anonymous` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:229` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `map` (1)

### `Socket`
`node:_http_server:899` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `onServerConnection` (1)

**Calls:**
- `Socket` (1)

### `#N`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `processPatterns` (1)

**Calls:**
- `child` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\module-types.js:40` | Self: 0.0% (0us) | Total: 0.4% (57.0ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:782` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Calls:**
- `bound max` (1)

### `createRoutes`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:681` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `compile` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1664` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `~effect/Effect/failureCont` (1)

**Calls:**
- `causeFilterInterruptors` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1525` | Self: 0.0% (0us) | Total: 0.2% (31.7ms) | Samples: 0

**Called by:**
- `generatorResume` (5)

**Calls:**
- `fiberAwaitAll` (5)

### `realpathSync`
`node:fs:376` | Self: 0.0% (0us) | Total: 0.3% (48.1ms) | Samples: 0

**Called by:**
- `resolve` (6)

**Calls:**
- `lstatSync` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\baggage\utils.js:19` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `onExit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:953` | Self: 0.0% (0us) | Total: 7.1% (978.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (100)

**Calls:**
- `(anonymous)` (100)

### `mapOrSame`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2393` | Self: 0.0% (0us) | Total: 0.3% (49.3ms) | Samples: 0

**Called by:**
- `rebuild` (5)
- `rebuild` (2)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:803` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `onConflictDoUpdate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:779` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\_md.js:5` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async ClaudeAuthPlugin`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\claude.ts:131` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (1)

**Calls:**
- `resolveCliPath` (1)

### `ZodArray`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `_array` (1)

**Calls:**
- `init` (1)

### `markListenerGenerationClosed`
`node:_http_server:91` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (1)

**Calls:**
- `emitCloseServer` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:72` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Calls:**
- `annotate` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:797` | Self: 0.0% (0us) | Total: 0.0% (997us) | Samples: 0

**Calls:**
- `_string` (1)

### `node:_http_client`
`node:_http_client:10` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:91` | Self: 0.0% (0us) | Total: 0.0% (959us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `statement` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:48` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\reply.js:36` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1156` | Self: 0.0% (0us) | Total: 0.0% (906us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `structuredClone` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:32` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Called by:**
- `getPayload` (1)

**Calls:**
- `make` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1334` | Self: 0.0% (0us) | Total: 0.0% (9.2ms) | Samples: 0

**Calls:**
- `_string` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeFileSystem.js:271` | Self: 0.0% (0us) | Total: 0.4% (58.1ms) | Samples: 0

**Called by:**
- `guarded` (4)

**Calls:**
- `(anonymous)` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:682` | Self: 0.0% (0us) | Total: 0.4% (66.9ms) | Samples: 0

**Called by:**
- `runLoop` (12)

**Calls:**
- `(anonymous)` (12)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `normalizePath`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:252` | Self: 0.0% (0us) | Total: 0.2% (31.0ms) | Samples: 0

**Called by:**
- `resolve` (3)

**Calls:**
- `bound realpathNativeSync` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1072` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Calls:**
- `string` (1)

### `mapResultRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:72` | Self: 0.0% (0us) | Total: 0.2% (36.2ms) | Samples: 0

**Called by:**
- `map` (6)
- `(anonymous)` (1)

**Calls:**
- `forEach` (7)

### `publishEvent`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1335` | Self: 0.0% (0us) | Total: 0.0% (13.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `gen` (1)

### `registerOwned`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:85` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `ownerKeys` (1)

### `I`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `async Je` (1)

**Calls:**
- `map` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:154` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:365` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Calls:**
- `compile` (1)

### `rebuild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1691` | Self: 0.0% (0us) | Total: 0.2% (33.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `mapOrSame` (5)
- `mapOrSame` (1)

### `observeMoments`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield-statistics.ts:146` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:674` | Self: 0.0% (0us) | Total: 1.7% (244.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (23)
- `(anonymous)` (8)
- `(anonymous)` (6)

**Calls:**
- `fromIteratorEagerUnsafe` (18)
- `(anonymous)` (10)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\transaction.js:6` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `mergeAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:728` | Self: 0.0% (0us) | Total: 0.3% (47.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `forEach` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1128` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `body`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1871` | Self: 0.0% (0us) | Total: 0.2% (31.2ms) | Samples: 0

**Called by:**
- `runLoop` (3)

**Calls:**
- `(anonymous)` (3)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:11` | Self: 0.0% (0us) | Total: 0.3% (41.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `create` (2)
- `create` (2)
- `create` (1)

### `child`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `#N` (1)

**Calls:**
- `children` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `_await`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:79` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `callback` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2419` | Self: 0.0% (0us) | Total: 0.0% (10.4ms) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `currentTimeNanosUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:1206` | Self: 0.0% (0us) | Total: 0.0% (12.2ms) | Samples: 0

**Called by:**
- `go` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:89` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `observeYieldStatistic` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:95` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+core@3.24.5\node_modules\@smithy\core\dist-cjs\submodules\serde\index.js:6` | Self: 0.0% (0us) | Total: 0.0% (11.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:253` | Self: 0.0% (0us) | Total: 0.0% (914us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `setContext`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:492` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getRef` (1)

### `onServerConnection`
`node:_http_server:668` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Calls:**
- `Socket` (1)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:86` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `on` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\buildMatchMemberExpression.js:7` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:598` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `runLoop` (3)

**Calls:**
- `interruptUnsafe` (2)
- `interruptUnsafe` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:62` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:14` | Self: 0.0% (0us) | Total: 0.3% (42.9ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:104` | Self: 0.0% (0us) | Total: 0.2% (31.5ms) | Samples: 0

**Called by:**
- `findIndex` (3)

**Calls:**
- `isTitleRequest` (2)
- `includes` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Ref.js:370` | Self: 0.0% (0us) | Total: 0.0% (10.4ms) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\scheduled-task\session-binding.ts:143` | Self: 0.0% (0us) | Total: 0.0% (10.7ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `fn` (1)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:60` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (989us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts:131` | Self: 0.0% (0us) | Total: 0.0% (882us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:12` | Self: 0.0% (0us) | Total: 0.0% (928us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:234` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `GenerationOptions`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Called by:**
- `mergeGenerationOptions` (1)

**Calls:**
- `out` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:47` | Self: 0.0% (0us) | Total: 0.0% (10.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `flat` (1)

### `annotate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:151` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `Map` (1)

### `gitbash`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:366` | Self: 0.0% (0us) | Total: 0.2% (28.6ms) | Samples: 0

**Called by:**
- `win` (3)

**Calls:**
- `which` (3)

### `existsSync`
`node:fs:217` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Called by:**
- `exists` (1)

**Calls:**
- `existsSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\normalize-and-load-metadata.js:11` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `exists`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\claude\availability.ts:78` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Called by:**
- `resolveCliPath` (1)

**Calls:**
- `existsSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:206` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `recur` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js:583` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:9` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1991` | Self: 0.0% (0us) | Total: 0.8% (121.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (12)
- `go` (8)
- `(anonymous)` (3)

**Calls:**
- `go` (22)
- `go` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:416` | Self: 0.0% (0us) | Total: 0.2% (33.7ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:72` | Self: 0.0% (0us) | Total: 0.1% (19.7ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:30` | Self: 0.0% (0us) | Total: 0.0% (902us) | Samples: 0

**Calls:**
- `bound require` (1)

### `replacementMapFrom`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:276` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `compile` (1)

**Calls:**
- `reduce` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:5` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\util\resolveCommand.js:4` | Self: 0.0% (0us) | Total: 0.4% (62.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\lib\compile.js:3` | Self: 0.0% (0us) | Total: 0.2% (29.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\diag.js:20` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `optionalKey`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2427` | Self: 0.0% (0us) | Total: 0.0% (10.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `create` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:885` | Self: 0.0% (0us) | Total: 0.1% (22.7ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `fromRow` (2)
- `fromRow` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:83` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Calls:**
- `channel` (1)

### `ZodString`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:31` | Self: 0.0% (0us) | Total: 0.0% (9.2ms) | Samples: 0

**Called by:**
- `_string` (1)

**Calls:**
- `init` (1)

### `async doTransform`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11936` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `async doStream` (1)
- `async doTransform` (1)

**Calls:**
- `async transformParams` (1)
- `async doTransform` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:161` | Self: 0.0% (0us) | Total: 0.3% (48.8ms) | Samples: 0

**Called by:**
- `_prepare` (10)

**Calls:**
- `buildSelection` (9)
- `join` (1)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:331` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `on` (1)

**Calls:**
- `collectJsonSchemaChecks` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\printer.js:8` | Self: 0.0% (0us) | Total: 0.2% (30.7ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `clone`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\util.js:262` | Self: 0.0% (0us) | Total: 0.2% (30.1ms) | Samples: 0

**Called by:**
- `bound extend` (1)
- `bound clone` (1)

**Calls:**
- `ZodObject` (1)
- `ZodNumber` (1)

### `set`
`node:diagnostics_channel:22` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `Channel` (1)

**Calls:**
- `WeakReference` (1)

### `toJsonSchemaDocument`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:297` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `toJsonSchemaDocument` (1)

**Calls:**
- `toJsonSchemaMultiDocument` (1)

### `DefaultStreamTextResult`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6567` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `streamText` (1)

**Calls:**
- `DelayedPromise` (1)

### `isHistoricalInfo`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts:233` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `latest` (1)

**Calls:**
- `resolveInfo` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\api.js:4` | Self: 0.0% (0us) | Total: 0.0% (969us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:66` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `bound max`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `bound check` (1)

### `from`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:125` | Self: 0.0% (0us) | Total: 0.2% (28.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `SQLiteEffectSelectBase` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\resolve@1.22.12\node_modules\resolve\lib\async.js:7` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `sql`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:321` | Self: 0.0% (0us) | Total: 0.4% (57.7ms) | Samples: 0

**Called by:**
- `buildSelectQuery` (2)
- `(anonymous)` (1)
- `map` (1)
- `(anonymous)` (1)

**Calls:**
- `SQL` (5)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\bedrock-converse.ts:127` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Calls:**
- `Struct` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:8` | Self: 0.0% (0us) | Total: 0.0% (12.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\MessageStorage.js:534` | Self: 0.0% (0us) | Total: 0.4% (62.1ms) | Samples: 0

**Calls:**
- `Option` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\convertToBuffer.js:6` | Self: 0.0% (0us) | Total: 1.1% (153.6ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:809` | Self: 0.0% (0us) | Total: 0.1% (16.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `Error` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:238` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `importModule` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\automation.ts:595` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `get` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\index.ts:229` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `hasLegacyConsumer`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:124` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `max` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:330` | Self: 0.0% (0us) | Total: 0.2% (31.6ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `flatIntoArrayWithCallback` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\draft7.js:5` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:891` | Self: 0.0% (0us) | Total: 0.0% (13.6ms) | Samples: 0

**Called by:**
- `runLoop` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (2)

### `handler`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:135` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `emit` (1)

**Calls:**
- `(anonymous)` (1)

### `define`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:91` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `make` (1)

### `touch`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:409` | Self: 0.0% (0us) | Total: 0.0% (971us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `pruneStates` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3302` | Self: 0.0% (0us) | Total: 0.0% (893us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\index.js:6` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\index.js:4` | Self: 0.0% (0us) | Total: 0.2% (31.1ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\vocabularies\applicator\index.js:18` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `ExpansionLane`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:77` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `SpadDetector` (1)

**Calls:**
- `Int32Array` (1)

### `ownerKeys`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:81` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `registerOwned` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:928` | Self: 0.0% (0us) | Total: 0.1% (17.0ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `workerDelegation` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\string.js:8` | Self: 0.0% (0us) | Total: 0.3% (44.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1427` | Self: 0.0% (0us) | Total: 0.4% (61.7ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `resolve` (7)

### `startPart`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:114` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `beginTurn` (2)

**Calls:**
- `SpadDetector` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1785` | Self: 0.0% (0us) | Total: 0.0% (859us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `isHumanControllableWorker` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha1.js:4` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1020` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Calls:**
- `object` (1)

### `getPayload`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:141` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `make` (1)
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `provideServiceImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1149` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\browser.ts:721` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Calls:**
- `Literals` (1)

### `interruptUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:398` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `evaluate` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-descriptors.js:16` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `fromIteratorEagerUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:840` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3872` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `beginTurn` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:393` | Self: 0.0% (0us) | Total: 0.2% (32.5ms) | Samples: 0

**Called by:**
- `generatorResume` (4)

**Calls:**
- `streamText` (2)
- `streamText` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\provider-route.ts:298` | Self: 0.0% (0us) | Total: 0.0% (882us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-up@3.0.0\node_modules\find-up\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (8.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:272` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `get` (1)

### `L`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\isexe@4.0.0\node_modules\isexe\dist\commonjs\index.min.js:1` | Self: 0.0% (0us) | Total: 0.7% (105.2ms) | Samples: 0

**Called by:**
- `whichSync` (14)

**Calls:**
- `statSync` (14)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\auth.ts:17` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `Service` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:74` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `is` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:1051` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Calls:**
- `makeFromTransport` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:705` | Self: 0.0% (0us) | Total: 0.2% (31.5ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `pull` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\index.js:9` | Self: 0.0% (0us) | Total: 0.2% (30.7ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\nodes.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async load`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\command.ts:15` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `async load` (1)

**Calls:**
- `async scan` (1)

### `async transform`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2294` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `onPipeChunkDeferredWrite` (1)
- `async transform` (1)

**Calls:**
- `async safeParseJSON` (1)
- `async transform` (1)

### `onCause`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js:160` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `~effect/Effect/failureCont` (1)

**Calls:**
- `doneExitFromCause` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-modules-commonjs@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-modules-commonjs\lib\index.js:14` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `beginTurn`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts:83` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `startPart` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\type\js\function.js:15` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `toJsonSchemaDocument`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7817` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `fromSchema` (1)

**Calls:**
- `fromAST` (1)

### `fromSchema`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\json-schema.ts:48` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `toJsonSchemaDocument` (1)

### `next`
`[native code]` | Self: 0.0% (0us) | Total: 100.0% (14.29s) | Samples: 0

**Called by:**
- `(anonymous)` (1599)
- `~effect/Effect/successCont` (187)
- `fromIteratorEagerUnsafe` (28)

**Calls:**
- `generatorResume` (1814)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\defineElement.js:21` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `create` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:699` | Self: 0.0% (0us) | Total: 0.3% (45.1ms) | Samples: 0

**Called by:**
- `bound ` (6)

**Calls:**
- `~effect/Utils/internal` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:8` | Self: 0.0% (0us) | Total: 0.2% (30.7ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\flow.js:346` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `validateType` (1)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `D` (1)

**Calls:**
- `ge` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\utils.js:14` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:109` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `flatIntoArrayWithCallback` (2)

**Calls:**
- `sql` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\api\propagation.js:22` | Self: 0.0% (0us) | Total: 0.0% (984us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\encoders\der.js:8` | Self: 0.0% (0us) | Total: 0.6% (92.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1061` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `_array` (1)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `go`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1910` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `callback` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\pty.ts:31` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Calls:**
- `annotate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\node.js:32` | Self: 0.0% (0us) | Total: 0.0% (13.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-preset-solid@1.9.12+2507c47859fdd5f5\node_modules\babel-preset-solid\index.js:1` | Self: 0.0% (0us) | Total: 1.4% (203.4ms) | Samples: 0

**Calls:**
- `bound require` (14)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:770` | Self: 0.0% (0us) | Total: 0.2% (31.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `run` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+is-array-buffer@2.2.0\node_modules\@smithy\is-array-buffer\dist-cjs\index.js:26` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__name` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1472` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `boundedSqlitePermit` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:29` | Self: 0.0% (0us) | Total: 0.0% (979us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `buildForeignKeys` (1)

### `fromJsonString`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:6346` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `sseDataJsonSchema` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:979` | Self: 0.0% (0us) | Total: 0.0% (923us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `fromRow` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\ShardingConfig.js:29` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `make` (1)

### `buildSelection`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:81` | Self: 0.0% (0us) | Total: 0.3% (47.9ms) | Samples: 0

**Called by:**
- `buildSelectQuery` (9)

**Calls:**
- `flatIntoArrayWithCallback` (9)

### `ReadableStream`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `runToolsTransformation` (1)

**Calls:**
- `async start` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:47` | Self: 0.0% (0us) | Total: 0.0% (10.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:896` | Self: 0.0% (0us) | Total: 0.1% (18.0ms) | Samples: 0

**Called by:**
- `generatorResume` (5)

**Calls:**
- `run` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\utils.js:8` | Self: 0.0% (0us) | Total: 0.1% (19.7ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\item.js:16` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\goal.ts:23` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Calls:**
- `join` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:829` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `isHumanControllableWorker` (1)

### `_string`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\api.js:7` | Self: 0.0% (0us) | Total: 0.1% (16.7ms) | Samples: 0

**Called by:**
- `string` (2)
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `ZodString` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:10` | Self: 0.0% (0us) | Total: 0.0% (948us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:725` | Self: 0.0% (0us) | Total: 1.1% (156.7ms) | Samples: 0

**Called by:**
- `onItem` (13)
- `(anonymous)` (10)
- `onItem` (5)
- `onItem` (1)

**Calls:**
- `(anonymous)` (28)
- `(anonymous)` (1)

### `SQLiteSelectQueryBuilderBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:60` | Self: 0.0% (0us) | Total: 0.2% (27.5ms) | Samples: 0

**Called by:**
- `SQLiteEffectSelectBase` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:325` | Self: 0.0% (0us) | Total: 0.1% (17.1ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `all` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\common\api.js:52` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\input.ts:1205` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `get` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:3065` | Self: 0.0% (0us) | Total: 0.0% (12.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `has` (1)

### `struct`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1749` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `Struct` (1)

**Calls:**
- `Objects` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.1\node_modules\semver\index.js:31` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `find`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:212` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getNextNode` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:124` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `escapeName` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:3` | Self: 0.0% (0us) | Total: 1.1% (155.7ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `out`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7272` | Self: 0.0% (0us) | Total: 0.3% (45.5ms) | Samples: 0

**Called by:**
- `Info` (4)
- `GenerationOptions` (1)

**Calls:**
- `(anonymous)` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `findLast` (3)

**Calls:**
- `match` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\lib\node\ril.js:8` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:1544` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1979` | Self: 0.0% (0us) | Total: 0.2% (31.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `go` (1)

**Calls:**
- `getCandidates` (2)
- `getCandidates` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:538` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `define` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node@4.0.0-beta.83+40cb817acddcaf25\node_modules\@effect\platform-node\dist\NodeHttpServer.js:63` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `emit` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:542` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `workerDelegation`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:197` | Self: 0.0% (0us) | Total: 0.3% (54.4ms) | Samples: 0

**Called by:**
- `isHumanControllableWorker` (4)
- `(anonymous)` (3)

**Calls:**
- `normalizeWorkerDelegationModel` (6)
- `normalizeWorkerDelegationModel` (1)

### `doneUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Deferred.js:657` | Self: 0.0% (0us) | Total: 12.6% (1.74s) | Samples: 0

**Called by:**
- `(anonymous)` (148)
- `~effect/Effect/evaluate` (69)

**Calls:**
- `(anonymous)` (217)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:4163` | Self: 0.0% (0us) | Total: 0.3% (41.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\index.js:1` | Self: 0.0% (0us) | Total: 3.7% (518.2ms) | Samples: 0

**Calls:**
- `bound require` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1145` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `provideServiceImpl` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:224` | Self: 0.0% (0us) | Total: 0.5% (78.7ms) | Samples: 0

**Called by:**
- `map` (7)
- `(anonymous)` (3)

**Calls:**
- `mergeQueries` (8)
- `mergeQueries` (1)
- `mergeQueries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:988` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1327` | Self: 0.0% (0us) | Total: 0.1% (18.6ms) | Samples: 0

**Called by:**
- `go` (5)

**Calls:**
- `(anonymous)` (5)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\websearch.ts:113` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Calls:**
- `defineFunctionLength` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\index.js:3` | Self: 0.0% (0us) | Total: 0.6% (93.1ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `_t`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:29` | Self: 0.0% (0us) | Total: 0.9% (124.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (11)

**Calls:**
- `bound require` (11)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7298` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `RunnerAddress` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:106` | Self: 0.0% (0us) | Total: 0.0% (931us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `statement` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1156` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `retrySqliteBusyCause` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\event.ts:108` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Calls:**
- `make` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaTransformation.js:622` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `transformOptional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\engines.js:3` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:40` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1282` | Self: 0.0% (0us) | Total: 0.2% (37.8ms) | Samples: 0

**Called by:**
- `generatorResume` (10)

**Calls:**
- `go` (9)
- `go` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\session-limit-recovery.ts:55` | Self: 0.0% (0us) | Total: 0.0% (13.5ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js:6` | Self: 0.0% (0us) | Total: 0.0% (11.5ms) | Samples: 0

**Calls:**
- `map` (1)

### `scopeCloseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1509` | Self: 0.0% (0us) | Total: 1.1% (154.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (15)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (16)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts:444` | Self: 0.0% (0us) | Total: 0.0% (11.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `async transformParams`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:454` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async doTransform` (1)

**Calls:**
- `message` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\core.js:11` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:315` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1810` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Calls:**
- `bound extend` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+core@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\core\build\src\index.js:35` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\file\file.js:46` | Self: 0.0% (0us) | Total: 0.9% (124.0ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `_t` (11)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:31` | Self: 0.0% (0us) | Total: 0.2% (30.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `_debug` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\avvio@9.2.0\node_modules\avvio\boot.js:3` | Self: 0.0% (0us) | Total: 0.0% (980us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:143` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-runtime.ts:568` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Calls:**
- `describeDefinition` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiError.js:166` | Self: 0.0% (0us) | Total: 0.1% (14.2ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `pipeArguments`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js:62` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `onSuccess` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\walker.js:13` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `fullyDenied`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` | Self: 0.0% (0us) | Total: 0.3% (44.5ms) | Samples: 0

**Called by:**
- `filter` (5)

**Calls:**
- `findLast` (5)

### `secureJsonParse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:865` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `async safeParseJSON` (1)

**Calls:**
- `_parse` (1)

### `_string`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\api.js:5` | Self: 0.0% (0us) | Total: 0.0% (9.2ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodString` (1)

### `currentTimeNanosUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2499` | Self: 0.0% (0us) | Total: 0.0% (12.2ms) | Samples: 0

**Called by:**
- `makeSpanUnsafe` (2)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:890` | Self: 0.0% (0us) | Total: 0.0% (982us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:87` | Self: 0.0% (0us) | Total: 4.1% (568.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (31)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (54)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:964` | Self: 0.0% (0us) | Total: 7.1% (978.4ms) | Samples: 0

**Called by:**
- `evaluate` (100)

**Calls:**
- `onExit` (100)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-buffer-from@2.2.0\node_modules\@smithy\util-buffer-from\dist-cjs\index.js:27` | Self: 0.0% (0us) | Total: 1.1% (153.6ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1550` | Self: 0.0% (0us) | Total: 0.3% (42.5ms) | Samples: 0

**Called by:**
- `generatorResume` (6)

**Calls:**
- `create` (5)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:350` | Self: 0.0% (0us) | Total: 0.2% (27.7ms) | Samples: 0

**Called by:**
- `findLast` (3)

**Calls:**
- `match` (2)
- `match` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:72` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `create`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts:23` | Self: 0.0% (0us) | Total: 0.1% (25.1ms) | Samples: 0

**Called by:**
- `create` (2)

**Calls:**
- `from` (2)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:362` | Self: 0.0% (0us) | Total: 0.4% (62.0ms) | Samples: 0

**Called by:**
- `run` (8)

**Calls:**
- `(anonymous)` (7)
- `buildUpdateQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2417` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\dom-serializer@2.0.0\node_modules\dom-serializer\lib\esm\foreignNames.js:40` | Self: 0.0% (0us) | Total: 0.0% (874us) | Samples: 0

**Calls:**
- `Map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:21` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fill-range@7.1.1\node_modules\fill-range\index.js:11` | Self: 0.0% (0us) | Total: 0.2% (29.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\builder.js:8` | Self: 0.0% (0us) | Total: 0.3% (44.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` | Self: 0.0% (0us) | Total: 3.2% (442.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (52)

**Calls:**
- `(anonymous)` (52)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2347` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `currentTimeNanosUnsafe` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:947` | Self: 0.0% (0us) | Total: 0.9% (135.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (23)

**Calls:**
- `(anonymous)` (23)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:459` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:6` | Self: 0.0% (0us) | Total: 0.3% (42.6ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\tokenizer\index.js:7` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\DOMImplementation.js:4` | Self: 0.0% (0us) | Total: 0.2% (32.3ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\index.js:4` | Self: 0.0% (0us) | Total: 0.3% (45.9ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-module-transforms@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-module-transforms\lib\index.js:51` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `walkCB`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `walkCB2` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:29` | Self: 0.0% (0us) | Total: 0.0% (891us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\auto-accept-policy.ts:37` | Self: 0.0% (0us) | Total: 0.2% (31.1ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (3)

**Calls:**
- `resolve` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\gensync-utils\fs.js:22` | Self: 0.0% (0us) | Total: 0.1% (19.7ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `_fs` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\ResourceImpl.js:9` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1549` | Self: 0.0% (0us) | Total: 0.2% (27.9ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `scopeAddFinalizerUnsafe` (1)
- `scopeAddFinalizerUnsafe` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:858` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `literal` (1)

### `runToolsTransformation`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6338` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Called by:**
- `async streamStep` (1)

**Calls:**
- `ReadableStream` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\context.js:7` | Self: 0.0% (0us) | Total: 0.5% (76.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:687` | Self: 0.0% (0us) | Total: 0.0% (889us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `isTitleRequest` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\index.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-hex-encoding@4.3.5\node_modules\@smithy\util-hex-encoding\dist-cjs\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (11.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:525` | Self: 0.0% (0us) | Total: 0.1% (13.7ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `stateFor` (2)

### `acceptable`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:543` | Self: 0.0% (0us) | Total: 0.4% (60.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (9)

**Calls:**
- `select` (9)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:27` | Self: 0.0% (0us) | Total: 0.1% (14.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1540` | Self: 0.0% (0us) | Total: 2.6% (369.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (18)
- `(anonymous)` (12)
- `mergeAllEffect` (6)

**Calls:**
- `scopeAddFinalizerUnsafe` (35)
- `scopeAddFinalizerUnsafe` (1)

### `Literals`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:2138` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\schema\default_full.js:20` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `realpathSync`
`node:fs:358` | Self: 0.0% (0us) | Total: 0.1% (13.7ms) | Samples: 0

**Called by:**
- `resolve` (1)

**Calls:**
- `lstatSync` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:150` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3770` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `importModule` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:597` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:13` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Calls:**
- `bound require` (1)

### `mergeGenerationOptions`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\schema\options.ts:111` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Called by:**
- `mergeRouteDefaults` (1)

**Calls:**
- `GenerationOptions` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:656` | Self: 0.0% (0us) | Total: 14.8% (2.04s) | Samples: 0

**Called by:**
- `runTasks` (269)

**Calls:**
- `evaluate` (268)
- `evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:824` | Self: 0.0% (0us) | Total: 1.0% (141.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (28)

**Calls:**
- `fromIteratorEagerUnsafe` (23)
- `fromIteratorEagerUnsafe` (4)
- `fromIteratorEagerUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1237` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `sql` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3175` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `[Symbol.iterator]` (1)

### `resolve`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:270` | Self: 0.0% (0us) | Total: 0.6% (92.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)
- `async get` (3)

**Calls:**
- `realpathSync` (6)
- `normalizePath` (3)
- `realpathSync` (1)

### `endReadableNT`
`internal:streams/readable:901` | Self: 0.0% (0us) | Total: 0.3% (49.3ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (6)

**Calls:**
- `emit` (6)

### `toTypeScript`
`C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-schema.ts:201` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `describeDefinition` (1)

**Calls:**
- `toJsonSchemaDocument` (1)

### `finalizer`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:132` | Self: 0.0% (0us) | Total: 0.5% (75.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (7)
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:19` | Self: 0.0% (0us) | Total: 0.2% (30.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `guarded`
`internal:shared:114` | Self: 0.0% (0us) | Total: 8.5% (1.17s) | Samples: 0

**Calls:**
- `(anonymous)` (121)
- `(anonymous)` (4)
- `(anonymous)` (1)

### `populateMaps`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:155` | Self: 0.0% (0us) | Total: 2.1% (293.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `forEach` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2637` | Self: 0.0% (0us) | Total: 0.3% (48.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)

**Calls:**
- `rebuild` (3)
- `rebuild` (2)
- `rebuild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:977` | Self: 0.0% (0us) | Total: 0.1% (19.3ms) | Samples: 0

**Called by:**
- `generatorResume` (5)

**Calls:**
- `getFrom` (5)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+gateway@3.0.104+d6123d32214422cb\node_modules\@ai-sdk\gateway\dist\index.mjs:1343` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `discriminatedUnion` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\tools.ts:497` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `schema` (1)
- `fromSchema` (1)

### `onPipeChunkDeferredWrite`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Calls:**
- `async transform` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\record.ts:153` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:147` | Self: 0.0% (0us) | Total: 7.3% (1.01s) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (148)

**Calls:**
- `doneUnsafe` (148)

### `ge`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `make` (1)

**Calls:**
- `ht` (1)

### `async tmpdir`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\fixture\fixture.ts:102` | Self: 0.0% (0us) | Total: 2.8% (387.0ms) | Samples: 0

**Calls:**
- `write` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\parse.js:4` | Self: 0.0% (0us) | Total: 0.4% (64.7ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts:411` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1029` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `#H`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (31.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1141` | Self: 0.0% (0us) | Total: 0.9% (135.6ms) | Samples: 0

**Called by:**
- `generatorResume` (23)

**Calls:**
- `(anonymous)` (23)

### `children`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `child` (1)

**Calls:**
- `set` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1269` | Self: 0.0% (0us) | Total: 0.2% (32.4ms) | Samples: 0

**Called by:**
- `generatorResume` (12)

**Calls:**
- `run` (12)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts:129` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `join` (1)

### `getLocalAddresses`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\definitions.js:67` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `networkInterfaces` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1111` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:731` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `sessionRow` (1)

### `afterScheduled`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:140` | Self: 0.0% (0us) | Total: 20.1% (2.77s) | Samples: 0

**Calls:**
- `runTasks` (359)

### `~effect/Effect/failureCont`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1630` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `(anonymous)` (1)
- `onCause` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:16` | Self: 0.0% (0us) | Total: 0.3% (41.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `applyUsage`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:139` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `run` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\effect-flock.ts:283` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\handle-request.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpClient.js:625` | Self: 0.0% (0us) | Total: 2.8% (385.9ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `FinalizationRegistry` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:235` | Self: 0.0% (0us) | Total: 0.0% (971us) | Samples: 0

**Calls:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:883` | Self: 0.0% (0us) | Total: 0.2% (33.6ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `getFrom` (7)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:7205` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `async doStream` (1)

### `sqliteTableBase`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\table.js:25` | Self: 0.0% (0us) | Total: 0.0% (979us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `map` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\session.ts:367` | Self: 0.0% (0us) | Total: 0.4% (60.5ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts:66` | Self: 0.0% (0us) | Total: 0.0% (856us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:333` | Self: 0.0% (0us) | Total: 0.2% (33.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `_prepare` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\effect-flock.ts:49` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `exponential` (1)

### `set`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `children` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:804` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `run` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-limit-recovery.ts:15` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\react\isReactComponent.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:470` | Self: 0.0% (0us) | Total: 0.3% (41.3ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `all` (3)

### `StreamSse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:154` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `make` (2)

**Calls:**
- `sseDataJsonSchema` (2)

### `makeEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:68` | Self: 0.0% (0us) | Total: 0.7% (104.2ms) | Samples: 0

**Called by:**
- `make` (8)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (3)

### `orderSelectedFields`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js:174` | Self: 0.0% (0us) | Total: 0.0% (13.4ms) | Samples: 0

**Called by:**
- `buildSelectQuery` (1)

**Calls:**
- `entries` (1)

### `async doStream`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11955` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async doStream` (1)

**Calls:**
- `async doTransform` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.4% (61.4ms) | Samples: 0

**Called by:**
- `map` (1)
- `Promise` (1)
- `set` (1)
- `guarded` (1)

**Calls:**
- `#H` (1)
- `q` (1)
- `D` (1)
- `walkCB` (1)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:320` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `on` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:37` | Self: 0.0% (0us) | Total: 0.0% (12.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1115` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js:969` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts:1114` | Self: 0.0% (0us) | Total: 0.4% (60.2ms) | Samples: 0

**Called by:**
- `generatorResume` (9)

**Calls:**
- `acceptable` (9)

### `processPatterns`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `walkCB2` (1)

**Calls:**
- `#N` (1)

### `which`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\which.ts:8` | Self: 0.0% (0us) | Total: 0.7% (105.2ms) | Samples: 0

**Called by:**
- `win` (6)
- `async AzureAuthPlugin` (4)
- `gitbash` (3)
- `~effect/Effect/evaluate` (1)

**Calls:**
- `whichSync` (14)

### `getBaseTelemetryAttributes`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:2155` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `DefaultStreamTextResult` (1)

**Calls:**
- `reduce` (1)

### `async pull`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts:171` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `onRSDefaultControllerPullFulfilled` (1)

**Calls:**
- `async pull` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:738` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `async postJsonToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2342` | Self: 0.0% (0us) | Total: 0.2% (31.9ms) | Samples: 0

**Called by:**
- `async doStream` (4)

**Calls:**
- `stringify` (4)

### `Literal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1419` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `make` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (22.5ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (13)

### `and`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\expressions\conditions.js:59` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `join` (1)

### `releaseTakers`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1451` | Self: 0.0% (0us) | Total: 3.2% (447.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (57)
- `runTasks` (2)

**Calls:**
- `(anonymous)` (59)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:4356` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `takeAuditCases` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js:4321` | Self: 0.0% (0us) | Total: 0.1% (14.2ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `findIndex` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:912` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `applyUsage` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\ajv.js:4` | Self: 0.0% (0us) | Total: 0.2% (28.5ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `async Je`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:3` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `async scan` (1)

**Calls:**
- `I` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\index.js:2` | Self: 0.0% (0us) | Total: 0.2% (32.3ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `join`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:342` | Self: 0.0% (0us) | Total: 0.1% (17.9ms) | Samples: 0

**Called by:**
- `buildUpdateQuery` (1)
- `and` (1)
- `buildSelectQuery` (1)

**Calls:**
- `SQL` (2)
- `SQL` (1)

### `fromAST`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:16` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `toJsonSchemaDocument` (1)

**Calls:**
- `fromASTs` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\group.ts:918` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2112` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Called by:**
- `runLoop` (1)
- `evaluate` (1)

**Calls:**
- `addObserver` (1)
- `scopeRemoveFinalizerUnsafe` (1)

### `require`
`[native code]` | Self: 0.0% (0us) | Total: 52.8% (7.26s) | Samples: 0

**Called by:**
- `bound require` (587)

**Calls:**
- `anonymous` (587)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:8` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:123` | Self: 0.0% (0us) | Total: 1.2% (171.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (19)

**Calls:**
- `getOrElseMemoize` (19)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:12` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ret@0.5.0\node_modules\ret\dist\index.js:15` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ManagedRuntime.js:101` | Self: 0.0% (0us) | Total: 0.0% (12.7ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+core@3.24.5\node_modules\@smithy\core\dist-cjs\submodules\endpoints\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (11.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `bound `
`[native code]` | Self: 0.0% (0us) | Total: 100.0% (14.89s) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1738)

**Calls:**
- `(anonymous)` (1716)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (2)

### `internal:fs/binding`
`internal:fs/binding:3` | Self: 0.0% (0us) | Total: 0.0% (926us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `@lazy` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:9` | Self: 0.0% (0us) | Total: 0.3% (42.2ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:262` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `next` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:839` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `evaluate` (1)

### `channel`
`node:diagnostics_channel:139` | Self: 0.0% (0us) | Total: 0.1% (26.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `Channel` (1)
- `Channel` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:11` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `buildUpdateQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:62` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `_prepare` (1)

**Calls:**
- `join` (1)

### `node:tty`
`node:tty:7` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:175` | Self: 0.0% (0us) | Total: 0.4% (58.8ms) | Samples: 0

**Called by:**
- `generatorResume` (6)

**Calls:**
- `resolveTools` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:151` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `topP` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:333` | Self: 0.0% (0us) | Total: 4.1% (568.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (54)

**Calls:**
- `withMapUnsafe` (54)

### `latest`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:2167` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `isHistoricalInfo` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts:110` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `run` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:42` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:372` | Self: 0.0% (0us) | Total: 3.0% (418.9ms) | Samples: 0

**Called by:**
- `runLoop` (57)

**Calls:**
- `releaseTakers` (57)

### `resolveTools`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\request.ts:251` | Self: 0.0% (0us) | Total: 0.4% (58.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)

**Calls:**
- `disabled` (5)
- `disabled` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `[prepareOwned]`
`bun:sqlite:331` | Self: 0.0% (0us) | Total: 0.2% (31.7ms) | Samples: 0

**Called by:**
- `query` (3)

**Calls:**
- `prepare` (3)

### `isTitleRequest`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts:615` | Self: 0.0% (0us) | Total: 0.0% (889us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `isArray` (1)

### `positiveInteger`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\runtime-flags.ts:6` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `number` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiError.js:278` | Self: 0.0% (0us) | Total: 0.0% (929us) | Samples: 0

**Calls:**
- `make` (1)

### `async (anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:260` | Self: 0.0% (0us) | Total: 0.0% (866us) | Samples: 0

**Called by:**
- `async dispose` (1)

**Calls:**
- `importModule` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1256` | Self: 0.0% (0us) | Total: 0.2% (33.6ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+core@2.0.0\node_modules\@modelcontextprotocol\core\dist\auth-CUe6YdwF.mjs:1096` | Self: 0.0% (0us) | Total: 0.0% (880us) | Samples: 0

**Calls:**
- `string` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:171` | Self: 0.0% (0us) | Total: 0.9% (124.0ms) | Samples: 0

**Calls:**
- `bound require` (11)

### `every`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:1796` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `patch` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts:625` | Self: 0.0% (0us) | Total: 0.1% (17.1ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `run` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\FileSystem.js:599` | Self: 0.0% (0us) | Total: 0.1% (16.0ms) | Samples: 0

**Calls:**
- `nominal` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1959` | Self: 0.0% (0us) | Total: 16.0% (2.20s) | Samples: 0

**Called by:**
- `evaluate` (249)

**Calls:**
- `(anonymous)` (249)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way@9.6.0\node_modules\find-my-way\index.js:30` | Self: 0.0% (0us) | Total: 0.1% (17.5ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\packages\protocol\src\groups\event.ts:92` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `StreamSse` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:10` | Self: 0.0% (0us) | Total: 0.0% (8.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:882` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `onConflictDoUpdate` (2)
- `onConflictDoUpdate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts:60` | Self: 0.0% (0us) | Total: 0.0% (999us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `async doStream`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:11958` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `async doStream` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:912` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `normalizeWorkerDelegationModel`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:168` | Self: 0.0% (0us) | Total: 0.0% (6.4ms) | Samples: 0

**Called by:**
- `workerDelegation` (1)

**Calls:**
- `copyDataProperties` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js:196870` | Self: 0.0% (0us) | Total: 3.5% (491.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@npmcli+config@10.8.1\node_modules\@npmcli\config\lib\definitions\definitions.js:1209` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `getLocalAddresses` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:76` | Self: 0.0% (0us) | Total: 2.2% (303.8ms) | Samples: 0

**Called by:**
- `_prepare` (28)
- `_prepare` (20)
- `_prepare` (7)

**Calls:**
- `buildQueryFromSourceParams` (52)
- `buildQueryFromSourceParams` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\runtime-flags.ts:82` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Calls:**
- `positiveInteger` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1166` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:26` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `async streamStep`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:7219` | Self: 0.0% (0us) | Total: 0.1% (14.5ms) | Samples: 0

**Calls:**
- `runToolsTransformation` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\index.js:17` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\Redis.js:6` | Self: 0.0% (0us) | Total: 0.3% (45.9ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\index.js:14` | Self: 0.0% (0us) | Total: 1.0% (142.7ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `ZodLiteral`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `literal` (1)

**Calls:**
- `init` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js:1685` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `RegExp` (1)

### `fn`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:787` | Self: 0.0% (0us) | Total: 0.0% (11.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `Error` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:74` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\lru-cache@11.5.1\node_modules\lru-cache\dist\commonjs\node\index.min.js:1` | Self: 0.0% (0us) | Total: 0.3% (43.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `anonymous` (1)

**Calls:**
- `(anonymous)` (2)
- `channel` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\project.ts:30` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Calls:**
- `make` (1)

### `bound clone`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `bound check` (1)

**Calls:**
- `clone` (1)

### `onConflictDoUpdate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts:289` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `mapUpdateSet` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\index.js:28` | Self: 0.0% (0us) | Total: 0.3% (41.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (996us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\db.ts:221` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `run` (3)

### `WeakReference`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `set` (1)

**Calls:**
- `WeakRef` (1)

### `statement`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:48` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `sqliteStatementClass` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1130` | Self: 0.0% (0us) | Total: 1.9% (274.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (11)

**Calls:**
- `(anonymous)` (11)

### `isHumanControllableWorker`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:227` | Self: 0.0% (0us) | Total: 0.2% (37.4ms) | Samples: 0

**Called by:**
- `fromRow` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `workerDelegation` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\micromatch@4.0.8\node_modules\micromatch\index.js:4` | Self: 0.0% (0us) | Total: 0.2% (31.9ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:332` | Self: 0.0% (0us) | Total: 0.2% (31.6ms) | Samples: 0

**Called by:**
- `flatIntoArrayWithCallback` (3)

**Calls:**
- `cloneInfo` (3)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1994` | Self: 0.0% (0us) | Total: 1.2% (174.4ms) | Samples: 0

**Called by:**
- `go` (17)

**Calls:**
- `(anonymous)` (17)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:361` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1185` | Self: 0.0% (0us) | Total: 0.9% (135.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (23)

**Calls:**
- `(anonymous)` (23)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:173` | Self: 0.0% (0us) | Total: 0.6% (92.5ms) | Samples: 0

**Calls:**
- `bound require` (12)

### `onRSDefaultControllerPullFulfilled`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Calls:**
- `async pull` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@fastify+rate-limit@10.3.0\node_modules\@fastify\rate-limit\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Calls:**
- `bound require` (1)

### `_traverse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:196` | Self: 0.0% (0us) | Total: 0.5% (77.7ms) | Samples: 0

**Called by:**
- `get` (9)

**Calls:**
- `bound require` (9)

### `currentTurnUploads`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:225` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `all` (2)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2325` | Self: 0.0% (0us) | Total: 0.0% (850us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getReferenceUnsafe` (1)

### `D`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `make` (1)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:229` | Self: 0.0% (0us) | Total: 0.1% (16.2ms) | Samples: 0

**Called by:**
- `all` (1)

**Calls:**
- `flatIntoArrayWithCallback` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\detect-resources.js:9` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1142` | Self: 0.0% (0us) | Total: 0.1% (16.5ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `stringify` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js:42` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `stateFor`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:366` | Self: 0.0% (0us) | Total: 0.1% (13.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\server.ts:711` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `createRoutes` (1)

### `getNextNode`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:412` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `find` (1)

**Calls:**
- `findStaticMatchingChild` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\npm-package-arg@13.0.2\node_modules\npm-package-arg\lib\npa.js:10` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2106` | Self: 0.0% (0us) | Total: 2.9% (403.9ms) | Samples: 0

**Called by:**
- `runLoop` (47)

**Calls:**
- `forkUnsafe` (47)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\limit-recovery.sql.ts:4` | Self: 0.0% (0us) | Total: 0.0% (979us) | Samples: 0

**Calls:**
- `sqliteTableBase` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\db.ts:212` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `evaluate` (3)

**Calls:**
- `(anonymous)` (3)

### `createHTMLParser`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:585` | Self: 0.0% (0us) | Total: 0.2% (32.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `bound require` (7)

### `message`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts:487` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async transformParams` (1)

**Calls:**
- `sdkKey` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\utils\react\cleanJSXElementLiteralChild.js:7` | Self: 0.0% (0us) | Total: 0.4% (59.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `SpadDetector`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\detector.ts:61` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `startPart` (2)

**Calls:**
- `ExpansionLane` (1)
- `ExpansionLane` (1)

### `Gt`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `ht` (1)

**Calls:**
- `slice` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ofxp-peer\index.ts:264` | Self: 0.0% (0us) | Total: 0.1% (17.0ms) | Samples: 0

**Calls:**
- `(anonymous)` (3)

### `fromRow`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:137` | Self: 0.0% (0us) | Total: 0.1% (21.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `isHumanControllableWorker` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\usage\usage.ts:298` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `prepareQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:75` | Self: 0.0% (0us) | Total: 0.0% (11.5ms) | Samples: 0

**Called by:**
- `run` (1)
- `run` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\locate-path@3.0.0\node_modules\locate-path\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:37` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\tool\bash.ts:24` | Self: 0.0% (0us) | Total: 0.2% (28.7ms) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1592` | Self: 0.0% (0us) | Total: 0.1% (26.7ms) | Samples: 0

**Called by:**
- `runLoop` (11)

**Calls:**
- `(anonymous)` (10)
- `setContext` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js:210` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `SQLiteSelectQueryBuilderBase` (1)

**Calls:**
- `createJoin` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\validate.js:10` | Self: 0.0% (0us) | Total: 0.3% (45.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\credential.ts:106` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `toJsonSchemaDocument`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:7818` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `toTypeScript` (1)

**Calls:**
- `toJsonSchemaDocument` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:48` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `findLast` (3)

### `getImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:201` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:420` | Self: 0.0% (0us) | Total: 0.0% (843us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `all` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+eventstream-codec@4.2.14\node_modules\@smithy\eventstream-codec\dist-cjs\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (11.9ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:41` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `ExpansionLane` (1)

**Calls:**
- `Int32Array` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:593` | Self: 0.0% (0us) | Total: 0.3% (48.9ms) | Samples: 0

**Calls:**
- `createHTMLParser` (7)
- `canParseHTMLNatively` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:425` | Self: 0.0% (0us) | Total: 26.3% (3.62s) | Samples: 0

**Called by:**
- `(anonymous)` (411)
- `forkUnsafe` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (249)
- `(anonymous)` (100)
- `(anonymous)` (53)
- `(anonymous)` (9)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `buildQueryFromSourceParams`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:90` | Self: 0.0% (0us) | Total: 4.6% (641.8ms) | Samples: 0

**Called by:**
- `map` (76)
- `(anonymous)` (52)

**Calls:**
- `map` (128)

### `findLast`
`[native code]` | Self: 0.0% (0us) | Total: 0.4% (60.3ms) | Samples: 0

**Called by:**
- `fullyDenied` (5)
- `evaluate` (3)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (3)
- `match` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\to-regex-range@5.0.1\node_modules\to-regex-range\index.js:10` | Self: 0.0% (0us) | Total: 0.2% (29.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `mapUpdateSet`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts:53` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `onConflictDoUpdate` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\propagation-api.js:21` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `whichSync`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\which@6.0.1\node_modules\which\lib\index.js:89` | Self: 0.0% (0us) | Total: 0.7% (105.2ms) | Samples: 0

**Called by:**
- `which` (14)

**Calls:**
- `L` (14)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\package.js:14` | Self: 0.0% (0us) | Total: 0.1% (19.7ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `bound realpathNativeSync`
`[native code]` | Self: 0.0% (0us) | Total: 0.2% (31.0ms) | Samples: 0

**Called by:**
- `normalizePath` (3)

**Calls:**
- `realpathNativeSync` (3)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:101` | Self: 0.0% (0us) | Total: 0.3% (44.7ms) | Samples: 0

**Calls:**
- `_template` (4)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\skill.ts:36` | Self: 0.0% (0us) | Total: 0.1% (16.0ms) | Samples: 0

**Calls:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:798` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `activeGrantEntries` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:368` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2598` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:679` | Self: 0.0% (0us) | Total: 4.1% (572.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (76)

**Calls:**
- `withMapUnsafe` (73)
- `withMapUnsafe` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2179` | Self: 0.0% (0us) | Total: 3.4% (472.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (56)

**Calls:**
- `(anonymous)` (56)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@effect+platform-node-shared@4.0.0-beta.83+43902b222b0d7d3e\node_modules\@effect\platform-node-shared\dist\NodeStream.js:142` | Self: 0.0% (0us) | Total: 0.3% (49.3ms) | Samples: 0

**Called by:**
- `emit` (6)

**Calls:**
- `(anonymous)` (6)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:13` | Self: 0.0% (0us) | Total: 0.0% (10.8ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `cloneInfo`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:264` | Self: 0.0% (0us) | Total: 0.2% (31.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `cloneObject` (3)

### `async safeParseJSON`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2258` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `async safeParseJSON` (1)

**Calls:**
- `secureJsonParse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1538` | Self: 0.0% (0us) | Total: 0.2% (29.5ms) | Samples: 0

**Called by:**
- `filter` (2)

**Calls:**
- `indexOf` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:1282` | Self: 0.0% (0us) | Total: 0.0% (12.4ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `all` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:461` | Self: 0.0% (0us) | Total: 0.0% (983us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `onNodeHTTPRequest`
`node:_http_server:586` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Calls:**
- `emit` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:24` | Self: 0.0% (0us) | Total: 0.0% (841us) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\scheduled-task\lease.ts:292` | Self: 0.0% (0us) | Total: 0.0% (960us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `fn` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1165` | Self: 0.0% (0us) | Total: 0.4% (59.2ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `get` (7)

### `compile`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:254` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `createRoutes` (1)

**Calls:**
- `replacementMapFrom` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\internal\logLevelLogger.js:19` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `emit`
`node:events:97` | Self: 0.0% (0us) | Total: 0.4% (62.4ms) | Samples: 0

**Called by:**
- `endReadableNT` (6)
- `emitCloseServer` (1)

**Calls:**
- `(anonymous)` (6)
- `(anonymous)` (1)

### `describeDefinition`
`C:\Users\slooshied\WebstormProjects\opencode\packages\codemode\src\tool-runtime.ts:449` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `toTypeScript` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@6.0.1\node_modules\entities\dist\commonjs\decode.js:9` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `isTitleRequest`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:86` | Self: 0.0% (0us) | Total: 0.4% (60.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `checkHits` (2)

**Calls:**
- `stringify` (4)

### `failCauseUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:641` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `finalize` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js:1328` | Self: 0.0% (0us) | Total: 0.2% (28.4ms) | Samples: 0

**Called by:**
- `optional` (1)
- `(module)` (1)

**Calls:**
- `make` (1)
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\Document.js:11` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `SQLiteEffectPreparedQuery`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:79` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `prepareQuery` (2)

**Calls:**
- `captureSqliteQuerySite` (1)
- `captureSqliteQuerySite` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:591` | Self: 0.0% (0us) | Total: 0.0% (951us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\generated\lowercase.js:263` | Self: 0.0% (0us) | Total: 0.3% (45.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts:3812` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `latest` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\oauth.js:28` | Self: 0.0% (0us) | Total: 0.0% (10.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `hostname` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts:300` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:11` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\configuration.js:50` | Self: 0.0% (0us) | Total: 0.4% (57.0ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:6` | Self: 0.0% (0us) | Total: 0.0% (922us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaRepresentation.js:523` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1117` | Self: 0.0% (0us) | Total: 8.1% (1.12s) | Samples: 0

**Called by:**
- `runLoop` (129)

**Calls:**
- `(anonymous)` (76)
- `(anonymous)` (31)
- `(anonymous)` (11)
- `withMapUnsafe` (7)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `withMapUnsafe` (1)

### `string`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:290` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `_string` (2)

### `set`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\update.ts:187` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `mapUpdateSet` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+template@7.29.7\node_modules\@babel\template\lib\parse.js:9` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `emitCloseServer`
`node:_http_server:88` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `markListenerGenerationClosed` (1)

**Calls:**
- `emit` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:588` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\web-push@3.6.7+3844822a191571ee\node_modules\web-push\src\vapid-helper.js:4` | Self: 0.0% (0us) | Total: 0.6% (93.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:19` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:265` | Self: 0.0% (0us) | Total: 1.9% (274.7ms) | Samples: 0

**Called by:**
- `getFrom` (10)
- `(anonymous)` (7)
- `(anonymous)` (3)
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

**Calls:**
- `_prepare` (36)
- `_prepare` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:691` | Self: 0.0% (0us) | Total: 0.7% (101.3ms) | Samples: 0

**Called by:**
- `bound ` (7)

**Calls:**
- `~effect/Utils/internal` (4)
- `(anonymous)` (3)

### `node:worker_threads`
`node:worker_threads:366` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `node:stream`
`node:stream:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:227` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `get` (1)

**Calls:**
- `prepareQuery` (1)

### `annotate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:14` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `modifyOwnPropertyDescriptors` (1)
- `annotate` (1)

### `Promise`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async walk` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\sql\Statement.js:669` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:489` | Self: 0.0% (0us) | Total: 0.0% (977us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getDefaultValue` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js:599` | Self: 0.0% (0us) | Total: 0.1% (15.0ms) | Samples: 0

**Called by:**
- `makeSpanUnsafe` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:418` | Self: 0.0% (0us) | Total: 0.4% (59.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\supports-color@8.1.1\node_modules\supports-color\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (13.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\braces@3.0.3\node_modules\braces\index.js:4` | Self: 0.0% (0us) | Total: 0.2% (29.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `optional`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\schema.ts:14` | Self: 0.0% (0us) | Total: 0.1% (16.2ms) | Samples: 0

**Called by:**
- `define` (1)
- `(module)` (1)

**Calls:**
- `make` (1)
- `(anonymous)` (1)

### `select`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:359` | Self: 0.0% (0us) | Total: 0.4% (60.2ms) | Samples: 0

**Called by:**
- `acceptable` (9)

**Calls:**
- `win` (9)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\lib\route.js:3` | Self: 0.0% (0us) | Total: 0.1% (17.5ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `processTicksAndRejections`
`[native code]` | Self: 0.0% (0us) | Total: 3.6% (505.7ms) | Samples: 0

**Calls:**
- `(anonymous)` (53)
- `endReadableNT` (6)
- `markListenerGenerationClosed` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\session-event.ts:573` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `define` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\index.js:7` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\index.js:4` | Self: 0.0% (0us) | Total: 0.4% (64.7ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `DefaultStreamTextResult`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6898` | Self: 0.0% (0us) | Total: 0.0% (973us) | Samples: 0

**Called by:**
- `streamText` (1)

**Calls:**
- `getBaseTelemetryAttributes` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:252` | Self: 0.0% (0us) | Total: 0.0% (12.7ms) | Samples: 0

**Calls:**
- `async scenario` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\hosted-git-info@9.0.3\node_modules\hosted-git-info\lib\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (948us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `reduce`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Called by:**
- `getBaseTelemetryAttributes` (1)
- `buildSelectQuery` (1)
- `replacementMapFrom` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1271` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `finalize`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js:1586` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `failCauseUnsafe` (1)

**Calls:**
- `(anonymous)` (1)

### `streamText`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs:6414` | Self: 0.0% (0us) | Total: 0.1% (16.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `DefaultStreamTextResult` (1)
- `DefaultStreamTextResult` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1.js:7` | Self: 0.0% (0us) | Total: 0.6% (93.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ioredis@5.11.0+3844822a191571ee\node_modules\ioredis\built\cluster\index.js:21` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `scopeForkUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` | Self: 0.0% (0us) | Total: 0.7% (101.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)
- `(anonymous)` (3)
- `mergeAllEffect` (1)

**Calls:**
- `scopeAddFinalizerUnsafe` (10)

### `~effect/Effect/evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js:320` | Self: 0.0% (0us) | Total: 0.1% (13.7ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `getCont` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:706` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts:148` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `internal:streams/compose`
`internal:streams/compose:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\ShardingConfig.js:112` | Self: 0.0% (0us) | Total: 0.0% (4.5ms) | Samples: 0

**Calls:**
- `all` (1)

### `undici`
`undici:2` | Self: 0.0% (0us) | Total: 2.0% (277.8ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\core.js:14` | Self: 0.0% (0us) | Total: 0.0% (12.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `ZodString` (1)
- `ZodDiscriminatedUnion` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\cross-spawn@7.0.6\node_modules\cross-spawn\lib\util\resolveCommand.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `_parse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:826` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `secureJsonParse` (1)

**Calls:**
- `parse` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\js-yaml@3.14.2\node_modules\js-yaml\lib\js-yaml\loader.js:9` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@parcel+watcher@2.5.1\node_modules\@parcel\watcher\wrapper.js:2` | Self: 0.0% (0us) | Total: 0.2% (32.9ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `ht`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js:1` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `ge` (1)

**Calls:**
- `Gt` (1)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2326` | Self: 0.0% (0us) | Total: 0.1% (16.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `filterDisablePropagation` (2)

### `transformOptional`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js:441` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `Getter` (1)

### `onSuccess`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpEffect.js:49` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\asn1.js@5.4.1\node_modules\asn1.js\lib\asn1\api.js:3` | Self: 0.0% (0us) | Total: 0.6% (92.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `observeYieldStatistic`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield-statistics.ts:214` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `map` (1)

### `evaluate`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\effect-core\query-effect.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `runLoop` (3)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1655` | Self: 0.0% (0us) | Total: 2.7% (374.6ms) | Samples: 0

**Called by:**
- `generatorResume` (63)

**Calls:**
- `go` (60)
- `go` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\files\index.js:73` | Self: 0.0% (0us) | Total: 0.4% (57.0ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2190` | Self: 0.0% (0us) | Total: 3.4% (472.3ms) | Samples: 0

**Called by:**
- `async (anonymous)` (52)
- `(anonymous)` (3)
- `async scenario` (1)

**Calls:**
- `(anonymous)` (56)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:745` | Self: 0.0% (0us) | Total: 0.3% (49.4ms) | Samples: 0

**Called by:**
- `go` (10)

**Calls:**
- `(anonymous)` (10)

### `makeFromTransport`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\route\client.ts:314` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `mergeRouteDefaults` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\namespace.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transformation\index.js:14` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\vscode-jsonrpc@8.2.1\node_modules\vscode-jsonrpc\node.js:7` | Self: 0.0% (0us) | Total: 0.2% (30.4ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\index.js:78` | Self: 0.0% (0us) | Total: 0.2% (32.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `compile`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts:269` | Self: 0.0% (0us) | Total: 0.2% (31.5ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `map` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts:994` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `pipeArguments` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js:8` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `recur` (1)

**Calls:**
- `resolve` (1)

### `validateType`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js:49` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `assertNodeType` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1869` | Self: 0.0% (0us) | Total: 0.1% (17.0ms) | Samples: 0

**Called by:**
- `runLoop` (4)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\index.js:69` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:108` | Self: 0.0% (0us) | Total: 0.2% (31.2ms) | Samples: 0

**Called by:**
- `runLoop` (3)

**Calls:**
- `query` (2)
- `query` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js:541` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:156` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `Info`
`[native code]` | Self: 0.0% (0us) | Total: 0.3% (44.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `out` (4)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:330` | Self: 0.0% (0us) | Total: 0.0% (979us) | Samples: 0

**Calls:**
- `fn` (1)

### `getFrom`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts:880` | Self: 0.0% (0us) | Total: 0.3% (52.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)
- `(anonymous)` (5)

**Calls:**
- `get` (10)
- `from` (1)
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\parser\index.js:4` | Self: 0.0% (0us) | Total: 0.1% (14.9ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `canParseHTMLNatively`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\turndown@7.2.0\node_modules\turndown\lib\turndown.cjs.js:573` | Self: 0.0% (0us) | Total: 0.1% (16.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(unknown)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+generator@7.29.7\node_modules\@babel\generator\lib\node\index.js:9` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\resolve@1.22.12\node_modules\resolve\index.js:1` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `runTasks`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Scheduler.js:150` | Self: 0.0% (0us) | Total: 20.1% (2.77s) | Samples: 0

**Called by:**
- `afterScheduled` (359)

**Calls:**
- `(anonymous)` (269)
- `evaluate` (87)
- `releaseTakers` (2)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-permit-tracker.ts:33` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `boundedSqlitePermit` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkijs@3.4.0\node_modules\pkijs\build\index.js:41` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `all`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:261` | Self: 0.0% (0us) | Total: 0.7% (107.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `currentTurnUploads` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `activeGrantEntries` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `_prepare` (14)
- `_prepare` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js:110` | Self: 0.0% (0us) | Total: 0.0% (929us) | Samples: 0

**Calls:**
- `fixedBase64` (1)

### `getCandidates`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1919` | Self: 0.0% (0us) | Total: 0.2% (29.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `filter` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts:172` | Self: 0.0% (0us) | Total: 0.0% (981us) | Samples: 0

**Calls:**
- `make` (1)

### `fiberAwaitAll`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:536` | Self: 0.0% (0us) | Total: 0.2% (31.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `callback` (5)

### `query`
`bun:sqlite:348` | Self: 0.0% (0us) | Total: 0.2% (31.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `[prepareOwned]` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\runtime.ts:409` | Self: 0.0% (0us) | Total: 0.0% (12.8ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `or` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:252` | Self: 0.0% (0us) | Total: 0.0% (962us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `hasLegacyConsumer` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js:195` | Self: 0.0% (0us) | Total: 0.3% (47.1ms) | Samples: 0

**Called by:**
- `runLoop` (7)

**Calls:**
- `(anonymous)` (2)
- `getImpl` (2)
- `_await` (1)
- `getImpl` (1)
- `interruptible` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-module-resolver@5.0.2\node_modules\babel-plugin-module-resolver\lib\normalizeOptions.js:11` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\core.js:22` | Self: 0.0% (0us) | Total: 0.2% (28.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `onItem`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1720` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Called by:**
- `go` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts:695` | Self: 0.0% (0us) | Total: 0.1% (15.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `triggerForEvent` (1)

### `run`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts:380` | Self: 0.0% (0us) | Total: 0.3% (44.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `runLoop` (2)

**Calls:**
- `prepareQuery` (3)
- `prepareQuery` (1)
- `prepareQuery` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:793` | Self: 0.0% (0us) | Total: 0.1% (16.6ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `currentTurnUploads` (2)

### `makeSpanUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:2350` | Self: 0.0% (0us) | Total: 0.1% (16.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `getReferenceUnsafe` (2)
- `(anonymous)` (1)

### `rebuild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1701` | Self: 0.0% (0us) | Total: 0.2% (29.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `Objects` (2)

### `activeGrantEntries`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\attachment.ts:870` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `all` (1)

### `sseDataJsonSchema`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js:171` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `StreamSse` (2)

**Calls:**
- `fromJsonString` (2)

### `modifyOwnPropertyDescriptors`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2300` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `annotate` (1)

**Calls:**
- `getOwnPropertyDescriptors` (1)

### `async AzureAuthPlugin`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\azure.ts:21` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Called by:**
- `~effect/Utils/internal` (4)

**Calls:**
- `which` (4)

### `exponential`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js:1454` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `make` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schedule.js:18` | Self: 0.0% (0us) | Total: 0.0% (887us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `toStepWithMetadata` (1)

### `withMapUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:847` | Self: 0.0% (0us) | Total: 0.2% (32.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\debug@4.4.3+3844822a191571ee\node_modules\debug\src\index.js:9` | Self: 0.0% (0us) | Total: 0.2% (30.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `ZodObject`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:44` | Self: 0.0% (0us) | Total: 0.1% (14.0ms) | Samples: 0

**Called by:**
- `clone` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js:110` | Self: 0.0% (0us) | Total: 0.1% (14.4ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `getPayload` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\transform-file.js:17` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js:603` | Self: 0.0% (0us) | Total: 0.0% (955us) | Samples: 0

**Calls:**
- `Literals` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts:214` | Self: 0.0% (0us) | Total: 0.3% (44.5ms) | Samples: 0

**Called by:**
- `generatorResume` (4)

**Calls:**
- `Info` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts:1150` | Self: 0.0% (0us) | Total: 0.2% (29.0ms) | Samples: 0

**Called by:**
- `generatorResume` (2)

**Calls:**
- `get` (2)

### `(anonymous)`
`[native code]` | Self: 0.0% (0us) | Total: 3.2% (443.3ms) | Samples: 0

**Called by:**
- `processTicksAndRejections` (53)

**Calls:**
- `async (anonymous)` (52)
- `(module)` (1)

### `memoMapReuse`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:16` | Self: 0.0% (0us) | Total: 0.2% (34.8ms) | Samples: 0

**Called by:**
- `get` (7)

**Calls:**
- `scopeAddFinalizerExit` (7)

### `findStaticMatchingChild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js:304` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `getNextNode` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1539` | Self: 0.0% (0us) | Total: 0.6% (89.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)
- `(anonymous)` (2)

**Calls:**
- `scopeClose` (8)

### `internal:fs/streams`
`internal:fs/streams:2` | Self: 0.0% (0us) | Total: 0.1% (16.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:6` | Self: 0.0% (0us) | Total: 1.0% (142.7ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\avvio@9.2.0\node_modules\avvio\boot.js:24` | Self: 0.0% (0us) | Total: 0.0% (10.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `withMapUnsafe`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js:846` | Self: 0.0% (0us) | Total: 8.1% (1.12s) | Samples: 0

**Called by:**
- `(anonymous)` (73)
- `(anonymous)` (54)
- `(anonymous)` (7)

**Calls:**
- `Map` (134)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpClient.js:648` | Self: 0.0% (0us) | Total: 2.8% (385.9ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `win`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\shell.ts:341` | Self: 0.0% (0us) | Total: 0.4% (60.2ms) | Samples: 0

**Called by:**
- `select` (9)

**Calls:**
- `which` (6)
- `gitbash` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1497` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpMiddleware.js:155` | Self: 0.0% (0us) | Total: 0.1% (15.8ms) | Samples: 0

**Called by:**
- `runTasks` (1)

**Calls:**
- `attribute` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\gray-matter@4.0.3\node_modules\gray-matter\lib\defaults.js:3` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\sha2.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `exit`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1432` | Self: 0.0% (0us) | Total: 0.4% (55.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `(anonymous)` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts:364` | Self: 0.0% (0us) | Total: 0.0% (10.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `get` (1)

### `on`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:534` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `recur` (1)

**Calls:**
- `recur` (1)

### `discriminatedUnion`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js:592` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodDiscriminatedUnion` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:28` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js:107` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Calls:**
- `immutableURLSetter` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\project.ts:15` | Self: 0.0% (0us) | Total: 0.0% (10.8ms) | Samples: 0

**Calls:**
- `optional` (1)

### `buildSelectQuery`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:153` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Called by:**
- `_prepare` (2)

**Calls:**
- `orderSelectedFields` (1)
- `reduce` (1)

### `async postJsonToApi`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2335` | Self: 0.0% (0us) | Total: 0.1% (14.8ms) | Samples: 0

**Called by:**
- `async doStream` (1)

**Calls:**
- `async postToApi` (1)

### `boundedSqlitePermit`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts:19` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:581` | Self: 0.0% (0us) | Total: 0.0% (971us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `touch` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\path-scurry@1.11.1\node_modules\path-scurry\dist\commonjs\index.js:36` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `effectImpl`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js:637` | Self: 0.0% (0us) | Total: 0.1% (23.6ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:165` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+crc32@5.2.0\node_modules\@aws-crypto\crc32\build\main\index.js:106` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\index.js:39` | Self: 0.0% (0us) | Total: 0.2% (27.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\account\account.ts:81` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `toMillis` (1)

### `async safeParseJSON`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs:2268` | Self: 0.0% (0us) | Total: 0.0% (903us) | Samples: 0

**Called by:**
- `async transform` (1)

**Calls:**
- `async safeParseJSON` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:1608` | Self: 0.0% (0us) | Total: 0.0% (884us) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:5` | Self: 0.0% (0us) | Total: 0.1% (15.4ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts:139` | Self: 0.0% (0us) | Total: 0.0% (945us) | Samples: 0

**Called by:**
- `~effect/Effect/evaluate` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+resources@2.6.1+460773ef8ff1e07c\node_modules\@opentelemetry\resources\build\src\index.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.6ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\locate-path@3.0.0\node_modules\locate-path\index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async dispose`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\app-runtime.ts:263` | Self: 0.0% (0us) | Total: 0.0% (866us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async (anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@smithy+util-utf8@2.3.0\node_modules\@smithy\util-utf8\dist-cjs\index.js:30` | Self: 0.0% (0us) | Total: 1.1% (153.6ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `recur`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:51` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\safe-regex2@5.1.1\node_modules\safe-regex2\index.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts:48` | Self: 0.0% (0us) | Total: 0.1% (13.8ms) | Samples: 0

**Calls:**
- `createLaceAISdkObserver` (1)

### `_array`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\api.js:712` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodArray` (1)

### `from`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:117` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `is` (1)

### `makeEffect`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js:69` | Self: 0.0% (0us) | Total: 0.1% (17.4ms) | Samples: 0

**Called by:**
- `make` (2)
- `makeOption` (1)

**Calls:**
- `run` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts:423` | Self: 0.0% (0us) | Total: 0.1% (23.0ms) | Samples: 0

**Called by:**
- `filter` (2)
- `generatorResume` (2)

**Calls:**
- `filter` (2)
- `evaluate` (1)
- `evaluate` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+plugin-transform-typescript@7.29.7+9b3a61428c0c4800\node_modules\@babel\plugin-transform-typescript\lib\index.js:13` | Self: 0.0% (0us) | Total: 0.1% (14.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8149` | Self: 0.0% (0us) | Total: 0.2% (33.4ms) | Samples: 0

**Called by:**
- `guarded` (7)

**Calls:**
- `(anonymous)` (7)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+crc32@5.2.0\node_modules\@aws-crypto\crc32\build\main\index.js:5` | Self: 0.0% (0us) | Total: 1.1% (154.7ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js:96` | Self: 0.0% (0us) | Total: 0.1% (19.8ms) | Samples: 0

**Called by:**
- `map` (5)

**Calls:**
- `escapeName` (5)

### `fromASTs`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:28` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `fromAST` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:1670` | Self: 0.0% (0us) | Total: 0.0% (12.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `go` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\validators\matchesPattern.js:7` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `checkHits`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:152` | Self: 0.0% (0us) | Total: 0.2% (31.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `stringify` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:7` | Self: 0.0% (0us) | Total: 0.0% (837us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\multicast-dns@7.2.5\node_modules\multicast-dns\index.js:3` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts:182` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `runLoop` (1)

**Calls:**
- `pipe` (1)

### `node:fs`
`node:fs:8` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `make`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js:33` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `define` (1)

**Calls:**
- `makeOption` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\index.ts:1781` | Self: 0.0% (0us) | Total: 0.0% (12.1ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `copyDataProperties` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\index-cjs.js:5` | Self: 0.0% (0us) | Total: 0.1% (24.5ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\section-matter@1.0.0\node_modules\section-matter\index.js:3` | Self: 0.0% (0us) | Total: 0.2% (31.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\index.js:32` | Self: 0.0% (0us) | Total: 1.0% (139.2ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\parse5@7.3.0\node_modules\parse5\dist\cjs\serializer\index.js:6` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+preset-typescript@7.27.1+9b3a61428c0c4800\node_modules\@babel\preset-typescript\lib\index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@9.3.5\node_modules\glob\dist\cjs\glob.js:5` | Self: 0.0% (0us) | Total: 0.1% (17.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `_debug`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\config-chain.js:17` | Self: 0.0% (0us) | Total: 0.2% (30.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1291` | Self: 0.0% (0us) | Total: 0.4% (59.1ms) | Samples: 0

**Called by:**
- `generatorResume` (7)

**Calls:**
- `run` (7)

### `emit`
`node:events:103` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `onNodeHTTPRequest` (1)

**Calls:**
- `handler` (1)

### `_fs`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\gensync-utils\fs.js:8` | Self: 0.0% (0us) | Total: 0.1% (19.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `bound require` (5)

### `_prepare`
`C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts:228` | Self: 0.0% (0us) | Total: 2.6% (364.9ms) | Samples: 0

**Called by:**
- `get` (36)
- `all` (14)

**Calls:**
- `(anonymous)` (28)
- `buildSelectQuery` (10)
- `buildSelectQuery` (5)
- `buildSelectQuery` (3)
- `buildSelectQuery` (2)
- `buildSelectQuery` (2)

### `mergeRouteDefaults`
`C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\route\client.ts:112` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Called by:**
- `makeFromTransport` (1)

**Calls:**
- `mergeGenerationOptions` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:279` | Self: 0.0% (0us) | Total: 0.0% (866us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `async dispose` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:734` | Self: 0.0% (0us) | Total: 0.1% (17.7ms) | Samples: 0

**Called by:**
- `generatorResume` (3)

**Calls:**
- `get` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1239` | Self: 0.0% (0us) | Total: 0.0% (949us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `rebuild`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js:2001` | Self: 0.0% (0us) | Total: 0.1% (16.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `mapOrSame` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@vercel+oidc@3.2.0\node_modules\@vercel\oidc\dist\token-util.js:46` | Self: 0.0% (0us) | Total: 0.9% (128.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `disabled`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\permission\index.ts:355` | Self: 0.0% (0us) | Total: 0.3% (44.5ms) | Samples: 0

**Called by:**
- `resolveTools` (5)

**Calls:**
- `filter` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\lib\mdns-server.js:7` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ajv@8.20.0\node_modules\ajv\dist\runtime\uri.js:3` | Self: 0.0% (0us) | Total: 0.2% (28.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\bonjour-service@1.3.0\node_modules\bonjour-service\dist\index.js:8` | Self: 0.0% (0us) | Total: 0.1% (14.1ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `guarded`
`internal:shared:112` | Self: 0.0% (0us) | Total: 8.0% (1.10s) | Samples: 0

**Calls:**
- `(anonymous)` (155)
- `(anonymous)` (7)
- `(anonymous)` (1)

### `normalizeWorkerDelegationModel`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\metadata-ownership.ts:155` | Self: 0.0% (0us) | Total: 0.3% (48.0ms) | Samples: 0

**Called by:**
- `workerDelegation` (6)

**Calls:**
- `(anonymous)` (6)

### `toJsonSchemaMultiDocument`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js:316` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `toJsonSchemaDocument` (1)

**Calls:**
- `map` (1)

### `init`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:22` | Self: 0.0% (0us) | Total: 0.7% (97.9ms) | Samples: 0

**Called by:**
- `ZodString` (3)
- `(anonymous)` (3)
- `ZodObject` (1)
- `(anonymous)` (1)
- `ZodLiteral` (1)
- `ZodNumber` (1)
- `(anonymous)` (1)
- `ZodArray` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@noble+hashes@1.4.0\node_modules\@noble\hashes\utils.js:11` | Self: 0.0% (0us) | Total: 0.2% (30.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `ExpansionLane`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\expansion-lane.ts:65` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `SpadDetector` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\config\full.js:18` | Self: 0.0% (0us) | Total: 0.0% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `get`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+core@7.28.0+9b3a61428c0c4800\node_modules\@babel\core\lib\index.js:167` | Self: 0.0% (0us) | Total: 0.5% (77.7ms) | Samples: 0

**Calls:**
- `_traverse` (9)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\builders\react\buildChildren.js:8` | Self: 0.0% (0us) | Total: 0.4% (59.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js:42` | Self: 0.0% (0us) | Total: 2.1% (293.0ms) | Samples: 0

**Calls:**
- `populateMaps` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\pkg-up@3.1.0\node_modules\pkg-up\index.js:2` | Self: 0.0% (0us) | Total: 0.0% (8.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\semver@7.8.5\node_modules\semver\index.js:20` | Self: 0.0% (0us) | Total: 0.0% (901us) | Samples: 0

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.gen.ts:242` | Self: 0.0% (0us) | Total: 0.0% (926us) | Samples: 0

**Calls:**
- `importModule` (1)

### `async scan`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\glob.ts:24` | Self: 0.0% (0us) | Total: 0.2% (28.0ms) | Samples: 0

**Called by:**
- `async load` (1)

**Calls:**
- `async Je` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+helper-create-class-features-plugin@7.29.7+9b3a61428c0c4800\node_modules\@babel\helper-create-class-features-plugin\lib\fields.js:13` | Self: 0.0% (0us) | Total: 0.0% (12.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:17` | Self: 0.0% (0us) | Total: 0.1% (13.9ms) | Samples: 0

**Calls:**
- `_string` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:579` | Self: 0.0% (0us) | Total: 0.8% (114.1ms) | Samples: 0

**Called by:**
- `makeEffect` (5)
- `(anonymous)` (3)
- `fromJsonString` (2)
- `(anonymous)` (2)
- `mapOrSame` (2)
- `(anonymous)` (1)
- `run` (1)

**Calls:**
- `(anonymous)` (6)
- `(anonymous)` (3)
- `rebuild` (2)
- `(anonymous)` (2)
- `flipEncoding` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `~effect/Utils/internal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js:89` | Self: 0.0% (0us) | Total: 0.7% (104.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)
- `(anonymous)` (4)

**Calls:**
- `async AzureAuthPlugin` (4)
- `async get` (3)
- `async GensparkAuthPlugin` (1)
- `async ClaudeAuthPlugin` (1)
- `async load` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\script\bench-session-concurrency.ts:285` | Self: 0.0% (0us) | Total: 0.1% (17.0ms) | Samples: 0

**Calls:**
- `rmSync` (3)

### `literal`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:1043` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodLiteral` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts:1547` | Self: 0.0% (0us) | Total: 0.0% (13.3ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `publishEvent` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@aws-crypto+util@5.2.0\node_modules\@aws-crypto\util\build\main\index.js:6` | Self: 0.0% (0us) | Total: 1.1% (153.6ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts:93` | Self: 0.0% (0us) | Total: 0.2% (30.5ms) | Samples: 0

**Called by:**
- `runLoop` (2)

**Calls:**
- `query` (1)
- `query` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\goal\index.ts:1700` | Self: 0.0% (0us) | Total: 0.0% (857us) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `from` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts:840` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `generatorResume` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\fastify@5.8.5\node_modules\fastify\fastify.js:44` | Self: 0.0% (0us) | Total: 0.1% (16.5ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\babel-plugin-jsx-dom-expressions@0.40.7+9b3a61428c0c4800\node_modules\babel-plugin-jsx-dom-expressions\index.js:3` | Self: 0.0% (0us) | Total: 0.1% (15.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `define`
`C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\event.ts:85` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `optional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\index.js:24` | Self: 0.0% (0us) | Total: 0.5% (77.7ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `readableAddChunkPushByteMode`
`internal:streams/readable:242` | Self: 0.0% (0us) | Total: 0.2% (30.2ms) | Samples: 0

**Called by:**
- `onDataIncomingMessage` (2)

**Calls:**
- `write` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js:78` | Self: 0.0% (0us) | Total: 1.2% (176.8ms) | Samples: 0

**Called by:**
- `~effect/Effect/successCont` (8)
- `(anonymous)` (7)
- `(anonymous)` (4)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `evaluate` (1)
- `provideServiceImpl` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (21)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(module)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\exchange\sqlite.ts:70` | Self: 0.0% (0us) | Total: 0.1% (15.2ms) | Samples: 0

**Calls:**
- `optional` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+semantic-conventions@1.41.1\node_modules\@opentelemetry\semantic-conventions\build\src\index.js:18` | Self: 0.0% (0us) | Total: 0.1% (14.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts:654` | Self: 0.0% (0us) | Total: 0.0% (850us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `get` (1)

### `ZodNumber`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.1% (16.1ms) | Samples: 0

**Called by:**
- `clone` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js:211` | Self: 0.0% (0us) | Total: 0.0% (920us) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `shouldDisableInsert` (1)

### `ZodString`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js:41` | Self: 0.0% (0us) | Total: 0.1% (16.7ms) | Samples: 0

**Called by:**
- `_string` (4)

**Calls:**
- `init` (3)
- `init` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js:259` | Self: 0.0% (0us) | Total: 0.1% (15.7ms) | Samples: 0

**Called by:**
- `init` (3)

**Calls:**
- `init` (3)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts:768` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `set` (2)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Effect.js:8151` | Self: 0.0% (0us) | Total: 8.1% (1.11s) | Samples: 0

**Called by:**
- `guarded` (121)
- `guarded` (1)

**Calls:**
- `(anonymous)` (122)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+traverse@7.29.7+3844822a191571ee\node_modules\@babel\traverse\lib\path\context.js:28` | Self: 0.0% (0us) | Total: 0.5% (77.7ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `getRef`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:370` | Self: 0.0% (0us) | Total: 0.1% (15.3ms) | Samples: 0

**Called by:**
- `setContext` (1)

**Calls:**
- `getReferenceUnsafe` (1)

### `(anonymous)`
`C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js:723` | Self: 0.0% (0us) | Total: 80.4% (11.05s) | Samples: 0

**Called by:**
- `(anonymous)` (249)
- `doneUnsafe` (217)
- `(anonymous)` (155)
- `(anonymous)` (122)
- `onExit` (100)
- `releaseTakers` (59)
- `evaluate` (53)
- `go` (9)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (4)
- `finalize` (1)
- `(anonymous)` (1)

**Calls:**
- `evaluate` (937)
- `evaluate` (411)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 45.9% | 6.32s | `[native code]` |
| 17.1% | 2.35s | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\effect.js` |
| 6.9% | 955.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\core.js` |
| 3.5% | 491.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\typescript@5.8.2\node_modules\typescript\lib\typescript.js` |
| 2.1% | 293.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\mime-types@3.0.2\node_modules\mime-types\index.js` |
| 2.0% | 284.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sql\sql.js` |
| 1.3% | 184.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaIssue.js` |
| 1.2% | 174.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\dialect.js` |
| 0.9% | 129.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaAST.js` |
| 0.9% | 129.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\html-entities@2.3.3\node_modules\html-entities\lib\named-references.js` |
| 0.8% | 110.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\event.ts` |
| 0.7% | 107.6ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Function.js` |
| 0.7% | 96.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Context.js` |
| 0.6% | 91.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\entity.js` |
| 0.6% | 88.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\session.ts` |
| 0.5% | 80.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Layer.js` |
| 0.5% | 79.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schema.js` |
| 0.5% | 78.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\prompt.ts` |
| 0.5% | 75.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Utils.js` |
| 0.4% | 61.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\provider.ts` |
| 0.4% | 60.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiEndpoint.js` |
| 0.4% | 60.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\util\wildcard.ts` |
| 0.3% | 48.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaParser.js` |
| 0.3% | 46.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\classic\schemas.js` |
| 0.3% | 44.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\ai@6.0.168+d6123d32214422cb\node_modules\ai\dist\index.mjs` |
| 0.3% | 44.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Channel.js` |
| 0.2% | 34.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\effect-sqlite\session.ts` |
| 0.2% | 32.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\effect\layer-node.ts` |
| 0.2% | 32.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\glob@13.0.5\node_modules\glob\dist\esm\index.min.js` |
| 0.2% | 30.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-busy.ts` |
| 0.2% | 30.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@ai-sdk+provider-utils@4.0.23+d6123d32214422cb\node_modules\@ai-sdk\provider-utils\dist\index.mjs` |
| 0.2% | 30.0ms | `bun:sqlite` |
| 0.2% | 29.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\identifier.ts` |
| 0.2% | 29.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\database.ts` |
| 0.2% | 28.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\schema.js` |
| 0.2% | 27.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\query-builders\select.js` |
| 0.1% | 19.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Config.js` |
| 0.1% | 18.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\internal\drizzle-utils.ts` |
| 0.1% | 18.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\delegated-worker.ts` |
| 0.1% | 17.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\projector.ts` |
| 0.1% | 17.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\config\config.ts` |
| 0.1% | 17.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\cluster\Envelope.js` |
| 0.1% | 16.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pipeable.js` |
| 0.1% | 16.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Brand.js` |
| 0.1% | 15.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm.ts` |
| 0.1% | 15.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Tracer.js` |
| 0.1% | 15.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\event-v2-bridge.ts` |
| 0.1% | 15.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\test\lib\llm-server.ts` |
| 0.1% | 15.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\message-v2.ts` |
| 0.1% | 15.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\representation.js` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Duration.js` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\utils\bedrock-media.ts` |
| 0.1% | 15.4ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\context\compiler.ts` |
| 0.1% | 15.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\checkpoint.ts` |
| 0.1% | 15.3ms | `internal:worker/messaging` |
| 0.1% | 15.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\definitions\utils.js` |
| 0.1% | 15.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\schema\annotations.js` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\Url.js` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\scheduled-task\executor.ts` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\stream-flush-deadline.ts` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\index.js` |
| 0.1% | 15.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@babel+types@7.29.7\node_modules\@babel\types\lib\clone\cloneNode.js` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\swarm\aggregate-recovery.ts` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Array.js` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\background-job.ts` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\subagent-supervision.ts` |
| 0.1% | 15.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\immer@11.1.4\node_modules\immer\dist\immer.mjs` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Order.js` |
| 0.1% | 15.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\schemas.js` |
| 0.1% | 14.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\symbols.ts` |
| 0.1% | 14.7ms | `internal:streams/duplex` |
| 0.1% | 14.5ms | `node:diagnostics_channel` |
| 0.1% | 14.5ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\share\share-next.ts` |
| 0.1% | 14.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\find-my-way-ts@0.1.6\node_modules\find-my-way-ts\dist\esm\internal\router.js` |
| 0.1% | 14.3ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SynchronizedRef.js` |
| 0.1% | 14.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\shell.ts` |
| 0.1% | 14.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\httpapi\HttpApiSchema.js` |
| 0.1% | 14.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\ai-sdk.ts` |
| 0.1% | 14.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\lsp\lsp.ts` |
| 0.1% | 14.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\profile.ts` |
| 0.1% | 14.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@opentelemetry+api@1.9.0\node_modules\@opentelemetry\api\build\src\diag\types.js` |
| 0.1% | 13.9ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\MutableHashMap.js` |
| 0.1% | 13.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\llm\lace-ai-sdk-observer.ts` |
| 0.0% | 13.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\schema.gen.ts` |
| 0.0% | 13.4ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@mixmark-io+domino@2.2.0\node_modules\@mixmark-io\domino\lib\htmlelts.js` |
| 0.0% | 13.3ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-acquire-timeout.ts` |
| 0.0% | 13.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\select.ts` |
| 0.0% | 13.2ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\instance-state.ts` |
| 0.0% | 13.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+server@2.0.0\node_modules\@modelcontextprotocol\server\dist\src-CX2iR2pK.mjs` |
| 0.0% | 12.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\effect-drizzle-sqlite\src\sqlite-core\effect\insert.ts` |
| 0.0% | 12.7ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\unstable\http\HttpPlatform.js` |
| 0.0% | 12.6ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\fork\credentials.ts` |
| 0.0% | 11.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\member-session.ts` |
| 0.0% | 11.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\index.ts` |
| 0.0% | 11.5ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\decode-data-html.js` |
| 0.0% | 9.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\classic\schemas.js` |
| 0.0% | 3.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\session.ts` |
| 0.0% | 3.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\provider\transform.ts` |
| 0.0% | 2.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.4.3\node_modules\zod\v4\core\core.js` |
| 0.0% | 2.7ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\skill\index.ts` |
| 0.0% | 2.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\processor.ts` |
| 0.0% | 2.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\telemetry.ts` |
| 0.0% | 1.9ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite.bun.ts` |
| 0.0% | 1.8ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\sqlite-diagnostics.ts` |
| 0.0% | 1.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Queue.js` |
| 0.0% | 1.8ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\htmlparser2@8.0.2\node_modules\htmlparser2\lib\esm\Parser.js` |
| 0.0% | 1.2ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\text.js` |
| 0.0% | 1.1ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\utils.js` |
| 0.0% | 1.1ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\spad\supervisor.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\@modelcontextprotocol+sdk@1.29.0+3844822a191571ee\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Pull.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\session\execution-owner.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\effect\config-service.ts` |
| 0.0% | 1.0ms | `node:_http_common` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration\20260908003500_event_compaction.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\routes\instance\httpapi\groups\directory-activity-fence.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Stream.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\fs-util.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\database\migration.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\schemas.js` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\usage\yield.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\ripgrep\binary.ts` |
| 0.0% | 1.0ms | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\SchemaGetter.js` |
| 0.0% | 996us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\tool\registry.ts` |
| 0.0% | 990us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\server\server.ts` |
| 0.0% | 985us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\retry.ts` |
| 0.0% | 979us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\sqlite-core\columns\common.js` |
| 0.0% | 969us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\schema.ts` |
| 0.0% | 966us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\plugin\genspark.ts` |
| 0.0% | 957us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\swarm\runtime-retention.ts` |
| 0.0% | 957us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\control-plane\workspace.ts` |
| 0.0% | 945us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\internal\option.js` |
| 0.0% | 929us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\zod@4.1.8\node_modules\zod\v4\core\regexes.js` |
| 0.0% | 920us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\drizzle-orm@1.0.0-rc.2+4c37402e66273d3e\node_modules\drizzle-orm\column.js` |
| 0.0% | 902us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\background\shell-job.ts` |
| 0.0% | 894us | `C:\Users\slooshied\WebstormProjects\opencode\packages\core\src\v1\session-turn-provenance.ts` |
| 0.0% | 893us | `C:\Users\slooshied\WebstormProjects\opencode\packages\opencode\src\session\system.ts` |
| 0.0% | 890us | `C:\Users\slooshied\WebstormProjects\opencode\packages\sdk\js\src\gen\client\utils.gen.ts` |
| 0.0% | 887us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\Schedule.js` |
| 0.0% | 882us | `C:\Users\slooshied\WebstormProjects\opencode\packages\llm\src\protocols\openai-responses.ts` |
| 0.0% | 880us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\entities@4.5.0\node_modules\entities\lib\esm\generated\encode-html.js` |
| 0.0% | 873us | `C:\Users\slooshied\WebstormProjects\opencode\packages\schema\src\ofxp.ts` |
| 0.0% | 865us | `C:\Users\slooshied\WebstormProjects\opencode\node_modules\.bun\effect@4.0.0-beta.83\node_modules\effect\dist\ScopedCache.js` |
