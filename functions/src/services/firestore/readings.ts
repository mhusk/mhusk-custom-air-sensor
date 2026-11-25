import {
  Timestamp,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import {
  assessReadingHealth,
  computeAirQualitySummaryFromReadings,
  downsampleReadings,
} from "./analytics.js";
import {
  DEVICES_COLLECTION,
  READINGS_COLLECTION,
  asNumber,
  asString,
  getDb,
  minutesBetween,
  normalizeTimestampToDate,
  parseIsoDate,
} from "./db.js";
import { mapDeviceData } from "./devices.js";
import {
  DEFAULT_HISTORY_HOURS,
  DEFAULT_HISTORY_LIMIT,
  MAX_EXPLICIT_WINDOW_DAYS,
  MAX_HISTORY_HOURS,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_SCAN_DOCS,
  MAX_SUMMARY_SCAN_DOCS,
  STALE_THRESHOLD_MINUTES,
  SUMMARY_PERIOD_HOURS,
  SUMMARY_PERIOD_MS,
  type AirQualityReading,
  type AirQualitySummaryOptions,
  type AirQualitySummaryResult,
  type AqiCategory,
  type DeviceStatus,
  type LatestReadingOptions,
  type LatestReadingResult,
  type ReadingsHistoryOptions,
  type ReadingsHistoryResult,
  type SummaryPeriod,
} from "./types.js";

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
 * Fetches readings history and matching statistical summary in a single Firestore
 * query when `period` matches `hours` (avoiding duplicate full-window scans on
 * dashboard chart loads). Falls back to separate queries for mismatched windows.
 */
export async function getReadingsHistoryWithSummary(
  options: ReadingsHistoryOptions & { period?: SummaryPeriod } = {},
  db: Firestore = getDb()
): Promise<{ history: ReadingsHistoryResult; summary: AirQualitySummaryResult }> {
  const requestedHours = options.hours ?? DEFAULT_HISTORY_HOURS;
  const clampedHours = Math.min(
    Math.max(requestedHours, 1),
    MAX_HISTORY_HOURS
  );
  const inferredPeriod: SummaryPeriod =
    clampedHours <= 1
      ? "1h"
      : clampedHours <= 6
        ? "6h"
        : clampedHours <= 24
          ? "24h"
          : "7d";
  const period = options.period ?? inferredPeriod;

  if (
    options.start_time ||
    options.end_time ||
    SUMMARY_PERIOD_HOURS[period] !== clampedHours
  ) {
    const [history, summary] = await Promise.all([
      getReadingsHistory(options, db),
      getAirQualitySummary(
        {
          period,
          device_id: options.device_id,
          location: options.location,
          now: options.now,
        },
        db
      ),
    ]);
    return { history, summary };
  }

  const now = options.now ?? new Date();
  const startDate = new Date(now.getTime() - clampedHours * 60 * 60 * 1000);
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT), 1),
    MAX_HISTORY_LIMIT
  );

  const { query, postFilterLocation } = buildReadingsQuery(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate: now,
    limit: MAX_HISTORY_SCAN_DOCS,
  });

  const snapshot = await query.get();
  const scanCapped = snapshot.size >= MAX_HISTORY_SCAN_DOCS;

  let readings = snapshot.docs.map(mapReadingSnapshot);
  if (postFilterLocation) {
    readings = readings.filter((r) => r.location === postFilterLocation);
  }
  readings.reverse();

  const totalMatching = readings.length;
  const downsampled = totalMatching > limit;
  const returnedReadings = downsampled
    ? downsampleReadings(readings, limit)
    : readings;

  return {
    history: {
      window_start: startDate.toISOString(),
      window_end: now.toISOString(),
      filters: {
        device_id: options.device_id ?? null,
        location: options.location ?? null,
      },
      total_matching: totalMatching,
      returned_count: returnedReadings.length,
      downsampled,
      scan_capped: scanCapped,
      readings: returnedReadings,
    },
    summary: computeAirQualitySummaryFromReadings(readings, {
      period,
      windowStart: startDate,
      windowEnd: now,
      device_id: options.device_id,
      location: options.location,
      scanCapped,
    }),
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

  return computeAirQualitySummaryFromReadings(readings, {
    period: options.period,
    windowStart: startDate,
    windowEnd: now,
    device_id: options.device_id,
    location: options.location,
    scanCapped,
  });
}
