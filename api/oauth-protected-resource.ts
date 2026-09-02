import { cloudIsConfigured, loadCloudEnvironment } from "./_lib/cloud.js";
import { jsonResponse, methodNotAllowed, publicRequestOrigin } from "./_lib/http.js";

function handler(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const origin = publicRequestOrigin(request);
  const configured = cloudIsConfigured();
  return jsonResponse({
    resource: `${origin}/api/mcp`,
    authorization_servers: configured ? [`${loadCloudEnvironment().supabaseUrl}/auth/v1`] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email"],
    resource_documentation: `${origin}/learn#mcp`
  });
}

export default { fetch: handler };
