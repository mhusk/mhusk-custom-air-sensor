/**
 * WorkOS AuthKit PKCE browser authentication & session storage for the
 * Custom Air Quality Sensor web dashboard.
 *
 * Security notes:
 * - Zero secrets live in client code. Client ID & AuthKit endpoints are loaded
 *   at runtime from `/api/auth/config`.
 * - PKCE (`S256`) + CSRF `state` are stored only in `sessionStorage` during the
 *   redirect round-trip and wiped immediately upon callback.
 * - Authorization code exchange and session refresh happen server-side via
 *   `/api/auth/exchange` and `/api/auth/refresh`, which enforce `emailVerified`
 *   and the strict owner allowlist (`ALLOWED_USER_EMAILS`).
 */

const SESSION_STORAGE_KEY = "iaq_dashboard_session_v1";
const PKCE_STORAGE_KEY = "iaq_dashboard_pkce_v1";
const PKCE_MAX_AGE_MS = 15 * 60 * 1000;

let inFlightRefresh = null;

/**
 * Encodes bytes into RFC 4648 base64url without padding.
 * Works in both browsers and Node.js test environments.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Generates a cryptographically secure random base64url string.
 *
 * @param {number} byteLength
 * @returns {string}
 */
export function randomUrlSafeString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Computes the PKCE S256 code_challenge for a verifier.
 *
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function computeCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Builds the WorkOS UserManagement AuthKit authorization URL with PKCE S256.
 *
 * @param {{
 *   authorizeEndpoint: string,
 *   clientId: string,
 *   redirectUri: string,
 *   codeChallenge: string,
 *   state: string,
 * }} params
 * @returns {string}
 */
export function buildAuthorizeUrl({
  authorizeEndpoint,
  clientId,
  redirectUri,
  codeChallenge,
  state,
}) {
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Returns the canonical OAuth redirect URI for the current origin.
 *
 * @returns {string}
 */
export function getRedirectUri() {
  return `${window.location.origin}/auth/callback`;
}

/**
 * Reads the persisted dashboard session from localStorage (if valid).
 *
 * @returns {{
 *   accessToken: string,
 *   refreshToken: string | null,
 *   user: { id: string | null, email: string | null, firstName: string | null, lastName: string | null },
 *   authMethod: string,
 * } | null}
 */
export function loadSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      user: {
        id: parsed.user?.id ?? null,
        email: parsed.user?.email ?? null,
        firstName: parsed.user?.firstName ?? null,
        lastName: parsed.user?.lastName ?? null,
      },
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : "workos_oauth",
    };
  } catch {
    return null;
  }
}

/**
 * Persists a verified dashboard session.
 *
 * @param {{
 *   accessToken: string,
 *   refreshToken?: string | null,
 *   user?: { id?: string | null, email?: string | null, firstName?: string | null, lastName?: string | null },
 *   authMethod?: string,
 * }} session
 */
export function saveSession(session) {
  const normalized = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? null,
    user: {
      id: session.user?.id ?? null,
      email: session.user?.email ?? null,
      firstName: session.user?.firstName ?? null,
      lastName: session.user?.lastName ?? null,
    },
    authMethod: session.authMethod ?? "workos_oauth",
  };
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * Clears all stored tokens and ephemeral PKCE state.
 */
