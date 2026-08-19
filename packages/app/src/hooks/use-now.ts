import { createSignal, onCleanup, type Accessor } from "solid-js"

// Single, app-global clock shared by every consumer. Exactly one timer exists
// for the whole page (never one-per-component), it is aligned to the wall-clock
// second boundary so countdown digits flip crisply and drift-free, and it only
// runs while at least one consumer is mounted (zero overhead otherwise).
const [now, setNow] = createSignal(Date.now(), { name: "globalNow" })
let timer: ReturnType<typeof setTimeout> | undefined
let subscribers = 0

function tick() {
  const t = Date.now()
  setNow(t)
  // Reschedule to the start of the next whole second -> no drift, crisp flip.
  timer = setTimeout(tick, 1000 - (t % 1000))
}

export function useNow(): Accessor<number> {
  if (subscribers === 0) tick()
  subscribers += 1
  onCleanup(() => {
    subscribers -= 1
    if (subscribers <= 0 && timer) {
      clearTimeout(timer)
      timer = undefined
    }
  })
  return now
}
