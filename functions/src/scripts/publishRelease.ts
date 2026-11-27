import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApps, initializeApp, type Credential } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

import { DEVICE_ID_REGEX } from "../api/schemas.js";
import {
  FIRMWARE_RELEASE_FILES_SUBCOLLECTION,
  FIRMWARE_RELEASES_COLLECTION,
  isValidFirmwareVersion,
  isValidOtaFilename,
  MAX_OTA_FILE_BYTES,
  PROTECTED_FIRMWARE_FILES,
  setDeviceTargetFirmwareVersion,
  type FirmwareReleaseFileEntry,
} from "../services/firestore.js";
import { getDefaultRepoRoot, resolveProjectId } from "./projectId.js";

export { getDefaultRepoRoot, resolveProjectId };

export const DEFAULT_CORE_OTA_FILES = [
  "app.py",
  "aqi.py",
  "firestore_client.py",
] as const;

export const OPTIONAL_OTA_FILES = ["ota_updater.py"] as const;

export const DEFAULT_MIN_BOOTLOADER_VERSION = "1.0.0";
export const MAX_RELEASE_NOTES_LENGTH = 2000;

export interface PublishCliArgs {
  version?: string;
  notes: string;
  minBootloaderVersion: string;
  files?: string[];
  firmwareDir: string;
  publishedBy: string;
  projectId?: string;
  setTargetDeviceId?: string;
  dryRun: boolean;
  force: boolean;
  allowVersionMismatch: boolean;
  deleteRelease: boolean;
  help: boolean;
}

export interface StagedReleaseFile {
  filename: string;
  sha256: string;
  size_bytes: number;
  encoding: "utf-8";
  content: string;
}

export interface BuiltReleaseBundle {
  version: string;
  appDeclaredVersion: string | null;
  min_bootloader_version: string;
  notes: string;
  file_count: number;
  total_size_bytes: number;
  files: Record<string, FirmwareReleaseFileEntry>;
  artifacts: StagedReleaseFile[];
  created_by: string;
  git_sha: string | null;
  status: "active";
}

export interface BuildReleaseBundleOptions {
  firmwareDir: string;
  version?: string;
  notes?: string;
  minBootloaderVersion?: string;
  files?: string[];
  publishedBy?: string;
  gitSha?: string | null;
  allowVersionMismatch?: boolean;
}

export function extractAppFirmwareVersion(appPySource: string): string | null {
  const match = appPySource.match(
    /^\s*FIRMWARE_VERSION\s*=\s*["']([^"']+)["']/m
  );
  return match ? match[1].trim() : null;
}

