import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createMcpHttpHandler } from "../index.js";
import { THRESHOLDS_RESOURCE_URI } from "../mcp/prompts.js";
import { handleStatelessMcpHttpRequest } from "../mcp/server.js";
import {
  createLocalMcpHttpServer,
  createMockAirQualityService,
  resolveProjectIdFromFirebaserc,
} from "./localMcpServer.js";

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function postMcp(
  baseUrl: string,
  payload: Record<string, unknown>,
  token?: string
): Promise<{ status: number; body: JsonRpcResponse }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as JsonRpcResponse;
  return { status: response.status, body };
}

async function runSuite(mode: "mock" | "live"): Promise<void> {
  const isLive = mode === "live";
  const bearerSecret = "local-step6-verification-token";
  const projectId = isLive ? resolveProjectIdFromFirebaserc() : undefined;

  if (isLive && !projectId) {
    throw new Error(
      "Could not determine Firebase project ID. Ensure .firebaserc exists or set FIREBASE_PROJECT_ID."
    );
  }

  const server = createLocalMcpHttpServer({
    useMock: !isLive,
    bearerSecret,
    projectId,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log(
      `\nRunning MCP Streamable HTTP verification (${isLive ? "LIVE Cloud Firestore" : "OFFLINE mock data"})...`
    );

    // 1. Verify Bearer auth rejects unauthenticated callers
    const unauth = await postMcp(baseUrl, {
      jsonrpc: "2.0",
      id: 0,
      method: "tools/list",
    });
    assert.equal(unauth.status, 401, "Expected 401 when Bearer token is missing.");
    console.log("   [PASS] Missing Bearer token rejected with 401 Unauthorized");

    // 2. Initialize handshake
    const init = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "step6-verifier", version: "0.1.0" },
        },
      },
      bearerSecret
    );
    assert.equal(init.status, 200);
    assert.ok(init.body.result, "Expected initialize result");
    const serverInfo = init.body.result.serverInfo as { name: string; version: string };
    assert.equal(serverInfo.name, "custom-air-sensor-mcp");
    console.log(`   [PASS] initialize -> server=${serverInfo.name}@${serverInfo.version}`);

    // 3. tools/list
    const toolsList = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      bearerSecret
    );
    assert.equal(toolsList.status, 200);
    const tools =
      (toolsList.body.result?.tools as Array<{
        name: string;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
        inputSchema?: { additionalProperties?: boolean };
      }>) ?? [];
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "get_air_quality_summary",
      "get_house_playbook",
      "get_latest_reading",
      "get_outdoor_air_quality",
      "get_readings_history",
      "get_sensor_status",
      "get_ventilation_forecast",
      "list_experiments",
      "log_experiment",
      "update_experiment",
    ]);
    const toolByName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Expected tools/list to include ${name}`);
      return tool;
    };
    for (const name of ["log_experiment", "update_experiment"]) {
      const annotations = toolByName(name).annotations;
      assert.equal(annotations?.readOnlyHint, false, `${name} readOnlyHint`);
      assert.equal(annotations?.destructiveHint, false, `${name} destructiveHint`);
      assert.equal(annotations?.idempotentHint, false, `${name} idempotentHint`);
      assert.equal(annotations?.openWorldHint, false, `${name} openWorldHint`);
      assert.equal(
        toolByName(name).inputSchema?.additionalProperties,
        false,
        `${name} should reject unknown fields`
      );
    }
    for (const name of ["list_experiments", "get_house_playbook"]) {
      assert.equal(toolByName(name).annotations?.readOnlyHint, true, `${name} readOnlyHint`);
    }
    console.log(`   [PASS] tools/list -> ${toolNames.join(", ")}`);

    // 4. tools/call: get_latest_reading
    const latestRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_latest_reading",
          arguments: {},
        },
      },
      bearerSecret
    );
    assert.equal(latestRes.status, 200);
    const latestContent = (latestRes.body.result?.content as Array<{ text: string }>) ?? [];
    if (latestRes.body.result?.isError) {
      throw new Error(`get_latest_reading returned tool error: ${latestContent[0]?.text ?? "unknown"}`);
    }
    const latestPayload = JSON.parse(latestContent[0].text) as {
      found: boolean;
      reading?: { device_id: string; co2_ppm: number; pm2_5_ug_m3: number; aqi_us: number };
      minutes_ago?: number;
    };
    assert.equal(latestPayload.found, true, "Expected at least one reading.");
    assert.ok(latestPayload.reading);
    console.log(
      `   [PASS] tools/call get_latest_reading -> device=${latestPayload.reading.device_id}, CO2=${latestPayload.reading.co2_ppm} ppm, PM2.5=${latestPayload.reading.pm2_5_ug_m3} ug/m3, AQI=${latestPayload.reading.aqi_us}`
    );

    // 5. tools/call: get_readings_history
    const historyRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_readings_history",
          arguments: { hours: 24, limit: 50 },
        },
      },
      bearerSecret
    );
    assert.equal(historyRes.status, 200);
    const historyContent = (historyRes.body.result?.content as Array<{ text: string }>) ?? [];
    const historyPayload = JSON.parse(historyContent[0].text) as {
      returned_count: number;
      total_matching: number;
    };
    assert.ok(historyPayload.returned_count >= 1);
    console.log(
      `   [PASS] tools/call get_readings_history -> ${historyPayload.returned_count}/${historyPayload.total_matching} reading(s)`
    );

    // 6. tools/call: get_air_quality_summary
    const summaryRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "get_air_quality_summary",
          arguments: { period: "24h" },
        },
      },
      bearerSecret
    );
    assert.equal(summaryRes.status, 200);
    const summaryContent = (summaryRes.body.result?.content as Array<{ text: string }>) ?? [];
    const summaryPayload = JSON.parse(summaryContent[0].text) as {
      sample_count: number;
      metrics: { co2_ppm: { avg: number; p95: number } } | null;
      notable_spikes: unknown[];
    };
    assert.ok(summaryPayload.sample_count >= 1 && summaryPayload.metrics !== null);
    console.log(
      `   [PASS] tools/call get_air_quality_summary -> samples=${summaryPayload.sample_count}, CO2 avg=${summaryPayload.metrics.co2_ppm.avg} ppm, spikes=${summaryPayload.notable_spikes.length}`
    );

    // 7. tools/call: get_sensor_status
    const statusRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "get_sensor_status",
          arguments: {},
        },
      },
      bearerSecret
    );
    assert.equal(statusRes.status, 200);
    const statusContent = (statusRes.body.result?.content as Array<{ text: string }>) ?? [];
    const statusPayload = JSON.parse(statusContent[0].text) as {
      device_count: number;
      devices: Array<{ device_id: string; status: string }>;
    };
    assert.ok(statusPayload.device_count >= 1);
    console.log(
      `   [PASS] tools/call get_sensor_status -> devices=${statusPayload.device_count} (${statusPayload.devices[0].device_id}: ${statusPayload.devices[0].status})`
    );

    // 7b. tools/call: get_ventilation_forecast
    const forecastRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "get_ventilation_forecast",
          arguments: {},
        },
      },
      bearerSecret
    );
    assert.equal(forecastRes.status, 200);
    const forecastContent = (forecastRes.body.result?.content as Array<{ text: string }>) ?? [];
    const forecastPayload = JSON.parse(forecastContent[0].text) as {
      found: boolean;
      current_energy_tax?: { tier: string } | null;
      next_best_window?: { best_tax_tier: string } | null;
    };
    if (!isLive) {
      assert.equal(forecastPayload.found, true);
      assert.ok(forecastPayload.current_energy_tax?.tier);
      assert.ok(forecastPayload.next_best_window?.best_tax_tier);
    }
    console.log(
      `   [PASS] tools/call get_ventilation_forecast -> found=${forecastPayload.found}`
    );

    // 7b2. House experiment tools. Writes stay on the offline mock so --live
    // never creates a real experiment. Live mode only reads.
    const playbookArgs = isLive
      ? {}
      : {
          location: "home-office",
          energy_tax_tier: "free",
          primary_goal: "lower_co2",
        };
    const playbookRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 63,
        method: "tools/call",
        params: {
          name: "get_house_playbook",
          arguments: playbookArgs,
        },
      },
      bearerSecret
    );
    assert.equal(playbookRes.status, 200);
    const playbookContent = (playbookRes.body.result?.content as Array<{ text: string }>) ?? [];
    assert.equal(Boolean(playbookRes.body.result?.isError), false);
    const playbookPayload = JSON.parse(playbookContent[0].text) as {
      found: boolean;
      has_history: boolean;
      context?: { energy_tax_tier: string | null; primary_goal: string };
      recommendations?: Array<{
        match_quality: string;
        rationale: string;
        entry: { action_type: string };
      }>;
    };
    assert.equal(playbookPayload.found, true);
    if (!isLive) {
      assert.equal(playbookPayload.has_history, true);
      assert.equal(playbookPayload.context?.primary_goal, "lower_co2");
      assert.equal(playbookPayload.context?.energy_tax_tier, "free");
      assert.equal(playbookPayload.recommendations?.[0]?.entry.action_type, "crack_window");
      assert.equal(playbookPayload.recommendations?.[0]?.match_quality, "exact_tier");
      assert.match(playbookPayload.recommendations?.[0]?.rationale ?? "", /ppm/);

      const derivedRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 641,
          method: "tools/call",
          params: {
            name: "get_house_playbook",
            arguments: { device_id: "feather-s3-01" },
          },
        },
        bearerSecret
      );
      const derivedContent = (derivedRes.body.result?.content as Array<{ text: string }>) ?? [];
      const derivedPayload = JSON.parse(derivedContent[0].text) as {
        context?: { location: string | null; energy_tax_tier: string | null; primary_goal: string };
      };
      assert.equal(derivedPayload.context?.location, "home-office");
      assert.equal(derivedPayload.context?.primary_goal, "lower_co2");
      assert.ok(
        derivedPayload.context?.energy_tax_tier === "free" ||
          derivedPayload.context?.energy_tax_tier === "low" ||
          derivedPayload.context?.energy_tax_tier === "moderate" ||
          derivedPayload.context?.energy_tax_tier === "high",
        "Expected a derived energy-tax tier from the current indoor and outdoor readings"
      );

      const pmPlaybookRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 64,
          method: "tools/call",
          params: {
            name: "get_house_playbook",
            arguments: {
              location: "home-office",
              energy_tax_tier: "high",
              primary_goal: "lower_pm2_5",
            },
          },
        },
        bearerSecret
      );
      const pmContent = (pmPlaybookRes.body.result?.content as Array<{ text: string }>) ?? [];
      const pmPayload = JSON.parse(pmContent[0].text) as {
        recommendations?: Array<{ entry: { action_type: string } }>;
      };
      assert.equal(pmPayload.recommendations?.[0]?.entry.action_type, "hepa_purifier");

      const loggedRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 65,
          method: "tools/call",
          params: {
            name: "log_experiment",
            arguments: {
              action_type: "open_door",
              device_id: "feather-s3-01",
              location: "home-office",
              notes: "mcp verifier",
            },
          },
        },
        bearerSecret
      );
      assert.equal(loggedRes.status, 200);
      assert.equal(loggedRes.body.result?.isError, undefined);
      const loggedContent = (loggedRes.body.result?.content as Array<{ text: string }>) ?? [];
      const loggedPayload = JSON.parse(loggedContent[0].text) as {
        created: boolean;
        experiment: { id: string; status: string; source: string; created_by: string };
      };
      assert.equal(loggedPayload.created, true);
      assert.equal(loggedPayload.experiment.status, "active");
      assert.equal(loggedPayload.experiment.source, "mcp");
      assert.equal(loggedPayload.experiment.created_by, "mcp");

      const strictRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 66,
          method: "tools/call",
          params: {
            name: "log_experiment",
            arguments: {
              action_type: "open_door",
              device_id: "feather-s3-01",
              unexpected_field: "nope",
            },
          },
        },
        bearerSecret
      );
      assert.equal(strictRes.status, 200);
      assert.ok(
        strictRes.body.error ||
          (strictRes.body.result as { isError?: boolean } | undefined)?.isError,
        "Expected strict schema rejection for unknown log_experiment field"
      );

      const finishedRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 67,
          method: "tools/call",
          params: {
            name: "update_experiment",
            arguments: {
              experiment_id: loggedPayload.experiment.id,
              duration_minutes: 5,
            },
          },
        },
        bearerSecret
      );
      const finishedContent = (finishedRes.body.result?.content as Array<{ text: string }>) ?? [];
      const finishedPayload = JSON.parse(finishedContent[0].text) as {
        updated: boolean;
        experiment: { status: string; duration_minutes: number };
      };
      assert.equal(finishedPayload.updated, true);
      assert.equal(finishedPayload.experiment.status, "pending_evaluation");
      assert.equal(finishedPayload.experiment.duration_minutes, 5);

      const dismissedRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 68,
          method: "tools/call",
          params: {
            name: "update_experiment",
            arguments: {
              experiment_id: loggedPayload.experiment.id,
              status: "dismissed",
            },
          },
        },
        bearerSecret
      );
      const dismissedContent = (dismissedRes.body.result?.content as Array<{ text: string }>) ?? [];
      const dismissedPayload = JSON.parse(dismissedContent[0].text) as {
        experiment: { status: string };
      };
      assert.equal(dismissedPayload.experiment.status, "dismissed");

      const missingRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 69,
          method: "tools/call",
          params: {
            name: "update_experiment",
            arguments: {
              experiment_id: "exp_does_not_exist",
              status: "dismissed",
            },
          },
        },
        bearerSecret
      );
      const missingContent = (missingRes.body.result?.content as Array<{ text: string }>) ?? [];
      const missingPayload = JSON.parse(missingContent[0].text) as { found: boolean };
      assert.equal(missingPayload.found, false);

      const listRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: {
            name: "list_experiments",
            arguments: { status: "dismissed", device_id: "feather-s3-01" },
          },
        },
        bearerSecret
      );
      const listContent = (listRes.body.result?.content as Array<{ text: string }>) ?? [];
      const listPayload = JSON.parse(listContent[0].text) as {
        count: number;
        experiments: Array<{ id: string; status: string }>;
      };
      assert.ok(listPayload.experiments.some((experiment) => experiment.id === loggedPayload.experiment.id));
      assert.ok(listPayload.experiments.every((experiment) => experiment.status === "dismissed"));
    } else {
      const listRes = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: {
            name: "list_experiments",
            arguments: { limit: 5 },
          },
        },
        bearerSecret
      );
      assert.equal(listRes.status, 200);
      assert.equal(Boolean(listRes.body.result?.isError), false);
      const listContent = (listRes.body.result?.content as Array<{ text: string }>) ?? [];
      const listPayload = JSON.parse(listContent[0].text) as { count: number; experiments: unknown[] };
      assert.equal(typeof listPayload.count, "number");
      assert.ok(Array.isArray(listPayload.experiments));
    }
    console.log(
      `   [PASS] experiment tools -> playbook history=${playbookPayload.has_history}${isLive ? " (live read-only)" : ""}`
    );

    // 7c. Invalid device_id/location slug rejected by MCP tool schema
    const badSlugRes = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 62,
        method: "tools/call",
        params: {
          name: "get_latest_reading",
          arguments: { device_id: "../authorized_devices/uid" },
        },
      },
      bearerSecret
    );
    assert.equal(badSlugRes.status, 200);
    assert.ok(
      badSlugRes.body.error || (badSlugRes.body.result as { isError?: boolean } | undefined)?.isError,
      "Expected schema validation error for slash-containing device_id"
    );
    console.log("   [PASS] tools/call rejects slash-containing device_id slug");

    // 8. prompts/list & prompts/get
    const promptsList = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "prompts/list",
        params: {},
      },
      bearerSecret
    );
    assert.equal(promptsList.status, 200);
    const prompts = (promptsList.body.result?.prompts as Array<{ name: string }>) ?? [];
    assert.ok(prompts.some((p) => p.name === "analyze_indoor_air"));

    const promptGet = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "prompts/get",
        params: {
          name: "analyze_indoor_air",
          arguments: { location: "home-office", period: "24h" },
        },
      },
      bearerSecret
    );
    assert.equal(promptGet.status, 200);
    const promptMessages =
      (promptGet.body.result?.messages as Array<{ content: { text: string } }>) ?? [];
    assert.ok(promptMessages.length === 1);
    assert.ok(promptMessages[0].content.text.includes("get_latest_reading"));
    assert.ok(promptMessages[0].content.text.includes("get_ventilation_forecast"));
    assert.ok(promptMessages[0].content.text.includes("get_house_playbook"));
    assert.ok(promptMessages[0].content.text.includes("house-proven"));
    assert.ok(promptMessages[0].content.text.includes(THRESHOLDS_RESOURCE_URI));
    console.log("   [PASS] prompts/list & prompts/get -> analyze_indoor_air");

    // 9. resources/list & resources/read
    const resourcesList = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 9,
        method: "resources/list",
        params: {},
      },
      bearerSecret
    );
    assert.equal(resourcesList.status, 200);
    const resources = (resourcesList.body.result?.resources as Array<{ uri: string }>) ?? [];
    assert.ok(resources.some((r) => r.uri === THRESHOLDS_RESOURCE_URI));

    const resourceRead = await postMcp(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "resources/read",
        params: { uri: THRESHOLDS_RESOURCE_URI },
      },
      bearerSecret
    );
    assert.equal(resourceRead.status, 200);
    const resourceContents =
      (resourceRead.body.result?.contents as Array<{ uri: string; text: string }>) ?? [];
    assert.equal(resourceContents[0].uri, THRESHOLDS_RESOURCE_URI);
    assert.ok(resourceContents[0].text.includes("0.0 – 9.0"));
    assert.ok(resourceContents[0].text.includes("400 – 799 ppm"));
    console.log(`   [PASS] resources/list & resources/read -> ${THRESHOLDS_RESOURCE_URI}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function runSanitizedErrorCheck(): Promise<void> {
  const fakeReq = new EventEmitter() as IncomingMessage & { auth?: unknown };
  fakeReq.method = "POST";
  fakeReq.url = "/mcp";
  fakeReq.headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  Object.defineProperty(fakeReq, "auth", {
    get() {
      throw new Error("SECRET_INTERNAL_STACK_LEAK");
    },
  });

  let sentHeaders = false;
  let capturedBody = "";
  const fakeRes = new EventEmitter() as unknown as ServerResponse;
  fakeRes.statusCode = 200;
  Object.defineProperty(fakeRes, "headersSent", {
    get: () => sentHeaders,
  });
  fakeRes.setHeader = (() => fakeRes) as ServerResponse["setHeader"];
  fakeRes.end = ((chunk?: unknown) => {
    capturedBody =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : "";
    sentHeaders = true;
    fakeRes.emit("close");
    return fakeRes;
  }) as ServerResponse["end"];

  await handleStatelessMcpHttpRequest(fakeReq as IncomingMessage, fakeRes, {
    service: createMockAirQualityService(),
  });

  assert.equal(fakeRes.statusCode, 500);
  const body = JSON.parse(capturedBody || "{}") as {
    error?: { code?: number; message?: string };
  };
  assert.equal(body.error?.code, -32603);
  assert.equal(body.error?.message, "Internal server error");
  assert.equal(capturedBody.includes("SECRET_INTERNAL_STACK_LEAK"), false);
  console.log("   [PASS] Unhandled MCP error returns sanitized -32603 without leaking internal details");

  // Also verify tool-level unexpected exceptions are sanitized
  const baseService = createMockAirQualityService();
  const handler = createMcpHttpHandler({
    getAuthConfig: () => ({ bearerFallbackSecret: "test-bearer-secret" }),
    service: {
      ...baseService,
      getLatestReading: async () => {
        throw new Error("FIRESTORE_INTERNAL_PATH_SECRET");
      },
    },
  });
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const toolErrRes = await postMcp(
      `http://127.0.0.1:${port}`,
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_latest_reading", arguments: {} },
      },
      "test-bearer-secret"
    );
    assert.equal(toolErrRes.status, 200);
    const toolPayloadText = JSON.stringify(toolErrRes.body);
    assert.equal(toolPayloadText.includes("FIRESTORE_INTERNAL_PATH_SECRET"), false);
    assert.ok(toolPayloadText.includes("Internal server error while executing tool."));
    console.log("   [PASS] Tool-level unexpected error returns sanitized message");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function main(): Promise<void> {
  const runLive = process.argv.includes("--live");
  await runSuite("mock");
  await runSanitizedErrorCheck();

  if (runLive) {
    try {
      await runSuite("live");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n[FAIL] Live MCP verification failed: ${message}`);
      if (
        message.includes("PERMISSION_DENIED") &&
        process.env.GOOGLE_APPLICATION_CREDENTIALS
      ) {
        console.error(
          "\nHint: Clear GOOGLE_APPLICATION_CREDENTIALS to use your default ADC:\n" +
            "  GOOGLE_APPLICATION_CREDENTIALS= npm --prefix functions run verify:mcp -- --live"
        );
      }
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(
      "\nTip: Pass `--live` to verify MCP tool calls against live Cloud Firestore:"
    );
    console.log("  npm --prefix functions run verify:mcp -- --live");
  }

  console.log("\nAll MCP server verification checks passed!");
}

await main();
