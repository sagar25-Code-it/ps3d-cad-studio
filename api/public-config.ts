import { cloudIsConfigured, loadCloudEnvironment } from "./_lib/cloud.js";
import { jsonResponse, methodNotAllowed } from "./_lib/http.js";

function handler(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const origin = new URL(request.url).origin;
  const configured = cloudIsConfigured();
  const issuer = configured ? `${loadCloudEnvironment().supabaseUrl}/auth/v1` : null;
  return jsonResponse({
    schema: "ps3d-public-cloud-config/1",
    cloudAccess: configured ? "ready" : "setup-required",
    authentication: configured ? "email-password-and-oauth-2.1" : "unavailable",
    mcpEndpoint: `${origin}/api/mcp`,
    oauthIssuer: issuer,
    protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
    tokenPrefix: "ps3d_mcp_",
    tokenSecretCharacters: 64,
    maximumActiveTokens: 5,
    tokenExpiryDays: [7, 30, 90],
    documentationUrl: `${origin}/learn#mcp`
  });
}

export default { fetch: handler };
