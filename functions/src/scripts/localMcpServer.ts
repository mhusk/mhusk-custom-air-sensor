import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractBearerToken, timingSafeSecretEqual } from "../auth/workos.js";
import {
  assessReadingHealth,
  computeMetricStats,
  detectNotableSpikes,
  downsampleReadings,
  getDb,
  type AirQualityReading,
  type DeviceStatus,
} from "../services/firestore.js";
import {
  computeDewPointF,
  type OutdoorForecastHour,
} from "../services/outdoor.js";
import { handleStatelessMcpHttpRequest } from "../mcp/server.js";
import type { AirQualityDataService } from "../mcp/tools.js";
import { resolveProjectId } from "./projectId.js";

/**
 * Resolves the Firebase project ID from environment variables or the local
 * gitignored `.firebaserc` file.
 */
export function resolveProjectIdFromFirebaserc(): string | undefined {
  return resolveProjectId();
}

/**
 * Creates a deterministic in-memory data service with synthetic readings so
 * MCP protocol tests can run offline without Google Cloud credentials.
 */
export function createMockAirQualityService(): AirQualityDataService {
  const now = new Date();
  const reading1Time = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const reading2Time = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const latestTime = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

  const readings: AirQualityReading[] = [
    {
      id: "mock_reading_1",
      device_id: "feather-s3-01",
      location: "home-office",
      timestamp: reading1Time,
      co2_ppm: 642,
      temperature_c: 22.4,
      temperature_f: 72.3,
      humidity_percent: 44.8,
      pm1_0_ug_m3: 3,
      pm2_5_ug_m3: 6,
      pm10_0_ug_m3: 11,
      aqi_us: 33,
      aqi_category: "Good",
      particles_0_3um: 810,
      particles_0_5um: 225,
      particles_1_0um: 42,
      particles_2_5um: 4,
      particles_5_0um: 1,
      particles_10_0um: 0,
    },
    {
      id: "mock_reading_2",
      device_id: "feather-s3-01",
      location: "home-office",
      timestamp: reading2Time,
      co2_ppm: 1120,
      temperature_c: 22.8,
      temperature_f: 73.0,
      humidity_percent: 45.2,
      pm1_0_ug_m3: 5,
      pm2_5_ug_m3: 12,
      pm10_0_ug_m3: 18,
      aqi_us: 57,
      aqi_category: "Moderate",
      particles_0_3um: 1240,
      particles_0_5um: 340,
      particles_1_0um: 68,
      particles_2_5um: 9,
      particles_5_0um: 2,
      particles_10_0um: 0,
    },
    {
      id: "mock_reading_3",
      device_id: "feather-s3-01",
      location: "home-office",
      timestamp: latestTime,
      co2_ppm: 780,
      temperature_c: 22.5,
      temperature_f: 72.5,
      humidity_percent: 44.5,
      pm1_0_ug_m3: 4,
      pm2_5_ug_m3: 7,
      pm10_0_ug_m3: 12,
      aqi_us: 39,
      aqi_category: "Good",
      particles_0_3um: 890,
      particles_0_5um: 240,
      particles_1_0um: 48,
      particles_2_5um: 5,
      particles_5_0um: 1,
      particles_10_0um: 0,
    },
  ];

  const device: DeviceStatus = {
    device_id: "feather-s3-01",
    location: "home-office",
    last_seen_at: latestTime,
    minutes_since_last_seen: 2.0,
    status: "online",
    is_online: true,
    is_stale: false,
    firmware_version: "1.0.0",
    sensors: ["SCD-40", "PMSA003I"],
    reporting_interval_seconds: 300,
    latest_reading: {
      co2_ppm: 780,
      temperature_f: 72.5,
      humidity_percent: 44.5,
      pm2_5_ug_m3: 7,
      aqi_us: 39,
      aqi_category: "Good",
    },
  };

  const filterReadings = (deviceId?: string, location?: string): AirQualityReading[] =>
    readings.filter(
      (r) =>
        (!deviceId || r.device_id === deviceId) &&
        (!location || r.location === location)
    );

  return {
    async getLatestReading(options = {}) {
      const matched = filterReadings(options.device_id, options.location);
      if (matched.length === 0) {
        return null;
      }
      const latest = matched[matched.length - 1];
      return {
        reading: latest,
        device,
        minutes_ago: 2.0,
        is_stale: false,
        health_context: assessReadingHealth(latest),
      };
    },
    async getReadingsHistory(options = {}) {
      const matched = filterReadings(options.device_id, options.location);
      const limit = options.limit ?? 100;
      const returned = downsampleReadings(matched, limit);
      return {
        window_start: new Date(now.getTime() - (options.hours ?? 24) * 3600 * 1000).toISOString(),
        window_end: now.toISOString(),
        filters: {
          device_id: options.device_id ?? null,
          location: options.location ?? null,
        },
        total_matching: matched.length,
        returned_count: returned.length,
        downsampled: matched.length > limit,
        scan_capped: false,
        readings: returned,
      };
    },
    async getAirQualitySummary(options) {
      const matched = filterReadings(options.device_id, options.location);
      return {
        period: options.period,
        window_start: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
        window_end: now.toISOString(),
        filters: {
          device_id: options.device_id ?? null,
          location: options.location ?? null,
        },
        sample_count: matched.length,
        scan_capped: false,
        metrics:
          matched.length === 0
            ? null
            : {
                co2_ppm: computeMetricStats(matched.map((r) => r.co2_ppm), 0),
                pm2_5_ug_m3: computeMetricStats(matched.map((r) => r.pm2_5_ug_m3), 1),
                pm10_0_ug_m3: computeMetricStats(matched.map((r) => r.pm10_0_ug_m3), 1),
                temperature_f: computeMetricStats(matched.map((r) => r.temperature_f), 1),
                temperature_c: computeMetricStats(matched.map((r) => r.temperature_c), 1),
                humidity_percent: computeMetricStats(matched.map((r) => r.humidity_percent), 1),
                aqi_us: computeMetricStats(matched.map((r) => r.aqi_us), 0),
              },
        threshold_exceedances: {
          co2_above_1000_ppm_count: matched.filter((r) => r.co2_ppm > 1000).length,
          co2_above_1000_ppm_percent:
            matched.length > 0
              ? Math.round((matched.filter((r) => r.co2_ppm > 1000).length / matched.length) * 1000) / 10
              : 0,
          co2_above_1400_ppm_count: matched.filter((r) => r.co2_ppm > 1400).length,
          pm2_5_above_9_ug_m3_count: matched.filter((r) => r.pm2_5_ug_m3 > 9).length,
          pm2_5_above_9_ug_m3_percent:
            matched.length > 0
              ? Math.round((matched.filter((r) => r.pm2_5_ug_m3 > 9).length / matched.length) * 1000) / 10
              : 0,
          pm2_5_above_35_4_ug_m3_count: matched.filter((r) => r.pm2_5_ug_m3 > 35.4).length,
        },
        notable_spikes: detectNotableSpikes(matched),
      };
    },
    async getSensorStatus(options = {}) {
      const devices =
        !options.device_id || options.device_id === device.device_id ? [device] : [];
      return {
        checked_at: now.toISOString(),
        stale_threshold_minutes: 15,
        device_count: devices.length,
        online_count: devices.length,
        stale_or_offline_count: 0,
        devices,
      };
    },
    async getLatestOutdoorReading() {
      return {
        reading: {
          id: "mock_outdoor_latest",
          timestamp: now.toISOString(),
          location_label: "Home Outdoor",
          latitude: 37.7749,
          longitude: -122.4194,
          source: "open-meteo",
          temperature_c: 18.0,
          temperature_f: 64.4,
          apparent_temperature_f: 63.0,
          humidity_percent: 52.0,
          wind_speed_mph: 6.2,
          weather_code: 1,
          weather_description: "Mainly clear",
          pm2_5_ug_m3: 6.4,
          pm10_0_ug_m3: 11.2,
          us_aqi: 29,
          us_aqi_category: "Good",
          ozone_ug_m3: 44.0,
          nitrogen_dioxide_ug_m3: 8.1,
        },
        minutes_ago: 4.0,
        is_stale: false,
      };
    },
    async getLatestOutdoorForecast() {
      const hours: OutdoorForecastHour[] = Array.from({ length: 6 }, (_, idx) => {
        const ts = new Date(now.getTime() + (idx + 1) * 3600 * 1000).toISOString();
        const tempC = 17.5 + idx * 0.5;
        const tempF = Math.round(((tempC * 9) / 5 + 32) * 10) / 10;
        const rh = 50 + idx;
        return {
          timestamp: ts,
          temperature_c: tempC,
          temperature_f: tempF,
          humidity_percent: rh,
          dew_point_f: computeDewPointF(tempF, rh),
          wind_speed_mph: 5.5,
          weather_code: 1,
          weather_description: "Mainly clear",
          pm2_5_ug_m3: 6.0,
          us_aqi: 26,
          us_aqi_category: "Good",
        };
      });
      return {
        forecast: {
          fetched_at: now.toISOString(),
          location_label: "Home Outdoor",
          latitude: 37.7749,
          longitude: -122.4194,
          source: "open-meteo",
          hours,
        },
        minutes_ago: 4.0,
        is_stale: false,
      };
    },
  };
}

