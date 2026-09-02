import { CloudConfigurationError, cloudConfigurationErrorResponse, loadCloudEnvironment, supabaseAuthFetch } from "./_lib/cloud.js";
import { apiError, assertExactKeys, isRecord, methodNotAllowed, publicRequestOrigin, readJsonObject, requestBodyErrorResponse, requireSameOrigin } from "./_lib/http.js";

type AuthAction = "sign-up" | "sign-in" | "refresh" | "sign-out" | "recover" | "update-password" | "user";

async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const originError = requireSameOrigin(request);
  if (originError !== undefined) return originError;
  try {
    const env = loadCloudEnvironment();
    const body = await readJsonObject(request);
    if (typeof body.action !== "string") return apiError(400, "AUTH_ACTION", "Choose a supported authentication action.");
    const action = body.action as AuthAction;
    if (!(["sign-up", "sign-in", "refresh", "sign-out", "recover", "update-password", "user"] as readonly string[]).includes(action)) {
      return apiError(400, "AUTH_ACTION", "Choose a supported authentication action.");
    }
    if (action === "sign-up" || action === "sign-in") return emailPasswordAction(request, env, body, action);
    if (action === "refresh") return refreshAction(env, body);
    if (action === "sign-out") return signOutAction(env, body);
    if (action === "recover") return recoverAction(request, env, body);
    if (action === "user") return userAction(env, body);
    return updatePasswordAction(env, body);
  } catch (error) {
    return requestBodyErrorResponse(error) ?? cloudConfigurationErrorResponse(error) ?? unexpectedAuthError(error);
  }
}

export default { fetch: handler };

async function userAction(env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>): Promise<Response> {
  if (!assertExactKeys(body, ["action", "accessToken"]) || typeof body.accessToken !== "string" || body.accessToken.length < 20 || body.accessToken.length > 4096) {
    return apiError(400, "ACCESS_TOKEN", "A valid access token is required.");
  }
  return forwardAuthResponse(await supabaseAuthFetch(env, "/user", { method: "GET", headers: { Authorization: `Bearer ${body.accessToken}` } }));
}

async function emailPasswordAction(request: Request, env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>, action: "sign-up" | "sign-in"): Promise<Response> {
  if (!assertExactKeys(body, ["action", "email", "password"])) return apiError(400, "AUTH_FIELDS", "The authentication request contains unsupported fields.");
  const email = normalizeEmail(body.email);
  const password = normalizePassword(body.password);
  if (email === undefined) return apiError(400, "EMAIL_INVALID", "Enter a valid email address no longer than 254 characters.");
  if (password === undefined) return apiError(400, "PASSWORD_POLICY", "Use a password from 12 to 128 characters.");
  const publicOrigin = publicRequestOrigin(request);
  const verificationRedirect = `${publicOrigin}/access?verified=1`;
  const path = action === "sign-up"
    ? `/signup?redirect_to=${encodeURIComponent(verificationRedirect)}`
    : "/token?grant_type=password";
  const payload = action === "sign-up"
    ? { email, password, data: {} }
    : { email, password };
  return forwardAuthResponse(await supabaseAuthFetch(env, path, { method: "POST", body: JSON.stringify(payload) }));
}

async function refreshAction(env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>): Promise<Response> {
  if (!assertExactKeys(body, ["action", "refreshToken"]) || typeof body.refreshToken !== "string" || body.refreshToken.length < 20 || body.refreshToken.length > 4096) {
    return apiError(400, "REFRESH_TOKEN", "A valid refresh token is required.");
  }
  return forwardAuthResponse(await supabaseAuthFetch(env, "/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: body.refreshToken }) }));
}

async function signOutAction(env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>): Promise<Response> {
  if (!assertExactKeys(body, ["action", "accessToken"]) || typeof body.accessToken !== "string" || body.accessToken.length < 20 || body.accessToken.length > 4096) {
    return apiError(400, "ACCESS_TOKEN", "A valid access token is required.");
  }
  const response = await supabaseAuthFetch(env, "/logout", { method: "POST", headers: { Authorization: `Bearer ${body.accessToken}` }, body: "{}" });
  if (!response.ok) return forwardAuthResponse(response);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function recoverAction(request: Request, env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>): Promise<Response> {
  if (!assertExactKeys(body, ["action", "email"])) return apiError(400, "AUTH_FIELDS", "The recovery request contains unsupported fields.");
  const email = normalizeEmail(body.email);
  if (email === undefined) return apiError(400, "EMAIL_INVALID", "Enter a valid email address.");
  const redirectTo = `${publicRequestOrigin(request)}/access?recovery=1`;
  const response = await supabaseAuthFetch(env, `/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: "POST", body: JSON.stringify({ email }) });
  if (!response.ok) return forwardAuthResponse(response);
  return Response.json({ message: "If the account exists, a password-reset email has been sent." }, { headers: { "Cache-Control": "no-store" } });
}

async function updatePasswordAction(env: ReturnType<typeof loadCloudEnvironment>, body: Readonly<Record<string, unknown>>): Promise<Response> {
  if (!assertExactKeys(body, ["action", "accessToken", "password"]) || typeof body.accessToken !== "string" || body.accessToken.length < 20 || body.accessToken.length > 4096) {
    return apiError(400, "ACCESS_TOKEN", "A valid recovery access token is required.");
  }
  const password = normalizePassword(body.password);
  if (password === undefined) return apiError(400, "PASSWORD_POLICY", "Use a password from 12 to 128 characters.");
  return forwardAuthResponse(await supabaseAuthFetch(env, "/user", {
    method: "PUT",
    headers: { Authorization: `Bearer ${body.accessToken}` },
    body: JSON.stringify({ password })
  }));
}

async function forwardAuthResponse(response: Response): Promise<Response> {
  const value: unknown = await response.json().catch(() => ({ message: "The identity provider returned an unreadable response." }));
  if (response.ok) return Response.json(value, { status: response.status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const message = isRecord(value) && typeof (value.msg ?? value.message ?? value.error_description) === "string"
    ? String(value.msg ?? value.message ?? value.error_description)
    : "Authentication failed.";
  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  return apiError(status, "IDENTITY_REJECTED", message.slice(0, 300));
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return undefined;
  return email;
}

function normalizePassword(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 12 && value.length <= 128 ? value : undefined;
}

function unexpectedAuthError(error: unknown): Response {
  if (error instanceof CloudConfigurationError) return apiError(503, "CLOUD_NOT_CONFIGURED", error.message);
  return apiError(502, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable.");
}
