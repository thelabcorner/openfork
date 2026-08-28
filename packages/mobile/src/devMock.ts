// Dev-only visual QA harness: loads when ?mock is in the URL (dev builds only).
// Renders the full connected UI with representative fake data so every view
// can be reviewed without a live OpenCode server.

export const mockEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has("mock")

type Raw = Record<string, unknown>
const session = (o: Raw) => o

const LARGE = (() => {
  try {
    const p = new URLSearchParams(location.search)
    if (!p.has("large")) return 0
    const v = p.get("large")
    if (!v || v === "1") return 1200
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 1200
  } catch { return 0 }
})()

const baseMockSessions: Raw[] = [
  session({
    id: "s1",
    slug: "s1",
    projectID: "proj-opencode",
    version: "v1",
    title: "Overhaul mobile PWA to match mockup",
    directory: "C:/dev/opencode",
    cost: 1.284,
    tokens: { input: 41200, output: 18300, reasoning: 5100, cache: { read: 610000, write: 24000 } },
    model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "high" },
    time: { created: Date.now() - 5_400_000, updated: Date.now() - 42_000 },
    summary: { additions: 1840, deletions: 920, files: 14 },
  }),
  session({
    id: "s2",
    slug: "s2",
    projectID: "proj-opencode",
    version: "v1",
    title: "Fix quota window aggregation for Go plan",
    directory: "C:/dev/opencode",
    cost: 0.312,
    tokens: { input: 12400, output: 6100, reasoning: 900, cache: { read: 180000, write: 8100 } },
    model: { id: "gpt-5.2-codex", providerID: "openai" },
    time: { created: Date.now() - 90_000_000, updated: Date.now() - 3_600_000 },
    summary: { additions: 210, deletions: 88, files: 3 },
  }),
  session({
    id: "s3",
    slug: "s3",
    projectID: "proj-bigfoot",
    version: "v1",
    title: "Regenerate Venmo & PayPal QR to match brand",
    directory: "C:/dev/bigfoot-sales",
    cost: 0,
    tokens: { input: 8100, output: 2100, reasoning: 0, cache: { read: 92000, write: 1200 } },
    model: { id: "muse-spark-1.2-free", providerID: "opencode" },
    time: { created: Date.now() - 200_000_000, updated: Date.now() - 26_000_000 },
  }),
  session({
    id: "s4",
    slug: "s4",
    projectID: "proj-homelab",
    version: "v1",
    title: "RAM running at correct MHz?",
    directory: "C:/dev/homelab",
    cost: 0.031,
    tokens: { input: 5100, output: 1900, reasoning: 300, cache: { read: 64000, write: 900 } },
    model: { id: "ox-alpha-free", providerID: "opencode" },
    time: { created: Date.now() - 400_000_000, updated: Date.now() - 260_000_000 },
  }),
]

const expandLarge = (base: Raw[], large: number): Raw[] => {
  if (!large || !mockEnabled) return base
  const projects = [
    { id: "proj-opencode", dir: "C:/dev/opencode", name: "opencode" },
    { id: "proj-bigfoot", dir: "C:/dev/bigfoot-sales", name: "bigfoot-sales" },
    { id: "proj-homelab", dir: "C:/dev/homelab", name: "homelab" },
    { id: "proj-obsidian", dir: "C:/dev/obsidian-vault", name: "obsidian-vault" },
    { id: "proj-acme", dir: "C:/work/acme-app", name: "acme-app" },
    { id: "proj-infra", dir: "C:/infra/terraform", name: "terraform" },
    { id: "proj-docs", dir: "C:/docs/site", name: "site" },
    { id: "proj-mobile", dir: "C:/dev/mobile-pwa", name: "mobile-pwa" },
  ]
  const titles = ["Refactor auth flow", "Fix pagination", "Optimize virtual list", "Update deps", "Review PR", "Investigate flake", "Add telemetry", "Polish empty state", "Fix haptics", "Migrate types"]
  const out = [...base]
  for (let i = base.length; i < large; i++) {
    const proj = projects[i % projects.length]!
    const t = titles[i % titles.length]!
    out.push(
      session({
        id: `s${i + 1}`,
        slug: `s${i + 1}`,
        projectID: proj.id,
        version: "v1",
        title: `${t} #${i + 1}`,
        directory: proj.dir,
        cost: Math.random() * 2,
        tokens: { input: 4000 + (i % 7) * 1200, output: 800 + (i % 5) * 400, reasoning: (i % 3) * 200, cache: { read: Math.floor(Math.random() * 600000), write: Math.floor(Math.random() * 20000) } },
        model: { id: i % 2 ? "claude-sonnet-4-5" : "gpt-5.2-codex", providerID: i % 2 ? "anthropic" : "openai" },
        time: { created: Date.now() - (i + 1) * 400_000, updated: Date.now() - i * 380_000 },
        summary: { additions: Math.floor(Math.random() * 200), deletions: Math.floor(Math.random() * 80), files: Math.floor(Math.random() * 8) },
      }),
    )
  }
  return out
}

