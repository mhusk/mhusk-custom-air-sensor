import type { DocumentData, Firestore } from "firebase-admin/firestore";

import {
  FIRMWARE_RELEASE_FILES_SUBCOLLECTION,
  FIRMWARE_RELEASES_COLLECTION,
  asNumber,
  asString,
  getDb,
  normalizeTimestampToDate,
} from "./db.js";
import type {
  FirmwareReleaseFileArtifact,
  FirmwareReleaseFileEntry,
  FirmwareReleaseManifest,
  FirmwareReleaseStatus,
} from "./types.js";

export const SEMVER_VERSION_REGEX =
  /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]{0,19})?$/;
export const OTA_FILENAME_REGEX = /^[a-z][a-z0-9_]{0,31}\.py$/;
export const PROTECTED_FIRMWARE_FILES = new Set(["boot.py", "code.py", "settings.toml"]);
export const MAX_OTA_FILE_BYTES = 512 * 1024; // 512 KiB (safely below Firestore's 1 MiB doc limit)

export function isValidFirmwareVersion(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 5 &&
    value.length <= 32 &&
    SEMVER_VERSION_REGEX.test(value)
  );
}

export function isValidOtaFilename(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 35 &&
    OTA_FILENAME_REGEX.test(value) &&
    !PROTECTED_FIRMWARE_FILES.has(value)
  );
}

function mapFirmwareReleaseManifest(
  docId: string,
  data: DocumentData
): FirmwareReleaseManifest {
  const createdAtDate = normalizeTimestampToDate(data.created_at);
  const files: Record<string, FirmwareReleaseFileEntry> = {};

  if (typeof data.files === "object" && data.files !== null && !Array.isArray(data.files)) {
    for (const [filename, rawEntry] of Object.entries(
      data.files as Record<string, unknown>
    )) {
      if (typeof rawEntry === "object" && rawEntry !== null) {
        const entry = rawEntry as Record<string, unknown>;
        files[filename] = {
          doc_id: asString(entry.doc_id, filename),
          sha256: asString(entry.sha256),
          size_bytes: Math.max(0, Math.trunc(asNumber(entry.size_bytes, 0))),
        };
      }
    }
  }

  const fileEntries = Object.values(files);
  const status: FirmwareReleaseStatus = data.status === "yanked" ? "yanked" : "active";

  return {
    version: asString(data.version, docId),
    min_bootloader_version: asString(data.min_bootloader_version, "1.0.0"),
    notes: asString(data.notes, ""),
    file_count: Math.max(
      fileEntries.length,
      Math.trunc(asNumber(data.file_count, fileEntries.length))
    ),
    total_size_bytes: Math.max(
      0,
      Math.trunc(
        asNumber(
          data.total_size_bytes,
          fileEntries.reduce((acc, item) => acc + item.size_bytes, 0)
        )
      )
    ),
    files,
    created_at: createdAtDate.toISOString(),
    created_by: asString(data.created_by, "publish-cli"),
    git_sha:
      typeof data.git_sha === "string" && data.git_sha.trim().length > 0
        ? data.git_sha.trim()
        : null,
    status,
  };
}

function mapFirmwareReleaseFileArtifact(
  docId: string,
  version: string,
  data: DocumentData
): FirmwareReleaseFileArtifact {
  const createdAtDate = normalizeTimestampToDate(data.created_at);
  return {
    filename: asString(data.filename, docId),
    version: asString(data.version, version),
    sha256: asString(data.sha256),
    size_bytes: Math.max(0, Math.trunc(asNumber(data.size_bytes, 0))),
    encoding: "utf-8",
    content: asString(data.content),
    created_at: createdAtDate.toISOString(),
  };
}

/**
 * Fetches a single OTA release manifest from `firmware_releases/{version}`.
 */
export async function getFirmwareRelease(
  version: string,
  db: Firestore = getDb()
): Promise<FirmwareReleaseManifest | null> {
  if (!isValidFirmwareVersion(version)) {
    return null;
  }
  const doc = await db.collection(FIRMWARE_RELEASES_COLLECTION).doc(version).get();
  if (!doc.exists || !doc.data()) {
    return null;
  }
  return mapFirmwareReleaseManifest(doc.id, doc.data()!);
}

/**
 * Lists all published OTA release manifests sorted newest-first by `created_at`.
 */
export async function listFirmwareReleases(
  db: Firestore = getDb()
): Promise<FirmwareReleaseManifest[]> {
  const snapshot = await db.collection(FIRMWARE_RELEASES_COLLECTION).get();
  const releases = snapshot.docs.map((doc) =>
    mapFirmwareReleaseManifest(doc.id, doc.data())
  );
  releases.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return releases;
}

/**
 * Fetches a single versioned Python artifact from `firmware_releases/{version}/files/{filename}`.
 */
export async function getFirmwareReleaseFile(
  version: string,
  filename: string,
  db: Firestore = getDb()
): Promise<FirmwareReleaseFileArtifact | null> {
  if (!isValidFirmwareVersion(version) || !isValidOtaFilename(filename)) {
    return null;
  }
  const doc = await db
    .collection(FIRMWARE_RELEASES_COLLECTION)
    .doc(version)
    .collection(FIRMWARE_RELEASE_FILES_SUBCOLLECTION)
    .doc(filename)
    .get();
  if (!doc.exists || !doc.data()) {
    return null;
  }
  return mapFirmwareReleaseFileArtifact(doc.id, version, doc.data()!);
}
