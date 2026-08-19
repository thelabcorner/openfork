import { Portal } from "solid-js/web"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/icon"

export function FileSearchBar(props: {
  pos: () => { top: number; left?: number; right?: number }
  query: () => string
  index: () => number
  count: () => number
  setInput: (el: HTMLInputElement) => void
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  const i18n = useI18n()

  return (
    <Portal>
      <div
        class="session-find-bar"
        style={{
          top: `${props.pos().top}px`,
          ...(props.pos().left !== undefined ? { left: `${props.pos().left}px` } : { right: `${props.pos().right}px` }),
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Icon name="magnifying-glass" size="small" class="shrink-0 text-text-weak" />
        <input
          ref={props.setInput}
          placeholder={i18n.t("ui.fileSearch.placeholder")}
          value={props.query()}
          class="session-find-input"
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => props.onKeyDown(e as KeyboardEvent)}
        />
        <div class="session-find-count" classList={{ "session-find-count--active": props.count() > 0 }}>
          {props.count() > 0 ? `${props.index() + 1}/${props.count()}` : "0/0"}
        </div>
        <div class="session-find-nav">
          <button
            type="button"
            class="session-find-btn"
            disabled={props.count() === 0}
            aria-label={i18n.t("ui.fileSearch.previousMatch")}
            onClick={props.onPrev}
          >
            <Icon name="arrow-up" size="small" />
          </button>
          <button
            type="button"
            class="session-find-btn"
            disabled={props.count() === 0}
            aria-label={i18n.t("ui.fileSearch.nextMatch")}
            onClick={props.onNext}
          >
            <Icon name="chevron-down" size="small" />
          </button>
        </div>
        <div class="session-find-separator" />
        <button
          type="button"
          class="session-find-btn"
          aria-label={i18n.t("ui.fileSearch.close")}
          onClick={props.onClose}
        >
          <Icon name="close-small" size="small" />
        </button>
      </div>
    </Portal>
  )
}
