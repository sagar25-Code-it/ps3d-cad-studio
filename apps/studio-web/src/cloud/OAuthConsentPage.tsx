import { useEffect, useState } from "react";
import { CloudApiError, ensureFreshSession, loadStoredSession, type CloudSession } from "./auth-client.js";
import { PublicPageHeader } from "./PublicPageHeader.js";

interface ConsentDetails {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export function OAuthConsentPage(): React.JSX.Element {
  const authorizationId = new URLSearchParams(location.search).get("authorization_id");
  const [session, setSession] = useState<CloudSession | undefined>(() => loadStoredSession());
  const [details, setDetails] = useState<ConsentDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (session === undefined || authorizationId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await ensureFreshSession(session);
        if (!cancelled) setSession(current);
        const response = await fetch(`/api/oauth-consent?authorization_id=${encodeURIComponent(authorizationId)}`, { headers: { Authorization: `Bearer ${current.accessToken}`, Accept: "application/json" }, cache: "no-store" });
        const value: unknown = await response.json();
        if (!response.ok) throw apiFailure(value, response.status);
        if (!cancelled) setDetails(normalizeConsent(value));
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "The authorization request could not be loaded."); }
    })();
    return () => { cancelled = true; };
  }, [authorizationId]);

  const decide = async (action: "approve" | "deny"): Promise<void> => {
    if (session === undefined || authorizationId === null || busy) return;
    setBusy(true); setError(undefined);
    try {
      const current = await ensureFreshSession(session);
      const response = await fetch("/api/oauth-consent", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.accessToken}`, Accept: "application/json" }, body: JSON.stringify({ authorizationId, action }) });
      const value: unknown = await response.json();
      if (!response.ok) throw apiFailure(value, response.status);
      const redirect = redirectFromConsent(value);
      if (redirect === undefined) throw new Error("The authorization server did not provide a safe redirect URL.");
      location.assign(redirect);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The authorization decision failed."); setBusy(false); }
  };

  const returnTarget = `/oauth/consent${location.search}`;
  return <main className="public-page consent-page"><PublicPageHeader active="access" /><section className="consent-shell"><div className="consent-card"><span className="eyebrow">OAUTH 2.1 AUTHORIZATION</span><h1>Connect an AI client to PS3D?</h1>{authorizationId === null ? <p className="consent-error">This link has no authorization request identifier.</p> : session === undefined ? <><p>Sign in with the PS3D account that should own this AI connection. Your password is never shared with the requesting client.</p><a className="primary portal-primary link-button" href={`/access?return=${encodeURIComponent(returnTarget)}`}>Sign in to continue</a></> : details === undefined ? <p>{error ?? "Loading verified client details..."}</p> : <><div className="consent-client"><span>Requesting client</span><strong>{details.clientName}</strong><small>{details.redirectUri}</small></div><h2>This client is asking to:</h2><ul><li>Discover PS3D engineering tools and capability boundaries</li><li>Inspect project data that you explicitly provide to the client</li></ul><p className="consent-scopes">OAuth access is read-only. Create a separately scoped personal MCP token when this client must preview or return confirmed CAD changes.</p><div className="consent-scopes">Identity scopes: {details.scopes.length === 0 ? "openid, email" : details.scopes.join(", ")}</div>{error !== undefined && <p className="consent-error">{error}</p>}<footer><button onClick={() => void decide("deny")} disabled={busy}>Deny</button><button className="primary" onClick={() => void decide("approve")} disabled={busy}>{busy ? "Working..." : "Approve read-only connection"}</button></footer></>}</div><aside><strong>PS3D never gives the client your password.</strong><p>The client receives a revocable, read-only access token from the identity provider. The remote MCP server validates it for each request and stores no CAD project payload.</p></aside></section></main>;
}

function normalizeConsent(value: unknown): ConsentDetails {
  const record = isRecord(value) && isRecord(value.authorization) ? value.authorization : value;
  if (!isRecord(record)) throw new Error("The authorization server returned invalid consent details.");
  const client = isRecord(record.client) ? record.client : undefined;
  const clientName = typeof record.client_name === "string" ? record.client_name : typeof client?.name === "string" ? client.name : "External AI client";
  const redirectUri = typeof record.redirect_uri === "string" ? record.redirect_uri : "Registered redirect URI";
  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === "string") : typeof record.scope === "string" ? record.scope.split(/\s+/u).filter(Boolean) : [];
  return { clientName, redirectUri, scopes };
}

function redirectFromConsent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = typeof value.redirect_url === "string" ? value.redirect_url : typeof value.redirect_uri === "string" ? value.redirect_uri : undefined;
  return safeOAuthConsentRedirect(candidate);
}

export function safeOAuthConsentRedirect(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;
    const loopback = parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function apiFailure(value: unknown, status: number): Error {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
    ? new CloudApiError(typeof value.error.code === "string" ? value.error.code : "OAUTH_ERROR", value.error.message, status)
    : new Error(`The authorization service returned ${status}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
