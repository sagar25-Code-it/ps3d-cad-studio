import { kernelSha256 } from "./canonical.js";
import { inputShapeHandles } from "./operations.js";
import type { ExactKernelOperation } from "./operations.js";
import {
  EXACT_KERNEL_OPERATION_KINDS,
  EXACT_KERNEL_PROTOCOL_VERSION,
  type ExactKernelCapabilities,
  type ExactKernelOperationKind,
  type ExactKernelOperationResult,
  type KernelDiagnostic,
  type KernelExchangeArtifact,
  type KernelIdentity,
  type KernelOperationReceipt,
  type KernelExecutionTarget,
  type MeshExchangeFormat,
  type NeutralCadFormat,
  type ResolvedTopologyEntity,
  type TessellationResult
} from "./types.js";

export interface KernelRequestEnvelope {
  readonly protocolVersion: typeof EXACT_KERNEL_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly generation: number;
  readonly documentId: string;
  readonly documentRevision: number;
}

export interface KernelCapabilityRequirements {
  readonly requiredOperations: readonly ExactKernelOperationKind[];
  readonly requiredImportFormats: readonly NeutralCadFormat[];
  readonly requiredExportFormats: readonly (NeutralCadFormat | MeshExchangeFormat)[];
  readonly preferredTargets: readonly KernelExecutionTarget[];
  readonly maximumRequiredToleranceMeters: number;
  readonly persistentSessionRequired: boolean;
  readonly cancellationRequired: boolean;
}

export interface NegotiateKernelRequest extends KernelRequestEnvelope {
  readonly kind: "negotiate";
  readonly requirements: KernelCapabilityRequirements;
}

export interface OpenKernelSessionRequest extends KernelRequestEnvelope {
  readonly kind: "open-session";
  readonly sessionId: string;
  readonly expectedCapabilityVersion: string;
}

export interface ExecuteKernelOperationRequest extends KernelRequestEnvelope {
  readonly kind: "execute";
  readonly sessionId: string;
  readonly expectedCapabilityVersion: string;
  readonly operation: ExactKernelOperation;
}

export interface ReleaseKernelShapesRequest extends KernelRequestEnvelope {
  readonly kind: "release-shapes";
  readonly sessionId: string;
  readonly shapeIds: readonly string[];
}

export interface CloseKernelSessionRequest extends KernelRequestEnvelope {
  readonly kind: "close-session";
  readonly sessionId: string;
}

export interface CancelKernelRequest extends KernelRequestEnvelope {
  readonly kind: "cancel";
  readonly targetRequestId: string;
}

export type ExactKernelRequest =
  | NegotiateKernelRequest
  | OpenKernelSessionRequest
  | ExecuteKernelOperationRequest
  | ReleaseKernelShapesRequest
  | CloseKernelSessionRequest
  | CancelKernelRequest;

export interface KernelResponseEnvelope {
  readonly protocolVersion: typeof EXACT_KERNEL_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly generation: number;
  readonly documentId: string;
  readonly documentRevision: number;
}

export interface KernelNegotiationSuccess extends KernelResponseEnvelope {
  readonly status: "ok";
  readonly kind: "negotiated";
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  readonly satisfied: boolean;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface KernelSessionSuccess extends KernelResponseEnvelope {
  readonly status: "ok";
  readonly kind: "session-opened" | "session-closed";
  readonly sessionId: string;
}

export interface KernelExecutionProducts {
  readonly geometry: ExactKernelOperationResult;
  readonly exchangeArtifacts: readonly KernelExchangeArtifact[];
  readonly tessellations: readonly TessellationResult[];
  readonly topologyEntities: readonly ResolvedTopologyEntity[];
}

export interface KernelExecutionSuccess extends KernelResponseEnvelope {
  readonly status: "ok";
  readonly kind: "executed";
  readonly sessionId: string;
  readonly products: KernelExecutionProducts;
}

export interface KernelReleaseSuccess extends KernelResponseEnvelope {
  readonly status: "ok";
  readonly kind: "shapes-released";
  readonly sessionId: string;
  readonly releasedShapeIds: readonly string[];
}

export interface KernelCancellationSuccess extends KernelResponseEnvelope {
  readonly status: "ok";
  readonly kind: "cancelled";
  readonly targetRequestId: string;
}

export interface KernelFailureResponse extends KernelResponseEnvelope {
  readonly status: "error";
  readonly kind: "failure";
  readonly diagnostics: readonly KernelDiagnostic[];
}

export type ExactKernelResponse =
  | KernelNegotiationSuccess
  | KernelSessionSuccess
  | KernelExecutionSuccess
  | KernelReleaseSuccess
  | KernelCancellationSuccess
  | KernelFailureResponse;

export interface ExactKernelAdapter {
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  handle(request: ExactKernelRequest, signal?: AbortSignal): Promise<ExactKernelResponse>;
}

export interface OperationResultDraft {
  readonly operationId: string;
  readonly operationKind: ExactKernelOperationKind;
  readonly outputs: ExactKernelOperationResult["outputs"];
  readonly validation: ExactKernelOperationResult["validation"];
  readonly provenance: ExactKernelOperationResult["provenance"];
  readonly diagnostics: ExactKernelOperationResult["diagnostics"];
  readonly exchangeArtifacts: readonly KernelExchangeArtifact[];
  readonly tessellations: readonly TessellationResult[];
  readonly topologyEntities: readonly ResolvedTopologyEntity[];
}

export function responseEnvelope(request: ExactKernelRequest): KernelResponseEnvelope {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: request.requestId,
    generation: request.generation,
    documentId: request.documentId,
    documentRevision: request.documentRevision
  };
}

