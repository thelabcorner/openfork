import { pathKey } from "@/utils/path-key"
import type { HomeSessionRecord } from "./home-session-types"

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}
