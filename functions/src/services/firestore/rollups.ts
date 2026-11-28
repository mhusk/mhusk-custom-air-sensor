import {
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";

import type { OutdoorReading } from "../outdoor.js";
import {
  DAILY_ROLLUPS_COLLECTION,
  OUTDOOR_DAILY_ROLLUPS_COLLECTION,
  asNullableNumber,
  asNumber,
  asString,
  getDb,
  parseTimestampToDateOrNull,
} from "./db.js";
import { parseAqiCategory, type AirQualityReading, type AqiCategory } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompactIndoorSample {
  ts: number;
  loc: string;
  co2: number;
  tc: number;
  tf: number;
  rh: number;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  aqi: number | null;
  cat: AqiCategory | null;
  p: [
    number | null,
    number | null,
    number | null,
    number | null,
    number | null,
    number | null,
  ];
  id?: string;
}

export interface CompactOutdoorSample {
  ts: number;
  lbl: string;
  lat: number;
  lon: number;
  tc: number;
  tf: number;
  atf: number | null;
  rh: number;
  wspd: number | null;
  wcode: number | null;
  wdesc: string;
  pm25: number | null;
  pm10: number | null;
  aqi: number | null;
  cat: AqiCategory | null;
  o3: number | null;
  no2: number | null;
  id?: string;
}

export interface IndoorRollupReadResult {
  readings: AirQualityReading[];
  missingDates: string[];
  docsRead: number;
}

export interface OutdoorRollupReadResult {
  readings: OutdoorReading[];
  missingDates: string[];
  docsRead: number;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Formats a Date as an ISO UTC calendar day (`YYYY-MM-DD`).
 */
export function formatUtcDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns an inclusive, chronologically sorted list of UTC `YYYY-MM-DD` strings
 * spanning `[startDate, endDate]`.
 */
export function listUtcDateStrings(startDate: Date, endDate: Date): string[] {
  const startUtcMs = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  );
  const endUtcMs = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate()
  );

  if (endUtcMs < startUtcMs) {
    return [];
  }

  const dates: string[] = [];
  for (let ms = startUtcMs; ms <= endUtcMs; ms += DAY_MS) {
    dates.push(formatUtcDateString(new Date(ms)));
  }
  return dates;
}

/**
 * Converts a UTC `YYYY-MM-DD` string into inclusive `[00:00:00.000Z, 23:59:59.999Z]` bounds.
 */
