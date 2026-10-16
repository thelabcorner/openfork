type Sender = {
  id: number
  once(event: "destroyed", listener: () => void): unknown
  removeListener(event: "destroyed", listener: () => void): unknown
}

/** One renderer lifetime observer, regardless of concurrent control requests. */
export function createSidecarRequestLifetimes() {
  const owners = new Map<number, { sender: Sender; controllers: Set<AbortController>; destroy: () => void }>()
  return {
    retain(sender: Sender, controller: AbortController) {
      let owner = owners.get(sender.id)
      if (!owner) {
        const controllers = new Set<AbortController>()
        const destroy = () => {
          owners.delete(sender.id)
          // Drop ownership before abort callbacks can release requests.
          for (const active of controllers) active.abort()
          controllers.clear()
        }
        owner = { sender, controllers, destroy }
        owners.set(sender.id, owner)
        sender.once("destroyed", destroy)
      }
      owner.controllers.add(controller)
      const retained = owner
      return () => {
        retained.controllers.delete(controller)
        if (retained.controllers.size || owners.get(sender.id) !== retained) return
        sender.removeListener("destroyed", retained.destroy)
        owners.delete(sender.id)
      }
    },
    clear() {
      const active = [...owners.values()]
      owners.clear()
      for (const owner of active) {
        owner.sender.removeListener("destroyed", owner.destroy)
        for (const controller of owner.controllers) controller.abort()
        owner.controllers.clear()
      }
    },
  }
}
