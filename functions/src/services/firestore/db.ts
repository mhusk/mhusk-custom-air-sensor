import { getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

export const READINGS_COLLECTION = "readings";
export const DEVICES_COLLECTION = "devices";
export const DEVICE_CONFIGS_COLLECTION = "device_configs";
export const FIRMWARE_RELEASES_COLLECTION = "firmware_releases";
export const FIRMWARE_RELEASE_FILES_SUBCOLLECTION = "files";
export const DAILY_ROLLUPS_COLLECTION = "daily_rollups";
export const OUTDOOR_DAILY_ROLLUPS_COLLECTION = "outdoor_daily_rollups";

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

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function asNumber(value: unknown, fallback = 0): number {
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

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function parseTimestampToDateOrNull(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: unknown }).toDate === "function"
  ) {
    const converted = (value as { toDate: () => Date }).toDate();
    if (converted instanceof Date && !Number.isNaN(converted.getTime())) {
      return converted;
    }
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

export function normalizeTimestampToDate(value: unknown): Date {
  return parseTimestampToDateOrNull(value) ?? new Date(0);
}

export function parseIsoDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp for '${fieldName}': ${value}`);
  }
  return parsed;
}

export function minutesBetween(older: Date, newer: Date): number {
  const diffMs = Math.max(0, newer.getTime() - older.getTime());
  return roundTo(diffMs / 60000, 1);
}
