import { randomBytes } from "node:crypto";

import {
  Timestamp,
  type DocumentData,
  type Firestore,
} from "firebase-admin/firestore";

import {
  DEVICE_CONFIGS_COLLECTION,
  DEVICES_COLLECTION,
  EXPERIMENTS_COLLECTION,
  EXPERIMENT_DETECTOR_STATE_COLLECTION,
  HOUSE_PLAYBOOK_COLLECTION,
  HOUSE_PLAYBOOK_SUMMARY_DOC_ID,
  MAX_HISTORY_LIMIT,
  getDb,
  getReadingsHistory,
  parseTimestampToDateOrNull,
  roundTo,
  type AirQualityReading,
} from "./firestore.js";
import { asNumber, asString } from "./firestore/db.js";
import {
  computeDewPointF,
  computeVentilationEnergyTax,
  getLatestOutdoorReading,
  getOutdoorReadingsHistory,
  type EnergyTaxTier,
  type OutdoorReading,
} from "./outdoor.js";

export const PRE_BASELINE_WINDOW_MINUTES = 15;
export const POST_SETTLE_WINDOW_MINUTES = 20;
export const DEFAULT_LIST_EXPERIMENTS_LIMIT = 50;
export const MAX_LIST_EXPERIMENTS_LIMIT = 200;

const NEARBY_OUTDOOR_MAX_DELTA_MS = 90 * 60_000;
const RECENT_START_TOLERANCE_MS = 60 * 60_000;

export const EXPERIMENT_ACTION_TYPES = [
  "crack_window",
  "cross_ventilate",
  "open_door",
  "hepa_purifier",
  "range_hood",
  "hvac_fan",
  "cooking",
  "custom",
] as const;

export type ExperimentActionType = (typeof EXPERIMENT_ACTION_TYPES)[number];

export const EXPERIMENT_STATUSES = [
  "active",
  "pending_evaluation",
  "evaluated",
  "unlabeled",
  "dismissed",
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_SOURCES = [
  "dashboard",
  "mcp",
  "auto_detected",
] as const;

export type ExperimentSource = (typeof EXPERIMENT_SOURCES)[number];

export type PlaybookConfidence = "low" | "medium" | "high";

export type PlaybookPrimaryGoal = "lower_co2" | "lower_pm2_5" | "balanced";

export interface ExperimentOutdoorSnapshot {
  timestamp: string;
  temperature_f: number;
  humidity_percent: number;
  dew_point_f: number;
  pm2_5_ug_m3: number | null;
  us_aqi: number | null;
  weather_description: string;
}

export interface ExperimentMetricSnapshot {
  sample_count: number;
  co2_ppm: number;
  pm2_5_ug_m3: number;
  temperature_f: number;
  humidity_percent: number;
}

export interface CrossRoomExperimentDelta {
  device_id: string;
  location: string;
  baseline_sample_count: number;
  post_sample_count: number;
  co2_delta_ppm: number;
  pm2_5_delta_ug_m3: number;
  temp_delta_f: number;
  humidity_delta_percent: number;
}

export interface ExperimentEvaluation {
  baseline: ExperimentMetricSnapshot;
  post_settle: ExperimentMetricSnapshot;
  co2_delta_ppm: number;
  co2_rate_ppm_per_min: number | null;
  pm2_5_delta_ug_m3: number;
  temp_delta_f: number;
  humidity_delta_percent: number;
  cross_room_deltas: CrossRoomExperimentDelta[];
  evaluated_at: string;
  insufficient_data?: boolean;
  note?: string;
}

export interface ExperimentRecord {
  id: string;
  action_type: ExperimentActionType;
  custom_label: string | null;
  device_id: string;
  location: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  status: ExperimentStatus;
  source: ExperimentSource;
  outdoor_snapshot: ExperimentOutdoorSnapshot | null;
  energy_tax_tier: EnergyTaxTier | null;
  evaluation: ExperimentEvaluation | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

export interface PlaybookEntry {
  key: string;
  location: string;
  action_type: ExperimentActionType;
  energy_tax_tier: EnergyTaxTier | "unknown";
  sample_count: number;
  co2_delta_ppm: number;
  co2_delta_mean_ppm: number;
  co2_rate_ppm_per_min: number | null;
  pm2_5_delta_ug_m3: number;
  temp_delta_f: number;
  humidity_delta_percent: number;
  avg_duration_minutes: number | null;
  confidence: PlaybookConfidence;
  last_observed_at: string;
}

export interface HousePlaybookSummary {
  updated_at: string;
  evaluated_experiment_count: number;
  entries: PlaybookEntry[];
}

export interface PlaybookRecommendation {
  entry: PlaybookEntry;
  match_quality: "exact_tier" | "same_location" | "other_location";
  score: number;
  rationale: string;
}

export interface CreateExperimentInput {
  action_type: ExperimentActionType;
  custom_label?: string | null;
  device_id: string;
  location?: string | null;
  started_at?: string;
  ended_at?: string | null;
  duration_minutes?: number | null;
  notes?: string | null;
  status?: Extract<ExperimentStatus, "active" | "pending_evaluation" | "unlabeled">;
  source?: ExperimentSource;
  outdoor_snapshot?: ExperimentOutdoorSnapshot | null;
  energy_tax_tier?: EnergyTaxTier | null;
  created_by?: string;
  evaluate_if_ready?: boolean;
  now?: Date;
}

export interface UpdateExperimentInput {
  action_type?: ExperimentActionType;
  custom_label?: string | null;
  notes?: string | null;
  started_at?: string;
  ended_at?: string | null;
  duration_minutes?: number | null;
  status?: ExperimentStatus;
  evaluate_if_ready?: boolean;
  now?: Date;
}

export interface ListExperimentsOptions {
  status?: ExperimentStatus | ExperimentStatus[];
  device_id?: string;
  location?: string;
  action_type?: ExperimentActionType;
  limit?: number;
}

export interface EvaluateExperimentOptions {
  db?: Firestore;
  now?: Date;
  force?: boolean;
  rebuildPlaybook?: boolean;
}

export interface RankPlaybookContext {
  location?: string;
  energy_tax_tier?: EnergyTaxTier | null;
  primary_goal?: PlaybookPrimaryGoal;
}

const VALID_ACTION_TYPE_SET = new Set<string>(EXPERIMENT_ACTION_TYPES);
const VALID_STATUS_SET = new Set<string>(EXPERIMENT_STATUSES);
const VALID_SOURCE_SET = new Set<string>(EXPERIMENT_SOURCES);
const VALID_ENERGY_TIERS = new Set<string>(["free", "low", "moderate", "high"]);

const EMPTY_METRIC_SNAPSHOT: ExperimentMetricSnapshot = {
  sample_count: 0,
  co2_ppm: 0,
  pm2_5_ug_m3: 0,
  temperature_f: 0,
  humidity_percent: 0,
};

function parseValidDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp for '${fieldName}': ${value}`);
  }
  return parsed;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function computeDurationMinutesBetween(startedAt: Date, endedAt: Date): number {
  const diffMs = endedAt.getTime() - startedAt.getTime();
  if (diffMs < 0) {
    throw new Error("'ended_at' must be greater than or equal to 'started_at'.");
  }
  return roundTo(diffMs / 60_000, 1);
}

function toFiniteNumberOrNull(value: unknown): number | null {
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

export function generateExperimentId(startedAt: Date): string {
  return `exp_${startedAt.getTime()}_${randomBytes(4).toString("hex")}`;
}

export function computeMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

export function computeMetricSnapshot(
  readings: AirQualityReading[]
): ExperimentMetricSnapshot | null {
  if (readings.length === 0) {
    return null;
  }

  const co2Values = readings.map((r) => r.co2_ppm);
  const pm25Values = readings.map((r) => r.pm2_5_ug_m3);
  const tempValues = readings.map((r) => r.temperature_f);
  const rhValues = readings.map((r) => r.humidity_percent);

  return {
    sample_count: readings.length,
    co2_ppm: roundTo(computeMean(co2Values), 1),
    pm2_5_ug_m3: roundTo(computeMean(pm25Values), 1),
    temperature_f: roundTo(computeMean(tempValues), 2),
    humidity_percent: roundTo(computeMean(rhValues), 1),
  };
}

export function buildOutdoorSnapshot(
  reading: OutdoorReading
): ExperimentOutdoorSnapshot {
  return {
    timestamp: reading.timestamp,
    temperature_f: roundTo(reading.temperature_f, 1),
    humidity_percent: roundTo(reading.humidity_percent, 1),
    dew_point_f: computeDewPointF(reading.temperature_f, reading.humidity_percent),
    pm2_5_ug_m3: reading.pm2_5_ug_m3 !== null ? roundTo(reading.pm2_5_ug_m3, 1) : null,
    us_aqi: reading.us_aqi !== null ? Math.round(reading.us_aqi) : null,
    weather_description: reading.weather_description,
  };
}

function confidenceForSampleCount(sampleCount: number): PlaybookConfidence {
  if (sampleCount >= 6) return "high";
  if (sampleCount >= 3) return "medium";
  return "low";
}

function isEvaluableForPlaybook(exp: ExperimentRecord): boolean {
  return (
    exp.status === "evaluated" &&
    exp.evaluation !== null &&
    !exp.evaluation.insufficient_data &&
    exp.evaluation.baseline.sample_count > 0 &&
    exp.evaluation.post_settle.sample_count > 0
  );
}

export function computePlaybookFromExperiments(
  experiments: ExperimentRecord[],
  now: Date = new Date()
): HousePlaybookSummary {
  const valid = experiments.filter(isEvaluableForPlaybook);
  const grouped = new Map<string, ExperimentRecord[]>();

  for (const exp of valid) {
    const tierKey = exp.energy_tax_tier ?? "unknown";
    const key = `${exp.location}|${exp.action_type}|${tierKey}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(exp);
    } else {
      grouped.set(key, [exp]);
    }
  }

  const entries: PlaybookEntry[] = [];
  for (const [key, items] of grouped.entries()) {
    const first = items[0];
    const co2Deltas = items.map((e) => e.evaluation!.co2_delta_ppm);
    const co2Rates = items
      .map((e) => e.evaluation!.co2_rate_ppm_per_min)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const pm25Deltas = items.map((e) => e.evaluation!.pm2_5_delta_ug_m3);
    const tempDeltas = items.map((e) => e.evaluation!.temp_delta_f);
    const rhDeltas = items.map((e) => e.evaluation!.humidity_delta_percent);
    const durations = items
      .map((e) => e.duration_minutes)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    let lastObservedAt = first.ended_at ?? first.started_at;
    for (const item of items) {
      const candidate = item.ended_at ?? item.started_at;
      if (candidate > lastObservedAt) {
        lastObservedAt = candidate;
      }
    }

    entries.push({
      key,
      location: first.location,
      action_type: first.action_type,
      energy_tax_tier: first.energy_tax_tier ?? "unknown",
      sample_count: items.length,
      co2_delta_ppm: roundTo(computeMedian(co2Deltas), 1),
      co2_delta_mean_ppm: roundTo(computeMean(co2Deltas), 1),
      co2_rate_ppm_per_min: co2Rates.length > 0 ? roundTo(computeMedian(co2Rates), 2) : null,
      pm2_5_delta_ug_m3: roundTo(computeMedian(pm25Deltas), 1),
      temp_delta_f: roundTo(computeMedian(tempDeltas), 2),
      humidity_delta_percent: roundTo(computeMedian(rhDeltas), 1),
      avg_duration_minutes:
        durations.length > 0 ? roundTo(computeMean(durations), 1) : null,
      confidence: confidenceForSampleCount(items.length),
      last_observed_at: lastObservedAt,
    });
  }

  entries.sort((a, b) => {
    const locCmp = a.location.localeCompare(b.location);
    if (locCmp !== 0) return locCmp;
    const actionCmp = a.action_type.localeCompare(b.action_type);
    if (actionCmp !== 0) return actionCmp;
    return a.energy_tax_tier.localeCompare(b.energy_tax_tier);
  });

  return {
    updated_at: now.toISOString(),
    evaluated_experiment_count: valid.length,
    entries,
  };
}

