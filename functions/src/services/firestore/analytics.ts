import { roundTo } from "./db.js";
import {
  CO2_ELEVATED_PPM,
  CO2_HIGH_PPM,
  PM2_5_ELEVATED_UG_M3,
  PM2_5_HIGH_UG_M3,
  type AirQualityReading,
  type AirQualitySummaryResult,
  type MetricStats,
  type NotableSpike,
  type ReadingHealthContext,
  type SummaryPeriod,
} from "./types.js";

/**
 * Computes min, max, average, and 95th percentile (linear interpolation) for a numeric series.
 */
export function computeMetricStats(values: number[], decimals = 1): MetricStats {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0, p95: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = sum / sorted.length;

  const pos = (sorted.length - 1) * 0.95;
  const lowerIdx = Math.floor(pos);
  const upperIdx = Math.ceil(pos);
  const fraction = pos - lowerIdx;
  const p95 =
    lowerIdx === upperIdx
      ? sorted[lowerIdx]
      : sorted[lowerIdx] + (sorted[upperIdx] - sorted[lowerIdx]) * fraction;

  return {
    min: roundTo(min, decimals),
    max: roundTo(max, decimals),
    avg: roundTo(avg, decimals),
    p95: roundTo(p95, decimals),
  };
}

/**
 * Evenly downsamples an ordered array to at most `maxPoints` elements,
 * always preserving the first and last observations.
 */
export function downsampleReadings<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) {
    return [];
  }
  if (items.length <= maxPoints) {
    return [...items];
  }
  if (maxPoints === 1) {
    return [items[items.length - 1]];
  }

  const result: T[] = [];
  const step = (items.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    result.push(items[idx]);
  }
  return result;
}

/**
 * Produces human-readable indoor air quality health context for a single reading.
 */
export function assessReadingHealth(reading: AirQualityReading): ReadingHealthContext {
  let co2_level: ReadingHealthContext["co2_level"];
  let co2_note: string;
  if (reading.co2_ppm < 800) {
    co2_level = "optimal";
    co2_note = "Well ventilated; optimal cognitive performance range (<800 ppm).";
  } else if (reading.co2_ppm <= CO2_ELEVATED_PPM) {
    co2_level = "acceptable";
    co2_note = "Acceptable indoor ventilation (800-1000 ppm); consider fresh air if rising.";
  } else if (reading.co2_ppm <= CO2_HIGH_PPM) {
    co2_level = "elevated";
    co2_note = "Elevated CO2 (1001-1400 ppm); mild drowsiness or reduced focus possible—open a window.";
  } else {
    co2_level = "poor";
    co2_note = "Poor ventilation (>1400 ppm); ventilate the room promptly.";
  }

  let pm2_5_level: ReadingHealthContext["pm2_5_level"];
  let pm2_5_note: string;
  if (reading.pm2_5_ug_m3 <= PM2_5_ELEVATED_UG_M3) {
    pm2_5_level = "good";
    pm2_5_note = "Low fine particulate matter (<=9.0 ug/m3, 2024 US EPA Good range).";
  } else if (reading.pm2_5_ug_m3 <= PM2_5_HIGH_UG_M3) {
    pm2_5_level = "moderate";
    pm2_5_note = "Moderate fine particles (9.1-35.4 ug/m3); running a HEPA purifier can help.";
  } else if (reading.pm2_5_ug_m3 <= 55.4) {
    pm2_5_level = "unhealthy_sensitive";
    pm2_5_note = "Elevated particles (Unhealthy for Sensitive Groups); run filtration and check sources.";
  } else {
    pm2_5_level = "unhealthy";
    pm2_5_note = "High particulate concentration (>55.4 ug/m3); run HEPA filtration and minimize smoke/dust.";
  }

  let humidity_level: ReadingHealthContext["humidity_level"];
  let humidity_note: string;
  if (reading.humidity_percent < 30) {
    humidity_level = "dry";
    humidity_note = "Dry indoor air (<30% RH); may irritate airways or dry skin.";
  } else if (reading.humidity_percent <= 50) {
    humidity_level = "ideal";
    humidity_note = "Ideal indoor relative humidity (30%-50% RH).";
  } else {
    humidity_level = "humid";
    humidity_note = "Elevated indoor humidity (>50% RH); sustained >60% increases mold/dust-mite risk.";
  }

  return {
    co2_level,
    co2_note,
    pm2_5_level,
    pm2_5_note,
    humidity_level,
    humidity_note,
  };
}

