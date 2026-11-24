import { getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

export const READINGS_COLLECTION = "readings";
export const DEVICES_COLLECTION = "devices";
export const DEVICE_CONFIGS_COLLECTION = "device_configs";
export const FIRMWARE_RELEASES_COLLECTION = "firmware_releases";
export const FIRMWARE_RELEASE_FILES_SUBCOLLECTION = "files";

export const SEMVER_VERSION_REGEX =
  /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]{0,19})?$/;
export const OTA_FILENAME_REGEX = /^[a-z][a-z0-9_]{0,31}\.py$/;
export const PROTECTED_FIRMWARE_FILES = new Set(["boot.py", "code.py", "settings.toml"]);
export const MAX_OTA_FILE_BYTES = 512 * 1024; // 512 KiB (safely below Firestore's 1 MiB doc limit)

export const DEFAULT_HISTORY_HOURS = 24;
export const MAX_HISTORY_HOURS = 168; // 7 days
export const MAX_EXPLICIT_WINDOW_DAYS = 31;
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 500;
export const MAX_HISTORY_SCAN_DOCS = 2500;
export const MAX_SUMMARY_SCAN_DOCS = 10000;
export const STALE_THRESHOLD_MINUTES = 15;
export const OFFLINE_THRESHOLD_MINUTES = 60;

// Health thresholds aligned with ASHRAE / Harvard cognitive CO2 studies and
// the revised 2024 US EPA PM2.5 AQI breakpoints (Good <= 9.0 ug/m3).
export const CO2_ELEVATED_PPM = 1000;
export const CO2_HIGH_PPM = 1400;
export const PM2_5_ELEVATED_UG_M3 = 9.0;
export const PM2_5_HIGH_UG_M3 = 35.4;

export type AqiCategory =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

export type SummaryPeriod = "1h" | "6h" | "24h" | "7d" | "30d";

export const SUMMARY_PERIOD_MS: Record<SummaryPeriod, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface AirQualityReading {
  id: string;
  device_id: string;
  location: string;
  timestamp: string;
  co2_ppm: number;
  temperature_c: number;
  temperature_f: number;
  humidity_percent: number;
  pm1_0_ug_m3: number;
  pm2_5_ug_m3: number;
  pm10_0_ug_m3: number;
  aqi_us: number;
  aqi_category: AqiCategory;
  particles_0_3um: number;
  particles_0_5um: number;
  particles_1_0um: number;
  particles_2_5um: number;
  particles_5_0um: number;
  particles_10_0um: number;
}

export interface DeviceLatestReadingSnapshot {
  co2_ppm: number;
  temperature_f: number;
  humidity_percent: number;
  pm2_5_ug_m3: number;
  aqi_us: number;
  aqi_category: AqiCategory;
}

export type OtaStatus = "up_to_date" | "updating" | "rolled_back" | "error";

const VALID_OTA_STATUSES = new Set<OtaStatus>([
  "up_to_date",
  "updating",
  "rolled_back",
  "error",
]);

export interface DeviceStatus {
  device_id: string;
  location: string;
  last_seen_at: string;
  minutes_since_last_seen: number;
  status: "online" | "stale" | "offline";
  is_online: boolean;
  is_stale: boolean;
  firmware_version: string;
  sensors: string[];
  reporting_interval_seconds: number;
  latest_reading: DeviceLatestReadingSnapshot | null;
  config_version?: number | null;
  temperature_offset_c?: number | null;
  altitude_m?: number | null;
  led_enabled?: boolean | null;
  ota_status?: OtaStatus | null;
  ota_target_version?: string | null;
  ota_last_error?: string | null;
}

export interface DeviceConfig {
  device_id: string;
  location: string;
  reporting_interval_seconds: number;
  temperature_offset_c: number;
  altitude_m: number;
  led_enabled: boolean;
  config_version: number;
  reboot_requested_at: string | null;
  target_firmware_version: string | null;
  updated_at: string;
  updated_by: string;
}

export type FirmwareReleaseStatus = "active" | "yanked";

export interface FirmwareReleaseFileEntry {
  doc_id: string;
  sha256: string;
  size_bytes: number;
}

export interface FirmwareReleaseManifest {
  version: string;
  min_bootloader_version: string;
  notes: string;
  file_count: number;
  total_size_bytes: number;
  files: Record<string, FirmwareReleaseFileEntry>;
  created_at: string;
  created_by: string;
  git_sha: string | null;
  status: FirmwareReleaseStatus;
}

export interface FirmwareReleaseFileArtifact {
  filename: string;
  version: string;
  sha256: string;
  size_bytes: number;
  encoding: "utf-8";
  content: string;
  created_at: string;
}

export interface UpdateDeviceConfigInput {
  location: string;
  reporting_interval_seconds: number;
  temperature_offset_c: number;
  altitude_m: number;
  led_enabled: boolean;
}

export interface ReadingHealthContext {
  co2_level: "optimal" | "acceptable" | "elevated" | "poor";
  co2_note: string;
  pm2_5_level: "good" | "moderate" | "unhealthy_sensitive" | "unhealthy";
  pm2_5_note: string;
  humidity_level: "dry" | "ideal" | "humid";
  humidity_note: string;
}

export interface LatestReadingOptions {
  device_id?: string;
  location?: string;
  now?: Date;
}

