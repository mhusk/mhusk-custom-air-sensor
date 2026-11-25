import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import {
  DEFAULT_HISTORY_HOURS,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_HOURS,
  MAX_HISTORY_LIMIT,
  getAirQualitySummary,
  getDb,
  getLatestReading,
  getReadingsHistory,
  getSensorStatus,
  type AirQualitySummaryOptions,
  type AirQualitySummaryResult,
  type LatestReadingOptions,
  type LatestReadingResult,
  type ReadingsHistoryOptions,
  type ReadingsHistoryResult,
  type SensorStatusOptions,
  type SensorStatusResult,
} from "../services/firestore.js";
import {
  computeIndoorOutdoorDelta,
  getLatestOutdoorReading,
  getOutdoorReadingsHistory,
  syncOutdoorReadingIfStale,
  type LatestOutdoorReadingResult,
  type OutdoorReading,
} from "../services/outdoor.js";

/**
 * Injectable data service interface so MCP tools can run against live Cloud
 * Firestore by default or a deterministic in-memory stub during offline tests.
 */
export interface AirQualityDataService {
  getLatestReading(options?: LatestReadingOptions): Promise<LatestReadingResult | null>;
  getReadingsHistory(options?: ReadingsHistoryOptions): Promise<ReadingsHistoryResult>;
  getAirQualitySummary(options: AirQualitySummaryOptions): Promise<AirQualitySummaryResult>;
  getSensorStatus(options?: SensorStatusOptions): Promise<SensorStatusResult>;
  getLatestOutdoorReading?: () => Promise<LatestOutdoorReadingResult | null>;
  getOutdoorReadingsHistory?: (hours?: number, limit?: number) => Promise<OutdoorReading[]>;
  syncOutdoorReadingIfStale?: (options?: { force?: boolean }) => Promise<{
    synced: boolean;
    reason: string;
    reading: OutdoorReading | null;
  }>;
}

/**
 * Builds the default Cloud Firestore-backed data service.
 */
