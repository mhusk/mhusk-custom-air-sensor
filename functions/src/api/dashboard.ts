import type { ServerResponse } from "node:http";

import type { Firestore } from "firebase-admin/firestore";

import {
  authenticateMcpRequest,
  buildWwwAuthenticateHeader,
} from "../auth/workos.js";
import {
  getAirQualitySummary,
  getDb,
  getDeviceConfig,
  getFirmwareRelease,
  getLatestReading,
  getReadingsHistory,
  getReadingsHistoryWithSummary,
  getSensorStatus,
  listDeviceConfigs,
  listFirmwareReleases,
  requestDeviceReboot,
  setDeviceTargetFirmwareVersion,
  updateDeviceConfig,
} from "../services/firestore.js";
import {
  getLatestOutdoorForecast,
  getLatestOutdoorReading,
  getOutdoorReadingsHistory,
  getSiteLocationConfig,
  syncOutdoorReadingIfStale,
  updateSiteLocationConfig,
} from "../services/outdoor.js";
import { BodyReadError, parseQueryParams, sendJson } from "./http.js";
import { handleMeRoute, handlePublicAuthRoutes, resolveActorLabel } from "./routes/auth.js";
import { handleDeviceActionRoute, matchDeviceConfigRoute } from "./routes/devices.js";
import { handleFirmwareReleasesRoute, handleFirmwareRolloutRoute } from "./routes/firmware.js";
import {
  handleOutdoorForecastRoute,
  handleOutdoorRefreshRoute,
  handleSiteConfigRoute,
} from "./routes/outdoor.js";
import {
  computeOtaRolloutStatus,
  handleOverviewRoute,
  handleReadingsHistoryRoute,
} from "./routes/telemetry.js";
import {
  DEVICE_ID_REGEX,
  fleetRolloutSchema,
  setTargetFirmwareSchema,
  updateDeviceConfigSchema,
  updateSiteLocationConfigSchema,
} from "./schemas.js";
import type {
  DashboardDataService,
  DashboardDeviceOverviewItem,
  HandleDashboardApiOptions,
  IncomingApiRequest,
  OtaRolloutStatus,
} from "./types.js";

export {
  DEVICE_ID_REGEX,
  computeOtaRolloutStatus,
  fleetRolloutSchema,
  setTargetFirmwareSchema,
  updateDeviceConfigSchema,
  updateSiteLocationConfigSchema,
};
export type {
  DashboardDataService,
  DashboardDeviceOverviewItem,
  HandleDashboardApiOptions,
  IncomingApiRequest,
  OtaRolloutStatus,
};

export function createFirestoreDashboardService(
  db: Firestore = getDb()
): DashboardDataService {
  return {
    getSensorStatus: (options) => getSensorStatus(options, db),
    getLatestReading: (options) => getLatestReading(options, db),
    getReadingsHistory: (options) => getReadingsHistory(options, db),
    getAirQualitySummary: (options) => getAirQualitySummary(options, db),
    getReadingsHistoryWithSummary: (options) => getReadingsHistoryWithSummary(options, db),
    getDeviceConfig: (deviceId) => getDeviceConfig(deviceId, db),
    listDeviceConfigs: () => listDeviceConfigs(db),
    updateDeviceConfig: (deviceId, input, updatedBy) =>
      updateDeviceConfig(deviceId, input, updatedBy, db),
    requestDeviceReboot: (deviceId, updatedBy) =>
      requestDeviceReboot(deviceId, updatedBy, db),
    listFirmwareReleases: () => listFirmwareReleases(db),
    getFirmwareRelease: (version) => getFirmwareRelease(version, db),
    setDeviceTargetFirmwareVersion: (deviceId, targetVersion, updatedBy) =>
      setDeviceTargetFirmwareVersion(deviceId, targetVersion, updatedBy, db),
    getSiteLocationConfig: () => getSiteLocationConfig(db),
    updateSiteLocationConfig: (input, updatedBy) =>
      updateSiteLocationConfig(input, updatedBy, db),
    getLatestOutdoorReading: () => getLatestOutdoorReading(db),
    getLatestOutdoorForecast: () => getLatestOutdoorForecast(db),
    getOutdoorReadingsHistory: (hours, limit, opts) =>
      getOutdoorReadingsHistory(hours, limit, db, new Date(), opts),
    syncOutdoorReadingIfStale: (opts) => syncOutdoorReadingIfStale({ ...opts, db }),
  };
}

