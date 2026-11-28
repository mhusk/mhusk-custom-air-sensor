/**
 * Typed HTTP client for the WorkOS-protected Dashboard API (`/api/*`).
 * Automatically attaches Bearer tokens and performs single-flight refresh on 401.
 */

import { clearSession, loadSession, refreshSessionDetailed } from "./auth.js";

const DEFAULT_API_TIMEOUT_MS = 15_000;

function createFetchSignal(externalSignal, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  const hasTimeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
  if (externalSignal && timeoutSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([externalSignal, timeoutSignal]);
  }
  return externalSignal ?? timeoutSignal;
}

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
    signal: createFetchSignal(undefined),
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
    signal: createFetchSignal(options.signal),
  });

  if (response.status === 401 && !retried && session.refreshToken) {
    const refreshed = await refreshSessionDetailed();
    if (refreshed.status === "ok" && refreshed.session?.accessToken) {
      return authenticatedJsonFetch(path, options, true);
    }
    if (refreshed.status === "transient_error") {
      throw new ApiError(
        503,
        "refresh_unavailable",
        "Unable to refresh your session right now. Please try again."
      );
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
export function fetchDashboardOverview({ refresh = false } = {}) {
  return authenticatedJsonFetch(`/api/dashboard/overview${refresh ? "?refresh=1" : ""}`);
}

/**
 * Builds the `/api/readings/history` request URL with optional `refresh=1` cache bypass.
 *
 * @param {{
 *   hours?: number,
 *   limit?: number,
 *   period?: "1h" | "6h" | "24h" | "7d" | "30d",
 *   deviceId?: string,
 *   location?: string,
 *   refresh?: boolean,
 * }} params
 * @returns {string}
 */
export function buildReadingsHistoryPath(params = {}) {
  const qs = new URLSearchParams();
  if (params.hours !== undefined) qs.set("hours", String(params.hours));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.period) qs.set("period", params.period);
  if (params.deviceId) qs.set("device_id", params.deviceId);
  if (params.location) qs.set("location", params.location);
  if (params.refresh) qs.set("refresh", "1");

  const query = qs.toString();
  return `/api/readings/history${query ? `?${query}` : ""}`;
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
 *   refresh?: boolean,
 * }} params
 */
export function fetchReadingsHistory(params = {}) {
  return authenticatedJsonFetch(buildReadingsHistoryPath(params), { signal: params.signal });
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
export function fetchFirmwareReleases({ refresh = false } = {}) {
  return authenticatedJsonFetch(`/api/firmware/releases${refresh ? "?refresh=1" : ""}`);
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

/**
 * Saves private Home Location settings (`site_configs/home`) for Open-Meteo
 * outdoor weather & AQI tracking, and immediately fetches a fresh reading.
 *
 * @param {{
 *   label: string,
 *   latitude: number,
 *   longitude: number,
 *   outdoor_poll_interval_minutes: number,
 * }} config
 */
export function saveSiteLocationConfig(config) {
  return authenticatedJsonFetch("/api/site/config", {
    method: "PUT",
    body: config,
  });
}

/**
 * Forces an on-demand Open-Meteo outdoor weather + AQI refresh.
 */
export function triggerOutdoorRefresh() {
  return authenticatedJsonFetch("/api/outdoor/refresh", {
    method: "POST",
  });
}

/**
 * Fetches the cached 24-hour Open-Meteo forecast and scored free/low-energy-tax
 * ventilation windows for the configured home location.
 *
 * @param {{ refresh?: boolean }} [options]
 */
export function fetchOutdoorForecast({ refresh = false } = {}) {
  return authenticatedJsonFetch(`/api/outdoor/forecast${refresh ? "?refresh=1" : ""}`);
}

/**
 * Builds `/api/experiments` with optional filters and `refresh=1` cache bypass.
 *
 * @param {{
 *   status?: string | string[],
 *   deviceId?: string,
 *   location?: string,
 *   actionType?: string,
 *   limit?: number,
 *   refresh?: boolean,
 * }} [params]
 */
export function buildExperimentsPath(params = {}) {
  const qs = new URLSearchParams();
  if (Array.isArray(params.status)) {
    if (params.status.length > 0) qs.set("status", params.status.join(","));
  } else if (params.status) {
    qs.set("status", params.status);
  }
  if (params.deviceId) qs.set("device_id", params.deviceId);
  if (params.location) qs.set("location", params.location);
  if (params.actionType) qs.set("action_type", params.actionType);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.refresh) qs.set("refresh", "1");
  const query = qs.toString();
  return `/api/experiments${query ? `?${query}` : ""}`;
}

/**
 * Lists logged and auto-detected experiments, newest first.
 *
 * @param {{
 *   status?: string | string[],
 *   deviceId?: string,
 *   location?: string,
 *   actionType?: string,
 *   limit?: number,
 *   refresh?: boolean,
 * }} [params]
 */
export function fetchExperiments(params = {}) {
  return authenticatedJsonFetch(buildExperimentsPath(params));
}

/**
 * Starts or records an experiment. `source` is set to `dashboard` by the API.
 *
 * @param {Record<string, unknown>} body
 */
export function createExperiment(body) {
  return authenticatedJsonFetch("/api/experiments", {
    method: "POST",
    body,
  });
}

/**
 * Finishes, labels, or dismisses an experiment.
 *
 * @param {string} experimentId
 * @param {Record<string, unknown>} body
 */
export function updateExperiment(experimentId, body) {
  return authenticatedJsonFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, {
    method: "PATCH",
    body,
  });
}

/**
 * Builds `/api/playbook` with optional ranking context and `refresh=1`.
 *
 * @param {{
 *   location?: string,
 *   energyTaxTier?: string,
 *   primaryGoal?: "lower_co2" | "lower_pm2_5" | "balanced",
 *   refresh?: boolean,
 * }} [params]
 */
export function buildPlaybookPath(params = {}) {
  const qs = new URLSearchParams();
  if (params.location) qs.set("location", params.location);
  if (params.energyTaxTier) qs.set("energy_tax_tier", params.energyTaxTier);
  if (params.primaryGoal) qs.set("primary_goal", params.primaryGoal);
  if (params.refresh) qs.set("refresh", "1");
  const query = qs.toString();
  return `/api/playbook${query ? `?${query}` : ""}`;
}

/**
 * Fetches the House Physics Playbook and ranked recommendations.
 *
 * @param {{
 *   location?: string,
 *   energyTaxTier?: string,
 *   primaryGoal?: "lower_co2" | "lower_pm2_5" | "balanced",
 *   refresh?: boolean,
 * }} [params]
 */
export function fetchPlaybook(params = {}) {
  return authenticatedJsonFetch(buildPlaybookPath(params));
}
