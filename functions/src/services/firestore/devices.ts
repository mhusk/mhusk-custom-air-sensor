import type { DocumentData, Firestore } from "firebase-admin/firestore";

import {
  DEVICES_COLLECTION,
  asNumber,
  asString,
  getDb,
  minutesBetween,
  normalizeTimestampToDate,
  roundTo,
} from "./db.js";
import {
  OFFLINE_THRESHOLD_MINUTES,
  STALE_THRESHOLD_MINUTES,
  type AqiCategory,
  type DeviceLatestReadingSnapshot,
  type DeviceStatus,
  type OtaStatus,
  type SensorStatusOptions,
  type SensorStatusResult,
} from "./types.js";

const VALID_OTA_STATUSES = new Set<OtaStatus>([
  "up_to_date",
  "updating",
  "rolled_back",
  "error",
]);

export function mapDeviceData(docId: string, data: DocumentData, now: Date): DeviceStatus {
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
