import type { AnalyticsRow, ModelCatalogEntry } from "./types";

export const DEFAULT_ORIGIN = "https://openrouter.ai";
export const ANALYTICS_METRICS = ["request_count", "tokens_prompt", "tokens_completion", "reasoning_tokens", "tokens_total"] as const;
export const ANALYTICS_DIMENSIONS = ["model", "variant"] as const;

export interface AnalyticsResult {
  rows: AnalyticsRow[];
  metadata: { queryTimeMs: number | null; rowCount: number; truncated: boolean };
}

export interface AnalyticsMeta {
  metrics: Set<string>;
  dimensions: Set<string>;
}

export class OpenRouterReadClient {
  private readonly key: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly origin: string;
  private readonly timeoutMs: number;
  calls = 0;

  constructor(args: { managementKey: string; fetchImpl: typeof globalThis.fetch; origin?: string; timeoutMs: number }) {
    this.key = args.managementKey;
    this.fetchImpl = args.fetchImpl;
    this.origin = (args.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    this.timeoutMs = args.timeoutMs;
  }

  resetCallCounter(): void { this.calls = 0; }

  async credits(): Promise<{ totalCredits: number; totalUsage: number }> {
    const payload = await this.request("/api/v1/credits") as { data?: { total_credits?: unknown; total_usage?: unknown } };
    return {
      totalCredits: finite(payload.data?.total_credits),
      totalUsage: finite(payload.data?.total_usage),
    };
  }

  async modelCatalog(): Promise<ModelCatalogEntry[]> {
    const payload = await this.request("/api/v1/models?limit=1000&output_modalities=all") as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];
    return payload.data.filter((entry): entry is ModelCatalogEntry => Boolean(entry) && typeof entry === "object" && typeof (entry as ModelCatalogEntry).id === "string");
  }

  async analytics(
    start: Date,
    end: Date,
    metrics: readonly string[] = ANALYTICS_METRICS,
    dimensions: readonly string[] = ANALYTICS_DIMENSIONS,
  ): Promise<AnalyticsResult> {
    const payload = await this.request("/api/v1/analytics/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metrics,
        dimensions,
        time_range: { start: start.toISOString(), end: end.toISOString() },
        limit: 1000,
      }),
    }) as {
      data?: { data?: unknown; metadata?: { query_time_ms?: unknown; row_count?: unknown; truncated?: unknown } };
    };
    const rows = Array.isArray(payload.data?.data) ? payload.data.data.filter((row): row is AnalyticsRow => Boolean(row) && typeof row === "object") : [];
    const metadata = payload.data?.metadata;
    return {
      rows,
      metadata: {
        queryTimeMs: metadata?.query_time_ms == null ? null : finite(metadata.query_time_ms),
        rowCount: Math.floor(finite(metadata?.row_count ?? rows.length)),
        truncated: metadata?.truncated === true,
      },
    };
  }

  async analyticsMeta(): Promise<AnalyticsMeta> {
    const payload = await this.request("/api/v1/analytics/meta") as {
      data?: { metrics?: Array<{ name?: unknown }>; dimensions?: Array<{ name?: unknown }> };
    };
    return {
      metrics: new Set((payload.data?.metrics ?? []).map((item) => item.name).filter((name): name is string => typeof name === "string")),
      dimensions: new Set((payload.data?.dimensions ?? []).map((item) => item.name).filter((name): name is string => typeof name === "string")),
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    this.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.key}`);
      const response = await this.fetchImpl(`${this.origin}${path}`, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (!response.ok) throw new OpenRouterError(response.status, path, payload);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OpenRouterError extends Error {
  constructor(public readonly status: number, public readonly path: string, public readonly payload: unknown) {
    super(`OpenRouter ${path} returned ${status}`);
    this.name = "OpenRouterError";
  }
}

function finite(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

