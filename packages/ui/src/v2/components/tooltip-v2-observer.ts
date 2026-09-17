type TooltipExpandedSync = () => void

const observerOptions: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["aria-expanded", "data-expanded"],
}

type TooltipObserverRegistry = {
  observer: MutationObserver
  targets: Map<Element, TooltipExpandedSync>
  resetQueued: boolean
}

const registries = new WeakMap<Document, TooltipObserverRegistry>()

function mutationObserverFor(document: Document, callback: MutationCallback) {
  const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver
  return new Observer(callback)
}

function collectAffected(registry: TooltipObserverRegistry, records: MutationRecord[]) {
  const affected = new Set<TooltipExpandedSync>()
  for (const record of records) {
    let element = record.target instanceof Element ? record.target : record.target.parentElement
    while (element) {
      const sync = registry.targets.get(element)
      if (sync) affected.add(sync)
      element = element.parentElement
    }
  }
  return affected
}

function createRegistry(document: Document): TooltipObserverRegistry {
  const registry = {
    observer: undefined as unknown as MutationObserver,
    targets: new Map<Element, TooltipExpandedSync>(),
    resetQueued: false,
  }
  registry.observer = mutationObserverFor(document, (records) => {
    // MutationObserver already batches a microtask's records. Dedupe again by
    // tooltip root because nested TooltipV2 triggers can observe the same DOM
    // mutation through more than one registered subtree.
    for (const sync of collectAffected(registry, records)) sync()
  })
  registries.set(document, registry)
  return registry
}

function resetObservedTargets(document: Document, registry: TooltipObserverRegistry) {
  registry.resetQueued = false
  if (registries.get(document) !== registry) return
  registry.observer.disconnect()
  if (registry.targets.size === 0) {
    registries.delete(document)
    return
  }
  for (const target of registry.targets.keys()) registry.observer.observe(target, observerOptions)
}

function queueObservedTargetReset(document: Document, registry: TooltipObserverRegistry) {
  if (registry.resetQueued) return
  registry.resetQueued = true
  // Removed trigger roots are detached from the live document, so leaving
  // them observed for a short maintenance window is harmless. A timer is
  // intentionally better than a microtask here: Solid can mount/unmount many
  // tooltip rows across several consecutive microtasks during route/list
  // reconciliation. Coalesce that burst into one disconnect + reobserve pass.
  const schedule = document.defaultView?.setTimeout.bind(document.defaultView) ?? setTimeout
  schedule(() => resetObservedTargets(document, registry), 250)
}

/**
 * Observe TooltipV2 trigger subtrees without allocating one MutationObserver
 * per tooltip. A single observer instance can observe many independent roots;
 * this keeps the old semantics while dramatically shrinking observer/fan-out
 * overhead in dense lists.
 */
export function observeTooltipExpandedState(target: Element, sync: TooltipExpandedSync) {
  const document = target.ownerDocument
  const registry = registries.get(document) ?? createRegistry(document)
  registry.targets.set(target, sync)
  registry.observer.observe(target, observerOptions)

  let active = true
  return () => {
    if (!active) return
    active = false
    const current = registries.get(document)
    if (current !== registry) return
    registry.targets.delete(target)
    if (registry.targets.size === 0) {
      registry.observer.disconnect()
      registries.delete(document)
      return
    }
    // MutationObserver has disconnect(), but no unobserve(target). Rebuild the
    // observation set after a short coalescing window so route/list churn does
    // not repeatedly re-register the same stable targets.
    queueObservedTargetReset(document, registry)
  }
}