function formatActionLabel(actionType: ExperimentActionType): string {
  return actionType.replace(/_/g, " ");
}

function formatSigned(value: number, unit: string, decimals = 1): string {
  const fixed = value.toFixed(decimals);
  return `${value > 0 ? "+" : ""}${fixed} ${unit}`;
}

function effectivenessScoreForGoal(
  entry: PlaybookEntry,
  goal: PlaybookPrimaryGoal
): number {
  if (goal === "lower_pm2_5") {
    // Larger negative PM2.5 delta yields higher score.
    return -entry.pm2_5_delta_ug_m3;
  }
  if (goal === "balanced") {
    // Normalize CO2 (~300 ppm) and PM2.5 (~10 ug/m3) drops on comparable scales.
    return -entry.co2_delta_ppm / 300 + -entry.pm2_5_delta_ug_m3 / 10;
  }
  // Default: "lower_co2"
  return -entry.co2_delta_ppm;
}

export function rankPlaybookRecommendations(
  playbook: HousePlaybookSummary,
  context: RankPlaybookContext = {}
): PlaybookRecommendation[] {
  const goal: PlaybookPrimaryGoal = context.primary_goal ?? "lower_co2";
  const targetLocation = context.location?.trim() || undefined;
  const targetTier = context.energy_tax_tier ?? undefined;

  const ranked = playbook.entries.map((entry): PlaybookRecommendation => {
    const sameLocation = !targetLocation || entry.location === targetLocation;
    const sameTier =
      sameLocation &&
      (!targetTier || entry.energy_tax_tier === targetTier);

    const matchQuality: PlaybookRecommendation["match_quality"] = sameTier
      ? "exact_tier"
      : sameLocation
        ? "same_location"
        : "other_location";

    const effectiveness = effectivenessScoreForGoal(entry, goal);
    const confidenceBonus =
      entry.confidence === "high" ? 0.2 : entry.confidence === "medium" ? 0.1 : 0;
    const matchTierWeight =
      matchQuality === "exact_tier"
        ? 2_000_000
        : matchQuality === "same_location"
          ? 1_000_000
          : 0;

    // Combine match tier weight + effectiveness (scaled) + confidence/sample tie-breakers.
    const score = roundTo(
      matchTierWeight + effectiveness * 100 + confidenceBonus + Math.min(entry.sample_count, 50) * 0.01,
      2
    );

    const durationPart =
      entry.avg_duration_minutes !== null
        ? ` (~${entry.avg_duration_minutes}m avg)`
        : "";
    const tierPart =
      entry.energy_tax_tier !== "unknown"
        ? ` under ${entry.energy_tax_tier} energy tax`
        : "";
    const rationale =
      `${formatActionLabel(entry.action_type)} in ${entry.location}${tierPart}${durationPart}: ` +
      `median ${formatSigned(entry.co2_delta_ppm, "ppm CO₂", 0)}, ` +
      `${formatSigned(entry.pm2_5_delta_ug_m3, "µg/m³ PM2.5", 1)}, ` +
      `${formatSigned(entry.temp_delta_f, "°F", 1)}, ` +
      `${formatSigned(entry.humidity_delta_percent, "% RH", 1)} ` +
      `(n=${entry.sample_count}, ${entry.confidence} confidence).`;

    return {
      entry,
      match_quality: matchQuality,
      score,
      rationale,
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.sample_count - a.entry.sample_count;
  });

  return ranked;
}

function mapOutdoorSnapshot(raw: unknown): ExperimentOutdoorSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const tempF = toFiniteNumberOrNull(obj.temperature_f);
  const rh = toFiniteNumberOrNull(obj.humidity_percent);
  const dpF = toFiniteNumberOrNull(obj.dew_point_f);
  const tsDate = parseTimestampToDateOrNull(obj.timestamp);
  if (tempF === null || rh === null || !tsDate) {
    return null;
  }
  return {
    timestamp: tsDate.toISOString(),
    temperature_f: tempF,
    humidity_percent: rh,
    dew_point_f: dpF ?? computeDewPointF(tempF, rh),
    pm2_5_ug_m3: toFiniteNumberOrNull(obj.pm2_5_ug_m3),
    us_aqi: toFiniteNumberOrNull(obj.us_aqi),
    weather_description: asString(obj.weather_description, "Unknown"),
  };
}

