import { z } from "zod";

import {
  EXPERIMENT_ACTION_TYPES,
  EXPERIMENT_STATUSES,
} from "../services/experiments.js";
import { isValidFirmwareVersion, type SummaryPeriod } from "../services/firestore.js";
import {
  DEFAULT_OUTDOOR_POLL_INTERVAL_MINUTES,
  MAX_OUTDOOR_POLL_INTERVAL_MINUTES,
  MIN_OUTDOOR_POLL_INTERVAL_MINUTES,
} from "../services/outdoor.js";

export const DEVICE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const EXPERIMENT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function isValidIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export const SUMMARY_PERIOD_VALUES = new Set<SummaryPeriod>([
  "1h",
  "6h",
  "24h",
  "7d",
  "30d",
]);

export const updateDeviceConfigSchema = z
  .object({
    location: z
      .string()
      .trim()
      .regex(
        DEVICE_ID_REGEX,
        "location must be 1-64 characters using letters, numbers, underscores, or hyphens."
      ),
    reporting_interval_seconds: z
      .number()
      .int("reporting_interval_seconds must be a whole number.")
      .min(60, "reporting_interval_seconds must be at least 60 seconds.")
      .max(3600, "reporting_interval_seconds must be at most 3600 seconds."),
    temperature_offset_c: z
      .number()
      .finite("temperature_offset_c must be a finite number.")
      .min(0, "temperature_offset_c must be between 0 and 20 °C.")
      .max(20, "temperature_offset_c must be between 0 and 20 °C."),
    altitude_m: z
      .number()
      .int("altitude_m must be a whole number.")
      .min(0, "altitude_m must be between 0 and 5000 meters.")
      .max(5000, "altitude_m must be between 0 and 5000 meters."),
    led_enabled: z.boolean(),
  })
  .strict();

export const authExchangeSchema = z
  .object({
    code: z.string().trim().min(1).max(2048),
    code_verifier: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const authRefreshSchema = z
  .object({
    refresh_token: z.string().trim().min(1).max(4096),
  })
  .strict();

export const setTargetFirmwareSchema = z
  .object({
    target_firmware_version: z
      .string()
      .trim()
      .refine(
        isValidFirmwareVersion,
        "target_firmware_version must be a valid SemVer string (e.g. 1.3.2)."
      )
      .nullable(),
  })
  .strict();

export const fleetRolloutSchema = z
  .object({
    target_firmware_version: z
      .string()
      .trim()
      .refine(
        isValidFirmwareVersion,
        "target_firmware_version must be a valid SemVer string (e.g. 1.3.2)."
      )
      .nullable(),
    device_ids: z
      .array(
        z
          .string()
          .trim()
          .regex(
            DEVICE_ID_REGEX,
            "Each device_id must be 1-64 characters using letters, numbers, underscores, or hyphens."
          )
      )
      .min(1, "device_ids must contain at least one device ID when provided.")
      .max(50, "device_ids cannot exceed 50 devices in a single rollout.")
      .optional(),
  })
  .strict();

export const updateSiteLocationConfigSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "label must be 1-64 characters.")
      .max(64, "label must be 1-64 characters."),
    latitude: z
      .number()
      .finite("latitude must be a valid number.")
      .min(-90, "latitude must be between -90 and 90.")
      .max(90, "latitude must be between -90 and 90."),
    longitude: z
      .number()
      .finite("longitude must be a valid number.")
      .min(-180, "longitude must be between -180 and 180.")
      .max(180, "longitude must be between -180 and 180."),
    outdoor_poll_interval_minutes: z
      .number()
      .int("outdoor_poll_interval_minutes must be a whole number.")
      .min(
        MIN_OUTDOOR_POLL_INTERVAL_MINUTES,
        `outdoor_poll_interval_minutes must be at least ${MIN_OUTDOOR_POLL_INTERVAL_MINUTES}.`
      )
      .max(
        MAX_OUTDOOR_POLL_INTERVAL_MINUTES,
        `outdoor_poll_interval_minutes must be at most ${MAX_OUTDOOR_POLL_INTERVAL_MINUTES}.`
      )
      .default(DEFAULT_OUTDOOR_POLL_INTERVAL_MINUTES),
  })
  .strict();

const isoTimestampSchema = z
  .string()
  .trim()
  .refine(isValidIsoTimestamp, "Must be a valid ISO-8601 timestamp.");

export const createExperimentSchema = z
  .object({
    action_type: z.enum(EXPERIMENT_ACTION_TYPES),
    device_id: z
      .string()
      .trim()
      .regex(
        DEVICE_ID_REGEX,
        "device_id must be 1-64 characters using letters, numbers, underscores, or hyphens."
      ),
    location: z
      .string()
      .trim()
      .regex(
        DEVICE_ID_REGEX,
        "location must be 1-64 characters using letters, numbers, underscores, or hyphens."
      )
      .nullable()
      .optional(),
    custom_label: z.string().trim().max(80).nullable().optional(),
    started_at: isoTimestampSchema.optional(),
    ended_at: isoTimestampSchema.nullable().optional(),
    duration_minutes: z.number().finite().positive().max(1440).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    evaluate_if_ready: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.started_at && data.ended_at) {
      if (Date.parse(data.ended_at) < Date.parse(data.started_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ended_at"],
          message: "'ended_at' must be greater than or equal to 'started_at'.",
        });
      }
    }
  });

export const updateExperimentSchema = z
  .object({
    action_type: z.enum(EXPERIMENT_ACTION_TYPES).optional(),
    custom_label: z.string().trim().max(80).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    started_at: isoTimestampSchema.optional(),
    ended_at: isoTimestampSchema.nullable().optional(),
    duration_minutes: z.number().finite().positive().max(1440).nullable().optional(),
    status: z.enum(EXPERIMENT_STATUSES).optional(),
    evaluate_if_ready: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasField =
      data.action_type !== undefined ||
      data.custom_label !== undefined ||
      data.notes !== undefined ||
      data.started_at !== undefined ||
      data.ended_at !== undefined ||
      data.duration_minutes !== undefined ||
      data.status !== undefined;
    if (!hasField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "At least one experiment field must be provided to update.",
      });
    }
    if (data.started_at && data.ended_at) {
      if (Date.parse(data.ended_at) < Date.parse(data.started_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ended_at"],
          message: "'ended_at' must be greater than or equal to 'started_at'.",
        });
      }
    }
  });

export const evaluateExperimentSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();