export interface LatestReadingResult {
  reading: AirQualityReading;
  device: DeviceStatus | null;
  minutes_ago: number;
  is_stale: boolean;
  health_context: ReadingHealthContext;
}

export interface ReadingsHistoryOptions {
  hours?: number;
  start_time?: string;
  end_time?: string;
  device_id?: string;
  location?: string;
  limit?: number;
  now?: Date;
}

export interface ReadingsHistoryResult {
  window_start: string;
  window_end: string;
  filters: {
    device_id: string | null;
    location: string | null;
  };
  total_matching: number;
  returned_count: number;
  downsampled: boolean;
  scan_capped: boolean;
  readings: AirQualityReading[];
}

export interface MetricStats {
  min: number;
  max: number;
  avg: number;
  p95: number;
}

export interface NotableSpike {
  metric: "co2_ppm" | "pm2_5_ug_m3";
  unit: "ppm" | "ug/m3";
  threshold: number;
  severity: "elevated" | "high";
  peak_value: number;
  peak_timestamp: string;
  started_at: string;
  ended_at: string;
  reading_count: number;
  device_id: string;
  location: string;
}

export interface ThresholdExceedances {
  co2_above_1000_ppm_count: number;
  co2_above_1000_ppm_percent: number;
  co2_above_1400_ppm_count: number;
  pm2_5_above_9_ug_m3_count: number;
  pm2_5_above_9_ug_m3_percent: number;
  pm2_5_above_35_4_ug_m3_count: number;
}

export interface AirQualitySummaryOptions {
  period: SummaryPeriod;
  device_id?: string;
  location?: string;
  now?: Date;
}

export interface AirQualitySummaryResult {
  period: SummaryPeriod;
  window_start: string;
  window_end: string;
  filters: {
    device_id: string | null;
    location: string | null;
  };
  sample_count: number;
  scan_capped: boolean;
  metrics: {
    co2_ppm: MetricStats;
    pm2_5_ug_m3: MetricStats;
    pm10_0_ug_m3: MetricStats;
    temperature_f: MetricStats;
    temperature_c: MetricStats;
    humidity_percent: MetricStats;
    aqi_us: MetricStats;
  } | null;
  threshold_exceedances: ThresholdExceedances;
  notable_spikes: NotableSpike[];
}

export interface SensorStatusOptions {
  device_id?: string;
  now?: Date;
}

export interface SensorStatusResult {
  checked_at: string;
  stale_threshold_minutes: number;
  device_count: number;
  online_count: number;
  stale_or_offline_count: number;
  devices: DeviceStatus[];
}

/**
 * Lazily initializes Firebase Admin and returns the default Firestore instance.
 * Inside Cloud Functions 2nd Gen, credentials and project ID are injected automatically.
 */
