import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const cachePath = path.join(dir, ".cache", "models.dev.json")
const ttlMs = 6 * 60 * 60 * 1000

export const modelsData = await loadModelsData()
console.log("Loaded models.dev snapshot")

async function loadModelsData() {
  if (process.env.MODELS_DEV_API_JSON) return await Bun.file(process.env.MODELS_DEV_API_JSON).text()

  const cache = Bun.file(cachePath)
  const cached = (await cache.exists()) ? await cache.text() : undefined
  if (cached && Date.now() - cache.lastModified < ttlMs) return cached

  const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
  const remote = await fetch(`${modelsUrl}/api.json`).then(
    (res) => (res.ok ? res.text() : undefined),
    () => undefined,
  )
  if (remote) {
    await Bun.write(cachePath, remote)
    return remote
  }
  if (cached) return cached
  throw new Error("models.dev snapshot unavailable")
}
