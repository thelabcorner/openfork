import type { TrackerCache } from "./types";

interface Entry { value: unknown; expiresAt: number }

export class MemoryCache implements TrackerCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + Math.max(0, ttlMs) });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export class SingleFlight {
  private readonly flights = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing as Promise<T>;
    const promise = task().finally(() => this.flights.delete(key));
    this.flights.set(key, promise);
    return promise;
  }
}