export function clearSession() {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage access failures in private/restricted modes.
  }
  try {
    window.sessionStorage.removeItem(PKCE_STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
}

/**
 * Initiates a full-page redirect to WorkOS AuthKit using PKCE S256.
 *
 * @param {{
 *   oauth_configured: boolean,
 *   client_id: string | null,
 *   authorize_endpoint: string,
 * }} authConfig
 */
export async function startWorkosLogin(authConfig) {
  if (!authConfig?.oauth_configured || !authConfig.client_id || !authConfig.authorize_endpoint) {
    throw new Error("WorkOS AuthKit is not configured on the backend.");
  }

  const codeVerifier = randomUrlSafeString(64);
  const state = randomUrlSafeString(24);
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  window.sessionStorage.setItem(
    PKCE_STORAGE_KEY,
    JSON.stringify({
      state,
      codeVerifier,
      createdAt: Date.now(),
    })
  );

  const authorizeUrl = buildAuthorizeUrl({
    authorizeEndpoint: authConfig.authorize_endpoint,
    clientId: authConfig.client_id,
    redirectUri: getRedirectUri(),
    codeChallenge,
    state,
  });

  window.location.assign(authorizeUrl);
}

/**
 * Detects and completes an incoming WorkOS OAuth callback (`?code=...&state=...`).
 * Always strips query parameters from the browser address bar immediately.
 *
 * @returns {Promise<
 *   | { handled: false }
 *   | { handled: true, ok: true, session: ReturnType<typeof saveSession> }
 *   | { handled: true, ok: false, error: string }
 * >}
 */
export async function handleAuthCallbackIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  const errorDescription = params.get("error_description");
  const returnedState = params.get("state");
  const isCallbackPath = window.location.pathname === "/auth/callback";

  if (!code && !error && !isCallbackPath) {
    return { handled: false };
  }

  // Always strip single-use auth params from the URL bar right away.
  window.history.replaceState({}, document.title, "/");

  let pkce = null;
  try {
    const rawPkce = window.sessionStorage.getItem(PKCE_STORAGE_KEY);
    window.sessionStorage.removeItem(PKCE_STORAGE_KEY);
    if (rawPkce) {
      pkce = JSON.parse(rawPkce);
    }
  } catch {
    pkce = null;
  }

  if (error) {
    return {
      handled: true,
      ok: false,
      error: errorDescription || `WorkOS sign-in returned an error: ${error}`,
    };
  }

  if (!code) {
    return {
      handled: true,
      ok: false,
      error: "Sign-in callback did not include an authorization code.",
    };
  }

  const isExpired =
    !pkce ||
    typeof pkce.createdAt !== "number" ||
    Date.now() - pkce.createdAt > PKCE_MAX_AGE_MS;
  if (isExpired || !pkce.state || returnedState !== pkce.state) {
    return {
      handled: true,
      ok: false,
      error: "Sign-in session expired or state did not match. Please try signing in again.",
    };
  }

  const response = await fetch("/api/auth/exchange", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: pkce.codeVerifier,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    clearSession();
    const message =
      response.status === 403
        ? payload.message || "Your account is not on the owner allowlist for this sensor."
        : payload.message || `Sign-in failed (HTTP ${response.status}).`;
    return {
      handled: true,
      ok: false,
      error: message,
    };
  }

  const session = saveSession({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    user: {
      id: payload.user?.id ?? null,
      email: payload.user?.email ?? null,
      firstName: payload.user?.first_name ?? null,
      lastName: payload.user?.last_name ?? null,
    },
    authMethod: "workos_oauth",
  });

  return { handled: true, ok: true, session };
}

/**
 * Refreshes an expired WorkOS AuthKit session using a single-flight lock so
 * concurrent 401 responses never race on rotating refresh tokens.
 *
 * @returns {Promise<ReturnType<typeof saveSession> | null>}
 */
export async function refreshSession() {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  const current = loadSession();
  if (!current?.refreshToken) {
    return null;
  }

  inFlightRefresh = (async () => {
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });

      if (!response.ok) {
        clearSession();
        return null;
      }

      const payload = await response.json();
      if (!payload?.access_token) {
        clearSession();
        return null;
      }

      return saveSession({
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? current.refreshToken,
        user: {
          id: payload.user?.id ?? current.user.id,
          email: payload.user?.email ?? current.user.email,
          firstName: payload.user?.first_name ?? current.user.firstName,
          lastName: payload.user?.last_name ?? current.user.lastName,
        },
        authMethod: "workos_oauth",
      });
    } catch {
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * Validates and saves a fallback Bearer token via `GET /api/me`.
 * Useful for local CLI/smoke testing without configuring OAuth redirect URIs.
 *
 * @param {string} rawToken
 */
export async function signInWithBearerToken(rawToken) {
  const token = rawToken.trim();
  if (!token) {
    throw new Error("Please paste a valid Bearer token.");
  }

  const response = await fetch("/api/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `Token was rejected (HTTP ${response.status}).`);
  }

  return saveSession({
    accessToken: token,
    refreshToken: null,
    user: {
      id: payload.user_id ?? "bearer-fallback",
      email: payload.email ?? "Bearer API Token",
      firstName: null,
      lastName: null,
    },
    authMethod: payload.auth_method ?? "bearer_fallback",
  });
}
