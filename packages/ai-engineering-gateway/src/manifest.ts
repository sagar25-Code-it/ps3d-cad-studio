import { deepFreeze, sha256 } from "./canonical.js";
import {
  AI_ENGINEERING_PROTOCOL_VERSION,
  type CommandDefinition,
  type CommandManifest,
  type GatewayDiagnostic,
  type GatewaySchemaManifest,
  type HandshakeAcknowledgement,
  type HandshakeRequest,
  type HandshakeResponse
} from "./types.js";

const FEATURE_PLAN_SCHEMA_DESCRIPTOR = {
  id: "ps3d-feature-plan/1",
  geometryPolicy: "stable-entity-references-and-engineering-parameters-only",
  required: ["id", "projectId", "baseRevision", "targetComponentId", "steps", "questions", "standardsEvidence"],
  previewPolicy: "all-blocking-questions-answered-and-required-evidence-verified"
} as const;

const GATEWAY_POLICY_DESCRIPTOR = {
  schemaAndCommandManifestFirst: true,
  featurePlanBeforeGeometry: true,
  previewBeforeApply: true,
  explicitApprovalRequired: true,
  revisionConflictFailsClosed: true,
  idempotencyConflictFailsClosed: true,
  networkSecretsOwnedByHost: true,
  adapterScriptsRequireHostValidation: true
} as const;

const command = (
  id: CommandDefinition["id"],
  title: string,
  workspace: CommandDefinition["workspace"],
  intentKinds: CommandDefinition["intentKinds"],
  exactKernelRequired: boolean
): CommandDefinition => ({
  id,
  title,
  description: `Plan and validate ${title.toLowerCase()} through stable CAD references.`,
  workspace,
  intentKinds,
  effect: "preview",
  inputSchemaId: "ps3d-feature-plan-step/1",
  outputSchemaId: "ps3d-feature-result/1",
  exactKernelRequired,
  idempotent: true
});

export const CORE_AI_COMMAND_MANIFEST: CommandManifest = deepFreeze({
  schemaVersion: "ps3d-command-manifest/1",
  manifestId: "ps3d-core-engineering-commands",
  revision: 1,
  commands: [
    command("command:sketch", "sketch operations", "sketch", ["sketch.create", "sketch.constrain", "sketch.dimension"], false),
    command("command:solid-create", "solid creation", "solid", ["solid.extrude", "solid.revolve", "solid.sweep", "solid.loft", "solid.hole", "solid.thread", "solid.rib", "solid.thin-extrude"], true),
    command("command:solid-modify", "solid modification", "solid", ["solid.fillet", "solid.chamfer", "solid.draft", "solid.shell", "solid.boolean", "solid.pattern", "solid.mirror", "solid.direct-edit"], true),
    command("command:surface", "surface operations", "surface", ["surface.create", "surface.modify", "surface.stitch", "surface.thicken"], true),
    command("command:assembly", "assembly operations", "assembly", ["assembly.insert", "assembly.joint", "assembly.motion", "assembly.explode", "assembly.inspect"], true),
    command("command:drawing", "associative drawing operations", "drawing", ["drawing.view", "drawing.annotate", "drawing.gdt", "drawing.parts-list"], true),
    command("command:render", "rendering operations", "render", ["render.appearance", "render.environment"], false),
    command("command:exchange", "neutral exchange operations", "exchange", ["exchange.import", "exchange.export"], true)
  ]
});

export async function createGatewaySchemaManifest(input: {
  readonly documentSchemaId: string;
  readonly documentSchemaDigest: string;
  readonly commandManifest?: CommandManifest;
}): Promise<GatewaySchemaManifest> {
  const commandManifest = input.commandManifest ?? CORE_AI_COMMAND_MANIFEST;
  return deepFreeze({
    protocolVersion: AI_ENGINEERING_PROTOCOL_VERSION,
    documentSchemaId: input.documentSchemaId,
    documentSchemaDigest: input.documentSchemaDigest,
    featurePlanSchemaId: "ps3d-feature-plan/1",
    featurePlanSchemaDigest: await sha256(FEATURE_PLAN_SCHEMA_DESCRIPTOR),
    commandManifestDigest: await sha256(commandManifest),
    gatewayPolicyDigest: await sha256(GATEWAY_POLICY_DESCRIPTOR)
  });
}

