export const settingsSpecialAgentsDict = {
  "settings.specialAgents.nav": "Special agents",
  "settings.specialAgents.title": "Special agents",
  "settings.specialAgents.badge": "Runtime",
  "settings.specialAgents.description":
    "Configure the narrow agents OpenFork runs for title generation, prompt revision, verification, repetition review, and context compaction.",
  "settings.specialAgents.hero.eyebrow": "Host automation",
  "settings.specialAgents.hero.title": "Five focused agents around the main conversation",
  "settings.specialAgents.hero.description":
    "Each agent owns one bounded job. Their model and prompt controls live here so General stays about the application, not hidden runtime machinery.",
  "settings.specialAgents.role.naming": "Naming",
  "settings.specialAgents.role.preflight": "Preflight",
  "settings.specialAgents.role.verification": "Verification",
  "settings.specialAgents.role.guardrail": "Guardrail",
  "settings.specialAgents.role.context": "Context",
  "settings.specialAgents.titleGeneration.description":
    "Creates and regenerates concise session titles without involving the primary conversation agent.",
  "settings.specialAgents.promptRevision.description":
    "Rewrites a draft before send, with optional read-only project reconnaissance and composer automation.",
  "settings.specialAgents.goalAuditor.description":
    "Performs independent read-only verification after autonomous Goal work and returns a bounded audit verdict.",
  "settings.specialAgents.spadAuditor.description":
    "Reviews ambiguous SPAD repetition signals as a small veto-only quality gate before intervention.",
  "settings.specialAgents.compaction.description":
    "Compresses long conversation state using tiered model routing while preserving the continuation-critical facts.",
} as const
