import type { GatewayDiagnostic, GatewayMcpEnvelope } from "./types.js";
import { AI_ENGINEERING_PROTOCOL_VERSION } from "./types.js";

export function validateGatewayMcpEnvelope(envelope: GatewayMcpEnvelope): readonly GatewayDiagnostic[] {
  const diagnostics: GatewayDiagnostic[] = [];
  if (envelope.protocolVersion !== AI_ENGINEERING_PROTOCOL_VERSION) diagnostics.push({
    code: "PROTOCOL_MISMATCH", severity: "error", message: "The MCP envelope uses an unsupported protocol version.",
    relatedIds: [envelope.requestId], recovery: `Use '${AI_ENGINEERING_PROTOCOL_VERSION}'.`
  });
  if (envelope.requestId.trim().length === 0 || envelope.idempotencyKey.trim().length < 8) diagnostics.push({
    code: "INVALID_PLAN", severity: "error", message: "The provider envelope lacks a usable request or idempotency identity.",
    relatedIds: [envelope.requestId], recovery: "Supply a stable request ID and an idempotency key of at least eight characters."
  });
  if (envelope.provider.name.trim().length === 0 || envelope.provider.version.trim().length === 0) diagnostics.push({
    code: "INVALID_PLAN", severity: "error", message: "The provider identity is incomplete.",
    relatedIds: [], recovery: "Identify the MCP host/provider and integration version."
  });
  return diagnostics;
}
