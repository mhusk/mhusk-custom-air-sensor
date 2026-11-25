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

export const SUMMARY_PERIOD_HOURS: Record<SummaryPeriod, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
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
