import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"

const filename = process.argv[2]
if (!filename) throw new Error("database path required")

await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
