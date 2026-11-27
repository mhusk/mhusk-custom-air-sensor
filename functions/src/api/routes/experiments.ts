import type { ServerResponse } from "node:http";

import {
  EXPERIMENT_ACTION_TYPES,
  EXPERIMENT_STATUSES,
  MAX_LIST_EXPERIMENTS_LIMIT,
  rankPlaybookRecommendations,
  type ExperimentActionType,
  type ExperimentStatus,
  type PlaybookPrimaryGoal,
} from "../../services/experiments.js";
import type { EnergyTaxTier } from "../../services/outdoor.js";
import {
  EXPERIMENTS_CACHE_TTL_MS,
  PLAYBOOK_CACHE_TTL_MS,
  type DashboardResponseCache,
} from "../cache.js";
import { parseValidatedJsonBody, sendJson, sendMethodNotAllowed } from "../http.js";
import {
  DEVICE_ID_REGEX,
  EXPERIMENT_ID_REGEX,
  createExperimentSchema,
  evaluateExperimentSchema,
  updateExperimentSchema,
} from "../schemas.js";
import type { DashboardDataService, IncomingApiRequest } from "../types.js";

const VALID_ACTION_TYPES = new Set<string>(EXPERIMENT_ACTION_TYPES);
const VALID_STATUSES = new Set<string>(EXPERIMENT_STATUSES);
const VALID_ENERGY_TIERS = new Set<string>(["free", "low", "moderate", "high"]);
const VALID_PRIMARY_GOALS = new Set<string>(["lower_co2", "lower_pm2_5", "balanced"]);

function decodeRouteSegment(
  segment: string
): { value: string; invalidEncoding: false } | { value: ""; invalidEncoding: true } {
  try {
    return { value: decodeURIComponent(segment), invalidEncoding: false };
  } catch {
    return { value: "", invalidEncoding: true };
  }
}

export function matchExperimentRoute(
  pathname: string
): { experimentId: string; action: "item" | "evaluate"; invalidEncoding: boolean } | null {
  const evalMatch = /^\/api\/experiments\/([^/]+)\/evaluate$/.exec(pathname);
  if (evalMatch) {
    const decoded = decodeRouteSegment(evalMatch[1]);
    return {
      experimentId: decoded.value,
      action: "evaluate",
      invalidEncoding: decoded.invalidEncoding,
    };
  }
  const itemMatch = /^\/api\/experiments\/([^/]+)$/.exec(pathname);
  if (itemMatch) {
    const decoded = decodeRouteSegment(itemMatch[1]);
    return {
      experimentId: decoded.value,
      action: "item",
      invalidEncoding: decoded.invalidEncoding,
    };
  }
  return null;
}

function isDomainValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return (
    msg.includes("must be greater than or equal") ||
    msg.includes("must be a positive") ||
    msg.includes("Cannot evaluate an active experiment") ||
    msg.includes("Invalid ISO-8601 timestamp") ||
    msg.includes("Unsupported 'action_type'") ||
    msg.includes("Unsupported 'status'") ||
    msg.includes("'device_id' is required")
  );
}

