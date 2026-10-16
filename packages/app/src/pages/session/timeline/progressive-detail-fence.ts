export type ProgressiveDetailTicket = Readonly<{
  identity: string
  generation: number
}>

/** Prevents late page requests from committing after close, row reuse, or unmount. */
export function createProgressiveDetailFence() {
  let identity: string | undefined
  let generation = 0
  let opened = false

  const changeIdentity = (next: string) => {
    if (identity === next) return false
    identity = next
    generation++
    opened = false
    return true
  }

  const ticket = (): ProgressiveDetailTicket | undefined =>
    identity === undefined ? undefined : { identity, generation }

  return {
    changeIdentity,
    open(next: string) {
      changeIdentity(next)
      opened = true
      return ticket()
    },
    close() {
      opened = false
      generation++
    },
    current(value: ProgressiveDetailTicket) {
      return opened && value.generation === generation && value.identity === identity
    },
    ticket,
  }
}
