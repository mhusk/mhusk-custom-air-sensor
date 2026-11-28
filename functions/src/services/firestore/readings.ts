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
  asNullableNumber,
  asNumber,
  asString,
  getDb,
  minutesBetween,
  normalizeTimestampToDate,
  parseIsoDate,
} from "./db.js";
import { mapDeviceData } from "./devices.js";
import {
  formatUtcDateString,
  groupContiguousDateRanges,
  readIndoorReadingsFromRollups,
  utcDayRange,
} from "./rollups.js";
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
  parseAqiCategory,
  type AirQualityReading,
  type AirQualitySummaryOptions,
  type AirQualitySummaryResult,
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
    pm1_0_ug_m3: asNullableNumber(data.pm1_0_ug_m3),
    pm2_5_ug_m3: asNullableNumber(data.pm2_5_ug_m3),
    pm10_0_ug_m3: asNullableNumber(data.pm10_0_ug_m3),
    aqi_us: asNullableNumber(data.aqi_us),
    aqi_category: parseAqiCategory(data.aqi_category),
    particles_0_3um: asNullableNumber(data.particles_0_3um),
    particles_0_5um: asNullableNumber(data.particles_0_5um),
    particles_1_0um: asNullableNumber(data.particles_1_0um),
    particles_2_5um: asNullableNumber(data.particles_2_5um),
    particles_5_0um: asNullableNumber(data.particles_5_0um),
    particles_10_0um: asNullableNumber(data.particles_10_0um),
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

async function fetchRawReadingsInWindow(
  db: Firestore,
  options: {
    device_id?: string;
    location?: string;
    startDate: Date;
    endDate: Date;
    maxScanDocs: number;
  }
): Promise<{ readings: AirQualityReading[]; scanCapped: boolean }> {
  const { query, postFilterLocation } = buildReadingsQuery(db, {
    device_id: options.device_id,
    location: options.location,
    startDate: options.startDate,
    endDate: options.endDate,
    limit: options.maxScanDocs,
  });

  const snapshot = await query.get();
  const scanCapped = snapshot.size >= options.maxScanDocs;

  let readings = snapshot.docs.map(mapReadingSnapshot);
  if (postFilterLocation) {
    readings = readings.filter((r) => r.location === postFilterLocation);
  }
  // Reverse from Firestore DESC order into chronological ASC order.
  readings.reverse();
  return { readings, scanCapped };
}

const ROLLUP_TAIL_LAG_THRESHOLD_MS = STALE_THRESHOLD_MINUTES * 60_000;

async function fetchReadingsWindowWithRollups(
  db: Firestore,
  options: {
    device_id?: string;
    location?: string;
    startDate: Date;
    endDate: Date;
    maxScanDocs: number;
    forceTailCheck?: boolean;
    now?: Date;
  }
): Promise<{ readings: AirQualityReading[]; scanCapped: boolean }> {
  const rollupResult = await readIndoorReadingsFromRollups(
    {
      startDate: options.startDate,
      endDate: options.endDate,
      device_id: options.device_id,
      location: options.location,
    },
    db
  );

  const startMs = options.startDate.getTime();
  const endMs = options.endDate.getTime();
  const fallbackRanges: Array<{ startDate: Date; endDate: Date }> = [];

  for (const range of groupContiguousDateRanges(rollupResult.missingDates)) {
    const clampedStart = new Date(Math.max(startMs, range.startDate.getTime()));
    const clampedEnd = new Date(Math.min(endMs, range.endDate.getTime()));
    if (clampedStart.getTime() <= clampedEnd.getTime()) {
      fallbackRanges.push({ startDate: clampedStart, endDate: clampedEnd });
    }
  }

  const now = options.now ?? new Date();
  const endUtcDate = formatUtcDateString(options.endDate);
  const nowUtcDate = formatUtcDateString(now);

  if (endUtcDate === nowUtcDate && !rollupResult.missingDates.includes(endUtcDate)) {
    let latestRollupMs: number | null = null;
    for (const r of rollupResult.readings) {
      const tsMs = Date.parse(r.timestamp);
      if (Number.isFinite(tsMs) && (latestRollupMs === null || tsMs > latestRollupMs)) {
        latestRollupMs = tsMs;
      }
    }

    const needsTailCheck =
      Boolean(options.forceTailCheck) ||
      latestRollupMs === null ||
      endMs - latestRollupMs > ROLLUP_TAIL_LAG_THRESHOLD_MS;

    if (needsTailCheck) {
      const todayStartMs = utcDayRange(endUtcDate).start.getTime();
      const tailStartMs =
        latestRollupMs !== null
          ? Math.max(startMs, latestRollupMs + 1000)
          : Math.max(startMs, todayStartMs);
      if (tailStartMs <= endMs) {
        fallbackRanges.push({
          startDate: new Date(tailStartMs),
          endDate: options.endDate,
        });
      }
    }
  }

  if (fallbackRanges.length === 0) {
    return { readings: rollupResult.readings, scanCapped: false };
  }

  let scanCapped = false;

  const fallbackBatches = await Promise.all(
    fallbackRanges.map(async (range) => {
      const raw = await fetchRawReadingsInWindow(db, {
        device_id: options.device_id,
        location: options.location,
        startDate: range.startDate,
        endDate: range.endDate,
        maxScanDocs: options.maxScanDocs,
      });
      if (raw.scanCapped) {
        scanCapped = true;
      }
      return raw.readings;
    })
  );

  if (rollupResult.readings.length === 0 && fallbackBatches.length === 1) {
    return { readings: fallbackBatches[0], scanCapped };
  }

  const deduped = new Map<string, AirQualityReading>();
  const addReading = (reading: AirQualityReading): void => {
    const dedupeKey = `${reading.device_id}|${Math.floor(Date.parse(reading.timestamp) / 1000)}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, reading);
    }
  };

  for (const r of rollupResult.readings) {
    addReading(r);
  }
  for (const batch of fallbackBatches) {
    for (const r of batch) {
      addReading(r);
    }
  }

  const merged = Array.from(deduped.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  return { readings: merged, scanCapped };
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

  const { readings, scanCapped } = await fetchReadingsWindowWithRollups(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate,
    maxScanDocs: MAX_HISTORY_SCAN_DOCS,
    forceTailCheck: options.forceTailCheck,
    now,
  });

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
          forceTailCheck: options.forceTailCheck,
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

  const { readings, scanCapped } = await fetchReadingsWindowWithRollups(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate: now,
    maxScanDocs: MAX_HISTORY_SCAN_DOCS,
    forceTailCheck: options.forceTailCheck,
    now,
  });

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

  const { readings, scanCapped } = await fetchReadingsWindowWithRollups(db, {
    device_id: options.device_id,
    location: options.location,
    startDate,
    endDate: now,
    maxScanDocs: MAX_SUMMARY_SCAN_DOCS,
    forceTailCheck: options.forceTailCheck,
    now,
  });

  return computeAirQualitySummaryFromReadings(readings, {
    period: options.period,
    windowStart: startDate,
    windowEnd: now,
    device_id: options.device_id,
    location: options.location,
    scanCapped,
  });
}
