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

import { buildReadingsHistoryPath } from "../web/api.js";
import { buildAuthorizeUrl, computeCodeChallenge, toBase64Url } from "../web/auth.js";
import {
  buildSeriesSegments,
  computeNiceDomain,
  findNearestPointIndex,
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
});

console.log(`\nAll ${passed} Step 15 offline checks passed!`);
