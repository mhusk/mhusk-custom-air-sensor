import assert from "node:assert/strict";

import {
  assessReadingHealth,
  computeAirQualitySummaryFromReadings,
  computeMetricStats,
  detectNotableSpikes,
  downsampleReadings,
  getAirQualitySummary,
  getDb,
  getLatestReading,
  getReadingsHistory,
  getSensorStatus,
  type AirQualityReading,
} from "../services/firestore.js";
import { resolveProjectId } from "./projectId.js";

function makeReading(
  overrides: Partial<AirQualityReading> & { timestamp: string }
): AirQualityReading {
  return {
    id: overrides.id ?? `reading_${overrides.timestamp}`,
    device_id: overrides.device_id ?? "feather-s3-01",
    location: overrides.location ?? "home-office",
    timestamp: overrides.timestamp,
    co2_ppm: overrides.co2_ppm ?? 650,
    temperature_c: overrides.temperature_c ?? 22.0,
    temperature_f: overrides.temperature_f ?? 71.6,
    humidity_percent: overrides.humidity_percent ?? 45.0,
    pm1_0_ug_m3: overrides.pm1_0_ug_m3 ?? 3,
    pm2_5_ug_m3: overrides.pm2_5_ug_m3 ?? 6,
    pm10_0_ug_m3: overrides.pm10_0_ug_m3 ?? 10,
    aqi_us: overrides.aqi_us ?? 33,
    aqi_category: overrides.aqi_category ?? "Good",
    particles_0_3um: overrides.particles_0_3um ?? 800,
    particles_0_5um: overrides.particles_0_5um ?? 220,
    particles_1_0um: overrides.particles_1_0um ?? 40,
    particles_2_5um: overrides.particles_2_5um ?? 4,
    particles_5_0um: overrides.particles_5_0um ?? 1,
    particles_10_0um: overrides.particles_10_0um ?? 0,
  };
}

function runOfflineUnitChecks(): void {
  console.log("1. Running offline statistical & helper checks...");

  // Single-value stats (mirrors the single synthetic reading from Step 4)
  const singleStats = computeMetricStats([642], 0);
  assert.deepEqual(singleStats, { min: 642, max: 642, avg: 642, p95: 642 });

  // Multi-value stats with p95 linear interpolation
  const series = [420, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1500];
  const multiStats = computeMetricStats(series, 1);
  assert.equal(multiStats.min, 420);
  assert.equal(multiStats.max, 1500);
  assert.equal(multiStats.avg, 872);
  assert.equal(multiStats.p95, 1365);
  console.log("   [PASS] computeMetricStats() single & multi-point calculations");

  // Downsampling preserves endpoints and caps count
  const items = Array.from({ length: 200 }, (_, idx) => idx);
  const sampled = downsampleReadings(items, 25);
  assert.equal(sampled.length, 25);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[sampled.length - 1], 199);
  assert.deepEqual(downsampleReadings([1, 2, 3], 10), [1, 2, 3]);
  console.log("   [PASS] downsampleReadings() preserves endpoints & caps length");

  // Health assessment thresholds
  const goodHealth = assessReadingHealth(
    makeReading({ timestamp: "2026-11-22T12:00:00Z", co2_ppm: 642, pm2_5_ug_m3: 6, humidity_percent: 44.8 })
  );
  assert.equal(goodHealth.co2_level, "optimal");
  assert.equal(goodHealth.pm2_5_level, "good");
  assert.equal(goodHealth.humidity_level, "ideal");

  const poorHealth = assessReadingHealth(
    makeReading({ timestamp: "2026-11-22T12:05:00Z", co2_ppm: 1520, pm2_5_ug_m3: 42, humidity_percent: 24 })
  );
  assert.equal(poorHealth.co2_level, "poor");
  assert.equal(poorHealth.pm2_5_level, "unhealthy_sensitive");
  assert.equal(poorHealth.humidity_level, "dry");
  console.log("   [PASS] assessReadingHealth() CO2, PM2.5, and humidity bands");

  // Spike episode grouping
  const spikeSeries: AirQualityReading[] = [
    makeReading({ timestamp: "2026-11-22T10:00:00Z", co2_ppm: 650, pm2_5_ug_m3: 5 }),
    makeReading({ timestamp: "2026-11-22T10:05:00Z", co2_ppm: 1120, pm2_5_ug_m3: 6 }),
    makeReading({ timestamp: "2026-11-22T10:10:00Z", co2_ppm: 1450, pm2_5_ug_m3: 18 }),
    makeReading({ timestamp: "2026-11-22T10:15:00Z", co2_ppm: 1200, pm2_5_ug_m3: 24 }),
    makeReading({ timestamp: "2026-11-22T10:20:00Z", co2_ppm: 780, pm2_5_ug_m3: 7 }),
  ];
  const spikes = detectNotableSpikes(spikeSeries);
  assert.equal(spikes.length, 2);

  const co2Spike = spikes.find((s) => s.metric === "co2_ppm");
  assert.ok(co2Spike);
  assert.equal(co2Spike.peak_value, 1450);
  assert.equal(co2Spike.peak_timestamp, "2026-11-22T10:10:00Z");
  assert.equal(co2Spike.reading_count, 3);
  assert.equal(co2Spike.severity, "high");

  const pmSpike = spikes.find((s) => s.metric === "pm2_5_ug_m3");
  assert.ok(pmSpike);
  assert.equal(pmSpike.peak_value, 24);
  assert.equal(pmSpike.peak_timestamp, "2026-11-22T10:15:00Z");
  assert.equal(pmSpike.reading_count, 2);
  assert.equal(pmSpike.severity, "elevated");
  console.log("   [PASS] detectNotableSpikes() contiguous episode grouping & peaks");

  // Pure summary computation (empty + populated)
  const emptySummary = computeAirQualitySummaryFromReadings([], {
    period: "24h",
    windowStart: new Date("2026-11-22T00:00:00Z"),
    windowEnd: new Date("2026-11-23T00:00:00Z"),
    scanCapped: false,
  });
  assert.equal(emptySummary.sample_count, 0);
  assert.equal(emptySummary.metrics, null);

  const filledSummary = computeAirQualitySummaryFromReadings(spikeSeries, {
    period: "24h",
    windowStart: new Date("2026-11-22T00:00:00Z"),
    windowEnd: new Date("2026-11-23T00:00:00Z"),
    device_id: "feather-s3-01",
    scanCapped: false,
  });
  assert.equal(filledSummary.sample_count, 5);
  assert.equal(filledSummary.metrics?.co2_ppm.max, 1450);
  assert.equal(filledSummary.threshold_exceedances.co2_above_1000_ppm_count, 3);
  assert.equal(filledSummary.threshold_exceedances.co2_above_1400_ppm_count, 1);
  assert.equal(filledSummary.notable_spikes.length, 2);
  console.log("   [PASS] computeAirQualitySummaryFromReadings() empty & spike aggregation");
}

