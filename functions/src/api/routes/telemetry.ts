import type { ServerResponse } from "node:http";

import {
  assessReadingHealth,
  type AirQualityReading,
  type AirQualitySummaryResult,
  type DeviceConfig,
  type DeviceStatus,
  type ReadingHealthContext,
  type ReadingsHistoryResult,
  type SummaryPeriod,
} from "../../services/firestore.js";
import {
  computeIndoorOutdoorDelta,
  findBestVentilationWindows,
  type OutdoorReading,
} from "../../services/outdoor.js";
import {
  HISTORY_CACHE_TTL_MS,
  OVERVIEW_CACHE_TTL_MS,
  type DashboardResponseCache,
} from "../cache.js";
import { parseQueryParams, sendJson } from "../http.js";
import { DEVICE_ID_REGEX, SUMMARY_PERIOD_VALUES } from "../schemas.js";
import type {
  DashboardDataService,
  DashboardDeviceOverviewItem,
  IncomingApiRequest,
  OtaRolloutStatus,
} from "../types.js";

export function computeConfigSyncStatus(
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

export function computeOtaRolloutStatus(
  device: DeviceStatus,
  desired: DeviceConfig | null
): OtaRolloutStatus {
  const target = desired?.target_firmware_version ?? null;
  if (device.ota_status === "updating") {
    return "updating";
  }
  if (target && target !== device.firmware_version) {
    if (
      (device.ota_status === "rolled_back" || device.ota_status === "error") &&
      device.ota_target_version === target
    ) {
      return device.ota_status;
    }
    return "pending";
  }
  if (device.ota_status === "rolled_back" || device.ota_status === "error") {
    return device.ota_status;
  }
  return "up_to_date";
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

export async function handleOverviewRoute(
  res: ServerResponse,
  service: DashboardDataService,
  cacheOpts: { cache?: DashboardResponseCache; bypassCache?: boolean } = {}
): Promise<void> {
  const cacheKey = "overview";
  if (cacheOpts.cache && !cacheOpts.bypassCache) {
    const cached = cacheOpts.cache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
  }

  const [statusResult, configMap, siteConfig, outdoorLatest, outdoorForecast] = await Promise.all([
    service.getSensorStatus(),
    service.listDeviceConfigs(),
    service.getSiteLocationConfig ? service.getSiteLocationConfig() : Promise.resolve(null),
    service.getLatestOutdoorReading
      ? service.getLatestOutdoorReading()
      : Promise.resolve(null),
    service.getLatestOutdoorForecast
      ? service.getLatestOutdoorForecast()
      : Promise.resolve(null),
  ]);

  const items: DashboardDeviceOverviewItem[] = statusResult.devices.map((device) => {
    const desired = configMap[device.device_id] ?? null;
    const outdoorDelta =
      device.latest_reading && outdoorLatest
        ? computeIndoorOutdoorDelta(device.latest_reading, outdoorLatest.reading)
        : null;
    return {
      device,
      desired_config: desired,
      config_sync_status: computeConfigSyncStatus(device, desired),
      ota_rollout_status: computeOtaRolloutStatus(device, desired),
      health_context: buildHealthContextFromLatest(device),
      outdoor_delta: outdoorDelta,
    };
  });

  const baselineDevice = statusResult.devices.find((d) => d.latest_reading !== null);
  const indoorBaseline = baselineDevice?.latest_reading
    ? {
        temperature_f: baselineDevice.latest_reading.temperature_f,
        humidity_percent: baselineDevice.latest_reading.humidity_percent,
      }
    : { temperature_f: 70.0, humidity_percent: 45.0 };

  let ventilationForecast: {
    fetched_at: string;
    is_stale: boolean;
    next_best_window: ReturnType<typeof findBestVentilationWindows>["next_best_window"];
    lowest_tax_fallback_hour: ReturnType<
      typeof findBestVentilationWindows
    >["lowest_tax_fallback_hour"];
  } | null = null;

  if (outdoorForecast) {
    const analysis = findBestVentilationWindows(indoorBaseline, outdoorForecast.forecast);
    ventilationForecast = {
      fetched_at: outdoorForecast.forecast.fetched_at,
      is_stale: outdoorForecast.is_stale,
      next_best_window: analysis.next_best_window,
      lowest_tax_fallback_hour: analysis.lowest_tax_fallback_hour,
    };
  }

  const payload = {
    checked_at: statusResult.checked_at,
    stale_threshold_minutes: statusResult.stale_threshold_minutes,
    device_count: statusResult.device_count,
    online_count: statusResult.online_count,
    stale_or_offline_count: statusResult.stale_or_offline_count,
    devices: items,
    site_config: siteConfig,
    outdoor_latest: outdoorLatest,
    ventilation_forecast: ventilationForecast,
  };
  cacheOpts.cache?.set(cacheKey, payload, OVERVIEW_CACHE_TTL_MS);
  sendJson(res, 200, payload);
}

export async function handleReadingsHistoryRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  service: DashboardDataService,
  cacheOpts: { cache?: DashboardResponseCache; bypassCache?: boolean } = {}
): Promise<void> {
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

  const cacheKey = `history:${hours}|${limit}|${summaryPeriod}|${deviceId ?? "*"}|${location ?? "*"}`;
  if (cacheOpts.cache && !cacheOpts.bypassCache) {
    const cached = cacheOpts.cache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
  }

  const forceTailCheck = Boolean(cacheOpts.bypassCache);
  const outdoorPromise = service.getOutdoorReadingsHistory
    ? service.getOutdoorReadingsHistory(hours, limit, { forceTailCheck })
    : Promise.resolve([]);

  let history: ReadingsHistoryResult;
  let summary: AirQualitySummaryResult;
  let outdoorHistory: OutdoorReading[];

  if (service.getReadingsHistoryWithSummary) {
    const [combined, outdoor] = await Promise.all([
      service.getReadingsHistoryWithSummary({
        hours,
        limit,
        period: summaryPeriod,
        device_id: deviceId,
        location,
        forceTailCheck,
      }),
      outdoorPromise,
    ]);
    history = combined.history;
    summary = combined.summary;
    outdoorHistory = outdoor;
  } else {
    const [hist, sum, outdoor] = await Promise.all([
      service.getReadingsHistory({
        hours,
        limit,
        device_id: deviceId,
        location,
        forceTailCheck,
      }),
      service.getAirQualitySummary({
        period: summaryPeriod,
        device_id: deviceId,
        location,
        forceTailCheck,
      }),
      outdoorPromise,
    ]);
    history = hist;
    summary = sum;
    outdoorHistory = outdoor;
  }

  const payload = {
    history,
    summary,
    outdoor_history: outdoorHistory,
  };
  cacheOpts.cache?.set(cacheKey, payload, HISTORY_CACHE_TTL_MS);
  sendJson(res, 200, payload);
}
