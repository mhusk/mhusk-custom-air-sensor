import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Firestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

import type { DashboardResponseCache } from "./api/cache.js";
import type { DashboardDataService } from "./api/dashboard.js";
import type { WorkosAuthConfig, WorkosAuthDependencies } from "./auth/workos.js";
import type { AirQualityDataService } from "./mcp/tools.js";
import { appendIndoorRollupFromRawDoc, getDb } from "./services/firestore.js";
import { processReadingForExperiments } from "./services/experiments.js";
import { syncOutdoorReadingIfStale } from "./services/outdoor.js";

interface HttpRuntimeDeps {
  DashboardResponseCache: typeof import("./api/cache.js").DashboardResponseCache;
  handleDashboardApiRequest: typeof import("./api/dashboard.js").handleDashboardApiRequest;
  workos: typeof import("./auth/workos.js");
  handleStatelessMcpHttpRequest: typeof import("./mcp/server.js").handleStatelessMcpHttpRequest;
  MCP_SERVER_INFO: typeof import("./mcp/server.js").MCP_SERVER_INFO;
}

let httpDepsPromise: Promise<HttpRuntimeDeps> | null = null;

function loadHttpRuntimeDeps(): Promise<HttpRuntimeDeps> {
  if (!httpDepsPromise) {
    httpDepsPromise = Promise.all([
      import("./api/cache.js"),
      import("./api/dashboard.js"),
      import("./auth/workos.js"),
      import("./mcp/server.js"),
    ]).then(([cacheMod, dashMod, workosMod, mcpMod]) => ({
      DashboardResponseCache: cacheMod.DashboardResponseCache,
      handleDashboardApiRequest: dashMod.handleDashboardApiRequest,
      workos: workosMod,
      handleStatelessMcpHttpRequest: mcpMod.handleStatelessMcpHttpRequest,
      MCP_SERVER_INFO: mcpMod.MCP_SERVER_INFO,
    }));
  }
  return httpDepsPromise;
}

// Google Cloud Secret Manager bindings (injected at Cloud Run runtime; never committed to Git)
const workosApiKey = defineSecret("WORKOS_API_KEY");
const workosClientId = defineSecret("WORKOS_CLIENT_ID");
const workosAuthKitDomain = defineSecret("WORKOS_AUTHKIT_DOMAIN");
const allowedUserEmails = defineSecret("ALLOWED_USER_EMAILS");
const mcpBearerFallbackSecret = defineSecret("MCP_BEARER_FALLBACK_SECRET");

export interface IncomingMcpRequest extends IncomingMessage {
  auth?: AuthInfo;
  body?: unknown;
  path?: string;
}

export interface CreateMcpHttpHandlerOptions {
  /** Resolves auth config per request (reads Firebase Secrets or test overrides). */
  getAuthConfig: () => WorkosAuthConfig;
  /** Optional custom auth dependencies for offline unit/protocol testing. */
  authDeps?: WorkosAuthDependencies;
  /** Optional custom Firestore instance (defaults to firebase-admin default DB). */
  db?: Firestore;
  /** Optional injected data service (useful for offline unit/protocol testing). */
  service?: AirQualityDataService;
  /** Optional injected dashboard service (useful for offline API unit testing). */
  dashboardService?: DashboardDataService;
  /** Optional custom AuthKit authorization server metadata loader for testing. */
  loadAuthorizationServerMetadata?: (
    authkitDomain: string
  ) => Promise<Record<string, unknown>>;
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

const SAFE_HOST_REGEX = /^[A-Za-z0-9.\-:\[\]]+$/;

function extractHostnameFromHostHeader(hostHeader: string): string {
  const lower = hostHeader.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const endBracket = lower.indexOf("]");
    return endBracket > 1 ? lower.slice(1, endBracket) : lower;
  }
  const colonIdx = lower.indexOf(":");
  return colonIdx > 0 ? lower.slice(0, colonIdx) : lower;
}

function buildTrustedForwardedHostSet(authConfig?: WorkosAuthConfig): Set<string> {
  const hosts = new Set<string>();
  const addOriginHost = (rawOrigin?: string): void => {
    if (!rawOrigin) return;
    try {
      const parsed = new URL(rawOrigin);
      if (parsed.hostname) {
        hosts.add(parsed.hostname.toLowerCase());
      }
    } catch {
      // Ignore malformed origin strings
    }
  };

  for (const origin of parseAllowedDashboardOrigins(authConfig?.allowedDashboardOrigins)) {
    addOriginHost(origin);
  }
  addOriginHost(authConfig?.publicOrigin ?? process.env.PUBLIC_ORIGIN);
  return hosts;
}

