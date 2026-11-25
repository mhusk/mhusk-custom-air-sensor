/**
 * Offline unit & mock-Firestore verification for daily rollup helpers
 * (`daily_rollups` and `outdoor_daily_rollups`).
 *
 * Run via: npm --prefix functions run verify:rollups
 */
import assert from "node:assert/strict";

import { Timestamp, type DocumentData, type Firestore } from "firebase-admin/firestore";

import {
  DAILY_ROLLUPS_COLLECTION,
  OUTDOOR_DAILY_ROLLUPS_COLLECTION,
  READINGS_COLLECTION,
  appendIndoorRollupFromRawDoc,
  appendIndoorRollupSample,
  appendOutdoorRollupSample,
  buildIndoorRollupDocId,
  buildOutdoorRollupDocId,
  decodeIndoorRollupDoc,
  decodeOutdoorRollupDoc,
  encodeIndoorRollupSample,
  encodeOutdoorRollupSample,
  formatUtcDateString,
  getAirQualitySummary,
  getReadingsHistoryWithSummary,
  groupContiguousDateRanges,
  groupIndoorReadingsIntoRollupDocs,
  groupOutdoorReadingsIntoRollupDocs,
  listUtcDateStrings,
  readIndoorReadingsFromRollups,
  readOutdoorReadingsFromRollups,
  type AirQualityReading,
} from "../services/firestore.js";
import {
  OUTDOOR_READINGS_COLLECTION,
  getOutdoorReadingsHistory,
  type OutdoorReading,
} from "../services/outdoor.js";
import { parseBackfillCliArgs } from "./backfillRollups.js";

