import type {
  SwarmBlackboardEntry,
  SwarmClaim,
  SwarmDeliverable,
  SwarmHttpApiDetail,
  SwarmHttpApiMessageHistoryEntry,
  SwarmMember,
  SwarmSummary,
  SwarmTask,
  SwarmTaskDependency,
  SwarmTaskRun,
} from "@opencode-ai/sdk/v2/client"

type Response<T> = Promise<{ readonly data?: T }>
type RequestOptions = { readonly throwOnError: true }

/**
 * Deliberately narrow client contract for the Swarm control panel.
 *
 * Session/message-history APIs are not part of this type. Rich panel state must
 * come from Swarm-owned projections; live member phase/model is overlaid
 * separately from SessionTelemetry.
 */
export type SwarmPanelApi = {
  detail(input: { swarmID: string }, options: RequestOptions): Response<SwarmHttpApiDetail>
  summary(input: { swarmID: string }, options: RequestOptions): Response<SwarmSummary>
  blackboard(
    input: { swarmID: string; limit?: string; cursor?: string },
    options: RequestOptions,
  ): Response<{ items: SwarmBlackboardEntry[]; more: boolean; nextCursor?: string }>
  claims(
    input: { swarmID: string; limit?: string; cursor?: string },
    options: RequestOptions,
  ): Response<{ items: SwarmClaim[]; more: boolean; nextCursor?: string }>
  deliverables(
    input: { swarmID: string; limit?: string; cursor?: string; memberID?: string },
    options: RequestOptions,
  ): Response<{ items: SwarmDeliverable[]; more: boolean; nextCursor?: string }>
  messages(
    input: { swarmID: string; limit?: string; cursor?: string },
    options: RequestOptions,
  ): Response<{ items: SwarmHttpApiMessageHistoryEntry[]; more: boolean; nextCursor?: string }>
  runs(
    input: { swarmID: string; limit?: string; cursor?: string; taskID?: string },
    options: RequestOptions,
  ): Response<{ items: SwarmTaskRun[]; more: boolean; nextCursor?: string }>
}

export function indexSwarmPanelDetail(detail: SwarmHttpApiDetail | undefined) {
  const memberByID = new Map<string, SwarmMember>()
  const taskByID = new Map<string, SwarmTask>()
  const dependenciesByTaskID = new Map<string, SwarmTaskDependency[]>()
  for (const member of detail?.members ?? []) memberByID.set(member.id, member)
  for (const task of detail?.tasks ?? []) taskByID.set(task.id, task)
  for (const dependency of detail?.dependencies ?? []) {
    const bucket = dependenciesByTaskID.get(dependency.taskID)
    if (bucket) bucket.push(dependency)
    else dependenciesByTaskID.set(dependency.taskID, [dependency])
  }
  return { memberByID, taskByID, dependenciesByTaskID }
}

export async function loadSwarmPanelCore(api: SwarmPanelApi, swarmID: string) {
  const [detailResponse, summaryResponse] = await Promise.all([
    api.detail({ swarmID }, { throwOnError: true }),
    api.summary({ swarmID }, { throwOnError: true }),
  ])
  if (!detailResponse.data || !summaryResponse.data) throw new Error("missing Swarm projection")
  return { detail: detailResponse.data, summary: summaryResponse.data }
}

export async function loadSwarmPanelMemory(
  api: SwarmPanelApi,
  input: {
    swarmID: string
    blackboardCursor?: string
    claimsCursor?: string
    deliverablesCursor?: string
  },
) {
  const [blackboard, claims, deliverables] = await Promise.all([
    api.blackboard(
      { swarmID: input.swarmID, limit: "50", ...(input.blackboardCursor ? { cursor: input.blackboardCursor } : {}) },
      { throwOnError: true },
    ),
    api.claims(
      { swarmID: input.swarmID, limit: "50", ...(input.claimsCursor ? { cursor: input.claimsCursor } : {}) },
      { throwOnError: true },
    ),
    api.deliverables(
      {
        swarmID: input.swarmID,
        limit: "50",
        ...(input.deliverablesCursor ? { cursor: input.deliverablesCursor } : {}),
      },
      { throwOnError: true },
    ),
  ])
  return {
    blackboard: blackboard.data ?? { items: [], more: false },
    claims: claims.data ?? { items: [], more: false },
    deliverables: deliverables.data ?? { items: [], more: false },
  }
}

export async function loadSwarmPanelBlackboardPage(api: SwarmPanelApi, swarmID: string, cursor: string) {
  const response = await api.blackboard({ swarmID, limit: "50", cursor }, { throwOnError: true })
  return response.data ?? { items: [], more: false }
}

export async function loadSwarmPanelClaimPage(api: SwarmPanelApi, swarmID: string, cursor: string) {
  const response = await api.claims({ swarmID, limit: "50", cursor }, { throwOnError: true })
  return response.data ?? { items: [], more: false }
}

export async function loadSwarmPanelDeliverablePage(api: SwarmPanelApi, swarmID: string, cursor: string) {
  const response = await api.deliverables({ swarmID, limit: "50", cursor }, { throwOnError: true })
  return response.data ?? { items: [], more: false }
}

export async function loadSwarmPanelHistory(
  api: SwarmPanelApi,
  input: { swarmID: string; messageCursor?: string; runCursor?: string },
) {
  const [messages, runs] = await Promise.all([
    api.messages(
      { swarmID: input.swarmID, limit: "50", ...(input.messageCursor ? { cursor: input.messageCursor } : {}) },
      { throwOnError: true },
    ),
    api.runs(
      { swarmID: input.swarmID, limit: "50", ...(input.runCursor ? { cursor: input.runCursor } : {}) },
      { throwOnError: true },
    ),
  ])
  return {
    messages: messages.data ?? { items: [], more: false },
    runs: runs.data ?? { items: [], more: false },
  }
}

export async function loadSwarmPanelMessagePage(api: SwarmPanelApi, swarmID: string, cursor: string) {
  const response = await api.messages({ swarmID, limit: "50", cursor }, { throwOnError: true })
  return response.data ?? { items: [], more: false }
}

export async function loadSwarmPanelRunPage(api: SwarmPanelApi, swarmID: string, cursor: string) {
  const response = await api.runs({ swarmID, limit: "50", cursor }, { throwOnError: true })
  return response.data ?? { items: [], more: false }
}
