# HttpApi Route Patterns

## Ownership tier comes before route shape

Before adding, moving, or reusing an endpoint, classify it using the Tier 0-3
model in the repository-root `AGENTS.md`.

- Tier 0 process/global endpoints must not use `InstanceContextMiddleware` or
  otherwise call `InstanceStore.load()`.
- Tier 1 durable-location reads may require an explicit directory, but they must
  not initialize config/plugins/tools/LSP/VCS/snapshot merely to read durable
  metadata.
- Tier 2/3 workspace operations require an explicit location (or a location
  authoritatively derived from the addressed session/workspace). Missing
  location is an error, **not** permission to fall back to `process.cwd()`.
- Do not put a cheap endpoint behind heavy group middleware merely because it
  shares a noun with runtime-heavy siblings. Split groups/boundaries when their
  ownership tiers differ.
- Trace the whole middleware chain before declaring an endpoint cheap:
  `WorkspaceRoutingMiddleware -> InstanceContextMiddleware -> InstanceStore ->
  InstanceBootstrap` is semantically much larger than its HTTP payload suggests.
- For bootstrap-free reads, add a regression that records/probes instance loads
  and proves the count remains zero, including when directory/workspace query
  parameters are omitted.
- Prefer an upstream compact projection for live summary data over an endpoint
  that forces clients to fetch message history and reconstruct domain state.

### Route review checklist

Before placing an endpoint in `InstanceHttpApi`, adding
`InstanceContextMiddleware`, or reusing an existing instance-scoped route for a
new caller, write down:

1. the user-visible fact being requested;
2. the authoritative producer or durable table that already owns that fact;
3. the correct Tier 0/1/2/3 classification;
4. the exact middleware chain the request will cross;
5. whether missing location can reach `process.cwd()`;
6. whether the endpoint can be answered from a global/process service, durable
   session/project storage, or a compact projection instead of an Instance;
7. the negative test that proves the ownership boundary cannot regress.

Do not justify heavy middleware with a route-group noun. A `provider`, `session`,
`config`, or `project` group can contain both cheap durable reads and expensive
runtime actions. Split the boundary when ownership tiers differ.

Use `HttpApiBuilder.group(...)` for normal HTTP endpoints, including streaming HTTP responses such as server-sent events. Handlers should yield stable services once while building the handler layer, then close over those services in endpoint implementations.

```ts
export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("list", () => session.list())
  }),
)
```

For SSE endpoints, stay in `HttpApiBuilder.group(...)` and return `HttpServerResponse.stream(...)` from the handler. Annotate the endpoint success schema with `HttpApiSchema.asText({ contentType: "text/event-stream" })` so OpenAPI documents the stream content type.

Use `HttpApiBuilder.group(...)` with `handleRaw(...)` for declared endpoints that need the raw request or response, including WebSocket upgrade routes. This keeps endpoint middleware, routing context, and OpenAPI metadata on one typed route tree.

```ts
export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service

    return handlers.handleRaw("connect", (ctx) => connectPty(ctx.request, pty))
  }),
)
```

Use raw `HttpRouter.use(...)` only for routes outside the declared API surface, such as a catch-all UI fallback.

Avoid `Effect.provide(SomeLayer)` inside request handlers or raw route callbacks. Stable layers should be provided once at the application/layer boundary, not rebuilt or scoped per request.

Avoid `HttpRouter.provideRequest(...)` unless the dependency is intentionally request-level. Prefer `HttpRouter.use(...)` for stable app services.

Use `Effect.provideService(...)` in middleware only for request-derived context, such as `WorkspaceRouteContext`, `InstanceRef`, or `WorkspaceRef`. Do not use it to smuggle stable services through request effects when they can be yielded at layer construction.

Public JSON errors should be explicit `Schema.ErrorClass` contracts declared on each endpoint. Use built-in `HttpApiError.*` classes only when their empty/tagged body is the intended wire shape; for SDK-visible errors with messages, define an API error schema such as `ApiNotFoundError` and fail with that exact declared error. Keep domain and storage services free of HttpApi types, and translate expected domain errors at the handler boundary.

When adding middleware, declare endpoint-contract middleware on the owning `HttpApiGroup` and provide its implementation layer at the assembly boundary in `server.ts`. Keep router middleware for truly raw fallback routes or global transport policy.