function mapMetricSnapshot(raw: unknown): ExperimentMetricSnapshot {
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_METRIC_SNAPSHOT };
  }
  const obj = raw as Record<string, unknown>;
  return {
    sample_count: Math.max(0, Math.round(asNumber(obj.sample_count, 0))),
    co2_ppm: asNumber(obj.co2_ppm, 0),
    pm2_5_ug_m3: asNumber(obj.pm2_5_ug_m3, 0),
    temperature_f: asNumber(obj.temperature_f, 0),
    humidity_percent: asNumber(obj.humidity_percent, 0),
  };
}

function mapEvaluation(raw: unknown): ExperimentEvaluation | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const evaluatedAtDate = parseTimestampToDateOrNull(obj.evaluated_at);
  if (!evaluatedAtDate) {
    return null;
  }

  const rawCross = Array.isArray(obj.cross_room_deltas) ? obj.cross_room_deltas : [];
  const crossRoomDeltas: CrossRoomExperimentDelta[] = [];
  for (const item of rawCross) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    crossRoomDeltas.push({
      device_id: asString(c.device_id),
      location: asString(c.location),
      baseline_sample_count: Math.max(0, Math.round(asNumber(c.baseline_sample_count, 0))),
      post_sample_count: Math.max(0, Math.round(asNumber(c.post_sample_count, 0))),
      co2_delta_ppm: asNumber(c.co2_delta_ppm, 0),
      pm2_5_delta_ug_m3: asNumber(c.pm2_5_delta_ug_m3, 0),
      temp_delta_f: asNumber(c.temp_delta_f, 0),
      humidity_delta_percent: asNumber(c.humidity_delta_percent, 0),
    });
  }

  const insufficientData = obj.insufficient_data === true;
  const note = typeof obj.note === "string" && obj.note.trim().length > 0 ? obj.note.trim() : undefined;

  return {
    baseline: mapMetricSnapshot(obj.baseline),
    post_settle: mapMetricSnapshot(obj.post_settle),
    co2_delta_ppm: asNumber(obj.co2_delta_ppm, 0),
    co2_rate_ppm_per_min: toFiniteNumberOrNull(obj.co2_rate_ppm_per_min),
    pm2_5_delta_ug_m3: asNumber(obj.pm2_5_delta_ug_m3, 0),
    temp_delta_f: asNumber(obj.temp_delta_f, 0),
    humidity_delta_percent: asNumber(obj.humidity_delta_percent, 0),
    cross_room_deltas: crossRoomDeltas,
    evaluated_at: evaluatedAtDate.toISOString(),
    ...(insufficientData ? { insufficient_data: true } : {}),
    ...(note ? { note } : {}),
  };
}

function mapExperimentDoc(docId: string, data: DocumentData): ExperimentRecord {
  const startedAt = parseTimestampToDateOrNull(data.started_at) ?? new Date(0);
  const endedAt = parseTimestampToDateOrNull(data.ended_at);
  const createdAt = parseTimestampToDateOrNull(data.created_at) ?? startedAt;
  const updatedAt = parseTimestampToDateOrNull(data.updated_at) ?? createdAt;

  const rawAction = asString(data.action_type, "custom");
  const actionType: ExperimentActionType = VALID_ACTION_TYPE_SET.has(rawAction)
    ? (rawAction as ExperimentActionType)
    : "custom";

  const rawStatus = asString(data.status, "active");
  const status: ExperimentStatus = VALID_STATUS_SET.has(rawStatus)
    ? (rawStatus as ExperimentStatus)
    : "active";

  const rawSource = asString(data.source, "dashboard");
  const source: ExperimentSource = VALID_SOURCE_SET.has(rawSource)
    ? (rawSource as ExperimentSource)
    : "dashboard";

  const rawTier = typeof data.energy_tax_tier === "string" ? data.energy_tax_tier : "";
  const energyTaxTier: EnergyTaxTier | null = VALID_ENERGY_TIERS.has(rawTier)
    ? (rawTier as EnergyTaxTier)
    : null;

  return {
    id: asString(data.id, docId),
    action_type: actionType,
    custom_label: normalizeOptionalString(
      typeof data.custom_label === "string" ? data.custom_label : null
    ),
    device_id: asString(data.device_id),
    location: asString(data.location, "unknown"),
    started_at: startedAt.toISOString(),
    ended_at: endedAt ? endedAt.toISOString() : null,
    duration_minutes: toFiniteNumberOrNull(data.duration_minutes),
    notes: normalizeOptionalString(typeof data.notes === "string" ? data.notes : null),
    status,
    source,
    outdoor_snapshot: mapOutdoorSnapshot(data.outdoor_snapshot),
    energy_tax_tier: energyTaxTier,
    evaluation: mapEvaluation(data.evaluation),
    created_at: createdAt.toISOString(),
    created_by: asString(data.created_by, "unknown"),
    updated_at: updatedAt.toISOString(),
  };
}

