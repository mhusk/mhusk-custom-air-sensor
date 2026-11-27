import type { IncomingMessage } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Firestore } from "firebase-admin/firestore";

import type { DashboardResponseCache } from "./cache.js";

import type {
  WorkosAuthConfig,
  WorkosAuthDependencies,
} from "../auth/workos.js";
import type {
  CreateExperimentInput,
  ExperimentRecord,
  HousePlaybookSummary,
  ListExperimentsOptions,
  UpdateExperimentInput,
} from "../services/experiments.js";
import type {
  AirQualitySummaryOptions,
  AirQualitySummaryResult,
  DeviceConfig,
  DeviceStatus,
  FirmwareReleaseManifest,
  LatestReadingOptions,
  LatestReadingResult,
  ReadingHealthContext,
  ReadingsHistoryOptions,
  ReadingsHistoryResult,
  SensorStatusOptions,
  SensorStatusResult,
  SummaryPeriod,
  UpdateDeviceConfigInput,
} from "../services/firestore.js";
import type {
  IndoorOutdoorDelta,
  LatestOutdoorForecastResult,
  LatestOutdoorReadingResult,
  OutdoorReading,
  SiteLocationConfig,
  UpdateSiteLocationConfigInput,
} from "../services/outdoor.js";

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
  getReadingsHistoryWithSummary?: (
    options?: ReadingsHistoryOptions & { period?: SummaryPeriod }
  ) => Promise<{ history: ReadingsHistoryResult; summary: AirQualitySummaryResult }>;
  getDeviceConfig: (deviceId: string) => Promise<DeviceConfig | null>;
  listDeviceConfigs: () => Promise<Record<string, DeviceConfig>>;
  updateDeviceConfig: (
    deviceId: string,
    input: UpdateDeviceConfigInput,
    updatedBy: string
  ) => Promise<DeviceConfig>;
  requestDeviceReboot: (deviceId: string, updatedBy: string) => Promise<DeviceConfig>;
  listFirmwareReleases: () => Promise<FirmwareReleaseManifest[]>;
  getFirmwareRelease: (version: string) => Promise<FirmwareReleaseManifest | null>;
  setDeviceTargetFirmwareVersion: (
    deviceId: string,
    targetVersion: string | null,
    updatedBy: string
  ) => Promise<DeviceConfig>;
  getSiteLocationConfig?: () => Promise<SiteLocationConfig | null>;
  updateSiteLocationConfig?: (
    input: UpdateSiteLocationConfigInput,
    updatedBy: string
  ) => Promise<SiteLocationConfig>;
  getLatestOutdoorReading?: () => Promise<LatestOutdoorReadingResult | null>;
  getLatestOutdoorForecast?: () => Promise<LatestOutdoorForecastResult | null>;
  getOutdoorReadingsHistory?: (
    hours?: number,
    limit?: number,
    options?: { forceTailCheck?: boolean }
  ) => Promise<OutdoorReading[]>;
  syncOutdoorReadingIfStale?: (options?: { force?: boolean }) => Promise<{
    synced: boolean;
    reason: string;
    reading: OutdoorReading | null;
  }>;
  listExperiments?: (options?: ListExperimentsOptions) => Promise<ExperimentRecord[]>;
  getExperiment?: (id: string) => Promise<ExperimentRecord | null>;
  createExperiment?: (input: CreateExperimentInput) => Promise<ExperimentRecord>;
  updateExperiment?: (
    id: string,
    input: UpdateExperimentInput
  ) => Promise<ExperimentRecord | null>;
  evaluateExperimentOutcome?: (
    id: string,
    options?: { force?: boolean }
  ) => Promise<ExperimentRecord | null>;
  getHousePlaybook?: () => Promise<HousePlaybookSummary>;
}

export type OtaRolloutStatus =
  | "up_to_date"
  | "pending"
  | "updating"
  | "rolled_back"
  | "error";

export interface DashboardDeviceOverviewItem {
  device: DeviceStatus;
  desired_config: DeviceConfig | null;
  config_sync_status: "synced" | "pending" | "local_defaults";
  ota_rollout_status: OtaRolloutStatus;
  health_context: ReadingHealthContext | null;
  outdoor_delta?: IndoorOutdoorDelta | null;
}

export interface HandleDashboardApiOptions {
  pathname: string;
  origin: string;
  authConfig: WorkosAuthConfig;
  authDeps?: WorkosAuthDependencies;
  db?: Firestore;
  dashboardService?: DashboardDataService;
  cache?: DashboardResponseCache;
}