export function failureResponse(request: ExactKernelRequest, diagnostics: readonly KernelDiagnostic[]): KernelFailureResponse {
  return { ...responseEnvelope(request), status: "error", kind: "failure", diagnostics };
}

export function protocolDiagnostic(
  code: KernelDiagnostic["code"],
  message: string,
  recovery: string,
  relatedSemanticIds: readonly string[] = [],
  relatedReferenceKeys: readonly string[] = []
): KernelDiagnostic {
  return { code, severity: "error", message, relatedSemanticIds, relatedReferenceKeys, recovery };
}

export function negotiateKernelCapabilities(
  capabilities: ExactKernelCapabilities,
  requirements: KernelCapabilityRequirements,
  target: KernelExecutionTarget
): readonly KernelDiagnostic[] {
  const diagnostics: KernelDiagnostic[] = [];
  const operations = new Set(capabilities.supportedOperations);
  const imports = new Set(capabilities.importFormats);
  const exports = new Set(capabilities.exportFormats);
  const unavailableOperations = requirements.requiredOperations.filter((kind) => !operations.has(kind));
  const unavailableImports = requirements.requiredImportFormats.filter((format) => !imports.has(format));
  const unavailableExports = requirements.requiredExportFormats.filter((format) => !exports.has(format));
  if (unavailableOperations.length > 0) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE",
    `Required operations are unavailable: ${unavailableOperations.join(", ")}.`,
    "Route this document to a worker that advertises every required operation."
  ));
  if (unavailableImports.length > 0 || unavailableExports.length > 0) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE",
    `Required exchange formats are unavailable: ${[...unavailableImports, ...unavailableExports].join(", ")}.`,
    "Use a supported neutral format or route to a translator worker."
  ));
  if (requirements.preferredTargets.length > 0 && !requirements.preferredTargets.includes(target)) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE",
    `Execution target '${target}' is outside the requested targets.`,
    "Choose one of the advertised execution targets explicitly."
  ));
  if (requirements.maximumRequiredToleranceMeters < capabilities.minimumLinearToleranceMeters) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE",
    "The worker cannot satisfy the requested linear tolerance.",
    `Request at least ${capabilities.minimumLinearToleranceMeters} m or choose a more precise worker.`
  ));
  if (requirements.persistentSessionRequired && !capabilities.supportsPersistentSessions) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE", "Persistent kernel sessions are required but unavailable.", "Use a persistent worker."
  ));
  if (requirements.cancellationRequired && !capabilities.supportsCancellation) diagnostics.push(protocolDiagnostic(
    "CAPABILITY_UNAVAILABLE", "Cancellation is required but unavailable.", "Use a worker with cancellable operations."
  ));
  return diagnostics;
}

