/**
 * Offline unit & mock-Firestore verification for experiments & House Physics Playbook
 * (`experiments` and `house_playbook/summary`).
 *
 * Run via: npm --prefix functions run verify:experiments
 */
import assert from "node:assert/strict";

import { Timestamp, type DocumentData, type Firestore } from "firebase-admin/firestore";

import {
  DEVICES_COLLECTION,
  EXPERIMENTS_COLLECTION,
  HOUSE_PLAYBOOK_COLLECTION,
  HOUSE_PLAYBOOK_SUMMARY_DOC_ID,
  appendIndoorRollupSample,
  appendOutdoorRollupSample,
  type AirQualityReading,
} from "../services/firestore.js";
import {
  OUTDOOR_READINGS_COLLECTION,
  type OutdoorReading,
} from "../services/outdoor.js";
import {
  computeMean,
  computeMedian,
  computeMetricSnapshot,
  computePlaybookFromExperiments,
  createExperiment,
  evaluateExperimentOutcome,
  getExperiment,
  getHousePlaybook,
  listExperiments,
  rankPlaybookRecommendations,
  updateExperiment,
  type ExperimentRecord,
} from "../services/experiments.js";

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

function createMockExperimentsFirestore(): {
  db: Firestore;
  store: Map<string, Map<string, DocumentData>>;
  counts: { reads: number; writes: number };
} {
  const store = new Map<string, Map<string, DocumentData>>();
  const counts = { reads: 0, writes: 0 };

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
      counts.reads += refs.length;
      return refs.map((ref) => makeSnap(ref.__col, ref.id));
    },
  } as unknown as Firestore;

  return { db, store, counts };
}

function makeReading(
  deviceId: string,
  location: string,
  isoTime: string,
  overrides: Partial<AirQualityReading> = {}
): AirQualityReading {
  return {
    id: `${deviceId}_${Date.parse(isoTime)}`,
    device_id: deviceId,
    location,
    timestamp: isoTime,
    co2_ppm: 1000,
    temperature_c: 21.11,
    temperature_f: 70.0,
    humidity_percent: 45.0,
    pm1_0_ug_m3: 4,
    pm2_5_ug_m3: 8.0,
    pm10_0_ug_m3: 10,
    aqi_us: 33,
    aqi_category: "Good",
    particles_0_3um: 400,
    particles_0_5um: 100,
    particles_1_0um: 20,
    particles_2_5um: 3,
    particles_5_0um: 1,
    particles_10_0um: 0,
    ...overrides,
  };
}

function makeOutdoor(isoTime: string, overrides: Partial<OutdoorReading> = {}): OutdoorReading {
  return {
    id: `outdoor_${isoTime}`,
    timestamp: isoTime,
    location_label: "Home Outdoor",
    latitude: 37.7749,
    longitude: -122.4194,
    source: "open-meteo",
    temperature_c: 19.0,
    temperature_f: 66.2,
    apparent_temperature_f: 65.0,
    humidity_percent: 48.0,
    wind_speed_mph: 6.0,
    weather_code: 1,
    weather_description: "Mainly clear",
    pm2_5_ug_m3: 4.5,
    pm10_0_ug_m3: 9.0,
    us_aqi: 19,
    us_aqi_category: "Good",
    ozone_ug_m3: 32,
    nitrogen_dioxide_ug_m3: 8,
    ...overrides,
  };
}

function makeSyntheticEvaluatedExperiment(
  overrides: Partial<ExperimentRecord> = {}
): ExperimentRecord {
  return {
    id: "exp_syn_1",
    action_type: "crack_window",
    custom_label: null,
    device_id: "feather-s3-01",
    location: "master-bedroom",
    started_at: "2026-11-27T12:00:00.000Z",
    ended_at: "2026-11-27T12:10:00.000Z",
    duration_minutes: 10,
    notes: null,
    status: "evaluated",
    source: "dashboard",
    outdoor_snapshot: null,
    energy_tax_tier: "free",
    evaluation: {
      baseline: {
        sample_count: 3,
        co2_ppm: 1200,
        pm2_5_ug_m3: 10,
        temperature_f: 70,
        humidity_percent: 45,
      },
      post_settle: {
        sample_count: 3,
        co2_ppm: 900,
        pm2_5_ug_m3: 8,
        temperature_f: 68.5,
        humidity_percent: 43,
      },
      co2_delta_ppm: -300,
      co2_rate_ppm_per_min: -30,
      pm2_5_delta_ug_m3: -2,
      temp_delta_f: -1.5,
      humidity_delta_percent: -2,
      cross_room_deltas: [],
      evaluated_at: "2026-11-27T12:30:00.000Z",
    },
    created_at: "2026-11-27T12:00:00.000Z",
    created_by: "owner",
    updated_at: "2026-11-27T12:30:00.000Z",
    ...overrides,
  };
}

