import { parentPort } from "node:worker_threads"

parentPort?.postMessage({ pong: true, pid: process.pid })
