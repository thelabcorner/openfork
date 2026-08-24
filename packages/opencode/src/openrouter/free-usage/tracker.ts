import { MemoryCache, SingleFlight } from "./cache";
import {
  catalogPricingMap,
  computeBurnRate,
  computeProjection,
  dailyLimitForPurchasedCredits,
  nextUtcMidnight,
  normalizeAnalyticsRow,
  quotaStatus,
  remainingPercent,
  utcDayStart,
  valueAggregate,
  type BurnSample,
} from "./core";
import { ANALYTICS_DIMENSIONS, ANALYTICS_METRICS, OpenRouterError, OpenRouterReadClient } from "./openrouter";
import type { FreeDailyLimit, FreeUsageReport, GetUsageOptions, ModelCatalogEntry, TrackerCache, TrackerOptions } from "./types";

const DEFAULT_SNAPSHOT_TTL = 15_000;
const DEFAULT_TIER_TTL = 6 * 60 * 60_000;
const DEFAULT_PRICING_TTL = 6 * 60 * 60_000;
const DEFAULT_SCHEMA_TTL = 24 * 60 * 60_000;
const DEFAULT_STALE_IF_ERROR = 5 * 60_000;
const DEFAULT_TIMEOUT = 10_000;

interface CachedReport { report: FreeUsageReport; atMs: number }
interface TierState { limit: FreeDailyLimit; source: "override" | "credits-api"; totalCreditsPurchased: number | null }
interface AnalyticsSchema { metrics: string[]; dimensions: string[] }

export class OpenRouterFreeUsageTracker {
  private readonly options: Required<Pick<TrackerOptions, "snapshotTtlMs" | "tierTtlMs" | "pricingTtlMs" | "schemaTtlMs" | "staleIfErrorMs" | "requestTimeoutMs">> & TrackerOptions;
  private readonly cache: TrackerCache;
  private readonly flights = new SingleFlight();
  private readonly client: OpenRouterReadClient;
  private readonly samples: BurnSample[] = [];
  private lastReport: CachedReport | null = null;

  constructor(options: TrackerOptions) {
    if (!options.managementKey) throw new Error("managementKey is required; OpenRouter analytics requires a Management key");
    if (options.freeDailyLimit !== undefined && options.freeDailyLimit !== 50 && options.freeDailyLimit !== 1000) throw new Error("freeDailyLimit must be 50 or 1000");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch implementation is required");
    this.options = {
      ...options,
      snapshotTtlMs: options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL,
      tierTtlMs: options.tierTtlMs ?? DEFAULT_TIER_TTL,
      pricingTtlMs: options.pricingTtlMs ?? DEFAULT_PRICING_TTL,
      schemaTtlMs: options.schemaTtlMs ?? DEFAULT_SCHEMA_TTL,
      staleIfErrorMs: options.staleIfErrorMs ?? DEFAULT_STALE_IF_ERROR,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT,
    };
    const nowFn = options.now ?? (() => new Date());
    this.cache = options.cache ?? new MemoryCache(() => nowFn().getTime());
    this.client = new OpenRouterReadClient({
      managementKey: options.managementKey,
      fetchImpl,
      ...(options.origin ? { origin: options.origin } : {}),
      timeoutMs: this.options.requestTimeoutMs,
    });
  }

