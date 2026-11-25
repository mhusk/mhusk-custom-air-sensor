import type { ServerResponse } from "node:http";

import { RELEASES_CACHE_TTL_MS, type DashboardResponseCache } from "../cache.js";
import { parseValidatedJsonBody, sendJson, sendMethodNotAllowed } from "../http.js";
import { fleetRolloutSchema } from "../schemas.js";
import type { DashboardDataService, IncomingApiRequest } from "../types.js";

/**
 * Verifies a non-null target firmware version exists and is not yanked,
 * sending the appropriate 404/409 response if ineligible.
 */
export async function validateTargetFirmwareRelease(
  res: ServerResponse,
  service: DashboardDataService,
  targetVersion: string | null
): Promise<boolean> {
  if (targetVersion === null) {
    return true;
  }

  const release = await service.getFirmwareRelease(targetVersion);
  if (!release) {
    sendJson(res, 404, {
      error: "release_not_found",
      message: `Firmware release '${targetVersion}' does not exist in firmware_releases.`,
    });
    return false;
  }
  if (release.status === "yanked") {
    sendJson(res, 409, {
      error: "release_yanked",
      message: `Firmware release '${targetVersion}' is yanked and cannot be rolled out.`,
    });
    return false;
  }
  return true;
}

export async function handleFirmwareReleasesRoute(
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
    bypassCache?: boolean;
  }
): Promise<void> {
  const { pathname, method, service, cache, bypassCache } = params;
  if (method !== "GET") {
    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  const cacheKey = "firmware_releases";
  if (cache && !bypassCache) {
    const cached = cache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
  }

  const releases = await service.listFirmwareReleases();
  const payload = {
    count: releases.length,
    releases,
  };
  cache?.set(cacheKey, payload, RELEASES_CACHE_TTL_MS);
  sendJson(res, 200, payload);
}

export async function handleFirmwareRolloutRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    actor: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
  }
): Promise<void> {
  const { pathname, method, actor, service, cache } = params;
  if (method !== "POST") {
    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  const body = await parseValidatedJsonBody(req, res, fleetRolloutSchema);
  if (!body) {
    return;
  }

  const targetVersion = body.target_firmware_version;
  if (!(await validateTargetFirmwareRelease(res, service, targetVersion))) {
    return;
  }

  let targetDeviceIds: string[];
  if (body.device_ids && body.device_ids.length > 0) {
    targetDeviceIds = Array.from(new Set(body.device_ids));
  } else {
    const statusResult = await service.getSensorStatus();
    targetDeviceIds = statusResult.devices.map((d) => d.device_id);
  }

  if (targetDeviceIds.length === 0) {
    sendJson(res, 404, {
      error: "no_devices",
      message: "No registered sensor devices found to update.",
    });
    return;
  }

  const configs = await Promise.all(
    targetDeviceIds.map((id) =>
      service.setDeviceTargetFirmwareVersion(id, targetVersion, actor)
    )
  );
  cache?.invalidate("overview");

  sendJson(res, 200, {
    updated: true,
    target_firmware_version: targetVersion,
    updated_count: configs.length,
    configs,
  });
}