export function utcDayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid UTC date string: ${dateStr}`);
  }
  const end = new Date(`${dateStr}T23:59:59.999Z`);
  return { start, end };
}

/**
 * Groups sorted or unsorted UTC `YYYY-MM-DD` strings into minimal contiguous
 * `[startDate, endDate]` windows for raw-collection fallback queries.
 */
export function groupContiguousDateRanges(
  dateStrings: string[]
): Array<{ startDate: Date; endDate: Date }> {
  if (dateStrings.length === 0) {
    return [];
  }

  const sorted = Array.from(new Set(dateStrings)).sort();
  const ranges: Array<{ startDate: Date; endDate: Date }> = [];

  let currentStart = utcDayRange(sorted[0]).start;
  let currentEnd = utcDayRange(sorted[0]).end;
  let prevDayStartMs = currentStart.getTime();

  for (let i = 1; i < sorted.length; i++) {
    const { start, end } = utcDayRange(sorted[i]);
    if (start.getTime() - prevDayStartMs === DAY_MS) {
      currentEnd = end;
      prevDayStartMs = start.getTime();
    } else {
      ranges.push({ startDate: currentStart, endDate: currentEnd });
      currentStart = start;
      currentEnd = end;
      prevDayStartMs = start.getTime();
    }
  }
  ranges.push({ startDate: currentStart, endDate: currentEnd });
  return ranges;
}

export function buildIndoorRollupDocId(deviceId: string, date: Date | string): string {
  const dateStr = typeof date === "string" ? date : formatUtcDateString(date);
  return `${deviceId}_${dateStr}`;
}

export function buildOutdoorRollupDocId(date: Date | string): string {
  return typeof date === "string" ? date : formatUtcDateString(date);
}

function resolveEpochKey(tsMs: number): string {
  return String(Math.floor(tsMs / 1000));
}

/**
 * Encodes a full `AirQualityReading` into a compact lossless map entry for `daily_rollups`.
 */
export function encodeIndoorRollupSample(reading: AirQualityReading): {
  epochKey: string;
  dateStr: string;
  sample: CompactIndoorSample;
} {
  const tsDate = new Date(reading.timestamp);
  if (Number.isNaN(tsDate.getTime())) {
    throw new Error(`Invalid reading timestamp for rollup: ${reading.timestamp}`);
  }
  const tsMs = tsDate.getTime();
  return {
    epochKey: resolveEpochKey(tsMs),
    dateStr: formatUtcDateString(tsDate),
    sample: {
      ts: tsMs,
      loc: reading.location,
      co2: reading.co2_ppm,
      tc: reading.temperature_c,
      tf: reading.temperature_f,
      rh: reading.humidity_percent,
      pm1: reading.pm1_0_ug_m3,
      pm25: reading.pm2_5_ug_m3,
      pm10: reading.pm10_0_ug_m3,
      aqi: reading.aqi_us,
      cat: reading.aqi_category,
      p: [
        reading.particles_0_3um,
        reading.particles_0_5um,
        reading.particles_1_0um,
        reading.particles_2_5um,
        reading.particles_5_0um,
        reading.particles_10_0um,
      ],
      ...(reading.id ? { id: reading.id } : {}),
    },
  };
}

function inferDeviceIdFromRollupDoc(docId: string, data: DocumentData): string {
  if (typeof data.device_id === "string" && data.device_id.trim().length > 0) {
    return data.device_id.trim();
  }
  const match = /^(.+)_\d{4}-\d{2}-\d{2}$/.exec(docId);
  return match ? match[1] : "";
}

/**
 * Reconstructs lossless `AirQualityReading` objects from a `daily_rollups` document.
 */
export function decodeIndoorRollupDoc(
  docId: string,
  data: DocumentData
): AirQualityReading[] {
  const deviceId = inferDeviceIdFromRollupDoc(docId, data);
  const rawSamples = data.samples;
  if (!deviceId || typeof rawSamples !== "object" || rawSamples === null) {
    return [];
  }

  const readings: AirQualityReading[] = [];
  for (const [epochKey, raw] of Object.entries(rawSamples as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const tsMs = toFiniteNumberOrNull(entry.ts);
    if (tsMs === null || !Number.isFinite(tsMs)) {
      continue;
    }
    const tsDate = new Date(tsMs);
    if (Number.isNaN(tsDate.getTime())) {
      continue;
    }

    const particles = Array.isArray(entry.p) ? entry.p : [];
    const sampleId =
      typeof entry.id === "string" && entry.id.trim().length > 0
        ? entry.id
        : `${deviceId}_${epochKey}`;

    readings.push({
      id: sampleId,
      device_id: deviceId,
      location: asString(entry.loc),
      timestamp: tsDate.toISOString(),
      co2_ppm: asNumber(entry.co2),
      temperature_c: asNumber(entry.tc),
      temperature_f: asNumber(entry.tf),
      humidity_percent: asNumber(entry.rh),
      pm1_0_ug_m3: asNullableNumber(entry.pm1),
      pm2_5_ug_m3: asNullableNumber(entry.pm25),
      pm10_0_ug_m3: asNullableNumber(entry.pm10),
      aqi_us: asNullableNumber(entry.aqi),
      aqi_category: parseAqiCategory(entry.cat),
      particles_0_3um: asNullableNumber(particles[0]),
      particles_0_5um: asNullableNumber(particles[1]),
      particles_1_0um: asNullableNumber(particles[2]),
      particles_2_5um: asNullableNumber(particles[3]),
      particles_5_0um: asNullableNumber(particles[4]),
      particles_10_0um: asNullableNumber(particles[5]),
    });
  }

  readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return readings;
}

/**
 * Encodes an `OutdoorReading` into a compact lossless map entry for `outdoor_daily_rollups`.
 */
export function encodeOutdoorRollupSample(
  reading: Omit<OutdoorReading, "id">,
  id?: string
): {
  epochKey: string;
  dateStr: string;
  sample: CompactOutdoorSample;
} {
  const tsDate = new Date(reading.timestamp);
  if (Number.isNaN(tsDate.getTime())) {
    throw new Error(`Invalid outdoor timestamp for rollup: ${reading.timestamp}`);
  }
  const tsMs = tsDate.getTime();
  return {
    epochKey: resolveEpochKey(tsMs),
    dateStr: formatUtcDateString(tsDate),
    sample: {
      ts: tsMs,
      lbl: reading.location_label,
      lat: reading.latitude,
      lon: reading.longitude,
      tc: reading.temperature_c,
      tf: reading.temperature_f,
      atf: reading.apparent_temperature_f,
      rh: reading.humidity_percent,
      wspd: reading.wind_speed_mph,
      wcode: reading.weather_code,
      wdesc: reading.weather_description,
      pm25: reading.pm2_5_ug_m3,
      pm10: reading.pm10_0_ug_m3,
      aqi: reading.us_aqi,
      cat: reading.us_aqi_category,
      o3: reading.ozone_ug_m3,
      no2: reading.nitrogen_dioxide_ug_m3,
      ...(id ? { id } : {}),
    },
  };
}

/**
 * Reconstructs lossless `OutdoorReading` objects from an `outdoor_daily_rollups` document.
 */
export function decodeOutdoorRollupDoc(data: DocumentData): OutdoorReading[] {
  const rawSamples = data.samples;
  if (typeof rawSamples !== "object" || rawSamples === null) {
    return [];
  }

  const readings: OutdoorReading[] = [];
  for (const [epochKey, raw] of Object.entries(rawSamples as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const tsMs = toFiniteNumberOrNull(entry.ts);
    const lat = toFiniteNumberOrNull(entry.lat);
    const lon = toFiniteNumberOrNull(entry.lon);
    const tc = toFiniteNumberOrNull(entry.tc);
    const tf = toFiniteNumberOrNull(entry.tf);
    const rh = toFiniteNumberOrNull(entry.rh);
    if (
      tsMs === null ||
      lat === null ||
      lon === null ||
      tc === null ||
      tf === null ||
      rh === null
    ) {
      continue;
    }

    const tsDate = new Date(tsMs);
    if (Number.isNaN(tsDate.getTime())) {
      continue;
    }

    const sampleId =
      typeof entry.id === "string" && entry.id.trim().length > 0
        ? entry.id
        : `outdoor_${epochKey}`;

    const rawCat = typeof entry.cat === "string" ? (entry.cat as AqiCategory) : null;

    readings.push({
      id: sampleId,
      timestamp: tsDate.toISOString(),
      location_label: asString(entry.lbl, "Home Outdoor"),
      latitude: lat,
      longitude: lon,
      source: "open-meteo",
      temperature_c: tc,
      temperature_f: tf,
      apparent_temperature_f: toFiniteNumberOrNull(entry.atf),
      humidity_percent: rh,
      wind_speed_mph: toFiniteNumberOrNull(entry.wspd),
      weather_code: toFiniteNumberOrNull(entry.wcode),
      weather_description: asString(entry.wdesc, "Unknown"),
      pm2_5_ug_m3: toFiniteNumberOrNull(entry.pm25),
      pm10_0_ug_m3: toFiniteNumberOrNull(entry.pm10),
      us_aqi: toFiniteNumberOrNull(entry.aqi),
      us_aqi_category: rawCat,
      ozone_ug_m3: toFiniteNumberOrNull(entry.o3),
      nitrogen_dioxide_ug_m3: toFiniteNumberOrNull(entry.no2),
    });
  }

  readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return readings;
}

/**
 * Idempotently appends one indoor reading into `daily_rollups/{device_id}_{YYYY-MM-DD}`
 * using `set(..., { merge: true })` (0 Firestore reads on write).
 */
export async function appendIndoorRollupSample(
  reading: AirQualityReading,
  db: Firestore = getDb()
): Promise<string> {
  const { epochKey, dateStr, sample } = encodeIndoorRollupSample(reading);
  const docId = buildIndoorRollupDocId(reading.device_id, dateStr);
  await db
    .collection(DAILY_ROLLUPS_COLLECTION)
    .doc(docId)
    .set(
      {
        device_id: reading.device_id,
        date: dateStr,
        updated_at: Timestamp.now(),
        samples: {
          [epochKey]: sample,
        },
      },
      { merge: true }
    );
  return docId;
}

/**
 * Parses a raw `readings/{readingId}` Firestore document payload (from `onDocumentCreated`)
 * and appends it to `daily_rollups`. Returns the rollup doc ID, or `null` if invalid.
 */
export async function appendIndoorRollupFromRawDoc(
  readingId: string,
  rawData: DocumentData,
  db: Firestore = getDb()
): Promise<string | null> {
  const deviceId = asString(rawData.device_id).trim();
  const tsDate = parseTimestampToDateOrNull(rawData.timestamp);
  if (!deviceId || !tsDate) {
    return null;
  }

  const reading: AirQualityReading = {
    id: readingId,
    device_id: deviceId,
    location: asString(rawData.location),
    timestamp: tsDate.toISOString(),
    co2_ppm: asNumber(rawData.co2_ppm),
    temperature_c: asNumber(rawData.temperature_c),
    temperature_f: asNumber(rawData.temperature_f),
    humidity_percent: asNumber(rawData.humidity_percent),
    pm1_0_ug_m3: asNullableNumber(rawData.pm1_0_ug_m3),
    pm2_5_ug_m3: asNullableNumber(rawData.pm2_5_ug_m3),
    pm10_0_ug_m3: asNullableNumber(rawData.pm10_0_ug_m3),
    aqi_us: asNullableNumber(rawData.aqi_us),
    aqi_category: parseAqiCategory(rawData.aqi_category),
    particles_0_3um: asNullableNumber(rawData.particles_0_3um),
    particles_0_5um: asNullableNumber(rawData.particles_0_5um),
    particles_1_0um: asNullableNumber(rawData.particles_1_0um),
    particles_2_5um: asNullableNumber(rawData.particles_2_5um),
    particles_5_0um: asNullableNumber(rawData.particles_5_0um),
    particles_10_0um: asNullableNumber(rawData.particles_10_0um),
  };

  return appendIndoorRollupSample(reading, db);
}

/**
 * Builds the `outdoor_daily_rollups/{YYYY-MM-DD}` doc ID and merge payload for one outdoor reading.
 */
export function buildOutdoorRollupWrite(
  reading: OutdoorReading
): { docId: string; payload: Record<string, unknown> } {
  const { epochKey, dateStr, sample } = encodeOutdoorRollupSample(reading, reading.id);
  return {
    docId: buildOutdoorRollupDocId(dateStr),
    payload: {
      date: dateStr,
      updated_at: Timestamp.now(),
      samples: {
        [epochKey]: sample,
      },
    },
  };
}

/**
 * Idempotently appends one outdoor reading into `outdoor_daily_rollups/{YYYY-MM-DD}`
 * using `set(..., { merge: true })` (0 Firestore reads on write).
 */
export async function appendOutdoorRollupSample(
  reading: OutdoorReading,
  db: Firestore = getDb()
): Promise<string> {
  const { docId, payload } = buildOutdoorRollupWrite(reading);
  await db
    .collection(OUTDOOR_DAILY_ROLLUPS_COLLECTION)
    .doc(docId)
    .set(payload, { merge: true });
  return docId;
}

/**
 * Reads indoor readings across `[startDate, endDate]` from `daily_rollups`.
 * Returns decoded readings in ascending chronological order plus `missingDates`
 * (UTC `YYYY-MM-DD` strings with no rollup doc) so callers can fall back to `readings`.
 */
export async function readIndoorReadingsFromRollups(
  options: {
    startDate: Date;
    endDate: Date;
    device_id?: string;
    location?: string;
  },
  db: Firestore = getDb()
): Promise<IndoorRollupReadResult> {
  const dates = listUtcDateStrings(options.startDate, options.endDate);
  if (dates.length === 0) {
    return { readings: [], missingDates: [], docsRead: 0 };
  }

  const startMs = options.startDate.getTime();
  const endMs = options.endDate.getTime();
  const readings: AirQualityReading[] = [];
  const missingDates: string[] = [];
  let docsRead = 0;

  if (options.device_id) {
    if (typeof db.getAll !== "function") {
      return { readings: [], missingDates: dates, docsRead: 0 };
    }
    const collectionRef = db.collection(DAILY_ROLLUPS_COLLECTION);
    const refs: DocumentReference<DocumentData>[] = dates.map((dateStr) =>
      collectionRef.doc(buildIndoorRollupDocId(options.device_id!, dateStr))
    );
    const snapshots = await db.getAll(...refs);
    docsRead = snapshots.length;

    snapshots.forEach((snap, idx) => {
      if (!snap.exists || !snap.data()) {
        missingDates.push(dates[idx]);
        return;
      }
      const decoded = decodeIndoorRollupDoc(snap.id, snap.data()!);
      for (const item of decoded) {
        const tsMs = Date.parse(item.timestamp);
        if (tsMs >= startMs && tsMs <= endMs) {
          if (!options.location || item.location === options.location) {
            readings.push(item);
          }
        }
      }
    });
  } else {
    const col = db.collection(DAILY_ROLLUPS_COLLECTION);
    if (typeof col.where !== "function") {
      return { readings: [], missingDates: dates, docsRead: 0 };
    }
    const snap = await col
      .where("date", ">=", dates[0])
      .where("date", "<=", dates[dates.length - 1])
      .get();
    docsRead = snap.size;

    const coveredDates = new Set<string>();
    const locationCoveredDates = new Set<string>();
    const datesByDevice = new Map<string, Set<string>>();

    for (const doc of snap.docs) {
      const data = doc.data();
      const docDate =
        typeof data.date === "string" && data.date.length === 10
          ? data.date
          : doc.id.slice(-10);
      const docDeviceId =
        typeof data.device_id === "string" && data.device_id.length > 0
          ? data.device_id
          : doc.id.slice(0, -11);

      coveredDates.add(docDate);
      if (docDeviceId) {
        let devDates = datesByDevice.get(docDeviceId);
        if (!devDates) {
          devDates = new Set<string>();
          datesByDevice.set(docDeviceId, devDates);
        }
        devDates.add(docDate);
      }

      const decoded = decodeIndoorRollupDoc(doc.id, data);
      let matchedLocation = false;
      for (const item of decoded) {
        const tsMs = Date.parse(item.timestamp);
        if (tsMs >= startMs && tsMs <= endMs) {
          if (!options.location || item.location === options.location) {
            readings.push(item);
            matchedLocation = true;
          }
        }
      }
      if (options.location && matchedLocation) {
        locationCoveredDates.add(docDate);
      }
    }

    if (options.location) {
      for (const dateStr of dates) {
        if (!locationCoveredDates.has(dateStr)) {
          missingDates.push(dateStr);
        }
      }
    } else {
      const deviceSpans = Array.from(datesByDevice.values()).map((devDates) => {
        const sorted = Array.from(devDates).sort();
        return {
          devDates,
          minDate: sorted[0],
          maxDate: sorted[sorted.length - 1],
        };
      });

      for (const dateStr of dates) {
        const missingFleetDate = !coveredDates.has(dateStr);
        const missingMidRangeDeviceDate = deviceSpans.some(
          ({ devDates, minDate, maxDate }) =>
            dateStr > minDate && dateStr < maxDate && !devDates.has(dateStr)
        );
        if (missingFleetDate || missingMidRangeDeviceDate) {
          missingDates.push(dateStr);
        }
      }
    }
  }

  readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { readings, missingDates, docsRead };
}

/**
 * Reads outdoor readings across `[startDate, endDate]` from `outdoor_daily_rollups`.
 * Returns decoded readings in ascending chronological order plus `missingDates`.
 */
export async function readOutdoorReadingsFromRollups(
  options: { startDate: Date; endDate: Date },
  db: Firestore = getDb()
): Promise<OutdoorRollupReadResult> {
  const dates = listUtcDateStrings(options.startDate, options.endDate);
  if (dates.length === 0) {
    return { readings: [], missingDates: [], docsRead: 0 };
  }

  if (typeof db.getAll !== "function") {
    return { readings: [], missingDates: dates, docsRead: 0 };
  }

  const startMs = options.startDate.getTime();
  const endMs = options.endDate.getTime();
  const collectionRef = db.collection(OUTDOOR_DAILY_ROLLUPS_COLLECTION);
  const refs: DocumentReference<DocumentData>[] = dates.map((dateStr) =>
    collectionRef.doc(buildOutdoorRollupDocId(dateStr))
  );
  const snapshots = await db.getAll(...refs);
  const readings: OutdoorReading[] = [];
  const missingDates: string[] = [];

  snapshots.forEach((snap, idx) => {
    if (!snap.exists || !snap.data()) {
      missingDates.push(dates[idx]);
      return;
    }
    const decoded = decodeOutdoorRollupDoc(snap.data()!);
    for (const item of decoded) {
      const tsMs = Date.parse(item.timestamp);
      if (tsMs >= startMs && tsMs <= endMs) {
        readings.push(item);
      }
    }
  });

  readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { readings, missingDates, docsRead: snapshots.length };
}

export interface GroupedIndoorRollupDoc {
  docId: string;
  device_id: string;
  date: string;
  samples: Record<string, CompactIndoorSample>;
}

export interface GroupedOutdoorRollupDoc {
  docId: string;
  date: string;
  samples: Record<string, CompactOutdoorSample>;
}

/**
 * Groups an array of indoor readings into UTC-day rollup payloads (used by backfill).
 */
export function groupIndoorReadingsIntoRollupDocs(
  readings: AirQualityReading[]
): GroupedIndoorRollupDoc[] {
  const byDocId = new Map<string, GroupedIndoorRollupDoc>();

  for (const reading of readings) {
    if (!reading.device_id) {
      continue;
    }
    const { epochKey, dateStr, sample } = encodeIndoorRollupSample(reading);
    const docId = buildIndoorRollupDocId(reading.device_id, dateStr);
    let group = byDocId.get(docId);
    if (!group) {
      group = {
        docId,
        device_id: reading.device_id,
        date: dateStr,
        samples: {},
      };
      byDocId.set(docId, group);
    }
    group.samples[epochKey] = sample;
  }

  return Array.from(byDocId.values()).sort((a, b) => a.docId.localeCompare(b.docId));
}

/**
 * Groups an array of outdoor readings into UTC-day rollup payloads (used by backfill).
 */
export function groupOutdoorReadingsIntoRollupDocs(
  readings: OutdoorReading[]
): GroupedOutdoorRollupDoc[] {
  const byDocId = new Map<string, GroupedOutdoorRollupDoc>();

  for (const reading of readings) {
    const { epochKey, dateStr, sample } = encodeOutdoorRollupSample(reading, reading.id);
    const docId = buildOutdoorRollupDocId(dateStr);
    let group = byDocId.get(docId);
    if (!group) {
      group = {
        docId,
        date: dateStr,
        samples: {},
      };
      byDocId.set(docId, group);
    }
    group.samples[epochKey] = sample;
  }

  return Array.from(byDocId.values()).sort((a, b) => a.docId.localeCompare(b.docId));
}
