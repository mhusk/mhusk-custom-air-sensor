import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  BoundedTtlCache,
  normalizeAuthKitDomain,
  parseAllowlist,
  type ResolvedWorkosUser,
  type WorkosAuthConfig,
} from "../auth/workos.js";
import { createMcpHttpHandler } from "../index.js";
import { createMockAirQualityService } from "./localMcpServer.js";

async function postMcp(
  url: string,
  payload: Record<string, unknown>,
  token?: string
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body };
}

async function main(): Promise<void> {
  // 1. Pure helper checks
  assert.equal(
    normalizeAuthKitDomain("demo-sensor.authkit.app/"),
    "https://demo-sensor.authkit.app"
  );
  assert.equal(
    normalizeAuthKitDomain("https://demo-sensor.authkit.app/extra"),
    "https://demo-sensor.authkit.app"
  );
  assert.equal(normalizeAuthKitDomain("   "), undefined);

  const parsedAllowlist = parseAllowlist(
    "Owner@Example.com, user_test_owner_123 ; second@example.org"
  );
  assert.equal(parsedAllowlist.emails.has("owner@example.com"), true);
  assert.equal(parsedAllowlist.emails.has("second@example.org"), true);
  assert.equal(parsedAllowlist.userIds.has("user_test_owner_123"), true);
  console.log("[PASS] AuthKit domain normalization & allowlist parsing");

  // 1b. BoundedTtlCache TTL expiry, expired pruning, and max-entry eviction
  const cache = new BoundedTtlCache<string, string>(2);
  cache.set("k1", "v1", 100, 1000);
  cache.set("k2", "v2", 500, 1000);
  assert.equal(cache.get("k1", 1050), "v1");
  assert.equal(cache.get("k1", 1100), undefined);
  // Adding k3 when k1 expired should not evict valid k2
  cache.set("k1", "v1-expired", 100, 1000);
  cache.set("k3", "v3", 500, 1150);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("k2", 1150), "v2");
  assert.equal(cache.get("k3", 1150), "v3");
  // Adding k4 when both k2 and k3 are active evicts oldest (k2)
  cache.set("k4", "v4", 500, 1200);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("k2", 1200), undefined);
  assert.equal(cache.get("k3", 1200), "v3");
  assert.equal(cache.get("k4", 1200), "v4");
  console.log("[PASS] BoundedTtlCache enforces TTL expiry, pruning, and capacity bounds");

  // 2. Generate ephemeral RS256 keypair simulating WorkOS AuthKit JWKS
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-workos-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const localJwks = createLocalJWKSet({ keys: [publicJwk] });
  const fakeAuthKitDomain = "https://demo-sensor.authkit.app";
  const fakeClientId = "client_test_air_sensor";
  const testFallbackToken = "local-unit-test-bearer-fallback-token";

  const fakeUsers: Record<string, ResolvedWorkosUser> = {
    user_owner_allowed: {
      id: "user_owner_allowed",
      email: "owner@example.com",
      emailVerified: true,
    },
    user_owner_unverified: {
      id: "user_owner_unverified",
      email: "owner@example.com",
      emailVerified: false,
    },
    user_stranger: {
      id: "user_stranger",
      email: "stranger@example.com",
      emailVerified: true,
    },
    user_direct_id_allowed: {
      id: "user_direct_id_allowed",
      email: "other@example.com",
      emailVerified: false,
    },
  };

  let currentConfig: WorkosAuthConfig = {
    workosApiKey: "unit-test-placeholder-api-key",
    workosClientId: fakeClientId,
    workosAuthKitDomain: fakeAuthKitDomain,
    allowedUserEmails: "owner@example.com,user_direct_id_allowed",
    bearerFallbackSecret: testFallbackToken,
  };

  const handler = createMcpHttpHandler({
    getAuthConfig: () => currentConfig,
    authDeps: {
      getKey: localJwks,
      getUserById: async (userId) => fakeUsers[userId] ?? null,
    },
    service: createMockAirQualityService(),
    loadAuthorizationServerMetadata: async (domain) => ({
      issuer: domain,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      jwks_uri: `${domain}/oauth2/jwks`,
      registration_endpoint: `${domain}/oauth2/register`,
    }),
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const mcpUrl = `${origin}/mcp`;

  const mintJwt = async (claims: {
    sub: string;
    aud?: string;
    iss?: string;
    exp?: string;
  }): Promise<string> =>
    new SignJWT({
      client_id: fakeClientId,
      scope: "openid profile email",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-workos-key-1" })
      .setIssuer(claims.iss ?? fakeAuthKitDomain)
      .setAudience(claims.aud ?? mcpUrl)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(privateKey);

  try {
    // 3. Health endpoint returns 200 without leaking secrets
    const healthRes = await fetch(`${origin}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.status, "ok");
    assert.equal(JSON.stringify(healthJson).includes(testFallbackToken), false);
    console.log("[PASS] GET /health returns 200 OK without exposing secrets");

    // 4. Protected Resource Metadata (RFC 9728) at both root and /mcp suffix
    for (const wellKnownPath of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const metaRes = await fetch(`${origin}${wellKnownPath}`);
      assert.equal(metaRes.status, 200);
      const meta = (await metaRes.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      assert.equal(meta.resource, mcpUrl);
      assert.deepEqual(meta.authorization_servers, [fakeAuthKitDomain]);
      assert.equal(meta.scopes_supported.includes("offline_access"), true);
    }
    console.log("[PASS] RFC 9728 /.well-known/oauth-protected-resource discovery metadata");

    // 5. Authorization Server Metadata proxy for legacy MCP clients
    const authServerRes = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(authServerRes.status, 200);
    const authServerMeta = (await authServerRes.json()) as { issuer: string };
    assert.equal(authServerMeta.issuer, fakeAuthKitDomain);
    console.log("[PASS] /.well-known/oauth-authorization-server metadata proxy");

    // 6. Unauthenticated POST /mcp returns 401 with RFC 9728 WWW-Authenticate header
    const unauth = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    assert.equal(unauth.status, 401);
    const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
    assert.match(wwwAuth, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
    console.log("[PASS] Unauthenticated /mcp returns 401 + WWW-Authenticate resource_metadata");

    // 6b. When accessed via *.cloudfunctions.net host, resource_metadata includes /mcp prefix
    const cfUnauth = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "us-east1-demo-project.cloudfunctions.net",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
    });
    assert.equal(cfUnauth.status, 401);
    assert.match(
      cfUnauth.headers.get("www-authenticate") ?? "",
      /resource_metadata="https:\/\/us-east1-demo-project\.cloudfunctions\.net\/mcp\/\.well-known\/oauth-protected-resource"/
    );
    console.log("[PASS] cloudfunctions.net host includes /mcp prefix in WWW-Authenticate resource_metadata");

    // 6c. Malformed X-Forwarded-Host header falls back safely without throwing 500
    const badHostUnauth = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Forwarded-Proto": "javascript",
        "X-Forwarded-Host": "bad host!!/evil",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    });
    assert.equal(badHostUnauth.status, 401);
    assert.match(
      badHostUnauth.headers.get("www-authenticate") ?? "",
      /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/
    );
    console.log("[PASS] Malformed X-Forwarded-Host/Proto returns 401 safely without crashing");

    // 7. Invalid Bearer token returns 401
    const badBearer = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      "not-a-valid-token"
    );
    assert.equal(badBearer.status, 401);
    console.log("[PASS] Invalid Bearer token returns 401 Unauthorized");

    // 8. Valid fallback Bearer secret returns 200 with MCP tool result
    const fallbackOk = await postMcp(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_latest_reading", arguments: {} },
      },
      testFallbackToken
    );
    assert.equal(fallbackOk.status, 200);
    assert.equal(Boolean(fallbackOk.body.result), true);
    console.log("[PASS] Valid MCP_BEARER_FALLBACK_SECRET returns 200 OK with MCP tool output");

    // 9. Valid WorkOS JWT for allowlisted verified owner email returns 200 OK
    const ownerJwt = await mintJwt({ sub: "user_owner_allowed" });
    const ownerOk = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      ownerJwt
    );
    assert.equal(ownerOk.status, 200);
    assert.equal(Boolean(ownerOk.body.result), true);
    console.log("[PASS] Valid WorkOS OAuth JWT (allowlisted verified email) returns 200 OK");

    // 10. Valid WorkOS JWT for direct user_id allowlist entry returns 200 OK
    const directIdJwt = await mintJwt({ sub: "user_direct_id_allowed", aud: fakeClientId });
    const directIdOk = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      directIdJwt
    );
    assert.equal(directIdOk.status, 200);
    console.log("[PASS] Valid WorkOS OAuth JWT (allowlisted user_id & client_id aud) returns 200 OK");

    // 11. Valid WorkOS JWT for non-allowlisted user returns 403 Forbidden
    const strangerJwt = await mintJwt({ sub: "user_stranger" });
    const strangerDenied = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
      strangerJwt
    );
    assert.equal(strangerDenied.status, 403);
    console.log("[PASS] Valid WorkOS OAuth JWT for non-allowlisted user returns 403 Forbidden");

    // 12. Valid WorkOS JWT for unverified email returns 403 Forbidden
    const unverifiedJwt = await mintJwt({ sub: "user_owner_unverified" });
    const unverifiedDenied = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      unverifiedJwt
    );
    assert.equal(unverifiedDenied.status, 403);
    console.log("[PASS] Valid WorkOS OAuth JWT with unverified email returns 403 Forbidden");

    // 13. Valid WorkOS JWT with wrong audience returns 401 Unauthorized
    const wrongAudJwt = await mintJwt({
      sub: "user_owner_allowed",
      aud: "https://some-other-service.example.com/mcp",
    });
    const wrongAudDenied = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
      wrongAudJwt
    );
    assert.equal(wrongAudDenied.status, 401);
    console.log("[PASS] WorkOS OAuth JWT with mismatched audience returns 401 Unauthorized");

    // 14. Empty owner allowlist fails closed with 403 Forbidden
    currentConfig = { ...currentConfig, allowedUserEmails: "   " };
    const failClosed = await postMcp(
      mcpUrl,
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
      ownerJwt
    );
    assert.equal(failClosed.status, 403);
    console.log("[PASS] Empty ALLOWED_USER_EMAILS fails closed with 403 Forbidden");

    console.log("\nAll WorkOS OAuth 2.1, allowlist, and discovery checks passed!");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error("Auth verification failed:", error);
  process.exit(1);
});
