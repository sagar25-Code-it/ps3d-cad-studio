export const MAX_API_JSON_BYTES = 64 * 1024;
export const MAX_MCP_JSON_BYTES = 1024 * 1024;

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function jsonResponse(value: unknown, status = 200, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

export function apiError(status: number, code: string, message: string, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  return jsonResponse({ error: { code, message } } satisfies ApiErrorBody, status, extraHeaders);
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return apiError(405, "METHOD_NOT_ALLOWED", `Use ${allowed.join(" or ")} for this endpoint.`, { Allow: allowed.join(", ") });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(request: Request, maxBytes = MAX_API_JSON_BYTES): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new RequestBodyError(415, "CONTENT_TYPE", "Send an application/json request body.");
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyError(413, "BODY_TOO_LARGE", `The request body exceeds ${maxBytes} bytes.`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new RequestBodyError(400, "EMPTY_BODY", "A JSON request body is required.");
  if (bytes.byteLength > maxBytes) throw new RequestBodyError(413, "BODY_TOO_LARGE", `The request body exceeds ${maxBytes} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestBodyError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!isRecord(value)) throw new RequestBodyError(400, "INVALID_BODY", "The request body must be one JSON object.");
  return value;
}

export class RequestBodyError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export function requestBodyErrorResponse(error: unknown): Response | undefined {
  return error instanceof RequestBodyError ? apiError(error.status, error.code, error.message) : undefined;
}

export function requireSameOrigin(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin === null) return apiError(403, "ORIGIN_REQUIRED", "Browser write requests must include an Origin header.");
  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = configuredPublicOrigin();
  if (origin !== requestOrigin && origin !== configuredOrigin) return apiError(403, "ORIGIN_REJECTED", "This browser origin is not allowed.");
  return undefined;
}

export function isAllowedMcpOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const requestOrigin = new URL(request.url).origin;
  return origin === requestOrigin || origin === configuredPublicOrigin();
}

export function configuredPublicOrigin(): string | undefined {
  const value = process.env.PUBLIC_APP_URL?.trim();
  if (value === undefined || value.length === 0) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match?.[1];
}

export function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