export function createFirestoreDataService(db?: Firestore): AirQualityDataService {
  const resolveDb = (): Firestore => db ?? getDb();
  return {
    getLatestReading: (options) => getLatestReading(options, resolveDb()),
    getReadingsHistory: (options) => getReadingsHistory(options, resolveDb()),
    getAirQualitySummary: (options) => getAirQualitySummary(options, resolveDb()),
    getSensorStatus: (options) => getSensorStatus(options, resolveDb()),
    getLatestOutdoorReading: () => getLatestOutdoorReading(resolveDb()),
    getOutdoorReadingsHistory: (hours, limit) =>
      getOutdoorReadingsHistory(hours, limit, resolveDb()),
    syncOutdoorReadingIfStale: (options) =>
      syncOutdoorReadingIfStale({ ...options, db: resolveDb() }),
  };
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function jsonToolResult(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorToolResult(toolName: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: `Tool '${toolName}' failed`,
            message,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Registers all five indoor/outdoor air quality MCP tools on the provided McpServer.
 */
export function registerAirQualityTools(
  server: McpServer,
  service: AirQualityDataService = createFirestoreDataService()
): void {
  server.registerTool(
    "get_latest_reading",
    {
      title: "Get Latest Air Quality Reading",
      description:
        "Fetches the most recent indoor air quality sensor reading from Firestore along with device metadata, freshness (minutes_ago / is_stale), CO2, temperature, humidity, PM1.0/PM2.5/PM10, US EPA AQI, particle counts, and qualitative health context.",
      inputSchema: {
        device_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional sensor device ID (e.g., 'feather-s3-01'). Omit to query all sensors."),
        location: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional room or location slug (e.g., 'home-office')."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ device_id, location }) => {
      try {
        const [result, outdoor] = await Promise.all([
          service.getLatestReading({ device_id, location }),
          service.getLatestOutdoorReading
            ? service.getLatestOutdoorReading().catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!result) {
          return jsonToolResult({
            found: false,
            filters: {
              device_id: device_id ?? null,
              location: location ?? null,
            },
            message: "No air quality readings found matching the specified filters.",
          });
        }
        const outdoorComparison = outdoor
          ? computeIndoorOutdoorDelta(result.reading, outdoor.reading)
          : null;
        return jsonToolResult({
          found: true,
          ...result,
          outdoor: outdoor ?? null,
          outdoor_comparison: outdoorComparison,
        });
      } catch (error) {
        return errorToolResult("get_latest_reading", error);
      }
    }
  );

  server.registerTool(
    "get_readings_history",
    {
      title: "Get Air Quality Readings History",
      description:
        "Queries chronological time-series indoor air quality readings from Firestore over a relative lookback window (`hours`) or explicit ISO-8601 `start_time`/`end_time` range. Automatically downsamples evenly if more readings match than `limit`, preserving the first and last observations.",
      inputSchema: {
        hours: z
          .number()
          .min(1)
          .max(MAX_HISTORY_HOURS)
          .optional()
          .describe(
            `Lookback duration in hours (1-${MAX_HISTORY_HOURS}, default ${DEFAULT_HISTORY_HOURS}). Ignored when start_time is provided.`
          ),
        start_time: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional ISO-8601 UTC start timestamp (e.g., '2026-11-22T00:00:00Z'). Max span is 31 days."
          ),
        end_time: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional ISO-8601 UTC end timestamp. Defaults to current server time."),
        device_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional sensor device ID filter (e.g., 'feather-s3-01')."),
        location: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional room or location filter (e.g., 'home-office')."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_HISTORY_LIMIT)
          .optional()
          .describe(
            `Maximum number of readings to return (1-${MAX_HISTORY_LIMIT}, default ${DEFAULT_HISTORY_LIMIT}).`
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ hours, start_time, end_time, device_id, location, limit }) => {
      try {
        const result = await service.getReadingsHistory({
          hours,
          start_time,
          end_time,
          device_id,
          location,
          limit,
        });
        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult("get_readings_history", error);
      }
    }
  );

  server.registerTool(
    "get_air_quality_summary",
    {
      title: "Get Air Quality Statistical Summary",
      description:
        "Computes server-side min, max, average, and 95th percentile (p95) statistics for CO2, PM2.5, PM10, temperature, humidity, and US EPA AQI over a standard period, plus threshold exceedance counts and grouped notable spike episodes (CO2 > 1000 ppm or PM2.5 > 9.0 ug/m3).",
      inputSchema: {
        period: z
          .enum(["1h", "6h", "24h", "7d", "30d"])
          .default("24h")
          .describe("Aggregation time window: '1h', '6h', '24h', '7d', or '30d' (default '24h')."),
        device_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional sensor device ID filter (e.g., 'feather-s3-01')."),
        location: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional room or location filter (e.g., 'home-office')."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ period, device_id, location }) => {
      try {
        const result = await service.getAirQualitySummary({
          period,
          device_id,
          location,
        });
        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult("get_air_quality_summary", error);
      }
    }
  );

  server.registerTool(
    "get_sensor_status",
    {
      title: "Get Sensor Fleet Health Status",
      description:
        "Inspects registered air quality sensors in the Firestore `devices` collection, reporting online (<=15 min), stale (16-60 min), or offline (>60 min) health relative to the expected 5-minute reporting interval, along with firmware version, attached sensors, and latest snapshot metrics.",
      inputSchema: {
        device_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional specific sensor device ID. Omit to list all registered sensors."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ device_id }) => {
      try {
        const result = await service.getSensorStatus({ device_id });
        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult("get_sensor_status", error);
      }
    }
  );

  server.registerTool(
    "get_outdoor_air_quality",
    {
      title: "Get Outdoor Weather & Air Quality",
      description:
        "Fetches the latest outdoor weather (temperature, feels-like, humidity, wind, conditions) and outdoor air quality (PM2.5, PM10, US EPA AQI, ozone, NO2) captured from Open-Meteo for the configured home location, plus optional recent outdoor history.",
      inputSchema: {
        hours: z
          .number()
          .min(1)
          .max(MAX_HISTORY_HOURS)
          .optional()
          .describe(
            `Optional lookback window in hours (1-${MAX_HISTORY_HOURS}) to also include chronological outdoor readings.`
          ),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Optional flag to force a fresh Open-Meteo fetch if home location is configured."
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ hours, refresh }) => {
      try {
        if (service.syncOutdoorReadingIfStale && refresh) {
          await service.syncOutdoorReadingIfStale({ force: true });
        }

        let latest = service.getLatestOutdoorReading
          ? await service.getLatestOutdoorReading()
          : null;

        if ((!latest || latest.is_stale) && service.syncOutdoorReadingIfStale) {
          const synced = await service.syncOutdoorReadingIfStale({ force: false });
          if (synced.synced) {
            latest = service.getLatestOutdoorReading
              ? await service.getLatestOutdoorReading()
              : latest;
          }
        }

        if (!latest) {
          return jsonToolResult({
            found: false,
            message:
              "No outdoor weather/AQI readings found yet. Configure Home Location in the Web Dashboard (site_configs/home) to enable automatic Open-Meteo tracking.",
          });
        }

        const history =
          hours !== undefined && service.getOutdoorReadingsHistory
            ? await service.getOutdoorReadingsHistory(hours, 100)
            : undefined;

        return jsonToolResult({
          found: true,
          ...latest,
          ...(history !== undefined ? { history_count: history.length, history } : {}),
        });
      } catch (error) {
        return errorToolResult("get_outdoor_air_quality", error);
      }
    }
  );
}
