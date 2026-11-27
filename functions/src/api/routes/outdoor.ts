import type { ServerResponse } from "node:http";

import {
  findBestVentilationWindows,
  selectIndoorBaseline,
  type OutdoorReading,
} from "../../services/outdoor.js";
import { FORECAST_CACHE_TTL_MS, type DashboardResponseCache } from "../cache.js";
import { parseValidatedJsonBody, sendJson, sendMethodNotAllowed } from "../http.js";
import { updateSiteLocationConfigSchema } from "../schemas.js";
import type { DashboardDataService, IncomingApiRequest } from "../types.js";

export async function handleSiteConfigRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    actor: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
  }
): Promise<void> {
  const { pathname, method, actor, service, cache } = params;

  if (method === "GET") {
    const siteConfig = service.getSiteLocationConfig
      ? await service.getSiteLocationConfig()
      : null;
    sendJson(res, 200, {
      configured: Boolean(siteConfig),
      config: siteConfig,
    });
    return;
  }

  if (method === "PUT") {
    const body = await parseValidatedJsonBody(req, res, updateSiteLocationConfigSchema);
    if (!body) {
      return;
    }

    if (!service.updateSiteLocationConfig) {
      sendJson(res, 501, {
        error: "not_implemented",
        message: "Site location config storage is not enabled.",
      });
      return;
    }

    const saved = await service.updateSiteLocationConfig(body, actor);
    let syncResult: { synced: boolean; reason: string; reading: OutdoorReading | null } | null =
      null;
    if (service.syncOutdoorReadingIfStale) {
      try {
        syncResult = await service.syncOutdoorReadingIfStale({ force: true });
      } catch (syncErr) {
        console.error(
          "[outdoor] Immediate refresh after /api/site/config update failed:",
          syncErr instanceof Error ? syncErr.message : String(syncErr)
        );
      }
    }

    cache?.invalidate("overview");
    cache?.invalidate("forecast");
    cache?.invalidatePrefix("history:");
    sendJson(res, 200, {
      updated: true,
      config: saved,
      outdoor_sync: syncResult,
    });
    return;
  }

  sendMethodNotAllowed(res, method, pathname);
}

export async function handleOutdoorRefreshRoute(
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
  }
): Promise<void> {
  const { pathname, method, service, cache } = params;
  if (method !== "POST") {
    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  if (!service.syncOutdoorReadingIfStale) {
    sendJson(res, 501, {
      error: "not_implemented",
      message: "Outdoor refresh is not enabled.",
    });
    return;
  }

  const outcome = await service.syncOutdoorReadingIfStale({ force: true });
  if (!outcome.reading && outcome.reason === "site_location_not_configured") {
    sendJson(res, 400, {
      error: "site_location_not_configured",
      message: "Configure your Home Location first before refreshing outdoor weather.",
    });
    return;
  }

  cache?.invalidate("overview");
  cache?.invalidate("forecast");
  cache?.invalidatePrefix("history:");
  sendJson(res, 200, outcome);
}

export async function handleOutdoorForecastRoute(
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
    bypassCache?: boolean;
  }
): Promise<void> {
  const { pathname, method, service, cache, bypassCache } = params;
  if (method !== "GET") {
    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  const cacheKey = "forecast";
  if (cache && !bypassCache) {
    const cached = cache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
  }

  const [siteConfig, statusResult, forecastResult] = await Promise.all([
    service.getSiteLocationConfig ? service.getSiteLocationConfig() : Promise.resolve(null),
    service.getSensorStatus(),
    service.getLatestOutdoorForecast ? service.getLatestOutdoorForecast() : Promise.resolve(null),
  ]);

  const indoorBaseline = selectIndoorBaseline(statusResult.devices);

  if (!siteConfig || !forecastResult) {
    const emptyPayload = {
      configured: Boolean(siteConfig),
      forecast_fetched_at: forecastResult?.forecast.fetched_at ?? null,
      is_stale: forecastResult?.is_stale ?? true,
      indoor_baseline: indoorBaseline,
      next_best_window: null,
      lowest_tax_fallback_hour: null,
      windows: [],
      hours: [],
    };
    cache?.set(cacheKey, emptyPayload, FORECAST_CACHE_TTL_MS);
    sendJson(res, 200, emptyPayload);
    return;
  }

  const analysis = findBestVentilationWindows(indoorBaseline, forecastResult.forecast);
  const payload = {
    configured: true,
    forecast_fetched_at: forecastResult.forecast.fetched_at,
    is_stale: forecastResult.is_stale,
    indoor_baseline: indoorBaseline,
    next_best_window: analysis.next_best_window,
    lowest_tax_fallback_hour: analysis.lowest_tax_fallback_hour,
    windows: analysis.windows,
    hours: analysis.scored_hours,
  };
  cache?.set(cacheKey, payload, FORECAST_CACHE_TTL_MS);
  sendJson(res, 200, payload);
}
