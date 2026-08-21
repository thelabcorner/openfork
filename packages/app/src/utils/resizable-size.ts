import { createStore, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export function clampSize(size: number, min: number, max: number) {
  return Math.min(max, Math.max(min, size))
}

export interface ResizableSizeConfig {
  min: number
  max: number
  default: number
}

/**
 * Persisted, clamped panel width/height. `field` is kept explicit (rather
 * than a fixed name) so the on-disk store key stays byte-identical to what
 * hand-rolled panel-state modules used before, avoiding a one-time reset of
 * everyone's saved panel sizes when a panel adopts this helper.
 */
export function createResizableSize<Field extends string>(
  persistKey: string,
  field: Field,
  config: ResizableSizeConfig,
) {
  const [store, setStore, , ready] = persisted(
    Persist.global(persistKey),
    createStore({ [field]: config.default } as Record<Field, number>),
  )
  const set = setStore as unknown as (key: Field, value: number) => void

  return {
    size: () => (store as Store<Record<Field, number>>)[field],
    ready,
    resize: (size: number) => set(field, clampSize(size, config.min, config.max)),
  }
}
