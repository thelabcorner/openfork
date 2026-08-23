export type FreeDailyLimit = 50 | 1000;

export interface ModelPricing {
  prompt?: string | null;
  completion?: string | null;
  request?: string | null;
  internal_reasoning?: string | null;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
  [key: string]: string | null | undefined;
}

export interface ModelCatalogEntry {
  id: string;
  pricing?: ModelPricing;
}

export interface AnalyticsRow {
  model?: string | null;
  request_count?: number | string | null;
  tokens_prompt?: number | string | null;
  tokens_completion?: number | string | null;
  reasoning_tokens?: number | string | null;
  tokens_total?: number | string | null;
  [key: string]: unknown;
}

export interface FreeModelUsage {
  model: string;
  paidSibling: string | null;
  requests: number;
  tokens: {
    prompt: number;
    completion: number;
    reasoning: number;
    total: number;
  };
  value: {
    equivalentPaidValueUsd: number | null;
    pricingFound: boolean;
  };
}

export interface FreeUsageReport {
  free: {
    remaining: number;
    limit: FreeDailyLimit;
    remainingPercent: number;
    used: number;
    usedPercent: number;
    status: "healthy" | "draining" | "low" | "critical" | "terminal" | "depleted";
    tier: {
      source: "override" | "credits-api";
      totalCreditsPurchased: number | null;
    };
    tokens: {
      prompt: number;
      completion: number;
      reasoning: number;
      total: number;
    };
    value: {
      equivalentPaidValueUsd: number;
      valuedRequests: number;
      unvaluedRequests: number;
      methodology: "current-paid-sibling-list-price";
      cacheAware: false;
      note: string;
    };
    window: {
      type: "calendar-day";
      timezone: "UTC";
      startedAt: string;
      resetsAt: string;
      secondsUntilReset: number;
    };
    reset: {
      policy: "midnight-utc";
      confidence: "high";
      basis: string;
    };
    rate: {
      limitPerMinute: 20;
      observedRequestsPerMinute: number;
      source: "snapshot-delta" | "day-average" | "insufficient-data";
    };
    projection: {
      requestsPerHour: number;
      rateSource: "snapshot-delta" | "day-average" | "insufficient-data";
      sustainableRequestsPerHour: number;
      projectedRemainingAtReset: number;
      willExhaustBeforeReset: boolean;
      estimatedExhaustionAt: string | null;
    };
    models: FreeModelUsage[];
  };
  source: {
    mode: "openrouter-analytics";
    scope: "account";
    analyticsAsOf: string;
    fetchedAt: string;
    stale: boolean;
    analyticsRows: number;
    analyticsTruncated: boolean;
    upstreamCalls: number;
  };
}

export interface TrackerCache {
  get<T>(key: string): T | undefined | Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface TrackerOptions {
  managementKey: string;
  freeDailyLimit?: FreeDailyLimit;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  cache?: TrackerCache;
  cacheNamespace?: string;
  snapshotTtlMs?: number;
  tierTtlMs?: number;
  pricingTtlMs?: number;
  schemaTtlMs?: number;
  staleIfErrorMs?: number;
  requestTimeoutMs?: number;
  origin?: string;
}

export interface GetUsageOptions {
  forceRefresh?: boolean;
  includeValue?: boolean;
}

