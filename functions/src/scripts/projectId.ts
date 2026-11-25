import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the repository root directory from `functions/lib/scripts/*`.
 */
export function getDefaultRepoRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../..");
}

/**
 * Resolves the Firebase project ID from an explicit override, standard Google
 * Cloud / Firebase env vars, or the local gitignored `.firebaserc` file.
 */
export function resolveProjectId(explicitProjectId?: string): string | undefined {
  if (explicitProjectId && explicitProjectId.trim().length > 0) {
    return explicitProjectId.trim();
  }

  const envProject =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GCLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT;
  if (envProject && envProject.trim().length > 0) {
    return envProject.trim();
  }

  const firebasercPath = path.join(getDefaultRepoRoot(), ".firebaserc");
  if (!fs.existsSync(firebasercPath)) {
    return undefined;
  }

  const raw = JSON.parse(fs.readFileSync(firebasercPath, "utf8")) as {
    projects?: { default?: string };
  };
  return raw.projects?.default;
}
