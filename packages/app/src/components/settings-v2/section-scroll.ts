import { createEffect, on, type Accessor } from "solid-js"

/**
 * Switching child sections changes the content of the same scrollable tab panel.
 * Reset its scroll position so a short section never opens below the old
 * section's scroll offset (a common source of apparently blank settings pages).
 */
export function useSettingsSectionScroll(section: Accessor<string | undefined>) {
  let anchor: HTMLElement | undefined
  createEffect(on(section, () => {
    const panel = anchor?.closest<HTMLElement>('[data-slot="tabs-v2-content"]')
    if (panel) panel.scrollTop = 0
  }, { defer: true }))
  return (element: HTMLElement) => { anchor = element }
}