function serializeExperimentDoc(record: ExperimentRecord): Record<string, unknown> {
  return {
    id: record.id,
    action_type: record.action_type,
    custom_label: record.custom_label,
    device_id: record.device_id,
    location: record.location,
    started_at: Timestamp.fromDate(new Date(record.started_at)),
    ended_at: record.ended_at ? Timestamp.fromDate(new Date(record.ended_at)) : null,
    duration_minutes: record.duration_minutes,
    notes: record.notes,
    status: record.status,
    source: record.source,
    outdoor_snapshot: record.outdoor_snapshot,
    energy_tax_tier: record.energy_tax_tier,
    evaluation: record.evaluation,
    created_at: Timestamp.fromDate(new Date(record.created_at)),
    created_by: record.created_by,
    updated_at: Timestamp.fromDate(new Date(record.updated_at)),
  };
}

async function resolveDeviceContext(
  deviceId: string,
  db: Firestore
): Promise<{
  location: string | null;
  latestReading: { temperature_f: number; humidity_percent: number } | null;
}> {
  let location: string | null = null;
  let latestReading: { temperature_f: number; humidity_percent: number } | null = null;

  try {
    const deviceSnap = await db.collection(DEVICES_COLLECTION).doc(deviceId).get();
    if (deviceSnap.exists && deviceSnap.data()) {
      const data = deviceSnap.data()!;
      location = normalizeOptionalString(typeof data.location === "string" ? data.location : null);
      const latest = data.latest_reading;
      if (latest && typeof latest === "object") {
        const l = latest as Record<string, unknown>;
        const tempF = toFiniteNumberOrNull(l.temperature_f);
        const rh = toFiniteNumberOrNull(l.humidity_percent);
        if (tempF !== null && rh !== null) {
          latestReading = { temperature_f: tempF, humidity_percent: rh };
        }
      }
    }
  } catch {
    // Non-fatal fallback
  }

  if (!location) {
    try {
      const configSnap = await db.collection(DEVICE_CONFIGS_COLLECTION).doc(deviceId).get();
      if (configSnap.exists && configSnap.data()) {
        const data = configSnap.data()!;
        location = normalizeOptionalString(typeof data.location === "string" ? data.location : null);
      }
    } catch {
      // Non-fatal fallback
    }
  }

  return { location, latestReading };
}

