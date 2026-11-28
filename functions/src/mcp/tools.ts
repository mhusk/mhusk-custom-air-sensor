import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import {
  DEVICE_ID_REGEX,
  EXPERIMENT_ID_REGEX,
  createExperimentSchema,
  updateExperimentSchema,
} from "../api/schemas.js";
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
  EXPERIMENT_ACTION_TYPES,
  EXPERIMENT_STATUSES,
  MAX_LIST_EXPERIMENTS_LIMIT,
  createExperiment,
  getHousePlaybook,
  listExperiments,
  rankPlaybookRecommendations,
  updateExperiment,
  type CreateExperimentInput,
  type ExperimentRecord,
  type HousePlaybookSummary,
  type ListExperimentsOptions,
  type PlaybookPrimaryGoal,
  type UpdateExperimentInput,
} from "../services/experiments.js";
import {
  computeIndoorOutdoorDelta,
  computeVentilationEnergyTax,
  findBestVentilationWindows,
  getLatestOutdoorForecast,
  getLatestOutdoorReading,
  getOutdoorReadingsHistory,
  syncOutdoorReadingIfStale,
  type EnergyTaxTier,
  type LatestOutdoorForecastResult,
  type LatestOutdoorReadingResult,
  type OutdoorReading,
  type VentilationEnergyTax,
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
  getLatestOutdoorForecast?: () => Promise<LatestOutdoorForecastResult | null>;
  getOutdoorReadingsHistory?: (hours?: number, limit?: number) => Promise<OutdoorReading[]>;
  syncOutdoorReadingIfStale?: (options?: { force?: boolean }) => Promise<{
    synced: boolean;
    reason: string;
    reading: OutdoorReading | null;
  }>;
  listExperiments?: (options?: ListExperimentsOptions) => Promise<ExperimentRecord[]>;
  createExperiment?: (input: CreateExperimentInput) => Promise<ExperimentRecord>;
  updateExperiment?: (
    id: string,
    input: UpdateExperimentInput
  ) => Promise<ExperimentRecord | null>;
  getHousePlaybook?: () => Promise<HousePlaybookSummary>;
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
    getLatestOutdoorForecast: () => getLatestOutdoorForecast(resolveDb()),
    getOutdoorReadingsHistory: (hours, limit) =>
      getOutdoorReadingsHistory(hours, limit, resolveDb()),
    syncOutdoorReadingIfStale: (options) =>
      syncOutdoorReadingIfStale({ ...options, db: resolveDb() }),
    listExperiments: (options) => listExperiments(options, resolveDb()),
    createExperiment: (input) => createExperiment(input, resolveDb()),
    updateExperiment: (id, input) => updateExperiment(id, input, resolveDb()),
    getHousePlaybook: () => getHousePlaybook(resolveDb()),
  };
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
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

const slugInputSchema = z
  .string()
  .trim()
  .regex(
    DEVICE_ID_REGEX,
    "Must be 1-64 characters using only letters, numbers, hyphens, or underscores."
  );

const SAFE_VALIDATION_ERROR_RE =
  /^(Invalid ISO-8601 timestamp|Invalid (start_time|end_time)|'(start_time|end_time|ended_at|duration_minutes|device_id)' |Requested window exceeds|Unsupported '|Cannot evaluate )/;

function errorToolResult(toolName: string, error: unknown): CallToolResult {
  console.error(`[mcp] Tool '${toolName}' failed:`, error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage =
    error instanceof RangeError || SAFE_VALIDATION_ERROR_RE.test(rawMessage)
      ? rawMessage
      : "Internal server error while executing tool.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: `Tool '${toolName}' failed`,
            message: safeMessage,
          },
          null,
          2
        ),
      },
    ],
  };
}

const PLAYBOOK_PRIMARY_GOALS = ["lower_co2", "lower_pm2_5", "balanced"] as const;
const ENERGY_TAX_TIERS = ["free", "low", "moderate", "high"] as const;

const mcpUpdateExperimentSchema = updateExperimentSchema.extend({
  experiment_id: z
    .string()
    .trim()
    .regex(
      EXPERIMENT_ID_REGEX,
      "experiment_id must be 1-96 characters using letters, numbers, underscores, or hyphens."
    )
    .describe("Existing experiment id returned by log_experiment or list_experiments."),
});