export async function handleExperimentsCollectionRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    actor: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
    bypassCache?: boolean;
    queryParams: URLSearchParams;
  }
): Promise<void> {
  const { pathname, method, actor, service, cache, bypassCache, queryParams } = params;

  if (method === "GET") {
    if (!service.listExperiments) {
      sendJson(res, 501, {
        error: "not_implemented",
        message: "Experiments listing is not enabled.",
      });
      return;
    }

    const rawStatus = queryParams.get("status")?.trim();
    let statusFilter: ExperimentStatus[] | undefined;
    if (rawStatus) {
      const parts = rawStatus
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0 || parts.some((s) => !VALID_STATUSES.has(s))) {
        sendJson(res, 400, {
          error: "validation_error",
          message: `status must be one of: ${EXPERIMENT_STATUSES.join(", ")}.`,
        });
        return;
      }
      statusFilter = parts as ExperimentStatus[];
    }

    const rawDeviceId = queryParams.get("device_id")?.trim();
    if (rawDeviceId && !DEVICE_ID_REGEX.test(rawDeviceId)) {
      sendJson(res, 400, {
        error: "validation_error",
        message:
          "device_id must be 1-64 characters using letters, numbers, underscores, or hyphens.",
      });
      return;
    }

    const rawLocation = queryParams.get("location")?.trim();
    if (rawLocation && !DEVICE_ID_REGEX.test(rawLocation)) {
      sendJson(res, 400, {
        error: "validation_error",
        message:
          "location must be 1-64 characters using letters, numbers, underscores, or hyphens.",
      });
      return;
    }

    const rawActionType = queryParams.get("action_type")?.trim();
    if (rawActionType && !VALID_ACTION_TYPES.has(rawActionType)) {
      sendJson(res, 400, {
        error: "validation_error",
        message: `action_type must be one of: ${EXPERIMENT_ACTION_TYPES.join(", ")}.`,
      });
      return;
    }

    let limit = 50;
    const rawLimit = queryParams.get("limit")?.trim();
    if (rawLimit !== undefined && rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (
        !Number.isInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > MAX_LIST_EXPERIMENTS_LIMIT
      ) {
        sendJson(res, 400, {
          error: "validation_error",
          message: `limit must be a whole number between 1 and ${MAX_LIST_EXPERIMENTS_LIMIT}.`,
        });
        return;
      }
      limit = parsedLimit;
    }

    const cacheKey = `experiments:${statusFilter ? statusFilter.join(",") : "*"}:${rawDeviceId ?? "*"}:${rawLocation ?? "*"}:${rawActionType ?? "*"}:${limit}`;
    if (cache && !bypassCache) {
      const cached = cache.get<Record<string, unknown>>(cacheKey);
      if (cached !== undefined) {
        sendJson(res, 200, cached);
        return;
      }
    }

    const experiments = await service.listExperiments({
      ...(statusFilter
        ? { status: statusFilter.length === 1 ? statusFilter[0] : statusFilter }
        : {}),
      ...(rawDeviceId ? { device_id: rawDeviceId } : {}),
      ...(rawLocation ? { location: rawLocation } : {}),
      ...(rawActionType ? { action_type: rawActionType as ExperimentActionType } : {}),
      limit,
    });

    const payload = {
      count: experiments.length,
      experiments,
    };
    cache?.set(cacheKey, payload, EXPERIMENTS_CACHE_TTL_MS);
    sendJson(res, 200, payload);
    return;
  }

  if (method === "POST") {
    const body = await parseValidatedJsonBody(req, res, createExperimentSchema);
    if (!body) {
      return;
    }

    if (!service.createExperiment) {
      sendJson(res, 501, {
        error: "not_implemented",
        message: "Experiment creation is not enabled.",
      });
      return;
    }

    try {
      const experiment = await service.createExperiment({
        ...body,
        source: "dashboard",
        created_by: actor,
      });
      cache?.invalidatePrefix("experiments:");
      cache?.invalidatePrefix("playbook");
      sendJson(res, 201, {
        created: true,
        experiment,
      });
    } catch (error) {
      if (isDomainValidationError(error)) {
        sendJson(res, 400, {
          error: "validation_error",
          message: error instanceof Error ? error.message : "Invalid experiment input.",
        });
        return;
      }
      throw error;
    }
    return;
  }

  sendMethodNotAllowed(res, method, pathname);
}

