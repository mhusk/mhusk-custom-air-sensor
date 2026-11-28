import { Timestamp, type DocumentData, type Firestore } from "firebase-admin/firestore";

import {
  DEVICES_COLLECTION,
  DEVICE_CONFIGS_COLLECTION,
  asNumber,
  asString,
  getDb,
  normalizeTimestampToDate,
  roundTo,
} from "./db.js";
import { isValidFirmwareVersion } from "./firmwareReleases.js";
import type { DeviceConfig, UpdateDeviceConfigInput } from "./types.js";

const FLOOR_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function parseFloor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return FLOOR_SLUG_REGEX.test(trimmed) ? trimmed : null;
}

function resolveFloor(input: UpdateDeviceConfigInput, existing: unknown): string | null {
  if (input.floor === undefined) {
    return parseFloor(existing);
  }
  return input.floor;
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
    floor: parseFloor(data.floor),
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
      floor: resolveFloor(input, existingData?.floor),
      updated_at: nowTs,
      updated_by: updatedBy,
    };

    tx.set(ref, payload);
    return mapDeviceConfigData(deviceId, payload);
  });
}

async function mutateDeviceConfigWithDefaults(
  deviceId: string,
  updatedBy: string,
  buildOverrides: (params: {
    cfgData: DocumentData | undefined;
    nowTs: Timestamp;
  }) => {
    reboot_requested_at: unknown;
    target_firmware_version: string | null;
  },
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
    const overrides = buildOverrides({ cfgData, nowTs });

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
      reboot_requested_at: overrides.reboot_requested_at,
      target_firmware_version: overrides.target_firmware_version,
      floor: parseFloor(cfgData?.floor),
      updated_at: nowTs,
      updated_by: updatedBy,
    };

    tx.set(configRef, payload);
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
  return mutateDeviceConfigWithDefaults(
    deviceId,
    updatedBy,
    ({ cfgData, nowTs }) => ({
      reboot_requested_at: nowTs,
      target_firmware_version:
        typeof cfgData?.target_firmware_version === "string"
          ? cfgData.target_firmware_version
          : null,
    }),
    db
  );
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

  return mutateDeviceConfigWithDefaults(
    deviceId,
    updatedBy,
    ({ cfgData }) => ({
      reboot_requested_at: cfgData?.reboot_requested_at ?? null,
      target_firmware_version: targetVersion,
    }),
    db
  );
}