const listExperimentsToolSchema = z
  .object({
    status: z
      .union([
        z.enum(EXPERIMENT_STATUSES),
        z.array(z.enum(EXPERIMENT_STATUSES)).min(1).max(EXPERIMENT_STATUSES.length),
      ])
      .optional()
      .describe(
        "Optional status filter: 'active', 'pending_evaluation', 'evaluated', 'unlabeled', or 'dismissed'. Pass one status or a short list."
      ),
    device_id: slugInputSchema
      .optional()
      .describe("Optional sensor device ID filter (e.g., 'feather-s3-01')."),
    location: slugInputSchema
      .optional()
      .describe("Optional room or location slug filter (e.g., 'home-office')."),
    action_type: z
      .enum(EXPERIMENT_ACTION_TYPES)
      .optional()
      .describe(
        "Optional action filter: crack_window, cross_ventilate, open_door, hepa_purifier, range_hood, hvac_fan, cooking, or custom."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_EXPERIMENTS_LIMIT)
      .optional()
      .describe(
        `Maximum experiments to return, newest first (1-${MAX_LIST_EXPERIMENTS_LIMIT}, default 50).`
      ),
  })
  .strict();

const housePlaybookToolSchema = z
  .object({
    device_id: slugInputSchema
      .optional()
      .describe("Optional indoor sensor whose latest reading supplies ranking context."),
    location: slugInputSchema
      .optional()
      .describe(
        "Optional room slug to prefer. When omitted, the latest indoor reading's location is used."
      ),
    energy_tax_tier: z
      .enum(ENERGY_TAX_TIERS)
      .optional()
      .describe(
        "Optional ventilation energy-tax tier to rank against. When omitted, the current indoor and outdoor readings supply it."
      ),
    primary_goal: z
      .enum(PLAYBOOK_PRIMARY_GOALS)
      .optional()
      .describe(
        "What to optimize: 'lower_co2' (default), 'lower_pm2_5', or 'balanced'. When omitted, elevated CO2 and PM2.5 on the latest indoor reading choose the goal."
      ),
  })
  .strict();

function createdByFromAuth(authInfo: AuthInfo | undefined): string {
  const email = authInfo?.extra?.email;
  if (typeof email !== "string") {
    return "mcp";
  }
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 320 || trimmed.includes("\n")) {
    return "mcp";
  }
  return trimmed;
}

function inferPlaybookPrimaryGoal(
  co2Ppm: number | null | undefined,
  pm25: number | null | undefined
): PlaybookPrimaryGoal {
  const co2High = typeof co2Ppm === "number" && co2Ppm > 1000;
  const pmHigh = typeof pm25 === "number" && pm25 > 9;
  if (co2High && pmHigh) {
    return "balanced";
  }
  if (pmHigh) {
    return "lower_pm2_5";
  }
  return "lower_co2";
}

interface PlaybookToolContext {
  device_id: string | null;
  location: string | null;
  energy_tax_tier: EnergyTaxTier | null;
  primary_goal: PlaybookPrimaryGoal;
  indoor: {
    co2_ppm: number;
    pm2_5_ug_m3: number;
    temperature_f: number;
    humidity_percent: number;
  } | null;
  current_energy_tax: VentilationEnergyTax | null;
}

async function resolvePlaybookToolContext(
  service: AirQualityDataService,
  args: z.infer<typeof housePlaybookToolSchema>
): Promise<PlaybookToolContext> {
  const indoorResult = await service.getLatestReading({
    device_id: args.device_id,
    location: args.location,
  });
  const outdoorResult = service.getLatestOutdoorReading
    ? await service.getLatestOutdoorReading().catch(() => null)
    : null;

  const indoor = indoorResult?.reading
    ? {
        co2_ppm: indoorResult.reading.co2_ppm,
        pm2_5_ug_m3: indoorResult.reading.pm2_5_ug_m3,
        temperature_f: indoorResult.reading.temperature_f,
        humidity_percent: indoorResult.reading.humidity_percent,
      }
    : null;

  const currentEnergyTax =
    indoor && outdoorResult?.reading
      ? computeVentilationEnergyTax(indoor, outdoorResult.reading)
      : null;

  const location = args.location ?? indoorResult?.reading.location ?? null;
  const energyTaxTier = args.energy_tax_tier ?? currentEnergyTax?.tier ?? null;
  const primaryGoal =
    args.primary_goal ??
    inferPlaybookPrimaryGoal(indoor?.co2_ppm, indoor?.pm2_5_ug_m3);

  return {
    device_id: args.device_id ?? indoorResult?.reading.device_id ?? null,
    location,
    energy_tax_tier: energyTaxTier,
    primary_goal: primaryGoal,
    indoor,
    current_energy_tax: currentEnergyTax,
  };
}

