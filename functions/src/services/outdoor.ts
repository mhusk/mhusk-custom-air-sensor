import {
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import {
  appendOutdoorRollupSample,
  downsampleReadings,
  formatUtcDateString,
  getDb,
  groupContiguousDateRanges,
  parseTimestampToDateOrNull,
  readOutdoorReadingsFromRollups,
  roundTo,
  utcDayRange,
  type AirQualityReading,
  type AqiCategory,
  type DeviceLatestReadingSnapshot,
} from "./firestore.js";

export const SITE_CONFIGS_COLLECTION = "site_configs";
export const HOME_SITE_CONFIG_ID = "home";
export const OUTDOOR_READINGS_COLLECTION = "outdoor_readings";
export const OUTDOOR_FORECASTS_COLLECTION = "outdoor_forecasts";
export const HOME_OUTDOOR_FORECAST_ID = "home";

export const DEFAULT_OUTDOOR_POLL_INTERVAL_MINUTES = 15;
export const MIN_OUTDOOR_POLL_INTERVAL_MINUTES = 5;
export const MAX_OUTDOOR_POLL_INTERVAL_MINUTES = 60;
export const OUTDOOR_STALE_THRESHOLD_MINUTES = 45;
export const OUTDOOR_FORECAST_STALE_THRESHOLD_MINUTES = 120;
export const OUTDOOR_SYNC_LEASE_MS = 60_000;
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

export type WindowRecommendation =
  | "open_recommended"
  | "open_brief_purge"
  | "neutral"
  | "keep_closed";

export type EnergyTaxTier = "free" | "low" | "moderate" | "high";

export type EnergyPenaltyType =
  | "none"
  | "cooling"
  | "heating"
  | "dehumidification"
  | "cooling_and_dehumidification";

export interface VentilationEnergyTax {
  tier: EnergyTaxTier;
  sensible_delta_f: number;
  dew_point_indoor_f: number;
  dew_point_outdoor_f: number;
  dew_point_delta_f: number;
  indoor_enthalpy_kj_kg: number;
  outdoor_enthalpy_kj_kg: number;
  enthalpy_delta_kj_kg: number;
  primary_penalty: EnergyPenaltyType;
  summary: string;
}

export interface IndoorOutdoorDelta {
  temperature_diff_f: number;
  temperature_diff_c: number;
  humidity_diff_percent: number;
  pm2_5_diff_ug_m3: number | null;
  aqi_diff: number | null;
  window_recommendation: WindowRecommendation;
  window_reason: string;
  energy_tax: VentilationEnergyTax;
}

export interface OutdoorForecastHour {
  timestamp: string;
  temperature_c: number;
  temperature_f: number;
  humidity_percent: number;
  dew_point_f: number;
  wind_speed_mph: number | null;
  weather_code: number | null;
  weather_description: string;
  pm2_5_ug_m3: number | null;
  us_aqi: number | null;
  us_aqi_category: AqiCategory | null;
}

export interface OutdoorForecast {
  fetched_at: string;
  location_label: string;
  latitude: number;
  longitude: number;
  source: "open-meteo";
  hours: OutdoorForecastHour[];
}

export interface LatestOutdoorForecastResult {
  forecast: OutdoorForecast;
  minutes_ago: number;
  is_stale: boolean;
}

export interface ScoredForecastHour extends OutdoorForecastHour {
  is_clean_air: boolean;
  energy_tax: VentilationEnergyTax;
}

export interface VentilationWindow {
  start_time: string;
  end_time: string;
  duration_hours: number;
  best_tax_tier: "free" | "low";
  avg_temp_f: number;
  avg_dew_point_f: number;
  max_us_aqi: number | null;
  reason: string;
}

export interface VentilationForecastAnalysis {
  next_best_window: VentilationWindow | null;
  lowest_tax_fallback_hour: ScoredForecastHour | null;
  windows: VentilationWindow[];
  scored_hours: ScoredForecastHour[];
}

export interface OpenMeteoFetchDependencies {
  fetchImpl?: typeof fetch;
  now?: () => Date;
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
 * Computes dew point (°C) via the Magnus-Tetens approximation (Alduchov & Eskridge).
 */
export function computeDewPointC(
  tempC: number,
  relativeHumidityPercent: number
): number {
  const rh = Math.max(1, Math.min(100, relativeHumidityPercent));
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

/**
 * Computes dew point (°F) rounded to 1 decimal place.
 */
export function computeDewPointF(
  tempF: number,
  relativeHumidityPercent: number
): number {
  const tempC = ((tempF - 32) * 5) / 9;
  const dpC = computeDewPointC(tempC, relativeHumidityPercent);
  return roundTo((dpC * 9) / 5 + 32, 1);
}

/**
 * Computes moist-air specific enthalpy (kJ/kg dry air) per ASHRAE standard psychrometrics.
 */
export function computeMoistAirEnthalpyKjKg(
  tempC: number,
  relativeHumidityPercent: number,
  pressureKpa = 101.325
): number {
  const rh = Math.max(0, Math.min(100, relativeHumidityPercent));
  const pSatKpa = 0.61094 * Math.exp((17.625 * tempC) / (tempC + 243.04));
  const pVapKpa = Math.min(pressureKpa * 0.99, (rh / 100) * pSatKpa);
  const humidityRatio = (0.62198 * pVapKpa) / Math.max(0.1, pressureKpa - pVapKpa);
  const enthalpy = 1.006 * tempC + humidityRatio * (2501 + 1.86 * tempC);
  return roundTo(enthalpy, 1);
}

/**
 * Quantifies the sensible (temperature) and latent (moisture/dew-point) HVAC energy
 * penalty of exchanging indoor air with outdoor air.
 */
export function computeVentilationEnergyTax(
  indoor: { temperature_f: number; humidity_percent: number },
  outdoor: { temperature_f: number; humidity_percent: number }
): VentilationEnergyTax {
  const sensibleDeltaF = roundTo(outdoor.temperature_f - indoor.temperature_f, 1);
  const indoorTempC = ((indoor.temperature_f - 32) * 5) / 9;
  const outdoorTempC = ((outdoor.temperature_f - 32) * 5) / 9;

  const dewPointIndoorF = computeDewPointF(indoor.temperature_f, indoor.humidity_percent);
  const dewPointOutdoorF = computeDewPointF(outdoor.temperature_f, outdoor.humidity_percent);
  const dewPointDeltaF = roundTo(dewPointOutdoorF - dewPointIndoorF, 1);

  const indoorEnthalpy = computeMoistAirEnthalpyKjKg(indoorTempC, indoor.humidity_percent);
  const outdoorEnthalpy = computeMoistAirEnthalpyKjKg(outdoorTempC, outdoor.humidity_percent);
  const enthalpyDelta = roundTo(outdoorEnthalpy - indoorEnthalpy, 1);

  let coolingPenalty = 0;
  if (sensibleDeltaF > 12 || outdoor.temperature_f >= 84) {
    coolingPenalty = 3;
  } else if (sensibleDeltaF > 7 || outdoor.temperature_f >= 80) {
    coolingPenalty = 2;
  } else if (sensibleDeltaF > 3 || outdoor.temperature_f >= 77) {
    coolingPenalty = 1;
  }

  let heatingPenalty = 0;
  if (sensibleDeltaF < -28 || outdoor.temperature_f < 40) {
    heatingPenalty = 3;
  } else if (sensibleDeltaF < -18 || outdoor.temperature_f < 52) {
    heatingPenalty = 2;
  } else if (sensibleDeltaF < -10 || outdoor.temperature_f < 60) {
    heatingPenalty = 1;
  }

  let latentPenalty = 0;
  if (dewPointOutdoorF >= 66 && dewPointDeltaF > 3) {
    latentPenalty = 3;
  } else if (dewPointOutdoorF >= 62 && dewPointDeltaF > 3) {
    latentPenalty = 2;
  } else if (dewPointOutdoorF >= 58 && dewPointDeltaF > 2) {
    latentPenalty = 1;
  }

  let maxPenalty = Math.max(coolingPenalty, heatingPenalty, latentPenalty);
  if (coolingPenalty >= 1 && latentPenalty >= 2) {
    maxPenalty = 3;
  }

  const tier: EnergyTaxTier =
    maxPenalty === 0
      ? "free"
      : maxPenalty === 1
        ? "low"
        : maxPenalty === 2
          ? "moderate"
          : "high";

  let primaryPenalty: EnergyPenaltyType = "none";
  if (maxPenalty > 0) {
    if (coolingPenalty >= 1 && latentPenalty >= 1) {
      primaryPenalty = "cooling_and_dehumidification";
    } else if (
      latentPenalty >= coolingPenalty &&
      latentPenalty >= heatingPenalty &&
      latentPenalty > 0
    ) {
      primaryPenalty = "dehumidification";
    } else if (coolingPenalty >= heatingPenalty && coolingPenalty > 0) {
      primaryPenalty = "cooling";
    } else {
      primaryPenalty = "heating";
    }
  }

  let summary: string;
  if (tier === "free") {
    summary = `Near-free ventilation: outdoor ${outdoor.temperature_f.toFixed(1)}°F (dew pt ${dewPointOutdoorF.toFixed(1)}°F) adds minimal thermal or humidity load.`;
  } else if (primaryPenalty === "cooling_and_dehumidification") {
    summary = `${tier} AC + dehumidification tax: outdoor air is ${outdoor.temperature_f.toFixed(1)}°F with ${dewPointOutdoorF.toFixed(1)}°F dew point (${sensibleDeltaF >= 0 ? "+" : ""}${sensibleDeltaF.toFixed(1)}°F, ${dewPointDeltaF >= 0 ? "+" : ""}${dewPointDeltaF.toFixed(1)}°F dew pt).`;
  } else if (primaryPenalty === "dehumidification") {
    summary = `${tier} dehumidification tax: outdoor dew point (${dewPointOutdoorF.toFixed(1)}°F) is ${dewPointDeltaF.toFixed(1)}°F higher than indoors (${dewPointIndoorF.toFixed(1)}°F).`;
  } else if (primaryPenalty === "cooling") {
    summary = `${tier} cooling tax: outdoor air (${outdoor.temperature_f.toFixed(1)}°F) is ${sensibleDeltaF.toFixed(1)}°F warmer than indoors.`;
  } else {
    summary = `${tier} heating tax: outdoor air (${outdoor.temperature_f.toFixed(1)}°F) is ${Math.abs(sensibleDeltaF).toFixed(1)}°F colder than indoors.`;
  }

  return {
    tier,
    sensible_delta_f: sensibleDeltaF,
    dew_point_indoor_f: dewPointIndoorF,
    dew_point_outdoor_f: dewPointOutdoorF,
    dew_point_delta_f: dewPointDeltaF,
    indoor_enthalpy_kj_kg: indoorEnthalpy,
    outdoor_enthalpy_kj_kg: outdoorEnthalpy,
    enthalpy_delta_kj_kg: enthalpyDelta,
    primary_penalty: primaryPenalty,
    summary,
  };
}

/**
 * Computes indoor-minus-outdoor deltas, psychrometric ventilation energy tax,
 * and an actionable window ventilation recommendation. Positive temperature/humidity
 * deltas mean indoors is warmer or more humid; negative PM2.5/AQI deltas mean
 * indoors is cleaner.
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
  const energyTax = computeVentilationEnergyTax(indoor, outdoor);

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
    if (energyTax.tier === "high") {
      windowRecommendation = "open_brief_purge";
      windowReason = `Indoor CO2 is elevated (${Math.round(indoor.co2_ppm)} ppm) and outdoor air is clean, but ${energyTax.summary} Use a brief 3-5 min purge or wait for a lower-tax window.`;
    } else {
      windowRecommendation = "open_recommended";
      windowReason = `Indoor CO2 is elevated (${Math.round(indoor.co2_ppm)} ppm) while outdoor air is clean (${energyTax.tier} energy tax) — cracking a window will refresh the room.`;
    }
  } else if (
    indoor.pm2_5_ug_m3 > 12.0 &&
    outdoor.pm2_5_ug_m3 !== null &&
    outdoor.pm2_5_ug_m3 + 3.0 < indoor.pm2_5_ug_m3
  ) {
    if (energyTax.tier === "high") {
      windowRecommendation = "keep_closed";
      windowReason = `Indoor PM2.5 (${indoor.pm2_5_ug_m3.toFixed(1)} ug/m3) is elevated, but ${energyTax.summary} Run indoor HEPA filtration instead to avoid the energy penalty.`;
    } else {
      windowRecommendation = "open_recommended";
      windowReason = `Outdoor PM2.5 (${outdoor.pm2_5_ug_m3.toFixed(1)} ug/m3) is noticeably lower than indoors (${indoor.pm2_5_ug_m3.toFixed(1)} ug/m3) with ${energyTax.tier} energy tax — ventilating will help clear indoor particles.`;
    }
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
    energy_tax: energyTax,
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

  const updatedAt = parseTimestampToDateOrNull(data.updated_at) ?? new Date(0);
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
  const timestamp = parseTimestampToDateOrNull(data.timestamp);
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

function normalizeOpenMeteoUtcTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const isoCandidate =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed}:00.000Z`
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)
        ? `${trimmed}.000Z`
        : trimmed;
  const parsedMs = Date.parse(isoCandidate);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

function parseOpenMeteoHourlyForecast(params: {
  config: Pick<SiteLocationConfig, "label" | "latitude" | "longitude">;
  now: Date;
  weatherHourly?: Record<string, unknown>;
  airHourly?: Record<string, unknown>;
}): OutdoorForecast | null {
  const { config, now, weatherHourly, airHourly } = params;
  if (!weatherHourly || !Array.isArray(weatherHourly.time)) {
    return null;
  }

  const times = weatherHourly.time as unknown[];
  const temps = Array.isArray(weatherHourly.temperature_2m)
    ? (weatherHourly.temperature_2m as unknown[])
    : [];
  const humidities = Array.isArray(weatherHourly.relative_humidity_2m)
    ? (weatherHourly.relative_humidity_2m as unknown[])
    : [];
  const winds = Array.isArray(weatherHourly.wind_speed_10m)
    ? (weatherHourly.wind_speed_10m as unknown[])
    : [];
  const codes = Array.isArray(weatherHourly.weather_code)
    ? (weatherHourly.weather_code as unknown[])
    : [];

  const airByIso = new Map<string, { pm2_5: number | null; us_aqi: number | null }>();
  if (airHourly && Array.isArray(airHourly.time)) {
    const airTimes = airHourly.time as unknown[];
    const airPm25 = Array.isArray(airHourly.pm2_5) ? (airHourly.pm2_5 as unknown[]) : [];
    const airAqi = Array.isArray(airHourly.us_aqi) ? (airHourly.us_aqi as unknown[]) : [];
    for (let i = 0; i < airTimes.length; i += 1) {
      const iso = normalizeOpenMeteoUtcTimestamp(airTimes[i]);
      if (!iso) continue;
      const pm25Val = toNumberOrNull(airPm25[i]);
      const aqiVal = toNumberOrNull(airAqi[i]);
      airByIso.set(iso, {
        pm2_5: pm25Val !== null ? roundTo(pm25Val, 1) : null,
        us_aqi: aqiVal !== null ? Math.round(aqiVal) : null,
      });
    }
  }

  const hours: OutdoorForecastHour[] = [];
  for (let i = 0; i < times.length && hours.length < 24; i += 1) {
    const iso = normalizeOpenMeteoUtcTimestamp(times[i]);
    const tempC = toNumberOrNull(temps[i]);
    const rh = toNumberOrNull(humidities[i]);
    if (!iso || tempC === null || rh === null) {
      continue;
    }
    const tempF = roundTo((tempC * 9) / 5 + 32, 1);
    const windMph = toNumberOrNull(winds[i]);
    const wCode = toNumberOrNull(codes[i]);
    const aq = airByIso.get(iso);
    const usAqi = aq?.us_aqi ?? null;

    hours.push({
      timestamp: iso,
      temperature_c: roundTo(tempC, 2),
      temperature_f: tempF,
      humidity_percent: roundTo(rh, 1),
      dew_point_f: computeDewPointF(tempF, rh),
      wind_speed_mph: windMph !== null ? roundTo(windMph, 1) : null,
      weather_code: wCode !== null ? Math.round(wCode) : null,
      weather_description: describeWmoWeatherCode(wCode),
      pm2_5_ug_m3: aq?.pm2_5 ?? null,
      us_aqi: usAqi,
      us_aqi_category: mapUsAqiCategory(usAqi),
    });
  }

  if (hours.length === 0) {
    return null;
  }

  return {
    fetched_at: now.toISOString(),
    location_label: config.label,
    latitude: roundTo(config.latitude, 5),
    longitude: roundTo(config.longitude, 5),
    source: "open-meteo",
    hours,
  };
}

/**
 * Fetches current outdoor weather & air quality plus a 24-hour hourly forecast
 * from Open-Meteo (free, no API key) in two parallel requests.
 */
export async function fetchOpenMeteoSnapshotWithForecast(
  config: Pick<SiteLocationConfig, "label" | "latitude" | "longitude">,
  deps: OpenMeteoFetchDependencies = {}
): Promise<{
  reading: Omit<OutdoorReading, "id">;
  forecast: OutdoorForecast | null;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ? deps.now() : new Date();

  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.searchParams.set("latitude", String(config.latitude));
  weatherUrl.searchParams.set("longitude", String(config.longitude));
  weatherUrl.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m"
  );
  weatherUrl.searchParams.set(
    "hourly",
    "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code"
  );
  weatherUrl.searchParams.set("forecast_hours", "24");
  weatherUrl.searchParams.set("temperature_unit", "celsius");
  weatherUrl.searchParams.set("wind_speed_unit", "mph");
  weatherUrl.searchParams.set("timezone", "UTC");

  const airUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  airUrl.searchParams.set("latitude", String(config.latitude));
  airUrl.searchParams.set("longitude", String(config.longitude));
  airUrl.searchParams.set("current", "pm2_5,pm10,us_aqi,ozone,nitrogen_dioxide");
  airUrl.searchParams.set("hourly", "pm2_5,us_aqi");
  airUrl.searchParams.set("forecast_hours", "24");
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
    hourly?: Record<string, unknown>;
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
  let airHourly: Record<string, unknown> | undefined;

  if (airRes.ok) {
    const airJson = (await airRes.json()) as {
      current?: Record<string, unknown>;
      hourly?: Record<string, unknown>;
    };
    airHourly = airJson.hourly;
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

  const reading: Omit<OutdoorReading, "id"> = {
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

  const forecast = parseOpenMeteoHourlyForecast({
    config,
    now,
    weatherHourly: weatherJson.hourly,
    airHourly,
  });

  return { reading, forecast };
}

/**
 * Fetches current weather and air quality conditions from Open-Meteo (free, no API key).
 */
export async function fetchOpenMeteoSnapshot(
  config: Pick<SiteLocationConfig, "label" | "latitude" | "longitude">,
  deps: OpenMeteoFetchDependencies = {}
): Promise<Omit<OutdoorReading, "id">> {
  const { reading } = await fetchOpenMeteoSnapshotWithForecast(config, deps);
  return reading;
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
  now: Date = new Date(),
  options: { forceTailCheck?: boolean } = {}
): Promise<OutdoorReading[]> {
  const clampedHours = Math.max(1, Math.min(168, Math.round(hours)));
  const clampedLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const startDate = new Date(now.getTime() - clampedHours * 60 * 60 * 1000);

  const rollupResult = await readOutdoorReadingsFromRollups(
    { startDate, endDate: now },
    db
  );

  const startMs = startDate.getTime();
  const endMs = now.getTime();
  const fallbackRanges: Array<{ startDate: Date; endDate: Date }> = [];

  for (const range of groupContiguousDateRanges(rollupResult.missingDates)) {
    const clampedStart = new Date(Math.max(startMs, range.startDate.getTime()));
    const clampedEnd = new Date(Math.min(endMs, range.endDate.getTime()));
    if (clampedStart.getTime() <= clampedEnd.getTime()) {
      fallbackRanges.push({ startDate: clampedStart, endDate: clampedEnd });
    }
  }

  const endUtcDate = formatUtcDateString(now);
  if (!rollupResult.missingDates.includes(endUtcDate)) {
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
      endMs - latestRollupMs > OUTDOOR_STALE_THRESHOLD_MINUTES * 60_000;

    if (needsTailCheck) {
      const todayStartMs = utcDayRange(endUtcDate).start.getTime();
      const tailStartMs =
        latestRollupMs !== null
          ? Math.max(startMs, latestRollupMs + 1000)
          : Math.max(startMs, todayStartMs);
      if (tailStartMs <= endMs) {
        fallbackRanges.push({
          startDate: new Date(tailStartMs),
          endDate: now,
        });
      }
    }
  }

  if (fallbackRanges.length === 0) {
    return downsampleReadings(rollupResult.readings, clampedLimit);
  }

  const fallbackBatches = await Promise.all(
    fallbackRanges.map(async (range) => {
      const snap = await db
        .collection(OUTDOOR_READINGS_COLLECTION)
        .where("timestamp", ">=", Timestamp.fromDate(range.startDate))
        .where("timestamp", "<=", Timestamp.fromDate(range.endDate))
        .orderBy("timestamp", "asc")
        .limit(1000)
        .get();

      const items: OutdoorReading[] = [];
      for (const doc of snap.docs) {
        const mapped = mapOutdoorReadingDoc(doc);
        if (mapped) {
          items.push(mapped);
        }
      }
      return items;
    })
  );

  const deduped = new Map<number, OutdoorReading>();
  for (const r of rollupResult.readings) {
    deduped.set(Math.floor(Date.parse(r.timestamp) / 1000), r);
  }
  for (const batch of fallbackBatches) {
    for (const r of batch) {
      const key = Math.floor(Date.parse(r.timestamp) / 1000);
      if (!deduped.has(key)) {
        deduped.set(key, r);
      }
    }
  }

  const merged = Array.from(deduped.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  return downsampleReadings(merged, clampedLimit);
}

/**
 * Builds a deterministic interval-bucketed document ID for scheduled/trigger syncs
 * so concurrent invocations converge on one document, or an exact timestamp ID
 * when `force` is requested by the user.
 */
export function buildOutdoorReadingDocId(
  now: Date,
  pollIntervalMinutes: number,
  force: boolean
): string {
  if (force) {
    return `outdoor_${now.toISOString().replace(/[:.]/g, "-")}`;
  }
  const intervalMs = Math.max(1, pollIntervalMinutes) * 60_000;
  const bucketMs = Math.floor(now.getTime() / intervalMs) * intervalMs;
  return `outdoor_${new Date(bucketMs).toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Checks whether a fresh outdoor weather + AQI reading should be fetched from
 * Open-Meteo and written to `outdoor_readings`.
 *
 * Called automatically by the `syncOutdoorOnReading` Firestore trigger (throttled
 * by `outdoor_poll_interval_minutes`, default 15 min, and coalesced via a
 * Firestore transaction lease) and on-demand when the user updates their Home
 * Location or clicks Refresh.
 */
export async function syncOutdoorReadingIfStale(
  options: {
    force?: boolean;
    includeReading?: boolean;
    db?: Firestore;
    deps?: OpenMeteoFetchDependencies;
  } = {}
): Promise<{
  synced: boolean;
  reason: string;
  reading: OutdoorReading | null;
}> {
  const db = options.db ?? getDb();
  const now = options.deps?.now ? options.deps.now() : new Date();
  const force = Boolean(options.force);
  const includeReading = options.includeReading !== false;
  const siteRef = db.collection(SITE_CONFIGS_COLLECTION).doc(HOME_SITE_CONFIG_ID);

  let siteConfig: SiteLocationConfig | null = null;

  if (!force) {
    type LeaseOutcome =
      | { status: "unconfigured" }
      | { status: "cached_fresh"; siteConfig: SiteLocationConfig; minutesAgo: number }
      | { status: "sync_in_progress"; siteConfig: SiteLocationConfig }
      | { status: "acquired"; siteConfig: SiteLocationConfig };

    const lease: LeaseOutcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(siteRef);
      if (!snap.exists) {
        return { status: "unconfigured" };
      }
      const data = snap.data();
      const cfg = data ? mapSiteLocationConfigDoc(snap.id, data) : null;
      if (!cfg) {
        return { status: "unconfigured" };
      }

      const lastSynced = parseTimestampToDateOrNull(data?.outdoor_last_synced_at);
      if (lastSynced) {
        const elapsedMs = Math.max(0, now.getTime() - lastSynced.getTime());
        const pollMs = cfg.outdoor_poll_interval_minutes * 60_000;
        if (elapsedMs < pollMs) {
          return {
            status: "cached_fresh",
            siteConfig: cfg,
            minutesAgo: roundTo(elapsedMs / 60_000, 1),
          };
        }
      }

      const lastAttempt = parseTimestampToDateOrNull(data?.outdoor_last_sync_attempt_at);
      if (lastAttempt) {
        const attemptAgeMs = Math.max(0, now.getTime() - lastAttempt.getTime());
        if (attemptAgeMs < OUTDOOR_SYNC_LEASE_MS) {
          return { status: "sync_in_progress", siteConfig: cfg };
        }
      }

      tx.set(
        siteRef,
        { outdoor_last_sync_attempt_at: Timestamp.fromDate(now) },
        { merge: true }
      );
      return { status: "acquired", siteConfig: cfg };
    });

    if (lease.status === "unconfigured") {
      return {
        synced: false,
        reason: "site_location_not_configured",
        reading: null,
      };
    }

    if (lease.status === "cached_fresh" || lease.status === "sync_in_progress") {
      const latest = includeReading ? await getLatestOutdoorReading(db, now) : null;
      return {
        synced: false,
        reason:
          lease.status === "cached_fresh"
            ? `cached_fresh (${lease.minutesAgo}m < ${lease.siteConfig.outdoor_poll_interval_minutes}m)`
            : "sync_in_progress",
        reading: latest?.reading ?? null,
      };
    }

    siteConfig = lease.siteConfig;
    const latest = await getLatestOutdoorReading(db, now);
    if (latest && latest.minutes_ago < siteConfig.outdoor_poll_interval_minutes) {
      return {
        synced: false,
        reason: `cached_fresh (${latest.minutes_ago}m < ${siteConfig.outdoor_poll_interval_minutes}m)`,
        reading: latest.reading,
      };
    }
  } else {
    siteConfig = await getSiteLocationConfig(db);
    if (!siteConfig) {
      return {
        synced: false,
        reason: "site_location_not_configured",
        reading: null,
      };
    }
  }

  const { reading: snapshot, forecast } = await fetchOpenMeteoSnapshotWithForecast(
    siteConfig,
    options.deps
  );
  const docId = buildOutdoorReadingDocId(
    now,
    siteConfig.outdoor_poll_interval_minutes,
    force
  );
  const writeData = {
    ...snapshot,
    timestamp: Timestamp.fromDate(new Date(snapshot.timestamp)),
  };
  const fullReading: OutdoorReading = {
    id: docId,
    ...snapshot,
  };

  const writes: Array<Promise<unknown>> = [
    db.collection(OUTDOOR_READINGS_COLLECTION).doc(docId).set(writeData),
    siteRef.set({ outdoor_last_synced_at: Timestamp.fromDate(now) }, { merge: true }),
    appendOutdoorRollupSample(fullReading, db),
  ];

  if (forecast && forecast.hours.length > 0) {
    writes.push(
      db
        .collection(OUTDOOR_FORECASTS_COLLECTION)
        .doc(HOME_OUTDOOR_FORECAST_ID)
        .set({
          ...forecast,
          fetched_at: Timestamp.fromDate(new Date(forecast.fetched_at)),
        })
    );
  }

  await Promise.all(writes);

  return {
    synced: true,
    reason: force ? "forced_refresh" : "cache_expired",
    reading: fullReading,
  };
}

/**
 * Reads the cached 24-hour Open-Meteo forecast document (`outdoor_forecasts/home`).
 */
export async function getLatestOutdoorForecast(
  db: Firestore = getDb(),
  now: Date = new Date()
): Promise<LatestOutdoorForecastResult | null> {
  const snap = await db
    .collection(OUTDOOR_FORECASTS_COLLECTION)
    .doc(HOME_OUTDOOR_FORECAST_ID)
    .get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data();
  if (!data || !Array.isArray(data.hours)) {
    return null;
  }

  const fetchedAt = parseTimestampToDateOrNull(data.fetched_at);
  const latitude = toNumberOrNull(data.latitude);
  const longitude = toNumberOrNull(data.longitude);
  if (!fetchedAt || latitude === null || longitude === null) {
    return null;
  }

  const hours: OutdoorForecastHour[] = [];
  for (const rawHour of data.hours as unknown[]) {
    if (!rawHour || typeof rawHour !== "object") continue;
    const h = rawHour as Record<string, unknown>;
    const ts = normalizeOpenMeteoUtcTimestamp(h.timestamp);
    const tempC = toNumberOrNull(h.temperature_c);
    const tempF = toNumberOrNull(h.temperature_f);
    const rh = toNumberOrNull(h.humidity_percent);
    if (!ts || tempC === null || tempF === null || rh === null) {
      continue;
    }
    const dpF = toNumberOrNull(h.dew_point_f);
    const windMph = toNumberOrNull(h.wind_speed_mph);
    const wCode = toNumberOrNull(h.weather_code);
    const pm25 = toNumberOrNull(h.pm2_5_ug_m3);
    const usAqi = toNumberOrNull(h.us_aqi);
    const usAqiRounded = usAqi !== null ? Math.round(usAqi) : null;

    hours.push({
      timestamp: ts,
      temperature_c: roundTo(tempC, 2),
      temperature_f: roundTo(tempF, 1),
      humidity_percent: roundTo(rh, 1),
      dew_point_f: dpF !== null ? roundTo(dpF, 1) : computeDewPointF(tempF, rh),
      wind_speed_mph: windMph !== null ? roundTo(windMph, 1) : null,
      weather_code: wCode !== null ? Math.round(wCode) : null,
      weather_description:
        typeof h.weather_description === "string" && h.weather_description.trim().length > 0
          ? h.weather_description.trim()
          : describeWmoWeatherCode(wCode),
      pm2_5_ug_m3: pm25 !== null ? roundTo(pm25, 1) : null,
      us_aqi: usAqiRounded,
      us_aqi_category: mapUsAqiCategory(usAqiRounded),
    });
  }

  if (hours.length === 0) {
    return null;
  }

  const minutesAgo = Math.max(
    0,
    roundTo((now.getTime() - fetchedAt.getTime()) / 60_000, 1)
  );
  return {
    forecast: {
      fetched_at: fetchedAt.toISOString(),
      location_label:
        typeof data.location_label === "string" && data.location_label.trim().length > 0
          ? data.location_label.trim()
          : "Home Outdoor",
      latitude: roundTo(latitude, 5),
      longitude: roundTo(longitude, 5),
      source: "open-meteo",
      hours,
    },
    minutes_ago: minutesAgo,
    is_stale: minutesAgo > OUTDOOR_FORECAST_STALE_THRESHOLD_MINUTES,
  };
}

function buildVentilationWindowFromSpan(
  span: ScoredForecastHour[]
): VentilationWindow {
  const first = span[0];
  const last = span[span.length - 1];
  const endMs = Date.parse(last.timestamp) + 60 * 60_000;
  const endTime = new Date(endMs).toISOString();
  const hasFree = span.some((h) => h.energy_tax.tier === "free");
  const bestTier: "free" | "low" = hasFree ? "free" : "low";

  const avgTempF = roundTo(
    span.reduce((acc, h) => acc + h.temperature_f, 0) / span.length,
    1
  );
  const avgDewPointF = roundTo(
    span.reduce((acc, h) => acc + h.dew_point_f, 0) / span.length,
    1
  );
  const aqiValues = span
    .map((h) => h.us_aqi)
    .filter((v): v is number => v !== null);
  const maxUsAqi = aqiValues.length > 0 ? Math.max(...aqiValues) : null;

  const tierLabel = bestTier === "free" ? "Free ventilation" : "Low energy tax";
  const aqiText = maxUsAqi !== null ? `, max AQI ${maxUsAqi}` : "";
  const reason = `${tierLabel} window (${span.length}h): ~${avgTempF.toFixed(1)}°F, dew pt ${avgDewPointF.toFixed(1)}°F${aqiText}.`;

  return {
    start_time: first.timestamp,
    end_time: endTime,
    duration_hours: span.length,
    best_tax_tier: bestTier,
    avg_temp_f: avgTempF,
    avg_dew_point_f: avgDewPointF,
    max_us_aqi: maxUsAqi,
    reason,
  };
}

/**
 * Scores a 24-hour forecast against the current indoor baseline to identify
 * contiguous clean, free/low-energy-tax ventilation windows and the best fallback hour.
 */
export function findBestVentilationWindows(
  indoorBaseline: { temperature_f: number; humidity_percent: number },
  forecast: OutdoorForecast,
  options: { now?: Date } = {}
): VentilationForecastAnalysis {
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - 30 * 60_000;

  const scoredHours: ScoredForecastHour[] = [];
  for (const hour of forecast.hours) {
    const tsMs = Date.parse(hour.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) {
      continue;
    }
    const isCleanAir =
      (hour.us_aqi === null || hour.us_aqi <= 80) &&
      (hour.pm2_5_ug_m3 === null || hour.pm2_5_ug_m3 <= 20.0);
    const energyTax = computeVentilationEnergyTax(indoorBaseline, hour);
    scoredHours.push({
      ...hour,
      is_clean_air: isCleanAir,
      energy_tax: energyTax,
    });
  }

  const windows: VentilationWindow[] = [];
  let activeSpan: ScoredForecastHour[] = [];
  for (const hour of scoredHours) {
    const qualifies =
      hour.is_clean_air &&
      (hour.energy_tax.tier === "free" || hour.energy_tax.tier === "low");
    const isContiguous =
      activeSpan.length === 0 ||
      Date.parse(hour.timestamp) - Date.parse(activeSpan[activeSpan.length - 1].timestamp) <=
        90 * 60_000;

    if (qualifies && isContiguous) {
      activeSpan.push(hour);
    } else {
      if (activeSpan.length > 0) {
        windows.push(buildVentilationWindowFromSpan(activeSpan));
        activeSpan = [];
      }
      if (qualifies) {
        activeSpan.push(hour);
      }
    }
  }
  if (activeSpan.length > 0) {
    windows.push(buildVentilationWindowFromSpan(activeSpan));
  }

  const cleanHours = scoredHours.filter((h) => h.is_clean_air);
  const candidates = cleanHours.length > 0 ? cleanHours : scoredHours;
  let lowestTaxFallback: ScoredForecastHour | null = null;
  for (const h of candidates) {
    if (
      !lowestTaxFallback ||
      Math.abs(h.energy_tax.enthalpy_delta_kj_kg) <
        Math.abs(lowestTaxFallback.energy_tax.enthalpy_delta_kj_kg)
    ) {
      lowestTaxFallback = h;
    }
  }

  return {
    next_best_window: windows[0] ?? null,
    lowest_tax_fallback_hour: lowestTaxFallback,
    windows,
    scored_hours: scoredHours,
  };
}
