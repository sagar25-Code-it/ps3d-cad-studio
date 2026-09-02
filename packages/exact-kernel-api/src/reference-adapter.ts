import { canonicalKernelJson, kernelSha256 } from "./canonical.js";
import { inputShapeHandles, type ExactKernelOperation } from "./operations.js";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  type ExactKernelCapabilities,
  type KernelDiagnostic,
  type KernelIdentity
} from "./types.js";
import {
  failureResponse,
  finalizeOperationProducts,
  kernelRequestDigest,
  negotiateKernelCapabilities,
  protocolDiagnostic,
  responseEnvelope,
  validateKernelRequest,
  validateKernelResponse,
  type ExactKernelAdapter,
  type ExactKernelRequest,
  type ExactKernelResponse,
  type ExecuteKernelOperationRequest,
  type KernelExecutionSuccess,
  type OperationResultDraft
} from "./protocol.js";

export interface RecordedKernelEvidence {
  readonly source: "recorded-kernel" | "externally-verified";
  readonly sourceKernel: KernelIdentity;
  readonly evidenceDigest: string;
  readonly description: string;
}

export interface RecordedOperationFixture {
  readonly fixtureVersion: 1;
  readonly request: ExecuteKernelOperationRequest;
  readonly result: OperationResultDraft;
  readonly evidence: RecordedKernelEvidence;
}

export interface FixtureRegistrationResult {
  readonly fixtureKey: string;
  readonly operationId: string;
  readonly operationKind: ExactKernelOperation["kind"];
}

/**
 * A protocol reference adapter for tests. It never evaluates geometry.
 * Every execution result must be registered from a real or independently
 * verified kernel record. Requests without a record fail with FIXTURE_MISSING.
 */
export class RecordedExactKernelAdapter implements ExactKernelAdapter {
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  readonly #fixtures = new Map<string, RecordedOperationFixture>();
  readonly #sessions = new Map<string, Map<string, { readonly contentDigest: string; readonly revision: number }>>();
  readonly #verifiedFixtureInputs = new Map<string, Map<string, { readonly contentDigest: string; readonly revision: number }>>();

  constructor(identity: KernelIdentity, capabilities: ExactKernelCapabilities) {
    if (identity.contractVersion !== EXACT_KERNEL_PROTOCOL_VERSION) throw new TypeError("Recorded adapter identity uses an incompatible contract version.");
    if (identity.executionTarget !== "recorded-reference") throw new TypeError("Recorded adapter identity must declare the recorded-reference target.");
    if (capabilities.canonicalLengthUnit !== "m" || capabilities.canonicalAngleUnit !== "rad") throw new TypeError("Exact-kernel adapters must use metres and radians.");
    this.identity = structuredClone(identity);
    this.capabilities = structuredClone(capabilities);
  }

