import type { ServerResponse } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import {
  exchangeAuthKitCode,
  normalizeAuthKitDomain,
  refreshAuthKitSession,
  type WorkosAuthConfig,
  type WorkosAuthDependencies,
} from "../../auth/workos.js";
import { parseValidatedJsonBody, sendJson } from "../http.js";
import { authExchangeSchema, authRefreshSchema } from "../schemas.js";
import type { IncomingApiRequest } from "../types.js";

export function resolveActorLabel(authInfo: AuthInfo): string {
  const email = authInfo.extra?.email;
  if (typeof email === "string" && email.trim().length > 0) {
    return email.trim().toLowerCase();
  }
  const userId = authInfo.extra?.userId;
  if (typeof userId === "string" && userId.trim().length > 0) {
    return userId.trim();
  }
  return "bearer-api";
}

/**
 * Handles public `/api/auth/*` discovery, PKCE code exchange, and session refresh.
 * Returns `true` if the route matched and a response was sent.
 */
export async function handlePublicAuthRoutes(
  req: IncomingApiRequest,
  res: ServerResponse,
  params: {
    pathname: string;
    method: string;
    authConfig: WorkosAuthConfig;
    authDeps?: WorkosAuthDependencies;
  }
): Promise<boolean> {
  const { pathname, method, authConfig, authDeps } = params;

  if (pathname === "/api/auth/config" && method === "GET") {
    const authkitDomain = normalizeAuthKitDomain(authConfig.workosAuthKitDomain);
    const clientId = authConfig.workosClientId?.trim() || null;
    sendJson(res, 200, {
      oauth_configured: Boolean(authkitDomain && clientId),
      authkit_domain: authkitDomain ?? null,
      client_id: clientId,
      authorize_endpoint: "https://api.workos.com/user_management/authorize",
    });
    return true;
  }

  if (pathname === "/api/auth/exchange" && method === "POST") {
    const body = await parseValidatedJsonBody(req, res, authExchangeSchema);
    if (!body) {
      return true;
    }

    const outcome = await exchangeAuthKitCode(
      {
        code: body.code,
        codeVerifier: body.code_verifier,
      },
      authConfig,
      authDeps
    );
    if (!outcome.ok) {
      sendJson(res, outcome.status, {
        error: outcome.error,
        message: outcome.message,
      });
      return true;
    }

    sendJson(res, 200, {
      access_token: outcome.session.accessToken,
      refresh_token: outcome.session.refreshToken,
      user: {
        id: outcome.session.user.id,
        email: outcome.session.user.email,
        first_name: outcome.session.user.firstName ?? null,
        last_name: outcome.session.user.lastName ?? null,
      },
    });
    return true;
  }

  if (pathname === "/api/auth/refresh" && method === "POST") {
    const body = await parseValidatedJsonBody(req, res, authRefreshSchema);
    if (!body) {
      return true;
    }

    const outcome = await refreshAuthKitSession(
      { refreshToken: body.refresh_token },
      authConfig,
      authDeps
    );
    if (!outcome.ok) {
      sendJson(res, outcome.status, {
        error: outcome.error,
        message: outcome.message,
      });
      return true;
    }

    sendJson(res, 200, {
      access_token: outcome.session.accessToken,
      refresh_token: outcome.session.refreshToken,
      user: {
        id: outcome.session.user.id,
        email: outcome.session.user.email,
        first_name: outcome.session.user.firstName ?? null,
        last_name: outcome.session.user.lastName ?? null,
      },
    });
    return true;
  }

  return false;
}

export function handleMeRoute(
  res: ServerResponse,
  authInfo: AuthInfo
): void {
  sendJson(res, 200, {
    authenticated: true,
    auth_method: authInfo.extra?.authMethod ?? "unknown",
    user_id: authInfo.extra?.userId ?? null,
    email: authInfo.extra?.email ?? null,
  });
}
