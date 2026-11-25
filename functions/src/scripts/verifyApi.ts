import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import type { DashboardDataService } from "../api/dashboard.js";
import type {
  AuthKitSessionResult,
  ResolvedWorkosUser,
  WorkosAuthConfig,
} from "../auth/workos.js";
import { createMcpHttpHandler } from "../index.js";
import type {
  DeviceConfig,
  DeviceStatus,
  FirmwareReleaseManifest,
} from "../services/firestore.js";
import { createMockAirQualityService } from "./localMcpServer.js";

function createMockDashboardService(): {
  service: DashboardDataService;
  counts: {
    getReadingsHistory: number;
    getAirQualitySummary: number;
    getReadingsHistoryWithSummary: number;
  };
} {
  const baseService = createMockAirQualityService();
  const counts = {
    getReadingsHistory: 0,
    getAirQualitySummary: 0,
    getReadingsHistoryWithSummary: 0,
  };

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
        updated_at: nowIso,
        updated_by: updatedBy,
      };
      configs.set(deviceId, next);
      return next;
    },
    listFirmwareReleases: async () =>
      Array.from(releases.values()).sort((a, b) => b.created_at.localeCompare(a.created_at)),
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
        updated_at: nowIso,
        updated_by: updatedBy,
      };
      configs.set(deviceId, next);
      return next;
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
    assert.equal(rebootCfg.config_version, 3);
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
    assert.equal(promotedCfg.config_version, 4);
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
