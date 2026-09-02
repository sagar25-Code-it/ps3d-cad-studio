const SESSION_STORAGE_KEY = "ps3d.cloud.session.v1";

export interface PublicCloudConfig {
  readonly schema: "ps3d-public-cloud-config/1";
  readonly cloudAccess: "ready" | "setup-required";
  readonly authentication: string;
  readonly mcpEndpoint: string;
  readonly oauthIssuer: string | null;
  readonly oauthMcpAccess: "read-only";
  readonly protectedResourceMetadata: string;
  readonly tokenPrefix: string;
  readonly tokenSecretCharacters: number;
  readonly maximumActiveTokens: number;
  readonly tokenExpiryDays: readonly number[];
  readonly documentationUrl: string;
}

export interface CloudUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface CloudSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMs: number;
  readonly user: CloudUser;
}

export interface McpTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly token_prefix: string;
  readonly scopes: readonly string[];
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface CreatedMcpToken {
  readonly token: string;
  readonly shownOnce: true;
  readonly record: McpTokenRecord;
}

export class CloudApiError extends Error {
  public constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "CloudApiError";
  }
}

export async function fetchPublicCloudConfig(): Promise<PublicCloudConfig> {
  const response = await fetch("/api/public-config", { headers: { Accept: "application/json" }, cache: "no-store" });
  const value = await readResponse(response);
  if (!isRecord(value) || value.schema !== "ps3d-public-cloud-config/1" || typeof value.mcpEndpoint !== "string") {
    throw new CloudApiError("CONFIG_RESPONSE", "This deployment did not return a valid cloud-access configuration.", 502);
  }
  return value as unknown as PublicCloudConfig;
}

export async function signUp(email: string, password: string): Promise<{ readonly session?: CloudSession; readonly message: string }> {
  const value = await authRequest({ action: "sign-up", email, password });
  const session = sessionFromAuthValue(value);
  return session === undefined
    ? { message: "Account created. Check your email and verify it before signing in." }
    : { session: storeSession(session), message: "Account created and signed in." };
}

export async function signIn(email: string, password: string): Promise<CloudSession> {
  const value = await authRequest({ action: "sign-in", email, password });
  const session = sessionFromAuthValue(value);
  if (session === undefined) throw new CloudApiError("SESSION_RESPONSE", "The identity provider did not return a usable login session.", 502);
  return storeSession(session);
}

export async function refreshSession(session: CloudSession): Promise<CloudSession> {
  const value = await authRequest({ action: "refresh", refreshToken: session.refreshToken });
  const refreshed = sessionFromAuthValue(value, session.user);
  if (refreshed === undefined) throw new CloudApiError("SESSION_RESPONSE", "The identity provider did not return a usable refreshed session.", 502);
  return storeSession(refreshed);
}

export async function sessionUser(accessToken: string): Promise<CloudUser> {
  const value = await authRequest({ action: "user", accessToken });
  const user = userFromValue(value);
  if (user === undefined) throw new CloudApiError("USER_RESPONSE", "The identity provider did not return a valid user.", 502);
  return user;
}

export async function signOut(session: CloudSession): Promise<void> {
  try {
    await authRequest({ action: "sign-out", accessToken: session.accessToken }, true);
  } finally {
    clearStoredSession();
  }
}

export async function requestPasswordRecovery(email: string): Promise<string> {
  const value = await authRequest({ action: "recover", email });
  return isRecord(value) && typeof value.message === "string" ? value.message : "If the account exists, a password-reset email has been sent.";
}

export async function updatePassword(accessToken: string, password: string): Promise<void> {
  await authRequest({ action: "update-password", accessToken, password });
}

export async function listMcpTokens(session: CloudSession): Promise<readonly McpTokenRecord[]> {
  const current = await ensureFreshSession(session);
  const response = await fetch("/api/access-tokens", { headers: { Accept: "application/json", Authorization: `Bearer ${current.accessToken}` }, cache: "no-store" });
  const value = await readResponse(response);
  if (!isRecord(value) || !Array.isArray(value.tokens)) throw new CloudApiError("TOKEN_LIST_RESPONSE", "The token service returned an invalid list.", 502);
  return value.tokens.filter(isMcpTokenRecord);
}