export function kernelRequestContent(request: ExactKernelRequest): unknown {
  if (request.kind === "execute") {
    return {
      protocolVersion: request.protocolVersion,
      documentId: request.documentId,
      documentRevision: request.documentRevision,
      kind: request.kind,
      sessionId: request.sessionId,
      expectedCapabilityVersion: request.expectedCapabilityVersion,
      operation: request.operation
    };
  }
  if (request.kind === "negotiate") return { protocolVersion: request.protocolVersion, kind: request.kind, requirements: request.requirements };
  if (request.kind === "open-session") return {
    protocolVersion: request.protocolVersion, documentId: request.documentId, documentRevision: request.documentRevision,
    kind: request.kind, sessionId: request.sessionId, expectedCapabilityVersion: request.expectedCapabilityVersion
  };
  if (request.kind === "release-shapes") return {
    protocolVersion: request.protocolVersion, documentId: request.documentId, documentRevision: request.documentRevision,
    kind: request.kind, sessionId: request.sessionId, shapeIds: request.shapeIds
  };
  if (request.kind === "close-session") return {
    protocolVersion: request.protocolVersion, documentId: request.documentId, documentRevision: request.documentRevision,
    kind: request.kind, sessionId: request.sessionId
  };
  return { protocolVersion: request.protocolVersion, kind: request.kind, targetRequestId: request.targetRequestId };
}

export async function kernelRequestDigest(request: ExactKernelRequest): Promise<string> {
  return kernelSha256(kernelRequestContent(request));
}

export async function finalizeOperationProducts(
  identity: KernelIdentity,
  capabilities: ExactKernelCapabilities,
  request: ExecuteKernelOperationRequest,
  draft: OperationResultDraft
): Promise<KernelExecutionProducts> {
  if (draft.operationId !== request.operation.operationId || draft.operationKind !== request.operation.kind) {
    throw new TypeError("Kernel result draft does not match the requested operation.");
  }
  const inputShapeDigests = inputShapeHandles(request.operation).map((shape) => shape.contentDigest);
  const outputShapeDigests = draft.outputs.map((shape) => shape.contentDigest);
  const requestDigest = await kernelRequestDigest(request);
  const resultContent = {
    operationId: draft.operationId,
    operationKind: draft.operationKind,
    outputs: draft.outputs,
    validation: draft.validation,
    provenance: draft.provenance,
    diagnostics: draft.diagnostics,
    exchangeArtifacts: draft.exchangeArtifacts,
    tessellations: draft.tessellations,
    topologyEntities: draft.topologyEntities
  };
  const resultDigest = await kernelSha256(resultContent);
  const receipt: KernelOperationReceipt = {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestDigest,
    resultDigest,
    kernel: identity,
    capabilityVersion: capabilities.capabilityVersion,
    operationId: draft.operationId,
    operationKind: draft.operationKind,
    inputShapeDigests,
    outputShapeDigests,
    deterministic: capabilities.deterministicForIdenticalBuildAndInputs
  };
  return {
    geometry: {
      operationId: draft.operationId,
      operationKind: draft.operationKind,
      outputs: draft.outputs,
      validation: draft.validation,
      provenance: draft.provenance,
      diagnostics: draft.diagnostics,
      receipt
    },
    exchangeArtifacts: draft.exchangeArtifacts,
    tessellations: draft.tessellations,
    topologyEntities: draft.topologyEntities
  };
}

