type Input = {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
}

export const nextTabListScrollLeft = (input: Input) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

export const createFileTabListSync = (input: { el: HTMLDivElement }) => {
  let frame: number | undefined
  let prevScrollWidth = input.el.scrollWidth
  // The first observed burst is the list materializing (mount or session
  // restore), not a user-opened tab — prime the baseline instead of scrolling.
  let primed = false
  // Only a pure append (tab opened, nothing removed) reveals the new tab.
  // Session switches replace the whole child set and must not smooth-scroll.
  let appendOnly = false

  const update = () => {
    const scrollWidth = input.el.scrollWidth
    const clientWidth = input.el.clientWidth

    if (!primed || !appendOnly) {
      primed = true
      appendOnly = false
      prevScrollWidth = scrollWidth
      return
    }

    const left = nextTabListScrollLeft({
      prevScrollWidth,
      scrollWidth,
      clientWidth,
    })

    if (left !== undefined) {
      input.el.scrollTo({
        left,
        behavior: "smooth",
      })
    }

    prevScrollWidth = scrollWidth
  }

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver((records) => {
    let added = 0
    let removed = 0
    for (const record of records) {
      added += record.addedNodes.length
      removed += record.removedNodes.length
    }
    appendOnly = removed === 0 && added > 0
    schedule()
  })
  observer.observe(input.el, { childList: true })

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