function collectSpikesForMetric(
  readingsAsc: AirQualityReading[],
  metric: "co2_ppm" | "pm2_5_ug_m3",
  unit: "ppm" | "ug/m3",
  elevatedThreshold: number,
  highThreshold: number
): NotableSpike[] {
  const spikes: NotableSpike[] = [];
  const activeByDevice = new Map<string, NotableSpike>();

  for (const reading of readingsAsc) {
    const value = reading[metric];
    const active = activeByDevice.get(reading.device_id);
    if (value > elevatedThreshold) {
      const severity: NotableSpike["severity"] =
        value >= highThreshold ? "high" : "elevated";

      if (active) {
        active.ended_at = reading.timestamp;
        active.reading_count += 1;
        if (value > active.peak_value) {
          active.peak_value = roundTo(value, 1);
          active.peak_timestamp = reading.timestamp;
        }
        if (severity === "high") {
          active.severity = "high";
        }
      } else {
        activeByDevice.set(reading.device_id, {
          metric,
          unit,
          threshold: elevatedThreshold,
          severity,
          peak_value: roundTo(value, 1),
          peak_timestamp: reading.timestamp,
          started_at: reading.timestamp,
          ended_at: reading.timestamp,
          reading_count: 1,
          device_id: reading.device_id,
          location: reading.location,
        });
      }
    } else if (active) {
      spikes.push(active);
      activeByDevice.delete(reading.device_id);
    }
  }

  for (const active of activeByDevice.values()) {
    spikes.push(active);
  }
  return spikes;
}

/**
 * Groups contiguous elevated CO2 (>1000 ppm) and PM2.5 (>9.0 ug/m3) readings into
 * concise spike episodes with peak values and timestamps.
 */
export function detectNotableSpikes(
  readingsAsc: AirQualityReading[],
  maxSpikes = 20
): NotableSpike[] {
  const co2Spikes = collectSpikesForMetric(
    readingsAsc,
    "co2_ppm",
    "ppm",
    CO2_ELEVATED_PPM,
    CO2_HIGH_PPM
  );
  const pm25Spikes = collectSpikesForMetric(
    readingsAsc,
    "pm2_5_ug_m3",
    "ug/m3",
    PM2_5_ELEVATED_UG_M3,
    PM2_5_HIGH_UG_M3
  );

  return [...co2Spikes, ...pm25Spikes]
    .sort((a, b) => b.peak_timestamp.localeCompare(a.peak_timestamp))
    .slice(0, maxSpikes);
}

/**
 * Computes statistical aggregations (min, max, average, p95), threshold
 * exceedance counts, and notable spike episodes from pre-loaded ascending readings.
 */
export function computeAirQualitySummaryFromReadings(
  readingsAsc: AirQualityReading[],
  options: {
    period: SummaryPeriod;
    windowStart: Date;
    windowEnd: Date;
    device_id?: string;
    location?: string;
    scanCapped: boolean;
  }
): AirQualitySummaryResult {
  const sampleCount = readingsAsc.length;
  if (sampleCount === 0) {
    return {
      period: options.period,
      window_start: options.windowStart.toISOString(),
      window_end: options.windowEnd.toISOString(),
      filters: {
        device_id: options.device_id ?? null,
        location: options.location ?? null,
      },
      sample_count: 0,
      scan_capped: options.scanCapped,
      metrics: null,
      threshold_exceedances: {
        co2_above_1000_ppm_count: 0,
        co2_above_1000_ppm_percent: 0,
        co2_above_1400_ppm_count: 0,
        pm2_5_above_9_ug_m3_count: 0,
        pm2_5_above_9_ug_m3_percent: 0,
        pm2_5_above_35_4_ug_m3_count: 0,
      },
      notable_spikes: [],
    };
  }

  const co2Above1000 = readingsAsc.filter((r) => r.co2_ppm > CO2_ELEVATED_PPM).length;
  const co2Above1400 = readingsAsc.filter((r) => r.co2_ppm > CO2_HIGH_PPM).length;
  const pm25Above9 = readingsAsc.filter((r) => r.pm2_5_ug_m3 > PM2_5_ELEVATED_UG_M3).length;
  const pm25Above35_4 = readingsAsc.filter((r) => r.pm2_5_ug_m3 > PM2_5_HIGH_UG_M3).length;

  return {
    period: options.period,
    window_start: options.windowStart.toISOString(),
    window_end: options.windowEnd.toISOString(),
    filters: {
      device_id: options.device_id ?? null,
      location: options.location ?? null,
    },
    sample_count: sampleCount,
    scan_capped: options.scanCapped,
    metrics: {
      co2_ppm: computeMetricStats(readingsAsc.map((r) => r.co2_ppm), 0),
      pm2_5_ug_m3: computeMetricStats(readingsAsc.map((r) => r.pm2_5_ug_m3), 1),
      pm10_0_ug_m3: computeMetricStats(readingsAsc.map((r) => r.pm10_0_ug_m3), 1),
      temperature_f: computeMetricStats(readingsAsc.map((r) => r.temperature_f), 1),
      temperature_c: computeMetricStats(readingsAsc.map((r) => r.temperature_c), 1),
      humidity_percent: computeMetricStats(readingsAsc.map((r) => r.humidity_percent), 1),
      aqi_us: computeMetricStats(readingsAsc.map((r) => r.aqi_us), 0),
    },
    threshold_exceedances: {
      co2_above_1000_ppm_count: co2Above1000,
      co2_above_1000_ppm_percent: roundTo((co2Above1000 / sampleCount) * 100, 1),
      co2_above_1400_ppm_count: co2Above1400,
      pm2_5_above_9_ug_m3_count: pm25Above9,
      pm2_5_above_9_ug_m3_percent: roundTo((pm25Above9 / sampleCount) * 100, 1),
      pm2_5_above_35_4_ug_m3_count: pm25Above35_4,
    },
    notable_spikes: detectNotableSpikes(readingsAsc),
  };
}
