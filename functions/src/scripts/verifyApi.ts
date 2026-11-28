import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { handleDashboardApiRequest, type DashboardDataService } from "../api/dashboard.js";
import type {
  AuthKitSessionResult,
  ResolvedWorkosUser,
  WorkosAuthConfig,
} from "../auth/workos.js";
import { createMcpHttpHandler } from "../index.js";
import {
  computePlaybookFromExperiments,
  type ExperimentRecord,
} from "../services/experiments.js";
import type {
  DeviceConfig,
  DeviceStatus,
  FirmwareReleaseManifest,
} from "../services/firestore.js";
import { createMockAirQualityService } from "./localMcpServer.js";

function createMockDashboardService(): {
  service: DashboardDataService;
  counts: {
    getSensorStatus: number;
    listFirmwareReleases: number;
    getReadingsHistory: number;
    getAirQualitySummary: number;
    getReadingsHistoryWithSummary: number;
    listExperiments: number;
    getHousePlaybook: number;
  };
} {
  const baseService = createMockAirQualityService();
  const counts = {
    getSensorStatus: 0,
    listFirmwareReleases: 0,
    getReadingsHistory: 0,
    getAirQualitySummary: 0,
    getReadingsHistoryWithSummary: 0,
    listExperiments: 0,
    getHousePlaybook: 0,
  };
  const experiments = new Map<string, ExperimentRecord>();
  let expCounter = 0;

  const configs = new Map<string, DeviceConfig>([
    [
      "feather-s3-01",
      {
        device_id: "feather-s3-01",
        location: "home-office",
        reporting_interval_seconds: 300,
        temperature_offset_c: 4.0,
        altitude_m: 0,
        led_enabled: true,
        config_version: 1,
        reboot_requested_at: null,
        target_firmware_version: null,
        updated_at: "2026-11-24T13:52:00.000Z",
        updated_by: "initial-seed",
        floor: null,
      },
    ],
  ]);

  const releases = new Map<string, FirmwareReleaseManifest>([
    [
      "1.3.2",
      {
        version: "1.3.2",
        min_bootloader_version: "1.0.0",
        notes: "Step 18 verified OTA release",
        file_count: 4,
        total_size_bytes: 88337,
        files: {
          "app.py": { doc_id: "app.py", sha256: "a".repeat(64), size_bytes: 34000 },
        },
        created_at: "2026-11-24T14:50:00.000Z",
        created_by: "publish-cli",
        git_sha: "ef22e8f",
        status: "active",
      },
    ],
    [
      "1.3.1-yanked",
      {
        version: "1.3.1-yanked",
        min_bootloader_version: "1.0.0",
        notes: "Yanked test build",
        file_count: 4,
        total_size_bytes: 88000,
        files: {
          "app.py": { doc_id: "app.py", sha256: "b".repeat(64), size_bytes: 34000 },
        },
        created_at: "2026-11-24T14:10:00.000Z",
        created_by: "publish-cli",
        git_sha: "9184020",
        status: "yanked",
      },
    ],
  ]);

  const service: DashboardDataService = {
    getSensorStatus: async (options) => {
      counts.getSensorStatus += 1;
      const result = await baseService.getSensorStatus(options);
      const devices: DeviceStatus[] = result.devices.map((device) => ({
        ...device,
        firmware_version: "1.1.0",
        config_version: 1,
        temperature_offset_c: 4.0,
        altitude_m: 0,
        led_enabled: true,
        ota_status: "up_to_date",
        ota_target_version: null,
        ota_last_error: null,
      }));
      return { ...result, devices };
    },
    getLatestReading: (options) => baseService.getLatestReading(options),
    getReadingsHistory: async (options) => {
      counts.getReadingsHistory += 1;
      return baseService.getReadingsHistory(options);
    },
    getAirQualitySummary: async (options) => {
      counts.getAirQualitySummary += 1;
      return baseService.getAirQualitySummary(options);
    },
    getReadingsHistoryWithSummary: async (options = {}) => {
      const hours = options.hours ?? 24;
      const inferredPeriod = hours <= 1 ? "1h" : hours <= 6 ? "6h" : hours <= 24 ? "24h" : "7d";
      const period = options.period ?? inferredPeriod;
      const periodHoursMap = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 } as const;
      if (periodHoursMap[period] === hours) {
        counts.getReadingsHistoryWithSummary += 1;
        const [history, summary] = await Promise.all([
          baseService.getReadingsHistory(options),
          baseService.getAirQualitySummary({
            period,
            device_id: options.device_id,
            location: options.location,
          }),
        ]);
        return { history, summary };
      }
      const [history, summary] = await Promise.all([
        service.getReadingsHistory(options),
        service.getAirQualitySummary({
          period,
          device_id: options.device_id,
          location: options.location,
        }),
      ]);
      return { history, summary };
    },
    getDeviceConfig: async (deviceId) => configs.get(deviceId) ?? null,
    listDeviceConfigs: async () => Object.fromEntries(configs.entries()),
    updateDeviceConfig: async (deviceId, input, updatedBy) => {
      const existing = configs.get(deviceId);
      const next: DeviceConfig = {
        device_id: deviceId,
        location: input.location,
        reporting_interval_seconds: input.reporting_interval_seconds,
        temperature_offset_c: Math.round(input.temperature_offset_c * 100) / 100,
        altitude_m: Math.round(input.altitude_m),
        led_enabled: input.led_enabled,
        config_version: (existing?.config_version ?? 0) + 1,
        reboot_requested_at: existing?.reboot_requested_at ?? null,
        target_firmware_version: existing?.target_firmware_version ?? null,
        floor: input.floor === undefined ? existing?.floor ?? null : input.floor,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      };
      configs.set(deviceId, next);
      return next;
    },
    requestDeviceReboot: async (deviceId, updatedBy) => {
      const existing = configs.get(deviceId);
      const nowIso = new Date().toISOString();
      const next: DeviceConfig = {
        device_id: deviceId,
        location: existing?.location ?? "home-office",
        reporting_interval_seconds: existing?.reporting_interval_seconds ?? 300,
        temperature_offset_c: existing?.temperature_offset_c ?? 4.0,
        altitude_m: existing?.altitude_m ?? 0,
        led_enabled: existing?.led_enabled ?? true,
        config_version: (existing?.config_version ?? 0) + 1,
        reboot_requested_at: nowIso,
        target_firmware_version: existing?.target_firmware_version ?? null,
        floor: existing?.floor ?? null,
        updated_at: nowIso,
        updated_by: updatedBy,
      };
      configs.set(deviceId, next);
      return next;
    },
    listFirmwareReleases: async () => {
      counts.listFirmwareReleases += 1;
      return Array.from(releases.values()).sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
    },
    getFirmwareRelease: async (version) => releases.get(version) ?? null,
    setDeviceTargetFirmwareVersion: async (deviceId, targetVersion, updatedBy) => {
      const existing = configs.get(deviceId);
      const nowIso = new Date().toISOString();
      const next: DeviceConfig = {
        device_id: deviceId,
        location: existing?.location ?? "home-office",
        reporting_interval_seconds: existing?.reporting_interval_seconds ?? 300,
        temperature_offset_c: existing?.temperature_offset_c ?? 4.0,
        altitude_m: existing?.altitude_m ?? 0,
        led_enabled: existing?.led_enabled ?? true,
        config_version: (existing?.config_version ?? 0) + 1,
        reboot_requested_at: existing?.reboot_requested_at ?? null,
        target_firmware_version: targetVersion,
        floor: existing?.floor ?? null,
        updated_at: nowIso,
        updated_by: updatedBy,
      };
      configs.set(deviceId, next);
      return next;
    },
    syncOutdoorReadingIfStale: async () => ({
      synced: true,
      reason: "forced_refresh",
      reading: null,
    }),
    listExperiments: async (options = {}) => {
      counts.listExperiments += 1;
      const statusSet = options.status
        ? new Set(Array.isArray(options.status) ? options.status : [options.status])
        : null;
      const items = Array.from(experiments.values())
        .filter((e) => {
          if (statusSet && !statusSet.has(e.status)) return false;
          if (options.device_id && e.device_id !== options.device_id) return false;
          if (options.location && e.location !== options.location) return false;
          if (options.action_type && e.action_type !== options.action_type) return false;
          return true;
        })
        .sort((a, b) => b.started_at.localeCompare(a.started_at));
      return options.limit ? items.slice(0, options.limit) : items;
    },
    getExperiment: async (id) => experiments.get(id) ?? null,
    createExperiment: async (input) => {
      expCounter += 1;
      const id = `exp_mock_${expCounter}`;
      const nowIso = new Date().toISOString();
      const startedAtIso = input.started_at ?? nowIso;
      let endedAtIso = input.ended_at ?? null;
      let durationMinutes = input.duration_minutes ?? null;
      if (!endedAtIso && durationMinutes) {
        endedAtIso = new Date(Date.parse(startedAtIso) + durationMinutes * 60_000).toISOString();
      } else if (endedAtIso) {
        const diffMs = Date.parse(endedAtIso) - Date.parse(startedAtIso);
        if (diffMs < 0) {
          throw new Error("'ended_at' must be greater than or equal to 'started_at'.");
        }
        durationMinutes = Math.round((diffMs / 60_000) * 10) / 10;
      }
      const record: ExperimentRecord = {
        id,
        action_type: input.action_type,
        custom_label: input.custom_label ?? null,
        device_id: input.device_id,
        location: input.location ?? configs.get(input.device_id)?.location ?? "home-office",
        started_at: startedAtIso,
        ended_at: endedAtIso,
        duration_minutes: durationMinutes,
        notes: input.notes ?? null,
        status: endedAtIso ? "pending_evaluation" : "active",
        source: input.source ?? "dashboard",
        outdoor_snapshot: null,
        energy_tax_tier: "free",
        evaluation: null,
        created_at: nowIso,
        created_by: input.created_by ?? "owner@example.com",
        updated_at: nowIso,
      };
      experiments.set(id, record);
      return record;
    },
    updateExperiment: async (id, input) => {
      const existing = experiments.get(id);
      if (!existing) return null;
      const startedAtIso = input.started_at ?? existing.started_at;
      const endedAtIso =
        input.ended_at === null ? null : (input.ended_at ?? existing.ended_at);
      if (endedAtIso && Date.parse(endedAtIso) < Date.parse(startedAtIso)) {
        throw new Error("'ended_at' must be greater than or equal to 'started_at'.");
      }
      const durationMinutes = endedAtIso
        ? Math.round(((Date.parse(endedAtIso) - Date.parse(startedAtIso)) / 60_000) * 10) / 10
        : null;
      const nextStatus =
        input.status ??
        (existing.status === "active" && endedAtIso ? "pending_evaluation" : existing.status);
      const updated: ExperimentRecord = {
        ...existing,
        action_type: input.action_type ?? existing.action_type,
        custom_label:
          input.custom_label !== undefined ? input.custom_label : existing.custom_label,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        started_at: startedAtIso,
        ended_at: endedAtIso,
        duration_minutes: durationMinutes,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      };
      experiments.set(id, updated);
      return updated;
    },
    evaluateExperimentOutcome: async (id) => {
      const existing = experiments.get(id);
      if (!existing) return null;
      if (!existing.ended_at) {
        throw new Error("Cannot evaluate an active experiment without an end time.");
      }
      const nowIso = new Date().toISOString();
      const evaluated: ExperimentRecord = {
        ...existing,
        status: "evaluated",
        evaluation: {
          baseline: {
            sample_count: 3,
            co2_ppm: 1200,
            pm2_5_ug_m3: 8,
            temperature_f: 70,
            humidity_percent: 45,
          },
          post_settle: {
            sample_count: 3,
            co2_ppm: 850,
            pm2_5_ug_m3: 6,
            temperature_f: 68.5,
            humidity_percent: 43,
          },
          co2_delta_ppm: -350,
          co2_rate_ppm_per_min: -35,
          pm2_5_delta_ug_m3: -2,
          temp_delta_f: -1.5,
          humidity_delta_percent: -2,
          cross_room_deltas: [],
          evaluated_at: nowIso,
        },
        updated_at: nowIso,
      };
      experiments.set(id, evaluated);
      return evaluated;
    },
    getHousePlaybook: async () => {
      counts.getHousePlaybook += 1;
      return computePlaybookFromExperiments(Array.from(experiments.values()));
    },
  };

  return { service, counts };
}

