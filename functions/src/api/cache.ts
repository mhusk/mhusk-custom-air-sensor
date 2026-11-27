export const OVERVIEW_CACHE_TTL_MS = 60_000;
export const HISTORY_CACHE_TTL_MS = 60_000;
export const RELEASES_CACHE_TTL_MS = 300_000;
export const FORECAST_CACHE_TTL_MS = 300_000;
export const EXPERIMENTS_CACHE_TTL_MS = 60_000;
export const PLAYBOOK_CACHE_TTL_MS = 300_000;
export const DEFAULT_DASHBOARD_CACHE_MAX_ENTRIES = 64;

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Bounded in-memory TTL cache for Dashboard API GET payloads inside a Cloud
 * Function instance. Warm hits avoid repeated Firestore reads while `?refresh=1`
 * and mutating routes invalidate affected keys immediately.
 */
export class DashboardResponseCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_DASHBOARD_CACHE_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string, nowMs: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (nowMs >= entry.expiresAtMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order for simple LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, nowMs: number = Date.now()): void {
    if (ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }

    // Prune expired entries before checking capacity.
    for (const [k, v] of this.entries.entries()) {
      if (nowMs >= v.expiresAtMs) {
        this.entries.delete(k);
      }
    }

    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else {
      while (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, {
      value,
      expiresAtMs: nowMs + ttlMs,
    });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
