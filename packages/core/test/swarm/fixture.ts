import { Agent } from "@opencode-ai/schema/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Swarm } from "@opencode-ai/schema/swarm"

/** Minimal deterministic profile for storage/authority tests that never execute a provider. */
export const managedProfile = {
  agent: Agent.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile
