import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import {
  authenticateMcpRequest,
  buildWwwAuthenticateHeader,
  exchangeAuthKitCode,
  normalizeAuthKitDomain,
  refreshAuthKitSession,
  type WorkosAuthConfig,
  type WorkosAuthDependencies,
} from "../auth/workos.js";
import {
  assessReadingHealth,
  getAirQualitySummary,
  getDb,
  getDeviceConfig,
  getLatestReading,
  getReadingsHistory,
  getSensorStatus,
  listDeviceConfigs,
  requestDeviceReboot,
  updateDeviceConfig,
  type AirQualityReading,
  type AirQualitySummaryOptions,
  type AirQualitySummaryResult,
  type DeviceConfig,
  type DeviceStatus,
  type LatestReadingOptions,
  type LatestReadingResult,
  type ReadingHealthContext,
  type ReadingsHistoryOptions,
  type ReadingsHistoryResult,
  type SensorStatusOptions,
  type SensorStatusResult,
  type SummaryPeriod,
  type UpdateDeviceConfigInput,
} from "../services/firestore.js";

export const DEVICE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_JSON_BODY_BYTES = 64 * 1024;

export interface IncomingApiRequest extends IncomingMessage {
  auth?: AuthInfo;
  body?: unknown;
  path?: string;
}

export interface DashboardDataService {
  getSensorStatus: (options?: SensorStatusOptions) => Promise<SensorStatusResult>;
  getLatestReading: (options?: LatestReadingOptions) => Promise<LatestReadingResult | null>;
  getReadingsHistory: (options?: ReadingsHistoryOptions) => Promise<ReadingsHistoryResult>;
  getAirQualitySummary: (options: AirQualitySummaryOptions) => Promise<AirQualitySummaryResult>;
  getDeviceConfig: (deviceId: string) => Promise<DeviceConfig | null>;
  listDeviceConfigs: () => Promise<Record<string, DeviceConfig>>;
  updateDeviceConfig: (
    deviceId: string,
    input: UpdateDeviceConfigInput,
    updatedBy: string
  ) => Promise<DeviceConfig>;
  requestDeviceReboot: (deviceId: string, updatedBy: string) => Promise<DeviceConfig>;
}

export interface DashboardDeviceOverviewItem {
  device: DeviceStatus;
  desired_config: DeviceConfig | null;
  config_sync_status: "synced" | "pending" | "local_defaults";
  health_context: ReadingHealthContext | null;
}

export interface HandleDashboardApiOptions {
  pathname: string;
  origin: string;
  authConfig: WorkosAuthConfig;
  authDeps?: WorkosAuthDependencies;
  db?: Firestore;
  dashboardService?: DashboardDataService;
}

export const updateDeviceConfigSchema = z
  .object({
    location: z
      .string()
      .trim()
      .regex(
        DEVICE_ID_REGEX,
        "location must be 1-64 characters using letters, numbers, underscores, or hyphens."
      ),
    reporting_interval_seconds: z
      .number()
      .int("reporting_interval_seconds must be a whole number.")
      .min(60, "reporting_interval_seconds must be at least 60 seconds.")
      .max(3600, "reporting_interval_seconds must be at most 3600 seconds."),
    temperature_offset_c: z
      .number()
      .finite("temperature_offset_c must be a finite number.")
      .min(0, "temperature_offset_c must be between 0 and 20 °C.")
      .max(20, "temperature_offset_c must be between 0 and 20 °C."),
    altitude_m: z
      .number()
      .int("altitude_m must be a whole number.")
      .min(0, "altitude_m must be between 0 and 5000 meters.")
      .max(5000, "altitude_m must be between 0 and 5000 meters."),
    led_enabled: z.boolean(),
  })
  .strict();

const authExchangeSchema = z
  .object({
    code: z.string().trim().min(1).max(2048),
    code_verifier: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const authRefreshSchema = z
  .object({
    refresh_token: z.string().trim().min(1).max(4096),
  })
  .strict();

const SUMMARY_PERIOD_VALUES = new Set<SummaryPeriod>(["1h", "6h", "24h", "7d", "30d"]);

export function createFirestoreDashboardService(
  db: Firestore = getDb()
): DashboardDataService {
  return {
    getSensorStatus: (options) => getSensorStatus(options, db),
    getLatestReading: (options) => getLatestReading(options, db),
    getReadingsHistory: (options) => getReadingsHistory(options, db),
    getAirQualitySummary: (options) => getAirQualitySummary(options, db),
    getDeviceConfig: (deviceId) => getDeviceConfig(deviceId, db),
    listDeviceConfigs: () => listDeviceConfigs(db),
    updateDeviceConfig: (deviceId, input, updatedBy) =>
      updateDeviceConfig(deviceId, input, updatedBy, db),
    requestDeviceReboot: (deviceId, updatedBy) =>
      requestDeviceReboot(deviceId, updatedBy, db),
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function parseQueryParams(req: IncomingApiRequest): URLSearchParams {
  const rawUrl = req.url ?? "/";
  const parsed = new URL(rawUrl, "http://localhost");
  return parsed.searchParams;
}

async function readJsonBody(req: IncomingApiRequest): Promise<unknown> {
  if (
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new BodyReadError(413, "payload_too_large", "Request JSON body exceeds 64 KB limit.");
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawText = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new BodyReadError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

class BodyReadError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function formatZodError(error: z.ZodError): {
  error: string;
  message: string;
  issues: Array<{ path: string; message: string }>;
} {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join(".") || "(body)",
    message: issue.message,
  }));
  return {
    error: "validation_error",
    message: issues[0] ? `${issues[0].path}: ${issues[0].message}` : "Invalid request payload.",
    issues,
  };
}

function resolveActorLabel(authInfo: AuthInfo): string {
  const email = authInfo.extra?.email;
  if (typeof email === "string" && email.trim().length > 0) {
    return email.trim().toLowerCase();
  }
  const userId = authInfo.extra?.userId;
  if (typeof userId === "string" && userId.trim().length > 0) {
    return userId.trim();
  }
  return "bearer-api";
}

function computeConfigSyncStatus(
  device: DeviceStatus,
  desired: DeviceConfig | null
): "synced" | "pending" | "local_defaults" {
  if (!desired) {
    return "local_defaults";
  }
  if (
    typeof device.config_version === "number" &&
    device.config_version === desired.config_version
  ) {
    return "synced";
  }
  return "pending";
}

function buildHealthContextFromLatest(device: DeviceStatus): ReadingHealthContext | null {
  const latest = device.latest_reading;
  if (!latest) {
    return null;
  }
  const syntheticReading: AirQualityReading = {
    id: `${device.device_id}_latest`,
    device_id: device.device_id,
    location: device.location,
    timestamp: device.last_seen_at,
    co2_ppm: latest.co2_ppm,
    temperature_c: ((latest.temperature_f - 32) * 5) / 9,
    temperature_f: latest.temperature_f,
    humidity_percent: latest.humidity_percent,
    pm1_0_ug_m3: 0,
    pm2_5_ug_m3: latest.pm2_5_ug_m3,
    pm10_0_ug_m3: 0,
    aqi_us: latest.aqi_us,
    aqi_category: latest.aqi_category,
    particles_0_3um: 0,
    particles_0_5um: 0,
    particles_1_0um: 0,
    particles_2_5um: 0,
    particles_5_0um: 0,
    particles_10_0um: 0,
  };
  return assessReadingHealth(syntheticReading);
}

function resolvePeriodFromHours(hours: number): SummaryPeriod {
  if (hours <= 1) return "1h";
  if (hours <= 6) return "6h";
  if (hours <= 24) return "24h";
  return "7d";
}

function matchDeviceConfigRoute(
  pathname: string
): { deviceId: string; action: "config" | "reboot" } | null {
  const configMatch = /^\/api\/devices\/([^/]+)\/config$/.exec(pathname);
  if (configMatch) {
    return { deviceId: decodeURIComponent(configMatch[1]), action: "config" };
  }
  const rebootMatch = /^\/api\/devices\/([^/]+)\/reboot$/.exec(pathname);
  if (rebootMatch) {
    return { deviceId: decodeURIComponent(rebootMatch[1]), action: "reboot" };
  }
  return null;
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
 *   - GET  /api/devices/:deviceId/config
 *   - PUT  /api/devices/:deviceId/config
 *   - POST /api/devices/:deviceId/reboot
 */
export async function handleDashboardApiRequest(
  req: IncomingApiRequest,
  res: ServerResponse,
  options: HandleDashboardApiOptions
): Promise<void> {
  const { pathname, origin, authConfig, authDeps } = options;
  const method = (req.method ?? "GET").toUpperCase();

  // 1. Public non-secret OAuth client discovery for the browser dashboard
  if (pathname === "/api/auth/config" && method === "GET") {
    const authkitDomain = normalizeAuthKitDomain(authConfig.workosAuthKitDomain);
    const clientId = authConfig.workosClientId?.trim() || null;
    sendJson(res, 200, {
      oauth_configured: Boolean(authkitDomain && clientId),
      authkit_domain: authkitDomain ?? null,
      client_id: clientId,
      authorize_endpoint: "https://api.workos.com/user_management/authorize",
    });
    return;
  }

  // 2. WorkOS AuthKit PKCE authorization code exchange (owner allowlist enforced)
  if (pathname === "/api/auth/exchange" && method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyReadError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const parsed = authExchangeSchema.safeParse(rawBody);
    if (!parsed.success) {
      sendJson(res, 400, formatZodError(parsed.error));
      return;
    }

    const outcome = await exchangeAuthKitCode(
      {
        code: parsed.data.code,
        codeVerifier: parsed.data.code_verifier,
      },
      authConfig,
      authDeps
    );
    if (!outcome.ok) {
      sendJson(res, outcome.status, {
        error: outcome.error,
        message: outcome.message,
      });
      return;
    }

    sendJson(res, 200, {
      access_token: outcome.session.accessToken,
      refresh_token: outcome.session.refreshToken,
      user: {
        id: outcome.session.user.id,
        email: outcome.session.user.email,
        first_name: outcome.session.user.firstName ?? null,
        last_name: outcome.session.user.lastName ?? null,
      },
    });
    return;
  }

  // 3. WorkOS AuthKit session refresh (owner allowlist re-verified)
  if (pathname === "/api/auth/refresh" && method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyReadError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const parsed = authRefreshSchema.safeParse(rawBody);
    if (!parsed.success) {
      sendJson(res, 400, formatZodError(parsed.error));
      return;
    }

    const outcome = await refreshAuthKitSession(
      { refreshToken: parsed.data.refresh_token },
      authConfig,
      authDeps
    );
    if (!outcome.ok) {
      sendJson(res, outcome.status, {
        error: outcome.error,
        message: outcome.message,
      });
      return;
    }

    sendJson(res, 200, {
      access_token: outcome.session.accessToken,
      refresh_token: outcome.session.refreshToken,
      user: {
        id: outcome.session.user.id,
        email: outcome.session.user.email,
        first_name: outcome.session.user.firstName ?? null,
        last_name: outcome.session.user.lastName ?? null,
      },
    });
    return;
  }

  // 4. All remaining `/api/*` endpoints require strict WorkOS JWT or Bearer fallback + owner allowlist
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
  const actor = resolveActorLabel(authResult.authInfo);

  // 5. GET /api/me — lightweight authenticated identity check
  if (pathname === "/api/me" && method === "GET") {
    sendJson(res, 200, {
      authenticated: true,
      auth_method: authResult.authInfo.extra?.authMethod ?? "unknown",
      user_id: authResult.authInfo.extra?.userId ?? null,
      email: authResult.authInfo.extra?.email ?? null,
    });
    return;
  }

  const service =
    options.dashboardService ?? createFirestoreDashboardService(options.db ?? getDb());

  try {
    // 6. GET /api/dashboard/overview — live device cards + desired config + sync status
    if (pathname === "/api/dashboard/overview" && method === "GET") {
      const [statusResult, configMap] = await Promise.all([
        service.getSensorStatus(),
        service.listDeviceConfigs(),
      ]);

      const items: DashboardDeviceOverviewItem[] = statusResult.devices.map((device) => {
        const desired = configMap[device.device_id] ?? null;
        return {
          device,
          desired_config: desired,
          config_sync_status: computeConfigSyncStatus(device, desired),
          health_context: buildHealthContextFromLatest(device),
        };
      });

      sendJson(res, 200, {
        checked_at: statusResult.checked_at,
        stale_threshold_minutes: statusResult.stale_threshold_minutes,
        device_count: statusResult.device_count,
        online_count: statusResult.online_count,
        stale_or_offline_count: statusResult.stale_or_offline_count,
        devices: items,
      });
      return;
    }

    // 7. GET /api/readings/history — time-series readings + summary stats for charts
    if (pathname === "/api/readings/history" && method === "GET") {
      const params = parseQueryParams(req);
      const rawHours = params.get("hours");
      const rawLimit = params.get("limit");
      const rawPeriod = params.get("period");
      const deviceId = params.get("device_id")?.trim() || undefined;
      const location = params.get("location")?.trim() || undefined;

      if (deviceId && !DEVICE_ID_REGEX.test(deviceId)) {
        sendJson(res, 400, {
          error: "validation_error",
          message: "Invalid device_id query parameter.",
        });
        return;
      }
      if (location && !DEVICE_ID_REGEX.test(location)) {
        sendJson(res, 400, {
          error: "validation_error",
          message: "Invalid location query parameter.",
        });
        return;
      }

      let hours = 24;
      if (rawHours !== null && rawHours.trim() !== "") {
        const parsedHours = Number(rawHours);
        if (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 168) {
          sendJson(res, 400, {
            error: "validation_error",
            message: "hours must be a number between 1 and 168.",
          });
          return;
        }
        hours = Math.round(parsedHours);
      }

      let limit = 200;
      if (rawLimit !== null && rawLimit.trim() !== "") {
        const parsedLimit = Number(rawLimit);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
          sendJson(res, 400, {
            error: "validation_error",
            message: "limit must be a number between 1 and 500.",
          });
          return;
        }
        limit = Math.round(parsedLimit);
      }

      let summaryPeriod: SummaryPeriod = resolvePeriodFromHours(hours);
      if (rawPeriod !== null && rawPeriod.trim() !== "") {
        if (!SUMMARY_PERIOD_VALUES.has(rawPeriod as SummaryPeriod)) {
          sendJson(res, 400, {
            error: "validation_error",
            message: "period must be one of: 1h, 6h, 24h, 7d, 30d.",
          });
          return;
        }
        summaryPeriod = rawPeriod as SummaryPeriod;
      }

      const [history, summary] = await Promise.all([
        service.getReadingsHistory({ hours, limit, device_id: deviceId, location }),
        service.getAirQualitySummary({
          period: summaryPeriod,
          device_id: deviceId,
          location,
        }),
      ]);

      sendJson(res, 200, {
        history,
        summary,
      });
      return;
    }

    // 8. /api/devices/:deviceId/config & /api/devices/:deviceId/reboot
    const deviceRoute = matchDeviceConfigRoute(pathname);
    if (deviceRoute) {
      const { deviceId, action } = deviceRoute;
      if (!DEVICE_ID_REGEX.test(deviceId)) {
        sendJson(res, 400, {
          error: "validation_error",
          message:
            "device_id must be 1-64 characters using letters, numbers, underscores, or hyphens.",
        });
        return;
      }

      if (action === "config" && method === "GET") {
        const [desired, status] = await Promise.all([
          service.getDeviceConfig(deviceId),
          service.getSensorStatus({ device_id: deviceId }),
        ]);
        const device = status.devices[0] ?? null;

        sendJson(res, 200, {
          device_id: deviceId,
          desired_config: desired,
          reported_device: device,
          config_sync_status: device
            ? computeConfigSyncStatus(device, desired)
            : desired
              ? "pending"
              : "local_defaults",
        });
        return;
      }

      if (action === "config" && method === "PUT") {
        let rawBody: unknown;
        try {
          rawBody = await readJsonBody(req);
        } catch (err) {
          if (err instanceof BodyReadError) {
            sendJson(res, err.statusCode, { error: err.code, message: err.message });
            return;
          }
          throw err;
        }

        const parsed = updateDeviceConfigSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendJson(res, 400, formatZodError(parsed.error));
          return;
        }

        const saved = await service.updateDeviceConfig(deviceId, parsed.data, actor);
        sendJson(res, 200, {
          updated: true,
          config: saved,
        });
        return;
      }

      if (action === "reboot" && method === "POST") {
        const saved = await service.requestDeviceReboot(deviceId, actor);
        sendJson(res, 200, {
          reboot_requested: true,
          config: saved,
        });
        return;
      }

      sendJson(res, 405, {
        error: "method_not_allowed",
        message: `Method ${method} is not allowed for ${pathname}.`,
      });
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message: `Unknown dashboard API route: ${method} ${pathname}`,
    });
  } catch (error) {
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
