const RELEASE = "__OPENFORK_PWA_RELEASE__"
const CACHE_PREFIX = "openfork-mobile-shared-runtime-"
const CACHE = `${CACHE_PREFIX}${RELEASE}`
const PRECACHE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/badge-96.png"]

async function precacheBootstrapShell() {
  const cache = await caches.open(CACHE)
  await cache.addAll(PRECACHE)

  // A newly installing worker does not control the document that registered it,
  // so the browser's initial JS/CSS requests may have bypassed our fetch handler.
  // Parse the built root shell and explicitly cache its content-addressed entry
  // assets. If any required shell asset fails, installation fails rather than
  // activating a worker that cannot actually cold-start offline.
  const shell = await cache.match("/")
  if (!shell) throw new Error("OpenFork PWA shell was not cached")
  const html = await shell.text()
  const assets = new Set()
  for (const match of html.matchAll(/\b(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g)) {
    assets.add(match[1])
  }
  if (assets.size > 0) await cache.addAll([...assets])
}

self.addEventListener("install", (event) => {
  // Do not skipWaiting on updates. The active client may still reference lazy
  // chunks from the previous release; swapping workers underneath it can create
  // a mixed-version graph. With no existing worker (first install), activation
  // proceeds normally. Updates stage until existing clients close.
  event.waitUntil(precacheBootstrapShell())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Never delete unrelated origin caches owned by other applications.
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SKIP_WAITING") return
  // Only an explicit client action promotes a staged release. The client waits
  // for controllerchange and reloads immediately, so no interactive old-release
  // window remains after the controller swap.
  event.waitUntil(self.skipWaiting())
})

// Declarative-Web-Push-compatible payload: `{ web_push: 8030, notification: {...} }`.
// This handler renders the exact same shape a supporting WebKit engine would
// render natively, so both paths produce an identical notification. Apple
// requires push to always produce a user-visible notification — never build
// this to be silent/invisible.
self.addEventListener("push", (event) => {
  let payload
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const notification = payload.notification ?? payload
  const title = notification.title ?? "OpenFork"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: notification.body,
      // Raster, not the SVG: Chromium's notification image decoder does not
      // handle image/svg+xml, so an SVG here renders as no icon at all on the
      // platform that receives most of these.
      icon: notification.icon ?? "/icon-192.png",
      badge: notification.badge ?? "/badge-96.png",
      tag: notification.tag,
      silent: notification.silent ?? false,
      timestamp: notification.timestamp,
      data: {
        navigate: notification.navigate ?? "/",
        ...notification.data,
      },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const candidate = new URL(event.notification.data?.navigate ?? "/", self.location.origin)
  // Notification payloads are server-originated, but navigation should still be
  // constrained to the installed PWA. Never turn a push click into an arbitrary
  // external-site launcher.
  const requested = candidate.origin === self.location.origin ? candidate : new URL("/", self.location.origin)
  // `/session/:id` is also an API route on same-origin deployments. Opening it
  // as a document can therefore return session JSON instead of the PWA shell.
  // Normalize notification session targets onto the root document and carry
  // only the session id in the query string. Warm and cold clicks now use the
  // exact same non-conflicting URL contract.
  const session = requested.pathname.match(/^\/session\/([^/]+)\/?$/)?.[1]
  const target = (() => {
    if (!session) return requested.href
    const app = new URL("/", self.location.origin)
    try {
      app.searchParams.set("session", decodeURIComponent(session))
    } catch {
      app.searchParams.set("session", session)
    }
    return app.href
  })()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of windows) {
        if ("focus" in client && new URL(client.url).origin === self.location.origin) {
          await client.focus()
          client.postMessage({ type: "PUSH_NAVIGATE", url: target })
          return
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== self.location.origin) return
  if (request.headers.has("authorization")) return
  const cacheableDestination = ["document", "script", "style", "font", "image", "manifest"].includes(request.destination)
  if (!cacheableDestination) return
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request)
      // Built assets are content-addressed by Vite; the two shared app fonts
      // are versioned by this SW cache namespace. Cache-first avoids a network
      // round trip for every JS/CSS/font request on installed-app relaunches.
      if (url.pathname.startsWith("/assets/") && cached) return cached

      // Documents/manifests stay network-first so a deployed shell update is
      // observed immediately. Canonical client routes are still the same SPA
      // shell, so an offline/dead-host navigation can fall back to the root
      // document pre-cached at install instead of failing on the route URL.
      const response = await fetch(request).catch(() => undefined)
      if (request.mode === "navigate" && (!response || !response.ok)) {
        const shell = await cache.match("/")
        if (shell) return shell
      }
      const cacheControl = response?.headers.get("cache-control") ?? ""
      if (response && response.ok && !/\b(?:no-store|private)\b/i.test(cacheControl)) {
        await cache.put(request, response.clone())
      }
      return response ?? cached ?? new Response("Offline", { status: 503 })
    }),
  )
})