function diagnostic(code: GatewayDiagnostic["code"], message: string, recovery: string, relatedIds: readonly string[] = []): GatewayDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery };
}

export async function createHandshake(
  request: HandshakeRequest,
  schemaManifest: GatewaySchemaManifest,
  commandManifest: CommandManifest = CORE_AI_COMMAND_MANIFEST
): Promise<HandshakeResponse> {
  const diagnostics: GatewayDiagnostic[] = [];
  if (!request.supportedProtocolVersions.includes(AI_ENGINEERING_PROTOCOL_VERSION)) diagnostics.push(diagnostic(
    "PROTOCOL_MISMATCH",
    `Provider does not advertise '${AI_ENGINEERING_PROTOCOL_VERSION}'.`,
    "Upgrade the provider integration before submitting CAD plans."
  ));
  const commands = new Set(commandManifest.commands.map((entry) => entry.id));
  const unknown = request.requestedCommandIds.filter((id) => !commands.has(id));
  if (unknown.length > 0) diagnostics.push(diagnostic(
    "UNKNOWN_COMMAND",
    `Requested commands are not in the current manifest: ${unknown.join(", ")}.`,
    "Read the returned command manifest and select only advertised commands.",
    unknown
  ));
  const handshakeDigest = await sha256({ request, schemaManifest, commandManifest });
  return deepFreeze({
    handshakeId: `handshake:${handshakeDigest}`,
    protocolVersion: AI_ENGINEERING_PROTOCOL_VERSION,
    provider: request.provider,
    schemaManifest,
    commandManifest,
    requiredSequence: ["read-schema-manifest", "read-command-manifest", "acknowledge", "plan", "preview", "approve", "apply"],
    diagnostics
  });
}

export function acknowledgementFor(handshake: HandshakeResponse): HandshakeAcknowledgement {
  return deepFreeze({
    handshakeId: handshake.handshakeId,
    protocolVersion: handshake.protocolVersion,
    documentSchemaDigest: handshake.schemaManifest.documentSchemaDigest,
    featurePlanSchemaDigest: handshake.schemaManifest.featurePlanSchemaDigest,
    commandManifestDigest: handshake.schemaManifest.commandManifestDigest,
    gatewayPolicyDigest: handshake.schemaManifest.gatewayPolicyDigest,
    understood: true
  });
}

export function validateHandshakeAcknowledgement(
  acknowledgement: HandshakeAcknowledgement,
  handshake: HandshakeResponse | undefined
): readonly GatewayDiagnostic[] {
  if (!handshake) return [diagnostic(
    "SCHEMA_ACK_REQUIRED",
    "The acknowledgement does not identify a handshake issued by this gateway instance.",
    "Perform a new handshake, read both manifests, and acknowledge their exact digests."
  )];
  const expected = acknowledgementFor(handshake);
  const matches = acknowledgement.protocolVersion === expected.protocolVersion
    && acknowledgement.documentSchemaDigest === expected.documentSchemaDigest
    && acknowledgement.featurePlanSchemaDigest === expected.featurePlanSchemaDigest
    && acknowledgement.commandManifestDigest === expected.commandManifestDigest
    && acknowledgement.gatewayPolicyDigest === expected.gatewayPolicyDigest;
  return matches ? [] : [diagnostic(
    "MANIFEST_MISMATCH",
    "The acknowledgement is bound to a different schema, command manifest, or gateway policy.",
    "Discard the stale acknowledgement and acknowledge the latest handshake manifest digests."
  )];
}