function isBearerAuthorized(req: IncomingMessage, expectedSecret: string): boolean {
  const provided = extractBearerToken(req);
  if (!provided) {
    return false;
  }
  return timingSafeSecretEqual(provided, expectedSecret);
}

export interface LocalMcpHttpServerOptions {
  useMock?: boolean;
  bearerSecret?: string;
  projectId?: string;
}

/**
 * Builds a localhost-only Node HTTP server exposing `/mcp` (Streamable HTTP)
 * and `/health` for Step 6 local `curl` and MCP Inspector validation.
 */
export function createLocalMcpHttpServer(
  options: LocalMcpHttpServerOptions = {}
): http.Server {
  const service = options.useMock ? createMockAirQualityService() : undefined;
  const db = options.useMock
    ? undefined
    : getDb(options.projectId ? { projectId: options.projectId } : undefined);

  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          mode: options.useMock ? "mock" : "firestore",
          auth: options.bearerSecret ? "bearer-required" : "local-open",
          endpoint: "/mcp",
        })
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp or GET /health." }));
      return;
    }

    if (options.bearerSecret && !isBearerAuthorized(req, options.bearerSecret)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer realm="custom-air-sensor-mcp"');
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized: valid Bearer token required.",
          },
          id: null,
        })
      );
      return;
    }

    await handleStatelessMcpHttpRequest(req, res, { db, service });
  });
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const useMock = process.argv.includes("--mock");
  const port = Number(process.env.PORT ?? 8787);
  const bearerSecret = process.env.MCP_BEARER_FALLBACK_SECRET?.trim() || undefined;
  const projectId = useMock ? undefined : resolveProjectIdFromFirebaserc();

  if (!useMock && !projectId) {
    console.error(
      "Could not determine Firebase project ID. Ensure .firebaserc exists, set FIREBASE_PROJECT_ID, or pass --mock."
    );
    process.exit(1);
  }

  const server = createLocalMcpHttpServer({
    useMock,
    bearerSecret,
    projectId,
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Local MCP server listening at http://127.0.0.1:${port}/mcp`);
    console.log(`  Mode: ${useMock ? "mock (in-memory synthetic data)" : "live (Cloud Firestore)"}`);
    console.log(
      `  Auth: ${bearerSecret ? "Bearer token enabled (MCP_BEARER_FALLBACK_SECRET)" : "none (localhost dev only)"}`
    );
    console.log("  Press Ctrl+C to stop.");
  });
}