async function testPureHelpersAndPlaybookRanking(): Promise<void> {
  assert.equal(computeMedian([]), 0);
  assert.equal(computeMedian([10]), 10);
  assert.equal(computeMedian([30, 10, 20]), 20);
  assert.equal(computeMedian([40, 10, 30, 20]), 25);
  assert.equal(computeMean([10, 20, 30]), 20);

  assert.equal(computeMetricSnapshot([]), null);
  const snap = computeMetricSnapshot([
    makeReading("d1", "room", "2026-11-27T10:00:00.000Z", {
      co2_ppm: 1000,
      pm2_5_ug_m3: 10,
      temperature_f: 70,
      humidity_percent: 44,
    }),
    makeReading("d1", "room", "2026-11-27T10:05:00.000Z", {
      co2_ppm: 1100,
      pm2_5_ug_m3: 14,
      temperature_f: 71,
      humidity_percent: 46,
    }),
  ]);
  assert.ok(snap);
  assert.equal(snap.sample_count, 2);
  assert.equal(snap.co2_ppm, 1050);
  assert.equal(snap.pm2_5_ug_m3, 12);
  assert.equal(snap.temperature_f, 70.5);
  assert.equal(snap.humidity_percent, 45);

  // Build synthetic evaluated experiments across tiers, confidence levels, and statuses
  const exps: ExperimentRecord[] = [
    makeSyntheticEvaluatedExperiment({
      id: "e1",
      evaluation: {
        ...makeSyntheticEvaluatedExperiment().evaluation!,
        co2_delta_ppm: -200,
        co2_rate_ppm_per_min: -20,
      },
    }),
    makeSyntheticEvaluatedExperiment({
      id: "e2",
      evaluation: {
        ...makeSyntheticEvaluatedExperiment().evaluation!,
        co2_delta_ppm: -300,
        co2_rate_ppm_per_min: -30,
      },
    }),
    makeSyntheticEvaluatedExperiment({
      id: "e3",
      ended_at: "2026-11-27T14:10:00.000Z",
      evaluation: {
        ...makeSyntheticEvaluatedExperiment().evaluation!,
        co2_delta_ppm: -700, // outlier pushes mean to -400 while median stays -300
        co2_rate_ppm_per_min: -70,
      },
    }),
    // HEPA purifier (6 samples -> high confidence, strong PM2.5 reduction)
    ...Array.from({ length: 6 }, (_, i) =>
      makeSyntheticEvaluatedExperiment({
        id: `hepa_${i}`,
        action_type: "hepa_purifier",
        energy_tax_tier: "high",
        evaluation: {
          ...makeSyntheticEvaluatedExperiment().evaluation!,
          co2_delta_ppm: 0,
          co2_rate_ppm_per_min: 0,
          pm2_5_delta_ug_m3: -18,
          temp_delta_f: 0.1,
          humidity_delta_percent: 0,
        },
      })
    ),
    // Other location entry
    makeSyntheticEvaluatedExperiment({
      id: "other_loc",
      location: "kitchen-living",
      action_type: "cross_ventilate",
      energy_tax_tier: "free",
      evaluation: {
        ...makeSyntheticEvaluatedExperiment().evaluation!,
        co2_delta_ppm: -650,
        co2_rate_ppm_per_min: -65,
      },
    }),
    // Ignored: insufficient_data, dismissed, pending_evaluation
    makeSyntheticEvaluatedExperiment({
      id: "ignored_insufficient",
      evaluation: {
        ...makeSyntheticEvaluatedExperiment().evaluation!,
        insufficient_data: true,
      },
    }),
    makeSyntheticEvaluatedExperiment({
      id: "ignored_dismissed",
      status: "dismissed",
    }),
    makeSyntheticEvaluatedExperiment({
      id: "ignored_pending",
      status: "pending_evaluation",
      evaluation: null,
    }),
  ];

  const playbook = computePlaybookFromExperiments(exps, new Date("2026-11-27T15:00:00.000Z"));
  assert.equal(playbook.evaluated_experiment_count, 10);
  assert.equal(playbook.entries.length, 3);

  const crackFree = playbook.entries.find(
    (e) => e.location === "master-bedroom" && e.action_type === "crack_window"
  );
  assert.ok(crackFree);
  assert.equal(crackFree.sample_count, 3);
  assert.equal(crackFree.confidence, "medium");
  assert.equal(crackFree.co2_delta_ppm, -300);
  assert.equal(crackFree.co2_delta_mean_ppm, -400);
  assert.equal(crackFree.last_observed_at, "2026-11-27T14:10:00.000Z");

  const hepaHigh = playbook.entries.find((e) => e.action_type === "hepa_purifier");
  assert.ok(hepaHigh);
  assert.equal(hepaHigh.confidence, "high");

  const otherLoc = playbook.entries.find((e) => e.location === "kitchen-living");
  assert.ok(otherLoc);
  assert.equal(otherLoc.confidence, "low");

  const rankedCo2 = rankPlaybookRecommendations(playbook, {
    location: "master-bedroom",
    energy_tax_tier: "free",
    primary_goal: "lower_co2",
  });
  assert.equal(rankedCo2[0].entry.action_type, "crack_window");
  assert.equal(rankedCo2[0].match_quality, "exact_tier");
  assert.equal(rankedCo2[1].entry.action_type, "hepa_purifier");
  assert.equal(rankedCo2[1].match_quality, "same_location");
  assert.equal(rankedCo2[2].entry.location, "kitchen-living");
  assert.equal(rankedCo2[2].match_quality, "other_location");

  const rankedPm = rankPlaybookRecommendations(playbook, {
    location: "master-bedroom",
    primary_goal: "lower_pm2_5",
  });
  assert.equal(rankedPm[0].entry.action_type, "hepa_purifier");
}

