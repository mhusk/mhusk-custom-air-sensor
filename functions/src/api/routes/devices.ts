import type { ServerResponse } from "node:http";

import type { DashboardResponseCache } from "../cache.js";
import { parseValidatedJsonBody, sendJson, sendMethodNotAllowed } from "../http.js";
import {
  DEVICE_ID_REGEX,
  setTargetFirmwareSchema,
  updateDeviceConfigSchema,
} from "../schemas.js";
import type { DashboardDataService, IncomingApiRequest } from "../types.js";
import { validateTargetFirmwareRelease } from "./firmware.js";
import { computeConfigSyncStatus, computeOtaRolloutStatus } from "./telemetry.js";

function decodeRouteSegment(
  segment: string
): { value: string; invalidEncoding: false } | { value: ""; invalidEncoding: true } {
  try {
    return { value: decodeURIComponent(segment), invalidEncoding: false };
  } catch {
    return { value: "", invalidEncoding: true };
  }
}

export function matchDeviceConfigRoute(
  pathname: string
): { deviceId: string; action: "config" | "reboot" | "firmware"; invalidEncoding: boolean } | null {
  const configMatch = /^\/api\/devices\/([^/]+)\/config$/.exec(pathname);
  if (configMatch) {
    const decoded = decodeRouteSegment(configMatch[1]);
    return { deviceId: decoded.value, action: "config", invalidEncoding: decoded.invalidEncoding };
  }
  const rebootMatch = /^\/api\/devices\/([^/]+)\/reboot$/.exec(pathname);
  if (rebootMatch) {
    const decoded = decodeRouteSegment(rebootMatch[1]);
    return { deviceId: decoded.value, action: "reboot", invalidEncoding: decoded.invalidEncoding };
  }
  const firmwareMatch = /^\/api\/devices\/([^/]+)\/firmware$/.exec(pathname);
  if (firmwareMatch) {
    const decoded = decodeRouteSegment(firmwareMatch[1]);
    return { deviceId: decoded.value, action: "firmware", invalidEncoding: decoded.invalidEncoding };
  }
  return null;
}

export async function handleDeviceActionRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    actor: string;
    service: DashboardDataService;
    deviceRoute: { deviceId: string; action: "config" | "reboot" | "firmware"; invalidEncoding: boolean };
    cache?: DashboardResponseCache;
  }
): Promise<void> {
  const { pathname, method, actor, service, deviceRoute, cache } = params;

  if (deviceRoute.invalidEncoding) {
    sendJson(res, 400, {
      error: "validation_error",
      message: "Invalid URL encoding in device_id path parameter.",
    });
    return;
  }

  const { deviceId, action } = deviceRoute;
  if (!DEVICE_ID_REGEX.test(deviceId)) {
    sendJson(res, 400, {
      error: "validation_error",
      message:
        "device_id must be 1-64 characters using letters, numbers, underscores, or hyphens.",
    });
    return;
  }

  if (action === "config" && method === "GET") {
    const [desired, status] = await Promise.all([
      service.getDeviceConfig(deviceId),
      service.getSensorStatus({ device_id: deviceId }),
    ]);
    const device = status.devices[0] ?? null;

    sendJson(res, 200, {
      device_id: deviceId,
      desired_config: desired,
      reported_device: device,
      config_sync_status: device
        ? computeConfigSyncStatus(device, desired)
        : desired
          ? "pending"
          : "local_defaults",
      ota_rollout_status: device
        ? computeOtaRolloutStatus(device, desired)
        : desired?.target_firmware_version
          ? "pending"
          : "up_to_date",
    });
    return;
  }

  if (action === "config" && method === "PUT") {
    const body = await parseValidatedJsonBody(req, res, updateDeviceConfigSchema);
    if (!body) {
      return;
    }

    const saved = await service.updateDeviceConfig(deviceId, body, actor);
    cache?.invalidate("overview");
    sendJson(res, 200, {
      updated: true,
      config: saved,
    });
    return;
  }

  if (action === "firmware" && method === "PUT") {
    const body = await parseValidatedJsonBody(req, res, setTargetFirmwareSchema);
    if (!body) {
      return;
    }

    const targetVersion = body.target_firmware_version;
    if (!(await validateTargetFirmwareRelease(res, service, targetVersion))) {
      return;
    }

    const saved = await service.setDeviceTargetFirmwareVersion(
      deviceId,
      targetVersion,
      actor
    );
    cache?.invalidate("overview");
    sendJson(res, 200, {
      updated: true,
      device_id: deviceId,
      target_firmware_version: targetVersion,
      config: saved,
    });
    return;
  }

  if (action === "reboot" && method === "POST") {
    const saved = await service.requestDeviceReboot(deviceId, actor);
    cache?.invalidate("overview");
    sendJson(res, 200, {
      reboot_requested: true,
      config: saved,
    });
    return;
  }

  sendMethodNotAllowed(res, method, pathname);
}
