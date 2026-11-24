import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Firestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

import {
  handleDashboardApiRequest,
  type DashboardDataService,
} from "./api/dashboard.js";
import {
  authenticateMcpRequest,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  fetchAuthorizationServerMetadata,
  normalizeAuthKitDomain,
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  type WorkosAuthConfig,
  type WorkosAuthDependencies,
} from "./auth/workos.js";
import { handleStatelessMcpHttpRequest, MCP_SERVER_INFO } from "./mcp/server.js";
import type { AirQualityDataService } from "./mcp/tools.js";
import { getDb } from "./services/firestore.js";
import { syncOutdoorReadingIfStale } from "./services/outdoor.js";

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

/**
 * Reconstructs the public HTTPS origin behind Cloud Run / Cloud Functions
 * reverse proxies (respecting `X-Forwarded-Proto` and `X-Forwarded-Host`).
 */
export function getPublicOrigin(req: IncomingMessage): string {
  const forwardedHost = getHeaderString(req.headers["x-forwarded-host"]);
  const host = (forwardedHost ?? getHeaderString(req.headers.host) ?? "localhost")
    .split(",")[0]
    .trim();

  const forwardedProto = getHeaderString(req.headers["x-forwarded-proto"])
    ?.split(",")[0]
    .trim()
    .toLowerCase();

  const isLocalHost =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  const proto = forwardedProto || (isLocalHost ? "http" : "https");
  return `${proto}://${host}`;
}

function getNormalizedPathname(req: IncomingMcpRequest): string {
  const rawPath = req.path ?? req.url ?? "/";
  const parsed = new URL(rawPath, "http://localhost");
  const pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const requestOrigin = getHeaderString(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", requestOrigin ?? "*");
  if (requestOrigin) {
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
  const loadAuthServerMeta =
    options.loadAuthorizationServerMetadata ?? fetchAuthorizationServerMetadata;

  return async (req: IncomingMcpRequest, res: ServerResponse): Promise<void> => {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const pathname = getNormalizedPathname(req);
    const origin = getPublicOrigin(req);
    const authConfig = options.getAuthConfig();
    const authkitDomain = normalizeAuthKitDomain(authConfig.workosAuthKitDomain);

    // 1. Public liveness/health check (reveals zero secrets or user info)
    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        service: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
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
      (pathname === OAUTH_PROTECTED_RESOURCE_PATH ||
        pathname === `${OAUTH_PROTECTED_RESOURCE_PATH}/mcp`)
    ) {
      if (!authkitDomain) {
        sendJson(res, 503, {
          error: "oauth_not_configured",
          message: "WorkOS AuthKit domain is not configured on this server.",
        });
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=300");
      sendJson(res, 200, buildProtectedResourceMetadata(origin, authkitDomain));
      return;
    }

    // 3. OAuth 2.1 Authorization Server Metadata proxy (for legacy MCP 2025-03-26 clients)
    if (req.method === "GET" && pathname === OAUTH_AUTHORIZATION_SERVER_PATH) {
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
      await handleDashboardApiRequest(req, res, {
        pathname,
        origin,
        authConfig,
        authDeps: options.authDeps,
        db: options.db,
        dashboardService: options.dashboardService,
      });
      return;
    }

    // 5. Protected MCP Streamable HTTP endpoint (`/mcp`, plus `/` for cloudfunctions.net URLs)
    if (pathname === "/mcp" || pathname === "/") {
      const authResult = await authenticateMcpRequest(
        req,
        origin,
        authConfig,
        options.authDeps
      );

      if (!authResult.ok) {
        if (authResult.status === 401) {
          const isCloudFunctionsHost = new URL(origin).hostname.endsWith(
            ".cloudfunctions.net"
          );
          const metadataBaseUrl = isCloudFunctionsHost ? `${origin}/mcp` : origin;
          res.setHeader(
            "WWW-Authenticate",
            buildWwwAuthenticateHeader(
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
            code: authResult.status === 401 ? -32001 : -32003,
            message: authResult.message,
          },
          id: null,
        });
        return;
      }

      req.auth = authResult.authInfo;

      const db = options.service ? undefined : (options.db ?? getDb());
      await handleStatelessMcpHttpRequest(req, res, {
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

const cloudFunctionHandler = createMcpHttpHandler({
  getAuthConfig: () => ({
    workosApiKey: workosApiKey.value(),
    workosClientId: workosClientId.value(),
    workosAuthKitDomain: workosAuthKitDomain.value(),
    allowedUserEmails: allowedUserEmails.value(),
    bearerFallbackSecret: mcpBearerFallbackSecret.value(),
  }),
});

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
    await cloudFunctionHandler(req as IncomingMcpRequest, res);
  }
);

/**
 * Firestore trigger (2nd Gen): whenever an ESP32-S3 sensor publishes a new
 * indoor reading, opportunistically captures an Open-Meteo outdoor weather +
 * US EPA AQI snapshot into `outdoor_readings` (throttled by `site_configs/home`'s
 * `outdoor_poll_interval_minutes`, default 15 min) so indoor-vs-outdoor deltas
 * and chart overlays stay populated with zero firmware changes.
 */
export const syncOutdoorOnReading = onDocumentCreated(
  {
    document: "readings/{readingId}",
    region: "us-east1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 2,
  },
  async () => {
    try {
      const outcome = await syncOutdoorReadingIfStale({ db: getDb() });
      console.log(`[outdoor] syncOutdoorOnReading: synced=${outcome.synced} (${outcome.reason})`);
    } catch (error) {
      console.error(
        "[outdoor] syncOutdoorOnReading failed (non-fatal):",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
);
