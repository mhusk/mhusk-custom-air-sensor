import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isValidFirmwareVersion,
  isValidOtaFilename,
} from "../services/firestore.js";
import {
  buildReleaseBundle,
  extractAppFirmwareVersion,
  getDefaultRepoRoot,
  parsePublishArgs,
} from "./publishRelease.js";

interface SettingsToml {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_WEB_API_KEY?: string;
  FIREBASE_DEVICE_EMAIL?: string;
  FIREBASE_DEVICE_PASSWORD?: string;
  SENSOR_DEVICE_ID?: string;
}

function loadSimpleToml(filePath: string): SettingsToml {
  const raw = fs.readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function runOfflineUnitChecks(): void {
  console.log("1. Running offline OTA release manifest & publisher unit checks...");

  // SemVer validation (including prerelease tags)
  assert.equal(isValidFirmwareVersion("1.2.0"), true);
  assert.equal(isValidFirmwareVersion("1.2.0-rc1"), true);
  assert.equal(isValidFirmwareVersion("2.10.3-beta.1"), true);
  assert.equal(isValidFirmwareVersion("1.2"), false);
  assert.equal(isValidFirmwareVersion("v1.2.0"), false);
  assert.equal(isValidFirmwareVersion("../1.2.0"), false);
  assert.equal(isValidFirmwareVersion(""), false);
  console.log("   [PASS] isValidFirmwareVersion() accepts SemVer + prerelease & rejects malformed tags");

  // Filename allowlist & protected bootloader guards
  assert.equal(isValidOtaFilename("app.py"), true);
  assert.equal(isValidOtaFilename("aqi.py"), true);
  assert.equal(isValidOtaFilename("firestore_client.py"), true);
  assert.equal(isValidOtaFilename("ota_updater.py"), true);
  assert.equal(isValidOtaFilename("boot.py"), false);
  assert.equal(isValidOtaFilename("code.py"), false);
  assert.equal(isValidOtaFilename("settings.toml"), false);
  assert.equal(isValidOtaFilename("../app.py"), false);
  assert.equal(isValidOtaFilename("App.py"), false);
  console.log("   [PASS] isValidOtaFilename() allows OTA .py modules & blocks boot.py/code.py/traversal");

  // CLI argument parsing
  const parsed = parsePublishArgs([
    "--version",
    "1.2.0-rc1",
    "--notes",
    "Step 17 test release",
    "--min-bootloader",
    "1.0.0",
    "--allow-version-mismatch",
    "--dry-run",
    "--force",
    "--set-target",
    "feather-s3-01",
  ]);
  assert.equal(parsed.version, "1.2.0-rc1");
  assert.equal(parsed.notes, "Step 17 test release");
  assert.equal(parsed.minBootloaderVersion, "1.0.0");
  assert.equal(parsed.allowVersionMismatch, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.force, true);
  assert.equal(parsed.setTargetDeviceId, "feather-s3-01");
  console.log("   [PASS] parsePublishArgs() parses flags cleanly");

  // Build release bundle from real repo firmware/
  const firmwareDir = path.join(getDefaultRepoRoot(), "firmware");
  const appPyRaw = fs.readFileSync(path.join(firmwareDir, "app.py"), "utf8");
  const appVersion = extractAppFirmwareVersion(appPyRaw);
  assert.ok(appVersion && isValidFirmwareVersion(appVersion));

  const bundle = buildReleaseBundle({
    firmwareDir,
    notes: "Offline checksum verification test",
  });
  assert.equal(bundle.version, appVersion);
  assert.equal(bundle.file_count, bundle.artifacts.length);
  assert.ok(bundle.files["app.py"]);
  assert.ok(bundle.files["aqi.py"]);
  assert.ok(bundle.files["firestore_client.py"]);

  let expectedTotal = 0;
  for (const artifact of bundle.artifacts) {
    const diskBytes = fs.readFileSync(path.join(firmwareDir, artifact.filename));
    const expectedHash = crypto.createHash("sha256").update(diskBytes).digest("hex");
    assert.equal(artifact.sha256, expectedHash);
    assert.equal(artifact.size_bytes, diskBytes.length);
    assert.equal(bundle.files[artifact.filename].sha256, expectedHash);
    assert.equal(bundle.files[artifact.filename].size_bytes, diskBytes.length);
    assert.equal(
      crypto.createHash("sha256").update(Buffer.from(artifact.content, "utf8")).digest("hex"),
      expectedHash
    );
    expectedTotal += diskBytes.length;
  }
  assert.equal(bundle.total_size_bytes, expectedTotal);
  console.log(
    `   [PASS] buildReleaseBundle() hashed ${bundle.file_count} files (${bundle.total_size_bytes} B) for v${bundle.version}`
  );

  // Version mismatch guard
  assert.throws(
    () =>
      buildReleaseBundle({
        firmwareDir,
        version: "9.9.9-rc1",
      }),
    /does not match FIRMWARE_VERSION/
  );
  const rcBundle = buildReleaseBundle({
    firmwareDir,
    version: "1.2.0-rc1",
    allowVersionMismatch: true,
    notes: "Staged RC test",
  });
  assert.equal(rcBundle.version, "1.2.0-rc1");
  console.log("   [PASS] Version mismatch guard blocks accidental mismatch & permits --allow-version-mismatch");

  // Protected file guard
  assert.throws(
    () =>
      buildReleaseBundle({
        firmwareDir,
        files: ["app.py", "code.py"],
      }),
    /Refusing to package protected file 'code\.py'/
  );
  assert.throws(
    () =>
      buildReleaseBundle({
        firmwareDir,
        files: ["app.py", "boot.py"],
      }),
    /Refusing to package protected file 'boot\.py'/
  );
  console.log("   [PASS] Protected file guard blocks boot.py and code.py from OTA bundles");

  // Firestore security rules static structural check
  const rulesText = fs.readFileSync(path.join(getDefaultRepoRoot(), "firestore.rules"), "utf8");
  assert.match(rulesText, /function\s+authDeviceMatches\s*\(/);
  assert.match(rulesText, /function\s+canActAsDevice\s*\(/);
  assert.match(rulesText, /canActAsDevice\(request\.resource\.data\.device_id\)/);
  assert.match(rulesText, /canActAsDevice\(deviceId\)/);
  assert.match(rulesText, /!\(value in \['boot\.py', 'code\.py'\]\)/);
  console.log("   [PASS] firestore.rules enforces per-device UID isolation and blocks boot.py/code.py");
}

async function httpJson(
  method: string,
  url: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    rawBody = JSON.stringify(options.body);
  }
  const res = await fetch(url, { method, headers, body: rawBody });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function getFirestoreErrorStatus(body: Record<string, unknown>): string | undefined {
  const err = body.error as Record<string, unknown> | undefined;
  return typeof err?.status === "string" ? err.status : undefined;
}

async function signInSensorDevice(settings: SettingsToml): Promise<string> {
  const apiKey = settings.FIREBASE_WEB_API_KEY;
  const email = settings.FIREBASE_DEVICE_EMAIL;
  const password = settings.FIREBASE_DEVICE_PASSWORD;
  if (!apiKey || !email || !password) {
    throw new Error(
      "firmware/settings.toml must contain FIREBASE_WEB_API_KEY, FIREBASE_DEVICE_EMAIL, and FIREBASE_DEVICE_PASSWORD."
    );
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  const { status, body } = await httpJson("POST", url, {
    body: { email, password, returnSecureToken: true },
  });
  if (status !== 200 || typeof body.idToken !== "string") {
    throw new Error(`Firebase Auth sign-in failed (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function runLiveChecks(version: string): Promise<void> {
  console.log(`\n2. Running live Firestore REST security & SHA-256 checks for v${version}...`);

  if (!isValidFirmwareVersion(version)) {
    throw new Error(`Invalid --version '${version}'`);
  }

  const settingsPath = path.join(getDefaultRepoRoot(), "firmware", "settings.toml");
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`${settingsPath} not found.`);
  }
  const settings = loadSimpleToml(settingsPath);
  const projectId = settings.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID missing from firmware/settings.toml.");
  }

  const docsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const releaseUrl = `${docsBase}/firmware_releases/${encodeURIComponent(version)}`;
  const releasesListUrl = `${docsBase}/firmware_releases`;
  const filesListUrl = `${releaseUrl}/files`;
  const appFileUrl = `${filesListUrl}/app.py`;
  const bootFileUrl = `${filesListUrl}/boot.py`;

  // 1. Unauthenticated GET on manifest -> 403 PERMISSION_DENIED
  const unauthManifest = await httpJson("GET", releaseUrl);
  assert.equal(unauthManifest.status, 403);
  assert.equal(getFirestoreErrorStatus(unauthManifest.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 1. Unauthenticated GET firmware_releases/${version} -> 403 PERMISSION_DENIED`);

  // 2. Unauthenticated GET on artifact file -> 403 PERMISSION_DENIED
  const unauthFile = await httpJson("GET", appFileUrl);
  assert.equal(unauthFile.status, 403);
  assert.equal(getFirestoreErrorStatus(unauthFile.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 2. Unauthenticated GET firmware_releases/${version}/files/app.py -> 403 PERMISSION_DENIED`);

  // Sign in as allowlisted sensor device
  const idToken = await signInSensorDevice(settings);

  // 3. Sensor GET manifest -> 200 OK
  const sensorManifest = await httpJson("GET", releaseUrl, { token: idToken });
  assert.equal(
    sensorManifest.status,
    200,
    `Expected HTTP 200 for sensor GET manifest, got ${sensorManifest.status}: ${JSON.stringify(sensorManifest.body)}`
  );
  const fields = sensorManifest.body.fields as Record<string, Record<string, unknown>>;
  assert.equal(fields.version?.stringValue, version);
  const filesMap = (
    (fields.files?.mapValue as Record<string, unknown>)?.fields ?? {}
  ) as Record<string, Record<string, unknown>>;
  const fileNames = Object.keys(filesMap);
  assert.ok(fileNames.includes("app.py"), "Manifest files map must include app.py");
  console.log(
    `   [PASS] 3. Sensor-authenticated GET firmware_releases/${version} -> 200 OK (${fileNames.length} files)`
  );

  // 4. Sensor LIST firmware_releases -> 403 PERMISSION_DENIED
  const sensorListReleases = await httpJson("GET", releasesListUrl, { token: idToken });
  assert.equal(sensorListReleases.status, 403);
  assert.equal(getFirestoreErrorStatus(sensorListReleases.body), "PERMISSION_DENIED");
  console.log("   [PASS] 4. Sensor-authenticated LIST firmware_releases -> 403 PERMISSION_DENIED");

  // 5. Sensor LIST firmware_releases/{version}/files -> 403 PERMISSION_DENIED
  const sensorListFiles = await httpJson("GET", filesListUrl, { token: idToken });
  assert.equal(sensorListFiles.status, 403);
  assert.equal(getFirestoreErrorStatus(sensorListFiles.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 5. Sensor-authenticated LIST firmware_releases/${version}/files -> 403 PERMISSION_DENIED`);

  // 6. Sensor GET protected bootloader filename -> 403 PERMISSION_DENIED
  const sensorBootFile = await httpJson("GET", bootFileUrl, { token: idToken });
  assert.equal(sensorBootFile.status, 403);
  assert.equal(getFirestoreErrorStatus(sensorBootFile.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 6. Sensor-authenticated GET .../files/boot.py -> 403 PERMISSION_DENIED`);

  // 7. Sensor GET every artifact listed in manifest & verify SHA-256 + byte length
  for (const filename of fileNames) {
    const manifestEntry = (
      (filesMap[filename].mapValue as Record<string, unknown>)?.fields ?? {}
    ) as Record<string, Record<string, unknown>>;
    const expectedSha = String(manifestEntry.sha256?.stringValue ?? "");
    const expectedSize = Number(manifestEntry.size_bytes?.integerValue ?? -1);

    const fileRes = await httpJson("GET", `${filesListUrl}/${encodeURIComponent(filename)}`, {
      token: idToken,
    });
    assert.equal(
      fileRes.status,
      200,
      `Expected HTTP 200 for sensor GET .../files/${filename}, got ${fileRes.status}`
    );
    const fileFields = fileRes.body.fields as Record<string, Record<string, unknown>>;
    const content = String(fileFields.content?.stringValue ?? "");
    const contentBuf = Buffer.from(content, "utf8");
    const actualSha = crypto.createHash("sha256").update(contentBuf).digest("hex");

    assert.equal(actualSha, expectedSha, `SHA-256 mismatch on ${filename}`);
    assert.equal(contentBuf.length, expectedSize, `Byte size mismatch on ${filename}`);
    assert.equal(String(fileFields.sha256?.stringValue ?? ""), expectedSha);
    assert.equal(Number(fileFields.size_bytes?.integerValue ?? -1), expectedSize);
  }
  console.log(
    `   [PASS] 7. Sensor fetched all ${fileNames.length} artifacts & verified exact SHA-256 + byte sizes`
  );

  // 8. Sensor PATCH manifest -> 403 PERMISSION_DENIED
  const sensorPatchManifest = await httpJson(
    "PATCH",
    `${releaseUrl}?updateMask.fieldPaths=notes`,
    {
      token: idToken,
      body: { fields: { notes: { stringValue: "tampered" } } },
    }
  );
  assert.equal(sensorPatchManifest.status, 403);
  assert.equal(getFirestoreErrorStatus(sensorPatchManifest.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 8. Sensor-authenticated PATCH firmware_releases/${version} -> 403 PERMISSION_DENIED`);

  // 9. Sensor DELETE artifact file -> 403 PERMISSION_DENIED
  const sensorDeleteFile = await httpJson("DELETE", appFileUrl, { token: idToken });
  assert.equal(sensorDeleteFile.status, 403);
  assert.equal(getFirestoreErrorStatus(sensorDeleteFile.body), "PERMISSION_DENIED");
  console.log(`   [PASS] 9. Sensor-authenticated DELETE firmware_releases/${version}/files/app.py -> 403 PERMISSION_DENIED`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runLive = argv.includes("--live");
  const versionFlagIdx = argv.indexOf("--version");
  const liveVersion =
    versionFlagIdx >= 0 && argv[versionFlagIdx + 1]
      ? argv[versionFlagIdx + 1]
      : "1.2.0-rc1";

  runOfflineUnitChecks();

  if (runLive) {
    await runLiveChecks(liveVersion);
    console.log(`\nAll offline + live Step 17 release manifest checks passed for v${liveVersion}!`);
  } else {
    console.log(
      "\nTip: Pass `--live --version 1.2.0-rc1` after publishing a release to verify live Firestore rules and SHA-256 downloads."
    );
    console.log("\nAll offline Step 17 release manifest checks passed!");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[FAIL] verify:release failed: ${message}`);
  process.exitCode = 1;
});
