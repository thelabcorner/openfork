import { DESKTOP_NATIVE_ENGLISH } from "./desktop-native"
import { eagerDict } from "./en-core"
import { desktopNetworkSettingsDict } from "./en-desktop-network-settings"
import { desktopShellDict } from "./en-desktop-shell"
import { oxpActivityDict } from "./en-oxp-activity"
import { projectExplorerDict } from "./en-project-explorer"
import { promptRevisionDict } from "./en-prompt-revision"
import { scheduledTasksDict } from "./en-scheduled-tasks"
import { sessionPermissionDict } from "./en-session-permissions"
import { settingsGeneralDict } from "./en-settings-general"
import { settingsShortcutsDict } from "./en-settings-shortcuts"
import { swarmDict } from "./en-swarm"

export { eagerDict } from "./en-core"

export const dict = { ...DESKTOP_NATIVE_ENGLISH, ...eagerDict, ...projectExplorerDict, ...promptRevisionDict, ...oxpActivityDict, ...scheduledTasksDict, ...sessionPermissionDict, ...settingsGeneralDict, ...settingsShortcutsDict, ...desktopNetworkSettingsDict, ...desktopShellDict, ...swarmDict } as const