  async getUsage(request: GetUsageOptions = {}): Promise<FreeUsageReport> {
    const now = (this.options.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    const includeValue = request.includeValue !== false;
    const snapshotKey = this.key(`report:${utcDayStart(now).toISOString()}:value=${includeValue ? 1 : 0}`);

    if (!request.forceRefresh) {
      const cached = await this.cache.get<FreeUsageReport>(snapshotKey);
      if (cached) return cached;
    }

    try {
      return await this.flights.run(snapshotKey, () => this.refresh(now, includeValue, snapshotKey, request.forceRefresh === true));
    } catch (error) {
      if (this.lastReport && nowMs - this.lastReport.atMs <= this.options.staleIfErrorMs) {
        return { ...this.lastReport.report, source: { ...this.lastReport.report.source, stale: true } };
      }
      throw error;
    }
  }

  private async refresh(now: Date, includeValue: boolean, snapshotKey: string, forceRefresh: boolean): Promise<FreeUsageReport> {
    this.client.resetCallCounter();
    const nowMs = now.getTime();
    const dayStart = utcDayStart(now);
    const resetAt = nextUtcMidnight(now);
    const secondsUntilReset = Math.max(0, Math.floor((resetAt.getTime() - nowMs) / 1000));

    const [analytics, tier] = await Promise.all([
      this.resolveAnalytics(dayStart, now, forceRefresh),
      this.resolveTier(),
    ]);

    const models = analytics.rows.map(normalizeAnalyticsRow).filter((row): row is NonNullable<typeof row> => row !== null);
    const used = models.reduce((sum, model) => sum + model.requests, 0);
    const prompt = models.reduce((sum, model) => sum + model.tokens.prompt, 0);
    const completion = models.reduce((sum, model) => sum + model.tokens.completion, 0);
    const reasoning = models.reduce((sum, model) => sum + model.tokens.reasoning, 0);
    const total = models.reduce((sum, model) => sum + model.tokens.total, 0);

    let equivalentPaidValueUsd = 0;
    let valuedRequests = 0;
    let unvaluedRequests = used;
    if (includeValue && used > 0) {
      const catalog = await this.resolveCatalog();
      const pricing = catalogPricingMap(catalog);
      valuedRequests = 0;
      unvaluedRequests = 0;
      for (const model of models) {
        const modelPricing = model.paidSibling ? pricing.get(model.paidSibling) : undefined;
        const value = modelPricing ? valueAggregate(model, modelPricing) : null;
        if (value === null) {
          unvaluedRequests += model.requests;
        } else {
          model.value = { equivalentPaidValueUsd: value, pricingFound: true };
          equivalentPaidValueUsd += value;
          valuedRequests += model.requests;
        }
      }
    }

    const remaining = Math.max(0, tier.limit - used);
    const percent = remainingPercent(remaining, tier.limit);
    const burn = computeBurnRate(this.samples, used, nowMs, dayStart.getTime());
    const projection = computeProjection({ remaining, secondsUntilReset, requestsPerHour: burn.requestsPerHour, rateSource: burn.source, nowMs });
    this.recordSample({ atMs: nowMs, used, dayStartMs: dayStart.getTime() });

    const report: FreeUsageReport = {
      free: {
        remaining,
        limit: tier.limit,
        remainingPercent: percent,
        used,
        usedPercent: 100 - percent,
        status: quotaStatus(percent),
        tier: { source: tier.source, totalCreditsPurchased: tier.totalCreditsPurchased },
        tokens: { prompt, completion, reasoning, total },
        value: {
          equivalentPaidValueUsd,
          valuedRequests,
          unvaluedRequests,
          methodology: "current-paid-sibling-list-price",
          cacheAware: false,
          note: "Analytics exposes aggregate prompt/completion/reasoning token totals but not exact cached-token totals in the stable query recipe; valuation therefore uses current paid-sibling list prices without assuming a cache discount.",
        },
        window: {
          type: "calendar-day",
          timezone: "UTC",
          startedAt: dayStart.toISOString(),
          resetsAt: resetAt.toISOString(),
          secondsUntilReset,
        },
        reset: {
          policy: "midnight-utc",
          confidence: "high",
          basis: "OpenRouter daily-limit semantics and observed community behavior; the tracker queries the current UTC calendar day.",
        },
        rate: { limitPerMinute: 20, observedRequestsPerMinute: burn.requestsPerMinute, source: burn.source },
        projection,
        models,
      },
      source: {
        mode: "openrouter-analytics",
        scope: "account",
        analyticsAsOf: now.toISOString(),
        fetchedAt: now.toISOString(),
        stale: false,
        analyticsRows: analytics.metadata.rowCount,
        analyticsTruncated: analytics.metadata.truncated,
        upstreamCalls: this.client.calls,
      },
    };

    await this.cache.set(snapshotKey, report, this.options.snapshotTtlMs);
    this.lastReport = { report, atMs: nowMs };
    return report;
  }

  private async resolveAnalytics(start: Date, end: Date, forceRefresh: boolean) {
    const key = this.key(`analytics:${start.toISOString()}`);
    if (!forceRefresh) {
      const cached = await this.cache.get<Awaited<ReturnType<OpenRouterReadClient["analytics"]>>>(key);
      if (cached) return cached;
    }
    return this.flights.run(key, async () => {
      if (!forceRefresh) {
        const second = await this.cache.get<Awaited<ReturnType<OpenRouterReadClient["analytics"]>>>(key);
        if (second) return second;
      }
      const analytics = await this.analyticsWithSchemaFallback(start, end);
      await this.cache.set(key, analytics, this.options.snapshotTtlMs);
      return analytics;
    });
  }

  private async analyticsWithSchemaFallback(start: Date, end: Date) {
    const schemaKey = this.key("analytics-metrics");
    const cachedSchema = await this.cache.get<AnalyticsSchema>(schemaKey);
    if (cachedSchema) return this.client.analytics(start, end, cachedSchema.metrics, cachedSchema.dimensions);
    try {
      return await this.client.analytics(start, end, ANALYTICS_METRICS);
    } catch (error) {
      if (!(error instanceof OpenRouterError) || error.status !== 400) throw error;
      const meta = await this.flights.run(this.key("analytics-meta"), () => this.client.analyticsMeta());
      if (!meta.dimensions.has("model") || !meta.metrics.has("request_count")) throw new Error("OpenRouter analytics schema no longer exposes model + request_count");
      const metrics = ANALYTICS_METRICS.filter((metric) => meta.metrics.has(metric));
      const dimensions = meta.dimensions.has("variant") ? [...ANALYTICS_DIMENSIONS] : ["model"];
      await this.cache.set(schemaKey, { metrics: [...metrics], dimensions }, this.options.schemaTtlMs);
      return this.client.analytics(start, end, metrics, dimensions);
    }
  }

  private async resolveTier(): Promise<TierState> {
    if (this.options.freeDailyLimit) return { limit: this.options.freeDailyLimit, source: "override", totalCreditsPurchased: null };
    const key = this.key("tier");
    const cached = await this.cache.get<TierState>(key);
    if (cached) return cached;
    return this.flights.run(key, async () => {
      const second = await this.cache.get<TierState>(key);
      if (second) return second;
      const credits = await this.client.credits();
      const state: TierState = { limit: dailyLimitForPurchasedCredits(credits.totalCredits), source: "credits-api", totalCreditsPurchased: credits.totalCredits };
      await this.cache.set(key, state, this.options.tierTtlMs);
      return state;
    });
  }

  private async resolveCatalog(): Promise<ModelCatalogEntry[]> {
    const key = this.key("model-catalog");
    const cached = await this.cache.get<ModelCatalogEntry[]>(key);
    if (cached) return cached;
    return this.flights.run(key, async () => {
      const second = await this.cache.get<ModelCatalogEntry[]>(key);
      if (second) return second;
      const catalog = await this.client.modelCatalog();
      await this.cache.set(key, catalog, this.options.pricingTtlMs);
      return catalog;
    });
  }

  private recordSample(sample: BurnSample): void {
    this.samples.push(sample);
    const cutoff = sample.atMs - 60 * 60_000;
    while (this.samples.length > 8 || (this.samples[0]?.atMs ?? sample.atMs) < cutoff) this.samples.shift();
  }

  private key(suffix: string): string {
    return `${this.options.cacheNamespace ?? "default"}:${suffix}`;
  }
}

export function createOpenRouterFreeUsageTracker(options: TrackerOptions): OpenRouterFreeUsageTracker {
  return new OpenRouterFreeUsageTracker(options);
}

