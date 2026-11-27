/**
 * Focused offline verification for Outdoor Weather & AQI (Open-Meteo service,
 * indoor-vs-outdoor delta logic, Dashboard API routes, and MCP tools).
 *
 * Run via: npm --prefix functions run verify:outdoor
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Firestore } from "firebase-admin/firestore";

import type { DashboardDataService } from "../api/dashboard.js";
import { createMcpHttpHandler } from "../index.js";
import type { AirQualityDataService } from "../mcp/tools.js";
import {
  OUTDOOR_DAILY_ROLLUPS_COLLECTION,
  assessReadingHealth,
  decodeOutdoorRollupDoc,
  type AirQualityReading,
  type DeviceConfig,
  type DeviceStatus,
} from "../services/firestore.js";
import {
  HOME_OUTDOOR_FORECAST_ID,
  HOME_SITE_CONFIG_ID,
  OUTDOOR_FORECASTS_COLLECTION,
  OUTDOOR_READINGS_COLLECTION,
  SITE_CONFIGS_COLLECTION,
  buildOutdoorReadingDocId,
  computeDewPointF,
  computeIndoorOutdoorDelta,
  computeMoistAirEnthalpyKjKg,
  computeVentilationEnergyTax,
  describeWmoWeatherCode,
  fetchOpenMeteoSnapshot,
  fetchOpenMeteoSnapshotWithForecast,
  findBestVentilationWindows,
  mapUsAqiCategory,
  syncOutdoorReadingIfStale,
  type LatestOutdoorForecastResult,
  type LatestOutdoorReadingResult,
  type OutdoorForecast,
  type OutdoorReading,
  type SiteLocationConfig,
} from "../services/outdoor.js";

const TEST_BEARER = "verify-outdoor-bearer-token";

const SAMPLE_READING: AirQualityReading = {
  id: "feather-s3-01_2026-11-24T17-00-00Z",
  device_id: "feather-s3-01",
  location: "master-bedroom",
  timestamp: "2026-11-24T17:00:00.000Z",
  co2_ppm: 1180,
  temperature_c: 21.7,
  temperature_f: 71.1,
  humidity_percent: 44.0,
  pm1_0_ug_m3: 2.0,
  pm2_5_ug_m3: 4.5,
  pm10_0_ug_m3: 6.0,
  aqi_us: 25,
  aqi_category: "Good",
  particles_0_3um: 400,
  particles_0_5um: 110,
  particles_1_0um: 18,
  particles_2_5um: 2,
  particles_5_0um: 0,
  particles_10_0um: 0,
};

const SAMPLE_OUTDOOR: OutdoorReading = {
  id: "outdoor_2026-11-24T17-00-00-000Z",
  timestamp: "2026-11-24T17:00:00.000Z",
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
};

const SAMPLE_DEVICE: DeviceStatus = {
  device_id: "feather-s3-01",
  location: "master-bedroom",
  last_seen_at: "2026-11-24T17:00:00.000Z",
  minutes_since_last_seen: 2,
  status: "online",
  is_online: true,
  is_stale: false,
  firmware_version: "1.3.3",
  sensors: ["SCD-40", "PMSA003I"],
  reporting_interval_seconds: 300,
  latest_reading: {
    co2_ppm: SAMPLE_READING.co2_ppm,
    temperature_f: SAMPLE_READING.temperature_f,
    humidity_percent: SAMPLE_READING.humidity_percent,
    pm2_5_ug_m3: SAMPLE_READING.pm2_5_ug_m3,
    aqi_us: SAMPLE_READING.aqi_us,
    aqi_category: SAMPLE_READING.aqi_category,
  },
  config_version: 3,
  temperature_offset_c: 4.0,
  altitude_m: 150,
  led_enabled: true,
  ota_status: "up_to_date",
};

async function testOpenMeteoParsing(): Promise<void> {
  assert.equal(describeWmoWeatherCode(0), "Clear sky");
  assert.equal(describeWmoWeatherCode(2), "Partly cloudy");
  assert.equal(describeWmoWeatherCode(95), "Thunderstorm");
  assert.equal(mapUsAqiCategory(25), "Good");
  assert.equal(mapUsAqiCategory(88), "Moderate");
  assert.equal(mapUsAqiCategory(135), "Unhealthy for Sensitive Groups");
  assert.equal(mapUsAqiCategory(175), "Unhealthy");
  assert.equal(mapUsAqiCategory(null), null);

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 14.5,
            relative_humidity_2m: 62,
            apparent_temperature: 13.4,
            weather_code: 2,
            wind_speed_10m: 7.4,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        current: {
          pm2_5: 7.2,
          pm10: 14.0,
          us_aqi: 34,
          ozone: 48.0,
          nitrogen_dioxide: 9.5,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const snap = await fetchOpenMeteoSnapshot(
    { label: "Home Outdoor", latitude: 37.7749, longitude: -122.4194 },
    { fetchImpl: mockFetch, now: () => new Date("2026-11-24T17:00:00.000Z") }
  );
  assert.equal(snap.temperature_c, 14.5);
  assert.equal(snap.temperature_f, 58.1);
  assert.equal(snap.humidity_percent, 62);
  assert.equal(snap.weather_description, "Partly cloudy");
  assert.equal(snap.pm2_5_ug_m3, 7.2);
  assert.equal(snap.us_aqi, 34);
  assert.equal(snap.us_aqi_category, "Good");

  // Graceful fallback when Air Quality API returns 503
  const mockFetchAqDown: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 10.0,
            relative_humidity_2m: 50,
            weather_code: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Service Unavailable", { status: 503 });
  };
  const fallbackSnap = await fetchOpenMeteoSnapshot(
    { label: "Home Outdoor", latitude: 37.7749, longitude: -122.4194 },
    { fetchImpl: mockFetchAqDown, now: () => new Date("2026-11-24T17:00:00.000Z") }
  );
  assert.equal(fallbackSnap.temperature_f, 50.0);
  assert.equal(fallbackSnap.pm2_5_ug_m3, null);
  assert.equal(fallbackSnap.us_aqi, null);

  // 24h hourly forecast parsing
  const mockFetchForecast: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 20.0,
            relative_humidity_2m: 45,
            apparent_temperature: 19.5,
            weather_code: 1,
            wind_speed_10m: 5.0,
          },
          hourly: {
            time: ["2026-11-24T17:00", "2026-11-24T18:00", "2026-11-24T19:00"],
            temperature_2m: [25.0, 17.5, 17.0],
            relative_humidity_2m: [78, 48, 50],
            wind_speed_10m: [6.0, 5.0, 4.5],
            weather_code: [2, 1, 0],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        current: { pm2_5: 6.0, pm10: 10.0, us_aqi: 25, ozone: 40, nitrogen_dioxide: 8 },
        hourly: {
          time: ["2026-11-24T17:00", "2026-11-24T18:00", "2026-11-24T19:00"],
          pm2_5: [8.0, 5.2, 4.9],
          us_aqi: [33, 22, 20],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const withForecast = await fetchOpenMeteoSnapshotWithForecast(
    { label: "Home Outdoor", latitude: 37.7749, longitude: -122.4194 },
    { fetchImpl: mockFetchForecast, now: () => new Date("2026-11-24T17:00:00.000Z") }
  );
  assert.ok(withForecast.forecast);
  assert.equal(withForecast.forecast.hours.length, 3);
  assert.equal(withForecast.forecast.hours[1].timestamp, "2026-11-24T18:00:00.000Z");
  assert.equal(withForecast.forecast.hours[1].us_aqi, 22);

  console.log("[PASS] 1. Open-Meteo parsing, WMO/AQI mapping, 24h forecast, and AQ-down fallback");
}

function testIndoorOutdoorDelta(): void {
  // Psychrometrics sanity checks
  const dpIndoor = computeDewPointF(71.0, 45.0);
  assert.ok(dpIndoor > 47 && dpIndoor < 50, `Unexpected indoor dew point ${dpIndoor}`);
  const enthalpyMild = computeMoistAirEnthalpyKjKg(20.0, 50.0);
  assert.ok(enthalpyMild > 37 && enthalpyMild < 41, `Unexpected moist air enthalpy ${enthalpyMild}`);

  // Mild fall -> free
  const freeTax = computeVentilationEnergyTax(
    { temperature_f: 70.0, humidity_percent: 45.0 },
    { temperature_f: 65.0, humidity_percent: 48.0 }
  );
  assert.equal(freeTax.tier, "free");
  assert.equal(freeTax.primary_penalty, "none");

  // Cool fall -> low heating tax
  const lowTax = computeVentilationEnergyTax(
    { temperature_f: 70.0, humidity_percent: 45.0 },
    { temperature_f: 58.1, humidity_percent: 62.0 }
  );
  assert.equal(lowTax.tier, "low");
  assert.equal(lowTax.primary_penalty, "heating");

  // Muggy 72F/82% RH latent trap -> high dehumidification tax
  const humidTrap = computeVentilationEnergyTax(
    { temperature_f: 71.0, humidity_percent: 45.0 },
    { temperature_f: 72.0, humidity_percent: 82.0 }
  );
  assert.equal(humidTrap.tier, "high");
  assert.equal(humidTrap.primary_penalty, "dehumidification");

  // Hot humid summer -> high cooling + dehumidification tax
  const summerTax = computeVentilationEnergyTax(
    { temperature_f: 71.0, humidity_percent: 45.0 },
    { temperature_f: 88.0, humidity_percent: 70.0 }
  );
  assert.equal(summerTax.tier, "high");
  assert.equal(summerTax.primary_penalty, "cooling_and_dehumidification");

  // Freezing winter -> high heating tax
  const winterTax = computeVentilationEnergyTax(
    { temperature_f: 70.0, humidity_percent: 40.0 },
    { temperature_f: 28.0, humidity_percent: 55.0 }
  );
  assert.equal(winterTax.tier, "high");
  assert.equal(winterTax.primary_penalty, "heating");

  // High indoor CO2 + clean outdoor (low tax) -> open_recommended
  const openDelta = computeIndoorOutdoorDelta(SAMPLE_READING, SAMPLE_OUTDOOR);
  assert.equal(openDelta.temperature_diff_f, 13.0);
  assert.equal(openDelta.humidity_diff_percent, -18.0);
  assert.equal(openDelta.pm2_5_diff_ug_m3, -2.7);
  assert.equal(openDelta.aqi_diff, -9);
  assert.equal(openDelta.window_recommendation, "open_recommended");
  assert.equal(openDelta.energy_tax.tier, "low");

  // High indoor CO2 + clean outdoor + high energy tax -> open_brief_purge
  const purgeDelta = computeIndoorOutdoorDelta(SAMPLE_READING, {
    ...SAMPLE_OUTDOOR,
    temperature_c: 31.1,
    temperature_f: 88.0,
    humidity_percent: 70.0,
  });
  assert.equal(purgeDelta.window_recommendation, "open_brief_purge");
  assert.equal(purgeDelta.energy_tax.tier, "high");

  // Elevated indoor PM2.5 + clean outdoor + high energy tax -> keep_closed (use HEPA)
  const hepaDelta = computeIndoorOutdoorDelta(
    { ...SAMPLE_READING, co2_ppm: 650, pm2_5_ug_m3: 24.0 },
    {
      ...SAMPLE_OUTDOOR,
      temperature_c: 31.1,
      temperature_f: 88.0,
      humidity_percent: 70.0,
      pm2_5_ug_m3: 5.0,
    }
  );
  assert.equal(hepaDelta.window_recommendation, "keep_closed");

  // Unhealthy outdoor smoke -> keep_closed even with high indoor CO2
  const smokeDelta = computeIndoorOutdoorDelta(SAMPLE_READING, {
    ...SAMPLE_OUTDOOR,
    pm2_5_ug_m3: 68.5,
    us_aqi: 158,
    us_aqi_category: "Unhealthy",
  });
  assert.equal(smokeDelta.window_recommendation, "keep_closed");

  // Comfortable both inside & outside -> neutral
  const neutralDelta = computeIndoorOutdoorDelta(
    { ...SAMPLE_READING, co2_ppm: 640, pm2_5_ug_m3: 4.0 },
    SAMPLE_OUTDOOR
  );
  assert.equal(neutralDelta.window_recommendation, "neutral");

  // Forecast window finder selects clean contiguous free/low window
  const sampleForecast: OutdoorForecast = {
    fetched_at: "2026-11-24T17:00:00.000Z",
    location_label: "Home Outdoor",
    latitude: 37.7749,
    longitude: -122.4194,
    source: "open-meteo",
    hours: [
      {
        timestamp: "2026-11-24T17:00:00.000Z",
        temperature_c: 29.5,
        temperature_f: 85.1,
        humidity_percent: 72,
        dew_point_f: 75.0,
        wind_speed_mph: 4,
        weather_code: 2,
        weather_description: "Partly cloudy",
        pm2_5_ug_m3: 6.0,
        us_aqi: 25,
        us_aqi_category: "Good",
      },
      {
        timestamp: "2026-11-24T18:00:00.000Z",
        temperature_c: 18.5,
        temperature_f: 65.3,
        humidity_percent: 48,
        dew_point_f: 45.1,
        wind_speed_mph: 6,
        weather_code: 1,
        weather_description: "Mainly clear",
        pm2_5_ug_m3: 5.0,
        us_aqi: 21,
        us_aqi_category: "Good",
      },
      {
        timestamp: "2026-11-24T19:00:00.000Z",
        temperature_c: 17.8,
        temperature_f: 64.0,
        humidity_percent: 49,
        dew_point_f: 44.5,
        wind_speed_mph: 5,
        weather_code: 0,
        weather_description: "Clear sky",
        pm2_5_ug_m3: 4.8,
        us_aqi: 20,
        us_aqi_category: "Good",
      },
    ],
  };
  const winAnalysis = findBestVentilationWindows(
    { temperature_f: 71.0, humidity_percent: 45.0 },
    sampleForecast,
    { now: new Date("2026-11-24T17:00:00.000Z") }
  );
  assert.ok(winAnalysis.next_best_window);
  assert.equal(winAnalysis.next_best_window.best_tax_tier, "free");
  assert.equal(winAnalysis.next_best_window.duration_hours, 2);
  assert.equal(winAnalysis.next_best_window.start_time, "2026-11-24T18:00:00.000Z");

  console.log("[PASS] 2. Indoor-vs-outdoor delta, psychrometric energy tax & forecast window finder");
}

async function testApiAndMcpIntegration(): Promise<void> {
  let siteConfig: SiteLocationConfig | null = null;
  let latestOutdoor: LatestOutdoorReadingResult | null = null;
  const futureHour1 = new Date(Date.now() + 60 * 60_000).toISOString();
  const futureHour2 = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  let latestForecast: LatestOutdoorForecastResult | null = null;
  const outdoorHistory: OutdoorReading[] = [SAMPLE_OUTDOOR];

  const dashboardService: DashboardDataService = {
    getSensorStatus: async () => ({
      checked_at: "2026-11-24T17:02:00.000Z",
      stale_threshold_minutes: 15,
      device_count: 1,
      online_count: 1,
      stale_or_offline_count: 0,
      devices: [SAMPLE_DEVICE],
    }),
    getLatestReading: async () => ({
      reading: SAMPLE_READING,
      device: SAMPLE_DEVICE,
      minutes_ago: 2,
      is_stale: false,
      health_context: assessReadingHealth(SAMPLE_READING),
    }),
    getReadingsHistory: async () => ({
      window_start: "2026-11-23T17:00:00.000Z",
      window_end: "2026-11-24T17:00:00.000Z",
      filters: { device_id: null, location: null },
      total_matching: 1,
      returned_count: 1,
      downsampled: false,
      scan_capped: false,
      readings: [SAMPLE_READING],
    }),
    getAirQualitySummary: async () => ({
      period: "24h",
      window_start: "2026-11-23T17:00:00.000Z",
      window_end: "2026-11-24T17:00:00.000Z",
      filters: { device_id: null, location: null },
      sample_count: 1,
      scan_capped: false,
      metrics: null,
      threshold_exceedances: {
        co2_above_1000_ppm_count: 1,
        co2_above_1000_ppm_percent: 100,
        co2_above_1400_ppm_count: 0,
        pm2_5_above_9_ug_m3_count: 0,
        pm2_5_above_9_ug_m3_percent: 0,
        pm2_5_above_35_4_ug_m3_count: 0,
      },
      notable_spikes: [],
    }),
    getDeviceConfig: async () => null,
    listDeviceConfigs: async () => ({} as Record<string, DeviceConfig>),
    updateDeviceConfig: async () => {
      throw new Error("unused");
    },
    requestDeviceReboot: async () => {
      throw new Error("unused");
    },
    listFirmwareReleases: async () => [],
    getFirmwareRelease: async () => null,
    setDeviceTargetFirmwareVersion: async () => {
      throw new Error("unused");
    },
    getSiteLocationConfig: async () => siteConfig,
    updateSiteLocationConfig: async (input, updatedBy) => {
      siteConfig = {
        site_id: "home",
        ...input,
        updated_at: "2026-11-24T17:02:00.000Z",
        updated_by: updatedBy,
      };
      return siteConfig;
    },
    getLatestOutdoorReading: async () => latestOutdoor,
    getLatestOutdoorForecast: async () => latestForecast,
    getOutdoorReadingsHistory: async () => outdoorHistory,
    syncOutdoorReadingIfStale: async () => {
      if (!siteConfig) {
        return { synced: false, reason: "site_location_not_configured", reading: null };
      }
      latestOutdoor = {
        reading: {
          ...SAMPLE_OUTDOOR,
          location_label: siteConfig.label,
          latitude: siteConfig.latitude,
          longitude: siteConfig.longitude,
        },
        minutes_ago: 0,
        is_stale: false,
      };
      latestForecast = {
        forecast: {
          fetched_at: new Date().toISOString(),
          location_label: siteConfig.label,
          latitude: siteConfig.latitude,
          longitude: siteConfig.longitude,
          source: "open-meteo",
          hours: [
            {
              timestamp: futureHour1,
              temperature_c: 18.0,
              temperature_f: 64.4,
              humidity_percent: 48,
              dew_point_f: 44.3,
              wind_speed_mph: 5,
              weather_code: 1,
              weather_description: "Mainly clear",
              pm2_5_ug_m3: 5.0,
              us_aqi: 22,
              us_aqi_category: "Good",
            },
            {
              timestamp: futureHour2,
              temperature_c: 17.5,
              temperature_f: 63.5,
              humidity_percent: 50,
              dew_point_f: 44.6,
              wind_speed_mph: 4.5,
              weather_code: 0,
              weather_description: "Clear sky",
              pm2_5_ug_m3: 4.8,
              us_aqi: 20,
              us_aqi_category: "Good",
            },
          ],
        },
        minutes_ago: 0,
        is_stale: false,
      };
      return { synced: true, reason: "forced_refresh", reading: latestOutdoor.reading };
    },
  };

  const mcpService: AirQualityDataService = {
    getLatestReading: dashboardService.getLatestReading,
    getReadingsHistory: dashboardService.getReadingsHistory,
    getAirQualitySummary: dashboardService.getAirQualitySummary,
    getSensorStatus: dashboardService.getSensorStatus,
    getLatestOutdoorReading: dashboardService.getLatestOutdoorReading,
    getLatestOutdoorForecast: dashboardService.getLatestOutdoorForecast,
    getOutdoorReadingsHistory: dashboardService.getOutdoorReadingsHistory,
    syncOutdoorReadingIfStale: dashboardService.syncOutdoorReadingIfStale,
  };

  const handler = createMcpHttpHandler({
    getAuthConfig: () => ({ bearerFallbackSecret: TEST_BEARER }),
    service: mcpService,
    dashboardService,
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    Authorization: `Bearer ${TEST_BEARER}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  try {
    // 3a. Reject invalid latitude on PUT /api/site/config
    const badRes = await fetch(`${baseUrl}/api/site/config`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        label: "Home Outdoor",
        latitude: 120,
        longitude: -122.4,
        outdoor_poll_interval_minutes: 15,
      }),
    });
    assert.equal(badRes.status, 400);

    // 3b. Save valid site config -> immediately syncs outdoor reading
    const putRes = await fetch(`${baseUrl}/api/site/config`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        label: "Home Outdoor",
        latitude: 37.7749,
        longitude: -122.4194,
        outdoor_poll_interval_minutes: 15,
      }),
    });
    assert.equal(putRes.status, 200);
    const putJson = (await putRes.json()) as {
      updated: boolean;
      outdoor_sync: { synced: boolean; reading: OutdoorReading };
    };
    assert.equal(putJson.updated, true);
    assert.equal(putJson.outdoor_sync.synced, true);
    assert.equal(putJson.outdoor_sync.reading.temperature_f, 58.1);

    // 3c. Overview includes site_config, outdoor_latest, and per-device outdoor_delta
    const overviewRes = await fetch(`${baseUrl}/api/dashboard/overview`, {
      headers: authHeaders,
    });
    assert.equal(overviewRes.status, 200);
    const overviewJson = (await overviewRes.json()) as {
      site_config: SiteLocationConfig;
      outdoor_latest: LatestOutdoorReadingResult;
      ventilation_forecast: { next_best_window: { best_tax_tier: string } | null } | null;
      devices: Array<{ outdoor_delta: { window_recommendation: string; energy_tax: { tier: string } } }>;
    };
    assert.equal(overviewJson.site_config.label, "Home Outdoor");
    assert.equal(overviewJson.outdoor_latest.reading.us_aqi, 34);
    assert.equal(overviewJson.devices[0].outdoor_delta.window_recommendation, "open_recommended");
    assert.equal(overviewJson.devices[0].outdoor_delta.energy_tax.tier, "low");
    assert.equal(overviewJson.ventilation_forecast?.next_best_window?.best_tax_tier, "free");

    // 3c-ii. GET /api/outdoor/forecast returns scored 24h forecast & windows
    const forecastRes = await fetch(`${baseUrl}/api/outdoor/forecast`, {
      headers: authHeaders,
    });
    assert.equal(forecastRes.status, 200);
    const forecastJson = (await forecastRes.json()) as {
      configured: boolean;
      next_best_window: { duration_hours: number; best_tax_tier: string } | null;
      hours: unknown[];
    };
    assert.equal(forecastJson.configured, true);
    assert.equal(forecastJson.next_best_window?.best_tax_tier, "free");
    assert.equal(forecastJson.hours.length, 2);

    // 3d. History includes outdoor_history
    const histRes = await fetch(`${baseUrl}/api/readings/history?hours=24`, {
      headers: authHeaders,
    });
    assert.equal(histRes.status, 200);
    const histJson = (await histRes.json()) as { outdoor_history: OutdoorReading[] };
    assert.equal(histJson.outdoor_history.length, 1);

    console.log("[PASS] 3. Dashboard API (/api/site/config, /api/outdoor/forecast, overview deltas, outdoor_history)");

    // 4a. MCP tools/list includes get_outdoor_air_quality and get_ventilation_forecast
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listText = await listRes.text();
    assert.ok(listText.includes("get_outdoor_air_quality"), "tools/list should include get_outdoor_air_quality");
    assert.ok(listText.includes("get_ventilation_forecast"), "tools/list should include get_ventilation_forecast");

    // 4b. MCP get_latest_reading includes outdoor + outdoor_comparison
    const latestRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_latest_reading", arguments: {} },
      }),
    });
    assert.equal(latestRes.status, 200);
    const latestText = await latestRes.text();
    assert.ok(latestText.includes("outdoor_comparison"), "get_latest_reading should include outdoor_comparison");
    assert.ok(latestText.includes("open_recommended"), "get_latest_reading should include window_recommendation");

    // 4c. MCP get_outdoor_air_quality returns reading + history
    const outdoorToolRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_outdoor_air_quality", arguments: { hours: 24 } },
      }),
    });
    assert.equal(outdoorToolRes.status, 200);
    const outdoorToolText = await outdoorToolRes.text();
    assert.ok(outdoorToolText.includes("Partly cloudy"), "get_outdoor_air_quality should return weather_description");
    assert.ok(outdoorToolText.includes("history_count"), "get_outdoor_air_quality should include history_count");

    // 4d. MCP get_ventilation_forecast returns energy tax & next_best_window
    const forecastToolRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_ventilation_forecast", arguments: {} },
      }),
    });
    assert.equal(forecastToolRes.status, 200);
    const forecastToolText = await forecastToolRes.text();
    assert.ok(forecastToolText.includes("next_best_window"), "get_ventilation_forecast should include next_best_window");
    assert.ok(forecastToolText.includes("current_energy_tax"), "get_ventilation_forecast should include current_energy_tax");

    console.log("[PASS] 4. MCP get_outdoor_air_quality, get_ventilation_forecast & get_latest_reading outdoor_comparison");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testConcurrentOutdoorSyncCoalescing(): Promise<void> {
  const fixedNow = new Date("2026-11-24T17:07:30.000Z");
  assert.equal(
    buildOutdoorReadingDocId(fixedNow, 15, false),
    "outdoor_2026-11-24T17-00-00-000Z"
  );
  assert.equal(
    buildOutdoorReadingDocId(fixedNow, 15, true),
    "outdoor_2026-11-24T17-07-30-000Z"
  );

  const store = new Map<string, Map<string, Record<string, unknown>>>([
    [
      SITE_CONFIGS_COLLECTION,
      new Map([
        [
          HOME_SITE_CONFIG_ID,
          {
            label: "Home Outdoor",
            latitude: 37.7749,
            longitude: -122.4194,
            outdoor_poll_interval_minutes: 15,
            updated_at: "2026-11-24T16:00:00.000Z",
            updated_by: "owner@example.com",
          },
        ],
      ]),
    ],
    [OUTDOOR_READINGS_COLLECTION, new Map()],
    [OUTDOOR_FORECASTS_COLLECTION, new Map()],
  ]);

  let readCount = 0;
  let txLock: Promise<void> = Promise.resolve();
  const mergeDocData = (
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>
  ): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...existing, ...incoming };
    if (
      typeof existing.samples === "object" &&
      existing.samples !== null &&
      typeof incoming.samples === "object" &&
      incoming.samples !== null
    ) {
      merged.samples = {
        ...(existing.samples as Record<string, unknown>),
        ...(incoming.samples as Record<string, unknown>),
      };
    }
    return merged;
  };

  const makeDocRef = (colName: string, docId: string) => ({
    colName,
    docId,
    async get() {
      readCount += 1;
      const data = store.get(colName)?.get(docId);
      return {
        id: docId,
        exists: data !== undefined,
        data: () => (data ? { ...data } : undefined),
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const col = store.get(colName) ?? new Map<string, Record<string, unknown>>();
      store.set(colName, col);
      const existing = opts?.merge ? (col.get(docId) ?? {}) : {};
      col.set(docId, opts?.merge ? mergeDocData(existing, data) : { ...data });
    },
  });

  const mockDb = {
    collection(colName: string) {
      return {
        doc: (docId: string) => makeDocRef(colName, docId),
        orderBy: (_field: string, dir: string) => ({
          limit: (n: number) => ({
            async get() {
              const col = store.get(colName) ?? new Map<string, Record<string, unknown>>();
              const docs = Array.from(col.entries()).map(([id, data]) => ({
                id,
                data: () => ({ ...data }),
              }));
              docs.sort((a, b) => {
                const ta = String(a.data().timestamp ?? "");
                const tb = String(b.data().timestamp ?? "");
                return dir === "desc" ? tb.localeCompare(ta) : ta.localeCompare(tb);
              });
              const sliced = docs.slice(0, n);
              readCount += Math.max(1, sliced.length);
              return { empty: sliced.length === 0, docs: sliced };
            },
          }),
        }),
      };
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const prev = txLock;
      let release!: () => void;
      txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        const tx = {
          get: (ref: ReturnType<typeof makeDocRef>) => ref.get(),
          set: (
            ref: ReturnType<typeof makeDocRef>,
            data: Record<string, unknown>,
            opts?: { merge?: boolean }
          ) => {
            const col = store.get(ref.colName) ?? new Map<string, Record<string, unknown>>();
            store.set(ref.colName, col);
            const existing = opts?.merge ? (col.get(ref.docId) ?? {}) : {};
            col.set(ref.docId, { ...existing, ...data });
          },
        };
        return await fn(tx);
      } finally {
        release();
      }
    },
  } as unknown as Firestore;

  let fetchCalls = 0;
  const mockFetch: typeof fetch = async (input) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 14.5,
            relative_humidity_2m: 62,
            apparent_temperature: 13.4,
            weather_code: 2,
            wind_speed_10m: 7.4,
          },
          hourly: {
            time: ["2026-11-24T18:00", "2026-11-24T19:00"],
            temperature_2m: [17.0, 16.5],
            relative_humidity_2m: [50, 52],
            wind_speed_10m: [6.0, 5.0],
            weather_code: [1, 0],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        current: { pm2_5: 7.2, pm10: 14.0, us_aqi: 34, ozone: 48.0, nitrogen_dioxide: 9.5 },
        hourly: {
          time: ["2026-11-24T18:00", "2026-11-24T19:00"],
          pm2_5: [5.5, 5.0],
          us_aqi: [24, 21],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const [first, second] = await Promise.all([
    syncOutdoorReadingIfStale({
      db: mockDb,
      deps: { fetchImpl: mockFetch, now: () => fixedNow },
    }),
    syncOutdoorReadingIfStale({
      db: mockDb,
      deps: { fetchImpl: mockFetch, now: () => fixedNow },
    }),
  ]);

  assert.equal(fetchCalls, 2, "Expected exactly 1 Open-Meteo sync cycle (weather + AQ)");
  assert.equal(
    [first.synced, second.synced].filter(Boolean).length,
    1,
    "Expected only one concurrent trigger to acquire the sync lease"
  );
  assert.equal(
    store.get(OUTDOOR_READINGS_COLLECTION)?.size,
    1,
    "Expected only 1 outdoor_readings doc written"
  );

  // Explicit force=true bypasses the lease and writes a new snapshot
  const forcedNow = new Date("2026-11-24T17:08:00.000Z");
  const forced = await syncOutdoorReadingIfStale({
    force: true,
    db: mockDb,
    deps: { fetchImpl: mockFetch, now: () => forcedNow },
  });
  assert.equal(forced.synced, true);
  assert.equal(forced.reason, "forced_refresh");
  assert.equal(fetchCalls, 4);
  assert.equal(store.get(OUTDOOR_READINGS_COLLECTION)?.size, 2);

  // Verify outdoor_daily_rollups and outdoor_forecasts/home received synced snapshots
  const rollupDoc = store.get(OUTDOOR_DAILY_ROLLUPS_COLLECTION)?.get("2026-11-24");
  assert.ok(rollupDoc, "Expected outdoor_daily_rollups/2026-11-24 to be populated");
  const decodedRollups = decodeOutdoorRollupDoc(rollupDoc);
  assert.equal(decodedRollups.length, 2);

  const forecastDoc = store.get(OUTDOOR_FORECASTS_COLLECTION)?.get(HOME_OUTDOOR_FORECAST_ID);
  assert.ok(forecastDoc, "Expected outdoor_forecasts/home to be populated");
  assert.equal((forecastDoc.hours as unknown[]).length, 2);

  // Verify includeReading: false performs only 1 Firestore read on cached_fresh trigger hit
  const readsBeforeCached = readCount;
  const cachedOutcome = await syncOutdoorReadingIfStale({
    includeReading: false,
    db: mockDb,
    deps: { fetchImpl: mockFetch, now: () => new Date("2026-11-24T17:10:00.000Z") },
  });
  assert.equal(cachedOutcome.synced, false);
  assert.equal(cachedOutcome.reading, null);
  assert.equal(
    readCount - readsBeforeCached,
    1,
    "Expected only 1 Firestore read (site_configs/home) when includeReading=false"
  );
  console.log("[PASS] 5. Concurrent outdoor sync coalesces via lease while force=true refreshes");
}

async function main(): Promise<void> {
  await testOpenMeteoParsing();
  testIndoorOutdoorDelta();
  await testApiAndMcpIntegration();
  await testConcurrentOutdoorSyncCoalescing();
  console.log("\nAll Outdoor Weather & AQI verification checks passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
