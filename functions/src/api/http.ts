import type { ServerResponse } from "node:http";

import type { z } from "zod";

import type { IncomingApiRequest } from "./types.js";

const MAX_JSON_BODY_BYTES = 64 * 1024;

export class BodyReadError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!res.hasHeader("Cache-Control")) {
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(JSON.stringify(body));
}

export function sendMethodNotAllowed(
  res: ServerResponse,
  method: string,
  pathname: string
): void {
  sendJson(res, 405, {
    error: "method_not_allowed",
    message: `Method ${method} is not allowed for ${pathname}.`,
  });
}

export function parseQueryParams(req: IncomingApiRequest): URLSearchParams {
  const rawUrl = req.url ?? "/";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return parsed.searchParams;
  } catch {
    throw new BodyReadError(400, "invalid_request", "Malformed request query string.");
  }
}

export async function readJsonBody(req: IncomingApiRequest): Promise<unknown> {
  if (
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new BodyReadError(413, "payload_too_large", "Request JSON body exceeds 64 KB limit.");
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawText = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new BodyReadError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function formatZodError(error: z.ZodError): {
  error: string;
  message: string;
  issues: Array<{ path: string; message: string }>;
} {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join(".") || "(body)",
    message: issue.message,
  }));
  return {
    error: "validation_error",
    message: issues[0] ? `${issues[0].path}: ${issues[0].message}` : "Invalid request payload.",
    issues,
  };
}

/**
 * Reads a JSON request body and validates it against `schema`, writing the
 * appropriate 400/413 JSON response and returning `null` on failure.
 */
export async function parseValidatedJsonBody<T>(
  req: IncomingApiRequest,
  res: ServerResponse,
  schema: z.ZodType<T>
): Promise<T | null> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyReadError) {
      sendJson(res, err.statusCode, { error: err.code, message: err.message });
      return null;
    }
    throw err;
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, formatZodError(parsed.error));
    return null;
  }

  return parsed.data;
}
