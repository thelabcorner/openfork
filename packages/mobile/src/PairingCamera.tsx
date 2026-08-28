import type { Component } from "solid-js"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import QrScanner from "qr-scanner"

interface PairingCameraProps {
  onPairCode: (code: string, serverUrl?: string) => void
  onError: (msg: string) => void
}

type PairingPayload = { code: string; serverUrl?: string }

export function parsePairingPayload(raw: string): PairingPayload | undefined {
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    const code = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair")
    if (code) {
      // The default QR is served by the API server itself, so its origin IS
      // the server base URL when no explicit ?server= rides along.
      const serverUrl =
        url.searchParams.get("server") ??
        (url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined)
      return { code: code.toUpperCase(), serverUrl }
    }
  } catch {
    // Not a URL — fall through to raw-code matching.
  }
  if (/^[A-Z0-9]{4,10}$/i.test(trimmed)) return { code: trimmed.toUpperCase() }
  return undefined
}

export const PairingCamera: Component<PairingCameraProps> = (props) => {
  let videoRef: HTMLVideoElement | undefined
  let scanner: QrScanner | undefined
  const [phase, setPhase] = createSignal<"starting" | "scanning" | "found" | "error">("starting")
  const [errorText, setErrorText] = createSignal("")

  onMount(async () => {
    if (!videoRef) return
    scanner = new QrScanner(
      videoRef,
      (result) => {
        const payload = parsePairingPayload(result.data)
        if (!payload || phase() === "found") return
        setPhase("found")
        scanner?.stop()
        props.onPairCode(payload.code, payload.serverUrl)
      },
      {
        returnDetailedScanResult: true,
        maxScansPerSecond: 10,
        preferredCamera: "environment",
        highlightScanRegion: false,
        highlightCodeOutline: false,
        onDecodeError: () => {
          // Fires continuously while no code is in frame — expected, not a failure.
        },
      },
    )
    try {
      await scanner.start()
      setPhase("scanning")
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : ""
      const msg =
        name === "NotAllowedError"
          ? "Camera access denied"
          : name === "NotFoundError"
            ? "No camera found on this device"
            : "Camera unavailable"
      setErrorText(msg)
      setPhase("error")
      props.onError(msg)
    }
  })

  onCleanup(() => {
    scanner?.stop()
    scanner?.destroy()
  })

  // The scanner stops once a code is found; the claim may still fail or hang
  // in the parent, so offer a manual path back to scanning.
  const resumeScan = async () => {
    if (phase() !== "found") return
    setPhase("scanning")
    try {
      await scanner?.start()
    } catch {
      setErrorText("Camera unavailable")
      setPhase("error")
      props.onError("Camera unavailable")
    }
  }

  return (
    <div class="scan-hero">
      <div class="scan-frame">
        <video ref={videoRef} playsinline muted class="scan-video" />
        <Show when={phase() === "scanning" || phase() === "found"}>
          <div class="scan-reticle">
            <span class="scan-corner tl" />
            <span class="scan-corner tr" />
            <span class="scan-corner bl" />
            <span class="scan-corner br" />
            <Show when={phase() === "scanning"}><div class="scan-line" /></Show>
          </div>
        </Show>
        <Show when={phase() === "found"}>
          <button type="button" class="scan-success" onClick={resumeScan} aria-label="Scan again">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <span class="scan-success-hint">Tap to scan again</span>
          </button>
        </Show>
        <Show when={phase() === "error"}>
          <div class="scan-error">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="7" width="18" height="13" rx="2" />
              <path d="M8 7 9.5 4h5L16 7" />
              <circle cx="12" cy="13.5" r="3.5" />
            </svg>
            <p>{errorText()}</p>
            <p class="scan-fallback-hint">Use "Enter code" instead, or open your phone's Camera app and point it at the pairing QR — it'll open this page and pair automatically.</p>
          </div>
        </Show>
      </div>
      <p class="scan-status">
        {phase() === "starting" && "Starting camera…"}
        {phase() === "scanning" && "Point the camera at the pairing QR"}
        {phase() === "found" && "Code recognized — connecting…"}
        {phase() === "error" && "Camera unavailable"}
      </p>
    </div>
  )
}