async function testCrudEvaluationAndCrossRoomRollups(): Promise<void> {
  const { db, store } = createMockExperimentsFirestore();

  // Seed device status and outdoor baseline
  await db.collection(DEVICES_COLLECTION).doc("feather-s3-01").set({
    device_id: "feather-s3-01",
    location: "master-bedroom",
    latest_reading: {
      co2_ppm: 1250,
      temperature_f: 70.0,
      humidity_percent: 45.0,
      pm2_5_ug_m3: 8.0,
      aqi_us: 33,
      aqi_category: "Good",
    },
  });

  await db
    .collection(OUTDOOR_READINGS_COLLECTION)
    .doc("outdoor_now")
    .set({
      ...makeOutdoor("2026-11-27T15:00:00.000Z"),
      timestamp: Timestamp.fromDate(new Date("2026-11-27T15:00:00.000Z")),
    });

  const nowCreate = new Date("2026-11-27T15:05:00.000Z");

  // 1. Active experiment creation with auto-resolved location & outdoor energy tax
  const activeExp = await createExperiment(
    {
      action_type: "crack_window",
      device_id: "feather-s3-01",
      notes: "Cracked bedroom window 2 inches",
      source: "dashboard",
      created_by: "user@example.com",
      now: nowCreate,
    },
    db
  );
  assert.equal(activeExp.status, "active");
  assert.equal(activeExp.location, "master-bedroom");
  assert.equal(activeExp.ended_at, null);
  assert.ok(activeExp.outdoor_snapshot);
  assert.equal(activeExp.energy_tax_tier, "free");

  const fetched = await getExperiment(activeExp.id, db);
  assert.ok(fetched);
  assert.equal(fetched.id, activeExp.id);

  // 2. Finish active experiment before 20m settle window -> remains pending_evaluation
  const endedAtIso = "2026-11-27T15:15:00.000Z";
  const pendingExp = await updateExperiment(
    activeExp.id,
    {
      ended_at: endedAtIso,
      now: new Date("2026-11-27T15:20:00.000Z"),
    },
    db
  );
  assert.ok(pendingExp);
  assert.equal(pendingExp.status, "pending_evaluation");
  assert.equal(pendingExp.duration_minutes, 10);
  assert.equal(pendingExp.evaluation, null);

  // Pre-settle guard check on direct evaluateExperimentOutcome
  const stillPending = await evaluateExperimentOutcome(activeExp.id, {
    db,
    now: new Date("2026-11-27T15:30:00.000Z"),
  });
  assert.ok(stillPending);
  assert.equal(stillPending.status, "pending_evaluation");
  assert.equal(stillPending.evaluation, null);

  // 3. Seed daily_rollups for target (feather-s3-01) and sibling (feather-s3-02)
  const preSamples = [
    { ts: "2026-11-27T14:52:00.000Z", co2: 1200, pm: 10, tf: 70.0, rh: 46.0 },
    { ts: "2026-11-27T14:57:00.000Z", co2: 1250, pm: 10, tf: 70.0, rh: 46.0 },
    { ts: "2026-11-27T15:02:00.000Z", co2: 1300, pm: 10, tf: 70.0, rh: 46.0 },
  ];
  const postSamples = [
    { ts: "2026-11-27T15:17:00.000Z", co2: 880, pm: 6, tf: 68.0, rh: 44.0 },
    { ts: "2026-11-27T15:22:00.000Z", co2: 850, pm: 6, tf: 68.0, rh: 44.0 },
    { ts: "2026-11-27T15:27:00.000Z", co2: 820, pm: 6, tf: 68.0, rh: 44.0 },
  ];
  for (const s of [...preSamples, ...postSamples]) {
    await appendIndoorRollupSample(
      makeReading("feather-s3-01", "master-bedroom", s.ts, {
        co2_ppm: s.co2,
        pm2_5_ug_m3: s.pm,
        temperature_f: s.tf,
        humidity_percent: s.rh,
      }),
      db
    );
  }
  await appendIndoorRollupSample(
    makeReading("feather-s3-02", "kitchen-living", "2026-11-27T14:55:00.000Z", {
      co2_ppm: 800,
      pm2_5_ug_m3: 8,
      temperature_f: 71.0,
      humidity_percent: 45.0,
    }),
    db
  );
  await appendIndoorRollupSample(
    makeReading("feather-s3-02", "kitchen-living", "2026-11-27T15:25:00.000Z", {
      co2_ppm: 760,
      pm2_5_ug_m3: 7,
      temperature_f: 70.5,
      humidity_percent: 44.5,
    }),
    db
  );

  // Evaluate once 20m post-settle window has elapsed
  const evaluated = await evaluateExperimentOutcome(activeExp.id, {
    db,
    now: new Date("2026-11-27T15:36:00.000Z"),
  });
  assert.ok(evaluated);
  assert.equal(evaluated.status, "evaluated");
  assert.ok(evaluated.evaluation);
  assert.equal(evaluated.evaluation.insufficient_data, undefined);
  assert.equal(evaluated.evaluation.baseline.sample_count, 3);
  assert.equal(evaluated.evaluation.post_settle.sample_count, 3);
  assert.equal(evaluated.evaluation.co2_delta_ppm, -400);
  assert.equal(evaluated.evaluation.co2_rate_ppm_per_min, -40);
  assert.equal(evaluated.evaluation.pm2_5_delta_ug_m3, -4);
  assert.equal(evaluated.evaluation.temp_delta_f, -2);
  assert.equal(evaluated.evaluation.humidity_delta_percent, -2);
  assert.equal(evaluated.evaluation.cross_room_deltas.length, 1);
  assert.equal(evaluated.evaluation.cross_room_deltas[0].device_id, "feather-s3-02");
  assert.equal(evaluated.evaluation.cross_room_deltas[0].co2_delta_ppm, -40);

  // Confirm house_playbook/summary was automatically populated
  const playbook = await getHousePlaybook(db);
  assert.equal(playbook.evaluated_experiment_count, 1);
  assert.equal(playbook.entries.length, 1);
  assert.equal(playbook.entries[0].co2_delta_ppm, -400);
  assert.ok(store.get(HOUSE_PLAYBOOK_COLLECTION)?.has(HOUSE_PLAYBOOK_SUMMARY_DOC_ID));

  // 4. Retroactive experiment created with duration_minutes, auto-backfilling outdoor from outdoor_daily_rollups
  await appendOutdoorRollupSample(
    makeOutdoor("2026-11-26T12:00:00.000Z", {
      temperature_f: 88.0,
      humidity_percent: 72.0,
    }),
    db
  );
  await appendIndoorRollupSample(
    makeReading("feather-s3-01", "master-bedroom", "2026-11-26T11:50:00.000Z", {
      co2_ppm: 1400,
      temperature_f: 72.0,
      humidity_percent: 45.0,
    }),
    db
  );
  await appendIndoorRollupSample(
    makeReading("feather-s3-01", "master-bedroom", "2026-11-26T12:20:00.000Z", {
      co2_ppm: 1000,
      temperature_f: 74.0,
      humidity_percent: 51.0,
    }),
    db
  );

  const retroExp = await createExperiment(
    {
      action_type: "cross_ventilate",
      device_id: "feather-s3-01",
      started_at: "2026-11-26T12:00:00.000Z",
      duration_minutes: 10,
      source: "mcp",
      now: new Date("2026-11-27T15:40:00.000Z"),
    },
    db
  );
  assert.equal(retroExp.status, "evaluated");
  assert.equal(retroExp.ended_at, "2026-11-26T12:10:00.000Z");
  assert.equal(retroExp.energy_tax_tier, "high");
  assert.equal(retroExp.evaluation?.co2_delta_ppm, -400);

  // 5. Insufficient-data experiment marks insufficient_data=true and stays out of playbook
  const noDataExp = await createExperiment(
    {
      action_type: "open_door",
      device_id: "feather-s3-01",
      started_at: "2026-11-25T10:00:00.000Z",
      duration_minutes: 15,
      now: new Date("2026-11-27T15:40:00.000Z"),
    },
    db
  );
  assert.equal(noDataExp.status, "evaluated");
  assert.equal(noDataExp.evaluation?.insufficient_data, true);

  const playbookAfterNoData = await getHousePlaybook(db);
  assert.equal(playbookAfterNoData.evaluated_experiment_count, 2);

  // 6. Unlabeled experiment labeling + dismissing evaluated experiment rebuilds playbook
  const unlabeled = await createExperiment(
    {
      action_type: "custom",
      device_id: "feather-s3-01",
      started_at: "2026-11-27T15:30:00.000Z",
      ended_at: "2026-11-27T15:35:00.000Z",
      status: "unlabeled",
      source: "auto_detected",
      evaluate_if_ready: false,
      now: new Date("2026-11-27T15:35:00.000Z"),
    },
    db
  );
  assert.equal(unlabeled.status, "unlabeled");

  const labeled = await updateExperiment(
    unlabeled.id,
    {
      action_type: "hepa_purifier",
      evaluate_if_ready: false,
      now: new Date("2026-11-27T15:36:00.000Z"),
    },
    db
  );
  assert.equal(labeled?.status, "pending_evaluation");

  // Dismissing activeExp removes it from house_playbook/summary
  const dismissed = await updateExperiment(
    activeExp.id,
    { status: "dismissed", now: new Date("2026-11-27T15:45:00.000Z") },
    db
  );
  assert.equal(dismissed?.status, "dismissed");
  const playbookAfterDismiss = await getHousePlaybook(db);
  assert.equal(playbookAfterDismiss.evaluated_experiment_count, 1);
  assert.equal(playbookAfterDismiss.entries.length, 1);
  assert.equal(playbookAfterDismiss.entries[0].action_type, "cross_ventilate");

  // List & filtering checks
  const allList = await listExperiments({ limit: 10 }, db);
  assert.equal(allList.length, 4);
  assert.ok(store.get(EXPERIMENTS_COLLECTION)?.size === 4);

  const pendingOnly = await listExperiments({ status: "pending_evaluation" }, db);
  assert.equal(pendingOnly.length, 1);
  assert.equal(pendingOnly[0].id, unlabeled.id);

  // Invalid end < start rejected
  await assert.rejects(
    createExperiment(
      {
        action_type: "crack_window",
        device_id: "feather-s3-01",
        started_at: "2026-11-27T12:00:00.000Z",
        ended_at: "2026-11-27T11:55:00.000Z",
      },
      db
    ),
    /greater than or equal/
  );
}

async function main(): Promise<void> {
  await testPureHelpersAndPlaybookRanking();
  await testCrudEvaluationAndCrossRoomRollups();
  console.log("PASS: verifyExperiments (all experiment & house playbook assertions passed)");
}

main().catch((error) => {
  console.error("FAIL: verifyExperiments", error);
  process.exit(1);
});
