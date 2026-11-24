import {
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import {
  getDb,
  type AirQualityReading,
  type AqiCategory,
  type DeviceLatestReadingSnapshot,
} from "./firestore.js";

export const SITE_CONFIGS_COLLECTION = "site_configs";
export const HOME_SITE_CONFIG_ID = "home";
export const OUTDOOR_READINGS_COLLECTION = "outdoor_readings";

export const DEFAULT_OUTDOOR_POLL_INTERVAL_MINUTES = 15;
export const MIN_OUTDOOR_POLL_INTERVAL_MINUTES = 5;
export const MAX_OUTDOOR_POLL_INTERVAL_MINUTES = 60;
export const OUTDOOR_STALE_THRESHOLD_MINUTES = 45;
export const OPEN_METEO_TIMEOUT_MS = 8000;

export interface SiteLocationConfig {
  site_id: string;
  label: string;
  latitude: number;
  longitude: number;
  outdoor_poll_interval_minutes: number;
  updated_at: string;
  updated_by: string;
}

export interface UpdateSiteLocationConfigInput {
  label: string;
  latitude: number;
  longitude: number;
  outdoor_poll_interval_minutes: number;
}

export interface OutdoorReading {
  id: string;
  timestamp: string;
  location_label: string;
  latitude: number;
  longitude: number;
  source: "open-meteo";
  temperature_c: number;
  temperature_f: number;
  apparent_temperature_f: number | null;
  humidity_percent: number;
  wind_speed_mph: number | null;
  weather_code: number | null;
  weather_description: string;
  pm2_5_ug_m3: number | null;
  pm10_0_ug_m3: number | null;
  us_aqi: number | null;
  us_aqi_category: AqiCategory | null;
  ozone_ug_m3: number | null;
  nitrogen_dioxide_ug_m3: number | null;
}

export interface LatestOutdoorReadingResult {
  reading: OutdoorReading;
  minutes_ago: number;
  is_stale: boolean;
}

export type WindowRecommendation = "open_recommended" | "neutral" | "keep_closed";

export interface IndoorOutdoorDelta {
  temperature_diff_f: number;
  temperature_diff_c: number;
  humidity_diff_percent: number;
  pm2_5_diff_ug_m3: number | null;
  aqi_diff: number | null;
  window_recommendation: WindowRecommendation;
  window_reason: string;
}

export interface OpenMeteoFetchDependencies {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toNumberOrNull(value: unknown): number | null {
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

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

/**
 * Maps a numeric US EPA AQI value (0–500) to its official category string.
 */
export function mapUsAqiCategory(aqi: number | null): AqiCategory | null {
  if (aqi === null || !Number.isFinite(aqi) || aqi < 0) {
    return null;
  }
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/**
 * Translates WMO Weather Interpretation Codes (used by Open-Meteo) into concise
 * human-readable labels.
 */
export function describeWmoWeatherCode(code: number | null): string {
  if (code === null || !Number.isFinite(code)) {
    return "Unknown";
  }
  const rounded = Math.round(code);
  const table: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Light rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Light snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };
  return table[rounded] ?? `Weather code ${rounded}`;
}

/**
 * Computes indoor-minus-outdoor deltas and an actionable window ventilation
 * recommendation. Positive temperature/humidity deltas mean indoors is warmer
 * or more humid; negative PM2.5/AQI deltas mean indoors is cleaner.
 */
export function computeIndoorOutdoorDelta(
  indoor: Pick<
    AirQualityReading | DeviceLatestReadingSnapshot,
    "co2_ppm" | "temperature_f" | "humidity_percent" | "pm2_5_ug_m3" | "aqi_us"
  >,
  outdoor: OutdoorReading
): IndoorOutdoorDelta {
  const temperatureDiffF = roundTo(indoor.temperature_f - outdoor.temperature_f, 1);
  const indoorTempC = ((indoor.temperature_f - 32) * 5) / 9;
  const temperatureDiffC = roundTo(indoorTempC - outdoor.temperature_c, 1);
  const humidityDiffPercent = roundTo(
    indoor.humidity_percent - outdoor.humidity_percent,
    1
  );
  const pm25Diff =
    outdoor.pm2_5_ug_m3 !== null
      ? roundTo(indoor.pm2_5_ug_m3 - outdoor.pm2_5_ug_m3, 1)
      : null;
  const aqiDiff =
    outdoor.us_aqi !== null ? Math.round(indoor.aqi_us - outdoor.us_aqi) : null;

  let windowRecommendation: WindowRecommendation = "neutral";
  let windowReason =
    "Indoor and outdoor air are both in comfortable ranges; ventilate as desired for comfort.";

  const outdoorAirUnhealthy =
    (outdoor.us_aqi !== null && outdoor.us_aqi > 100) ||
    (outdoor.pm2_5_ug_m3 !== null && outdoor.pm2_5_ug_m3 > 35.4);

  const outdoorAirClean =
    (outdoor.us_aqi === null || outdoor.us_aqi <= 80) &&
    (outdoor.pm2_5_ug_m3 === null || outdoor.pm2_5_ug_m3 <= 20.0);

  if (outdoorAirUnhealthy) {
    windowRecommendation = "keep_closed";
    windowReason =
      "Outdoor particulate air quality is elevated; keep windows closed and rely on indoor HEPA filtration.";
  } else if (indoor.co2_ppm > 1000 && outdoorAirClean) {
    windowRecommendation = "open_recommended";
    windowReason = `Indoor CO2 is elevated (${Math.round(indoor.co2_ppm)} ppm) while outdoor air is clean — cracking a window will refresh the room.`;
  } else if (
    indoor.pm2_5_ug_m3 > 12.0 &&
    outdoor.pm2_5_ug_m3 !== null &&
    outdoor.pm2_5_ug_m3 + 3.0 < indoor.pm2_5_ug_m3
  ) {
    windowRecommendation = "open_recommended";
    windowReason = `Outdoor PM2.5 (${outdoor.pm2_5_ug_m3.toFixed(1)} ug/m3) is noticeably lower than indoors (${indoor.pm2_5_ug_m3.toFixed(1)} ug/m3) — ventilating will help clear indoor particles.`;
  } else if (
    indoor.pm2_5_ug_m3 <= 9.0 &&
    outdoor.pm2_5_ug_m3 !== null &&
    outdoor.pm2_5_ug_m3 > 15.0
  ) {
    windowRecommendation = "keep_closed";
    windowReason = `Indoor air is cleaner than outdoor PM2.5 (${outdoor.pm2_5_ug_m3.toFixed(1)} ug/m3); keep windows closed unless CO2 climbs above 1,000 ppm.`;
  }

  return {
    temperature_diff_f: temperatureDiffF,
    temperature_diff_c: temperatureDiffC,
    humidity_diff_percent: humidityDiffPercent,
    pm2_5_diff_ug_m3: pm25Diff,
    aqi_diff: aqiDiff,
    window_recommendation: windowRecommendation,
    window_reason: windowReason,
  };
}

function mapSiteLocationConfigDoc(
  siteId: string,
  data: DocumentData
): SiteLocationConfig | null {
  const latitude = toNumberOrNull(data.latitude);
  const longitude = toNumberOrNull(data.longitude);
  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const label =
    typeof data.label === "string" && data.label.trim().length > 0
      ? data.label.trim()
      : "Home Outdoor";
  const rawInterval = toNumberOrNull(data.outdoor_poll_interval_minutes);
  const pollInterval =
    rawInterval !== null
      ? Math.max(
          MIN_OUTDOOR_POLL_INTERVAL_MINUTES,
          Math.min(MAX_OUTDOOR_POLL_INTERVAL_MINUTES, Math.round(rawInterval))
        )
      : DEFAULT_OUTDOOR_POLL_INTERVAL_MINUTES;

  const updatedAt = toDate(data.updated_at) ?? new Date(0);
  const updatedBy =
    typeof data.updated_by === "string" && data.updated_by.trim().length > 0
      ? data.updated_by.trim()
      : "unknown";

  return {
    site_id: siteId,
    label,
    latitude: roundTo(latitude, 5),
    longitude: roundTo(longitude, 5),
    outdoor_poll_interval_minutes: pollInterval,
    updated_at: updatedAt.toISOString(),
    updated_by: updatedBy,
  };
}

function mapOutdoorReadingDoc(doc: QueryDocumentSnapshot<DocumentData>): OutdoorReading | null {
  const data = doc.data();
  const timestamp = toDate(data.timestamp);
  const temperatureC = toNumberOrNull(data.temperature_c);
  const temperatureF = toNumberOrNull(data.temperature_f);
  const humidityPercent = toNumberOrNull(data.humidity_percent);
  const latitude = toNumberOrNull(data.latitude);
  const longitude = toNumberOrNull(data.longitude);

  if (
    !timestamp ||
    temperatureC === null ||
    temperatureF === null ||
    humidityPercent === null ||
    latitude === null ||
    longitude === null
  ) {
    return null;
  }

  const weatherCode = toNumberOrNull(data.weather_code);
  const usAqi = toNumberOrNull(data.us_aqi);
  const usAqiRounded = usAqi !== null ? Math.round(usAqi) : null;

  return {
    id: doc.id,
    timestamp: timestamp.toISOString(),
    location_label:
      typeof data.location_label === "string" && data.location_label.trim().length > 0
        ? data.location_label.trim()
        : "Home Outdoor",
    latitude: roundTo(latitude, 5),
    longitude: roundTo(longitude, 5),
    source: "open-meteo",
    temperature_c: roundTo(temperatureC, 2),
    temperature_f: roundTo(temperatureF, 1),
    apparent_temperature_f:
      toNumberOrNull(data.apparent_temperature_f) !== null
        ? roundTo(toNumberOrNull(data.apparent_temperature_f)!, 1)
        : null,
    humidity_percent: roundTo(humidityPercent, 1),
    wind_speed_mph:
      toNumberOrNull(data.wind_speed_mph) !== null
        ? roundTo(toNumberOrNull(data.wind_speed_mph)!, 1)
        : null,
    weather_code: weatherCode !== null ? Math.round(weatherCode) : null,
    weather_description:
      typeof data.weather_description === "string" && data.weather_description.trim().length > 0
        ? data.weather_description.trim()
        : describeWmoWeatherCode(weatherCode),
    pm2_5_ug_m3:
      toNumberOrNull(data.pm2_5_ug_m3) !== null
        ? roundTo(toNumberOrNull(data.pm2_5_ug_m3)!, 1)
        : null,
    pm10_0_ug_m3:
      toNumberOrNull(data.pm10_0_ug_m3) !== null
        ? roundTo(toNumberOrNull(data.pm10_0_ug_m3)!, 1)
        : null,
    us_aqi: usAqiRounded,
    us_aqi_category: mapUsAqiCategory(usAqiRounded),
    ozone_ug_m3:
      toNumberOrNull(data.ozone_ug_m3) !== null
        ? roundTo(toNumberOrNull(data.ozone_ug_m3)!, 1)
        : null,
    nitrogen_dioxide_ug_m3:
      toNumberOrNull(data.nitrogen_dioxide_ug_m3) !== null
        ? roundTo(toNumberOrNull(data.nitrogen_dioxide_ug_m3)!, 1)
        : null,
  };
}

/**
 * Fetches current weather and air quality conditions from Open-Meteo (free, no API key).
 */
export async function fetchOpenMeteoSnapshot(
  config: Pick<SiteLocationConfig, "label" | "latitude" | "longitude">,
  deps: OpenMeteoFetchDependencies = {}
): Promise<Omit<OutdoorReading, "id">> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ? deps.now() : new Date();

  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.searchParams.set("latitude", String(config.latitude));
  weatherUrl.searchParams.set("longitude", String(config.longitude));
  weatherUrl.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m"
  );
  weatherUrl.searchParams.set("temperature_unit", "celsius");
  weatherUrl.searchParams.set("wind_speed_unit", "mph");
  weatherUrl.searchParams.set("timezone", "UTC");

  const airUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  airUrl.searchParams.set("latitude", String(config.latitude));
  airUrl.searchParams.set("longitude", String(config.longitude));
  airUrl.searchParams.set("current", "pm2_5,pm10,us_aqi,ozone,nitrogen_dioxide");
  airUrl.searchParams.set("timezone", "UTC");

  const [weatherRes, airRes] = await Promise.all([
    fetchImpl(weatherUrl.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OPEN_METEO_TIMEOUT_MS),
    }),
    fetchImpl(airUrl.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OPEN_METEO_TIMEOUT_MS),
    }),
  ]);

  if (!weatherRes.ok) {
    throw new Error(`Open-Meteo weather request failed with HTTP ${weatherRes.status}`);
  }
  const weatherJson = (await weatherRes.json()) as {
    current?: Record<string, unknown>;
  };
  const weatherCurrent = weatherJson.current;
  if (!weatherCurrent) {
    throw new Error("Open-Meteo weather response missing 'current' object.");
  }

  const tempC = toNumberOrNull(weatherCurrent.temperature_2m);
  const humidity = toNumberOrNull(weatherCurrent.relative_humidity_2m);
  if (tempC === null || humidity === null) {
    throw new Error("Open-Meteo weather response missing temperature_2m or relative_humidity_2m.");
  }

  const tempF = roundTo((tempC * 9) / 5 + 32, 1);
  const apparentC = toNumberOrNull(weatherCurrent.apparent_temperature);
  const apparentF = apparentC !== null ? roundTo((apparentC * 9) / 5 + 32, 1) : null;
  const windMph = toNumberOrNull(weatherCurrent.wind_speed_10m);
  const weatherCode = toNumberOrNull(weatherCurrent.weather_code);

  // Air quality endpoint is treated as best-effort so weather still succeeds if AQ is briefly unavailable
  let pm25: number | null = null;
  let pm10: number | null = null;
  let usAqi: number | null = null;
  let ozone: number | null = null;
  let no2: number | null = null;

  if (airRes.ok) {
    const airJson = (await airRes.json()) as {
      current?: Record<string, unknown>;
    };
    const airCurrent = airJson.current;
    if (airCurrent) {
      const rawPm25 = toNumberOrNull(airCurrent.pm2_5);
      const rawPm10 = toNumberOrNull(airCurrent.pm10);
      const rawAqi = toNumberOrNull(airCurrent.us_aqi);
      const rawOzone = toNumberOrNull(airCurrent.ozone);
      const rawNo2 = toNumberOrNull(airCurrent.nitrogen_dioxide);

      pm25 = rawPm25 !== null ? roundTo(rawPm25, 1) : null;
      pm10 = rawPm10 !== null ? roundTo(rawPm10, 1) : null;
      usAqi = rawAqi !== null ? Math.round(rawAqi) : null;
      ozone = rawOzone !== null ? roundTo(rawOzone, 1) : null;
      no2 = rawNo2 !== null ? roundTo(rawNo2, 1) : null;
    }
  }

  return {
    timestamp: now.toISOString(),
    location_label: config.label,
    latitude: roundTo(config.latitude, 5),
    longitude: roundTo(config.longitude, 5),
    source: "open-meteo",
    temperature_c: roundTo(tempC, 2),
    temperature_f: tempF,
    apparent_temperature_f: apparentF,
    humidity_percent: roundTo(humidity, 1),
    wind_speed_mph: windMph !== null ? roundTo(windMph, 1) : null,
    weather_code: weatherCode !== null ? Math.round(weatherCode) : null,
    weather_description: describeWmoWeatherCode(weatherCode),
    pm2_5_ug_m3: pm25,
    pm10_0_ug_m3: pm10,
    us_aqi: usAqi,
    us_aqi_category: mapUsAqiCategory(usAqi),
    ozone_ug_m3: ozone,
    nitrogen_dioxide_ug_m3: no2,
  };
}