export const mockSessions = expandLarge(baseMockSessions, LARGE) as unknown as import("@opencode-ai/sdk/v2/client").Session[]

export const mockArchived = expandLarge(
  [
    session({
      id: "a1",
      slug: "a1",
      projectID: "proj-opencode",
      version: "v1",
      title: "Migrate legacy pwa.html consumers",
      directory: "C:/dev/opencode",
      cost: 2.9,
      tokens: { input: 91000, output: 41000, reasoning: 12000, cache: { read: 890000, write: 31000 } },
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      time: { created: Date.now() - 900_000_000, updated: Date.now() - 800_000_000, archived: Date.now() - 700_000_000 },
    }),
  ],
  LARGE,
) as unknown as import("@opencode-ai/sdk/v2/client").Session[]

const assistant = (o: Raw) => o
const user = (o: Raw) => o
const text = (id: string, mid: string, t: string) => ({ id, sessionID: "s1", messageID: mid, type: "text", text: t })
const tool = (id: string, mid: string, name: string, title: string, status: "completed" | "running" | "error", extra: Raw = {}) => ({
  id,
  sessionID: "s1",
  messageID: mid,
  type: "tool",
  callID: id,
  tool: name,
  state: { status, input: {}, title, time: { start: Date.now() - 60_000, end: Date.now() - 58_000 }, ...extra },
})

export const mockMessages = [
  {
    info: user({
      id: "m1",
      sessionID: "s1",
      role: "user",
      time: { created: Date.now() - 300_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }),
    parts: [text("p1", "m1", "The session list still looks nothing like the mockup. Rebuild it with the rich rows: context meter, cache hit, cost, model chip, and the long-press menu.")] as any,
  },
  {
    info: assistant({
      id: "m2",
      sessionID: "s1",
      role: "assistant",
      parentID: "m1",
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "C:/dev/opencode", root: "C:/dev/opencode" },
      cost: 0.412,
      time: { created: Date.now() - 280_000, completed: Date.now() - 190_000 },
      tokens: { input: 41000, output: 5200, reasoning: 2100, cache: { read: 210000, write: 8100 } },
    }),
    parts: [
      { id: "r1", sessionID: "s1", messageID: "m2", type: "reasoning", text: "The user wants the session rows to mirror the desktop sidebar density: status, context bar, model, cost. I'll rebuild SessionRow against the real SDK token shape.", time: { start: Date.now() - 280_000, end: Date.now() - 260_000 } },
      text("p2", "m2", "Rebuilt the session list against the real v2 SDK. Each row now carries the live runtime status, a three-segment context meter, cache-hit percentage, session cost, and the active model with its reasoning variant."),
      tool("t1", "m2", "read", "packages/mobile/src/components/SessionRow.tsx", "completed"),
      tool("t2", "m2", "grep", "SessionMessagesResponses in sdk types", "completed"),
      tool("t3", "m2", "edit", "packages/mobile/src/components/SessionRow.tsx", "completed", { metadata: { additions: 96, deletions: 41 } }),
      tool("t4", "m2", "bash", "bun run --cwd packages/mobile typecheck", "completed"),
      text("p3", "m2", "Long-press (480ms) or right-click opens the same context menu as the desktop sidebar — archive and delete are wired to the real `session.update` / `session.delete` endpoints now, no more placeholders."),
    ] as any,
  },
  {
    info: user({
      id: "m3",
      sessionID: "s1",
      role: "user",
      time: { created: Date.now() - 120_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }),
    parts: [text("p4", "m3", "Good. Now stream the tokens with restrained haptics and keep the composer premium.")] as any,
  },
  {
    info: assistant({
      id: "m4",
      sessionID: "s1",
      role: "assistant",
      parentID: "m3",
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "C:/dev/opencode", root: "C:/dev/opencode" },
      cost: 0.084,
      time: { created: Date.now() - 100_000 },
      tokens: { input: 1200, output: 310, reasoning: 90, cache: { read: 41000, write: 300 } },
    }),
    parts: [
      { id: "st1", sessionID: "s1", messageID: "m4", type: "subtask", prompt: "Audit haptic usage", description: "Audit every haptic trigger for over/under-use", agent: "review" },
      text("p5", "m4", "Haptics now fire from the real `session.next.text.delta` SSE stream — every third delta, gated to 120ms, alternating soft/light so it reads as a heartbeat rather than a buzzer. Permission and question asks get a distinct warning tap."),
      tool("t5", "m4", "edit", "packages/mobile/src/app.tsx", "running"),
    ] as any,
  },
]

