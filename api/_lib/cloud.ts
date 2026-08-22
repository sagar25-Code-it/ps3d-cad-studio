import { createHmac, randomBytes } from "node:crypto";
import { apiError, bearerToken, isRecord } from "./http.js";

export interface CloudEnvironment {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly adminKey: string;
  readonly tokenPepper: string;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface McpPrincipal {
  readonly userId: string;
  readonly actorHash: string;
  readonly tokenId?: string;
  readonly scopes: readonly McpScope[];
  readonly kind: "personal-access-token" | "oauth-access-token";
}

export type McpScope = "mcp:read" | "mcp:preview" | "mcp:apply";

export const MCP_SCOPES: readonly McpScope[] = ["mcp:read", "mcp:preview", "mcp:apply"];
export const PERSONAL_TOKEN_PATTERN = /^ps3d_mcp_[a-f0-9]{64}$/u;

export class CloudConfigurationError extends Error {
  public constructor(message = "Cloud access is not configured for this deployment.") {
    super(message);
    this.name = "CloudConfigurationError";
  }
}

export function loadCloudEnvironment(): CloudEnvironment {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const publishableKey = firstEnvironmentValue("SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
  const adminKey = firstEnvironmentValue("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  const tokenPepper = firstEnvironmentValue("MCP_TOKEN_PEPPER");
  if (supabaseUrl === undefined || publishableKey === undefined || adminKey === undefined || tokenPepper === undefined || tokenPepper.length < 32) {
    throw new CloudConfigurationError();
  }
  return { supabaseUrl, publishableKey, adminKey, tokenPepper };
}

export function cloudIsConfigured(): boolean {
  try {
    loadCloudEnvironment();
    return true;
  } catch {
    return false;
  }
}

function normalizeSupabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) return undefined;
    parsed.pathname = parsed.pathname.replace(/\/$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function firstEnvironmentValue(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

export function cloudConfigurationErrorResponse(error: unknown): Response | undefined {
  return error instanceof CloudConfigurationError ? apiError(503, "CLOUD_NOT_CONFIGURED", error.message) : undefined;
}

export async function supabaseAuthFetch(env: CloudEnvironment, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.supabaseUrl}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: env.publishableKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
    redirect: "manual"
  });
}

export async function supabaseAdminFetch(env: CloudEnvironment, path: string, init: RequestInit = {}): Promise<Response> {
  const serviceAuthorization = env.adminKey.startsWith("sb_secret_")
    ? {}
    : { Authorization: `Bearer ${env.adminKey}` };
  return fetch(`${env.supabaseUrl}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: env.adminKey,
      ...serviceAuthorization,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
    redirect: "manual"
  });
}

export async function authenticateUserRequest(request: Request, env: CloudEnvironment): Promise<AuthenticatedUser | Response> {
  const token = bearerToken(request);
  if (token === undefined || token.length > 4096) return apiError(401, "LOGIN_REQUIRED", "Sign in before using this endpoint.");
  return authenticateSupabaseToken(token, env);
}

export async function authenticateSupabaseToken(token: string, env: CloudEnvironment): Promise<AuthenticatedUser | Response> {
  const response = await supabaseAuthFetch(env, "/user", { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return apiError(401, "SESSION_INVALID", "The login session is invalid or expired.");
  const value: unknown = await response.json().catch(() => undefined);
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string") return apiError(502, "IDENTITY_RESPONSE", "The identity provider returned an invalid user record.");
  const verified = typeof value.email_confirmed_at === "string" || typeof value.confirmed_at === "string";
  return { id: value.id, email: value.email, emailVerified: verified };
}

export function generatePersonalAccessToken(): string {
  return `ps3d_mcp_${randomBytes(32).toString("hex")}`;
}

export function hashPersonalAccessToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

export function normalizeScopes(value: unknown): readonly McpScope[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MCP_SCOPES.length) return undefined;
  const set = new Set<McpScope>();
  for (const scope of value) {
    if (typeof scope !== "string" || !(MCP_SCOPES as readonly string[]).includes(scope)) return undefined;
    set.add(scope as McpScope);
  }
  if (!set.has("mcp:read")) return undefined;
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

export async function authenticateMcpRequest(request: Request, env: CloudEnvironment): Promise<McpPrincipal | Response> {
  const token = bearerToken(request);
  if (token === undefined || token.length > 4096) return mcpUnauthorized(request, "Provide a PS3D personal token or OAuth access token.");
  if (token.startsWith("ps3d_mcp_")) return authenticatePersonalToken(token, request, env);
  const user = await authenticateSupabaseToken(token, env);
  if (user instanceof Response) return mcpUnauthorized(request, "The OAuth access token is invalid or expired.");
  if (!user.emailVerified) return mcpUnauthorized(request, "Verify the account email before using MCP.");
  return {
    userId: user.id,
    actorHash: hashPersonalAccessToken(`oauth:${user.id}`, env.tokenPepper),
    scopes: MCP_SCOPES,
    kind: "oauth-access-token"
  };
}

async function authenticatePersonalToken(token: string, request: Request, env: CloudEnvironment): Promise<McpPrincipal | Response> {
  if (!PERSONAL_TOKEN_PATTERN.test(token)) return mcpUnauthorized(request, "The PS3D personal token format is invalid.");
  const tokenHash = hashPersonalAccessToken(token, env.tokenPepper);
  const query = `/mcp_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&revoked_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,user_id,scopes&limit=1`;
  const response = await supabaseAdminFetch(env, query, { method: "GET" });
  if (!response.ok) return apiError(503, "TOKEN_LOOKUP_FAILED", "Token validation is temporarily unavailable.");
  const value: unknown = await response.json().catch(() => undefined);
  const record = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(record) || typeof record.id !== "string" || typeof record.user_id !== "string") return mcpUnauthorized(request, "The PS3D personal token is invalid, expired, or revoked.");
  const scopes = normalizeScopes(record.scopes);
  if (scopes === undefined) return mcpUnauthorized(request, "The PS3D personal token has an invalid scope set.");
  return { userId: record.user_id, actorHash: tokenHash, tokenId: record.id, scopes, kind: "personal-access-token" };
}

export async function consumeMcpQuota(principal: McpPrincipal, env: CloudEnvironment): Promise<{ readonly allowed: boolean; readonly remaining: number; readonly resetAt: string } | Response> {
  const response = await supabaseAdminFetch(env, "/rpc/consume_mcp_quota", {
    method: "POST",
    body: JSON.stringify({ p_actor_hash: principal.actorHash, p_limit: 60 })
  });
  if (!response.ok) return apiError(503, "RATE_LIMIT_UNAVAILABLE", "The abuse-control service is temporarily unavailable.");
  const value: unknown = await response.json().catch(() => undefined);
  const record = Array.isArray(value) ? value[0] : value;
  if (!isRecord(record) || typeof record.allowed !== "boolean" || typeof record.remaining !== "number" || typeof record.reset_at !== "string") {
    return apiError(503, "RATE_LIMIT_RESPONSE", "The abuse-control service returned an invalid result.");
  }
  return { allowed: record.allowed, remaining: record.remaining, resetAt: record.reset_at };
}

export async function recordTokenUse(principal: McpPrincipal, env: CloudEnvironment): Promise<void> {
  if (principal.tokenId === undefined) return;
  await supabaseAdminFetch(env, `/mcp_tokens?id=eq.${encodeURIComponent(principal.tokenId)}&user_id=eq.${encodeURIComponent(principal.userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_used_at: new Date().toISOString() })
  }).catch(() => undefined);
}

export function hasMcpScope(principal: McpPrincipal, scope: McpScope): boolean {
  return principal.scopes.includes(scope);
}

export function mcpUnauthorized(request: Request, message: string): Response {
  const metadataUrl = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return apiError(401, "MCP_AUTH_REQUIRED", message, {
    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`
  });
}
