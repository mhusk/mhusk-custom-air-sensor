import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WorkOS } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const MCP_AUTH_REALM = "custom-air-sensor-mcp";
export const MCP_RESOURCE_NAME = "Custom Air Quality Sensor MCP Server";
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const OAUTH_AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_SERVER_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;

export interface WorkosAuthConfig {
  workosApiKey?: string;
  workosClientId?: string;
  workosAuthKitDomain?: string;
  allowedUserEmails?: string;
  bearerFallbackSecret?: string;
}

export interface ParsedAllowlist {
  emails: Set<string>;
  userIds: Set<string>;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  scopes_supported: string[];
  resource_name: string;
}

export interface ResolvedWorkosUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface WorkosAuthDependencies {
  /** Custom JWKS key resolver (injectable for offline unit tests). */
  getKey?: JWTVerifyGetKey;
  /** Custom WorkOS user lookup (injectable for offline unit tests). */
  getUserById?: (userId: string) => Promise<ResolvedWorkosUser | null>;
}

export type AuthVerificationResult =
  | {
      ok: true;
      authInfo: AuthInfo;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: "invalid_token" | "insufficient_scope" | "access_denied";
      message: string;
      /** True when the client omitted the Authorization header completely. */
      missingToken?: boolean;
    };

interface CachedUserEntry {
  user: ResolvedWorkosUser;
  expiresAt: number;
}

interface CachedMetadataEntry {
  metadata: Record<string, unknown>;
  expiresAt: number;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const workosClientCache = new Map<string, WorkOS>();
const userProfileCache = new Map<string, CachedUserEntry>();
const authServerMetadataCache = new Map<string, CachedMetadataEntry>();

/**
 * Normalizes a WorkOS AuthKit domain into an origin-only HTTPS URL without a
 * trailing slash (e.g., `example.authkit.app/` -> `https://example.authkit.app`).
 */
export function normalizeAuthKitDomain(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Parses a comma-, semicolon-, or whitespace-separated allowlist into
 * normalized lowercase emails and exact WorkOS user IDs (`user_...`).
 */
export function parseAllowlist(raw?: string): ParsedAllowlist {
  const emails = new Set<string>();
  const userIds = new Set<string>();

  if (!raw) {
    return { emails, userIds };
  }

  for (const part of raw.split(/[\s,;]+/)) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    if (entry.startsWith("user_")) {
      userIds.add(entry);
    } else if (entry.includes("@")) {
      emails.add(entry.toLowerCase());
    }
  }

  return { emails, userIds };
}

/**
 * Timing-safe string comparison using SHA-256 digests so secret length is not
 * leaked via timing differences.
 */
export function timingSafeSecretEqual(provided: string, expected: string): boolean {
  const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Extracts a Bearer token from an HTTP Authorization header.
 */
export function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * Builds the RFC 9728 OAuth 2.0 Protected Resource Metadata document telling
 * MCP clients which WorkOS AuthKit Authorization Server protects `/mcp`.
 */
export function buildProtectedResourceMetadata(
  origin: string,
  authkitDomain: string
): ProtectedResourceMetadata {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const cleanAuthKit = normalizeAuthKitDomain(authkitDomain) ?? authkitDomain.replace(/\/+$/, "");

  return {
    resource: `${cleanOrigin}/mcp`,
    authorization_servers: [cleanAuthKit],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    resource_name: MCP_RESOURCE_NAME,
  };
}

/**
 * Builds an RFC 6750 + RFC 9728 `WWW-Authenticate` header so MCP clients know
 * where to fetch OAuth Protected Resource Metadata upon receiving HTTP 401.
 */
export function buildWwwAuthenticateHeader(
  origin: string,
  options: {
    error?: string;
    errorDescription?: string;
  } = {}
): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const resourceMetadataUrl = `${cleanOrigin}${OAUTH_PROTECTED_RESOURCE_PATH}`;
  const parts = [
    `realm="${MCP_AUTH_REALM}"`,
    `resource_metadata="${resourceMetadataUrl}"`,
  ];

  if (options.error) {
    parts.push(`error="${sanitizeHeaderValue(options.error)}"`);
  }
  if (options.errorDescription) {
    parts.push(`error_description="${sanitizeHeaderValue(options.errorDescription)}"`);
  }

  return `Bearer ${parts.join(", ")}`;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, " ").trim();
}