export async function getSiteLocationConfig(
  db: Firestore = getDb()
): Promise<SiteLocationConfig | null> {
  const snap = await db.collection(SITE_CONFIGS_COLLECTION).doc(HOME_SITE_CONFIG_ID).get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data();
  return data ? mapSiteLocationConfigDoc(snap.id, data) : null;
}

export async function updateSiteLocationConfig(
  input: UpdateSiteLocationConfigInput,
  updatedBy: string,
  db: Firestore = getDb()
): Promise<SiteLocationConfig> {
  const now = new Date();
  const payload = {
    label: input.label.trim(),
    latitude: roundTo(input.latitude, 5),
    longitude: roundTo(input.longitude, 5),
    outdoor_poll_interval_minutes: Math.max(
      MIN_OUTDOOR_POLL_INTERVAL_MINUTES,
      Math.min(MAX_OUTDOOR_POLL_INTERVAL_MINUTES, Math.round(input.outdoor_poll_interval_minutes))
    ),
    updated_at: Timestamp.fromDate(now),
    updated_by: updatedBy,
  };

  await db
    .collection(SITE_CONFIGS_COLLECTION)
    .doc(HOME_SITE_CONFIG_ID)
    .set(payload, { merge: true });

  return {
    site_id: HOME_SITE_CONFIG_ID,
    label: payload.label,
    latitude: payload.latitude,
    longitude: payload.longitude,
    outdoor_poll_interval_minutes: payload.outdoor_poll_interval_minutes,
    updated_at: now.toISOString(),
    updated_by: updatedBy,
  };
}

