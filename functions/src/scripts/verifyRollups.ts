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
  groupContiguousDateRanges,
  listUtcDateStrings,
  readIndoorReadingsFromRollups,
  readOutdoorReadingsFromRollups,
  type AirQualityReading,
} from "../services/firestore.js";
import type { OutdoorReading } from "../services/outdoor.js";

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
}

runTests()
  .then(() => {
    console.log("\nAll daily rollup verification checks passed!");
  })
  .catch((err) => {
    console.error("Rollup verification failed:", err);
    process.exitCode = 1;
  });