function deepMergeMaps(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Timestamp) &&
      !(value instanceof Date) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergeMaps(
        out[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createMockRollupFirestore(): {
  db: Firestore;
  store: Map<string, Map<string, DocumentData>>;
  counts: { reads: number; writes: number; getAllCalls: number };
} {
  const store = new Map<string, Map<string, DocumentData>>();
  const counts = { reads: 0, writes: 0, getAllCalls: 0 };

  const getCol = (name: string): Map<string, DocumentData> => {
    let map = store.get(name);
    if (!map) {
      map = new Map();
      store.set(name, map);
    }
    return map;
  };

  const makeSnap = (colName: string, id: string) => {
    const data = getCol(colName).get(id);
    return {
      id,
      exists: data !== undefined,
      data: () => data,
    };
  };

  const buildQuery = (
    colName: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    orderField?: string,
    orderDir: "asc" | "desc" = "asc",
    limitNum?: number
  ) => {
    const queryObj = {
      where: (field: string, op: string, value: unknown) =>
        buildQuery(colName, [...filters, { field, op, value }], orderField, orderDir, limitNum),
      orderBy: (field: string, dir: "asc" | "desc" = "asc") =>
        buildQuery(colName, filters, field, dir, limitNum),
      limit: (n: number) => buildQuery(colName, filters, orderField, orderDir, n),
      get: async () => {
        const docs: Array<{ id: string; exists: boolean; data: () => DocumentData }> = [];
        const toComparable = (val: unknown): number | string => {
          if (val instanceof Timestamp) return val.toMillis();
          if (val instanceof Date) return val.getTime();
          if (typeof val === "number" || typeof val === "string") return val;
          return String(val ?? "");
        };

        for (const [id, data] of getCol(colName).entries()) {
          let matches = true;
          for (const f of filters) {
            const actual = toComparable(data[f.field]);
            const expected = toComparable(f.value);
            if (f.op === "==" && actual !== expected) matches = false;
            if (f.op === ">=" && !(actual >= expected)) matches = false;
            if (f.op === "<=" && !(actual <= expected)) matches = false;
            if (!matches) break;
          }
          if (matches) {
            docs.push({ id, exists: true, data: () => data });
          }
        }

        if (orderField) {
          docs.sort((a, b) => {
            const av = toComparable(a.data()[orderField]);
            const bv = toComparable(b.data()[orderField]);
            if (av === bv) return 0;
            const cmp = av < bv ? -1 : 1;
            return orderDir === "desc" ? -cmp : cmp;
          });
        }

        const sliced = limitNum !== undefined ? docs.slice(0, limitNum) : docs;
        counts.reads += sliced.length;
        return {
          empty: sliced.length === 0,
          size: sliced.length,
          docs: sliced,
        };
      },
    };
    return queryObj;
  };

  const db = {
    collection: (colName: string) => ({
      ...buildQuery(colName),
      doc: (docId: string) => ({
        __col: colName,
        id: docId,
        get: async () => {
          counts.reads += 1;
          return makeSnap(colName, docId);
        },
        set: async (data: DocumentData, opts?: { merge?: boolean }) => {
          counts.writes += 1;
          const col = getCol(colName);
          if (opts?.merge && col.has(docId)) {
            col.set(docId, deepMergeMaps(col.get(docId)!, data));
          } else {
            col.set(docId, { ...data });
          }
        },
      }),
    }),
    getAll: async (...refs: Array<{ __col: string; id: string }>) => {
      counts.getAllCalls += 1;
      counts.reads += refs.length;
      return refs.map((ref) => makeSnap(ref.__col, ref.id));
    },
  } as unknown as Firestore;

  return { db, store, counts };
}

function makeSampleReading(overrides: Partial<AirQualityReading> = {}): AirQualityReading {
  return {
    id: "feather-s3-01_1795546800",
    device_id: "feather-s3-01",
    location: "master-bedroom",
    timestamp: "2026-11-24T19:00:00.000Z",
    co2_ppm: 742,
    temperature_c: 21.35,
    temperature_f: 70.43,
    humidity_percent: 43.25,
    pm1_0_ug_m3: 2,
    pm2_5_ug_m3: 5.5,
    pm10_0_ug_m3: 7,
    aqi_us: 23,
    aqi_category: "Good",
    particles_0_3um: 412,
    particles_0_5um: 118,
    particles_1_0um: 21,
    particles_2_5um: 3,
    particles_5_0um: 1,
    particles_10_0um: 0,
    ...overrides,
  };
}

function makeSampleOutdoor(overrides: Partial<OutdoorReading> = {}): OutdoorReading {
  return {
    id: "outdoor_2026-11-24T19-00-00-000Z",
    timestamp: "2026-11-24T19:00:00.000Z",
    location_label: "Home Outdoor",
    latitude: 37.7749,
    longitude: -122.4194,
    source: "open-meteo",
    temperature_c: 14.5,
    temperature_f: 58.1,
    apparent_temperature_f: 56.2,
    humidity_percent: 62.0,
    wind_speed_mph: 7.4,
    weather_code: 2,
    weather_description: "Partly cloudy",
    pm2_5_ug_m3: 7.2,
    pm10_0_ug_m3: 14.0,
    us_aqi: 34,
    us_aqi_category: "Good",
    ozone_ug_m3: 48.0,
    nitrogen_dioxide_ug_m3: 9.5,
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  // 1. UTC date helpers across month/year boundaries
  const dates = listUtcDateStrings(
    new Date("2026-12-30T22:15:00.000Z"),
    new Date("2027-01-02T03:00:00.000Z")
  );
  assert.deepEqual(dates, ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(formatUtcDateString(new Date("2026-11-24T23:59:59.000Z")), "2026-11-24");

  const grouped = groupContiguousDateRanges([
    "2026-11-20",
    "2026-11-21",
    "2026-11-24",
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].startDate.toISOString(), "2026-11-20T00:00:00.000Z");
  assert.equal(grouped[0].endDate.toISOString(), "2026-11-21T23:59:59.999Z");
  assert.equal(grouped[1].startDate.toISOString(), "2026-11-24T00:00:00.000Z");
  console.log("   [PASS] UTC date enumeration and contiguous range grouping");

  // 2. Lossless indoor & outdoor encode/decode
  const indoor = makeSampleReading();
  const encodedIn = encodeIndoorRollupSample(indoor);
  assert.equal(encodedIn.dateStr, "2026-11-24");
  const decodedIn = decodeIndoorRollupDoc("feather-s3-01_2026-11-24", {
    device_id: "feather-s3-01",
    samples: { [encodedIn.epochKey]: encodedIn.sample },
  });
  assert.equal(decodedIn.length, 1);
  assert.deepEqual(decodedIn[0], indoor);

  const outdoor = makeSampleOutdoor();
  const encodedOut = encodeOutdoorRollupSample(outdoor, outdoor.id);
  const decodedOut = decodeOutdoorRollupDoc({
    samples: { [encodedOut.epochKey]: encodedOut.sample },
  });
  assert.equal(decodedOut.length, 1);
  assert.deepEqual(decodedOut[0], outdoor);
  console.log("   [PASS] Lossless compact indoor & outdoor sample encode/decode");

  // 3. 0-read merge writers & batch getAll readers
  const { db, store, counts } = createMockRollupFirestore();
  const r1 = makeSampleReading({
    id: "r1",
    timestamp: "2026-11-23T23:55:00.000Z",
    co2_ppm: 610,
  });
  const r2 = makeSampleReading({
    id: "r2",
    timestamp: "2026-11-24T00:05:00.000Z",
    co2_ppm: 680,
  });
  await appendIndoorRollupSample(r1, db);
  await appendIndoorRollupFromRawDoc(
    "r2",
    {
      ...r2,
      timestamp: Timestamp.fromDate(new Date(r2.timestamp)),
    },
    db
  );
  assert.equal(counts.reads, 0);
  assert.equal(counts.writes, 2);
  assert.ok(store.get(DAILY_ROLLUPS_COLLECTION)?.has(buildIndoorRollupDocId("feather-s3-01", "2026-11-23")));
  assert.ok(store.get(DAILY_ROLLUPS_COLLECTION)?.has(buildIndoorRollupDocId("feather-s3-01", "2026-11-24")));

  // Query across 3 UTC days where Nov 22 is missing
  const readResult = await readIndoorReadingsFromRollups(
    {
      startDate: new Date("2026-11-22T12:00:00.000Z"),
      endDate: new Date("2026-11-24T12:00:00.000Z"),
      device_id: "feather-s3-01",
    },
    db
  );
  assert.equal(counts.getAllCalls, 1);
  assert.equal(readResult.docsRead, 3);
  assert.deepEqual(readResult.missingDates, ["2026-11-22"]);
  assert.deepEqual(
    readResult.readings.map((r) => r.id),
    ["r1", "r2"]
  );

  // Query without device_id uses `date` range query
  const fleetResult = await readIndoorReadingsFromRollups(
    {
      startDate: new Date("2026-11-23T00:00:00.000Z"),
      endDate: new Date("2026-11-24T23:59:59.000Z"),
    },
    db
  );
  assert.deepEqual(fleetResult.missingDates, []);
  assert.equal(fleetResult.readings.length, 2);
  console.log("   [PASS] 0-read merge writers, batch getAll, and missingDates detection");

  // 4. Outdoor rollup writer & reader
  const writesBefore = counts.writes;
  await appendOutdoorRollupSample(outdoor, db);
  assert.equal(counts.writes, writesBefore + 1);
  assert.ok(store.get(OUTDOOR_DAILY_ROLLUPS_COLLECTION)?.has(buildOutdoorRollupDocId("2026-11-24")));

  const outRes = await readOutdoorReadingsFromRollups(
    {
      startDate: new Date("2026-11-23T00:00:00.000Z"),
      endDate: new Date("2026-11-24T23:59:59.000Z"),
    },
    db
  );
  assert.deepEqual(outRes.missingDates, ["2026-11-23"]);
  assert.equal(outRes.readings.length, 1);
  assert.equal(outRes.readings[0].us_aqi, 34);
  console.log("   [PASS] Outdoor rollup writer & batch reader");

  // 5. Parity & O(days) read count on 7d/30d history + summary + mixed raw fallback
  const rollupHarness = createMockRollupFirestore();
  const rawOnlyHarness = createMockRollupFirestore();
  const endNow = new Date("2026-11-24T20:00:00.000Z");

  // Seed 7 days (288 readings/day @ 5-min cadence = 2,016 readings) into raw-only DB
  // and seed days 2..7 into rollupHarness rollups while leaving day 1 (Nov 18) only in raw readings
  const seededCount = 7 * 288;
  const startSeedMs = endNow.getTime() - 7 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < seededCount; i++) {
    const ts = new Date(startSeedMs + i * 5 * 60 * 1000);
    const co2 = i % 100 === 0 ? 1150 : 600 + (i % 150);
    const pm25 = i % 140 === 0 ? 14.5 : 4.0;
    const sample = makeSampleReading({
      id: `feather-s3-01_${Math.floor(ts.getTime() / 1000)}`,
      timestamp: ts.toISOString(),
      co2_ppm: co2,
      pm2_5_ug_m3: pm25,
    });
    const rawDoc = {
      ...sample,
      timestamp: Timestamp.fromDate(ts),
    };
    let rawCol = rawOnlyHarness.store.get(READINGS_COLLECTION);
    if (!rawCol) {
      rawCol = new Map();
      rawOnlyHarness.store.set(READINGS_COLLECTION, rawCol);
    }
    rawCol.set(sample.id, rawDoc);

    const dateStr = formatUtcDateString(ts);
    if (dateStr === "2026-11-17" || dateStr === "2026-11-18") {
      let mixedRaw = rollupHarness.store.get(READINGS_COLLECTION);
      if (!mixedRaw) {
        mixedRaw = new Map();
        rollupHarness.store.set(READINGS_COLLECTION, mixedRaw);
      }
      mixedRaw.set(sample.id, rawDoc);
    } else {
      await appendIndoorRollupSample(sample, rollupHarness.db);
    }
  }

  // Also seed full 7d in a pure-rollup harness to verify O(days) read count
  const pureRollupHarness = createMockRollupFirestore();
  for (const [, rawDoc] of rawOnlyHarness.store.get(READINGS_COLLECTION)!.entries()) {
    const tsDate = (rawDoc.timestamp as Timestamp).toDate();
    await appendIndoorRollupSample(
      makeSampleReading({
        id: String(rawDoc.id ?? ""),
        timestamp: tsDate.toISOString(),
        co2_ppm: Number(rawDoc.co2_ppm),
        pm2_5_ug_m3: Number(rawDoc.pm2_5_ug_m3),
      }),
      pureRollupHarness.db
    );
  }
  pureRollupHarness.counts.reads = 0;
  pureRollupHarness.counts.writes = 0;

  const rawRes = await getReadingsHistoryWithSummary(
    { hours: 168, period: "7d", limit: 240, device_id: "feather-s3-01", now: endNow },
    rawOnlyHarness.db
  );
  const pureRes = await getReadingsHistoryWithSummary(
    { hours: 168, period: "7d", limit: 240, device_id: "feather-s3-01", now: endNow },
    pureRollupHarness.db
  );
  const mixedRes = await getReadingsHistoryWithSummary(
    { hours: 168, period: "7d", limit: 240, device_id: "feather-s3-01", now: endNow },
    rollupHarness.db
  );

  // Raw fallback checked 8 missing rollup docs + scanned 2,016 raw docs; pure rollup read only 8 daily docs!
  assert.equal(rawOnlyHarness.counts.reads, 8 + seededCount);
  assert.equal(pureRollupHarness.counts.reads, 8);
  assert.deepEqual(pureRes.summary.metrics, rawRes.summary.metrics);
  assert.deepEqual(pureRes.summary.threshold_exceedances, rawRes.summary.threshold_exceedances);
  assert.equal(pureRes.summary.notable_spikes.length, rawRes.summary.notable_spikes.length);
  assert.deepEqual(mixedRes.summary.metrics, rawRes.summary.metrics);
  assert.equal(mixedRes.history.total_matching, rawRes.history.total_matching);

  // 30d summary reads <= 31 rollup docs
  pureRollupHarness.counts.reads = 0;
  const summary30d = await getAirQualitySummary(
    { period: "30d", device_id: "feather-s3-01", now: endNow },
    pureRollupHarness.db
  );
  assert.ok(pureRollupHarness.counts.reads <= 31);
  assert.equal(summary30d.sample_count, seededCount);

  // Outdoor 7d history reads <= 8 docs from rollups + falls back cleanly for missing days
  const outMixedHarness = createMockRollupFirestore();
  for (let d = 0; d < 4; d++) {
    const ts = new Date(endNow.getTime() - d * 24 * 60 * 60 * 1000);
    const outItem = makeSampleOutdoor({
      id: `outdoor_${d}`,
      timestamp: ts.toISOString(),
      temperature_f: 55 + d,
    });
    if (d < 2) {
      await appendOutdoorRollupSample(outItem, outMixedHarness.db);
    } else {
      let outRaw = outMixedHarness.store.get(OUTDOOR_READINGS_COLLECTION);
      if (!outRaw) {
        outRaw = new Map();
        outMixedHarness.store.set(OUTDOOR_READINGS_COLLECTION, outRaw);
      }
      outRaw.set(outItem.id, { ...outItem, timestamp: Timestamp.fromDate(ts) });
    }
  }
  outMixedHarness.counts.reads = 0;
  const outHistory = await getOutdoorReadingsHistory(168, 200, outMixedHarness.db, endNow);
  assert.equal(outHistory.length, 4);
  assert.ok(outMixedHarness.counts.reads <= 12);
  console.log("   [PASS] 7d/30d rollup parity, O(days) read reduction, and mixed raw fallback");

  // 6. Backfill CLI arg parsing and batch grouping helpers
  const defaultArgs = parseBackfillCliArgs([]);
  assert.equal(defaultArgs.days, 30);
  assert.equal(defaultArgs.dryRun, false);
  const customArgs = parseBackfillCliArgs(["--days", "14", "--dry-run", "--project", "demo-id"]);
  assert.equal(customArgs.days, 14);
  assert.equal(customArgs.dryRun, true);
  assert.equal(customArgs.projectId, "demo-id");

  const groupedIndoor = groupIndoorReadingsIntoRollupDocs([
    makeSampleReading({ id: "a", timestamp: "2026-11-23T23:55:00.000Z" }),
    makeSampleReading({ id: "b", timestamp: "2026-11-24T00:05:00.000Z" }),
    makeSampleReading({ id: "c", timestamp: "2026-11-24T00:10:00.000Z" }),
  ]);
  assert.equal(groupedIndoor.length, 2);
  assert.equal(Object.keys(groupedIndoor[1].samples).length, 2);

  const groupedOutdoor = groupOutdoorReadingsIntoRollupDocs([
    makeSampleOutdoor({ id: "o1", timestamp: "2026-11-24T01:00:00.000Z" }),
    makeSampleOutdoor({ id: "o2", timestamp: "2026-11-24T01:15:00.000Z" }),
  ]);
  assert.equal(groupedOutdoor.length, 1);
  assert.equal(Object.keys(groupedOutdoor[0].samples).length, 2);
  console.log("   [PASS] Backfill CLI flags & UTC-day grouping helpers");

  // 7. Tail-gap raw fallback on today's rollup (indoor & outdoor)
  // 7a. Lagging today rollup (>15m behind endNow) merges only newer raw readings
  const tailNow = new Date("2026-11-25T13:00:00.000Z");
  const lagHarness = createMockRollupFirestore();
  const seedRawIndoor = (
    harness: ReturnType<typeof createMockRollupFirestore>,
    reading: AirQualityReading
  ) => {
    let rawCol = harness.store.get(READINGS_COLLECTION);
    if (!rawCol) {
      rawCol = new Map();
      harness.store.set(READINGS_COLLECTION, rawCol);
    }
    rawCol.set(reading.id, {
      ...reading,
      timestamp: Timestamp.fromDate(new Date(reading.timestamp)),
    });
  };

  const r10 = makeSampleReading({ id: "r10", timestamp: "2026-11-25T10:00:00.000Z", co2_ppm: 610 });
  const r11 = makeSampleReading({ id: "r11", timestamp: "2026-11-25T11:00:00.000Z", co2_ppm: 640 });
  const r1230 = makeSampleReading({ id: "r1230", timestamp: "2026-11-25T12:30:00.000Z", co2_ppm: 710 });
  const r1255 = makeSampleReading({ id: "r1255", timestamp: "2026-11-25T12:55:00.000Z", co2_ppm: 750 });
  await appendIndoorRollupSample(r10, lagHarness.db);
  await appendIndoorRollupSample(r11, lagHarness.db);
  for (const r of [r10, r11, r1230, r1255]) {
    seedRawIndoor(lagHarness, r);
  }
  lagHarness.counts.reads = 0;
  const lagRes = await getReadingsHistoryWithSummary(
    { hours: 6, period: "6h", device_id: "feather-s3-01", now: tailNow },
    lagHarness.db
  );
  assert.deepEqual(
    lagRes.history.readings.map((r) => r.id),
    ["r10", "r11", "r1230", "r1255"]
  );
  assert.equal(lagHarness.counts.reads, 3, "Expected 1 rollup read + 2 newer raw tail reads");

  // 7b. 6h window completely after a frozen earlier-in-day rollup (the 8:52 PM bug)
  const frozenHarness = createMockRollupFirestore();
  await appendIndoorRollupSample(
    makeSampleReading({ id: "r0100", timestamp: "2026-11-25T01:00:00.000Z" }),
    frozenHarness.db
  );
  await appendIndoorRollupSample(
    makeSampleReading({ id: "r0150", timestamp: "2026-11-25T01:50:00.000Z" }),
    frozenHarness.db
  );
  for (const ts of [
    "2026-11-25T08:00:00.000Z",
    "2026-11-25T10:00:00.000Z",
    "2026-11-25T12:55:00.000Z",
  ]) {
    seedRawIndoor(
      frozenHarness,
      makeSampleReading({ id: `raw_${ts}`, timestamp: ts, co2_ppm: 820 })
    );
  }
  const frozenRes = await getReadingsHistoryWithSummary(
    { hours: 6, period: "6h", device_id: "feather-s3-01", now: tailNow },
    frozenHarness.db
  );
  assert.deepEqual(
    frozenRes.history.readings.map((r) => r.timestamp),
    ["2026-11-25T08:00:00.000Z", "2026-11-25T10:00:00.000Z", "2026-11-25T12:55:00.000Z"]
  );

  // 7c. forceTailCheck (?refresh=1) fetches raw tail even when rollup lag < 15m
  const freshHarness = createMockRollupFirestore();
  const r1254 = makeSampleReading({ id: "r1254", timestamp: "2026-11-25T12:54:00.000Z", co2_ppm: 680 });
  const r1259 = makeSampleReading({ id: "r1259", timestamp: "2026-11-25T12:59:00.000Z", co2_ppm: 790 });
  await appendIndoorRollupSample(r1254, freshHarness.db);
  seedRawIndoor(freshHarness, r1254);
  seedRawIndoor(freshHarness, r1259);
  freshHarness.counts.reads = 0;

  const noForceRes = await getReadingsHistoryWithSummary(
    { hours: 6, period: "6h", device_id: "feather-s3-01", now: tailNow },
    freshHarness.db
  );
  assert.equal(freshHarness.counts.reads, 1, "Expected 0 raw reads when lag < 15m and forceTailCheck is false");
  assert.deepEqual(noForceRes.history.readings.map((r) => r.id), ["r1254"]);

  const forcedRes = await getReadingsHistoryWithSummary(
    { hours: 6, period: "6h", device_id: "feather-s3-01", now: tailNow, forceTailCheck: true },
    freshHarness.db
  );
  assert.deepEqual(forcedRes.history.readings.map((r) => r.id), ["r1254", "r1259"]);

  // 7d. Outdoor tail-gap fallback (>45m behind endNow)
  const outTailHarness = createMockRollupFirestore();
  const o11 = makeSampleOutdoor({ id: "o11", timestamp: "2026-11-25T11:00:00.000Z", temperature_f: 52.0 });
  const o1255 = makeSampleOutdoor({ id: "o1255", timestamp: "2026-11-25T12:55:00.000Z", temperature_f: 56.5 });
  await appendOutdoorRollupSample(o11, outTailHarness.db);
  let outTailRaw = outTailHarness.store.get(OUTDOOR_READINGS_COLLECTION);
  if (!outTailRaw) {
    outTailRaw = new Map();
    outTailHarness.store.set(OUTDOOR_READINGS_COLLECTION, outTailRaw);
  }
  for (const o of [o11, o1255]) {
    outTailRaw.set(o.id, { ...o, timestamp: Timestamp.fromDate(new Date(o.timestamp)) });
  }
  const outTailHistory = await getOutdoorReadingsHistory(6, 200, outTailHarness.db, tailNow);
  assert.deepEqual(
    outTailHistory.map((r) => r.id),
    ["o11", "o1255"]
  );
  console.log("   [PASS] Tail-gap raw fallback on today's rollup (indoor, frozen window, forceTailCheck, outdoor)");
}

runTests()
  .then(() => {
    console.log("\nAll daily rollup verification checks passed!");
  })
  .catch((err) => {
    console.error("Rollup verification failed:", err);
    process.exitCode = 1;
  });