export function detectGitShortSha(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function parsePublishArgs(
  argv: string[],
  defaultFirmwareDir = path.join(getDefaultRepoRoot(), "firmware")
): PublishCliArgs {
  const result: PublishCliArgs = {
    notes: "",
    minBootloaderVersion: DEFAULT_MIN_BOOTLOADER_VERSION,
    firmwareDir: defaultFirmwareDir,
    publishedBy: "publish-cli",
    dryRun: false,
    force: false,
    allowVersionMismatch: false,
    deleteRelease: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const readValue = (flag: string): string => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--version":
        result.version = readValue("--version");
        break;
      case "--notes":
        result.notes = readValue("--notes");
        break;
      case "--min-bootloader":
        result.minBootloaderVersion = readValue("--min-bootloader");
        break;
      case "--files":
        result.files = readValue("--files")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        break;
      case "--firmware-dir":
        result.firmwareDir = path.resolve(readValue("--firmware-dir"));
        break;
      case "--published-by":
        result.publishedBy = readValue("--published-by");
        break;
      case "--project":
        result.projectId = readValue("--project");
        break;
      case "--set-target":
        result.setTargetDeviceId = readValue("--set-target");
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--force":
        result.force = true;
        break;
      case "--allow-version-mismatch":
        result.allowVersionMismatch = true;
        break;
      case "--delete":
        result.deleteRelease = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

export function buildReleaseBundle(
  options: BuildReleaseBundleOptions
): BuiltReleaseBundle {
  const firmwareDir = path.resolve(options.firmwareDir);
  if (!fs.existsSync(firmwareDir) || !fs.statSync(firmwareDir).isDirectory()) {
    throw new Error(`Firmware directory not found: ${firmwareDir}`);
  }

  const minBootloaderVersion = (
    options.minBootloaderVersion ?? DEFAULT_MIN_BOOTLOADER_VERSION
  ).trim();
  if (!isValidFirmwareVersion(minBootloaderVersion)) {
    throw new Error(
      `Invalid --min-bootloader version '${minBootloaderVersion}'. Expected SemVer (e.g. 1.0.0).`
    );
  }

  const notes = (options.notes ?? "").trim();
  if (notes.length > MAX_RELEASE_NOTES_LENGTH) {
    throw new Error(
      `Release notes exceed maximum length (${MAX_RELEASE_NOTES_LENGTH} chars).`
    );
  }

  let selectedFiles: string[];
  if (options.files && options.files.length > 0) {
    selectedFiles = [...new Set(options.files)];
  } else {
    selectedFiles = [...DEFAULT_CORE_OTA_FILES];
    for (const optionalFile of OPTIONAL_OTA_FILES) {
      if (fs.existsSync(path.join(firmwareDir, optionalFile))) {
        selectedFiles.push(optionalFile);
      }
    }
  }

  if (selectedFiles.length === 0) {
    throw new Error("At least one firmware .py file must be included in a release.");
  }

  if (!selectedFiles.includes("app.py")) {
    throw new Error("Release bundle must include 'app.py'.");
  }

  const artifacts: StagedReleaseFile[] = [];
  const manifestFiles: Record<string, FirmwareReleaseFileEntry> = {};
  let totalSizeBytes = 0;
  let appDeclaredVersion: string | null = null;

  for (const filename of selectedFiles) {
    if (PROTECTED_FIRMWARE_FILES.has(filename)) {
      throw new Error(
        `Refusing to package protected file '${filename}'. boot.py, code.py, and settings.toml must never be shipped over OTA.`
      );
    }
    if (!isValidOtaFilename(filename)) {
      throw new Error(
        `Invalid OTA filename '${filename}'. Must match ^[a-z][a-z0-9_]{0,31}\\.py$ and exclude protected files.`
      );
    }

    const fullPath = path.join(firmwareDir, filename);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`Firmware file not found: ${fullPath}`);
    }
    const realFirmwareDir = fs.realpathSync(firmwareDir);
    const realFullPath = fs.realpathSync(fullPath);
    if (
      path.dirname(realFullPath) !== realFirmwareDir ||
      path.basename(realFullPath) !== filename
    ) {
      throw new Error(
        `Refusing to package '${filename}': symlink resolves outside ${firmwareDir}.`
      );
    }

    const rawBytes = fs.readFileSync(fullPath);
    if (rawBytes.length === 0) {
      throw new Error(`Firmware file '${filename}' is empty.`);
    }
    if (rawBytes.length > MAX_OTA_FILE_BYTES) {
      throw new Error(
        `Firmware file '${filename}' (${rawBytes.length} bytes) exceeds max allowed size (${MAX_OTA_FILE_BYTES} bytes).`
      );
    }

    const content = rawBytes.toString("utf8");
    const roundTripped = Buffer.from(content, "utf8");
    if (!roundTripped.equals(rawBytes)) {
      throw new Error(
        `Firmware file '${filename}' contains non-UTF-8 bytes and cannot be stored safely as UTF-8.`
      );
    }

    if (filename === "app.py") {
      appDeclaredVersion = extractAppFirmwareVersion(content);
      if (!content.includes("def main(")) {
        throw new Error(
          "firmware/app.py does not define `def main(...)` required by the code.py bootloader."
        );
      }
    }

    const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
    totalSizeBytes += rawBytes.length;

    artifacts.push({
      filename,
      sha256,
      size_bytes: rawBytes.length,
      encoding: "utf-8",
      content,
    });
    manifestFiles[filename] = {
      doc_id: filename,
      sha256,
      size_bytes: rawBytes.length,
    };
  }

  const version = (options.version ?? appDeclaredVersion ?? "").trim();
  if (!version) {
    throw new Error(
      "Could not determine release version. Pass --version <semver> or define FIRMWARE_VERSION in firmware/app.py."
    );
  }
  if (!isValidFirmwareVersion(version)) {
    throw new Error(
      `Invalid release version '${version}'. Expected SemVer such as 1.2.0 or 1.2.0-rc1.`
    );
  }

  if (
    appDeclaredVersion &&
    version !== appDeclaredVersion &&
    !options.allowVersionMismatch
  ) {
    throw new Error(
      `Release --version '${version}' does not match FIRMWARE_VERSION='${appDeclaredVersion}' in firmware/app.py. ` +
        `Update firmware/app.py or pass --allow-version-mismatch for a staged test release.`
    );
  }

  const createdBy = (options.publishedBy ?? "publish-cli").trim() || "publish-cli";

  return {
    version,
    appDeclaredVersion,
    min_bootloader_version: minBootloaderVersion,
    notes,
    file_count: artifacts.length,
    total_size_bytes: totalSizeBytes,
    files: manifestFiles,
    artifacts,
    created_by: createdBy,
    git_sha: options.gitSha ?? null,
    status: "active",
  };
}

function createStaticTokenCredential(accessToken: string): Credential {
  return {
    getAccessToken: async () => ({
      access_token: accessToken,
      expires_in: 3600,
    }),
  };
}

function getPublishFirestore(projectId: string): Firestore {
  const existingDefault = getApps().find((app) => app.name === "[DEFAULT]");
  if (existingDefault) {
    return getFirestore(existingDefault);
  }

  const explicitToken =
    process.env.FIRESTORE_ACCESS_TOKEN?.trim() ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();

  const app = explicitToken
    ? initializeApp({
        projectId,
        credential: createStaticTokenCredential(explicitToken),
      })
    : initializeApp({ projectId });

  return getFirestore(app);
}

export async function publishReleaseToFirestore(
  bundle: BuiltReleaseBundle,
  options: { force?: boolean; setTargetDeviceId?: string },
  db: Firestore
): Promise<{
  overwritten: boolean;
  targetUpdatedForDevice: string | null;
}> {
  if (options.setTargetDeviceId && !DEVICE_ID_REGEX.test(options.setTargetDeviceId)) {
    throw new Error(
      `Invalid target device ID '${options.setTargetDeviceId}'. Must match ${DEVICE_ID_REGEX.source}.`
    );
  }
  const releaseRef = db
    .collection(FIRMWARE_RELEASES_COLLECTION)
    .doc(bundle.version);
  const existing = await releaseRef.get();

  if (existing.exists && !options.force) {
    throw new Error(
      `Release '${bundle.version}' already exists in Firestore. Pass --force to overwrite an existing release.`
    );
  }

  const filesCol = releaseRef.collection(FIRMWARE_RELEASE_FILES_SUBCOLLECTION);
  const existingFilesSnap = existing.exists ? await filesCol.get() : null;
  const incomingFileSet = new Set(bundle.artifacts.map((a) => a.filename));

  const nowTs = Timestamp.now();
  const batch = db.batch();

  // Remove any stale subcollection files when overwriting with --force
  if (existingFilesSnap) {
    for (const doc of existingFilesSnap.docs) {
      if (!incomingFileSet.has(doc.id)) {
        batch.delete(doc.ref);
      }
    }
  }

  // Stage every .py file artifact and the parent manifest atomically in one batch
  for (const artifact of bundle.artifacts) {
    batch.set(filesCol.doc(artifact.filename), {
      filename: artifact.filename,
      version: bundle.version,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      encoding: artifact.encoding,
      content: artifact.content,
      created_at: nowTs,
    });
  }

  batch.set(releaseRef, {
    version: bundle.version,
    min_bootloader_version: bundle.min_bootloader_version,
    notes: bundle.notes,
    file_count: bundle.file_count,
    total_size_bytes: bundle.total_size_bytes,
    files: bundle.files,
    created_at: nowTs,
    created_by: bundle.created_by,
    git_sha: bundle.git_sha,
    status: bundle.status,
  });

  await batch.commit();

  let targetUpdatedForDevice: string | null = null;
  if (options.setTargetDeviceId) {
    await setDeviceTargetFirmwareVersion(
      options.setTargetDeviceId,
      bundle.version,
      bundle.created_by,
      db
    );
    targetUpdatedForDevice = options.setTargetDeviceId;
  }

  return {
    overwritten: existing.exists,
    targetUpdatedForDevice,
  };
}

export async function deleteReleaseFromFirestore(
  version: string,
  db: Firestore
): Promise<boolean> {
  if (!isValidFirmwareVersion(version)) {
    throw new Error(`Invalid release version '${version}'.`);
  }
  const releaseRef = db.collection(FIRMWARE_RELEASES_COLLECTION).doc(version);
  const filesSnap = await releaseRef
    .collection(FIRMWARE_RELEASE_FILES_SUBCOLLECTION)
    .get();
  const releaseSnap = await releaseRef.get();

  if (!releaseSnap.exists && filesSnap.empty) {
    return false;
  }

  const batch = db.batch();
  for (const doc of filesSnap.docs) {
    batch.delete(doc.ref);
  }
  if (releaseSnap.exists) {
    batch.delete(releaseRef);
  }
  await batch.commit();
  return true;
}

function printUsage(): void {
  console.log(`Usage:
  npm --prefix functions run publish:release -- [options]

Options:
  --version <semver>         Release version (default: FIRMWARE_VERSION from firmware/app.py)
  --notes "<text>"           Release notes stored in the manifest
  --min-bootloader <semver>  Minimum required code.py bootloader version (default: 1.0.0)
  --files <a.py,b.py,...>    Comma-separated list of .py files (default: app.py,aqi.py,firestore_client.py[,ota_updater.py])
  --firmware-dir <path>      Path to firmware directory (default: <repo>/firmware)
  --published-by <label>     Audit label stored in created_by (default: publish-cli)
  --project <project_id>     Firebase project ID (default: .firebaserc or FIREBASE_PROJECT_ID)
  --set-target <device_id>   Also pin device_configs/<device_id>.target_firmware_version to this release
  --allow-version-mismatch   Allow --version to differ from FIRMWARE_VERSION in firmware/app.py (useful for -rc test builds)
  --force                    Overwrite an existing firmware_releases/<version> release
  --dry-run                  Validate files and print SHA-256 manifest without writing to Firestore
  --delete                   Delete firmware_releases/<version> and its files subcollection
  --help, -h                 Show this help message
`);
}

function printBundleSummary(bundle: BuiltReleaseBundle, dryRun: boolean): void {
  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}OTA Firmware Release Manifest: v${bundle.version}`
  );
  console.log(`  app.py FIRMWARE_VERSION : ${bundle.appDeclaredVersion ?? "(not detected)"}`);
  console.log(`  min_bootloader_version  : ${bundle.min_bootloader_version}`);
  console.log(`  git_sha                 : ${bundle.git_sha ?? "(unavailable)"}`);
  console.log(`  notes                   : ${bundle.notes || "(none)"}`);
  console.log(
    `  files (${bundle.file_count}, ${bundle.total_size_bytes} bytes total):`
  );
  for (const artifact of bundle.artifacts) {
    console.log(
      `    - ${artifact.filename.padEnd(20)} ${String(artifact.size_bytes).padStart(6)} B  sha256:${artifact.sha256}`
    );
  }
}

async function main(): Promise<void> {
  const args = parsePublishArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const projectId = resolveProjectId(args.projectId);

  if (args.deleteRelease) {
    if (!args.version) {
      throw new Error("--delete requires --version <semver>.");
    }
    if (!projectId) {
      throw new Error(
        "Could not determine Firebase project ID. Ensure .firebaserc exists or pass --project."
      );
    }
    const db = getPublishFirestore(projectId);
    const deleted = await deleteReleaseFromFirestore(args.version, db);
    console.log(
      deleted
        ? `[OK] Deleted firmware_releases/${args.version} (and its files subcollection) from project '${projectId}'.`
        : `[INFO] Release firmware_releases/${args.version} was not found in project '${projectId}'.`
    );
    return;
  }

  const bundle = buildReleaseBundle({
    firmwareDir: args.firmwareDir,
    version: args.version,
    notes: args.notes,
    minBootloaderVersion: args.minBootloaderVersion,
    files: args.files,
    publishedBy: args.publishedBy,
    gitSha: detectGitShortSha(getDefaultRepoRoot()),
    allowVersionMismatch: args.allowVersionMismatch,
  });

  printBundleSummary(bundle, args.dryRun);

  if (args.dryRun) {
    console.log("\n[PASS] Dry run complete — no Firestore documents were modified.");
    return;
  }

  if (!projectId) {
    throw new Error(
      "Could not determine Firebase project ID. Ensure .firebaserc exists or pass --project."
    );
  }

  const db = getPublishFirestore(projectId);
  const result = await publishReleaseToFirestore(
    bundle,
    {
      force: args.force,
      setTargetDeviceId: args.setTargetDeviceId,
    },
    db
  );

  console.log(
    `\n[PASS] ${result.overwritten ? "Overwrote" : "Published"} firmware_releases/${bundle.version} ` +
      `(${bundle.file_count} files, atomic batch) in project '${projectId}'.`
  );
  if (result.targetUpdatedForDevice) {
    console.log(
      `[PASS] Updated device_configs/${result.targetUpdatedForDevice}.target_firmware_version = '${bundle.version}'.`
    );
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[FAIL] publish:release failed: ${message}`);
    if (
      (message.includes("PERMISSION_DENIED") || message.includes("does not exist")) &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ) {
      console.error(
        "\nHint: GOOGLE_APPLICATION_CREDENTIALS is set in your shell environment and may\n" +
          "point to a service account from a different Google Cloud project.\n" +
          "Try clearing it inline to fall back to default ADC:\n" +
          "  GOOGLE_APPLICATION_CREDENTIALS= npm --prefix functions run publish:release -- ..."
      );
    } else if (
      message.includes("Could not load the default credentials") ||
      message.includes("UNAUTHENTICATED") ||
      message.includes("default credentials")
    ) {
      console.error(
        "\nHint: firebase-admin needs Admin credentials locally:\n" +
          "  Option A: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json npm --prefix functions run publish:release -- ...\n" +
          "  Option B: gcloud auth application-default login\n" +
          "  Option C: Pass an explicit OAuth token via FIRESTORE_ACCESS_TOKEN=..."
      );
    }
    process.exitCode = 1;
  });
}
