# Native Swarm forced operations

Native Swarm supports deliberate one-operation force requests for the cases
where a member needs to act outside its ordinary role. The `force: true` input
is intent, not authority: the tool also requests the `swarm.force` permission
for the exact operation. The ordinary leaf permission is checked separately.

## Supported operations

- An active member can force a coordinator-only `swarm` action: `set_status`,
  `state`, `member.add`, `member.stop`, `member.resume`, `task.create`,
  `task.dependencies`, `recover.members`, `recover.effects`,
  `recover.contain`, `recover.session`, or `task.review`.
- Cross-Swarm `message.send` and replies can be forced by naming
  `sourceSwarmId` (the caller's actual member binding) and `swarmId` (the target
  Swarm). For a reply, `swarmId` is the original author's Swarm,
  `targetMemberId` is that author, and `responseTo` may point at the message in
  the other Swarm.

The `swarm.force` resource is action-scoped for coordinator operations and
source-to-target scoped for cross-Swarm messages. The interactive ask offers no
"always" grant for this call; an operator may still deliberately configure a
matching permission rule. The decision is reflected in tool metadata, and
forced authority is logged.

## Invariants that force does not change

- The caller must still be an active, Session-bound member. Forced messaging
  uses that member's real durable ID, Session ID, and binding generation.
- Source and target Swarms must both belong to the current project. There is no
  implicit guest registration, fake destination membership, or cross-project
  bridge.
- The action's normal leaf permission, input validation, lifecycle rules,
  transaction fences, task lease/review generations, recipient checks, and
  workspace boundaries remain in force. In particular, a worker cannot stop
  the recorded coordinator through `member.stop`.
- `admin.*` is a distinct operator recovery surface guarded by `swarm.admin`;
  `force` does not grant or replace it.
- Force is unavailable on actions that do not have a defined role/cross-Swarm
  exception. Passing it there fails before the permission ask.

This preserves the useful explicit opt-in from OpenSwarm without restoring its
boolean-only membership bypass. Cross-Swarm messages remain authored by their
real source member, and elevated actions remain visible as separately approved
decisions.
