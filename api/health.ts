import { cloudIsConfigured } from "./_lib/cloud.js";
import { jsonResponse, methodNotAllowed } from "./_lib/http.js";

function handler(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return jsonResponse({
    service: "ps3d-public-api",
    status: cloudIsConfigured() ? "ready" : "setup-required",
    version: "0.2.0-preview.1",
    time: new Date().toISOString()
  });
}

export default { fetch: handler };
