/** Pure presentation invalidation classifier. Keep this independent of the
 * Solid JSX provider so it can be tested without a browser/runtime owner. */
export function eventInvalidatesSessionGroupNavigation(type: string) {
  return type === "swarm.created" || type === "swarm.updated" || type === "swarm.member.updated"
}