async function runLiveFirestoreChecks(): Promise<void> {
  console.log("\n2. Running live Cloud Firestore query checks...");
  const projectId = resolveProjectId();
  if (!projectId) {
    throw new Error(
      "Could not determine Firebase project ID. Ensure .firebaserc exists or set FIREBASE_PROJECT_ID."
    );
  }

  const db = getDb({ projectId });

  const latest = await getLatestReading({}, db);
  assert.ok(
    latest !== null,
    "Expected at least 1 reading in Firestore (from Step 4 synthetic publish)."
  );
  console.log(
    `   [PASS] getLatestReading() -> device=${latest.reading.device_id}, location=${latest.reading.location}, CO2=${latest.reading.co2_ppm} ppm, PM2.5=${latest.reading.pm2_5_ug_m3} ug/m3, AQI=${latest.reading.aqi_us} (${latest.reading.aqi_category}), ${latest.minutes_ago}m ago`
  );

  const history = await getReadingsHistory(
    { hours: 24, device_id: latest.reading.device_id, limit: 50 },
    db
  );
  assert.ok(history.returned_count >= 1, "Expected >= 1 reading in 24h history.");
  console.log(
    `   [PASS] getReadingsHistory(24h, device_id=${latest.reading.device_id}) -> ${history.returned_count}/${history.total_matching} reading(s), downsampled=${history.downsampled}`
  );

  const summary = await getAirQualitySummary(
    { period: "24h", location: latest.reading.location },
    db
  );
  assert.ok(summary.sample_count >= 1 && summary.metrics !== null);
  console.log(
    `   [PASS] getAirQualitySummary(24h, location=${latest.reading.location}) -> samples=${summary.sample_count}, CO2 avg=${summary.metrics.co2_ppm.avg} ppm (p95=${summary.metrics.co2_ppm.p95}), PM2.5 avg=${summary.metrics.pm2_5_ug_m3.avg} ug/m3, spikes=${summary.notable_spikes.length}`
  );

  const status = await getSensorStatus({}, db);
  assert.ok(status.device_count >= 1, "Expected >= 1 device in `devices` collection.");
  const primary = status.devices[0];
  console.log(
    `   [PASS] getSensorStatus() -> devices=${status.device_count} (online=${status.online_count}, stale/offline=${status.stale_or_offline_count}), first=${primary.device_id} [${primary.status}, ${primary.minutes_since_last_seen}m ago]`
  );
}

async function main(): Promise<void> {
  const runLive = process.argv.includes("--live");
  runOfflineUnitChecks();

  if (runLive) {
    try {
      await runLiveFirestoreChecks();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n[FAIL] Live Firestore verification failed: ${message}`);
      if (
        message.includes("PERMISSION_DENIED") &&
        process.env.GOOGLE_APPLICATION_CREDENTIALS
      ) {
        console.error(
          "\nHint: GOOGLE_APPLICATION_CREDENTIALS is set in your shell environment and may\n" +
            "point to a service account from a different Google Cloud project.\n" +
            "Try clearing it to fall back to default ADC:\n" +
            "  GOOGLE_APPLICATION_CREDENTIALS= npm --prefix functions run verify:firestore -- --live"
        );
      } else if (
        message.includes("Could not load the default credentials") ||
        message.includes("UNAUTHENTICATED") ||
        message.includes("default credentials")
      ) {
        console.error(
          "\nHint: `firebase-admin` needs Google Application Default Credentials locally.\n" +
            "  Option A: Run `gcloud auth application-default login`\n" +
            "  Option B: Download a temporary service account key (gitignored as *service-account*.json)\n" +
            "            and run: GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run verify:firestore -- --live"
        );
      }
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(
      "\nTip: Pass `--live` to verify live Firestore reads against the Step 4 synthetic reading:"
    );
    console.log("  npm run verify:firestore -- --live");
  }

  console.log("\nAll Firestore service verification checks passed!");
}

await main();