function registerExperimentMcpTools(
  server: McpServer,
  service: AirQualityDataService
): void {
  server.registerTool(
    "log_experiment",
    {
      title: "Log House Experiment",
      description:
        "Log a real house-physics experiment for a sensor: crack_window, cross_ventilate, open_door, hepa_purifier, range_hood, hvac_fan, cooking, or custom. Omit ended_at and duration_minutes to start an active experiment. Provide either to record a finished action as pending_evaluation, or evaluated immediately when the 20-minute post-settle window has already elapsed. Outdoor conditions and the ventilation energy-tax tier are captured automatically. This is an owner-allowlisted write (it does not delete history).",
      inputSchema: createExperimentSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (args, extra) => {
      try {
        if (!service.createExperiment) {
          return jsonToolResult({
            created: false,
            message: "Experiment logging is not enabled on this server.",
          });
        }
        const experiment = await service.createExperiment({
          ...args,
          source: "mcp",
          created_by: createdByFromAuth(extra.authInfo),
        });
        return jsonToolResult({
          created: true,
          experiment,
        });
      } catch (error) {
        return errorToolResult("log_experiment", error);
      }
    }
  );

  server.registerTool(
    "update_experiment",
    {
      title: "Update House Experiment",
      description:
        "Finish, label, or dismiss an existing experiment. Finish an active run by setting ended_at (ISO-8601) or duration_minutes (positive minutes). Label an unlabeled auto-detected event by setting action_type and an optional custom_label. Dismiss a candidate by setting status to 'dismissed'. This does not delete the experiment.",
      inputSchema: mcpUpdateExperimentSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ experiment_id, ...patch }) => {
      try {
        if (!service.updateExperiment) {
          return jsonToolResult({
            found: false,
            updated: false,
            experiment_id,
            message: "Experiment updates are not enabled on this server.",
          });
        }
        const experiment = await service.updateExperiment(experiment_id, patch);
        if (!experiment) {
          return jsonToolResult({
            found: false,
            updated: false,
            experiment_id,
            message: `Experiment '${experiment_id}' not found.`,
          });
        }
        return jsonToolResult({
          found: true,
          updated: true,
          experiment,
        });
      } catch (error) {
        return errorToolResult("update_experiment", error);
      }
    }
  );

  server.registerTool(
    "list_experiments",
    {
      title: "List House Experiments",
      description:
        "List recent logged and auto-detected house experiments, newest first. Filter by status (active, pending_evaluation, evaluated, unlabeled, dismissed), device, location, or action type. Use this to find an id before finish, label, or dismiss.",
      inputSchema: listExperimentsToolSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        if (!service.listExperiments) {
          return jsonToolResult({
            count: 0,
            experiments: [],
            message: "Experiment listing is not enabled on this server.",
          });
        }
        const experiments = await service.listExperiments({
          status: args.status,
          device_id: args.device_id,
          location: args.location,
          action_type: args.action_type,
          limit: args.limit,
        });
        return jsonToolResult({
          count: experiments.length,
          experiments,
        });
      } catch (error) {
        return errorToolResult("list_experiments", error);
      }
    }
  );

  server.registerTool(
    "get_house_playbook",
    {
      title: "Get House Physics Playbook",
      description:
        "Return the learned House Physics Playbook and rank house-proven actions for the current room and ventilation energy-tax tier. Pass location or device_id, and optionally energy_tax_tier or primary_goal (lower_co2, lower_pm2_5, balanced). When those are omitted, the latest indoor reading and outdoor snapshot supply the ranking context. Cite each recommendation's measured CO2, PM2.5, temperature, and humidity deltas, sample count, and confidence.",
      inputSchema: housePlaybookToolSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        if (!service.getHousePlaybook) {
          return jsonToolResult({
            found: false,
            has_history: false,
            recommendations: [],
            message: "House Physics Playbook is not enabled on this server.",
          });
        }
        const [playbook, context] = await Promise.all([
          service.getHousePlaybook(),
          resolvePlaybookToolContext(service, args),
        ]);
        const recommendations = rankPlaybookRecommendations(playbook, {
          ...(context.location ? { location: context.location } : {}),
          ...(context.energy_tax_tier ? { energy_tax_tier: context.energy_tax_tier } : {}),
          primary_goal: context.primary_goal,
        });
        return jsonToolResult({
          found: true,
          has_history: playbook.entries.length > 0,
          context,
          playbook,
          recommendations,
          ...(playbook.entries.length === 0
            ? {
                message:
                  "No evaluated house experiments yet. Log an experiment and wait for the 20-minute post-settle window before expecting measured recommendations.",
              }
            : {}),
        });
      } catch (error) {
        return errorToolResult("get_house_playbook", error);
      }
    }
  );
}