  async registerFixture(fixture: RecordedOperationFixture): Promise<FixtureRegistrationResult> {
    const diagnostics = validateRecordedFixture(fixture, this.capabilities);
    if (diagnostics.length > 0) throw new RecordedFixtureError(diagnostics);
    const fixtureKey = await kernelRequestDigest(fixture.request);
    const existing = this.#fixtures.get(fixtureKey);
    if (existing !== undefined && canonicalKernelJson(existing) !== canonicalKernelJson(fixture)) {
      throw new RecordedFixtureError([protocolDiagnostic(
        "FIXTURE_INVALID",
        `Fixture key '${fixtureKey}' already identifies different recorded data.`,
        "Use a new operation input or remove the conflicting fixture."
      )]);
    }
    const verifiedInputs = new Map(this.#verifiedFixtureInputs.get(fixture.request.sessionId) ?? []);
    for (const input of inputShapeHandles(fixture.request.operation)) {
      const existingInput = verifiedInputs.get(input.shapeId);
      if (existingInput !== undefined
        && (existingInput.contentDigest !== input.contentDigest || existingInput.revision !== input.revision)) {
        throw new RecordedFixtureError([protocolDiagnostic(
          "FIXTURE_INVALID",
          `Recorded fixtures disagree about input shape '${input.shapeId}'.`,
          "Use a distinct shape ID or record one authoritative revision and digest."
        )]);
      }
      verifiedInputs.set(input.shapeId, { contentDigest: input.contentDigest, revision: input.revision });
    }
    this.#fixtures.set(fixtureKey, structuredClone(fixture));
    this.#verifiedFixtureInputs.set(fixture.request.sessionId, verifiedInputs);
    return { fixtureKey, operationId: fixture.request.operation.operationId, operationKind: fixture.request.operation.kind };
  }

  async handle(request: ExactKernelRequest, signal?: AbortSignal): Promise<ExactKernelResponse> {
    const requestDiagnostics = validateKernelRequest(request);
    if (requestDiagnostics.length > 0) return failureResponse(request, requestDiagnostics);
    if (signal?.aborted === true) return failureResponse(request, [protocolDiagnostic(
      "CANCELLED", "The exact-kernel request was cancelled before execution.", "Submit a new request if the operation is still required."
    )]);

    if (request.kind === "negotiate") {
      const diagnostics = negotiateKernelCapabilities(this.capabilities, request.requirements, this.identity.executionTarget);
      return {
        ...responseEnvelope(request),
        status: "ok",
        kind: "negotiated",
        identity: structuredClone(this.identity),
        capabilities: structuredClone(this.capabilities),
        satisfied: diagnostics.length === 0,
        diagnostics
      };
    }

    if (request.kind === "open-session") {
      if (request.expectedCapabilityVersion !== this.capabilities.capabilityVersion) return failureResponse(request, [protocolDiagnostic(
        "CAPABILITY_UNAVAILABLE", "The requested capability version is not active.", "Renegotiate capabilities and reopen the session."
      )]);
      if (!this.capabilities.supportsPersistentSessions && this.#sessions.size > 0) return failureResponse(request, [protocolDiagnostic(
        "CAPABILITY_UNAVAILABLE", "This adapter does not support multiple persistent sessions.", "Close the active session before opening another."
      )]);
      if (this.#sessions.has(request.sessionId)) return failureResponse(request, [protocolDiagnostic(
        "INVALID_REQUEST", `Kernel session '${request.sessionId}' is already open.`, "Reuse the active session or close it before reopening."
      )]);
      this.#sessions.set(request.sessionId, new Map(this.#verifiedFixtureInputs.get(request.sessionId) ?? []));
      return { ...responseEnvelope(request), status: "ok", kind: "session-opened", sessionId: request.sessionId };
    }

    if (request.kind === "close-session") {
      if (!this.#sessions.delete(request.sessionId)) return failureResponse(request, [sessionNotFound(request.sessionId)]);
      return { ...responseEnvelope(request), status: "ok", kind: "session-closed", sessionId: request.sessionId };
    }

    if (request.kind === "release-shapes") {
      const shapes = this.#sessions.get(request.sessionId);
      if (shapes === undefined) return failureResponse(request, [sessionNotFound(request.sessionId)]);
      const released: string[] = [];
      for (const shapeId of request.shapeIds) {
        if (shapes.delete(shapeId)) released.push(shapeId);
      }
      return { ...responseEnvelope(request), status: "ok", kind: "shapes-released", sessionId: request.sessionId, releasedShapeIds: released };
    }

    if (request.kind === "cancel") {
      if (!this.capabilities.supportsCancellation) return failureResponse(request, [protocolDiagnostic(
        "CAPABILITY_UNAVAILABLE", "This adapter does not advertise cancellation.", "Wait for the operation to finish or use a cancellable worker."
      )]);
      return { ...responseEnvelope(request), status: "ok", kind: "cancelled", targetRequestId: request.targetRequestId };
    }

    return this.#execute(request, signal);
  }

  async #execute(request: ExecuteKernelOperationRequest, signal?: AbortSignal): Promise<ExactKernelResponse> {
    const sessionShapes = this.#sessions.get(request.sessionId);
    if (sessionShapes === undefined) return failureResponse(request, [sessionNotFound(request.sessionId)]);
    if (request.expectedCapabilityVersion !== this.capabilities.capabilityVersion) return failureResponse(request, [protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", "The execution request uses a stale capability version.", "Renegotiate capabilities and retry."
    )]);
    if (!this.capabilities.supportedOperations.includes(request.operation.kind)) return failureResponse(request, [protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", `Operation '${request.operation.kind}' is not advertised by this adapter.`, "Route the operation to a compatible worker."
    )]);
    if (signal?.aborted === true) return failureResponse(request, [protocolDiagnostic(
      "CANCELLED", "The exact-kernel request was cancelled.", "Submit a new request if the operation is still required."
    )]);

    for (const input of inputShapeHandles(request.operation)) {
      if (input.sessionId !== request.sessionId) return failureResponse(request, [protocolDiagnostic(
        "STALE_SHAPE_HANDLE", `Shape '${input.shapeId}' belongs to another session.`, "Import or rebuild the shape in the active session."
      )]);
      const known = sessionShapes.get(input.shapeId);
      if (known === undefined) return failureResponse(request, [protocolDiagnostic(
        "SHAPE_NOT_FOUND", `Shape '${input.shapeId}' is not owned by the active session.`, "Import or rebuild the shape in the active session before using it."
      )]);
      if (known.contentDigest !== input.contentDigest || known.revision !== input.revision) return failureResponse(request, [protocolDiagnostic(
        "STALE_SHAPE_HANDLE", `Shape '${input.shapeId}' has a stale revision or digest.`, "Re-resolve the feature inputs from the latest document revision."
      )]);
    }

    const fixture = this.#fixtures.get(await kernelRequestDigest(request));
    if (fixture === undefined) return failureResponse(request, [protocolDiagnostic(
      "FIXTURE_MISSING",
      `No verified exact-kernel record exists for operation '${request.operation.operationId}'.`,
      "Record this operation from a real exact kernel before using it in a contract test.",
      request.operation.semanticOutputIds
    )]);
    const products = await finalizeOperationProducts(this.identity, this.capabilities, request, structuredClone(fixture.result));
    const response: KernelExecutionSuccess = {
      ...responseEnvelope(request), status: "ok", kind: "executed", sessionId: request.sessionId, products
    };
    const responseDiagnostics = await validateKernelResponse(request, response, this.identity, this.capabilities);
    if (responseDiagnostics.length > 0) return failureResponse(request, responseDiagnostics);
    for (const output of products.geometry.outputs) sessionShapes.set(output.shapeId, {
      contentDigest: output.contentDigest,
      revision: output.revision
    });
    return response;
  }
}