/**
 * Handles all `/api/*` routes for the lightweight Web Dashboard.
 *
 * Public non-secret endpoints:
 *   - GET  /api/auth/config
 *   - POST /api/auth/exchange   (WorkOS AuthKit PKCE code -> tokens, owner allowlist enforced)
 *   - POST /api/auth/refresh    (WorkOS AuthKit refresh -> tokens, owner allowlist enforced)
 *
 * Protected endpoints (require valid WorkOS JWT or Bearer fallback + owner allowlist):
 *   - GET  /api/me
 *   - GET  /api/dashboard/overview
 *   - GET  /api/readings/history
 *   - GET  /api/site/config
 *   - PUT  /api/site/config
 *   - POST /api/outdoor/refresh
 *   - GET  /api/firmware/releases
 *   - POST /api/firmware/rollout
 *   - GET  /api/devices/:deviceId/config
 *   - PUT  /api/devices/:deviceId/config
 *   - PUT  /api/devices/:deviceId/firmware
 *   - POST /api/devices/:deviceId/reboot
 */
export async function handleDashboardApiRequest(
  req: IncomingApiRequest,
  res: ServerResponse,
  options: HandleDashboardApiOptions
): Promise<void> {
  const { pathname, origin, authConfig, authDeps } = options;
  const method = (req.method ?? "GET").toUpperCase();

  if (
    await handlePublicAuthRoutes(req, res, {
      pathname,
      method,
      authConfig,
      authDeps,
    })
  ) {
    return;
  }

  const authResult = await authenticateMcpRequest(req, origin, authConfig, authDeps);
  if (!authResult.ok) {
    if (authResult.status === 401) {
      res.setHeader(
        "WWW-Authenticate",
        buildWwwAuthenticateHeader(
          origin,
          authResult.missingToken
            ? {}
            : {
                error: authResult.error,
                errorDescription: authResult.message,
              }
        )
      );
    }
    sendJson(res, authResult.status, {
      error: authResult.error,
      message: authResult.message,
    });
    return;
  }

  req.auth = authResult.authInfo;
  res.setHeader("Cache-Control", "private, no-store");
  const actor = resolveActorLabel(authResult.authInfo);

  if (pathname === "/api/me" && method === "GET") {
    handleMeRoute(res, authResult.authInfo);
    return;
  }

  const service =
    options.dashboardService ?? createFirestoreDashboardService(options.db ?? getDb());
  const cache = options.cache;

  try {
    const queryParams = parseQueryParams(req);
    const refreshParam = queryParams.get("refresh")?.trim().toLowerCase();
    const bypassCache = refreshParam === "1" || refreshParam === "true";

    if (pathname === "/api/dashboard/overview" && method === "GET") {
      await handleOverviewRoute(res, service, { cache, bypassCache });
      return;
    }

    if (pathname === "/api/readings/history" && method === "GET") {
      await handleReadingsHistoryRoute(req, res, service, {
        cache,
        bypassCache,
        queryParams,
      });
      return;
    }

    if (pathname === "/api/site/config") {
      await handleSiteConfigRoute(req, res, { pathname, method, actor, service, cache });
      return;
    }

    if (pathname === "/api/outdoor/refresh") {
      await handleOutdoorRefreshRoute(res, { pathname, method, service, cache });
      return;
    }

    if (pathname === "/api/outdoor/forecast") {
      await handleOutdoorForecastRoute(res, {
        pathname,
        method,
        service,
        cache,
        bypassCache,
      });
      return;
    }

    if (pathname === "/api/firmware/releases") {
      await handleFirmwareReleasesRoute(res, {
        pathname,
        method,
        service,
        cache,
        bypassCache,
      });
      return;
    }

    if (pathname === "/api/firmware/rollout") {
      await handleFirmwareRolloutRoute(req, res, {
        pathname,
        method,
        actor,
        service,
        cache,
      });
      return;
    }

    const deviceRoute = matchDeviceConfigRoute(pathname);
    if (deviceRoute) {
      await handleDeviceActionRoute(req, res, {
        pathname,
        method,
        actor,
        service,
        deviceRoute,
        cache,
      });
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message: `Unknown dashboard API route: ${method} ${pathname}`,
    });
  } catch (error) {
    if (error instanceof BodyReadError) {
      sendJson(res, error.statusCode, {
        error: error.code,
        message: error.message,
      });
      return;
    }
    console.error(
      `[api] Unhandled error on ${method} ${pathname}:`,
      error instanceof Error ? error.message : String(error)
    );
    sendJson(res, 500, {
      error: "internal_error",
      message: "Internal server error while processing dashboard API request.",
    });
  }
}