/**
 * Registers indoor, outdoor, forecast, and house-experiment MCP tools.
 * Write tools rely on the existing WorkOS owner allowlist (or owner bearer
 * fallback) that gates POST /mcp before a tool handler runs.
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
        device_id: slugInputSchema
          .optional()
          .describe("Optional sensor device ID (e.g., 'feather-s3-01'). Omit to query all sensors."),
        location: slugInputSchema
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
        device_id: slugInputSchema
          .optional()
          .describe("Optional sensor device ID filter (e.g., 'feather-s3-01')."),
        location: slugInputSchema
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
        device_id: slugInputSchema
          .optional()
          .describe("Optional sensor device ID filter (e.g., 'feather-s3-01')."),
        location: slugInputSchema
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
        device_id: slugInputSchema
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

  server.registerTool(
    "get_ventilation_forecast",
    {
      title: "Get Energy-Aware Ventilation Forecast",
      description:
        "Evaluates the current heating/cooling/dehumidification energy tax of opening a window (using dew point and moist-air enthalpy) and scans the cached 24-hour Open-Meteo hourly weather + AQI forecast to find the next clean, low-energy-tax ventilation window.",
      inputSchema: {
        device_id: slugInputSchema
          .optional()
          .describe("Optional indoor sensor device ID to use as the indoor temp/RH baseline."),
        location: slugInputSchema
          .optional()
          .describe("Optional room/location slug to use as the indoor temp/RH baseline."),
        refresh: z
          .boolean()
          .optional()
          .describe("Optional flag to force a fresh Open-Meteo forecast sync if configured."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ device_id, location, refresh }) => {
      try {
        if (service.syncOutdoorReadingIfStale && refresh) {
          await service.syncOutdoorReadingIfStale({ force: true });
        }

        const [latestIndoor, latestOutdoor, forecastResult] = await Promise.all([
          service.getLatestReading({ device_id, location }),
          service.getLatestOutdoorReading
            ? service.getLatestOutdoorReading().catch(() => null)
            : Promise.resolve(null),
          service.getLatestOutdoorForecast
            ? service.getLatestOutdoorForecast().catch(() => null)
            : Promise.resolve(null),
        ]);

        const indoorBaseline = latestIndoor?.reading
          ? {
              device_id: latestIndoor.reading.device_id,
              location: latestIndoor.reading.location,
              temperature_f: latestIndoor.reading.temperature_f,
              humidity_percent: latestIndoor.reading.humidity_percent,
            }
          : {
              device_id: null,
              location: null,
              temperature_f: 70.0,
              humidity_percent: 45.0,
            };

        const currentEnergyTax = latestOutdoor?.reading
          ? computeVentilationEnergyTax(indoorBaseline, latestOutdoor.reading)
          : null;

        if (!forecastResult) {
          return jsonToolResult({
            found: false,
            indoor_baseline: indoorBaseline,
            current_energy_tax: currentEnergyTax,
            message:
              "No 24-hour Open-Meteo forecast cached yet. Configure Home Location in the Web Dashboard or trigger an outdoor refresh.",
          });
        }

        const analysis = findBestVentilationWindows(indoorBaseline, forecastResult.forecast);
        return jsonToolResult({
          found: true,
          forecast_fetched_at: forecastResult.forecast.fetched_at,
          minutes_ago: forecastResult.minutes_ago,
          is_stale: forecastResult.is_stale,
          indoor_baseline: indoorBaseline,
          current_energy_tax: currentEnergyTax,
          next_best_window: analysis.next_best_window,
          lowest_tax_fallback_hour: analysis.lowest_tax_fallback_hour,
          windows: analysis.windows,
          scored_hours: analysis.scored_hours,
        });
      } catch (error) {
        return errorToolResult("get_ventilation_forecast", error);
      }
    }
  );

  registerExperimentMcpTools(server, service);
}
