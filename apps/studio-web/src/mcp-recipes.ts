/**
 * Connection recipes for MCP hosts, built from the deployment's own origin, and the honest reading of the
 * remote endpoint's health probe. Pure, so tests can hold the exact text that users copy.
 */

export interface McpHostRecipe {
  readonly id: string;
  readonly label: string;
  /** "command" renders as one shell line; "json" as a config block; "steps" as numbered instructions. */
  readonly kind: "command" | "json" | "steps";
  readonly body: string;
  readonly note: string;
}

export function remoteMcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/api/mcp`;
}

/** Per-host remote connection recipes. Shapes follow each host's published MCP config; check its docs if a host changed them. */
export function buildHostRecipes(origin: string): readonly McpHostRecipe[] {
  const url = remoteMcpUrl(origin);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "command",
      body: `claude mcp add --transport http ps3d ${url}`,
      note: "Run it in a terminal, then authorize with /mcp inside Claude Code. OAuth is handled by the client."
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop / claude.ai",
      kind: "steps",
      body: `1. Open Settings and choose Connectors.\n2. Add custom connector.\n3. Paste the URL: ${url}\n4. Approve the OAuth sign-in when the host asks.`,
      note: "Desktop and claude.ai add remote MCP servers as connectors; no config file is edited."
    },
    {
      id: "cursor",
      label: "Cursor",
      kind: "json",
      body: JSON.stringify({ mcpServers: { ps3d: { url } } }, null, 2),
      note: "Put it in .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)."
    },
    {
      id: "vs-code",
      label: "VS Code",
      kind: "json",
      body: JSON.stringify({ servers: { ps3d: { type: "http", url } } }, null, 2),
      note: "Put it in .vscode/mcp.json, or add it with the MCP: Add Server command."
    }
  ];
}

export interface RemoteProbeReading {
  readonly state: "ready" | "setup-required" | "unreachable";
  readonly headline: string;
  readonly detail: string;
}

/**
 * Reads the two probes honestly: /api/health says whether the deployment's backend is configured, and the
 * OAuth protected-resource metadata names the authorization server. A dev server has neither route.
 */
export function readRemoteProbe(health: { readonly status?: unknown } | undefined, metadata: { readonly resource?: unknown; readonly authorization_servers?: unknown } | undefined): RemoteProbeReading {
  if (health === undefined) {
    return {
      state: "unreachable",
      headline: "No remote MCP at this address",
      detail: "This origin does not serve /api/mcp (a local dev server has no API routes). Use the production URL, or the local stdio server below."
    };
  }
  if (health.status !== "ready") {
    return {
      state: "setup-required",
      headline: "Deployment reachable · backend setup required",
      detail: "The API answers, but its identity backend is not configured, so tokens and OAuth sign-in are off. The stdio server below works regardless."
    };
  }
  const servers = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string") : [];
  const authHost = ((): string => {
    const first = servers[0];
    if (first === undefined) return "not published";
    try { return new URL(first).host; } catch { return first; }
  })();
  return {
    state: "ready",
    headline: "Remote MCP ready",
    detail: typeof metadata?.resource === "string"
      ? `Serving ${metadata.resource} · OAuth server: ${authHost}.`
      : `The endpoint is up, but its OAuth resource metadata did not load; header tokens from MCP Access still work.`
  };
}
