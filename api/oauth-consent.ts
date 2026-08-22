import { cloudConfigurationErrorResponse, loadCloudEnvironment, supabaseAuthFetch } from "./_lib/cloud.js";
import { apiError, assertExactKeys, bearerToken, isRecord, jsonResponse, methodNotAllowed, readJsonObject, requestBodyErrorResponse, requireSameOrigin } from "./_lib/http.js";

async function handler(request: Request): Promise<Response> {
  if (!(request.method === "GET" || request.method === "POST")) return methodNotAllowed(["GET", "POST"]);
  if (request.method === "POST") {
    const originError = requireSameOrigin(request);
    if (originError !== undefined) return originError;
  }
  try {
    const env = loadCloudEnvironment();
    const token = bearerToken(request);
    if (token === undefined || token.length > 4096) return apiError(401, "LOGIN_REQUIRED", "Sign in before reviewing an OAuth authorization request.");
    if (request.method === "GET") {
      const authorizationId = new URL(request.url).searchParams.get("authorization_id");
      if (!validAuthorizationId(authorizationId)) return apiError(400, "AUTHORIZATION_ID", "A valid authorization request identifier is required.");
      return forward(await supabaseAuthFetch(env, `/oauth/authorizations/${encodeURIComponent(authorizationId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      }));
    }
    const body = await readJsonObject(request);
    if (!assertExactKeys(body, ["authorizationId", "action"]) || !validAuthorizationId(body.authorizationId) || !(body.action === "approve" || body.action === "deny")) {
      return apiError(400, "CONSENT_REQUEST", "Choose approve or deny for a valid authorization request.");
    }
    return forward(await supabaseAuthFetch(env, `/oauth/authorizations/${encodeURIComponent(body.authorizationId)}/consent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: body.action })
    }));
  } catch (error) {
    return requestBodyErrorResponse(error) ?? cloudConfigurationErrorResponse(error) ?? apiError(502, "CONSENT_UNAVAILABLE", "OAuth consent is temporarily unavailable.");
  }
}

export default { fetch: handler };

function validAuthorizationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 200 && /^[A-Za-z0-9._~-]+$/u.test(value);
}

async function forward(response: Response): Promise<Response> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(value) && typeof (value.message ?? value.msg ?? value.error_description) === "string"
      ? String(value.message ?? value.msg ?? value.error_description)
      : "The authorization request could not be processed.";
    return apiError(response.status >= 400 && response.status < 500 ? response.status : 502, "OAUTH_REJECTED", message.slice(0, 300));
  }
  return jsonResponse(value);
}
