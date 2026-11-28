import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Firestore } from "firebase-admin/firestore";

import { registerAirQualityPromptsAndResources } from "./prompts.js";
import {
  createFirestoreDataService,
  registerAirQualityTools,
  type AirQualityDataService,
} from "./tools.js";

export const MCP_SERVER_INFO = {
  name: "custom-air-sensor-mcp",
  version: "0.1.0",
} as const;

export interface CreateAirQualityMcpServerOptions {
  /** Optional custom Firestore instance (defaults to firebase-admin default DB). */
  db?: Firestore;
  /** Optional injected data service (useful for offline unit/protocol testing). */
  service?: AirQualityDataService;
}

export interface HandleMcpHttpRequestOptions extends CreateAirQualityMcpServerOptions {
  /** Pre-parsed JSON request body (e.g., `req.body` from Cloud Functions / Express). */
  parsedBody?: unknown;
  /**
   * When true (default), POST requests return direct `application/json` responses
   * instead of keeping an SSE stream open. Recommended for stateless serverless
   * environments like Firebase Cloud Functions (2nd Gen) / Cloud Run.
   */
  enableJsonResponse?: boolean;
}

/**
 * Creates a fresh, fully configured MCP server instance with indoor, outdoor,
 * and house-experiment tools, prompts, and threshold reference resources.
 *
 * In stateless HTTP deployments (Cloud Functions / Cloud Run), call this once
 * per incoming HTTP request so each request gets an isolated server + transport.
 */
export function createAirQualityMcpServer(
  options: CreateAirQualityMcpServerOptions = {}
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  });

  const service = options.service ?? createFirestoreDataService(options.db);
  registerAirQualityTools(server, service);
  registerAirQualityPromptsAndResources(server);

  return server;
}

/**
 * Handles a single MCP Streamable HTTP request in stateless mode
 * (`sessionIdGenerator: undefined`), creating and cleanly closing a dedicated
 * `McpServer` and `StreamableHTTPServerTransport` for the request lifecycle.
 */
export async function handleStatelessMcpHttpRequest(
  req: IncomingMessage & { auth?: AuthInfo },
  res: ServerResponse,
  options: HandleMcpHttpRequestOptions = {}
): Promise<void> {
  const server = createAirQualityMcpServer({
    db: options.db,
    service: options.service,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: options.enableJsonResponse ?? true,
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      await transport.close();
    } catch {
      // Ignore close errors after response completion
    }
    try {
      await server.close();
    } catch {
      // Ignore close errors after response completion
    }
  };

  res.on("close", () => {
    void cleanup();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, options.parsedBody);
  } catch (error) {
    console.error(
      "[mcp] Unhandled MCP request error:",
      error instanceof Error ? error.message : String(error)
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        })
      );
    }
    await cleanup();
  }
}
