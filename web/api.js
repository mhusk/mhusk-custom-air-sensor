/**
 * Typed HTTP client for the WorkOS-protected Dashboard API (`/api/*`).
 * Automatically attaches Bearer tokens and performs single-flight refresh on 401.
 */

import { clearSession, loadSession, refreshSession } from "./auth.js";

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Array<{ path: string, message: string }>} [issues]
   */
  constructor(status, code, message, issues = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/**
 * Public non-secret AuthKit client discovery.
 */
export async function fetchAuthConfig() {
  const response = await fetch("/api/auth/config", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error || "auth_config_failed",
      payload.message || `Unable to load auth configuration (HTTP ${response.status}).`
    );
  }
  return payload;
}

/**
 * Authenticated JSON fetch with automatic single-retry refresh on 401.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @param {boolean} [retried]
 */
async function authenticatedJsonFetch(path, options = {}, retried = false) {
  const session = loadSession();
  if (!session?.accessToken) {
    throw new ApiError(401, "not_authenticated", "Please sign in to access the dashboard.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body,
  });

  if (response.status === 401 && !retried && session.refreshToken) {
    const refreshed = await refreshSession();
    if (refreshed?.accessToken) {
      return authenticatedJsonFetch(path, options, true);
    }
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
    }
    throw new ApiError(
      response.status,
      payload.error || "api_error",
      payload.message || `Request failed with HTTP ${response.status}.`,
      Array.isArray(payload.issues) ? payload.issues : []
    );
  }

  return payload;
}

/** Verifies current user identity. */
export function fetchMe() {
  return authenticatedJsonFetch("/api/me");
}

/** Fetches live room cards, health context, desired config, and sync status. */
export function fetchDashboardOverview() {
  return authenticatedJsonFetch("/api/dashboard/overview");
}

/**
 * Fetches chronological time-series readings and period statistics.
 *
 * @param {{
 *   hours?: number,
 *   limit?: number,
 *   period?: "1h" | "6h" | "24h" | "7d" | "30d",
 *   deviceId?: string,
 *   location?: string,
 * }} params
 */
export function fetchReadingsHistory(params = {}) {
  const qs = new URLSearchParams();
  if (params.hours !== undefined) qs.set("hours", String(params.hours));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.period) qs.set("period", params.period);
  if (params.deviceId) qs.set("device_id", params.deviceId);
  if (params.location) qs.set("location", params.location);

  const query = qs.toString();
  return authenticatedJsonFetch(`/api/readings/history${query ? `?${query}` : ""}`);
}

/**
 * Fetches desired and reported config for a single device.
 *
 * @param {string} deviceId
 */
export function fetchDeviceConfig(deviceId) {
  return authenticatedJsonFetch(`/api/devices/${encodeURIComponent(deviceId)}/config`);
}

/**
 * Saves validated Layer 1 remote settings to `device_configs/{deviceId}`.
 *
 * @param {string} deviceId
 * @param {{
 *   location: string,
 *   reporting_interval_seconds: number,
 *   temperature_offset_c: number,
 *   altitude_m: number,
 *   led_enabled: boolean,
 * }} config
 */
export function saveDeviceConfig(deviceId, config) {
  return authenticatedJsonFetch(`/api/devices/${encodeURIComponent(deviceId)}/config`, {
    method: "PUT",
    body: config,
  });
}

/**
 * Stamps a safe one-shot `reboot_requested_at` timestamp on `device_configs/{deviceId}`.
 *
 * @param {string} deviceId
 */
export function triggerDeviceReboot(deviceId) {
  return authenticatedJsonFetch(`/api/devices/${encodeURIComponent(deviceId)}/reboot`, {
    method: "POST",
  });
}

/**
 * Lists all published OTA firmware release manifests (newest-first).
 */
export function fetchFirmwareReleases() {
  return authenticatedJsonFetch("/api/firmware/releases");
}

/**
 * Sets or clears `target_firmware_version` for a single sensor device.
 *
 * @param {string} deviceId
 * @param {string | null} targetFirmwareVersion
 */
export function setDeviceTargetFirmware(deviceId, targetFirmwareVersion) {
  return authenticatedJsonFetch(`/api/devices/${encodeURIComponent(deviceId)}/firmware`, {
    method: "PUT",
    body: { target_firmware_version: targetFirmwareVersion },
  });
}

/**
 * Sets or clears `target_firmware_version` across all registered sensors (or a subset).
 *
 * @param {string | null} targetFirmwareVersion
 * @param {string[]} [deviceIds]
 */
export function triggerFleetRollout(targetFirmwareVersion, deviceIds) {
  const body = { target_firmware_version: targetFirmwareVersion };
  if (Array.isArray(deviceIds) && deviceIds.length > 0) {
    body.device_ids = deviceIds;
  }
  return authenticatedJsonFetch("/api/firmware/rollout", {
    method: "POST",
    body,
  });
}
