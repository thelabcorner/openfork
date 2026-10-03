export const settingsWakaTimeDict = {
  "settings.wakatime.nav": "WakaTime",
  "settings.wakatime.title": "WakaTime",
  "settings.wakatime.badge": "Opt-in",
  "settings.wakatime.description":
    "Optionally send coding activity heartbeats for the files OpenFork reads and writes while it works in your projects.",
  "settings.wakatime.toggle.title": "Send coding activity to WakaTime",
  "settings.wakatime.toggle.description":
    "When enabled, OpenFork queues coding activity heartbeats for the WakaTime CLI to deliver to api.wakatime.com. Nothing is sent until WakaTime is also authenticated.",
  "settings.wakatime.privacy.title": "What is sent",
  "settings.wakatime.privacy.sent":
    "For queued coding activity, OpenFork supplies the file or entity path, whether it was a read or a write, the time it happened, the number of AI-generated line changes where it can verify that count, and the canonical project folder when it knows it. It also labels every delivery with an OpenFork-owned WakaTime plugin identity. Native activity is attributed to OpenFork, OXP-originated activity to OpenFork OXP, and OFXP-originated activity to OpenFork OFXP; a second stable token identifies the first-party OpenFork WakaTime integration, together with the OpenFork version. The OpenFork host carrying the activity, such as desktop versus CLI, is not sent as a separate WakaTime attribution dimension. Activity for the same file is combined only inside the same attribution boundary, and a batch of it can be delivered in a single WakaTime command. The WakaTime CLI can add coding metadata of its own: it reads the file and the repository around it, so depending on your WakaTime configuration a heartbeat can also carry the project name, branch, language, and dependencies.",
  "settings.wakatime.privacy.excluded":
    "OpenFork does not send your prompts, responses, tool output, or file contents, and it does not send the model you are using or OpenFork session references, source references, or replay references.",
  "settings.wakatime.privacy.credentials":
    "WakaTime authentication stays in WakaTime's own configuration: an API key in $WAKATIME_HOME/.wakatime.cfg when WAKATIME_HOME is set (otherwise ~/.wakatime.cfg), or the WAKATIME_API_KEY environment variable. OpenFork stores the opt-in, non-secret metadata about maintaining the WakaTime command line it manages for you, and short-lived SHA-256 project fingerprints with last-delivery timestamps so the one-minute heartbeat window survives a restart. It does not store raw project paths in that limiter state and never stores a WakaTime credential.",
  "settings.wakatime.configuration.title": "Configuration",
  "settings.wakatime.configuration.cli": "Command line",
  "settings.wakatime.configuration.cli.description": "The WakaTime CLI OpenFork will use for heartbeat delivery.",
  "settings.wakatime.configuration.cli.unresolved": "Command line not prepared",
  "settings.wakatime.action.prepareCli": "Prepare command line",
  "settings.wakatime.configuration.source": "Source",
  "settings.wakatime.configuration.source.description": "How the current WakaTime CLI was resolved.",
  "settings.wakatime.configuration.source.override": "OPENFORK_WAKATIME_CLI",
  "settings.wakatime.configuration.source.system": "Found on PATH",
  "settings.wakatime.configuration.source.managed": "Managed by OpenFork",
  "settings.wakatime.status.title": "Status",
  "settings.wakatime.status.disabled": "Disabled",
  "settings.wakatime.status.missingKey": "No API key found",
  "settings.wakatime.status.missingCli": "Command line not ready",
  "settings.wakatime.status.ready": "Ready",
  "settings.wakatime.status.missingKey.hint":
    "Set WAKATIME_API_KEY or add .wakatime.cfg under WAKATIME_HOME (otherwise ~/.wakatime.cfg), then reload.",
  "settings.wakatime.error.load": "Could not load WakaTime status",
  "settings.wakatime.error.save": "Could not update WakaTime settings",
  "settings.wakatime.error.unsupported.title": "WakaTime settings are not available on this server",
  "settings.wakatime.error.unsupported.local":
    "The OpenFork interface is newer than the active local backend. Restart OpenFork to activate WakaTime settings.",
  "settings.wakatime.error.unsupported.remote":
    "The connected server does not support WakaTime settings. Update or restart that server, then retry.",
  "settings.wakatime.error.notApplied":
    "The server did not apply the requested WakaTime setting. OPENFORK_WAKATIME may be forcing the effective state.",
  "settings.wakatime.action.restart": "Restart OpenFork",
  "settings.wakatime.toast.enabled": "WakaTime enabled",
  "settings.wakatime.toast.disabled": "WakaTime disabled",
} as const