/**
 * Fetches and caches WorkOS AuthKit's OAuth 2.1 Authorization Server Metadata
 * for legacy MCP clients that query `/.well-known/oauth-authorization-server`
 * on the MCP resource server's origin.
 */
export async function fetchAuthorizationServerMetadata(
  authkitDomain: string
): Promise<Record<string, unknown>> {
  const cleanAuthKit = normalizeAuthKitDomain(authkitDomain);
  if (!cleanAuthKit) {
    throw new Error("WORKOS_AUTHKIT_DOMAIN is not configured.");
  }

  const cached = authServerMetadataCache.get(cleanAuthKit);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  const discoveryUrl = `${cleanAuthKit}${OAUTH_AUTHORIZATION_SERVER_PATH}`;
  const response = await fetch(discoveryUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch AuthKit authorization server metadata (HTTP ${response.status}).`
    );
  }

  const metadata = (await response.json()) as Record<string, unknown>;
  authServerMetadataCache.set(cleanAuthKit, {
    metadata,
    expiresAt: Date.now() + AUTH_SERVER_METADATA_CACHE_TTL_MS,
  });

  return metadata;
}

function getRemoteJwksForAuthKit(authkitDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const jwksUrl = `${authkitDomain}/oauth2/jwks`;
  const existing = jwksCache.get(jwksUrl);
  if (existing) {
    return existing;
  }
  const created = createRemoteJWKSet(new URL(jwksUrl));
  jwksCache.set(jwksUrl, created);
  return created;
}

function getWorkosClient(apiKey: string, clientId?: string): WorkOS {
  const keyHash = crypto
    .createHash("sha256")
    .update(`${apiKey}:${clientId ?? ""}`, "utf8")
    .digest("hex");

  const existing = workosClientCache.get(keyHash);
  if (existing) {
    return existing;
  }

  const client = new WorkOS(apiKey, clientId ? { clientId } : undefined);
  workosClientCache.set(keyHash, client);
  return client;
}

async function resolveWorkosUserById(
  userId: string,
  config: WorkosAuthConfig,
  deps: WorkosAuthDependencies
): Promise<ResolvedWorkosUser | null> {
  if (deps.getUserById) {
    return deps.getUserById(userId);
  }

  const apiKey = config.workosApiKey?.trim();
  if (!apiKey) {
    return null;
  }

  const cacheKey = `${crypto.createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)}:${userId}`;
  const cached = userProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const workos = getWorkosClient(apiKey, config.workosClientId?.trim() || undefined);
  const user = await workos.userManagement.getUser(userId);
  const resolved: ResolvedWorkosUser = {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
  };

  userProfileCache.set(cacheKey, {
    user: resolved,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });

  return resolved;
}

function parseScopes(scopeClaim: unknown): string[] {
  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return [];
}

function buildExpectedAudiences(origin: string, clientId?: string): string[] {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const candidates = [
    `${cleanOrigin}/mcp`,
    cleanOrigin,
    clientId?.trim(),
  ].filter((value): value is string => Boolean(value && value.length > 0));

  return [...new Set(candidates)];
}

/**
 * Authenticates and authorizes an incoming HTTP request to the MCP endpoint.
 *
 * Supported authentication methods:
 * 1. Static fallback Bearer secret (`MCP_BEARER_FALLBACK_SECRET`) for CLI tools,
 *    smoke tests, and MCP Inspector sessions.
 * 2. WorkOS AuthKit OAuth 2.1 JWT access token verified via AuthKit JWKS
 *    (`iss`, `aud`, `exp`, cryptographic signature) and strictly gated against
 *    the owner allowlist (`ALLOWED_USER_EMAILS`, supporting emails and `user_...` IDs).
 */
export async function authenticateMcpRequest(
  req: IncomingMessage,
  origin: string,
  config: WorkosAuthConfig,
  deps: WorkosAuthDependencies = {}
): Promise<AuthVerificationResult> {
  const token = extractBearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: "Unauthorized: Bearer token required.",
      missingToken: true,
    };
  }

  // Path 1: Static fallback Bearer secret (e.g., curl validation or CLI clients)
  const fallbackSecret = config.bearerFallbackSecret?.trim();
  if (fallbackSecret && timingSafeSecretEqual(token, fallbackSecret)) {
    return {
      ok: true,
      authInfo: {
        token,
        clientId: "bearer-fallback",
        scopes: ["mcp:read"],
        extra: {
          authMethod: "bearer_fallback",
        },
      },
    };
  }

  // Path 2: WorkOS AuthKit OAuth 2.1 JWT verification
  const authkitDomain = normalizeAuthKitDomain(config.workosAuthKitDomain);
  if (!authkitDomain) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: "Unauthorized: invalid Bearer token.",
    };
  }

  const getKey = deps.getKey ?? getRemoteJwksForAuthKit(authkitDomain);
  const expectedAudiences = buildExpectedAudiences(origin, config.workosClientId);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getKey, {
      issuer: authkitDomain,
      audience: expectedAudiences.length > 0 ? expectedAudiences : undefined,
    });
    payload = verified.payload;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "JWTVerificationError";
    console.warn(`[auth] WorkOS JWT verification failed (${reason}).`);
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: "Unauthorized: invalid or expired WorkOS access token.",
    };
  }

  const userId = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!userId) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: "Unauthorized: token is missing subject (sub) claim.",
    };
  }

  // Strict owner allowlist enforcement (always fail closed when empty)
  const allowlist = parseAllowlist(config.allowedUserEmails);
  if (allowlist.emails.size === 0 && allowlist.userIds.size === 0) {
    console.error("[auth] Owner allowlist (ALLOWED_USER_EMAILS) is empty; denying access.");
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      message: "Forbidden: server owner allowlist is not configured.",
    };
  }

  const clientId =
    typeof payload.client_id === "string" && payload.client_id.trim().length > 0
      ? payload.client_id.trim()
      : config.workosClientId?.trim() || "workos-oauth";
  const scopes = parseScopes(payload.scope);
  const orgId = typeof payload.org_id === "string" ? payload.org_id : undefined;

  // Direct WorkOS user ID match (`user_01...`)
  if (allowlist.userIds.has(userId)) {
    return {
      ok: true,
      authInfo: {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        extra: {
          authMethod: "workos_oauth",
          userId,
          orgId,
        },
      },
    };
  }

  // Email allowlist check: resolve authoritative user profile from WorkOS API
  let resolvedEmail: string | undefined;
  let emailVerified = false;

  try {
    const user = await resolveWorkosUserById(userId, config, deps);
    if (user) {
      resolvedEmail = user.email.trim().toLowerCase();
      emailVerified = user.emailVerified;
    }
  } catch (error) {
    console.error(
      `[auth] Failed to resolve WorkOS user profile for sub=${userId}:`,
      error instanceof Error ? error.message : String(error)
    );
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      message: "Forbidden: unable to verify user authorization.",
    };
  }

  if (!resolvedEmail || !emailVerified || !allowlist.emails.has(resolvedEmail)) {
    console.warn(`[auth] Access denied by owner allowlist for sub=${userId}.`);
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      message: "Forbidden: authenticated user is not authorized to access this MCP server.",
    };
  }

  return {
    ok: true,
    authInfo: {
      token,
      clientId,
      scopes,
      expiresAt: payload.exp,
      extra: {
        authMethod: "workos_oauth",
        userId,
        email: resolvedEmail,
        orgId,
      },
    },
  };
}