export async function createMcpToken(session: CloudSession, input: { readonly name: string; readonly scopes: readonly string[]; readonly expiresInDays: number }): Promise<CreatedMcpToken> {
  const current = await ensureFreshSession(session);
  const response = await fetch("/api/access-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${current.accessToken}` },
    body: JSON.stringify(input)
  });
  const value = await readResponse(response);
  if (!isRecord(value) || typeof value.token !== "string" || value.shownOnce !== true || !isMcpTokenRecord(value.record)) {
    throw new CloudApiError("TOKEN_CREATE_RESPONSE", "The token service returned an invalid creation result.", 502);
  }
  return { token: value.token, shownOnce: true, record: value.record };
}

export async function revokeMcpToken(session: CloudSession, id: string): Promise<void> {
  const current = await ensureFreshSession(session);
  const response = await fetch("/api/access-tokens", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.accessToken}` },
    body: JSON.stringify({ id })
  });
  if (!response.ok) await readResponse(response);
}

export function loadStoredSession(): CloudSession | undefined {
  try {
    const recovery = recoverySessionFromLocation();
    if (recovery !== undefined) return storeSession(recovery);
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return isCloudSession(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeSession(session: CloudSession): CloudSession {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearStoredSession(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

export async function ensureFreshSession(session: CloudSession): Promise<CloudSession> {
  if (session.expiresAtMs - Date.now() > 90_000) return session;
  return refreshSession(session);
}

export function recoverySessionFromLocation(): CloudSession | undefined {
  if (location.hash.length < 2) return undefined;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const expiresIn = Number(fragment.get("expires_in") ?? "3600");
  if (fragment.get("type") !== "recovery" || accessToken === null || refreshToken === null || accessToken.length < 20 || refreshToken.length < 20 || !Number.isFinite(expiresIn)) return undefined;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return {
    accessToken,
    refreshToken,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
    user: { id: "recovery-pending", email: "Recovery session", emailVerified: true }
  };
}

async function authRequest(body: Readonly<Record<string, unknown>>, allowEmpty = false): Promise<unknown> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  if (allowEmpty && response.status === 204) return {};
  return readResponse(response);
}

async function readResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
      throw new CloudApiError(value.error.code, value.error.message, response.status);
    }
    throw new CloudApiError("REQUEST_FAILED", `The cloud request failed with status ${response.status}.`, response.status);
  }
  return value;
}

function sessionFromAuthValue(value: unknown, fallbackUser?: CloudUser): CloudSession | undefined {
  if (!isRecord(value) || typeof value.access_token !== "string" || typeof value.refresh_token !== "string") return undefined;
  const user = userFromValue(value.user) ?? fallbackUser;
  if (user === undefined) return undefined;
  const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) ? value.expires_in : 3600;
  const expiresAtMs = typeof value.expires_at === "number" && Number.isFinite(value.expires_at) ? value.expires_at * 1000 : Date.now() + expiresIn * 1000;
  return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAtMs, user };
}

function userFromValue(value: unknown): CloudUser | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string") return undefined;
  return {
    id: value.id,
    email: value.email,
    emailVerified: typeof value.email_confirmed_at === "string" || typeof value.confirmed_at === "string"
  };
}

function isCloudSession(value: unknown): value is CloudSession {
  return isRecord(value) && typeof value.accessToken === "string" && typeof value.refreshToken === "string" && typeof value.expiresAtMs === "number" && userFromValue(value.user) !== undefined;
}

function isMcpTokenRecord(value: unknown): value is McpTokenRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.token_prefix === "string"
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === "string")
    && typeof value.created_at === "string"
    && typeof value.expires_at === "string"
    && (value.last_used_at === null || typeof value.last_used_at === "string")
    && (value.revoked_at === null || typeof value.revoked_at === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
