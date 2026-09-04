const CACHE = "opencode-mobile-shell-v5"

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
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
  const title = notification.title ?? "opencode"
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
  const target = new URL(event.notification.data?.navigate ?? "/", self.location.origin).href
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
      const response = await fetch(request).catch(() => cached)
      const cacheControl = response?.headers.get("cache-control") ?? ""
      if (response && response.ok && !/\b(?:no-store|private)\b/i.test(cacheControl)) {
        await cache.put(request, response.clone())
      }
      return response ?? new Response("Offline", { status: 503 })
    }),
  )
})
