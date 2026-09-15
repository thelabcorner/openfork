import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: string
  title: string
  sessions: HomeSessionRecord[]
  isUserGroup: boolean
  kind?: "user" | "subagent" | "plugin"
}

export type OpenSessionOptions = { background?: boolean }
