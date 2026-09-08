export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { CHAT_PROJECT_ID } from "../project/chat"
import {
  chatSessionDirectoryKey,
  chatSessionDirectoryMutex,
  generateChatSessionDirectory,
  removeChatSessionDirectory,
} from "../project/chat-directory"
import { ProjectTable } from "../project/sql"
import { SessionV2 } from "../session"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionTable } from "../session/sql"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const sessions = yield* SessionStore.Service
    const database = yield* Database.Service
    const db = database.db

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const requestedDirectory = AbsolutePath.make(input.destination.directory)
      if (current.location.directory === requestedDirectory) return

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(requestedDirectory)
      const crossProject = current.projectID !== destination.id
      if (crossProject && input.moveChanges) {
        // Patches captured from one repository cannot be applied safely in
        // another: histories, roots, and worktrees differ. Re-associate
        // without transferring changes instead.
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }

      // The Chat project root is a routing/catalog identity, not a conversation
      // working directory. Moving a session to Chat gets the same isolated
      // scratch semantics as creating a new root Chat session. Existing managed
      // Chat scratch destinations are preserved verbatim for internal callers.
      const destinationIsChat = destination.id === ProjectV2.ID.make(CHAT_PROJECT_ID)
      const requestedChatKey = destinationIsChat
        ? chatSessionDirectoryKey(requestedDirectory, destination.directory)
        : undefined
      const allocatedDirectory =
        destinationIsChat && !requestedChatKey
          ? AbsolutePath.make(yield* Effect.promise(() => generateChatSessionDirectory(destination.directory)))
          : requestedDirectory
      const allocatedChatKey =
        destinationIsChat && !requestedChatKey
          ? chatSessionDirectoryKey(allocatedDirectory, destination.directory)
          : undefined
      let moveCommitted = false

      const cleanupAllocatedDestination = Effect.suspend(() => {
        if (!allocatedChatKey || moveCommitted) return Effect.void
        return chatSessionDirectoryMutex.withLock(allocatedChatKey)(
          Effect.gen(function* () {
            const referenced = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.directory, allocatedDirectory))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (referenced) return
            yield* Effect.promise(() => removeChatSessionDirectory(allocatedDirectory, destination.directory)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to reclaim uncommitted Chat move directory", {
                  directory: allocatedDirectory,
                  cause,
                }),
              ),
            )
          }),
        )
      })

      const directory = allocatedDirectory

      const moveChanges = input.moveChanges && source.directory !== destination.directory
      const sourceRepository = moveChanges ? yield* git.repo.discover(current.location.directory) : undefined
      if (moveChanges && !sourceRepository)
        return yield* new CaptureChangesError({ message: "Source is not a Git repository" })
      const patch = sourceRepository
        ? yield* git.change
            .capture({ repository: sourceRepository, path: current.location.directory })
            .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
        : Git.ChangeSet.make("")
      if (patch) {
        const repository = yield* git.repo.discover(directory)
        if (!repository) return yield* new ApplyChangesError({ message: "Destination is not a Git repository" })
        yield* git.change
          .apply({ repository, path: directory, changes: patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      // Event-level location metadata carries the NEW root so location-routed
      // consumers (instance SSE, plugin event hook) can observe re-roots;
      // without it the moved event only survives on the unfiltered server SSE.
      // Cross-project moves also carry the new project ID so the projector can
      // re-associate the session row; same-project moves omit it so historical
      // events keep projecting unchanged.
      if (crossProject) {
        yield* db
          .insert(ProjectTable)
          .values({ id: destination.id, worktree: destination.directory, vcs: destination.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
      const publishMove = events.publish(
        SessionEvent.Moved,
        {
          sessionID: input.sessionID,
          location: Location.Ref.make({ directory }),
          subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
          ...(crossProject ? { projectID: destination.id } : {}),
          timestamp: yield* DateTime.now,
        },
        { location: Location.Ref.make({ directory }) },
      )
      yield* (allocatedChatKey ? chatSessionDirectoryMutex.withLock(allocatedChatKey)(publishMove) : publishMove).pipe(
        Effect.tap(() => Effect.sync(() => (moveCommitted = true))),
        Effect.ensuring(cleanupAllocatedDestination),
      )

      // A session leaving Chat can make its old scratch directory unreachable.
      // Reclaim it only after the moved event has synchronously updated the
      // projection, and only when no fork/child/other session still references
      // that exact directory. The shared per-directory mutex closes the race
      // with concurrent Chat create/delete operations.
      if (source.id === ProjectV2.ID.make(CHAT_PROJECT_ID)) {
        const sourceKey = chatSessionDirectoryKey(current.location.directory, source.directory)
        if (sourceKey) {
          yield* chatSessionDirectoryMutex.withLock(sourceKey)(
            Effect.gen(function* () {
              const referenced = yield* db
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.directory, current.location.directory))
                .limit(1)
                .get()
                .pipe(Effect.orDie)
              if (referenced) return
              yield* Effect.promise(() => removeChatSessionDirectory(current.location.directory, source.directory)).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to reclaim moved Chat session directory", {
                    directory: current.location.directory,
                    cause,
                  }),
                ),
              )
            }),
          )
        }
      }

      if (patch) {
        const repository = yield* git.repo.discover(current.location.directory)
        if (!repository)
          return yield* new ResetSourceChangesError({
            directory: current.location.directory,
            message: "Source is not a Git repository",
          })
        yield* git.change
          .discard({
            repository,
            path: current.location.directory,
            index: "preserve",
            untracked: "remove",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ResetSourceChangesError({
                  directory: current.location.directory,
                  message: error.message,
                  cause: error.cause,
                }),
            ),
          )
      }
    })

    return Service.of({ moveSession })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, EventV2.node, ProjectV2.node, SessionStore.node, Database.node],
})
