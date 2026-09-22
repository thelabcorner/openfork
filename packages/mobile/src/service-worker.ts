const UPDATE_READY_EVENT = "openfork:pwa-update-ready"

let registrationPromise: Promise<ServiceWorkerRegistration | undefined> | undefined
let waitingWorker: ServiceWorker | undefined
let hadController = false
let activationRequested = false

function announceUpdate(worker: ServiceWorker) {
  waitingWorker = worker
  window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT))
}

function watchRegistration(registration: ServiceWorkerRegistration) {
  const existing = registration.waiting
  if (existing && navigator.serviceWorker.controller) announceUpdate(existing)

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing
    if (!worker) return
    worker.addEventListener("statechange", () => {
      if (worker.state !== "installed") return
      // No controller means this is the first install, not an update.
      if (!navigator.serviceWorker.controller) return
      announceUpdate(worker)
    })
  })
}

export function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(undefined)
  if (registrationPromise) return registrationPromise

  hadController = navigator.serviceWorker.controller !== null
  registrationPromise = navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      watchRegistration(registration)
      return registration
    })
    .catch((error) => {
      registrationPromise = undefined
      console.warn("[openfork:mobile] service worker registration failed", error)
      return undefined
    })

  // If another tab promotes the staged worker, this client must reload as well:
  // continuing to execute an old lazy-module graph under a new controller is the
  // exact mixed-release state the generation caches are designed to prevent.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true
      return
    }
    location.reload()
  })

  return registrationPromise
}

export async function activatePwaUpdate() {
  const registration = await registerPwaServiceWorker()
  const worker = registration?.waiting ?? waitingWorker
  if (!worker || worker.state === "redundant") return false
  if (activationRequested) return true

  activationRequested = true
  worker.postMessage({ type: "SKIP_WAITING" })
  return true
}

export function onPwaUpdateReady(listener: () => void) {
  const handler = () => listener()
  window.addEventListener(UPDATE_READY_EVENT, handler)
  return () => window.removeEventListener(UPDATE_READY_EVENT, handler)
}