const mockModel = (id: string, name: string, ctx: number, costIn: number, costOut: number, caps: { reasoning?: boolean; image?: boolean } = {}): any => ({
  id,
  name,
  limit: { context: ctx, output: 8192 },
  cost: { input: costIn, output: costOut, cache: { read: costIn * 0.1, write: costIn * 1.25 } },
  capabilities: { reasoning: !!caps.reasoning, input: { image: !!caps.image }, tools: true },
  variants: undefined,
})

export const mockProviders = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "custom",
    key: "sk-ant",
    models: {
      "claude-sonnet-4-5": mockModel("claude-sonnet-4-5", "Claude Sonnet 4.5", 200000, 3, 15, { reasoning: true }),
      "claude-opus-4": mockModel("claude-opus-4", "Claude Opus 4", 200000, 15, 75, { reasoning: true, image: true }),
      "claude-haiku-3-5": mockModel("claude-haiku-3-5", "Claude Haiku 3.5", 200000, 0.8, 4),
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    source: "custom",
    key: "sk-",
    models: {
      "gpt-5.2-codex": mockModel("gpt-5.2-codex", "GPT 5.2 Codex", 128000, 2.5, 10),
      "gpt-4o": mockModel("gpt-4o", "GPT-4o", 128000, 2.5, 10, { image: true }),
      "o3-mini": mockModel("o3-mini", "o3-mini", 200000, 1.1, 4.4, { reasoning: true }),
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    source: "custom",
    key: "oc_",
    models: {
      "muse-spark-1.2": mockModel("muse-spark-1.2", "Muse Spark 1.2", 100000, 0, 0),
      "muse-spark-1.2-free": mockModel("muse-spark-1.2-free", "Muse Spark 1.2 Free", 100000, 0, 0),
      "ox-alpha-free": mockModel("ox-alpha-free", "Ox Alpha Free", 64000, 0, 0),
    },
  },
] as unknown as import("@opencode-ai/sdk/v2/client").Provider[]

const toWindows = (entries: Array<{ key: string; usedPercent: number; resetAfterSeconds: number; valueLabel?: string }>) =>
  Object.fromEntries(
    entries.map((e) => [
      e.key,
      {
        usedPercent: e.usedPercent,
        remainingPercent: 100 - e.usedPercent,
        windowSeconds: e.key === "5h" ? 18_000 : e.key === "week" ? 604_800 : 2_592_000,
        resetAt: e.resetAfterSeconds ? Date.now() + e.resetAfterSeconds * 1000 : null,
        resetAfterSeconds: e.resetAfterSeconds,
        valueLabel: e.valueLabel ?? null,
      },
    ]),
  )

export const mockQuota = [
  {
    result: {
      providerId: "opencode",
      providerName: "OpenCode Go",
      configured: true,
      ok: true,
      planLabel: "Go",
      usage: { windows: toWindows([
        { key: "5h", usedPercent: 92.4, resetAfterSeconds: 4620, valueLabel: "$18.40" },
        { key: "week", usedPercent: 61.2, resetAfterSeconds: 320_000, valueLabel: "$96.10" },
        { key: "month", usedPercent: 34.8, resetAfterSeconds: 1_500_000, valueLabel: "$212.44" },
      ]) },
      fetchedAt: Date.now(),
    },
    perKey: [
      { id: "k1", label: "Migrated key", active: false, windows: Object.entries(toWindows([{ key: "5h", usedPercent: 100, resetAfterSeconds: 17_800 }, { key: "week", usedPercent: 100, resetAfterSeconds: 320_000 }, { key: "month", usedPercent: 100, resetAfterSeconds: 2_400_000 }])) },
      { id: "k2", label: "key2", active: false, windows: Object.entries(toWindows([{ key: "5h", usedPercent: 100, resetAfterSeconds: 17_800 }, { key: "week", usedPercent: 100, resetAfterSeconds: 320_000 }, { key: "month", usedPercent: 1, resetAfterSeconds: 1_500_000 }])) },
      { id: "k3", label: "key3", active: true, windows: Object.entries(toWindows([{ key: "5h", usedPercent: 99, resetAfterSeconds: 4620 }, { key: "week", usedPercent: 96, resetAfterSeconds: 320_000 }, { key: "month", usedPercent: 88, resetAfterSeconds: 2_100_000 }])) },
    ],
  },
  {
    result: {
      providerId: "anthropic",
      providerName: "Anthropic",
      configured: true,
      ok: true,
      usage: { windows: toWindows([
        { key: "5h", usedPercent: 12.1, resetAfterSeconds: 9100, valueLabel: "412 prompts" },
        { key: "week", usedPercent: 88.6, resetAfterSeconds: 210_000, valueLabel: "2,904 prompts" },
      ]) },
      fetchedAt: Date.now(),
    },
  },
  {
    result: {
      providerId: "openai",
      providerName: "OpenAI",
      configured: true,
      ok: false,
      usage: null,
      fetchedAt: Date.now(),
    },
  },
] as import("./views/LimitsView").LimitsProviderData[]