export async function handleExperimentItemRoute(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    service: DashboardDataService;
    route: { experimentId: string; action: "item" | "evaluate"; invalidEncoding: boolean };
    cache?: DashboardResponseCache;
  }
): Promise<void> {
  const { pathname, method, service, route, cache } = params;

  if (route.invalidEncoding) {
    sendJson(res, 400, {
      error: "validation_error",
      message: "Invalid URL encoding in experiment ID path parameter.",
    });
    return;
  }

  const { experimentId, action } = route;
  if (!EXPERIMENT_ID_REGEX.test(experimentId)) {
    sendJson(res, 400, {
      error: "validation_error",
      message:
        "experiment ID must be 1-96 characters using letters, numbers, underscores, or hyphens.",
    });
    return;
  }

  if (action === "item") {
    if (method === "GET") {
      if (!service.getExperiment) {
        sendJson(res, 501, {
          error: "not_implemented",
          message: "Experiment lookup is not enabled.",
        });
        return;
      }
      const experiment = await service.getExperiment(experimentId);
      if (!experiment) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Experiment '${experimentId}' not found.`,
        });
        return;
      }
      sendJson(res, 200, { experiment });
      return;
    }

    if (method === "PATCH") {
      const body = await parseValidatedJsonBody(req, res, updateExperimentSchema);
      if (!body) {
        return;
      }

      if (!service.updateExperiment) {
        sendJson(res, 501, {
          error: "not_implemented",
          message: "Experiment updates are not enabled.",
        });
        return;
      }

      try {
        const experiment = await service.updateExperiment(experimentId, body);
        if (!experiment) {
          sendJson(res, 404, {
            error: "not_found",
            message: `Experiment '${experimentId}' not found.`,
          });
          return;
        }
        cache?.invalidatePrefix("experiments:");
        cache?.invalidatePrefix("playbook");
        sendJson(res, 200, {
          updated: true,
          experiment,
        });
      } catch (error) {
        if (isDomainValidationError(error)) {
          sendJson(res, 400, {
            error: "validation_error",
            message: error instanceof Error ? error.message : "Invalid experiment update.",
          });
          return;
        }
        throw error;
      }
      return;
    }

    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  if (action === "evaluate") {
    if (method !== "POST") {
      sendMethodNotAllowed(res, method, pathname);
      return;
    }

    const body = await parseValidatedJsonBody(req, res, evaluateExperimentSchema);
    if (!body) {
      return;
    }

    if (!service.evaluateExperimentOutcome) {
      sendJson(res, 501, {
        error: "not_implemented",
        message: "Experiment evaluation is not enabled.",
      });
      return;
    }

    try {
      const experiment = await service.evaluateExperimentOutcome(experimentId, {
        force: body.force,
      });
      if (!experiment) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Experiment '${experimentId}' not found.`,
        });
        return;
      }
      cache?.invalidatePrefix("experiments:");
      cache?.invalidatePrefix("playbook");
      sendJson(res, 200, {
        evaluated: experiment.status === "evaluated",
        experiment,
      });
    } catch (error) {
      if (isDomainValidationError(error)) {
        sendJson(res, 400, {
          error: "validation_error",
          message: error instanceof Error ? error.message : "Cannot evaluate experiment.",
        });
        return;
      }
      throw error;
    }
    return;
  }

  sendMethodNotAllowed(res, method, pathname);
}

export async function handlePlaybookRoute(
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    service: DashboardDataService;
    cache?: DashboardResponseCache;
    bypassCache?: boolean;
    queryParams: URLSearchParams;
  }
): Promise<void> {
  const { pathname, method, service, cache, bypassCache, queryParams } = params;

  if (method !== "GET") {
    sendMethodNotAllowed(res, method, pathname);
    return;
  }

  if (!service.getHousePlaybook) {
    sendJson(res, 501, {
      error: "not_implemented",
      message: "House Physics Playbook is not enabled.",
    });
    return;
  }

  const rawLocation = queryParams.get("location")?.trim();
  if (rawLocation && !DEVICE_ID_REGEX.test(rawLocation)) {
    sendJson(res, 400, {
      error: "validation_error",
      message:
        "location must be 1-64 characters using letters, numbers, underscores, or hyphens.",
    });
    return;
  }

  const rawTier = queryParams.get("energy_tax_tier")?.trim();
  if (rawTier && !VALID_ENERGY_TIERS.has(rawTier)) {
    sendJson(res, 400, {
      error: "validation_error",
      message: "energy_tax_tier must be one of: free, low, moderate, high.",
    });
    return;
  }

  const rawGoal = queryParams.get("primary_goal")?.trim();
  if (rawGoal && !VALID_PRIMARY_GOALS.has(rawGoal)) {
    sendJson(res, 400, {
      error: "validation_error",
      message: "primary_goal must be one of: lower_co2, lower_pm2_5, balanced.",
    });
    return;
  }

  const cacheKey = `playbook:${rawLocation ?? "*"}:${rawTier ?? "*"}:${rawGoal ?? "lower_co2"}`;
  if (cache && !bypassCache) {
    const cached = cache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
  }

  const playbook = await service.getHousePlaybook();
  const recommendations = rankPlaybookRecommendations(playbook, {
    ...(rawLocation ? { location: rawLocation } : {}),
    ...(rawTier ? { energy_tax_tier: rawTier as EnergyTaxTier } : {}),
    ...(rawGoal ? { primary_goal: rawGoal as PlaybookPrimaryGoal } : {}),
  });

  const payload = {
    playbook,
    recommendations,
  };
  cache?.set(cacheKey, payload, PLAYBOOK_CACHE_TTL_MS);
  sendJson(res, 200, payload);
}