async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    rawBody = JSON.stringify(options.body);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: rawBody,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body };
}

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-api-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const localJwks = createLocalJWKSet({ keys: [publicJwk] });
  const fakeAuthKitDomain = "https://demo-sensor.authkit.app";
  const fakeClientId = "client_test_dashboard";
  const testFallbackToken = "local-unit-test-dashboard-bearer-secret";

  const fakeUsers: Record<string, ResolvedWorkosUser> = {
    user_owner_allowed: {
      id: "user_owner_allowed",
      email: "owner@example.com",
      emailVerified: true,
    },
    user_owner_unverified: {
      id: "user_owner_unverified",
      email: "owner@example.com",
      emailVerified: false,
    },
    user_stranger: {
      id: "user_stranger",
      email: "stranger@example.com",
      emailVerified: true,
    },
  };

  const fakeUserManagementSessionToken = "um-session-jwt-owner-valid";

  const authConfig: WorkosAuthConfig = {
    workosApiKey: "unit-test-placeholder-api-key",
    workosClientId: fakeClientId,
    workosAuthKitDomain: fakeAuthKitDomain,
    allowedUserEmails: "owner@example.com",
    bearerFallbackSecret: testFallbackToken,
    allowedDashboardOrigins: "https://dashboard.example.web.app",
  };

  const mockDashboard = createMockDashboardService();

  const handler = createMcpHttpHandler({
    getAuthConfig: () => authConfig,
    authDeps: {
      getKey: localJwks,
      getUserById: async (userId) => fakeUsers[userId] ?? null,
      verifyUserAccessToken: async (token) => {
        if (token === fakeUserManagementSessionToken) {
          return { sub: "user_owner_allowed", exp: Math.floor(Date.now() / 1000) + 3600 };
        }
        return null;
      },
      authenticateWithCode: async ({ code }): Promise<AuthKitSessionResult> => {
        if (code === "code_owner_ok") {
          return {
            accessToken: fakeUserManagementSessionToken,
            refreshToken: "refresh_owner_ok",
            user: {
              id: "user_owner_allowed",
              email: "owner@example.com",
              emailVerified: true,
              firstName: "Owner",
              lastName: "User",
            },
          };
        }
        if (code === "code_stranger") {
          return {
            accessToken: "stranger_token",
            refreshToken: "stranger_refresh",
            user: {
              id: "user_stranger",
              email: "stranger@example.com",
              emailVerified: true,
            },
          };
        }
        if (code === "code_unverified") {
          return {
            accessToken: "unverified_token",
            refreshToken: "unverified_refresh",
            user: {
              id: "user_owner_unverified",
              email: "owner@example.com",
              emailVerified: false,
            },
          };
        }
        throw new Error("invalid_grant");
      },
      authenticateWithRefreshToken: async ({ refreshToken }): Promise<AuthKitSessionResult> => {
        if (refreshToken === "refresh_owner_ok") {
          return {
            accessToken: fakeUserManagementSessionToken,
            refreshToken: "refresh_owner_rotated",
            user: {
              id: "user_owner_allowed",
              email: "owner@example.com",
              emailVerified: true,
            },
          };
        }
        if (refreshToken === "refresh_stranger") {
          return {
            accessToken: "stranger_token",
            refreshToken: "stranger_refresh_2",
            user: {
              id: "user_stranger",
              email: "stranger@example.com",
              emailVerified: true,
            },
          };
        }
        throw new Error("invalid_grant");
      },
    },
    service: createMockAirQualityService(),
    dashboardService: mockDashboard.service,
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function mintJwt(sub: string): Promise<string> {
    return new SignJWT({ scope: "openid email" })
      .setProtectedHeader({ alg: "RS256", kid: "test-api-key-1" })
      .setIssuer(fakeAuthKitDomain)
      .setAudience(fakeClientId)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  try {
    // 1. Public OAuth discovery config (non-secret)
    const authCfgRes = await apiRequest(baseUrl, "GET", "/api/auth/config");
    assert.equal(authCfgRes.status, 200);
    assert.equal(authCfgRes.body.oauth_configured, true);
    assert.equal(authCfgRes.body.client_id, fakeClientId);
    assert.equal(authCfgRes.body.authkit_domain, fakeAuthKitDomain);
    assert.equal("workos_api_key" in authCfgRes.body, false);
    console.log("[PASS] 1. GET /api/auth/config returns public OAuth metadata without secrets");

    // 2. AuthKit PKCE code exchange + allowlist checks
    const exOwner = await apiRequest(baseUrl, "POST", "/api/auth/exchange", {
      body: { code: "code_owner_ok", code_verifier: "test_verifier_123" },
    });
    assert.equal(exOwner.status, 200);
    assert.equal(exOwner.body.access_token, fakeUserManagementSessionToken);
    assert.equal(exOwner.body.refresh_token, "refresh_owner_ok");

    const exStranger = await apiRequest(baseUrl, "POST", "/api/auth/exchange", {
      body: { code: "code_stranger" },
    });
    assert.equal(exStranger.status, 403);

    const exUnverified = await apiRequest(baseUrl, "POST", "/api/auth/exchange", {
      body: { code: "code_unverified" },
    });
    assert.equal(exUnverified.status, 403);

    const exBad = await apiRequest(baseUrl, "POST", "/api/auth/exchange", {
      body: { code: "expired_code" },
    });
    assert.equal(exBad.status, 401);

    const exInvalidBody = await apiRequest(baseUrl, "POST", "/api/auth/exchange", {
      body: {},
    });
    assert.equal(exInvalidBody.status, 400);

    const refOwner = await apiRequest(baseUrl, "POST", "/api/auth/refresh", {
      body: { refresh_token: "refresh_owner_ok" },
    });
    assert.equal(refOwner.status, 200);
    assert.equal(refOwner.body.refresh_token, "refresh_owner_rotated");

    const refStranger = await apiRequest(baseUrl, "POST", "/api/auth/refresh", {
      body: { refresh_token: "refresh_stranger" },
    });
    assert.equal(refStranger.status, 403);
    console.log("[PASS] 2. POST /api/auth/exchange & /refresh enforce allowlist (200/400/401/403)");

    // 3. Protected endpoint auth rejections (401 / 403)
    const noAuth = await apiRequest(baseUrl, "GET", "/api/dashboard/overview");
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers.get("www-authenticate")?.includes("Bearer"));

    const badToken = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: "not-a-valid-token",
    });
    assert.equal(badToken.status, 401);

    const strangerJwt = await mintJwt("user_stranger");
    const strangerRes = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: strangerJwt,
    });
    assert.equal(strangerRes.status, 403);

    const unverifiedJwt = await mintJwt("user_owner_unverified");
    const unverifiedRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: unverifiedJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 300,
        temperature_offset_c: 4.5,
        altitude_m: 100,
        led_enabled: false,
      },
    });
    assert.equal(unverifiedRes.status, 403);
    console.log("[PASS] 3. Unauthenticated (401) & non-allowlisted/unverified (403) requests rejected");

    // 4. Authenticated GET /api/me via Connect JWT, UserManagement session token, & Bearer fallback
    const ownerJwt = await mintJwt("user_owner_allowed");
    const meJwt = await apiRequest(baseUrl, "GET", "/api/me", { token: ownerJwt });
    assert.equal(meJwt.status, 200);
    assert.equal(meJwt.body.email, "owner@example.com");

    const meUm = await apiRequest(baseUrl, "GET", "/api/me", {
      token: fakeUserManagementSessionToken,
    });
    assert.equal(meUm.status, 200);
    assert.equal(meUm.body.email, "owner@example.com");

    const meFallback = await apiRequest(baseUrl, "GET", "/api/me", {
      token: testFallbackToken,
    });
    assert.equal(meFallback.status, 200);
    assert.equal(meFallback.body.auth_method, "bearer_fallback");
    console.log("[PASS] 4. GET /api/me accepts WorkOS Connect JWT, UserManagement token, and Bearer fallback");

    // 5. GET /api/dashboard/overview & GET /api/readings/history
    const overview = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: fakeUserManagementSessionToken,
    });
    assert.equal(overview.status, 200);
    const devices = overview.body.devices as Array<Record<string, unknown>>;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].config_sync_status, "synced");
    assert.ok(devices[0].health_context);

    const history = await apiRequest(
      baseUrl,
      "GET",
      "/api/readings/history?hours=24&device_id=feather-s3-01",
      { token: fakeUserManagementSessionToken }
    );
    assert.equal(history.status, 200);
    assert.ok(history.body.history);
    assert.ok(history.body.summary);
    assert.equal(mockDashboard.counts.getReadingsHistoryWithSummary, 1);
    assert.equal(mockDashboard.counts.getAirQualitySummary, 0);

    const historyMismatchedPeriod = await apiRequest(
      baseUrl,
      "GET",
      "/api/readings/history?hours=24&period=7d&device_id=feather-s3-01",
      { token: fakeUserManagementSessionToken }
    );
    assert.equal(historyMismatchedPeriod.status, 200);
    assert.equal(mockDashboard.counts.getAirQualitySummary, 1);
    assert.equal(
      (historyMismatchedPeriod.body.summary as Record<string, unknown>).period,
      "7d"
    );

    const badHistory = await apiRequest(baseUrl, "GET", "/api/readings/history?hours=999", {
      token: fakeUserManagementSessionToken,
    });
    assert.equal(badHistory.status, 400);
    console.log("[PASS] 5. GET /api/dashboard/overview & /api/readings/history return telemetry + sync state");

    // 6. Strict Zod validation on PUT /api/devices/:deviceId/config
    const badOffset = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 300,
        temperature_offset_c: 25.0, // > 20 max
        altitude_m: 0,
        led_enabled: false,
      },
    });
    assert.equal(badOffset.status, 400);
    assert.equal(badOffset.body.error, "validation_error");

    const extraField = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 300,
        temperature_offset_c: 5.5,
        altitude_m: 150,
        led_enabled: false,
        sneaky_extra: "nope",
      },
    });
    assert.equal(extraField.status, 400);

    const validUpdate = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 120,
        temperature_offset_c: 5.5,
        altitude_m: 150,
        led_enabled: false,
      },
    });
    assert.equal(validUpdate.status, 200);
    const savedCfg = validUpdate.body.config as Record<string, unknown>;
    assert.equal(savedCfg.config_version, 2);
    assert.equal(savedCfg.location, "master-bedroom");
    assert.equal(savedCfg.reporting_interval_seconds, 120);
    assert.equal(savedCfg.temperature_offset_c, 5.5);
    assert.equal(savedCfg.altitude_m, 150);
    assert.equal(savedCfg.led_enabled, false);
    assert.equal(savedCfg.updated_by, "owner@example.com");
    assert.equal(savedCfg.floor, null);

    const badFloor = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 120,
        temperature_offset_c: 5.5,
        altitude_m: 150,
        led_enabled: false,
        floor: "not a slug",
      },
    });
    assert.equal(badFloor.status, 400);

    const withFloor = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 120,
        temperature_offset_c: 5.5,
        altitude_m: 150,
        led_enabled: false,
        floor: "upstairs",
      },
    });
    assert.equal(withFloor.status, 200);
    assert.equal((withFloor.body.config as Record<string, unknown>).floor, "upstairs");
    assert.equal((withFloor.body.config as Record<string, unknown>).config_version, 3);

    const preservedFloor = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/config", {
      token: ownerJwt,
      body: {
        location: "master-bedroom",
        reporting_interval_seconds: 120,
        temperature_offset_c: 5.5,
        altitude_m: 150,
        led_enabled: false,
      },
    });
    assert.equal(preservedFloor.status, 200);
    assert.equal((preservedFloor.body.config as Record<string, unknown>).floor, "upstairs");

    // Overview should now mark sync status as "pending" because device still reports v1
    const overviewAfter = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: ownerJwt,
    });
    const devicesAfter = overviewAfter.body.devices as Array<Record<string, unknown>>;
    assert.equal(devicesAfter[0].config_sync_status, "pending");
    console.log("[PASS] 6. PUT /api/devices/:deviceId/config validates via Zod, increments config_version, and flips sync to pending");

    // 6b. Malformed percent-encoded deviceId returns 400 validation_error (not 500)
    const malformedDeviceRes = await apiRequest(
      baseUrl,
      "GET",
      "/api/devices/%E0%A4%A/config",
      { token: ownerJwt }
    );
    assert.equal(malformedDeviceRes.status, 400);
    assert.equal(malformedDeviceRes.body.error, "validation_error");

    // 7. One-shot remote reboot endpoint
    const rebootRes = await apiRequest(baseUrl, "POST", "/api/devices/feather-s3-01/reboot", {
      token: ownerJwt,
    });
    assert.equal(rebootRes.status, 200);
    assert.equal(rebootRes.body.reboot_requested, true);
    const rebootCfg = rebootRes.body.config as Record<string, unknown>;
    assert.equal(rebootCfg.config_version, 5);
    assert.equal(rebootCfg.floor, "upstairs");
    assert.equal(typeof rebootCfg.reboot_requested_at, "string");
    assert.equal(rebootCfg.temperature_offset_c, 5.5); // preserved!
    console.log("[PASS] 7. POST /api/devices/:deviceId/reboot stamps reboot_requested_at & increments config_version");

    // 8. GET /api/firmware/releases
    const releasesRes = await apiRequest(baseUrl, "GET", "/api/firmware/releases", {
      token: ownerJwt,
    });
    assert.equal(releasesRes.status, 200);
    assert.equal(releasesRes.body.count, 2);
    const releaseItems = releasesRes.body.releases as Array<Record<string, unknown>>;
    assert.equal(releaseItems[0].version, "1.3.2");
    assert.equal(releaseItems[1].status, "yanked");
    console.log("[PASS] 8. GET /api/firmware/releases returns published manifests newest-first");

    // 9. PUT /api/devices/:deviceId/firmware (per-device promotion, guards, and clear)
    const badVerRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/firmware", {
      token: ownerJwt,
      body: { target_firmware_version: "not-a-semver" },
    });
    assert.equal(badVerRes.status, 400);

    const missingRelRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/firmware", {
      token: ownerJwt,
      body: { target_firmware_version: "9.9.9" },
    });
    assert.equal(missingRelRes.status, 404);

    const yankedRelRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/firmware", {
      token: ownerJwt,
      body: { target_firmware_version: "1.3.1-yanked" },
    });
    assert.equal(yankedRelRes.status, 409);

    const promoteOneRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/firmware", {
      token: ownerJwt,
      body: { target_firmware_version: "1.3.2" },
    });
    assert.equal(promoteOneRes.status, 200);
    assert.equal(promoteOneRes.body.target_firmware_version, "1.3.2");
    const promotedCfg = promoteOneRes.body.config as Record<string, unknown>;
    assert.equal(promotedCfg.target_firmware_version, "1.3.2");
    assert.equal(promotedCfg.config_version, 6);
    assert.equal(promotedCfg.floor, "upstairs");
    assert.equal(promotedCfg.temperature_offset_c, 5.5); // preserved!

    const overviewPendingOta = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: ownerJwt,
    });
    const devicesPendingOta = overviewPendingOta.body.devices as Array<Record<string, unknown>>;
    assert.equal(devicesPendingOta[0].ota_rollout_status, "pending");

    const clearOneRes = await apiRequest(baseUrl, "PUT", "/api/devices/feather-s3-01/firmware", {
      token: ownerJwt,
      body: { target_firmware_version: null },
    });
    assert.equal(clearOneRes.status, 200);
    assert.equal(clearOneRes.body.target_firmware_version, null);
    console.log("[PASS] 9. PUT /api/devices/:deviceId/firmware validates SemVer/yanked/404, promotes, and clears target");

    // 10. POST /api/firmware/rollout (fleet-wide promotion + yanked rejection)
    const yankedFleetRes = await apiRequest(baseUrl, "POST", "/api/firmware/rollout", {
      token: ownerJwt,
      body: { target_firmware_version: "1.3.1-yanked" },
    });
    assert.equal(yankedFleetRes.status, 409);

    const fleetRes = await apiRequest(baseUrl, "POST", "/api/firmware/rollout", {
      token: ownerJwt,
      body: { target_firmware_version: "1.3.2" },
    });
    assert.equal(fleetRes.status, 200);
    assert.equal(fleetRes.body.updated, true);
    assert.equal(fleetRes.body.updated_count, 1);
    assert.equal(fleetRes.body.target_firmware_version, "1.3.2");
    console.log("[PASS] 10. POST /api/firmware/rollout promotes active release across fleet and rejects yanked builds");

    // 11. /api/* CORS restricts cross-origins to explicit allowlist + localhost + same-origin
    const localCorsRes = await fetch(`${baseUrl}/api/auth/config`, {
      headers: { Origin: "http://localhost:5000" },
    });
    assert.equal(localCorsRes.status, 200);
    assert.equal(localCorsRes.headers.get("access-control-allow-origin"), "http://localhost:5000");

    const allowedCorsRes = await fetch(`${baseUrl}/api/dashboard/overview`, {
      method: "OPTIONS",
      headers: { Origin: "https://dashboard.example.web.app" },
    });
    assert.equal(allowedCorsRes.status, 204);
    assert.equal(
      allowedCorsRes.headers.get("access-control-allow-origin"),
      "https://dashboard.example.web.app"
    );

    const untrustedCorsRes = await fetch(`${baseUrl}/api/auth/config`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(untrustedCorsRes.status, 200);
    assert.equal(untrustedCorsRes.headers.get("access-control-allow-origin"), null);
    assert.equal(untrustedCorsRes.headers.get("vary"), "Origin");
    console.log("[PASS] 11. /api/* CORS allows localhost & allowlisted origins and omits untrusted origins");

    // 12. Server-side TTL cache hits, ?refresh=1 bypass, Cache-Control, and write invalidation
    const overviewHit1 = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: ownerJwt,
    });
    assert.equal(overviewHit1.status, 200);
    assert.equal(overviewHit1.headers.get("cache-control"), "private, no-store");
    const statusCallsAfterWarm = mockDashboard.counts.getSensorStatus;

    const overviewHit2 = await apiRequest(baseUrl, "GET", "/api/dashboard/overview", {
      token: ownerJwt,
    });
    assert.equal(overviewHit2.status, 200);
    assert.equal(
      mockDashboard.counts.getSensorStatus,
      statusCallsAfterWarm,
      "Expected warm overview GET to hit cache"
    );

    const overviewBypass = await apiRequest(baseUrl, "GET", "/api/dashboard/overview?refresh=1", {
      token: ownerJwt,
    });
    assert.equal(overviewBypass.status, 200);
    assert.equal(
      mockDashboard.counts.getSensorStatus,
      statusCallsAfterWarm + 1,
      "Expected ?refresh=1 to bypass overview cache"
    );

    const histCallsBefore = mockDashboard.counts.getReadingsHistoryWithSummary;
    await apiRequest(baseUrl, "GET", "/api/readings/history?hours=24&device_id=feather-s3-01", {
      token: ownerJwt,
    });
    assert.equal(mockDashboard.counts.getReadingsHistoryWithSummary, histCallsBefore);
    await apiRequest(
      baseUrl,
      "GET",
      "/api/readings/history?hours=24&device_id=feather-s3-01&refresh=1",
      { token: ownerJwt }
    );
    assert.equal(mockDashboard.counts.getReadingsHistoryWithSummary, histCallsBefore + 1);

    const relCallsBefore = mockDashboard.counts.listFirmwareReleases;
    await apiRequest(baseUrl, "GET", "/api/firmware/releases", { token: ownerJwt });
    assert.equal(mockDashboard.counts.listFirmwareReleases, relCallsBefore);

    // Outdoor refresh invalidates both overview and history caches
    const outdoorRefreshRes = await apiRequest(baseUrl, "POST", "/api/outdoor/refresh", {
      token: ownerJwt,
    });
    assert.equal(outdoorRefreshRes.status, 200);

    const statusCallsAfterInvalidate = mockDashboard.counts.getSensorStatus;
    const histCallsAfterInvalidate = mockDashboard.counts.getReadingsHistoryWithSummary;
    await apiRequest(baseUrl, "GET", "/api/dashboard/overview", { token: ownerJwt });
    await apiRequest(baseUrl, "GET", "/api/readings/history?hours=24&device_id=feather-s3-01", {
      token: ownerJwt,
    });
    assert.equal(mockDashboard.counts.getSensorStatus, statusCallsAfterInvalidate + 1);
    assert.equal(
      mockDashboard.counts.getReadingsHistoryWithSummary,
      histCallsAfterInvalidate + 1
    );
    console.log(
      "[PASS] 12. Server-side TTL cache serves warm hits, honors ?refresh=1, sets Cache-Control, and invalidates on writes"
    );

    // 13. Malformed req.url returns 400 invalid_request JSON instead of unhandled rejection
    const badUrlBearer = "bad-url-test-bearer";
    const badReq = new EventEmitter() as IncomingMessage & { path?: string };
    badReq.method = "GET";
    badReq.url = "http://[::1";
    badReq.path = "/api/dashboard/overview";
    badReq.headers = { authorization: `Bearer ${badUrlBearer}` };
    let badResStatus = 200;
    let badResBody = "";
    const badRes = new EventEmitter() as unknown as ServerResponse;
    Object.defineProperty(badRes, "statusCode", {
      get: () => badResStatus,
      set: (v: number) => {
        badResStatus = v;
      },
    });
    badRes.hasHeader = () => false;
    badRes.setHeader = (() => badRes) as ServerResponse["setHeader"];
    badRes.end = ((chunk?: unknown) => {
      badResBody = typeof chunk === "string" ? chunk : "";
      return badRes;
    }) as ServerResponse["end"];

    await handleDashboardApiRequest(badReq, badRes, {
      pathname: "/api/dashboard/overview",
      origin: baseUrl,
      authConfig: { bearerFallbackSecret: badUrlBearer },
      dashboardService: mockDashboard.service,
    });
    assert.equal(badResStatus, 400);
    assert.equal((JSON.parse(badResBody) as { error?: string }).error, "invalid_request");
    console.log("[PASS] 13. Malformed req.url returns 400 invalid_request JSON envelope");

    // 14. Experiments & House Playbook routes (auth, Zod validation, PATCH CORS, caching & invalidation)
    const unauthExpGet = await apiRequest(baseUrl, "GET", "/api/experiments");
    assert.equal(unauthExpGet.status, 401);
    const unauthExpPost = await apiRequest(baseUrl, "POST", "/api/experiments", {
      body: { action_type: "crack_window", device_id: "feather-s3-01" },
    });
    assert.equal(unauthExpPost.status, 401);
    const unauthPlaybook = await apiRequest(baseUrl, "GET", "/api/playbook");
    assert.equal(unauthPlaybook.status, 401);

    const corsPatchRes = await fetch(`${baseUrl}/api/experiments/exp_1`, {
      method: "OPTIONS",
      headers: { Origin: "https://dashboard.example.web.app" },
    });
    assert.equal(corsPatchRes.status, 204);
    assert.match(
      corsPatchRes.headers.get("access-control-allow-methods") ?? "",
      /\bPATCH\b/
    );

    const badExpUnknown = await apiRequest(baseUrl, "POST", "/api/experiments", {
      token: ownerJwt,
      body: { action_type: "crack_window", device_id: "feather-s3-01", unexpected: true },
    });
    assert.equal(badExpUnknown.status, 400);

    const badExpAction = await apiRequest(baseUrl, "POST", "/api/experiments", {
      token: ownerJwt,
      body: { action_type: "launch_rockets", device_id: "feather-s3-01" },
    });
    assert.equal(badExpAction.status, 400);

    const badExpOrder = await apiRequest(baseUrl, "POST", "/api/experiments", {
      token: ownerJwt,
      body: {
        action_type: "crack_window",
        device_id: "feather-s3-01",
        started_at: "2026-11-27T12:00:00.000Z",
        ended_at: "2026-11-27T11:50:00.000Z",
      },
    });
    assert.equal(badExpOrder.status, 400);

    const createActiveRes = await apiRequest(baseUrl, "POST", "/api/experiments", {
      token: ownerJwt,
      body: {
        action_type: "crack_window",
        device_id: "feather-s3-01",
        started_at: "2026-11-27T15:00:00.000Z",
        notes: "Window open 2 inches",
      },
    });
    assert.equal(createActiveRes.status, 201);
    const createdExp = createActiveRes.body.experiment as ExperimentRecord;
    assert.equal(createdExp.status, "active");
    assert.equal(createdExp.source, "dashboard");
    assert.equal(createdExp.created_by, "owner@example.com");

    // GET /api/experiments list, warm cache hit, and ?refresh=1 bypass
    const listBefore = mockDashboard.counts.listExperiments;
    const listRes1 = await apiRequest(
      baseUrl,
      "GET",
      "/api/experiments?status=active&device_id=feather-s3-01",
      { token: ownerJwt }
    );
    assert.equal(listRes1.status, 200);
    assert.equal(listRes1.body.count, 1);
    assert.equal(mockDashboard.counts.listExperiments, listBefore + 1);

    const listRes2 = await apiRequest(
      baseUrl,
      "GET",
      "/api/experiments?status=active&device_id=feather-s3-01",
      { token: ownerJwt }
    );
    assert.equal(listRes2.status, 200);
    assert.equal(mockDashboard.counts.listExperiments, listBefore + 1);

    await apiRequest(
      baseUrl,
      "GET",
      "/api/experiments?status=active&device_id=feather-s3-01&refresh=1",
      { token: ownerJwt }
    );
    assert.equal(mockDashboard.counts.listExperiments, listBefore + 2);

    // GET /api/experiments/:id + 404 + malformed percent-encoding 400
    const getOneRes = await apiRequest(
      baseUrl,
      "GET",
      `/api/experiments/${createdExp.id}`,
      { token: ownerJwt }
    );
    assert.equal(getOneRes.status, 200);
    assert.equal((getOneRes.body.experiment as ExperimentRecord).id, createdExp.id);

    const getMissingRes = await apiRequest(
      baseUrl,
      "GET",
      "/api/experiments/exp_does_not_exist",
      { token: ownerJwt }
    );
    assert.equal(getMissingRes.status, 404);

    const badEncodedExp = await apiRequest(
      baseUrl,
      "GET",
      "/api/experiments/%E0%A4%A",
      { token: ownerJwt }
    );
    assert.equal(badEncodedExp.status, 400);

    // Evaluate while active -> 400
    const evalActiveRes = await apiRequest(
      baseUrl,
      "POST",
      `/api/experiments/${createdExp.id}/evaluate`,
      { token: ownerJwt }
    );
    assert.equal(evalActiveRes.status, 400);

    // PATCH validation errors & finishing active experiment
    const patchEmptyRes = await apiRequest(
      baseUrl,
      "PATCH",
      `/api/experiments/${createdExp.id}`,
      { token: ownerJwt, body: {} }
    );
    assert.equal(patchEmptyRes.status, 400);

    const patchMissingRes = await apiRequest(
      baseUrl,
      "PATCH",
      "/api/experiments/exp_missing",
      { token: ownerJwt, body: { notes: "hello" } }
    );
    assert.equal(patchMissingRes.status, 404);

    const patchFinishRes = await apiRequest(
      baseUrl,
      "PATCH",
      `/api/experiments/${createdExp.id}`,
      {
        token: ownerJwt,
        body: { ended_at: "2026-11-27T15:10:00.000Z" },
      }
    );
    assert.equal(patchFinishRes.status, 200);
    assert.equal(
      (patchFinishRes.body.experiment as ExperimentRecord).status,
      "pending_evaluation"
    );

    // Warm playbook before evaluation (cached), then evaluate -> invalidates playbook cache
    const badPlaybookTier = await apiRequest(
      baseUrl,
      "GET",
      "/api/playbook?energy_tax_tier=extreme",
      { token: ownerJwt }
    );
    assert.equal(badPlaybookTier.status, 400);

    const pbCallsBefore = mockDashboard.counts.getHousePlaybook;
    const pbEmpty1 = await apiRequest(
      baseUrl,
      "GET",
      "/api/playbook?location=home-office&energy_tax_tier=free&primary_goal=lower_co2",
      { token: ownerJwt }
    );
    assert.equal(pbEmpty1.status, 200);
    assert.equal(
      (pbEmpty1.body.playbook as { evaluated_experiment_count: number }).evaluated_experiment_count,
      0
    );
    assert.equal(mockDashboard.counts.getHousePlaybook, pbCallsBefore + 1);

    await apiRequest(
      baseUrl,
      "GET",
      "/api/playbook?location=home-office&energy_tax_tier=free&primary_goal=lower_co2",
      { token: ownerJwt }
    );
    assert.equal(mockDashboard.counts.getHousePlaybook, pbCallsBefore + 1);

    // Evaluate finished experiment -> 200 and invalidates playbook + experiments caches
    const evalDoneRes = await apiRequest(
      baseUrl,
      "POST",
      `/api/experiments/${createdExp.id}/evaluate`,
      { token: ownerJwt, body: { force: true } }
    );
    assert.equal(evalDoneRes.status, 200);
    assert.equal(evalDoneRes.body.evaluated, true);
    assert.equal((evalDoneRes.body.experiment as ExperimentRecord).status, "evaluated");

    const pbAfterEval = await apiRequest(
      baseUrl,
      "GET",
      "/api/playbook?location=home-office&energy_tax_tier=free&primary_goal=lower_co2",
      { token: ownerJwt }
    );
    assert.equal(pbAfterEval.status, 200);
    assert.equal(mockDashboard.counts.getHousePlaybook, pbCallsBefore + 2);
    assert.equal(
      (pbAfterEval.body.playbook as { evaluated_experiment_count: number }).evaluated_experiment_count,
      1
    );
    assert.equal((pbAfterEval.body.recommendations as unknown[]).length, 1);

    console.log(
      "[PASS] 14. /api/experiments & /api/playbook enforce auth, Zod schemas, PATCH CORS, caching, and invalidation"
    );

    console.log("\nAll Dashboard API & WorkOS Auth verification checks passed!");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
