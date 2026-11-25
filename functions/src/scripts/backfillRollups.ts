import { fileURLToPath } from "node:url";

import { getApps, initializeApp, type Credential } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import {
  DAILY_ROLLUPS_COLLECTION,
  OUTDOOR_DAILY_ROLLUPS_COLLECTION,
  READINGS_COLLECTION,
  groupIndoorReadingsIntoRollupDocs,
  groupOutdoorReadingsIntoRollupDocs,
  parseTimestampToDateOrNull,
  roundTo,
  type AirQualityReading,
  type AqiCategory,
} from "../services/firestore.js";
import {
  OUTDOOR_READINGS_COLLECTION,
  describeWmoWeatherCode,
  mapUsAqiCategory,
  type OutdoorReading,
} from "../services/outdoor.js";
import { resolveProjectId } from "./projectId.js";

const DEFAULT_BACKFILL_DAYS = 30;
const MAX_BACKFILL_DAYS = 365;
const QUERY_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 100;

export interface BackfillCliArgs {
  days: number;
  projectId?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliArgs {
  const args: BackfillCliArgs = {
    days: DEFAULT_BACKFILL_DAYS,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--days") {
      const next = argv[++i];
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BACKFILL_DAYS) {
        throw new Error(`--days must be an integer between 1 and ${MAX_BACKFILL_DAYS}.`);
      }
      args.days = parsed;
    } else if (token === "--project") {
      const next = argv[++i];
      if (!next || next.trim().length === 0) {
        throw new Error("--project requires a non-empty Firebase project ID.");
      }
      args.projectId = next.trim();
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage: npm --prefix functions run backfill:rollups -- [options]

Backfills UTC-day rollup documents in \`daily_rollups\` and \`outdoor_daily_rollups\`
from raw \`readings\` and \`outdoor_readings\` documents.

Options:
  --days <N>       Lookback window in days (1-${MAX_BACKFILL_DAYS}, default ${DEFAULT_BACKFILL_DAYS})
  --project <id>   Firebase project ID override (defaults to .firebaserc / env)
  --dry-run        Scan raw collections and report planned rollup counts without writing
  -h, --help       Show this help message
`);
}

function createStaticTokenCredential(accessToken: string): Credential {
  return {
    getAccessToken: async () => ({
      access_token: accessToken,
      expires_in: 3600,
    }),
  };
}