export function validateKernelRequest(request: ExactKernelRequest): readonly KernelDiagnostic[] {
  const diagnostics: KernelDiagnostic[] = [];
  try {
    assertCommonEnvelope(request);
    assertFiniteTree(request);
  } catch (error) {
    diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : "The request is structurally invalid.",
      "Rebuild the request from the exact-kernel contract types."
    ));
    return diagnostics;
  }
  if (request.kind === "execute") {
    if (request.expectedCapabilityVersion.length === 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "expectedCapabilityVersion cannot be empty.", "Negotiate capabilities before execution."
    ));
    if (!(EXACT_KERNEL_OPERATION_KINDS as readonly string[]).includes(request.operation.kind)) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", `Unknown operation kind '${String(request.operation.kind)}'.`, "Use an operation kind from the negotiated contract."
    ));
    if (request.operation.linearToleranceMeters <= 0 || request.operation.angularToleranceRadians <= 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Operation tolerances must be positive.", "Supply explicit positive modelling tolerances."
    ));
    if (!Number.isInteger(request.operation.expectedOutputCount) || request.operation.expectedOutputCount < 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "expectedOutputCount must be a non-negative integer.", "Declare the expected number of output shapes."
    ));
  } else if (request.kind === "negotiate") {
    if (!Number.isFinite(request.requirements.maximumRequiredToleranceMeters)
      || request.requirements.maximumRequiredToleranceMeters <= 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "maximumRequiredToleranceMeters must be finite and positive.", "Supply an explicit positive modelling tolerance."
    ));
    if (new Set(request.requirements.requiredOperations).size !== request.requirements.requiredOperations.length
      || request.requirements.requiredOperations.some((kind) => !(EXACT_KERNEL_OPERATION_KINDS as readonly string[]).includes(kind))) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Capability requirements contain duplicate or unknown operation kinds.", "Use unique operation kinds from the exact-kernel contract."
    ));
  } else if (request.kind === "open-session") {
    if (request.sessionId.trim().length === 0 || request.expectedCapabilityVersion.trim().length === 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Session ID and expected capability version are required.", "Negotiate capabilities and provide a stable session ID."
    ));
  } else if (request.kind === "release-shapes") {
    if (request.sessionId.trim().length === 0 || request.shapeIds.some((id) => id.trim().length === 0)
      || new Set(request.shapeIds).size !== request.shapeIds.length) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Shape release requires a session ID and unique non-empty shape IDs.", "Remove duplicate/empty shape IDs and retry."
    ));
  } else if (request.kind === "close-session") {
    if (request.sessionId.trim().length === 0) diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Session ID is required.", "Provide the session that should be closed."
    ));
  } else if (request.targetRequestId.trim().length === 0) {
    diagnostics.push(protocolDiagnostic(
      "INVALID_REQUEST", "Cancellation target request ID is required.", "Provide the active request ID to cancel."
    ));
  }
  return diagnostics;
}