export async function getLatestOutdoorReading(
  db: Firestore = getDb(),
  now: Date = new Date()
): Promise<LatestOutdoorReadingResult | null> {
  const snap = await db
    .collection(OUTDOOR_READINGS_COLLECTION)
    .orderBy("timestamp", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    return null;
  }

  const mapped = mapOutdoorReadingDoc(snap.docs[0]);
  if (!mapped) {
    return null;
  }

  const minutesAgo = Math.max(
    0,
    roundTo((now.getTime() - Date.parse(mapped.timestamp)) / 60_000, 1)
  );
  return {
    reading: mapped,
    minutes_ago: minutesAgo,
    is_stale: minutesAgo > OUTDOOR_STALE_THRESHOLD_MINUTES,
  };
}

export async function getOutdoorReadingsHistory(
  hours: number = 24,
  limit: number = 200,
  db: Firestore = getDb(),
  now: Date = new Date()
): Promise<OutdoorReading[]> {
  const clampedHours = Math.max(1, Math.min(168, Math.round(hours)));
  const clampedLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const startDate = new Date(now.getTime() - clampedHours * 60 * 60 * 1000);

  const snap = await db
    .collection(OUTDOOR_READINGS_COLLECTION)
    .where("timestamp", ">=", Timestamp.fromDate(startDate))
    .orderBy("timestamp", "asc")
    .limit(1000)
    .get();

  const readings: OutdoorReading[] = [];
  for (const doc of snap.docs) {
    const mapped = mapOutdoorReadingDoc(doc);
    if (mapped) {
      readings.push(mapped);
    }
  }

  if (readings.length <= clampedLimit) {
    return readings;
  }

  // Evenly downsample preserving first & last samples
  const step = (readings.length - 1) / (clampedLimit - 1);
  const sampled: OutdoorReading[] = [];
  for (let i = 0; i < clampedLimit; i += 1) {
    sampled.push(readings[Math.round(i * step)]);
  }
  return sampled;
}

