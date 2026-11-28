#!/usr/bin/env node
/**
 * Offline verification suite for the Step 15 lightweight web dashboard (`web/`)
 * and Firebase Hosting configuration (`firebase.json`).
 *
 * Usage:
 *   node scripts/verify_web_dashboard.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiError,
  buildExperimentsPath,
  buildPlaybookPath,
  buildReadingsHistoryPath,
  fetchDashboardOverview,
  fetchOutdoorForecast,
} from "../web/api.js";
import {
  buildAuthorizeUrl,
  clearSession,
  computeCodeChallenge,
  handleAuthCallbackIfPresent,
  loadSession,
  refreshSessionDetailed,
  saveSession,
  toBase64Url,
} from "../web/auth.js";
import {
  buildSeriesSegments,
  computeNiceDomain,
  findNearestPointIndex,
  toFiniteNumberOrNaN,
} from "../web/charts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let passed = 0;

async function runCheck(name, fn) {
  await fn();
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

console.log("Running Step 15 Web Dashboard & Firebase Hosting verification...\n");

await runCheck("PKCE S256 matches RFC 7636 Appendix B reference vector", async () => {
  // RFC 7636 Appendix B test vector:
  // verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // expected S256 challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await computeCodeChallenge(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(toBase64Url(new Uint8Array([251, 255, 191])), "-_-_");
});

await runCheck("WorkOS AuthKit authorize URL includes PKCE S256 + provider=authkit", () => {
  const urlStr = buildAuthorizeUrl({
    authorizeEndpoint: "https://api.workos.com/user_management/authorize",
    clientId: "client_example_123",
    redirectUri: "https://example.web.app/auth/callback",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    state: "csrf-state-xyz",
  });
  const parsed = new URL(urlStr);
  assert.equal(parsed.origin, "https://api.workos.com");
  assert.equal(parsed.pathname, "/user_management/authorize");
  assert.equal(parsed.searchParams.get("client_id"), "client_example_123");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://example.web.app/auth/callback");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("provider"), "authkit");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("state"), "csrf-state-xyz");
});

await runCheck("Chart domain calculation handles flat, sparse, and bounded ranges", () => {
  const co2Domain = computeNiceDomain([520, 680, 1050], {
    minFloor: 350,
    suggestedMin: 400,
    suggestedMax: 1100,
  });
  assert.ok(co2Domain.min >= 350 && co2Domain.min <= 400);
  assert.ok(co2Domain.max >= 1100);
  assert.ok(co2Domain.ticks.length >= 3);

  const flatDomain = computeNiceDomain([4.2, 4.2, 4.2], { minFloor: 0 });
  assert.ok(flatDomain.min >= 0);
  assert.ok(flatDomain.max > flatDomain.min);
});

await runCheck("Chart segment builder splits series across offline gaps", () => {
  const points = [
    { timeMs: 0, value: 500 },
    { timeMs: 5 * 60_000, value: 510 },
    { timeMs: 90 * 60_000, value: 600 }, // 85 min gap > 45 min threshold
    { timeMs: 95 * 60_000, value: 610 },
  ];
  const segments = buildSeriesSegments(points, 45 * 60_000);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 2);
  assert.equal(segments[1].length, 2);
});

await runCheck("Chart hover nearest-point binary search locates closest sample", () => {
  const points = [
    { timeMs: 1000 },
    { timeMs: 2000 },
    { timeMs: 4000 },
    { timeMs: 9000 },
  ];
  assert.equal(findNearestPointIndex(points, 500), 0);
  assert.equal(findNearestPointIndex(points, 1400), 0);
  assert.equal(findNearestPointIndex(points, 1600), 1);
  assert.equal(findNearestPointIndex(points, 3800), 2);
  assert.equal(findNearestPointIndex(points, 12000), 3);
});

await runCheck("index.html meets modern web guidance semantics and accessibility checks", () => {
  const html = fs.readFileSync(path.join(repoRoot, "web/index.html"), "utf8");
  assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark">/);
  assert.match(html, /<dialog\s+id="settings-dialog"[^>]*closedby="any"/);
  assert.match(html, /<dialog\s+id="site-dialog"[^>]*closedby="any"/);
  assert.match(html, /<dialog\s+id="rollout-dialog"/);
  assert.match(html, /id="outdoor-card-slot"/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal=/);
  assert.match(html, /<input[^>]*id="cfg-led-enabled"[^>]*type="checkbox"[^>]*switch/s);
  assert.match(html, /<button[^>]*value="cancel"[^>]*autofocus/);
  // Step 19 tabs & responsive table checks
  assert.match(html, /focusgroup="tablist nomemory"/);
  assert.match(html, /id="tab-overview"[^>]*aria-selected="true"[^>]*focusgroupstart/s);
  assert.match(html, /id="panel-fleet"[^>]*role="tabpanel"[^>]*hidden="until-found"/s);
  assert.doesNotMatch(html, /aria-controls=/);
  assert.match(html, /tabindex="0"\s+role="region"\s+aria-labelledby="fleet-table-caption"/s);
  assert.match(html, /id="tab-experiments"[^>]*aria-selected="false"/s);
  assert.match(html, /id="panel-experiments"[^>]*role="tabpanel"[^>]*hidden="until-found"/s);
  assert.match(html, /data-experiment-preset="crack_window"/);
  assert.match(html, /Crack Window/);
  assert.match(html, /Cross-Ventilate/);
  assert.match(html, /Open Door/);
  assert.match(html, /HEPA Purifier/);
  assert.match(html, /Range Hood/);
  assert.match(html, /data-experiment-preset="custom"/);
  assert.match(html, /Log Past Action/);
  assert.match(html, /Unlabeled Events Detected/);
  assert.match(html, /Learned House Playbook/);
  assert.match(html, /class="fleet-table playbook-table"/);
  assert.match(html, /<dialog\s+id="past-log-dialog"[^>]*closedby="any"/);
});

await runCheck("firebase.json configures Hosting public=web and 2nd Gen API rewrites", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "firebase.json"), "utf8"));
  assert.equal(cfg.hosting?.public, "web");
  const rewrites = cfg.hosting?.rewrites ?? [];
  const apiIndex = rewrites.findIndex(
    (r) =>
      r.source === "/api/**" &&
      r.function?.functionId === "mcp" &&
      r.function?.region === "us-east1"
  );
  const spaIndex = rewrites.findIndex(
    (r) => r.source === "**" && r.destination === "/index.html"
  );
  assert.ok(apiIndex >= 0, "Expected /api/** rewrite to 2nd Gen mcp function in us-east1");
  assert.ok(spaIndex > apiIndex, "SPA catch-all rewrite must come after /api/**");
});

await runCheck("api.js builds /api/readings/history paths with optional refresh=1 bypass", () => {
  const normal = buildReadingsHistoryPath({
    hours: 24,
    limit: 200,
    period: "24h",
    deviceId: "feather-s3-01",
  });
  assert.equal(
    normal,
    "/api/readings/history?hours=24&limit=200&period=24h&device_id=feather-s3-01"
  );
  const bypassed = buildReadingsHistoryPath({
    hours: 168,
    limit: 240,
    period: "7d",
    refresh: true,
  });
  assert.equal(
    bypassed,
    "/api/readings/history?hours=168&limit=240&period=7d&refresh=1"
  );
});

await runCheck("app.js implements 5m chartsCache, lazy Fleet loading, and targeted refreshes", () => {
  const appJs = fs.readFileSync(path.join(repoRoot, "web/app.js"), "utf8");
  assert.match(appJs, /CLIENT_CACHE_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(appJs, /chartsCache:\s*new Map\(\)/);
  assert.match(appJs, /async function loadFirmwareReleases\(/);
  assert.match(appJs, /async function refreshOverviewOnly\(/);
  assert.match(appJs, /state\.activeTab === "fleet"[\s\S]*loadFirmwareReleases\(\)/);
  assert.equal(typeof fetchOutdoorForecast, "function");
  assert.match(appJs, /function describeEnergyTax\(/);
  assert.match(appJs, /open_brief_purge/);
  assert.match(appJs, /forecast-strip/);
  assert.match(appJs, /async function loadExperimentsPanel\(/);
  assert.match(appJs, /state\.activeTab === "experiments"[\s\S]*loadExperimentsPanel\(\)/);
  assert.match(appJs, /data-experiment-preset/);
  assert.match(appJs, /data-experiment-stop/);
  assert.match(appJs, /status:\s*"dismissed"/);
  assert.match(appJs, /CLIENT_CACHE_TTL_MS/);
});

await runCheck("api.js builds experiment and playbook paths with refresh=1 bypass", () => {
  assert.equal(buildExperimentsPath(), "/api/experiments");
  assert.equal(
    buildExperimentsPath({ status: "active" }),
    "/api/experiments?status=active"
  );
  assert.equal(
    buildExperimentsPath({
      status: ["active", "unlabeled"],
      deviceId: "feather-s3-01",
      location: "home-office",
      actionType: "crack_window",
      limit: 50,
      refresh: true,
    }),
    "/api/experiments?status=active%2Cunlabeled&device_id=feather-s3-01&location=home-office&action_type=crack_window&limit=50&refresh=1"
  );
  assert.equal(buildPlaybookPath(), "/api/playbook");
  assert.equal(
    buildPlaybookPath({
      location: "home-office",
      energyTaxTier: "free",
      primaryGoal: "lower_co2",
      refresh: true,
    }),
    "/api/playbook?location=home-office&energy_tax_tier=free&primary_goal=lower_co2&refresh=1"
  );
});

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

await runCheck("toFiniteNumberOrNaN prevents null/undefined/blank from coercing to 0", () => {
  assert.ok(Number.isNaN(toFiniteNumberOrNaN(null)));
  assert.ok(Number.isNaN(toFiniteNumberOrNaN(undefined)));
  assert.ok(Number.isNaN(toFiniteNumberOrNaN("")));
  assert.ok(Number.isNaN(toFiniteNumberOrNaN("not-a-num")));
  assert.equal(toFiniteNumberOrNaN(0), 0);
  assert.equal(toFiniteNumberOrNaN(42.5), 42.5);
});

await runCheck("buildAuthorizeUrl rejects non-HTTPS or untrusted authorize endpoints", () => {
  assert.throws(
    () =>
      buildAuthorizeUrl({
        authorizeEndpoint: "http://api.workos.com/user_management/authorize",
        clientId: "client_123",
        redirectUri: "https://example.web.app/auth/callback",
        codeChallenge: "abc",
        state: "xyz",
      }),
    /Untrusted WorkOS authorize endpoint/
  );
  assert.throws(
    () =>
      buildAuthorizeUrl({
        authorizeEndpoint: "https://evil.example.com/authorize",
        clientId: "client_123",
        redirectUri: "https://example.web.app/auth/callback",
        codeChallenge: "abc",
        state: "xyz",
      }),
    /Untrusted WorkOS authorize endpoint/
  );
  const authkitUrl = buildAuthorizeUrl({
    authorizeEndpoint: "https://demo.authkit.app/oauth2/authorize",
    clientId: "client_123",
    redirectUri: "https://example.web.app/auth/callback",
    codeChallenge: "abc",
    state: "xyz",
  });
  assert.ok(authkitUrl.startsWith("https://demo.authkit.app/"));
});

await runCheck(
  "Auth callback ignores spoofed error_description without PKCE state, keeps bearer_fallback in sessionStorage, and preserves refreshToken on 503",
  async () => {
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origFetch = globalThis.fetch;

    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    let currentSearch = "?error=access_denied&error_description=Phishing+Message";
    let currentPathname = "/auth/callback";

    globalThis.document = { title: "Air Quality" };
    globalThis.window = {
      localStorage,
      sessionStorage,
      location: {
        origin: "https://example.web.app",
        get search() {
          return currentSearch;
        },
        get pathname() {
          return currentPathname;
        },
      },
      history: {
        replaceState: (_state, _title, nextUrl) => {
          currentPathname = nextUrl;
          currentSearch = "";
        },
      },
    };

    try {
      // 1. Spoofed error_description without matching PKCE state must return static message
      const spoofed = await handleAuthCallbackIfPresent();
      assert.equal(spoofed.handled, true);
      assert.equal(spoofed.ok, false);
      assert.equal(spoofed.error.includes("Phishing"), false);

      // 2. Network error during /api/auth/exchange is caught cleanly without rejecting
      currentSearch = "?code=abc&state=expected-state";
      currentPathname = "/auth/callback";
      sessionStorage.setItem(
        "iaq_dashboard_pkce_v1",
        JSON.stringify({ state: "expected-state", codeVerifier: "ver", createdAt: Date.now() })
      );
      globalThis.fetch = async () => {
        throw new Error("Offline");
      };
      const netErr = await handleAuthCallbackIfPresent();
      assert.equal(netErr.handled, true);
      assert.equal(netErr.ok, false);
      assert.match(netErr.error, /Network error/);

      // 3. bearer_fallback is stored in sessionStorage (not localStorage)
      saveSession({ accessToken: "bearer-secret", authMethod: "bearer_fallback" });
      assert.equal(localStorage.getItem("iaq_dashboard_session_v1"), null);
      assert.ok(sessionStorage.getItem("iaq_dashboard_session_v1"));
      assert.equal(loadSession()?.accessToken, "bearer-secret");
      clearSession();
      assert.equal(loadSession(), null);

      // 4. Transient 503 during refresh preserves refreshToken in localStorage
      saveSession({
        accessToken: "expired-jwt",
        refreshToken: "valid-refresh-tok",
        authMethod: "workos_oauth",
      });
      globalThis.fetch = async (url) => {
        if (String(url) === "/api/auth/refresh") {
          return new Response(JSON.stringify({ error: "upstream" }), { status: 503 });
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      };
      await assert.rejects(
        () => fetchDashboardOverview(),
        (err) => err instanceof ApiError && err.status === 503 && err.code === "refresh_unavailable"
      );
      assert.equal(loadSession()?.refreshToken, "valid-refresh-tok");

      // 5. Terminal 401 on refresh clears session
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      const invalidRefresh = await refreshSessionDetailed();
      assert.equal(invalidRefresh.status, "invalid");
      assert.equal(loadSession(), null);
    } finally {
      globalThis.window = origWindow;
      globalThis.document = origDocument;
      globalThis.fetch = origFetch;
    }
  }
);

await runCheck("index.html, styles.css, and firebase.json enforce hardened form, container, and CSP rules", () => {
  const html = fs.readFileSync(path.join(repoRoot, "web/index.html"), "utf8");
  const css = fs.readFileSync(path.join(repoRoot, "web/styles.css"), "utf8");
  const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "firebase.json"), "utf8"));

  assert.match(html, /id="cfg-temp-offset"[\s\S]*?step="0\.01"/);
  assert.match(html, /id="site-label"[\s\S]*?pattern="\.\*\\S\.\*"/);
  assert.equal((html.match(/for="site-latitude"/g) ?? []).length, 1);

  const containerStart = css.indexOf("@container (width < 720px)");
  assert.ok(containerStart >= 0);
  const afterContainer = css.slice(containerStart);
  assert.equal(/\.table-wrapper\s*\{/.test(afterContainer), false);
  assert.match(css, /\.playbook-table\s*\{[^}]*--label-2:\s*"Room"/);

  const globalHeaders = cfg.hosting?.headers?.find((h) => h.source === "**")?.headers ?? [];
  const csp = globalHeaders.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  const perms = globalHeaders.find((h) => h.key === "Permissions-Policy")?.value ?? "";
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(perms, /geolocation=\(self\)/);
});

console.log(`\nAll ${passed} Step 15 offline checks passed!`);