export async function validateKernelResponse(
  request: ExactKernelRequest,
  response: ExactKernelResponse,
  identity?: KernelIdentity,
  capabilities?: ExactKernelCapabilities
): Promise<readonly KernelDiagnostic[]> {
  const diagnostics: KernelDiagnostic[] = [];
  try {
    if (typeof response !== "object" || response === null) throw new TypeError("Kernel response must be an object.");
    assertFiniteTree(response);
  } catch (error) {
    return [protocolDiagnostic(
      "PROTOCOL_MISMATCH",
      error instanceof Error ? error.message : "The kernel response is structurally invalid.",
      "Discard the response and restart the worker session."
    )];
  }
  if (response.protocolVersion !== request.protocolVersion || response.requestId !== request.requestId
    || response.generation !== request.generation || response.documentId !== request.documentId
    || response.documentRevision !== request.documentRevision) {
    diagnostics.push(protocolDiagnostic("PROTOCOL_MISMATCH", "Response correlation does not match its request.", "Discard the response and restart the worker session."));
    return diagnostics;
  }
  if (response.status === "error") {
    if (response.diagnostics.length === 0 || response.diagnostics.every((item) => item.severity !== "error")) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "A failure response must contain an error diagnostic.", "Return at least one actionable error diagnostic."
    ));
    return diagnostics;
  }
  if (request.kind === "negotiate") {
    if (response.kind !== "negotiated") return [protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Negotiation returned the wrong response kind.", "Discard the response and renegotiate."
    )];
    if (identity !== undefined && await kernelSha256(response.identity) !== await kernelSha256(identity)) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Negotiation returned a different kernel identity than the selected adapter.", "Discard the response and inspect the adapter bridge."
    ));
    if (capabilities !== undefined && await kernelSha256(response.capabilities) !== await kernelSha256(capabilities)) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Negotiation returned capabilities that differ from the selected adapter.", "Discard the response and inspect the adapter bridge."
    ));
    const hasError = response.diagnostics.some((item) => item.severity === "error");
    if (response.satisfied === hasError) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Negotiation satisfaction does not agree with its diagnostics.", "Return satisfied=true only when no error diagnostic remains."
    ));
    return diagnostics;
  }
  if (request.kind === "open-session" || request.kind === "close-session") {
    const expectedKind = request.kind === "open-session" ? "session-opened" : "session-closed";
    if (response.kind !== expectedKind || response.sessionId !== request.sessionId) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Session response kind or session ID does not match the request.", "Discard the response and restart the session workflow."
    ));
    return diagnostics;
  }
  if (request.kind === "release-shapes") {
    if (response.kind !== "shapes-released" || response.sessionId !== request.sessionId) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Shape-release response kind or session ID does not match the request.", "Discard the response."
    ));
    else if (new Set(response.releasedShapeIds).size !== response.releasedShapeIds.length
      || response.releasedShapeIds.some((shapeId) => !request.shapeIds.includes(shapeId))) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Shape-release response includes duplicate or unrequested shape IDs.", "Return only unique IDs requested for release."
    ));
    return diagnostics;
  }
  if (request.kind === "cancel") {
    if (response.kind !== "cancelled" || response.targetRequestId !== request.targetRequestId) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "Cancellation response does not match the requested target.", "Discard the response."
    ));
    return diagnostics;
  }
  if (response.kind !== "executed" || response.sessionId !== request.sessionId) {
    diagnostics.push(protocolDiagnostic("PROTOCOL_MISMATCH", "Execution response kind or session does not match the request.", "Discard the response."));
    return diagnostics;
  }
  const geometry = response.products.geometry;
  if (geometry.operationId !== request.operation.operationId || geometry.operationKind !== request.operation.kind) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "Operation identity changed between request and response.", "Discard the response."
  ));
  if (geometry.outputs.length !== request.operation.expectedOutputCount || geometry.validation.length !== geometry.outputs.length) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "Output or validation counts do not match the declared operation contract.", "Return one validation report for every expected shape."
  ));
  if (geometry.outputs.some((shape) => shape.representation !== "exact-brep")) diagnostics.push(protocolDiagnostic(
    "INVALID_GEOMETRY", "A kernel output is not an exact B-rep handle.", "Do not substitute a render mesh for exact geometry."
  ));
  const receipt = geometry.receipt;
  if (receipt.protocolVersion !== request.protocolVersion
    || receipt.operationId !== request.operation.operationId
    || receipt.operationKind !== request.operation.kind) diagnostics.push(protocolDiagnostic(
      "PROTOCOL_MISMATCH", "The operation receipt identity does not match the request.", "Regenerate the operation receipt."
    ));
  if (receipt.requestDigest !== await kernelRequestDigest(request)) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The operation receipt does not bind the canonical request.", "Recompute the receipt after validating the request."
  ));
  const outputDigests = geometry.outputs.map((shape) => shape.contentDigest);
  if (!sameStrings(receipt.outputShapeDigests, outputDigests)) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The receipt output digests do not match returned shapes.", "Regenerate the result receipt."
  ));
  const inputDigests = inputShapeHandles(request.operation).map((shape) => shape.contentDigest);
  if (!sameStrings(receipt.inputShapeDigests, inputDigests)) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The receipt input digests do not match the operation inputs.", "Regenerate the result receipt."
  ));
  const resultDigest = await kernelSha256({
    operationId: geometry.operationId,
    operationKind: geometry.operationKind,
    outputs: geometry.outputs,
    validation: geometry.validation,
    provenance: geometry.provenance,
    diagnostics: geometry.diagnostics,
    exchangeArtifacts: response.products.exchangeArtifacts,
    tessellations: response.products.tessellations,
    topologyEntities: response.products.topologyEntities
  });
  if (receipt.resultDigest !== resultDigest) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The operation receipt does not bind the returned result products.", "Regenerate the receipt from the complete result payload."
  ));
  if (identity !== undefined && await kernelSha256(receipt.kernel) !== await kernelSha256(identity)) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The receipt identifies a different kernel build.", "Discard cross-build results."
  ));
  if (capabilities !== undefined && receipt.capabilityVersion !== capabilities.capabilityVersion) diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", "The receipt capability version is stale.", "Renegotiate and retry."
  ));
  return diagnostics;
}

function assertCommonEnvelope(request: ExactKernelRequest): void {
  if (request.protocolVersion !== EXACT_KERNEL_PROTOCOL_VERSION) throw new TypeError("Unsupported exact-kernel protocol version.");
  if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u.test(request.requestId)) throw new TypeError("requestId is not a stable protocol identifier.");
  if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u.test(request.documentId)) throw new TypeError("documentId is not a stable protocol identifier.");
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) throw new TypeError("generation must be a non-negative safe integer.");
  if (!Number.isSafeInteger(request.documentRevision) || request.documentRevision < 0) throw new TypeError("documentRevision must be a non-negative safe integer.");
}

function assertFiniteTree(value: unknown, ancestors: Set<object> = new Set()): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Protocol values cannot contain NaN or infinity.");
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (ancestors.has(value)) throw new TypeError("Protocol values cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertFiniteTree(item, ancestors);
    } else {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (nested === undefined) throw new TypeError(`Protocol field '${key}' cannot be undefined.`);
        assertFiniteTree(nested, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
