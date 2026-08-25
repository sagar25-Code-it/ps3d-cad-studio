import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CloudApiError,
  clearStoredSession,
  createMcpToken,
  ensureFreshSession,
  fetchPublicCloudConfig,
  listMcpTokens,
  loadStoredSession,
  requestPasswordRecovery,
  revokeMcpToken,
  sessionUser,
  signIn,
  signOut,
  signUp,
  storeSession,
  updatePassword,
  type CloudSession,
  type CreatedMcpToken,
  type McpTokenRecord,
  type PublicCloudConfig
} from "./auth-client.js";
import { BrandFooter } from "./BrandFooter.js";
import { PublicPageHeader } from "./PublicPageHeader.js";

type AuthMode = "sign-in" | "sign-up";

export function AccessPortal(): React.JSX.Element {
  const [config, setConfig] = useState<PublicCloudConfig>();
  const [configError, setConfigError] = useState<string>();
  const [session, setSession] = useState<CloudSession | undefined>(() => loadStoredSession());
  const [tokens, setTokens] = useState<readonly McpTokenRecord[]>([]);
  const [created, setCreated] = useState<CreatedMcpToken>();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [tokenName, setTokenName] = useState("My AI workspace");
  const [expiry, setExpiry] = useState(30);
  const [scopes, setScopes] = useState<readonly string[]>(["mcp:read", "mcp:preview"]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const recoveryMode = new URLSearchParams(location.search).get("recovery") === "1" || session?.user.id === "recovery-pending";

  useEffect(() => {
    void fetchPublicCloudConfig().then(setConfig).catch((cause: unknown) => {
      setConfigError(messageFrom(cause, "Cloud access is not available in this local or unconfigured deployment."));
    });
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        let current = await ensureFreshSession(session);
        if (current.user.id === "recovery-pending") {
          const user = await sessionUser(current.accessToken);
          current = storeSession({ ...current, user });
        }
        if (cancelled) return;
        setSession(current);
        if (!recoveryMode) setTokens(await listMcpTokens(current));
      } catch (cause) {
        if (!cancelled) {
          clearStoredSession();
          setSession(undefined);
          setError(messageFrom(cause, "The saved login session expired. Sign in again."));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const jsonConfig = useMemo(() => created === undefined || config === undefined ? "" : JSON.stringify({
    mcpServers: { ps3d: { url: config.mcpEndpoint, headers: { Authorization: `Bearer ${created.token}` } } }
  }, null, 2), [config, created]);
  const tomlConfig = useMemo(() => created === undefined || config === undefined ? "" : `[mcp_servers.ps3d]\nurl = "${config.mcpEndpoint}"\n\n[mcp_servers.ps3d.http_headers]\nAuthorization = "Bearer ${created.token}"`, [config, created]);

  const submitAuth = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined); setFeedback(undefined);
    try {
      if (mode === "sign-up") {
        const result = await signUp(email, password);
        setFeedback(result.message);
        if (result.session !== undefined) setSession(result.session);
      } else {
        const current = await signIn(email, password);
        setSession(current);
        setPassword("");
        const returnTo = safeReturnTarget(new URLSearchParams(location.search).get("return"));
        if (returnTo !== undefined) { location.assign(returnTo); return; }
        setTokens(await listMcpTokens(current));
        setFeedback("Signed in. Your browser session is kept only in this tab.");
      }
    } catch (cause) { setError(messageFrom(cause, "Authentication failed.")); }
    finally { setBusy(false); }
  };

  const recover = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { setFeedback(await requestPasswordRecovery(email)); }
    catch (cause) { setError(messageFrom(cause, "Password recovery could not be started.")); }
    finally { setBusy(false); }
  };

  const commitNewPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (session === undefined || busy) return;
    setBusy(true); setError(undefined);
    try {
      await updatePassword(session.accessToken, newPassword);
      setNewPassword("");
      setFeedback("Password updated. You can now create and manage MCP tokens.");
      location.replace("/access");
    } catch (cause) { setError(messageFrom(cause, "The password could not be updated.")); }
    finally { setBusy(false); }
  };

  const issueToken = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (session === undefined || busy) return;
    setBusy(true); setError(undefined); setCreated(undefined);
    try {
      const result = await createMcpToken(session, { name: tokenName, scopes, expiresInDays: expiry });
      setCreated(result);
      const current = loadStoredSession() ?? session;
      setSession(current);
      setTokens(await listMcpTokens(current));
      setFeedback("Token created. Copy it now; PS3D cannot retrieve the raw value later.");
    } catch (cause) { setError(messageFrom(cause, "The MCP token could not be created.")); }
    finally { setBusy(false); }
  };

  const revoke = async (record: McpTokenRecord): Promise<void> => {
    if (session === undefined || busy || !confirm(`Revoke ${record.name}? Any AI client using it will disconnect immediately.`)) return;
    setBusy(true); setError(undefined);
    try {
      await revokeMcpToken(session, record.id);
      const current = loadStoredSession() ?? session;
      setSession(current);
      setTokens(await listMcpTokens(current));
      setFeedback(`${record.name} was revoked.`);
    } catch (cause) { setError(messageFrom(cause, "The MCP token could not be revoked.")); }
    finally { setBusy(false); }
  };

  const logout = async (): Promise<void> => {
    if (session === undefined || busy) return;
    setBusy(true);
    try { await signOut(session); }
    catch { clearStoredSession(); }
    finally { setCreated(undefined); setTokens([]); setSession(undefined); setBusy(false); }
  };

  return <main className="public-page access-page">
    <PublicPageHeader active="access" />
    <section className="public-hero access-hero">
      <div><span className="eyebrow">SECURE AI CONNECTION</span><h1>Your account. Your MCP access.</h1><p>Connect an AI host to PS3D without sharing a password or a common global key. Every personal token is unique, scoped, expiring, and independently revocable.</p></div>
      <div className={`cloud-readiness ${config?.cloudAccess === "ready" ? "ready" : "setup"}`}><span />{config?.cloudAccess === "ready" ? "Cloud access ready" : "Deployment setup required"}</div>
    </section>

    {configError !== undefined && <section className="portal-notice warning"><strong>Local preview boundary</strong><p>{configError}</p><p>The CAD workbench remains usable locally. Account creation is deliberately disabled until the production environment is configured.</p></section>}
    {config?.cloudAccess === "setup-required" && <SetupRequired />}
    {error !== undefined && <div className="portal-feedback error" role="alert"><strong>Action stopped</strong><span>{error}</span><button onClick={() => setError(undefined)}>Dismiss</button></div>}
    {feedback !== undefined && <div className="portal-feedback success" role="status"><strong>Complete</strong><span>{feedback}</span><button onClick={() => setFeedback(undefined)}>Dismiss</button></div>}

    {session === undefined && <section className="auth-layout">
      <div className="auth-card">
        <div className="auth-tabs" role="tablist"><button className={mode === "sign-in" ? "active" : ""} onClick={() => setMode("sign-in")}>Sign in</button><button className={mode === "sign-up" ? "active" : ""} onClick={() => setMode("sign-up")}>Create account</button></div>
        <form onSubmit={(event) => void submitAuth(event)}>
          <label>Email <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></label>
          <label>Password <input type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} required /></label>
          <small>{mode === "sign-up" ? "Use 12-128 characters. Your email is your unique login ID and must be verified." : "The password is used only for web login. Never paste it into MCP configuration."}</small>
          <button className="primary portal-primary" disabled={busy || config?.cloudAccess !== "ready"}>{busy ? "Working..." : mode === "sign-up" ? "Create secure account" : "Sign in"}</button>
          {mode === "sign-in" && <button type="button" className="text-action" onClick={() => void recover()} disabled={busy || email.trim().length === 0}>Send password-reset link</button>}
        </form>
      </div>
      <SecurityModel />
    </section>}

    {session !== undefined && recoveryMode && <section className="auth-layout"><div className="auth-card"><span className="eyebrow">ACCOUNT RECOVERY</span><h2>Set a new password</h2><form onSubmit={(event) => void commitNewPassword(event)}><label>New password <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={128} required /></label><button className="primary portal-primary" disabled={busy}>Update password</button></form></div><SecurityModel /></section>}

    {session !== undefined && !recoveryMode && <section className="account-console">
      <header><div><span className="eyebrow">SIGNED-IN ACCOUNT</span><h2>{session.user.email}</h2><p>{session.user.emailVerified ? "Verified identity" : "Email verification required before token creation"} · session kept in this browser tab only</p></div><button onClick={() => void logout()} disabled={busy}>Sign out</button></header>
      <div className="account-grid">
        <form className="token-create-card" onSubmit={(event) => void issueToken(event)}>
          <span className="step-index">01</span><h3>Create a personal MCP token</h3>
          <label>Connection name <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} minLength={2} maxLength={60} required /></label>
          <label>Expires after <select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>{(config?.tokenExpiryDays ?? [7, 30, 90]).map((days) => <option key={days} value={days}>{days} days</option>)}</select></label>
          <fieldset><legend>Permissions</legend><label><input type="checkbox" checked disabled /> Read and inspect</label><label><input type="checkbox" checked={scopes.includes("mcp:preview")} onChange={(event) => setScope(scopes, setScopes, "mcp:preview", event.target.checked)} /> Create change previews</label><label><input type="checkbox" checked={scopes.includes("mcp:apply")} onChange={(event) => setScope(scopes, setScopes, "mcp:apply", event.target.checked)} /> Return confirmed project copies</label></fieldset>
          <button className="primary portal-primary" disabled={busy || !session.user.emailVerified}>Generate unique token</button>
          <small>Maximum {config?.maximumActiveTokens ?? 5} active tokens. The raw token is shown once and stored by PS3D only as a keyed hash.</small>
        </form>
        <div className="endpoint-card"><span className="step-index">02</span><h3>Choose a client connection</h3><dl><div><dt>Remote MCP endpoint</dt><dd><code>{config?.mcpEndpoint ?? `${location.origin}/api/mcp`}</code></dd></div><div><dt>Recommended</dt><dd>OAuth 2.1 when your AI client supports automatic authorization</dd></div><div><dt>Fallback</dt><dd>Personal bearer token for clients that accept custom HTTP headers</dd></div></dl><a href="/learn#mcp">Open the model-by-model connection guide</a></div>
      </div>

      {created !== undefined && <section className="token-reveal" aria-live="polite"><header><div><span className="eyebrow">SHOWN ONCE</span><h3>Copy this token before leaving</h3></div><button onClick={() => setCreated(undefined)}>I saved it</button></header><code>{created.token}</code><div className="copy-grid"><CopyBlock title="Generic JSON configuration" value={jsonConfig} /><CopyBlock title="TOML configuration" value={tomlConfig} /></div><p><strong>Do not commit this value</strong>, paste it into chat, or share it with another user. Revoke it immediately if exposed.</p></section>}

      <section className="token-list-card"><header><div><span className="step-index">03</span><h3>Active and recent tokens</h3></div><span>{tokens.filter((token) => token.revoked_at === null && new Date(token.expires_at).getTime() > Date.now()).length} active</span></header>{tokens.length === 0 ? <div className="empty-tokens">No tokens yet. Create a separate token for each AI tool or device.</div> : <div className="token-table" role="table">{tokens.map((record) => <div className={`token-row ${record.revoked_at === null ? "" : "revoked"}`} role="row" key={record.id}><div><strong>{record.name}</strong><code>{record.token_prefix}</code></div><div><span>{record.scopes.map(scopeLabel).join(" · ")}</span><small>Expires {formatDate(record.expires_at)} · {record.last_used_at === null ? "never used" : `used ${formatDate(record.last_used_at)}`}</small></div><div>{record.revoked_at === null && new Date(record.expires_at).getTime() > Date.now() ? <button className="danger-outline" onClick={() => void revoke(record)} disabled={busy}>Revoke</button> : <span className="token-state">{record.revoked_at === null ? "Expired" : "Revoked"}</span>}</div></div>)}</div>}</section>
    </section>}
    <BrandFooter note="MIT-licensed source. Passwords and raw personal tokens are never stored in the project repository." />
  </main>;
}