export class RecordedFixtureError extends Error {
  readonly diagnostics: readonly KernelDiagnostic[];

  constructor(diagnostics: readonly KernelDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join(" "));
    this.name = "RecordedFixtureError";
    this.diagnostics = diagnostics;
  }
}

export function validateRecordedFixture(
  fixture: RecordedOperationFixture,
  capabilities: ExactKernelCapabilities
): readonly KernelDiagnostic[] {
  const diagnostics: KernelDiagnostic[] = [...validateKernelRequest(fixture.request)];
  if (fixture.fixtureVersion !== 1) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Unsupported fixture version.", "Re-record the fixture using version 1."
  ));
  if (fixture.evidence.sourceKernel.executionTarget === "recorded-reference") diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "A recorded adapter cannot be the source of geometry evidence.", "Capture the result from a real WASM/native kernel or independently verify it."
  ));
  if (!/^[a-f0-9]{64}$/u.test(fixture.evidence.evidenceDigest)) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture evidenceDigest must be a SHA-256 hex digest.", "Hash and attach the source evidence."
  ));
  if (fixture.result.operationId !== fixture.request.operation.operationId || fixture.result.operationKind !== fixture.request.operation.kind) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture result operation identity does not match its request.", "Record the request and result as one atomic fixture."
  ));
  if (fixture.result.outputs.length !== fixture.request.operation.expectedOutputCount
    || fixture.result.validation.length !== fixture.result.outputs.length) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture output and validation counts do not match the request.", "Record one validation report per output shape."
  ));
  if (fixture.result.outputs.some((shape) => shape.representation !== "exact-brep" || shape.sessionId !== fixture.request.sessionId)) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture outputs must be exact B-rep handles in the recorded session.", "Do not register tessellated or cross-session shapes."
  ));
  if (!capabilities.supportedOperations.includes(fixture.request.operation.kind)) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture operation is not present in the adapter capabilities.", "Advertise the recorded operation or remove the fixture."
  ));
  if (fixture.result.provenance.operationId !== fixture.result.operationId
    || fixture.result.provenance.operationKind !== fixture.result.operationKind) diagnostics.push(protocolDiagnostic(
    "FIXTURE_INVALID", "Fixture provenance does not match the result operation.", "Regenerate topology provenance from the source kernel."
  ));
  return diagnostics;
}

export async function createRecordedEvidenceDigest(
  sourceKernel: KernelIdentity,
  request: ExecuteKernelOperationRequest,
  result: OperationResultDraft
): Promise<string> {
  return kernelSha256({ sourceKernel, request: await kernelRequestDigest(request), result });
}

function sessionNotFound(sessionId: string): KernelDiagnostic {
  return protocolDiagnostic("SESSION_NOT_FOUND", `Kernel session '${sessionId}' is not open.`, "Open a session after capability negotiation.");
}