async function findNearestOutdoorReading(
  targetTime: Date,
  now: Date,
  db: Firestore
): Promise<OutdoorReading | null> {
  const targetMs = targetTime.getTime();
  const isNearNow = Math.abs(now.getTime() - targetMs) <= RECENT_START_TOLERANCE_MS;

  if (isNearNow) {
    try {
      const latest = await getLatestOutdoorReading(db, now);
      if (latest) {
        const readingMs = Date.parse(latest.reading.timestamp);
        if (Math.abs(readingMs - targetMs) <= NEARBY_OUTDOOR_MAX_DELTA_MS) {
          return latest.reading;
        }
      }
    } catch {
      // Fall through to historical lookup
    }
  }

  try {
    const windowEnd = new Date(targetMs + RECENT_START_TOLERANCE_MS);
    const history = await getOutdoorReadingsHistory(2, 50, db, windowEnd);
    let best: OutdoorReading | null = null;
    let bestDeltaMs = Number.POSITIVE_INFINITY;
    for (const candidate of history) {
      const deltaMs = Math.abs(Date.parse(candidate.timestamp) - targetMs);
      if (deltaMs <= NEARBY_OUTDOOR_MAX_DELTA_MS && deltaMs < bestDeltaMs) {
        best = candidate;
        bestDeltaMs = deltaMs;
      }
    }
    if (best) {
      return best;
    }
  } catch {
    // Non-fatal
  }

  if (isNearNow) {
    try {
      const latest = await getLatestOutdoorReading(db, now);
      return latest?.reading ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function getExperiment(
  id: string,
  db: Firestore = getDb()
): Promise<ExperimentRecord | null> {
  const trimmedId = id.trim();
  if (!trimmedId) {
    return null;
  }
  const snap = await db.collection(EXPERIMENTS_COLLECTION).doc(trimmedId).get();
  if (!snap.exists || !snap.data()) {
    return null;
  }
  return mapExperimentDoc(snap.id, snap.data()!);
}

export async function listExperiments(
  options: ListExperimentsOptions = {},
  db: Firestore = getDb()
): Promise<ExperimentRecord[]> {
  const requestedLimit = options.limit ?? DEFAULT_LIST_EXPERIMENTS_LIMIT;
  const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_LIST_EXPERIMENTS_LIMIT);
  const scanLimit = Math.min(Math.max(limit * 4, 100), 400);

  const snap = await db
    .collection(EXPERIMENTS_COLLECTION)
    .orderBy("started_at", "desc")
    .limit(scanLimit)
    .get();

  const statusSet = options.status
    ? new Set(Array.isArray(options.status) ? options.status : [options.status])
    : null;

  const results: ExperimentRecord[] = [];
  for (const doc of snap.docs) {
    const mapped = mapExperimentDoc(doc.id, doc.data());
    if (statusSet && !statusSet.has(mapped.status)) continue;
    if (options.device_id && mapped.device_id !== options.device_id) continue;
    if (options.location && mapped.location !== options.location) continue;
    if (options.action_type && mapped.action_type !== options.action_type) continue;
    results.push(mapped);
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

export async function createExperiment(
  input: CreateExperimentInput,
  db: Firestore = getDb()
): Promise<ExperimentRecord> {
  const deviceId = input.device_id.trim();
  if (!deviceId) {
    throw new Error("'device_id' is required.");
  }
  if (!VALID_ACTION_TYPE_SET.has(input.action_type)) {
    throw new Error(`Unsupported 'action_type': ${String(input.action_type)}`);
  }

  const now = input.now ?? new Date();
  const startedAt = input.started_at
    ? parseValidDate(input.started_at, "started_at")
    : now;

  let endedAt: Date | null = null;
  let durationMinutes: number | null = null;

  if (input.ended_at !== undefined && input.ended_at !== null) {
    endedAt = parseValidDate(input.ended_at, "ended_at");
    durationMinutes = computeDurationMinutesBetween(startedAt, endedAt);
  } else if (input.duration_minutes !== undefined && input.duration_minutes !== null) {
    if (!Number.isFinite(input.duration_minutes) || input.duration_minutes <= 0) {
      throw new Error("'duration_minutes' must be a positive number.");
    }
    durationMinutes = roundTo(input.duration_minutes, 1);
    endedAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
  }

  const deviceCtx = await resolveDeviceContext(deviceId, db);
  const location =
    normalizeOptionalString(input.location) ?? deviceCtx.location ?? "unknown";

  const status: ExperimentStatus =
    input.status === "unlabeled"
      ? "unlabeled"
      : endedAt
        ? "pending_evaluation"
        : (input.status ?? "active");

  let outdoorSnapshot: ExperimentOutdoorSnapshot | null = input.outdoor_snapshot ?? null;
  let energyTaxTier: EnergyTaxTier | null = input.energy_tax_tier ?? null;

  if (!outdoorSnapshot) {
    const nearbyOutdoor = await findNearestOutdoorReading(startedAt, now, db);
    if (nearbyOutdoor) {
      outdoorSnapshot = buildOutdoorSnapshot(nearbyOutdoor);
    }
  }

  if (!energyTaxTier && outdoorSnapshot) {
    const isNearNow = Math.abs(now.getTime() - startedAt.getTime()) <= RECENT_START_TOLERANCE_MS;
    if (isNearNow && deviceCtx.latestReading) {
      energyTaxTier = computeVentilationEnergyTax(deviceCtx.latestReading, {
        temperature_f: outdoorSnapshot.temperature_f,
        humidity_percent: outdoorSnapshot.humidity_percent,
      }).tier;
    }
  }

  const id = generateExperimentId(startedAt);
  const record: ExperimentRecord = {
    id,
    action_type: input.action_type,
    custom_label: normalizeOptionalString(input.custom_label),
    device_id: deviceId,
    location,
    started_at: startedAt.toISOString(),
    ended_at: endedAt ? endedAt.toISOString() : null,
    duration_minutes: durationMinutes,
    notes: normalizeOptionalString(input.notes),
    status,
    source: input.source ?? "dashboard",
    outdoor_snapshot: outdoorSnapshot,
    energy_tax_tier: energyTaxTier,
    evaluation: null,
    created_at: now.toISOString(),
    created_by: normalizeOptionalString(input.created_by) ?? "owner",
    updated_at: now.toISOString(),
  };

  await db
    .collection(EXPERIMENTS_COLLECTION)
    .doc(id)
    .set(serializeExperimentDoc(record));

  const readyToEvaluate =
    record.status === "pending_evaluation" &&
    input.evaluate_if_ready !== false &&
    endedAt !== null &&
    endedAt.getTime() + POST_SETTLE_WINDOW_MINUTES * 60_000 <= now.getTime();

  if (readyToEvaluate) {
    const evaluated = await evaluateExperimentOutcome(id, { db, now });
    if (evaluated) {
      return evaluated;
    }
  }

  return record;
}

export async function updateExperiment(
  id: string,
  input: UpdateExperimentInput,
  db: Firestore = getDb()
): Promise<ExperimentRecord | null> {
  const existing = await getExperiment(id, db);
  if (!existing) {
    return null;
  }

  const now = input.now ?? new Date();
  const startedAt =
    input.started_at !== undefined
      ? parseValidDate(input.started_at, "started_at")
      : new Date(existing.started_at);

  let endedAt: Date | null = existing.ended_at ? new Date(existing.ended_at) : null;
  let durationMinutes: number | null = existing.duration_minutes;

  if (input.ended_at === null) {
    endedAt = null;
    durationMinutes = null;
  } else if (input.ended_at !== undefined) {
    endedAt = parseValidDate(input.ended_at, "ended_at");
    durationMinutes = computeDurationMinutesBetween(startedAt, endedAt);
  } else if (input.duration_minutes !== undefined && input.duration_minutes !== null) {
    if (!Number.isFinite(input.duration_minutes) || input.duration_minutes <= 0) {
      throw new Error("'duration_minutes' must be a positive number.");
    }
    durationMinutes = roundTo(input.duration_minutes, 1);
    endedAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
  } else if (endedAt !== null) {
    durationMinutes = computeDurationMinutesBetween(startedAt, endedAt);
  }

  if (input.action_type !== undefined && !VALID_ACTION_TYPE_SET.has(input.action_type)) {
    throw new Error(`Unsupported 'action_type': ${String(input.action_type)}`);
  }

  const nextActionType = input.action_type ?? existing.action_type;
  let nextStatus: ExperimentStatus = existing.status;

  if (input.status !== undefined) {
    if (!VALID_STATUS_SET.has(input.status)) {
      throw new Error(`Unsupported 'status': ${String(input.status)}`);
    }
    nextStatus = input.status;
  } else if (existing.status === "dismissed") {
    nextStatus = "dismissed";
  } else if (existing.status === "unlabeled" && input.action_type !== undefined) {
    nextStatus = endedAt ? "pending_evaluation" : "active";
  } else if (
    existing.status === "active" &&
    (input.ended_at !== undefined || input.duration_minutes !== undefined) &&
    endedAt !== null
  ) {
    nextStatus = "pending_evaluation";
  }

  const nextRecord: ExperimentRecord = {
    ...existing,
    action_type: nextActionType,
    custom_label:
      input.custom_label !== undefined
        ? normalizeOptionalString(input.custom_label)
        : existing.custom_label,
    notes:
      input.notes !== undefined
        ? normalizeOptionalString(input.notes)
        : existing.notes,
    started_at: startedAt.toISOString(),
    ended_at: endedAt ? endedAt.toISOString() : null,
    duration_minutes: durationMinutes,
    status: nextStatus,
    updated_at: now.toISOString(),
  };

  await db
    .collection(EXPERIMENTS_COLLECTION)
    .doc(existing.id)
    .set(serializeExperimentDoc(nextRecord));

  const wasEvaluated = existing.status === "evaluated";
  const playbookImpacted =
    wasEvaluated &&
    (nextRecord.status !== "evaluated" ||
      nextRecord.action_type !== existing.action_type ||
      nextRecord.location !== existing.location);

  if (playbookImpacted) {
    await rebuildHousePlaybook(db, now);
  }

  const readyToEvaluate =
    nextRecord.status === "pending_evaluation" &&
    input.evaluate_if_ready !== false &&
    endedAt !== null &&
    endedAt.getTime() + POST_SETTLE_WINDOW_MINUTES * 60_000 <= now.getTime();

  if (readyToEvaluate) {
    const evaluated = await evaluateExperimentOutcome(existing.id, { db, now });
    if (evaluated) {
      return evaluated;
    }
  }

  return nextRecord;
}

export async function evaluateExperimentOutcome(
  id: string,
  options: EvaluateExperimentOptions = {}
): Promise<ExperimentRecord | null> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const existing = await getExperiment(id, db);
  if (!existing) {
    return null;
  }

  if (!existing.ended_at) {
    throw new Error("Cannot evaluate an active experiment without an end time.");
  }

  const startedAtMs = Date.parse(existing.started_at);
  const endedAtMs = Date.parse(existing.ended_at);
  const preStart = new Date(startedAtMs - PRE_BASELINE_WINDOW_MINUTES * 60_000);
  const postEnd = new Date(endedAtMs + POST_SETTLE_WINDOW_MINUTES * 60_000);

  if (!options.force && now.getTime() < postEnd.getTime()) {
    return existing;
  }

  const history = await getReadingsHistory(
    {
      start_time: preStart.toISOString(),
      end_time: postEnd.toISOString(),
      limit: MAX_HISTORY_LIMIT,
      now,
      forceTailCheck: true,
    },
    db
  );

  const preStartMs = preStart.getTime();
  const postEndMs = postEnd.getTime();

  const targetPre: AirQualityReading[] = [];
  const targetPost: AirQualityReading[] = [];
  const siblingsByDevice = new Map<
    string,
    { location: string; pre: AirQualityReading[]; post: AirQualityReading[] }
  >();

  for (const reading of history.readings) {
    const tsMs = Date.parse(reading.timestamp);
    if (!Number.isFinite(tsMs)) continue;

    const isPre = tsMs >= preStartMs && tsMs <= startedAtMs;
    const isPost = tsMs >= endedAtMs && tsMs <= postEndMs;
    if (!isPre && !isPost) continue;

    if (reading.device_id === existing.device_id) {
      if (isPre) targetPre.push(reading);
      if (isPost) targetPost.push(reading);
    } else if (reading.device_id) {
      let entry = siblingsByDevice.get(reading.device_id);
      if (!entry) {
        entry = { location: reading.location || "unknown", pre: [], post: [] };
        siblingsByDevice.set(reading.device_id, entry);
      }
      if (reading.location) {
        entry.location = reading.location;
      }
      if (isPre) entry.pre.push(reading);
      if (isPost) entry.post.push(reading);
    }
  }

  const baseline = computeMetricSnapshot(targetPre);
  const postSettle = computeMetricSnapshot(targetPost);

  let outdoorSnapshot = existing.outdoor_snapshot;
  let energyTaxTier = existing.energy_tax_tier;

  if (!outdoorSnapshot) {
    const nearbyOutdoor = await findNearestOutdoorReading(new Date(startedAtMs), now, db);
    if (nearbyOutdoor) {
      outdoorSnapshot = buildOutdoorSnapshot(nearbyOutdoor);
    }
  }

  if (!energyTaxTier && outdoorSnapshot && baseline) {
    energyTaxTier = computeVentilationEnergyTax(baseline, {
      temperature_f: outdoorSnapshot.temperature_f,
      humidity_percent: outdoorSnapshot.humidity_percent,
    }).tier;
  }

  let evaluation: ExperimentEvaluation;

  if (!baseline || !postSettle) {
    const missingParts: string[] = [];
    if (!baseline) missingParts.push("pre-baseline");
    if (!postSettle) missingParts.push("post-settle");
    evaluation = {
      baseline: baseline ?? { ...EMPTY_METRIC_SNAPSHOT },
      post_settle: postSettle ?? { ...EMPTY_METRIC_SNAPSHOT },
      co2_delta_ppm: 0,
      co2_rate_ppm_per_min: null,
      pm2_5_delta_ug_m3: 0,
      temp_delta_f: 0,
      humidity_delta_percent: 0,
      cross_room_deltas: [],
      evaluated_at: now.toISOString(),
      insufficient_data: true,
      note: `Insufficient ${missingParts.join(" and ")} telemetry samples for ${existing.device_id}.`,
    };
  } else {
    const co2Delta = roundTo(postSettle.co2_ppm - baseline.co2_ppm, 1);
    const durationMinutes =
      existing.duration_minutes && existing.duration_minutes > 0
        ? existing.duration_minutes
        : roundTo(Math.max(0, endedAtMs - startedAtMs) / 60_000, 1);
    const co2Rate =
      durationMinutes > 0 ? roundTo(co2Delta / durationMinutes, 2) : null;

    const crossRoomDeltas: CrossRoomExperimentDelta[] = [];
    for (const [siblingId, group] of siblingsByDevice.entries()) {
      const sibPre = computeMetricSnapshot(group.pre);
      const sibPost = computeMetricSnapshot(group.post);
      if (!sibPre || !sibPost) continue;
      crossRoomDeltas.push({
        device_id: siblingId,
        location: group.location,
        baseline_sample_count: sibPre.sample_count,
        post_sample_count: sibPost.sample_count,
        co2_delta_ppm: roundTo(sibPost.co2_ppm - sibPre.co2_ppm, 1),
        pm2_5_delta_ug_m3: roundTo(sibPost.pm2_5_ug_m3 - sibPre.pm2_5_ug_m3, 1),
        temp_delta_f: roundTo(sibPost.temperature_f - sibPre.temperature_f, 2),
        humidity_delta_percent: roundTo(
          sibPost.humidity_percent - sibPre.humidity_percent,
          1
        ),
      });
    }
    crossRoomDeltas.sort((a, b) => a.device_id.localeCompare(b.device_id));

    evaluation = {
      baseline,
      post_settle: postSettle,
      co2_delta_ppm: co2Delta,
      co2_rate_ppm_per_min: co2Rate,
      pm2_5_delta_ug_m3: roundTo(postSettle.pm2_5_ug_m3 - baseline.pm2_5_ug_m3, 1),
      temp_delta_f: roundTo(postSettle.temperature_f - baseline.temperature_f, 2),
      humidity_delta_percent: roundTo(
        postSettle.humidity_percent - baseline.humidity_percent,
        1
      ),
      cross_room_deltas: crossRoomDeltas,
      evaluated_at: now.toISOString(),
    };
  }

  const updated: ExperimentRecord = {
    ...existing,
    status: "evaluated",
    outdoor_snapshot: outdoorSnapshot,
    energy_tax_tier: energyTaxTier,
    evaluation,
    updated_at: now.toISOString(),
  };

  await db
    .collection(EXPERIMENTS_COLLECTION)
    .doc(existing.id)
    .set(serializeExperimentDoc(updated));

  if (options.rebuildPlaybook !== false) {
    await rebuildHousePlaybook(db, now);
  }

  return updated;
}

export async function rebuildHousePlaybook(
  db: Firestore = getDb(),
  now: Date = new Date()
): Promise<HousePlaybookSummary> {
  const snap = await db
    .collection(EXPERIMENTS_COLLECTION)
    .where("status", "==", "evaluated")
    .get();

  const evaluated = snap.docs.map((doc) => mapExperimentDoc(doc.id, doc.data()));
  const summary = computePlaybookFromExperiments(evaluated, now);

  await db
    .collection(HOUSE_PLAYBOOK_COLLECTION)
    .doc(HOUSE_PLAYBOOK_SUMMARY_DOC_ID)
    .set({
      ...summary,
      updated_at: Timestamp.fromDate(now),
    });

  return summary;
}

export async function getHousePlaybook(
  db: Firestore = getDb(),
  now: Date = new Date()
): Promise<HousePlaybookSummary> {
  const snap = await db
    .collection(HOUSE_PLAYBOOK_COLLECTION)
    .doc(HOUSE_PLAYBOOK_SUMMARY_DOC_ID)
    .get();

  if (!snap.exists || !snap.data()) {
    return {
      updated_at: now.toISOString(),
      evaluated_experiment_count: 0,
      entries: [],
    };
  }

  const data = snap.data()!;
  const updatedAt = parseTimestampToDateOrNull(data.updated_at) ?? now;
  const rawEntries = Array.isArray(data.entries) ? data.entries : [];

  const entries: PlaybookEntry[] = [];
  for (const item of rawEntries) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const rawAction = asString(e.action_type, "custom");
    const actionType: ExperimentActionType = VALID_ACTION_TYPE_SET.has(rawAction)
      ? (rawAction as ExperimentActionType)
      : "custom";
    const rawTier = asString(e.energy_tax_tier, "unknown");
    const energyTaxTier: EnergyTaxTier | "unknown" = VALID_ENERGY_TIERS.has(rawTier)
      ? (rawTier as EnergyTaxTier)
      : "unknown";
    const rawConf = asString(e.confidence, "low");
    const confidence: PlaybookConfidence =
      rawConf === "high" || rawConf === "medium" ? rawConf : "low";

    entries.push({
      key: asString(e.key),
      location: asString(e.location, "unknown"),
      action_type: actionType,
      energy_tax_tier: energyTaxTier,
      sample_count: Math.max(0, Math.round(asNumber(e.sample_count, 0))),
      co2_delta_ppm: asNumber(e.co2_delta_ppm, 0),
      co2_delta_mean_ppm: asNumber(e.co2_delta_mean_ppm, 0),
      co2_rate_ppm_per_min: toFiniteNumberOrNull(e.co2_rate_ppm_per_min),
      pm2_5_delta_ug_m3: asNumber(e.pm2_5_delta_ug_m3, 0),
      temp_delta_f: asNumber(e.temp_delta_f, 0),
      humidity_delta_percent: asNumber(e.humidity_delta_percent, 0),
      avg_duration_minutes: toFiniteNumberOrNull(e.avg_duration_minutes),
      confidence,
      last_observed_at: asString(e.last_observed_at, updatedAt.toISOString()),
    });
  }

  return {
    updated_at: updatedAt.toISOString(),
    evaluated_experiment_count: Math.max(
      0,
      Math.round(asNumber(data.evaluated_experiment_count, entries.length))
    ),
    entries,
  };
}

export const AUTO_DETECT_CO2_DELTA_PPM = 150;
export const AUTO_DETECT_PM2_5_DELTA_UG_M3 = 15;
export const AUTO_DETECT_MAX_WINDOW_MINUTES = 15;
export const AUTO_DETECT_COOLDOWN_MINUTES = 30;
export const AUTO_DETECT_OVERLAP_BUFFER_MINUTES = 15;

export interface ReadingStepInput {
  device_id: string;
  location: string;
  timestamp: string;
  co2_ppm: number;
  pm2_5_ug_m3: number;
}

export interface DetectorDeviceState {
  device_id: string;
  last_timestamp: string;
  last_co2_ppm: number;
  last_pm2_5_ug_m3: number;
  last_detected_at: string | null;
}

export interface StepChangeEvaluation {
  triggered: boolean;
  reason: string;
  co2_delta_ppm?: number;
  pm2_5_delta_ug_m3?: number;
  note?: string;
}

export interface StepDetectionResult {
  detected: boolean;
  reason: string;
  experiment?: ExperimentRecord | null;
  co2_delta_ppm?: number;
  pm2_5_delta_ug_m3?: number;
}

export interface ProcessReadingForExperimentsResult {
  detection: StepDetectionResult;
  finalized_ids: string[];
}

export function evaluateStepChange(
  prior: DetectorDeviceState,
  current: ReadingStepInput
): StepChangeEvaluation {
  const priorMs = Date.parse(prior.last_timestamp);
  const currentMs = Date.parse(current.timestamp);
  if (!Number.isFinite(priorMs) || !Number.isFinite(currentMs)) {
    return { triggered: false, reason: "out_of_order_or_duplicate" };
  }

  const elapsedMin = (currentMs - priorMs) / 60_000;
  if (elapsedMin <= 0) {
    return { triggered: false, reason: "out_of_order_or_duplicate" };
  }
  if (elapsedMin > AUTO_DETECT_MAX_WINDOW_MINUTES) {
    return { triggered: false, reason: "gap_too_large" };
  }

  const co2Delta = roundTo(current.co2_ppm - prior.last_co2_ppm, 1);
  const pm25Delta = roundTo(current.pm2_5_ug_m3 - prior.last_pm2_5_ug_m3, 1);

  const co2Triggered = Math.abs(co2Delta) >= AUTO_DETECT_CO2_DELTA_PPM;
  const pm25Triggered = Math.abs(pm25Delta) >= AUTO_DETECT_PM2_5_DELTA_UG_M3;

  if (!co2Triggered && !pm25Triggered) {
    return {
      triggered: false,
      reason: "below_threshold",
      co2_delta_ppm: co2Delta,
      pm2_5_delta_ug_m3: pm25Delta,
    };
  }

  const elapsedLabel = `${Math.max(1, Math.round(elapsedMin))} min`;
  const parts: string[] = [];
  if (co2Triggered) {
    const dir = co2Delta < 0 ? "drop" : "spike";
    const signed = `${co2Delta > 0 ? "+" : ""}${Math.round(co2Delta)} ppm`;
    parts.push(
      `CO₂ ${dir} of ${signed} (${Math.round(prior.last_co2_ppm)} → ${Math.round(current.co2_ppm)} ppm)`
    );
  }
  if (pm25Triggered) {
    const dir = pm25Delta < 0 ? "drop" : "spike";
    const signed = `${pm25Delta > 0 ? "+" : ""}${pm25Delta.toFixed(1)} µg/m³`;
    parts.push(
      `PM2.5 ${dir} of ${signed} (${prior.last_pm2_5_ug_m3.toFixed(1)} → ${current.pm2_5_ug_m3.toFixed(1)} µg/m³)`
    );
  }

  return {
    triggered: true,
    reason: "threshold_exceeded",
    co2_delta_ppm: co2Delta,
    pm2_5_delta_ug_m3: pm25Delta,
    note: `Auto-detected ${parts.join(" and ")} over ${elapsedLabel}.`,
  };
}

function mapDetectorState(docId: string, data: DocumentData): DetectorDeviceState | null {
  const lastTs = parseTimestampToDateOrNull(data.last_timestamp);
  const co2 = toFiniteNumberOrNull(data.last_co2_ppm);
  const pm25 = toFiniteNumberOrNull(data.last_pm2_5_ug_m3);
  if (!lastTs || co2 === null || pm25 === null) {
    return null;
  }
  const lastDetected = parseTimestampToDateOrNull(data.last_detected_at);
  return {
    device_id: asString(data.device_id, docId),
    last_timestamp: lastTs.toISOString(),
    last_co2_ppm: co2,
    last_pm2_5_ug_m3: pm25,
    last_detected_at: lastDetected ? lastDetected.toISOString() : null,
  };
}

async function saveDetectorState(
  state: DetectorDeviceState,
  db: Firestore
): Promise<void> {
  await db
    .collection(EXPERIMENT_DETECTOR_STATE_COLLECTION)
    .doc(state.device_id)
    .set({
      device_id: state.device_id,
      last_timestamp: Timestamp.fromDate(new Date(state.last_timestamp)),
      last_co2_ppm: state.last_co2_ppm,
      last_pm2_5_ug_m3: state.last_pm2_5_ug_m3,
      last_detected_at: state.last_detected_at
        ? Timestamp.fromDate(new Date(state.last_detected_at))
        : null,
    });
}

export async function detectUnlabeledEventCandidate(
  reading: ReadingStepInput,
  options: { db?: Firestore; now?: Date } = {}
): Promise<StepDetectionResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const deviceId = reading.device_id.trim();
  const currentMs = Date.parse(reading.timestamp);
  if (!deviceId || !Number.isFinite(currentMs)) {
    return { detected: false, reason: "invalid_reading_payload" };
  }

  const normalizedCurrent: ReadingStepInput = {
    ...reading,
    device_id: deviceId,
    timestamp: new Date(currentMs).toISOString(),
  };

  const stateSnap = await db
    .collection(EXPERIMENT_DETECTOR_STATE_COLLECTION)
    .doc(deviceId)
    .get();

  const priorState =
    stateSnap.exists && stateSnap.data()
      ? mapDetectorState(stateSnap.id, stateSnap.data()!)
      : null;

  if (!priorState) {
    await saveDetectorState(
      {
        device_id: deviceId,
        last_timestamp: normalizedCurrent.timestamp,
        last_co2_ppm: normalizedCurrent.co2_ppm,
        last_pm2_5_ug_m3: normalizedCurrent.pm2_5_ug_m3,
        last_detected_at: null,
      },
      db
    );
    return { detected: false, reason: "initialized_baseline" };
  }

  const stepEval = evaluateStepChange(priorState, normalizedCurrent);
  if (stepEval.reason === "out_of_order_or_duplicate") {
    // Keep the newer stored state intact; never regress last_timestamp.
    return { detected: false, reason: "out_of_order_or_duplicate" };
  }

  const nextBaseState: DetectorDeviceState = {
    device_id: deviceId,
    last_timestamp: normalizedCurrent.timestamp,
    last_co2_ppm: normalizedCurrent.co2_ppm,
    last_pm2_5_ug_m3: normalizedCurrent.pm2_5_ug_m3,
    last_detected_at: priorState.last_detected_at,
  };

  if (!stepEval.triggered) {
    await saveDetectorState(nextBaseState, db);
    return {
      detected: false,
      reason: stepEval.reason,
      ...(stepEval.co2_delta_ppm !== undefined ? { co2_delta_ppm: stepEval.co2_delta_ppm } : {}),
      ...(stepEval.pm2_5_delta_ug_m3 !== undefined ? { pm2_5_delta_ug_m3: stepEval.pm2_5_delta_ug_m3 } : {}),
    };
  }

  if (priorState.last_detected_at) {
    const lastDetectedMs = Date.parse(priorState.last_detected_at);
    if (
      Number.isFinite(lastDetectedMs) &&
      currentMs - lastDetectedMs < AUTO_DETECT_COOLDOWN_MINUTES * 60_000
    ) {
      await saveDetectorState(nextBaseState, db);
      return {
        detected: false,
        reason: "cooldown_active",
        co2_delta_ppm: stepEval.co2_delta_ppm,
        pm2_5_delta_ug_m3: stepEval.pm2_5_delta_ug_m3,
      };
    }
  }

  const priorMs = Date.parse(priorState.last_timestamp);
  const bufferMs = AUTO_DETECT_OVERLAP_BUFFER_MINUTES * 60_000;
  const windowStartMs = priorMs - bufferMs;
  const windowEndMs = currentMs + bufferMs;

  const recentExperiments = await listExperiments({ device_id: deviceId, limit: 15 }, db);
  const hasOverlap = recentExperiments.some((exp) => {
    if (exp.status === "dismissed") {
      return false;
    }
    if (exp.status === "active") {
      return true;
    }
    const expStartMs = Date.parse(exp.started_at);
    const expEndMs = exp.ended_at ? Date.parse(exp.ended_at) : expStartMs;
    if (!Number.isFinite(expStartMs) || !Number.isFinite(expEndMs)) {
      return false;
    }
    return expStartMs <= windowEndMs && expEndMs >= windowStartMs;
  });

  if (hasOverlap) {
    await saveDetectorState(nextBaseState, db);
    return {
      detected: false,
      reason: "overlapping_experiment",
      co2_delta_ppm: stepEval.co2_delta_ppm,
      pm2_5_delta_ug_m3: stepEval.pm2_5_delta_ug_m3,
    };
  }

  const candidate = await createExperiment(
    {
      action_type: "custom",
      device_id: deviceId,
      location: normalizedCurrent.location || undefined,
      started_at: priorState.last_timestamp,
      ended_at: normalizedCurrent.timestamp,
      notes: stepEval.note ?? null,
      status: "unlabeled",
      source: "auto_detected",
      created_by: "auto-detector",
      evaluate_if_ready: false,
      now,
    },
    db
  );

  await saveDetectorState(
    {
      ...nextBaseState,
      last_detected_at: normalizedCurrent.timestamp,
    },
    db
  );

  return {
    detected: true,
    reason: "candidate_created",
    experiment: candidate,
    co2_delta_ppm: stepEval.co2_delta_ppm,
    pm2_5_delta_ug_m3: stepEval.pm2_5_delta_ug_m3,
  };
}

export async function finalizeDuePendingExperiments(
  options: { db?: Firestore; now?: Date } = {}
): Promise<string[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const settleLeadMs = POST_SETTLE_WINDOW_MINUTES * 60_000;

  const snap = await db
    .collection(EXPERIMENTS_COLLECTION)
    .where("status", "==", "pending_evaluation")
    .get();

  const finalizedIds: string[] = [];
  for (const doc of snap.docs) {
    const exp = mapExperimentDoc(doc.id, doc.data());
    if (!exp.ended_at) {
      continue;
    }
    const endedMs = Date.parse(exp.ended_at);
    if (!Number.isFinite(endedMs) || endedMs + settleLeadMs > now.getTime()) {
      continue;
    }

    const updated = await evaluateExperimentOutcome(exp.id, {
      db,
      now,
      rebuildPlaybook: false,
    });
    if (updated && updated.status === "evaluated") {
      finalizedIds.push(updated.id);
    }
  }

  if (finalizedIds.length > 0) {
    await rebuildHousePlaybook(db, now);
  }

  return finalizedIds;
}

export async function processReadingForExperiments(
  rawData: DocumentData,
  options: { db?: Firestore; now?: Date } = {}
): Promise<ProcessReadingForExperimentsResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  const finalizedIds = await finalizeDuePendingExperiments({ db, now });

  const deviceId =
    typeof rawData.device_id === "string" ? rawData.device_id.trim() : "";
  const tsDate = parseTimestampToDateOrNull(rawData.timestamp);
  const co2 = toFiniteNumberOrNull(rawData.co2_ppm);
  const pm25 = toFiniteNumberOrNull(rawData.pm2_5_ug_m3);

  if (!deviceId || !tsDate || co2 === null) {
    return {
      detection: { detected: false, reason: "invalid_reading_payload" },
      finalized_ids: finalizedIds,
    };
  }

  const location =
    typeof rawData.location === "string" && rawData.location.trim().length > 0
      ? rawData.location.trim()
      : "unknown";

  const detection = await detectUnlabeledEventCandidate(
    {
      device_id: deviceId,
      location,
      timestamp: tsDate.toISOString(),
      co2_ppm: co2,
      pm2_5_ug_m3: pm25 ?? 0,
    },
    { db, now }
  );

  return {
    detection,
    finalized_ids: finalizedIds,
  };
}
