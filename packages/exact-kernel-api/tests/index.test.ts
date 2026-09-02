import assert from "node:assert/strict";
import test from "node:test";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  RecordedExactKernelAdapter,
  canonicalKernelJson,
  finalizeOperationProducts,
  kernelSha256,
  validateKernelRequest,
  validateKernelResponse,
  type ExactKernelCapabilities,
  type ExecuteKernelOperationRequest,
  type KernelExecutionSuccess,
  type KernelIdentity,
  type NegotiateKernelRequest
} from "../src/index.js";

const identity: KernelIdentity = {
  implementation: "recorded-test",
  implementationVersion: "1",
  kernel: "verified-fixture-only",
  kernelVersion: "1",
  buildId: "recorded-build-1",
  executionTarget: "recorded-reference",
  contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
};

const capabilities: ExactKernelCapabilities = {
  capabilityVersion: "recorded-v1",
  supportedOperations: ["primitive.box"],
  importFormats: [],
  exportFormats: [],
  supportedContinuity: ["g0"],
  canonicalLengthUnit: "m",
  canonicalAngleUnit: "rad",
  minimumLinearToleranceMeters: 1e-8,
  maximumLinearToleranceMeters: 1e-2,
  minimumAngularToleranceRadians: 1e-8,
  deterministicForIdenticalBuildAndInputs: true,
  supportsPersistentSessions: true,
  supportsCancellation: true,
  resourceLimits: {
    maximumInputShapes: 8,
    maximumOutputShapes: 8,
    maximumTopologyEntities: 10_000,
    maximumExchangeBytes: 10_000,
    maximumOperationMilliseconds: 1_000
  }
};

function boxRequest(): ExecuteKernelOperationRequest {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:box-1",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "execute",
    sessionId: "session:test",
    expectedCapabilityVersion: capabilities.capabilityVersion,
    operation: {
      operationId: "operation:box-1",
      kind: "primitive.box",
      semanticOutputIds: ["body:box"],
      linearToleranceMeters: 1e-6,
      angularToleranceRadians: 1e-6,
      expectedOutputCount: 1,
      sizeMeters: [0.1, 0.2, 0.3],
      placement: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] }
    }
  };
}

test("canonical hashing ignores object insertion order", async () => {
  const first = { z: 2, a: { y: 1, x: 0 } };
  const second = { a: { x: 0, y: 1 }, z: 2 };
  assert.equal(canonicalKernelJson(first), canonicalKernelJson(second));
  assert.equal(await kernelSha256(first), await kernelSha256(second));
});

test("invalid numeric protocol data fails before reaching a kernel", () => {
  const request = boxRequest();
  const invalid = { ...request, operation: { ...request.operation, linearToleranceMeters: Number.NaN } };
  const diagnostics = validateKernelRequest(invalid);
  assert.equal(diagnostics[0]?.code, "INVALID_REQUEST");
});

test("recorded adapter refuses to fabricate missing exact geometry", async () => {
  const adapter = new RecordedExactKernelAdapter(identity, capabilities);
  const request = boxRequest();
  const opened = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-1",
    generation: 0,
    documentId: request.documentId,
    documentRevision: request.documentRevision,
    kind: "open-session",
    sessionId: request.sessionId,
    expectedCapabilityVersion: capabilities.capabilityVersion
  });
  assert.equal(opened.status, "ok");
  const response = await adapter.handle(request);
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "FIXTURE_MISSING");
});

test("response validation rejects a successful response kind that does not match its request", async () => {
  const request: NegotiateKernelRequest = {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:negotiate-1",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "negotiate",
    requirements: {
      requiredOperations: [],
      requiredImportFormats: [],
      requiredExportFormats: [],
      preferredTargets: [],
      maximumRequiredToleranceMeters: 1e-6,
      persistentSessionRequired: false,
      cancellationRequired: false
    }
  };
  const diagnostics = await validateKernelResponse(request, {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    generation: request.generation,
    documentId: request.documentId,
    documentRevision: request.documentRevision,
    status: "ok",
    kind: "cancelled",
    targetRequestId: "request:other"
  });
  assert.equal(diagnostics[0]?.code, "PROTOCOL_MISMATCH");
});

test("response validation binds the receipt to every returned execution product", async () => {
  const request = boxRequest();
  const outputDigest = await kernelSha256({ shape: "box" });
  const products = await finalizeOperationProducts(identity, capabilities, request, {
    operationId: request.operation.operationId,
    operationKind: request.operation.kind,
    outputs: [{
      shapeId: "shape:box",
      sessionId: request.sessionId,
      revision: request.documentRevision,
      kind: "solid",
      representation: "exact-brep",
      contentDigest: outputDigest,
      toleranceMeters: 1e-7,
      boundsMeters: { min: [0, 0, 0], max: [0.1, 0.2, 0.3] },
      topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true }
    }],
    validation: [{
      valid: true,
      exact: true,
      checkedToleranceMeters: 1e-7,
      closed: true,
      manifold: true,
      orientable: true,
      finite: true,
      selfIntersections: 0,
      invalidEntityReferenceKeys: [],
      diagnostics: []
    }],
    provenance: {
      operationId: request.operation.operationId,
      operationKind: request.operation.kind,
      inputShapeDigests: [],
      outputShapeDigests: [outputDigest],
      topologyEntities: [],
      provenanceDigest: await kernelSha256({ operation: request.operation.operationId })
    },
    diagnostics: [],
    exchangeArtifacts: [],
    tessellations: [],
    topologyEntities: []
  });
  const validResponse: KernelExecutionSuccess = {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    generation: request.generation,
    documentId: request.documentId,
    documentRevision: request.documentRevision,
    status: "ok",
    kind: "executed",
    sessionId: request.sessionId,
    products
  };
  assert.deepEqual(await validateKernelResponse(request, validResponse, identity, capabilities), []);

  const tampered: KernelExecutionSuccess = {
    ...validResponse,
    products: {
      ...products,
      geometry: {
        ...products.geometry,
        validation: [{ ...products.geometry.validation[0]!, valid: false }]
      }
    }
  };
  const diagnostics = await validateKernelResponse(request, tampered, identity, capabilities);
  assert.ok(diagnostics.some((item) => item.code === "PROTOCOL_MISMATCH" && item.message.includes("returned result")));
});