function isTrustedForwardedHost(rawHost: string, extraTrustedHosts?: Set<string>): boolean {
  const hostname = extractHostnameFromHostHeader(rawHost);
  if (!hostname) {
    return false;
  }
  if (extraTrustedHosts?.has(hostname)) {
    return true;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }
  return (
    hostname.endsWith(".web.app") ||
    hostname.endsWith(".firebaseapp.com") ||
    hostname.endsWith(".cloudfunctions.net") ||
    hostname.endsWith(".run.app")
  );
}

/**
 * Reconstructs the public HTTPS origin behind Cloud Run / Cloud Functions
 * reverse proxies (respecting `X-Forwarded-Proto` and trusted `X-Forwarded-Host`),
 * falling back safely on malformed or untrusted header values.
 */
export function getPublicOrigin(
  req: IncomingMessage,
  options?: { trustedHosts?: Set<string> }
): string {
  const rawForwardedHost = getHeaderString(req.headers["x-forwarded-host"])
    ?.split(",")[0]
    .trim();
  const rawHostHeader = getHeaderString(req.headers.host)?.split(",")[0].trim();

  const trustedForwardedHost =
    rawForwardedHost &&
    SAFE_HOST_REGEX.test(rawForwardedHost) &&
    isTrustedForwardedHost(rawForwardedHost, options?.trustedHosts)
      ? rawForwardedHost
      : undefined;

  const host =
    trustedForwardedHost ??
    (rawHostHeader && SAFE_HOST_REGEX.test(rawHostHeader) ? rawHostHeader : "localhost");

  const forwardedProto = getHeaderString(req.headers["x-forwarded-proto"])
    ?.split(",")[0]
    .trim()
    .toLowerCase();

  const isLocalHost =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  const proto =
    isLocalHost && !trustedForwardedHost
      ? "http"
      : forwardedProto === "http" || forwardedProto === "https"
        ? forwardedProto
        : isLocalHost
          ? "http"
          : "https";

  const candidate = `${proto}://${host}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return isLocalHost ? "http://localhost" : "https://localhost";
  }
}

function isCloudFunctionsOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.endsWith(".cloudfunctions.net");
  } catch {
    return false;
  }
}

function getNormalizedPathname(req: IncomingMcpRequest): string | null {
  const rawPath = req.path ?? req.url ?? "/";
  try {
    const parsed = new URL(rawPath, "http://localhost");
    const pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      return pathname.slice(0, -1);
    }
    return pathname;
  } catch {
    return null;
  }
}

const LOCAL_DEV_ORIGIN_REGEX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function parseAllowedDashboardOrigins(raw?: string): Set<string> {
  const origins = new Set<string>();
  if (!raw) {
    return origins;
  }
  for (const part of raw.split(/[\s,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed origin entries
    }
  }
  return origins;
}

function isAllowedDashboardOrigin(
  requestOrigin: string,
  publicOrigin: string,
  allowedOriginsRaw?: string
): boolean {
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(requestOrigin).origin;
  } catch {
    return false;
  }

  if (normalizedOrigin === publicOrigin || LOCAL_DEV_ORIGIN_REGEX.test(normalizedOrigin)) {
    return true;
  }

  return parseAllowedDashboardOrigins(allowedOriginsRaw).has(normalizedOrigin);
}

function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    pathname: string;
    publicOrigin: string;
    allowedDashboardOrigins?: string;
  }
): void {
  const requestOrigin = getHeaderString(req.headers.origin)?.trim();
  const isApiRoute =
    options.pathname === "/api" || options.pathname.startsWith("/api/");

  if (isApiRoute) {
    if (requestOrigin) {
      res.setHeader("Vary", "Origin");
      if (
        isAllowedDashboardOrigin(
          requestOrigin,
          options.publicOrigin,
          options.allowedDashboardOrigins
        )
      ) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      }
    }
  } else {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin ?? "*");
    if (requestOrigin) {
      res.setHeader("Vary", "Origin");
    }
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version"
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hasPreparsedJsonBody(req: IncomingMcpRequest): boolean {
  return (
    req.method === "POST" &&
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  );
}

/**
 * Builds the core HTTP handler shared between the deployed Firebase Cloud
 * Function (2nd Gen) and local automated auth/protocol tests.
 */
export function createMcpHttpHandler(
  options: CreateMcpHttpHandlerOptions
): (req: IncomingMcpRequest, res: ServerResponse) => Promise<void> {
  let dashboardCache: DashboardResponseCache | null = null;

  return async (req: IncomingMcpRequest, res: ServerResponse): Promise<void> => {
    const deps = await loadHttpRuntimeDeps();
    dashboardCache ??= new deps.DashboardResponseCache();
    const loadAuthServerMeta =
      options.loadAuthorizationServerMetadata ?? deps.workos.fetchAuthorizationServerMetadata;

    const pathname = getNormalizedPathname(req);
    const authConfig = options.getAuthConfig();
    const trustedHosts = buildTrustedForwardedHostSet(authConfig);
    const origin = getPublicOrigin(req, { trustedHosts });

    setCorsHeaders(req, res, {
      pathname: pathname ?? "/",
      publicOrigin: origin,
      allowedDashboardOrigins: authConfig.allowedDashboardOrigins,
    });

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === null) {
      sendJson(res, 400, {
        error: "invalid_request",
        message: "Malformed request URL.",
      });
      return;
    }
    const authkitDomain = deps.workos.normalizeAuthKitDomain(authConfig.workosAuthKitDomain);

    // 1. Public liveness/health check (reveals zero secrets or user info)
    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        service: deps.MCP_SERVER_INFO.name,
        version: deps.MCP_SERVER_INFO.version,
        endpoint: `${origin}/mcp`,
        auth: {
          workos_oauth_configured: Boolean(authkitDomain),
          bearer_fallback_configured: Boolean(authConfig.bearerFallbackSecret?.trim()),
        },
      });
      return;
    }

    // 2. OAuth 2.1 Protected Resource Metadata (RFC 9728)
    if (
      req.method === "GET" &&
      (pathname === deps.workos.OAUTH_PROTECTED_RESOURCE_PATH ||
        pathname === `${deps.workos.OAUTH_PROTECTED_RESOURCE_PATH}/mcp`)
    ) {
      if (!authkitDomain) {
        sendJson(res, 503, {
          error: "oauth_not_configured",
          message: "WorkOS AuthKit domain is not configured on this server.",
        });
        return;
      }

      res.setHeader("Vary", "Host, X-Forwarded-Host");
      res.setHeader("Cache-Control", "public, max-age=300");
      sendJson(res, 200, deps.workos.buildProtectedResourceMetadata(origin, authkitDomain));
      return;
    }

    // 3. OAuth 2.1 Authorization Server Metadata proxy (for legacy MCP 2025-03-26 clients)
    if (req.method === "GET" && pathname === deps.workos.OAUTH_AUTHORIZATION_SERVER_PATH) {
      if (!authkitDomain) {
        sendJson(res, 503, {
          error: "oauth_not_configured",
          message: "WorkOS AuthKit domain is not configured on this server.",
        });
        return;
      }

      try {
        const metadata = await loadAuthServerMeta(authkitDomain);
        res.setHeader("Cache-Control", "public, max-age=300");
        sendJson(res, 200, metadata);
      } catch (error) {
        console.error(
          "[oauth] Failed to proxy AuthKit authorization server metadata:",
          error instanceof Error ? error.message : String(error)
        );
        sendJson(res, 502, {
          error: "upstream_metadata_unavailable",
          message: "Unable to fetch WorkOS AuthKit OAuth metadata.",
        });
      }
      return;
    }

    // 4. Dashboard JSON API endpoints (`/api/*`)
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await deps.handleDashboardApiRequest(req, res, {
        pathname,
        origin,
        authConfig,
        authDeps: options.authDeps,
        db: options.db,
        dashboardService: options.dashboardService,
        cache: dashboardCache,
      });
      return;
    }

    // 5. Protected MCP Streamable HTTP endpoint (`/mcp`, plus `/` for cloudfunctions.net URLs)
    if (pathname === "/mcp" || pathname === "/") {
      const authResult = await deps.workos.authenticateMcpRequest(
        req,
        origin,
        authConfig,
        options.authDeps
      );

      if (!authResult.ok) {
        if (authResult.status === 401) {
          const isCloudFunctionsHost = isCloudFunctionsOrigin(origin);
          const metadataBaseUrl = isCloudFunctionsHost ? `${origin}/mcp` : origin;
          res.setHeader(
            "WWW-Authenticate",
            deps.workos.buildWwwAuthenticateHeader(
              metadataBaseUrl,
              authResult.missingToken
                ? {}
                : {
                    error: authResult.error,
                    errorDescription: authResult.message,
                  }
            )
          );
        }

        sendJson(res, authResult.status, {
          jsonrpc: "2.0",
          error: {
            code:
              authResult.status === 401
                ? -32001
                : authResult.status === 403
                  ? -32003
                  : -32000,
            message: authResult.message,
          },
          id: null,
        });
        return;
      }

      req.auth = authResult.authInfo;

      const db = options.service ? undefined : (options.db ?? getDb());
      await deps.handleStatelessMcpHttpRequest(req, res, {
        db,
        service: options.service,
        parsedBody: hasPreparsedJsonBody(req) ? req.body : undefined,
      });
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message:
        "Not found. Use POST /mcp for MCP requests, GET /.well-known/oauth-protected-resource for OAuth discovery, or GET /health.",
    });
  };
}

let cloudFunctionHandler:
  | ((req: IncomingMcpRequest, res: ServerResponse) => Promise<void>)
  | null = null;

function getCloudFunctionHandler(): (
  req: IncomingMcpRequest,
  res: ServerResponse
) => Promise<void> {
  if (!cloudFunctionHandler) {
    cloudFunctionHandler = createMcpHttpHandler({
      getAuthConfig: () => ({
        workosApiKey: workosApiKey.value(),
        workosClientId: workosClientId.value(),
        workosAuthKitDomain: workosAuthKitDomain.value(),
        allowedUserEmails: allowedUserEmails.value(),
        bearerFallbackSecret: mcpBearerFallbackSecret.value(),
        allowedDashboardOrigins: process.env.ALLOWED_DASHBOARD_ORIGINS,
        publicOrigin: process.env.PUBLIC_ORIGIN,
      }),
    });
  }
  return cloudFunctionHandler;
}

/**
 * Firebase Cloud Function (2nd Gen) HTTPS entrypoint for the Remote MCP Server.
 *
 * Deployed in `us-east1` alongside Cloud Firestore for low-latency queries,
 * publicly invocable at the Cloud Run layer so external AI assistants (Claude,
 * ChatGPT, Grok) can reach OAuth discovery and present WorkOS AuthKit Bearer
 * tokens enforced by `authenticateMcpRequest()`.
 */
export const mcp = onRequest(
  {
    region: "us-east1",
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 5,
    secrets: [
      workosApiKey,
      workosClientId,
      workosAuthKitDomain,
      allowedUserEmails,
      mcpBearerFallbackSecret,
    ],
  },
  async (req, res) => {
    await getCloudFunctionHandler()(req as IncomingMcpRequest, res);
  }
);

/**
 * Firestore trigger (2nd Gen): whenever an ESP32-S3 sensor publishes a new
 * indoor reading, (1) idempotently appends the compact sample to `daily_rollups`
 * with 0 Firestore reads, (2) opportunistically captures an Open-Meteo
 * outdoor weather + US EPA AQI snapshot into `outdoor_readings` +
 * `outdoor_daily_rollups` (throttled by `site_configs/home`), and (3) runs
 * passive experiment step-change detection & due pending-experiment evaluation.
 */
export const syncOutdoorOnReading = onDocumentCreated(
  {
    document: "readings/{readingId}",
    region: "us-east1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 2,
  },
  async (event) => {
    const db = getDb();
    const readingId = event.params?.readingId;
    const rawData = event.data?.data();

    const rollupPromise =
      readingId && rawData
        ? appendIndoorRollupFromRawDoc(readingId, rawData, db)
        : Promise.resolve(null);

    const outdoorPromise = syncOutdoorReadingIfStale({
      db,
      includeReading: false,
    });

    const experimentsPromise = rawData
      ? processReadingForExperiments(rawData, { db })
      : Promise.resolve(null);

    const [rollupResult, outdoorResult, experimentsResult] = await Promise.allSettled([
      rollupPromise,
      outdoorPromise,
      experimentsPromise,
    ]);

    if (rollupResult.status === "fulfilled") {
      if (rollupResult.value) {
        console.log(`[rollup] syncOutdoorOnReading: appended ${rollupResult.value}`);
      }
    } else {
      console.error(
        "[rollup] syncOutdoorOnReading rollup append failed (non-fatal):",
        rollupResult.reason instanceof Error
          ? rollupResult.reason.message
          : String(rollupResult.reason)
      );
    }

    if (outdoorResult.status === "fulfilled") {
      const outcome = outdoorResult.value;
      console.log(
        `[outdoor] syncOutdoorOnReading: synced=${outcome.synced} (${outcome.reason})`
      );
    } else {
      console.error(
        "[outdoor] syncOutdoorOnReading failed (non-fatal):",
        outdoorResult.reason instanceof Error
          ? outdoorResult.reason.message
          : String(outdoorResult.reason)
      );
    }

    if (experimentsResult.status === "fulfilled") {
      const outcome = experimentsResult.value;
      if (outcome && (outcome.detection.detected || outcome.finalized_ids.length > 0)) {
        console.log(
          `[experiments] syncOutdoorOnReading: detected=${outcome.detection.detected} (${outcome.detection.reason}), finalized=${outcome.finalized_ids.length}`
        );
      }
    } else {
      console.error(
        "[experiments] syncOutdoorOnReading experiments processing failed (non-fatal):",
        experimentsResult.reason instanceof Error
          ? experimentsResult.reason.message
          : String(experimentsResult.reason)
      );
    }
  }
);
