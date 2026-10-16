import { parentPort, workerData } from "node:worker_threads"

parentPort?.postMessage({ pong: true, tag: workerData?.tag ?? "none" })
