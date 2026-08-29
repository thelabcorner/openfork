import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  AUTO_SCROLL_ESCAPE_PX,
  AUTO_SCROLL_STICK_PX,
  classifyAutoScroll,
  isProgrammaticScroll,
} from "./auto-scroll-intent"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  // One-shot programmatic marker: consumed on the next scroll frame.
  let pendingProg: number | null = null
  let lastScrollTop = 0
  let stickRaf: number | undefined

  const stickThreshold = () => options.bottomThreshold ?? AUTO_SCROLL_STICK_PX
  const escapeThreshold = () => Math.max(AUTO_SCROLL_ESCAPE_PX, stickThreshold() * 2.4)

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  const markProg = (el: HTMLElement) => {
    pendingProg = Math.max(0, el.scrollHeight - el.clientHeight)
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = store.scrollRef
    if (!el) return
    markProg(el)
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    lastScrollTop = max
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    if (force && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!force && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markProg(el)
      lastScrollTop = el.scrollTop
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const scheduleStick = () => {
    if (stickRaf !== undefined) return
    stickRaf = requestAnimationFrame(() => {
      stickRaf = undefined
      const el = store.scrollRef
      if (!el) return
      if (!canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        return
      }
      if (!active() || store.userScrolled) return
      scrollToBottom(false)
    })
  }

  const stop = () => {
    if (stickRaf !== undefined) {
      cancelAnimationFrame(stickRaf)
      stickRaf = undefined
    }
    pendingProg = null

    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const isNestedScrollable = (target: EventTarget | null) => {
    const el = store.scrollRef
    const node = target instanceof Element ? target : undefined
    const nested = node?.closest("[data-scrollable]")
    return !!(el && nested && nested !== el)
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    if (isNestedScrollable(e.target)) return
    stop()
  }

  // Windows/Chrome middle-click autoscroll starts on button 1 and keeps
  // synthesizing scroll after mouseup from cursor offset. Escape on the
  // press, before the first tick can race a stick-to-bottom write.
  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 1) return
    if (isNestedScrollable(e.target)) return
    stop()
  }

  const onScrollInternal = () => {
    const el = store.scrollRef
    if (!el) return

    // Parent onScroll + this listener can both fire for one browser event.
    // Processing twice would see delta=0 on the second pass and re-stick.
    if (el.scrollTop === lastScrollTop && pendingProg === null) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      lastScrollTop = el.scrollTop
      pendingProg = null
      return
    }

    const dist = distanceFromBottom(el)
    const delta = el.scrollTop - lastScrollTop
    lastScrollTop = el.scrollTop

    const programmatic = isProgrammaticScroll({
      pendingTop: pendingProg,
      scrollTop: el.scrollTop,
      delta,
    })
    pendingProg = null

    const intent = classifyAutoScroll({
      distance: dist,
      delta,
      stickThreshold: stickThreshold(),
      escapeThreshold: escapeThreshold(),
      isProgrammatic: programmatic,
    })

    if (intent === "prog") {
      if (dist < stickThreshold() && store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (intent === "escape") {
      if (!store.userScrolled) {
        setStore("userScrolled", true)
        options.onUserInteracted?.()
      }
      return
    }

    if (intent === "stick") {
      if (store.userScrolled) setStore("userScrolled", false)
    }
  }

  const handleScroll = () => onScrollInternal()

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (el && !canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        return
      }
      if (!active()) return
      if (store.userScrolled) return
      // Coalesce rapid content growth (streaming) into one rAF stick so we
      // don't fight a concurrent user scroll that happened this frame.
      scheduleStick()
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEffect(() => {
    const el = store.scrollRef
    if (!el) return
    lastScrollTop = el.scrollTop
    const handler = () => onScrollInternal()
    el.addEventListener("scroll", handler, { passive: true })
    onCleanup(() => el.removeEventListener("scroll", handler))
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })
  createEventListener(() => store.scrollRef, "pointerdown", handlePointerDown, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (stickRaf !== undefined) cancelAnimationFrame(stickRaf)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (el) lastScrollTop = el.scrollTop
      setStore("scrollRef", el)
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