function SetupRequired(): React.JSX.Element {
  return <section className="portal-notice setup"><strong>Production identity is fail-closed</strong><p>This deployment is missing one or more server-only environment values or its database migration. No account or token operation will run until an administrator completes the release checklist.</p></section>;
}

function SecurityModel(): React.JSX.Element {
  return <aside className="security-model"><span className="eyebrow">SECURITY MODEL</span><h2>One identity, separate credentials</h2><ol><li><strong>Email + password</strong><span>Signs you into the web portal. Password handling belongs to the identity provider.</span></li><li><strong>OAuth or personal token</strong><span>Connects one AI host. Tokens expire and can be revoked independently.</span></li><li><strong>Receipt-gated CAD changes</strong><span>AI tools inspect and preview first; confirmed apply returns a new project copy and writes no browser file.</span></li></ol><p>No system can be guaranteed unhackable. PS3D uses least privilege, strict validation, rate limits, tenant isolation, and secret scanning to reduce risk.</p></aside>;
}

function CopyBlock(props: { readonly title: string; readonly value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(props.value); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  };
  return <div className="copy-block"><header><strong>{props.title}</strong><button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button></header><pre>{props.value}</pre></div>;
}

function setScope(current: readonly string[], setter: (value: readonly string[]) => void, scope: string, enabled: boolean): void {
  const set = new Set(current);
  if (enabled) set.add(scope); else set.delete(scope);
  setter(["mcp:read", "mcp:preview", "mcp:apply"].filter((candidate) => set.has(candidate)));
}

function safeReturnTarget(value: string | null): string | undefined {
  return value !== null && value.startsWith("/oauth/consent?") && !value.includes("\\") && !value.includes("//") ? value : undefined;
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof CloudApiError || cause instanceof Error ? cause.message : fallback;
}

function scopeLabel(scope: string): string {
  if (scope === "mcp:read") return "read";
  if (scope === "mcp:preview") return "preview";
  if (scope === "mcp:apply") return "confirmed copy";
  return scope;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "unknown";
}