export function getDb(options?: AppOptions): Firestore {
  if (getApps().length === 0) {
    const projectId =
      options?.projectId ??
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.FIREBASE_PROJECT_ID;

    if (projectId || options) {
      initializeApp({ ...options, ...(projectId ? { projectId } : {}) });
    } else {
      initializeApp();
    }
  }
  return getFirestore();
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeTimestampToDate(value: unknown): Date {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(0);
}

function parseIsoDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp for '${fieldName}': ${value}`);
  }
  return parsed;
}

function minutesBetween(older: Date, newer: Date): number {
  const diffMs = Math.max(0, newer.getTime() - older.getTime());
  return roundTo(diffMs / 60000, 1);
}

function mapReadingSnapshot(doc: QueryDocumentSnapshot<DocumentData>): AirQualityReading {
  const data = doc.data();
  const timestampDate = normalizeTimestampToDate(data.timestamp);

  return {
    id: doc.id,
    device_id: asString(data.device_id),
    location: asString(data.location),
    timestamp: timestampDate.toISOString(),
    co2_ppm: asNumber(data.co2_ppm),
    temperature_c: asNumber(data.temperature_c),
    temperature_f: asNumber(data.temperature_f),
    humidity_percent: asNumber(data.humidity_percent),
    pm1_0_ug_m3: asNumber(data.pm1_0_ug_m3),
    pm2_5_ug_m3: asNumber(data.pm2_5_ug_m3),
    pm10_0_ug_m3: asNumber(data.pm10_0_ug_m3),
    aqi_us: asNumber(data.aqi_us),
    aqi_category: asString(data.aqi_category, "Good") as AqiCategory,
    particles_0_3um: asNumber(data.particles_0_3um),
    particles_0_5um: asNumber(data.particles_0_5um),
    particles_1_0um: asNumber(data.particles_1_0um),
    particles_2_5um: asNumber(data.particles_2_5um),
    particles_5_0um: asNumber(data.particles_5_0um),
    particles_10_0um: asNumber(data.particles_10_0um),
  };
}

function mapDeviceData(docId: string, data: DocumentData, now: Date): DeviceStatus {
  const lastSeenDate = normalizeTimestampToDate(data.last_seen_at);
  const minutesSince = minutesBetween(lastSeenDate, now);

  let status: DeviceStatus["status"] = "online";
  if (minutesSince > OFFLINE_THRESHOLD_MINUTES) {
    status = "offline";
  } else if (minutesSince > STALE_THRESHOLD_MINUTES) {
    status = "stale";
  }

  const latestRaw =
    typeof data.latest_reading === "object" && data.latest_reading !== null
      ? (data.latest_reading as Record<string, unknown>)
      : null;

  const latestReading: DeviceLatestReadingSnapshot | null = latestRaw
    ? {
        co2_ppm: asNumber(latestRaw.co2_ppm),
        temperature_f: asNumber(latestRaw.temperature_f),
        humidity_percent: asNumber(latestRaw.humidity_percent),
        pm2_5_ug_m3: asNumber(latestRaw.pm2_5_ug_m3),
        aqi_us: asNumber(latestRaw.aqi_us),
        aqi_category: asString(latestRaw.aqi_category, "Good") as AqiCategory,
      }
    : null;

  const sensors = Array.isArray(data.sensors)
    ? data.sensors.filter((item): item is string => typeof item === "string")
    : [];

  return {
    device_id: asString(data.device_id, docId),
    location: asString(data.location),
    last_seen_at: lastSeenDate.toISOString(),
    minutes_since_last_seen: minutesSince,
    status,
    is_online: status === "online",
    is_stale: status !== "online",
    firmware_version: asString(data.firmware_version, "unknown"),
    sensors,
    reporting_interval_seconds: asNumber(data.reporting_interval_seconds, 300),
    latest_reading: latestReading,
    config_version:
      typeof data.config_version === "number" && Number.isFinite(data.config_version)
        ? Math.trunc(data.config_version)
        : null,
    temperature_offset_c:
      typeof data.temperature_offset_c === "number" &&
      Number.isFinite(data.temperature_offset_c)
        ? roundTo(data.temperature_offset_c, 2)
        : null,
    altitude_m:
      typeof data.altitude_m === "number" && Number.isFinite(data.altitude_m)
        ? Math.round(data.altitude_m)
        : null,
    led_enabled: typeof data.led_enabled === "boolean" ? data.led_enabled : null,
    ota_status:
      typeof data.ota_status === "string" &&
      VALID_OTA_STATUSES.has(data.ota_status as OtaStatus)
        ? (data.ota_status as OtaStatus)
        : null,
    ota_target_version:
      typeof data.ota_target_version === "string" &&
      data.ota_target_version.trim().length > 0
        ? data.ota_target_version.trim()
        : null,
    ota_last_error:
      typeof data.ota_last_error === "string" &&
      data.ota_last_error.trim().length > 0
        ? data.ota_last_error.trim()
        : null,
  };
}

function mapDeviceConfigData(docId: string, data: DocumentData): DeviceConfig {
  const updatedAtDate = normalizeTimestampToDate(data.updated_at);
  const rebootRequestedAt =
    data.reboot_requested_at !== undefined && data.reboot_requested_at !== null
      ? normalizeTimestampToDate(data.reboot_requested_at).toISOString()
      : null;
  const targetFirmwareVersion =
    typeof data.target_firmware_version === "string" &&
    data.target_firmware_version.trim().length > 0
      ? data.target_firmware_version.trim()
      : null;

  return {
    device_id: asString(data.device_id, docId),
    location: asString(data.location, "home-office"),
    reporting_interval_seconds: Math.round(asNumber(data.reporting_interval_seconds, 300)),
    temperature_offset_c: roundTo(asNumber(data.temperature_offset_c, 4.0), 2),
    altitude_m: Math.round(asNumber(data.altitude_m, 0)),
    led_enabled: typeof data.led_enabled === "boolean" ? data.led_enabled : true,
    config_version: Math.max(1, Math.trunc(asNumber(data.config_version, 1))),
    reboot_requested_at: rebootRequestedAt,
    target_firmware_version: targetFirmwareVersion,
    updated_at: updatedAtDate.toISOString(),
    updated_by: asString(data.updated_by, "unknown"),
  };
}

export function isValidFirmwareVersion(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 5 &&
    value.length <= 32 &&
    SEMVER_VERSION_REGEX.test(value)
  );
}

export function isValidOtaFilename(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 35 &&
    OTA_FILENAME_REGEX.test(value) &&
    !PROTECTED_FIRMWARE_FILES.has(value)
  );
}

function mapFirmwareReleaseManifest(
  docId: string,
  data: DocumentData
): FirmwareReleaseManifest {
  const createdAtDate = normalizeTimestampToDate(data.created_at);
  const files: Record<string, FirmwareReleaseFileEntry> = {};

  if (typeof data.files === "object" && data.files !== null && !Array.isArray(data.files)) {
    for (const [filename, rawEntry] of Object.entries(
      data.files as Record<string, unknown>
    )) {
      if (typeof rawEntry === "object" && rawEntry !== null) {
        const entry = rawEntry as Record<string, unknown>;
        files[filename] = {
          doc_id: asString(entry.doc_id, filename),
          sha256: asString(entry.sha256),
          size_bytes: Math.max(0, Math.trunc(asNumber(entry.size_bytes, 0))),
        };
      }
    }
  }

  const fileEntries = Object.values(files);
  const status: FirmwareReleaseStatus = data.status === "yanked" ? "yanked" : "active";

  return {
    version: asString(data.version, docId),
    min_bootloader_version: asString(data.min_bootloader_version, "1.0.0"),
    notes: asString(data.notes, ""),
    file_count: Math.max(
      fileEntries.length,
      Math.trunc(asNumber(data.file_count, fileEntries.length))
    ),
    total_size_bytes: Math.max(
      0,
      Math.trunc(
        asNumber(
          data.total_size_bytes,
          fileEntries.reduce((acc, item) => acc + item.size_bytes, 0)
        )
      )
    ),
    files,
    created_at: createdAtDate.toISOString(),
    created_by: asString(data.created_by, "publish-cli"),
    git_sha:
      typeof data.git_sha === "string" && data.git_sha.trim().length > 0
        ? data.git_sha.trim()
        : null,
    status,
  };
}

function mapFirmwareReleaseFileArtifact(
  docId: string,
  version: string,
  data: DocumentData
): FirmwareReleaseFileArtifact {
  const createdAtDate = normalizeTimestampToDate(data.created_at);
  return {
    filename: asString(data.filename, docId),
    version: asString(data.version, version),
    sha256: asString(data.sha256),
    size_bytes: Math.max(0, Math.trunc(asNumber(data.size_bytes, 0))),
    encoding: "utf-8",
    content: asString(data.content),
    created_at: createdAtDate.toISOString(),
  };
}

/**
 * Computes min, max, average, and 95th percentile (linear interpolation) for a numeric series.
 */
export function computeMetricStats(values: number[], decimals = 1): MetricStats {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0, p95: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = sum / sorted.length;

  const pos = (sorted.length - 1) * 0.95;
  const lowerIdx = Math.floor(pos);
  const upperIdx = Math.ceil(pos);
  const fraction = pos - lowerIdx;
  const p95 =
    lowerIdx === upperIdx
      ? sorted[lowerIdx]
      : sorted[lowerIdx] + (sorted[upperIdx] - sorted[lowerIdx]) * fraction;

  return {
    min: roundTo(min, decimals),
    max: roundTo(max, decimals),
    avg: roundTo(avg, decimals),
    p95: roundTo(p95, decimals),
  };
}

/**
 * Evenly downsamples an ordered array to at most `maxPoints` elements,
 * always preserving the first and last observations.
 */
export function downsampleReadings<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) {
    return [];
  }
  if (items.length <= maxPoints) {
    return [...items];
  }
  if (maxPoints === 1) {
    return [items[items.length - 1]];
  }

  const result: T[] = [];
  const step = (items.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    result.push(items[idx]);
  }
  return result;
}

/**
 * Produces human-readable indoor air quality health context for a single reading.
 */
export function assessReadingHealth(reading: AirQualityReading): ReadingHealthContext {
  let co2_level: ReadingHealthContext["co2_level"];
  let co2_note: string;
  if (reading.co2_ppm < 800) {
    co2_level = "optimal";
    co2_note = "Well ventilated; optimal cognitive performance range (<800 ppm).";
  } else if (reading.co2_ppm <= CO2_ELEVATED_PPM) {
    co2_level = "acceptable";
    co2_note = "Acceptable indoor ventilation (800-1000 ppm); consider fresh air if rising.";
  } else if (reading.co2_ppm <= CO2_HIGH_PPM) {
    co2_level = "elevated";
    co2_note = "Elevated CO2 (1001-1400 ppm); mild drowsiness or reduced focus possible—open a window.";
  } else {
    co2_level = "poor";
    co2_note = "Poor ventilation (>1400 ppm); ventilate the room promptly.";
  }

  let pm2_5_level: ReadingHealthContext["pm2_5_level"];
  let pm2_5_note: string;
  if (reading.pm2_5_ug_m3 <= PM2_5_ELEVATED_UG_M3) {
    pm2_5_level = "good";
    pm2_5_note = "Low fine particulate matter (<=9.0 ug/m3, 2024 US EPA Good range).";
  } else if (reading.pm2_5_ug_m3 <= PM2_5_HIGH_UG_M3) {
    pm2_5_level = "moderate";
    pm2_5_note = "Moderate fine particles (9.1-35.4 ug/m3); running a HEPA purifier can help.";
  } else if (reading.pm2_5_ug_m3 <= 55.4) {
    pm2_5_level = "unhealthy_sensitive";
    pm2_5_note = "Elevated particles (Unhealthy for Sensitive Groups); run filtration and check sources.";
  } else {
    pm2_5_level = "unhealthy";
    pm2_5_note = "High particulate concentration (>55.4 ug/m3); run HEPA filtration and minimize smoke/dust.";
  }

  let humidity_level: ReadingHealthContext["humidity_level"];
  let humidity_note: string;
  if (reading.humidity_percent < 30) {
    humidity_level = "dry";
    humidity_note = "Dry indoor air (<30% RH); may irritate airways or dry skin.";
  } else if (reading.humidity_percent <= 50) {
    humidity_level = "ideal";
    humidity_note = "Ideal indoor relative humidity (30%-50% RH).";
  } else {
    humidity_level = "humid";
    humidity_note = "Elevated indoor humidity (>50% RH); sustained >60% increases mold/dust-mite risk.";
  }

  return {
    co2_level,
    co2_note,
    pm2_5_level,
    pm2_5_note,
    humidity_level,
    humidity_note,
  };
}

function collectSpikesForMetric(
  readingsAsc: AirQualityReading[],
  metric: "co2_ppm" | "pm2_5_ug_m3",
  unit: "ppm" | "ug/m3",
  elevatedThreshold: number,
  highThreshold: number
): NotableSpike[] {
  const spikes: NotableSpike[] = [];
  let active: NotableSpike | null = null;

  for (const reading of readingsAsc) {
    const value = reading[metric];
    if (value > elevatedThreshold) {
      const severity: NotableSpike["severity"] =
        value >= highThreshold ? "high" : "elevated";

      if (active && active.device_id === reading.device_id) {
        active.ended_at = reading.timestamp;
        active.reading_count += 1;
        if (value > active.peak_value) {
          active.peak_value = roundTo(value, 1);
          active.peak_timestamp = reading.timestamp;
        }
        if (severity === "high") {
          active.severity = "high";
        }
      } else {
        if (active) {
          spikes.push(active);
        }
        active = {
          metric,
          unit,
          threshold: elevatedThreshold,
          severity,
          peak_value: roundTo(value, 1),
          peak_timestamp: reading.timestamp,
          started_at: reading.timestamp,
          ended_at: reading.timestamp,
          reading_count: 1,
          device_id: reading.device_id,
          location: reading.location,
        };
      }
    } else if (active) {
      spikes.push(active);
      active = null;
    }
  }

  if (active) {
    spikes.push(active);
  }
  return spikes;
}

/**
 * Groups contiguous elevated CO2 (>1000 ppm) and PM2.5 (>9.0 ug/m3) readings into
 * concise spike episodes with peak values and timestamps.
 */
export function detectNotableSpikes(
  readingsAsc: AirQualityReading[],
  maxSpikes = 20
): NotableSpike[] {
  const co2Spikes = collectSpikesForMetric(
    readingsAsc,
    "co2_ppm",
    "ppm",
    CO2_ELEVATED_PPM,
    CO2_HIGH_PPM
  );
  const pm25Spikes = collectSpikesForMetric(
    readingsAsc,
    "pm2_5_ug_m3",
    "ug/m3",
    PM2_5_ELEVATED_UG_M3,
    PM2_5_HIGH_UG_M3
  );

  return [...co2Spikes, ...pm25Spikes]
    .sort((a, b) => b.peak_timestamp.localeCompare(a.peak_timestamp))
    .slice(0, maxSpikes);
}

/**
 * Builds an index-aligned Firestore query against `readings` using the composite
 * indexes defined in `firestore.indexes.json`:
 *   - (device_id ASC, timestamp DESC)
 *   - (location ASC, timestamp DESC)
 * When both `device_id` and `location` are supplied, queries by `device_id`
 * and filters `location` in memory so no 3-field composite index is required.
 */
function buildReadingsQuery(
  db: Firestore,
  filters: {
    device_id?: string;
    location?: string;
    startDate?: Date;
    endDate?: Date;
    limit: number;
  }
): { query: Query<DocumentData>; postFilterLocation: string | null } {
  let query: Query<DocumentData> = db.collection(READINGS_COLLECTION);
  let postFilterLocation: string | null = null;

  if (filters.device_id) {
    query = query.where("device_id", "==", filters.device_id);
    if (filters.location) {
      postFilterLocation = filters.location;
    }
  } else if (filters.location) {
    query = query.where("location", "==", filters.location);
  }

  if (filters.startDate) {
    query = query.where("timestamp", ">=", Timestamp.fromDate(filters.startDate));
  }
  if (filters.endDate) {
    query = query.where("timestamp", "<=", Timestamp.fromDate(filters.endDate));
  }

  query = query.orderBy("timestamp", "desc").limit(filters.limit);
  return { query, postFilterLocation };
}

/**
 * Fetches the most recent air quality reading along with its device metadata
 * and qualitative health context.
 */
export async function getLatestReading(
  options: LatestReadingOptions = {},
  db: Firestore = getDb()
): Promise<LatestReadingResult | null> {
  const now = options.now ?? new Date();
  const fetchLimit = options.device_id && options.location ? 25 : 1;

  const { query, postFilterLocation } = buildReadingsQuery(db, {
    device_id: options.device_id,
    location: options.location,
    limit: fetchLimit,
  });

  const snapshot = await query.get();
  if (snapshot.empty) {
    return null;
  }

  let matchedDoc: QueryDocumentSnapshot<DocumentData> | undefined;
  if (postFilterLocation) {
    matchedDoc = snapshot.docs.find(
      (doc) => doc.data().location === postFilterLocation
    );
  } else {
    matchedDoc = snapshot.docs[0];
  }

  if (!matchedDoc) {
    return null;
  }

  const reading = mapReadingSnapshot(matchedDoc);
  const readingDate = new Date(reading.timestamp);
  const minutesAgo = minutesBetween(readingDate, now);

  let device: DeviceStatus | null = null;
  if (reading.device_id) {
    const deviceDoc = await db
      .collection(DEVICES_COLLECTION)
      .doc(reading.device_id)
      .get();
    if (deviceDoc.exists && deviceDoc.data()) {
      device = mapDeviceData(deviceDoc.id, deviceDoc.data()!, now);
    }
  }

  return {
    reading,
    device,
    minutes_ago: minutesAgo,
    is_stale: minutesAgo > STALE_THRESHOLD_MINUTES,
    health_context: assessReadingHealth(reading),
  };
}

/**
 * Queries historical time-series readings over a requested time window and
 * optionally downsamples evenly so responses stay compact for AI assistants.
 */
export async function getReadingsHistory(
  options: ReadingsHistoryOptions = {},
  db: Firestore = getDb()
): Promise<ReadingsHistoryResult> {
  const now = options.now ?? new Date();
  const endDate = options.end_time
    ? parseIsoDate(options.end_time, "end_time")
    : now;

  let startDate: Date;
  if (options.start_time) {
    startDate = parseIsoDate(options.start_time, "start_time");
    if (startDate.getTime() > endDate.getTime()) {
      throw new Error("'start_time' must be earlier than or equal to 'end_time'.");
    }
    const maxWindowMs = MAX_EXPLICIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (endDate.getTime() - startDate.getTime() > maxWindowMs) {
      throw new Error(
        `Requested window exceeds the ${MAX_EXPLICIT_WINDOW_DAYS}-day maximum.`
      );
    }
  } else {
    const requestedHours = options.hours ?? DEFAULT_HISTORY_HOURS;
    const clampedHours = Math.min(
      Math.max(requestedHours, 1),
      MAX_HISTORY_HOURS
    );
    startDate = new Date(endDate.getTime() - clampedHours * 60 * 60 * 1000);
  }

  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT), 1),
    MAX_HISTORY_LIMIT
  );

  const { query, postFilterLocation } = buildReadingsQuery(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate,
    limit: MAX_HISTORY_SCAN_DOCS,
  });

  const snapshot = await query.get();
  const scanCapped = snapshot.size >= MAX_HISTORY_SCAN_DOCS;

  let readings = snapshot.docs.map(mapReadingSnapshot);
  if (postFilterLocation) {
    readings = readings.filter((r) => r.location === postFilterLocation);
  }

  // Reverse from Firestore DESC order into chronological ASC order for trend reading.
  readings.reverse();

  const totalMatching = readings.length;
  const downsampled = totalMatching > limit;
  const returnedReadings = downsampled
    ? downsampleReadings(readings, limit)
    : readings;

  return {
    window_start: startDate.toISOString(),
    window_end: endDate.toISOString(),
    filters: {
      device_id: options.device_id ?? null,
      location: options.location ?? null,
    },
    total_matching: totalMatching,
    returned_count: returnedReadings.length,
    downsampled,
    scan_capped: scanCapped,
    readings: returnedReadings,
  };
}

/**
 * Computes statistical aggregations (min, max, average, p95), threshold
 * exceedance counts, and notable spike episodes for a standard period.
 */
export async function getAirQualitySummary(
  options: AirQualitySummaryOptions,
  db: Firestore = getDb()
): Promise<AirQualitySummaryResult> {
  const periodMs = SUMMARY_PERIOD_MS[options.period];
  if (!periodMs) {
    throw new Error(`Unsupported summary period: ${String(options.period)}`);
  }

  const now = options.now ?? new Date();
  const startDate = new Date(now.getTime() - periodMs);

  const { query, postFilterLocation } = buildReadingsQuery(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate: now,
    limit: MAX_SUMMARY_SCAN_DOCS,
  });

  const snapshot = await query.get();
  const scanCapped = snapshot.size >= MAX_SUMMARY_SCAN_DOCS;

  let readings = snapshot.docs.map(mapReadingSnapshot);
  if (postFilterLocation) {
    readings = readings.filter((r) => r.location === postFilterLocation);
  }
  readings.reverse();

  const sampleCount = readings.length;
  if (sampleCount === 0) {
    return {
      period: options.period,
      window_start: startDate.toISOString(),
      window_end: now.toISOString(),
      filters: {
        device_id: options.device_id ?? null,
        location: options.location ?? null,
      },
      sample_count: 0,
      scan_capped: scanCapped,
      metrics: null,
      threshold_exceedances: {
        co2_above_1000_ppm_count: 0,
        co2_above_1000_ppm_percent: 0,
        co2_above_1400_ppm_count: 0,
        pm2_5_above_9_ug_m3_count: 0,
        pm2_5_above_9_ug_m3_percent: 0,
        pm2_5_above_35_4_ug_m3_count: 0,
      },
      notable_spikes: [],
    };
  }

  const co2Above1000 = readings.filter((r) => r.co2_ppm > CO2_ELEVATED_PPM).length;
  const co2Above1400 = readings.filter((r) => r.co2_ppm > CO2_HIGH_PPM).length;
  const pm25Above9 = readings.filter((r) => r.pm2_5_ug_m3 > PM2_5_ELEVATED_UG_M3).length;
  const pm25Above35_4 = readings.filter((r) => r.pm2_5_ug_m3 > PM2_5_HIGH_UG_M3).length;

  return {
    period: options.period,
    window_start: startDate.toISOString(),
    window_end: now.toISOString(),
    filters: {
      device_id: options.device_id ?? null,
      location: options.location ?? null,
    },
    sample_count: sampleCount,
    scan_capped: scanCapped,
    metrics: {
      co2_ppm: computeMetricStats(readings.map((r) => r.co2_ppm), 0),
      pm2_5_ug_m3: computeMetricStats(readings.map((r) => r.pm2_5_ug_m3), 1),
      pm10_0_ug_m3: computeMetricStats(readings.map((r) => r.pm10_0_ug_m3), 1),
      temperature_f: computeMetricStats(readings.map((r) => r.temperature_f), 1),
      temperature_c: computeMetricStats(readings.map((r) => r.temperature_c), 1),
      humidity_percent: computeMetricStats(readings.map((r) => r.humidity_percent), 1),
      aqi_us: computeMetricStats(readings.map((r) => r.aqi_us), 0),
    },
    threshold_exceedances: {
      co2_above_1000_ppm_count: co2Above1000,
      co2_above_1000_ppm_percent: roundTo((co2Above1000 / sampleCount) * 100, 1),
      co2_above_1400_ppm_count: co2Above1400,
      pm2_5_above_9_ug_m3_count: pm25Above9,
      pm2_5_above_9_ug_m3_percent: roundTo((pm25Above9 / sampleCount) * 100, 1),
      pm2_5_above_35_4_ug_m3_count: pm25Above35_4,
    },
    notable_spikes: detectNotableSpikes(readings),
  };
}

/**
 * Checks registered sensor devices in `devices`, reporting online/stale/offline
 * health relative to the expected 5-minute reporting cadence.
 */
export async function getSensorStatus(
  options: SensorStatusOptions = {},
  db: Firestore = getDb()
): Promise<SensorStatusResult> {
  const now = options.now ?? new Date();
  const devices: DeviceStatus[] = [];

  if (options.device_id) {
    const doc = await db.collection(DEVICES_COLLECTION).doc(options.device_id).get();
    if (doc.exists && doc.data()) {
      devices.push(mapDeviceData(doc.id, doc.data()!, now));
    }
  } else {
    const snapshot = await db.collection(DEVICES_COLLECTION).get();
    for (const doc of snapshot.docs) {
      devices.push(mapDeviceData(doc.id, doc.data(), now));
    }
    devices.sort((a, b) => a.device_id.localeCompare(b.device_id));
  }

  const onlineCount = devices.filter((d) => d.is_online).length;

  return {
    checked_at: now.toISOString(),
    stale_threshold_minutes: STALE_THRESHOLD_MINUTES,
    device_count: devices.length,
    online_count: onlineCount,
    stale_or_offline_count: devices.length - onlineCount,
    devices,
  };
}

/**
 * Fetches a single device's desired remote configuration from `device_configs/{deviceId}`.
 */
export async function getDeviceConfig(
  deviceId: string,
  db: Firestore = getDb()
): Promise<DeviceConfig | null> {
  const doc = await db.collection(DEVICE_CONFIGS_COLLECTION).doc(deviceId).get();
  if (!doc.exists || !doc.data()) {
    return null;
  }
  return mapDeviceConfigData(doc.id, doc.data()!);
}

/**
 * Lists all desired remote configurations keyed by `device_id`.
 */
export async function listDeviceConfigs(
  db: Firestore = getDb()
): Promise<Record<string, DeviceConfig>> {
  const snapshot = await db.collection(DEVICE_CONFIGS_COLLECTION).get();
  const configs: Record<string, DeviceConfig> = {};
  for (const doc of snapshot.docs) {
    const mapped = mapDeviceConfigData(doc.id, doc.data());
    configs[mapped.device_id] = mapped;
  }
  return configs;
}

/**
 * Atomically updates `device_configs/{deviceId}` and increments `config_version`.
 * Preserves any existing `reboot_requested_at` timestamp so a pending reboot is not lost.
 */
export async function updateDeviceConfig(
  deviceId: string,
  input: UpdateDeviceConfigInput,
  updatedBy: string,
  db: Firestore = getDb()
): Promise<DeviceConfig> {
  const ref = db.collection(DEVICE_CONFIGS_COLLECTION).doc(deviceId);
  const nowTs = Timestamp.now();

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    const existingData = existing.exists ? existing.data() : undefined;
    const prevVersion =
      existingData && typeof existingData.config_version === "number"
        ? Math.trunc(existingData.config_version)
        : 0;
    const nextVersion = Math.min(1_000_000, Math.max(1, prevVersion + 1));

    const payload = {
      device_id: deviceId,
      location: input.location,
      reporting_interval_seconds: Math.round(input.reporting_interval_seconds),
      temperature_offset_c: roundTo(input.temperature_offset_c, 2),
      altitude_m: Math.round(input.altitude_m),
      led_enabled: Boolean(input.led_enabled),
      config_version: nextVersion,
      reboot_requested_at: existingData?.reboot_requested_at ?? null,
      target_firmware_version: existingData?.target_firmware_version ?? null,
      updated_at: nowTs,
      updated_by: updatedBy,
    };

    tx.set(ref, payload);
    return mapDeviceConfigData(deviceId, payload);
  });
}

/**
 * Atomically stamps `reboot_requested_at = now` and increments `config_version`
 * on `device_configs/{deviceId}` to trigger a safe one-shot remote reboot.
 */
export async function requestDeviceReboot(
  deviceId: string,
  updatedBy: string,
  db: Firestore = getDb()
): Promise<DeviceConfig> {
  const configRef = db.collection(DEVICE_CONFIGS_COLLECTION).doc(deviceId);
  const deviceRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
  const nowTs = Timestamp.now();

  return db.runTransaction(async (tx) => {
    const [existingCfg, existingDevice] = await Promise.all([
      tx.get(configRef),
      tx.get(deviceRef),
    ]);
    const cfgData = existingCfg.exists ? existingCfg.data() : undefined;
    const devData = existingDevice.exists ? existingDevice.data() : undefined;

    const prevVersion =
      cfgData && typeof cfgData.config_version === "number"
        ? Math.trunc(cfgData.config_version)
        : 0;
    const nextVersion = Math.min(1_000_000, Math.max(1, prevVersion + 1));

    const payload = {
      device_id: deviceId,
      location: asString(cfgData?.location ?? devData?.location, "home-office"),
      reporting_interval_seconds: Math.round(
        asNumber(
          cfgData?.reporting_interval_seconds ?? devData?.reporting_interval_seconds,
          300
        )
      ),
      temperature_offset_c: roundTo(
        asNumber(cfgData?.temperature_offset_c ?? devData?.temperature_offset_c, 4.0),
        2
      ),
      altitude_m: Math.round(asNumber(cfgData?.altitude_m ?? devData?.altitude_m, 0)),
      led_enabled:
        typeof cfgData?.led_enabled === "boolean"
          ? cfgData.led_enabled
          : typeof devData?.led_enabled === "boolean"
            ? devData.led_enabled
            : true,
      config_version: nextVersion,
      reboot_requested_at: nowTs,
      target_firmware_version: cfgData?.target_firmware_version ?? null,
      updated_at: nowTs,
      updated_by: updatedBy,
    };

    tx.set(configRef, payload);
    return mapDeviceConfigData(deviceId, payload);
  });
}

/**
 * Atomically sets (or clears when `null`) `target_firmware_version` on `device_configs/{deviceId}`
 * and increments `config_version`, preserving all Layer 1 settings and `reboot_requested_at`.
 */
export async function setDeviceTargetFirmwareVersion(
  deviceId: string,
  targetVersion: string | null,
  updatedBy: string,
  db: Firestore = getDb()
): Promise<DeviceConfig> {
  if (targetVersion !== null && !isValidFirmwareVersion(targetVersion)) {
    throw new Error(`Invalid target_firmware_version '${targetVersion}'.`);
  }

  const configRef = db.collection(DEVICE_CONFIGS_COLLECTION).doc(deviceId);
  const deviceRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
  const nowTs = Timestamp.now();

  return db.runTransaction(async (tx) => {
    const [existingCfg, existingDevice] = await Promise.all([
      tx.get(configRef),
      tx.get(deviceRef),
    ]);
    const cfgData = existingCfg.exists ? existingCfg.data() : undefined;
    const devData = existingDevice.exists ? existingDevice.data() : undefined;

    const prevVersion =
      cfgData && typeof cfgData.config_version === "number"
        ? Math.trunc(cfgData.config_version)
        : 0;
    const nextVersion = Math.min(1_000_000, Math.max(1, prevVersion + 1));

    const payload = {
      device_id: deviceId,
      location: asString(cfgData?.location ?? devData?.location, "home-office"),
      reporting_interval_seconds: Math.round(
        asNumber(
          cfgData?.reporting_interval_seconds ?? devData?.reporting_interval_seconds,
          300
        )
      ),
      temperature_offset_c: roundTo(
        asNumber(cfgData?.temperature_offset_c ?? devData?.temperature_offset_c, 4.0),
        2
      ),
      altitude_m: Math.round(asNumber(cfgData?.altitude_m ?? devData?.altitude_m, 0)),
      led_enabled:
        typeof cfgData?.led_enabled === "boolean"
          ? cfgData.led_enabled
          : typeof devData?.led_enabled === "boolean"
            ? devData.led_enabled
            : true,
      config_version: nextVersion,
      reboot_requested_at: cfgData?.reboot_requested_at ?? null,
      target_firmware_version: targetVersion,
      updated_at: nowTs,
      updated_by: updatedBy,
    };

    tx.set(configRef, payload);
    return mapDeviceConfigData(deviceId, payload);
  });
}

/**
 * Fetches a single OTA release manifest from `firmware_releases/{version}`.
 */
export async function getFirmwareRelease(
  version: string,
  db: Firestore = getDb()
): Promise<FirmwareReleaseManifest | null> {
  if (!isValidFirmwareVersion(version)) {
    return null;
  }
  const doc = await db.collection(FIRMWARE_RELEASES_COLLECTION).doc(version).get();
  if (!doc.exists || !doc.data()) {
    return null;
  }
  return mapFirmwareReleaseManifest(doc.id, doc.data()!);
}

/**
 * Lists all published OTA release manifests sorted newest-first by `created_at`.
 */
export async function listFirmwareReleases(
  db: Firestore = getDb()
): Promise<FirmwareReleaseManifest[]> {
  const snapshot = await db.collection(FIRMWARE_RELEASES_COLLECTION).get();
  const releases = snapshot.docs.map((doc) =>
    mapFirmwareReleaseManifest(doc.id, doc.data())
  );
  releases.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return releases;
}

/**
 * Fetches a single versioned Python artifact from `firmware_releases/{version}/files/{filename}`.
 */
export async function getFirmwareReleaseFile(
  version: string,
  filename: string,
  db: Firestore = getDb()
): Promise<FirmwareReleaseFileArtifact | null> {
  if (!isValidFirmwareVersion(version) || !isValidOtaFilename(filename)) {
    return null;
  }
  const doc = await db
    .collection(FIRMWARE_RELEASES_COLLECTION)
    .doc(version)
    .collection(FIRMWARE_RELEASE_FILES_SUBCOLLECTION)
    .doc(filename)
    .get();
  if (!doc.exists || !doc.data()) {
    return null;
  }
  return mapFirmwareReleaseFileArtifact(doc.id, version, doc.data()!);
}