/**
 * Checks whether a fresh outdoor weather + AQI reading should be fetched from
 * Open-Meteo and written to `outdoor_readings`.
 *
 * Called automatically by the `syncOutdoorOnReading` Firestore trigger (throttled
 * by `outdoor_poll_interval_minutes`, default 15 min) and on-demand when the user
 * updates their Home Location or clicks Refresh.
 */
export async function syncOutdoorReadingIfStale(
  options: { force?: boolean; db?: Firestore; deps?: OpenMeteoFetchDependencies } = {}
): Promise<{
  synced: boolean;
  reason: string;
  reading: OutdoorReading | null;
}> {
  const db = options.db ?? getDb();
  const now = options.deps?.now ? options.deps.now() : new Date();

  const siteConfig = await getSiteLocationConfig(db);
  if (!siteConfig) {
    return {
      synced: false,
      reason: "site_location_not_configured",
      reading: null,
    };
  }

  const latest = await getLatestOutdoorReading(db, now);
  if (
    !options.force &&
    latest &&
    latest.minutes_ago < siteConfig.outdoor_poll_interval_minutes
  ) {
    return {
      synced: false,
      reason: `cached_fresh (${latest.minutes_ago}m < ${siteConfig.outdoor_poll_interval_minutes}m)`,
      reading: latest.reading,
    };
  }

  const snapshot = await fetchOpenMeteoSnapshot(siteConfig, options.deps);
  const docId = `outdoor_${now.toISOString().replace(/[:.]/g, "-")}`;
  const writeData = {
    ...snapshot,
    timestamp: Timestamp.fromDate(new Date(snapshot.timestamp)),
  };

  await db.collection(OUTDOOR_READINGS_COLLECTION).doc(docId).set(writeData);

  return {
    synced: true,
    reason: options.force ? "forced_refresh" : "cache_expired",
    reading: {
      id: docId,
      ...snapshot,
    },
  };
}
