import {
  authenticateUserRequest,
  cloudConfigurationErrorResponse,
  generatePersonalAccessToken,
  hashPersonalAccessToken,
  loadCloudEnvironment,
  normalizeScopes,
  supabaseAdminFetch
} from "./_lib/cloud.js";
import { apiError, assertExactKeys, isRecord, jsonResponse, methodNotAllowed, readJsonObject, requestBodyErrorResponse, requireSameOrigin } from "./_lib/http.js";
import { tokenStoreErrorResponse } from "./_lib/token-store-error.js";

const ALLOWED_EXPIRY_DAYS = [7, 30, 90] as const;

async function handler(request: Request): Promise<Response> {
  if (!(request.method === "GET" || request.method === "POST" || request.method === "DELETE")) return methodNotAllowed(["GET", "POST", "DELETE"]);
  if (request.method !== "GET") {
    const originError = requireSameOrigin(request);
    if (originError !== undefined) return originError;
  }
  try {
    const env = loadCloudEnvironment();
    const user = await authenticateUserRequest(request, env);
    if (user instanceof Response) return user;
    if (!user.emailVerified) return apiError(403, "EMAIL_NOT_VERIFIED", "Verify the account email before creating MCP access tokens.");
    if (request.method === "GET") return listTokens(user.id, env);
    const body = await readJsonObject(request);
    if (request.method === "DELETE") return revokeToken(user.id, body, env);
    return createToken(user.id, body, env);
  } catch (error) {
    return requestBodyErrorResponse(error) ?? cloudConfigurationErrorResponse(error) ?? apiError(502, "TOKEN_SERVICE_UNAVAILABLE", "The token service is temporarily unavailable.");
  }
}

export default { fetch: handler };

async function listTokens(userId: string, env: ReturnType<typeof loadCloudEnvironment>): Promise<Response> {
  const query = `/mcp_tokens?user_id=eq.${encodeURIComponent(userId)}&select=id,name,token_prefix,scopes,created_at,expires_at,last_used_at,revoked_at&order=created_at.desc&limit=20`;
  const response = await supabaseAdminFetch(env, query, { method: "GET" });
  if (!response.ok) return tokenStoreErrorResponse(response, "list");
  const value: unknown = await response.json().catch(() => undefined);
  if (!Array.isArray(value)) return apiError(502, "TOKEN_LIST_RESPONSE", "The token store returned an invalid response.");
  return jsonResponse({ schema: "ps3d-mcp-token-list/1", tokens: value });
}

async function createToken(userId: string, body: Readonly<Record<string, unknown>>, env: ReturnType<typeof loadCloudEnvironment>): Promise<Response> {
  if (!assertExactKeys(body, ["name", "scopes", "expiresInDays"])) return apiError(400, "TOKEN_FIELDS", "The token request contains unsupported fields.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) return apiError(400, "TOKEN_NAME", "Use a token name from 2 to 60 visible characters.");
  const scopes = normalizeScopes(body.scopes);
  if (scopes === undefined) return apiError(400, "TOKEN_SCOPES", "Choose a valid scope set that includes mcp:read.");
  if (typeof body.expiresInDays !== "number" || !ALLOWED_EXPIRY_DAYS.includes(body.expiresInDays as (typeof ALLOWED_EXPIRY_DAYS)[number])) {
    return apiError(400, "TOKEN_EXPIRY", "Choose a token lifetime of 7, 30, or 90 days.");
  }
  const rawToken = generatePersonalAccessToken();
  const tokenHash = hashPersonalAccessToken(rawToken, env.tokenPepper);
  const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
  const tokenPrefix = `${rawToken.slice(0, 18)}...${rawToken.slice(-4)}`;
  const response = await supabaseAdminFetch(env, "/mcp_tokens", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, name, token_hash: tokenHash, token_prefix: tokenPrefix, scopes, expires_at: expiresAt })
  });
  if (!response.ok) return tokenStoreErrorResponse(response, "create");
  const value: unknown = await response.json().catch(() => undefined);
  const created = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(created) || typeof created.id !== "string") return apiError(502, "TOKEN_CREATE_RESPONSE", "The token store returned an invalid creation response.");
  return jsonResponse({
    schema: "ps3d-mcp-token-created/1",
    token: rawToken,
    shownOnce: true,
    record: {
      id: created.id,
      name,
      token_prefix: tokenPrefix,
      scopes,
      created_at: created.created_at,
      expires_at: expiresAt,
      last_used_at: null,
      revoked_at: null
    }
  }, 201);
}

async function revokeToken(userId: string, body: Readonly<Record<string, unknown>>, env: ReturnType<typeof loadCloudEnvironment>): Promise<Response> {
  if (!assertExactKeys(body, ["id"]) || typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.id)) return apiError(400, "TOKEN_ID", "A valid token identifier is required.");
  const response = await supabaseAdminFetch(env, `/mcp_tokens?id=eq.${encodeURIComponent(body.id)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ revoked_at: new Date().toISOString() })
  });
  if (!response.ok) return tokenStoreErrorResponse(response, "revoke");
  const value: unknown = await response.json().catch(() => undefined);
  if (!Array.isArray(value) || value.length !== 1) return apiError(404, "TOKEN_NOT_FOUND", "The active token was not found.");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
