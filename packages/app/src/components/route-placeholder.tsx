/**
 * Zero-dependency Suspense placeholder for shell surfaces that preserve their
 * flex geometry while a lazy route/pane is loading. Keep this separate from
 * RouteLoadingFallback: the latter intentionally pulls query diagnostics and
 * richer UI that should never enter the synchronous desktop startup graph just
 * because a transparent placeholder is needed.
 */
export function RoutePlaceholder() {
  return <div class="flex-1 min-h-0 w-full" />
}
