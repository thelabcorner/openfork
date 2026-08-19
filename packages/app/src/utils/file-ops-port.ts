// Client-side contract for filesystem MUTATION operations (write/delete/
// rename/mkdir). As of this writing, none of these are backed by a real
// server endpoint — the app can only read (`fs.read`/`fs.list`/`fs.find`).
// This module exists so the UI (project explorer tree, context menu, editor
// pane) can be built and wired completely today against a stable interface,
// with a default implementation that fails loudly and explains why, instead
// of the UI silently doing nothing or being left half-built.
//
// See AGENT_HANDOFF_file-explorer-backend.md at the repo root for the full
// backend implementation spec this interface is designed to be satisfied by.

export type FileOpsWriteResult = { hash: string }

export class FileOpsNotImplementedError extends Error {
  constructor(readonly operation: "write" | "delete" | "rename" | "mkdir") {
    super(
      `File operation "${operation}" has no backend yet — see AGENT_HANDOFF_file-explorer-backend.md at the repo root.`,
    )
    this.name = "FileOpsNotImplementedError"
  }
}

// Thrown by a real implementation when a write's `expectedHash` doesn't match
// the file's current on-disk hash (someone — likely the agent — wrote to it
// after this buffer's content was loaded). Not thrown by the stub below,
// since the stub never gets far enough to compare hashes; defined here so
// the editor pane's conflict-handling code has a concrete type to catch
// against once the real backend lands.
export class FileOpsConflictError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" changed on disk since it was last loaded here.`)
    this.name = "FileOpsConflictError"
  }
}

export interface FileOpsPort {
  /** Write full file content. `expectedHash`, when provided, must match the
   *  server's current content hash for the write to succeed (optimistic
   *  concurrency) — omit only for a brand-new file. */
  write(input: { path: string; content: string; expectedHash?: string }): Promise<FileOpsWriteResult>
  delete(input: { path: string }): Promise<void>
  rename(input: { from: string; to: string }): Promise<void>
  mkdir(input: { path: string; kind: "file" | "directory" }): Promise<void>
}

type FileOpsClient = {
  file: {
    write(input: { path: string; content: string; expectedHash?: string }): Promise<{ data?: FileOpsWriteResult }>
    delete(input: { path: string }): Promise<unknown>
    rename(input: { from: string; to: string }): Promise<unknown>
    mkdir(input: { path: string; kind: "file" | "directory" }): Promise<unknown>
  }
}

const reject = (operation: "write" | "delete" | "rename" | "mkdir") => () =>
  Promise.reject(new FileOpsNotImplementedError(operation))

export const notImplementedFileOpsPort: FileOpsPort = {
  write: reject("write"),
  delete: reject("delete"),
  rename: reject("rename"),
  mkdir: reject("mkdir"),
}

export function createFileOpsPort(client: FileOpsClient): FileOpsPort {
  return {
    async write(input) {
      try {
        const result = await client.file.write(input)
        if (!result.data) throw new Error("File write returned no data")
        return result.data
      } catch (error) {
        throw mapFileOpsError(error, input.path)
      }
    },
    async delete(input) {
      try {
        await client.file.delete(input)
      } catch (error) {
        throw mapFileOpsError(error, input.path)
      }
    },
    async rename(input) {
      try {
        await client.file.rename(input)
      } catch (error) {
        throw mapFileOpsError(error, input.from)
      }
    },
    async mkdir(input) {
      try {
        await client.file.mkdir(input)
      } catch (error) {
        throw mapFileOpsError(error, input.path)
      }
    },
  }
}

function mapFileOpsError(error: unknown, path: string) {
  const cause = error instanceof Error ? error.cause : undefined
  const body = cause && typeof cause === "object" && "body" in cause ? cause.body : undefined
  const data = body && typeof body === "object" && "data" in body ? body.data : undefined
  const code = data && typeof data === "object" && "code" in data ? data.code : undefined
  if (code === "conflict") return new FileOpsConflictError(path)
  return error
}