function getBackfillFirestore(projectId: string): Firestore {
  const existingDefault = getApps().find((app) => app.name === "[DEFAULT]");
  if (existingDefault) {
    return getFirestore(existingDefault);
  }

  const explicitToken =
    process.env.FIRESTORE_ACCESS_TOKEN?.trim() ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();

  const app = explicitToken
    ? initializeApp({
        projectId,
        credential: createStaticTokenCredential(explicitToken),
      })
    : initializeApp({ projectId });

  return getFirestore(app);
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mapRawIndoorDoc(doc: QueryDocumentSnapshot<DocumentData>): AirQualityReading | null {
  const data = doc.data();
  const deviceId = typeof data.device_id === "string" ? data.device_id.trim() : "";
  const tsDate = parseTimestampToDateOrNull(data.timestamp);
  if (!deviceId || !tsDate) {
    return null;
  }

  return {
    id: doc.id,
    device_id: deviceId,
    location: typeof data.location === "string" ? data.location : "",
    timestamp: tsDate.toISOString(),
    co2_ppm: num(data.co2_ppm),
    temperature_c: num(data.temperature_c),
    temperature_f: num(data.temperature_f),
    humidity_percent: num(data.humidity_percent),
    pm1_0_ug_m3: num(data.pm1_0_ug_m3),
    pm2_5_ug_m3: num(data.pm2_5_ug_m3),
    pm10_0_ug_m3: num(data.pm10_0_ug_m3),
    aqi_us: num(data.aqi_us),
    aqi_category: (typeof data.aqi_category === "string" ? data.aqi_category : "Good") as AqiCategory,
    particles_0_3um: num(data.particles_0_3um),
    particles_0_5um: num(data.particles_0_5um),
    particles_1_0um: num(data.particles_1_0um),
    particles_2_5um: num(data.particles_2_5um),
    particles_5_0um: num(data.particles_5_0um),
    particles_10_0um: num(data.particles_10_0um),
  };
}

function mapRawOutdoorDoc(doc: QueryDocumentSnapshot<DocumentData>): OutdoorReading | null {
  const data = doc.data();
  const tsDate = parseTimestampToDateOrNull(data.timestamp);
  const tc = numOrNull(data.temperature_c);
  const tf = numOrNull(data.temperature_f);
  const rh = numOrNull(data.humidity_percent);
  const lat = numOrNull(data.latitude);
  const lon = numOrNull(data.longitude);
  if (!tsDate || tc === null || tf === null || rh === null || lat === null || lon === null) {
    return null;
  }

  const wcode = numOrNull(data.weather_code);
  const aqi = numOrNull(data.us_aqi);
  const aqiRounded = aqi !== null ? Math.round(aqi) : null;

  return {
    id: doc.id,
    timestamp: tsDate.toISOString(),
    location_label:
      typeof data.location_label === "string" && data.location_label.trim().length > 0
        ? data.location_label.trim()
        : "Home Outdoor",
    latitude: roundTo(lat, 5),
    longitude: roundTo(lon, 5),
    source: "open-meteo",
    temperature_c: roundTo(tc, 2),
    temperature_f: roundTo(tf, 1),
    apparent_temperature_f:
      numOrNull(data.apparent_temperature_f) !== null
        ? roundTo(numOrNull(data.apparent_temperature_f)!, 1)
        : null,
    humidity_percent: roundTo(rh, 1),
    wind_speed_mph:
      numOrNull(data.wind_speed_mph) !== null
        ? roundTo(numOrNull(data.wind_speed_mph)!, 1)
        : null,
    weather_code: wcode !== null ? Math.round(wcode) : null,
    weather_description:
      typeof data.weather_description === "string" && data.weather_description.trim().length > 0
        ? data.weather_description.trim()
        : describeWmoWeatherCode(wcode),
    pm2_5_ug_m3:
      numOrNull(data.pm2_5_ug_m3) !== null ? roundTo(numOrNull(data.pm2_5_ug_m3)!, 1) : null,
    pm10_0_ug_m3:
      numOrNull(data.pm10_0_ug_m3) !== null ? roundTo(numOrNull(data.pm10_0_ug_m3)!, 1) : null,
    us_aqi: aqiRounded,
    us_aqi_category: mapUsAqiCategory(aqiRounded),
    ozone_ug_m3:
      numOrNull(data.ozone_ug_m3) !== null ? roundTo(numOrNull(data.ozone_ug_m3)!, 1) : null,
    nitrogen_dioxide_ug_m3:
      numOrNull(data.nitrogen_dioxide_ug_m3) !== null
        ? roundTo(numOrNull(data.nitrogen_dioxide_ug_m3)!, 1)
        : null,
  };
}

async function scanCollectionInWindow<T>(
  db: Firestore,
  collectionName: string,
  cutoff: Date,
  mapper: (doc: QueryDocumentSnapshot<DocumentData>) => T | null
): Promise<{ scannedDocs: number; items: T[] }> {
  const items: T[] = [];
  let scannedDocs = 0;
  let cursor: QueryDocumentSnapshot<DocumentData> | undefined;

  while (true) {
    let query = db
      .collection(collectionName)
      .where("timestamp", ">=", Timestamp.fromDate(cutoff))
      .orderBy("timestamp", "asc")
      .limit(QUERY_PAGE_SIZE);

    if (cursor) {
      query = query.startAfter(cursor);
    }

    const snap = await query.get();
    if (snap.empty) {
      break;
    }

    scannedDocs += snap.size;
    for (const doc of snap.docs) {
      const mapped = mapper(doc);
      if (mapped) {
        items.push(mapped);
      }
    }

    if (snap.size < QUERY_PAGE_SIZE) {
      break;
    }
    cursor = snap.docs[snap.docs.length - 1];
  }

  return { scannedDocs, items };
}

async function commitRollupBatches(
  db: Firestore,
  writes: Array<{ collection: string; docId: string; payload: Record<string, unknown> }>
): Promise<void> {
  const nowTs = Timestamp.now();
  for (let i = 0; i < writes.length; i += WRITE_BATCH_SIZE) {
    const chunk = writes.slice(i, i + WRITE_BATCH_SIZE);
    const batch = db.batch();
    for (const item of chunk) {
      const ref = db.collection(item.collection).doc(item.docId);
      batch.set(
        ref,
        {
          ...item.payload,
          updated_at: nowTs,
        },
        { merge: true }
      );
    }
    await batch.commit();
  }
}

export async function runBackfill(
  args: BackfillCliArgs,
  db?: Firestore
): Promise<{
  days: number;
  dryRun: boolean;
  indoorScanned: number;
  indoorRollupDocs: number;
  outdoorScanned: number;
  outdoorRollupDocs: number;
}> {
  const resolvedDb =
    db ??
    (() => {
      const projectId = resolveProjectId(args.projectId);
      if (!projectId) {
        throw new Error(
          "Could not resolve Firebase project ID. Pass --project <id> or set .firebaserc."
        );
      }
      return getBackfillFirestore(projectId);
    })();

  const cutoff = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  const [indoorScan, outdoorScan] = await Promise.all([
    scanCollectionInWindow(resolvedDb, READINGS_COLLECTION, cutoff, mapRawIndoorDoc),
    scanCollectionInWindow(resolvedDb, OUTDOOR_READINGS_COLLECTION, cutoff, mapRawOutdoorDoc),
  ]);

  const indoorGroups = groupIndoorReadingsIntoRollupDocs(indoorScan.items);
  const outdoorGroups = groupOutdoorReadingsIntoRollupDocs(outdoorScan.items);

  if (!args.dryRun) {
    const writes = [
      ...indoorGroups.map((g) => ({
        collection: DAILY_ROLLUPS_COLLECTION,
        docId: g.docId,
        payload: {
          device_id: g.device_id,
          date: g.date,
          samples: g.samples,
        },
      })),
      ...outdoorGroups.map((g) => ({
        collection: OUTDOOR_DAILY_ROLLUPS_COLLECTION,
        docId: g.docId,
        payload: {
          date: g.date,
          samples: g.samples,
        },
      })),
    ];
    await commitRollupBatches(resolvedDb, writes);
  }

  return {
    days: args.days,
    dryRun: args.dryRun,
    indoorScanned: indoorScan.scannedDocs,
    indoorRollupDocs: indoorGroups.length,
    outdoorScanned: outdoorScan.scannedDocs,
    outdoorRollupDocs: outdoorGroups.length,
  };
}

async function main(): Promise<void> {
  const args = parseBackfillCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const summary = await runBackfill(args);
  const modeLabel = summary.dryRun ? "DRY RUN (no writes performed)" : "LIVE WRITE COMPLETE";
  console.log(`\nDaily Rollups Backfill — ${modeLabel}`);
  console.log(`  Window:               last ${summary.days} day(s)`);
  console.log(`  Indoor readings scan: ${summary.indoorScanned} raw docs -> ${summary.indoorRollupDocs} daily_rollups docs`);
  console.log(`  Outdoor readings scan:${summary.outdoorScanned} raw docs -> ${summary.outdoorRollupDocs} outdoor_daily_rollups docs`);
}

const isMainModule =
  process.argv[1] && pathResolveMatches(process.argv[1], fileURLToPath(import.meta.url));

function pathResolveMatches(a: string, b: string): boolean {
  return a === b;
}

if (isMainModule) {
  main().catch((err) => {
    console.error("[backfill:rollups] Failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
