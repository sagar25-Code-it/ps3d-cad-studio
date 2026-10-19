import assert from "node:assert/strict";
import test from "node:test";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  type ExactKernelCapabilities,
  type ExactShapeHandle,
  type ExecuteKernelOperationRequest,
  type OperationResultDraft
} from "../../exact-kernel-api/src/index.js";
import {
  OcctAttestationError,
  createAttestedOcctKernelAdapter,
  createReferenceBrepRuntime,
  type OcctQualificationManifest,
  type OcctRuntimeAttestation,
  type OcctRuntimePort,
  type TrustedOcctRuntimeLoader
} from "../src/index.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const digestC = `sha256:${"c".repeat(64)}` as const;

const capabilities: ExactKernelCapabilities = {
  capabilityVersion: "occt-v8_0_1-qualified-1",
  supportedOperations: ["primitive.box"],
  importFormats: ["step", "iges", "brep"],
  exportFormats: ["step", "iges", "brep", "stl"],
  supportedContinuity: ["g0", "g1", "g2"],
  canonicalLengthUnit: "m",
  canonicalAngleUnit: "rad",
  minimumLinearToleranceMeters: 1e-8,
  maximumLinearToleranceMeters: 1e-2,
  minimumAngularToleranceRadians: 1e-8,
  deterministicForIdenticalBuildAndInputs: true,
  supportsPersistentSessions: true,
  supportsCancellation: true,
  resourceLimits: {
    maximumInputShapes: 32,
    maximumOutputShapes: 16,
    maximumTopologyEntities: 100_000,
    maximumExchangeBytes: 10_000_000,
    maximumOperationMilliseconds: 1_000
  }
};

function manifest(): OcctQualificationManifest {
  return {
    manifestId: "occt:8.0.1-test-qualified",
    attestationVersion: 1,
    identity: {
      implementation: "ps3d-occt-runtime",
      implementationVersion: "0.1.0",
      kernel: "Open CASCADE Technology",
      kernelVersion: "8.0.1",
      buildId: "occt-wasm:test-build",
      executionTarget: "wasm-worker",
      contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
    },
    capabilities,
    source: {
      repository: "https://github.com/Open-Cascade-SAS/OCCT",
      tag: "V8_0_1",
      commit: "a".repeat(40),
      sourceArchiveSha256: digestA
    },
    artifact: {
      kind: "wasm-module",
      artifactSha256: digestB,
      buildConfigurationSha256: digestC,
      toolchain: "emscripten-qualified-test"
    },
    license: {
      license: "LGPL-2.1-only",
      specialException: "Open CASCADE Technology exception 1.0",
      licenseTextSha256: digestA,
      exceptionTextSha256: digestB,
      thirdPartyNoticesSha256: digestC,
      relinkMaterialsAvailable: true
    },
    qualification: {
      suiteId: "ps3d-occt-qualification",
      suiteVersion: "1",
      resultSha256: digestA,
      passed: true
    }
  };
}

function attestation(value = manifest()): OcctRuntimeAttestation {
  const { manifestId: _manifestId, ...runtime } = value;
  return structuredClone(runtime);
}

function boxRequest(requestId = "request:box-1"): ExecuteKernelOperationRequest {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId,
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

function boxDraft(request = boxRequest()): OperationResultDraft {
  const output = {
    shapeId: "shape:box-1",
    sessionId: request.sessionId,
    revision: 0,
    kind: "solid" as const,
    representation: "exact-brep" as const,
    contentDigest: digestB,
    toleranceMeters: 1e-6,
    boundsMeters: { min: [0, 0, 0] as const, max: [0.1, 0.2, 0.3] as const },
    topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true }
  };
  return {
    operationId: request.operation.operationId,
    operationKind: request.operation.kind,
    outputs: [output],
    validation: [{
      valid: true, exact: true, checkedToleranceMeters: 1e-6, closed: true, manifold: true,
      orientable: true, finite: true, selfIntersections: 0, invalidEntityReferenceKeys: [], diagnostics: []
    }],
    provenance: {
      operationId: request.operation.operationId,
      operationKind: request.operation.kind,
      inputShapeDigests: [], outputShapeDigests: [output.contentDigest], topologyEntities: [], provenanceDigest: digestC
    },
    diagnostics: [], exchangeArtifacts: [], tessellations: [], topologyEntities: []
  };
}

interface FakeOcctRuntimeHooks {
  readonly openSession?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  readonly releaseShapes?: (sessionId: string, shapeIds: readonly string[], signal?: AbortSignal) => Promise<readonly string[]>;
  readonly closeSession?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
}

class FakeOcctRuntime implements OcctRuntimePort {
  disposed = false;
  terminated = false;
  readonly terminationReasons: string[] = [];
  readonly cancellationRequests: string[] = [];
  readonly sessions = new Set<string>();
  constructor(
    readonly executor: (request: ExecuteKernelOperationRequest, signal?: AbortSignal) => Promise<OperationResultDraft>
      = async (request) => boxDraft(request),
    readonly hooks: FakeOcctRuntimeHooks = {}
  ) {}
  async openSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.hooks.openSession !== undefined) return this.hooks.openSession(sessionId, signal);
    this.sessions.add(sessionId);
  }
  execute(request: ExecuteKernelOperationRequest, signal?: AbortSignal): Promise<OperationResultDraft> { return this.executor(request, signal); }
  async releaseShapes(sessionId: string, shapeIds: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    if (this.hooks.releaseShapes !== undefined) return this.hooks.releaseShapes(sessionId, shapeIds, signal);
    return [...shapeIds];
  }
  async closeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.hooks.closeSession !== undefined) return this.hooks.closeSession(sessionId, signal);
    this.sessions.delete(sessionId);
  }
  async cancel(targetRequestId: string): Promise<void> { this.cancellationRequests.push(targetRequestId); }
  terminate(reason: string): void { this.terminated = true; this.terminationReasons.push(reason); }
  async dispose(): Promise<void> { this.disposed = true; }
}

function trustedLoader(runtime: OcctRuntimePort, observed: OcctRuntimeAttestation): TrustedOcctRuntimeLoader {
  return {
    async load() { return { runtime, attestation: structuredClone(observed) }; }
  };
}

async function open(adapter: Awaited<ReturnType<typeof createAttestedOcctKernelAdapter>>["adapter"]): Promise<void> {
  const response = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-1",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "open-session",
    sessionId: "session:test",
    expectedCapabilityVersion: capabilities.capabilityVersion
  });
  assert.equal(response.status, "ok");
}

test("rejects and disposes a runtime whose executable digest is not qualified", async () => {
  const expected = manifest();
  const qualified = attestation(expected);
  const runtime = new FakeOcctRuntime();
  const observed = {
    ...qualified,
    artifact: { ...qualified.artifact, artifactSha256: digestC }
  };
  await assert.rejects(
    createAttestedOcctKernelAdapter(trustedLoader(runtime, observed), expected),
    (error: unknown) => error instanceof OcctAttestationError
      && error.findings.some((finding) => finding.code === "ARTIFACT_MISMATCH")
  );
  assert.equal(runtime.terminated, true);
  assert.equal(runtime.disposed, true);
});

test("qualified runtime evaluates an exact operation and returns a bound receipt", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime();
  const { adapter, manifestId } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  assert.equal(manifestId, expected.manifestId);
  await open(adapter);
  const request = boxRequest();
  const response = await adapter.handle(request);
  assert.equal(response.status, "ok");
  if (response.status === "ok" && response.kind === "executed") {
    assert.equal(response.products.geometry.outputs[0]?.representation, "exact-brep");
    assert.equal(response.products.geometry.receipt.kernel.buildId, expected.identity.buildId);
    assert.equal(response.products.geometry.receipt.operationId, request.operation.operationId);
  }
});

test("invalid runtime products fail protocol validation instead of entering session state", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime(async (request) => ({ ...boxDraft(request), outputs: [] }));
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle(boxRequest());
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "PROTOCOL_MISMATCH");
  assert.equal(runtime.terminated, true);
});

test("deadline terminates an uncooperative runtime call with a timeout diagnostic", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime(async () => new Promise<OperationResultDraft>(() => undefined));
  const { adapter } = await createAttestedOcctKernelAdapter(
    trustedLoader(runtime, attestation(expected)), expected, { operationTimeoutMilliseconds: 10 }
  );
  await open(adapter);
  const response = await adapter.handle(boxRequest("request:box-timeout"));
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "TIMEOUT");
  assert.equal(runtime.terminated, true);
});

test("rejects a cancellation claim when the isolated runtime exposes no cancellation entrypoint", async () => {
  const expected = manifest();
  const backing = new FakeOcctRuntime();
  const runtime: OcctRuntimePort = {
    openSession: (sessionId, signal) => backing.openSession(sessionId, signal),
    execute: (request, signal) => backing.execute(request, signal),
    releaseShapes: (sessionId, shapeIds, signal) => backing.releaseShapes(sessionId, shapeIds, signal),
    closeSession: (sessionId, signal) => backing.closeSession(sessionId, signal),
    terminate: (reason) => backing.terminate(reason),
    dispose: () => backing.dispose()
  };
  await assert.rejects(
    createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected),
    (error: unknown) => error instanceof OcctAttestationError
      && error.findings.some((finding) => finding.code === "RUNTIME_CONTRACT_MISMATCH")
  );
  assert.equal(backing.terminated, true);
});

test("rejects a runtime that cannot synchronously terminate its isolation boundary", async () => {
  const expected = manifest();
  const backing = new FakeOcctRuntime();
  const runtime = {
    openSession: (sessionId: string, signal?: AbortSignal) => backing.openSession(sessionId, signal),
    execute: (request: ExecuteKernelOperationRequest, signal?: AbortSignal) => backing.execute(request, signal),
    releaseShapes: (sessionId: string, shapeIds: readonly string[], signal?: AbortSignal) => backing.releaseShapes(sessionId, shapeIds, signal),
    closeSession: (sessionId: string, signal?: AbortSignal) => backing.closeSession(sessionId, signal),
    cancel: (requestId: string) => backing.cancel(requestId),
    dispose: () => backing.dispose()
  } as unknown as OcctRuntimePort;
  await assert.rejects(
    createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected),
    (error: unknown) => error instanceof OcctAttestationError
      && error.findings.some((finding) => finding.field === "runtime.terminate")
  );
  assert.equal(backing.disposed, true);
});

test("binds a session to one document revision and rejects cross-document reuse", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime();
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle({ ...boxRequest(), documentId: "document:other" });
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "STALE_SHAPE_HANDLE");
  assert.equal(runtime.terminated, false);
});

test("quarantines a runtime that returns a cross-session shape and cannot reuse it", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime(async (request) => {
    const draft = boxDraft(request);
    return { ...draft, outputs: draft.outputs.map((output) => ({ ...output, sessionId: "session:other" })) };
  });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle(boxRequest());
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "PROTOCOL_MISMATCH");
  assert.equal(runtime.terminated, true);

  const retry = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:negotiate-after-quarantine",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "negotiate",
    requirements: {
      requiredOperations: [], requiredImportFormats: [], requiredExportFormats: [], preferredTargets: [],
      maximumRequiredToleranceMeters: 1e-6, persistentSessionRequired: false, cancellationRequired: false
    }
  });
  assert.equal(retry.status, "error");
  if (retry.status === "error") assert.equal(retry.diagnostics[0]?.code, "KERNEL_FAILURE");
});

test("rejects a duplicate execution request ID without dispatching another side effect", async () => {
  const expected = manifest();
  let executions = 0;
  const runtime = new FakeOcctRuntime(async (request) => { executions += 1; return boxDraft(request); });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const request = boxRequest("request:single-use");
  assert.equal((await adapter.handle(request)).status, "ok");
  const duplicate = await adapter.handle(request);
  assert.equal(duplicate.status, "error");
  if (duplicate.status === "error") assert.equal(duplicate.diagnostics[0]?.code, "INVALID_REQUEST");
  assert.equal(executions, 1);
  assert.equal(runtime.terminated, false);
});

test("hard cancellation terminates the isolated runtime and is document-bound", async () => {
  const expected = manifest();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = new FakeOcctRuntime(async () => {
    markStarted?.();
    return new Promise<OperationResultDraft>(() => undefined);
  });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const execution = adapter.handle(boxRequest("request:active-operation"));
  await started;
  const wrongDocument = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:cancel-wrong-document",
    generation: 0,
    documentId: "document:other",
    documentRevision: 0,
    kind: "cancel",
    targetRequestId: "request:active-operation"
  });
  assert.equal(wrongDocument.status, "error");
  assert.equal(runtime.terminated, false);

  const cancelled = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:cancel-active",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "cancel",
    targetRequestId: "request:active-operation"
  });
  assert.equal(cancelled.status, "ok");
  const interrupted = await execution;
  assert.equal(interrupted.status, "error");
  if (interrupted.status === "error") assert.equal(interrupted.diagnostics[0]?.code, "CANCELLED");
  assert.equal(runtime.terminated, true);
  assert.deepEqual(runtime.cancellationRequests, ["request:active-operation"]);
});

test("exposes immutable qualified identity, capabilities and attestation evidence", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime();
  const result = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  assert.equal(Object.isFrozen(result.adapter.identity), true);
  assert.equal(Object.isFrozen(result.adapter.capabilities), true);
  assert.equal(Object.isFrozen(result.adapter.capabilities.resourceLimits), true);
  assert.equal(Object.isFrozen(result.attestation), true);
  assert.throws(() => {
    (result.adapter.identity as { buildId: string }).buildId = "mutated";
  }, TypeError);
  assert.equal(result.adapter.identity.buildId, expected.identity.buildId);
});

test("serializes the entire isolated runtime across multiple sessions", async () => {
  const expected = manifest();
  let resolveExecution: ((draft: OperationResultDraft) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = new Promise<OperationResultDraft>((resolve) => { resolveExecution = resolve; });
  let executions = 0;
  const runtime = new FakeOcctRuntime(async () => {
    executions += 1;
    markStarted?.();
    return pending;
  });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const secondOpen = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-second",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "open-session",
    sessionId: "session:second",
    expectedCapabilityVersion: capabilities.capabilityVersion
  });
  assert.equal(secondOpen.status, "ok");

  const firstRequest = boxRequest("request:runtime-busy");
  const firstExecution = adapter.handle(firstRequest);
  await started;
  const secondRequest: ExecuteKernelOperationRequest = {
    ...boxRequest("request:blocked-second-session"),
    sessionId: "session:second",
    operation: { ...boxRequest().operation, operationId: "operation:box-2", semanticOutputIds: ["body:box-2"] }
  };
  const blocked = await adapter.handle(secondRequest);
  assert.equal(blocked.status, "error");
  if (blocked.status === "error") assert.equal(blocked.diagnostics[0]?.code, "RESOURCE_LIMIT");
  assert.equal(executions, 1);

  resolveExecution?.(boxDraft(firstRequest));
  assert.equal((await firstExecution).status, "ok");
  assert.equal(runtime.terminated, false);
});

test("management timeout quarantines and disposes an uncooperative runtime", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime(undefined, {
    openSession: async () => new Promise<void>(() => undefined)
  });
  const { adapter } = await createAttestedOcctKernelAdapter(
    trustedLoader(runtime, attestation(expected)), expected, { managementTimeoutMilliseconds: 10 }
  );
  const response = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-timeout",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "open-session",
    sessionId: "session:timeout",
    expectedCapabilityVersion: capabilities.capabilityVersion
  });
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "TIMEOUT");
  await adapter.dispose();
  assert.equal(runtime.terminated, true);
  assert.equal(runtime.disposed, true);
});

test("quarantines a runtime that labels a failed exact-shape validation as success", async () => {
  const expected = manifest();
  const runtime = new FakeOcctRuntime(async (request) => {
    const draft = boxDraft(request);
    return { ...draft, validation: draft.validation.map((report) => ({ ...report, valid: false })) };
  });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle(boxRequest("request:invalid-validation"));
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "PROTOCOL_MISMATCH");
  await adapter.dispose();
  assert.equal(runtime.terminated, true);
  assert.equal(runtime.disposed, true);
});

test("rejects unsupported and oversized imports before runtime dispatch", async () => {
  const base = manifest();
  const importCapabilities: ExactKernelCapabilities = {
    ...base.capabilities,
    supportedOperations: ["exchange.import"],
    importFormats: ["step"],
    resourceLimits: { ...base.capabilities.resourceLimits, maximumExchangeBytes: 4 }
  };
  const expected: OcctQualificationManifest = { ...base, capabilities: importCapabilities };
  let executions = 0;
  const runtime = new FakeOcctRuntime(async (request) => { executions += 1; return boxDraft(request); });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  const opened = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-import",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "open-session",
    sessionId: "session:test",
    expectedCapabilityVersion: importCapabilities.capabilityVersion
  });
  assert.equal(opened.status, "ok");
  const importRequest = (requestId: string, format: "step" | "iges", bytes: Uint8Array): ExecuteKernelOperationRequest => ({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId,
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "execute",
    sessionId: "session:test",
    expectedCapabilityVersion: importCapabilities.capabilityVersion,
    operation: {
      operationId: `operation:${requestId.slice("request:".length)}`,
      kind: "exchange.import",
      semanticOutputIds: ["body:imported"],
      linearToleranceMeters: 1e-6,
      angularToleranceRadians: 1e-6,
      expectedOutputCount: 1,
      format,
      bytes,
      fileName: `part.${format}`,
      options: { heal: true, splitCompounds: true, sourceLengthUnit: "auto", maximumToleranceMeters: 1e-5 }
    }
  });
  const unsupported = await adapter.handle(importRequest("request:import-unsupported", "iges", Uint8Array.of(1)));
  assert.equal(unsupported.status, "error");
  if (unsupported.status === "error") assert.equal(unsupported.diagnostics[0]?.code, "UNSUPPORTED_FORMAT");
  const oversized = await adapter.handle(importRequest("request:import-oversized", "step", Uint8Array.of(1, 2, 3, 4, 5)));
  assert.equal(oversized.status, "error");
  if (oversized.status === "error") assert.equal(oversized.diagnostics[0]?.code, "RESOURCE_LIMIT");
  assert.equal(executions, 0);
  assert.equal(runtime.terminated, false);
});

test("quarantines output whose aggregate topology exceeds the qualified limit", async () => {
  const base = manifest();
  const boundedCapabilities: ExactKernelCapabilities = {
    ...base.capabilities,
    resourceLimits: { ...base.capabilities.resourceLimits, maximumTopologyEntities: 34 }
  };
  const expected: OcctQualificationManifest = { ...base, capabilities: boundedCapabilities };
  const runtime = new FakeOcctRuntime();
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  const opened = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:open-topology-limit",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "open-session",
    sessionId: "session:test",
    expectedCapabilityVersion: boundedCapabilities.capabilityVersion
  });
  assert.equal(opened.status, "ok");
  const response = await adapter.handle(boxRequest("request:topology-limit"));
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "RESOURCE_LIMIT");
  assert.equal(runtime.terminated, true);
});

test("rejects a forged partial shape handle even when its ID and digest are current", async () => {
  const base = manifest();
  const validationCapabilities: ExactKernelCapabilities = {
    ...base.capabilities,
    supportedOperations: ["primitive.box", "shape.validate"]
  };
  const expected: OcctQualificationManifest = { ...base, capabilities: validationCapabilities };
  let executions = 0;
  const runtime = new FakeOcctRuntime(async (request) => { executions += 1; return boxDraft(request); });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const created = await adapter.handle(boxRequest("request:create-for-handle-check"));
  assert.equal(created.status, "ok");
  assert.equal(created.kind, "executed");
  if (created.status !== "ok" || created.kind !== "executed") return;
  const current = created.products.geometry.outputs[0]!;
  const forged = { ...current, kind: "face" as const };
  const request: ExecuteKernelOperationRequest = {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:forged-handle",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "execute",
    sessionId: "session:test",
    expectedCapabilityVersion: validationCapabilities.capabilityVersion,
    operation: {
      operationId: "operation:validate-forged-handle",
      kind: "shape.validate",
      semanticOutputIds: [],
      linearToleranceMeters: 1e-6,
      angularToleranceRadians: 1e-6,
      expectedOutputCount: 0,
      shapes: [{ shape: forged }],
      checkSelfIntersections: true,
      requireClosed: true,
      requireManifold: true
    }
  };
  const response = await adapter.handle(request);
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "STALE_SHAPE_HANDLE");
  assert.equal(executions, 1);
  assert.equal(runtime.terminated, false);
});

test("rejects non-finite operation payloads before runtime dispatch", async () => {
  const expected = manifest();
  let executions = 0;
  const runtime = new FakeOcctRuntime(async (request) => { executions += 1; return boxDraft(request); });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const request = boxRequest("request:non-finite");
  assert.equal(request.operation.kind, "primitive.box");
  if (request.operation.kind !== "primitive.box") return;
  const response = await adapter.handle({
    ...request,
    operation: { ...request.operation, sizeMeters: [Number.NaN, 0.2, 0.3] }
  });
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "INVALID_REQUEST");
  assert.equal(executions, 0);
  assert.equal(runtime.terminated, false);
});

test("hard cancellation still terminates when cooperative cancel throws synchronously", async () => {
  const expected = manifest();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const backing = new FakeOcctRuntime(async () => {
    markStarted?.();
    return new Promise<OperationResultDraft>(() => undefined);
  });
  const runtime: OcctRuntimePort = {
    openSession: (sessionId, signal) => backing.openSession(sessionId, signal),
    execute: (request, signal) => backing.execute(request, signal),
    releaseShapes: (sessionId, shapeIds, signal) => backing.releaseShapes(sessionId, shapeIds, signal),
    closeSession: (sessionId, signal) => backing.closeSession(sessionId, signal),
    cancel: () => { throw new Error("cooperative cancellation failed"); },
    terminate: (reason) => backing.terminate(reason),
    dispose: () => backing.dispose()
  };
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const execution = adapter.handle(boxRequest("request:sync-cancel-target"));
  await started;
  const cancelled = await adapter.handle({
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:sync-cancel",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "cancel",
    targetRequestId: "request:sync-cancel-target"
  });
  assert.equal(cancelled.status, "ok");
  const interrupted = await execution;
  assert.equal(interrupted.status, "error");
  if (interrupted.status === "error") assert.equal(interrupted.diagnostics[0]?.code, "CANCELLED");
  assert.equal(backing.terminated, true);
});

test("copies runtime products before exposing them to callers", async () => {
  const expected = manifest();
  let runtimeDraft: OperationResultDraft | undefined;
  const runtime = new FakeOcctRuntime(async (request) => {
    runtimeDraft = boxDraft(request);
    return runtimeDraft;
  });
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle(boxRequest("request:owned-result"));
  assert.equal(response.status, "ok");
  assert.equal(response.kind, "executed");
  if (response.status !== "ok" || response.kind !== "executed" || runtimeDraft === undefined) return;
  (runtimeDraft.outputs[0] as { sessionId: string }).sessionId = "session:mutated-after-return";
  assert.equal(response.products.geometry.outputs[0]?.sessionId, "session:test");
});

test("reports non-canonical observed evidence as an attestation mismatch", async () => {
  const expected = manifest();
  const qualified = attestation(expected);
  const malformed: OcctRuntimeAttestation = {
    ...qualified,
    identity: { ...qualified.identity, buildId: Number.NaN as unknown as string }
  };
  const runtime = new FakeOcctRuntime();
  await assert.rejects(
    createAttestedOcctKernelAdapter(trustedLoader(runtime, malformed), expected),
    (error: unknown) => error instanceof OcctAttestationError
      && error.findings.some((finding) => finding.code === "IDENTITY_MISMATCH")
  );
  assert.equal(runtime.terminated, true);
  assert.equal(runtime.disposed, true);
});

test("rejects a qualification manifest with any non-positive resource limit", async () => {
  const base = manifest();
  const invalidCapabilities: ExactKernelCapabilities = {
    ...base.capabilities,
    resourceLimits: { ...base.capabilities.resourceLimits, maximumInputShapes: 0 }
  };
  const expected: OcctQualificationManifest = { ...base, capabilities: invalidCapabilities };
  const runtime = new FakeOcctRuntime();
  await assert.rejects(
    createAttestedOcctKernelAdapter(trustedLoader(runtime, attestation(expected)), expected),
    (error: unknown) => error instanceof OcctAttestationError
      && error.findings.some((finding) => finding.field === "capabilities.resourceLimits.maximumInputShapes")
  );
  assert.equal(runtime.terminated, true);
  assert.equal(runtime.disposed, true);
});

function cylinderRequest(requestId = "request:cyl-1"): ExecuteKernelOperationRequest {
  return {
    ...boxRequest(requestId),
    operation: {
      operationId: "operation:cyl-1",
      kind: "primitive.cylinder",
      semanticOutputIds: ["body:cyl"],
      linearToleranceMeters: 1e-6,
      angularToleranceRadians: 1e-6,
      expectedOutputCount: 1,
      radiusMeters: 0.05,
      heightMeters: 0.2,
      placement: { origin: [0, 0, 0], direction: [0, 0, 1], xDirection: [1, 0, 0] }
    }
  };
}

function meshVolume(positions: Float64Array, indices: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return total / 6;
}

test("the reference B-rep runtime evaluates a real box through the attested adapter", async () => {
  const expected = manifest();
  const { adapter } = await createAttestedOcctKernelAdapter(trustedLoader(createReferenceBrepRuntime(), attestation(expected)), expected);
  await open(adapter);
  const response = await adapter.handle(boxRequest());
  assert.equal(response.status, "ok");
  if (response.status === "ok" && response.kind === "executed") {
    const shape = response.products.geometry.outputs[0]!;
    assert.equal(shape.representation, "exact-brep");
    assert.deepEqual(shape.topology, { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
    assert.deepEqual(shape.boundsMeters, { min: [0, 0, 0], max: [0.1, 0.2, 0.3] });
    assert.equal(response.products.tessellations[0]?.indices.length, 36);
    assert.equal(response.products.geometry.validation[0]?.closed, true);
  }
});

test("the reference B-rep runtime is content-addressed and size-sensitive", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const first = await runtime.execute(boxRequest());
  const second = await runtime.execute(boxRequest());
  assert.equal(first.outputs[0]!.contentDigest, second.outputs[0]!.contentDigest);
  const request = boxRequest();
  assert.equal(request.operation.kind, "primitive.box");
  if (request.operation.kind !== "primitive.box") return;
  const bigger = await runtime.execute({ ...request, operation: { ...request.operation, sizeMeters: [0.2, 0.2, 0.3] } });
  assert.notEqual(first.outputs[0]!.contentDigest, bigger.outputs[0]!.contentDigest);
});

test("the reference box tessellation is a watertight outward solid with exact volume", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const result = await runtime.execute(boxRequest());
  const tess = result.tessellations[0]!;
  assert.equal(tess.indices.length, 36);
  assert.ok(Math.abs(meshVolume(tess.positions, tess.indices) - 0.1 * 0.2 * 0.3) < 1e-9);
});

test("the reference B-rep runtime builds a valid analytic cylinder", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const result = await runtime.execute(cylinderRequest());
  assert.deepEqual(result.outputs[0]!.topology, { vertices: 2, edges: 3, wires: 3, faces: 3, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  const exact = Math.PI * 0.05 * 0.05 * 0.2;
  const volume = meshVolume(result.tessellations[0]!.positions, result.tessellations[0]!.indices);
  assert.ok(volume > exact * 0.98 && volume <= exact + 1e-9, `cylinder volume ${volume} vs ${exact}`);
});

function customBoxRequest(requestId: string, operationId: string, size: readonly [number, number, number], origin: readonly [number, number, number]): ExecuteKernelOperationRequest {
  return {
    ...boxRequest(requestId),
    operation: {
      operationId, kind: "primitive.box", semanticOutputIds: ["body:box"],
      linearToleranceMeters: 1e-6, angularToleranceRadians: 1e-6, expectedOutputCount: 1,
      sizeMeters: size, placement: { origin, normal: [0, 0, 1], xDirection: [1, 0, 0] }
    }
  };
}

function extrudeRequest(profile: ExactShapeHandle, distanceMeters = 0.5): ExecuteKernelOperationRequest {
  return {
    ...boxRequest("request:ext-1"),
    operation: {
      operationId: "operation:ext-1", kind: "solid.extrude", semanticOutputIds: ["body:ext"],
      linearToleranceMeters: 1e-6, angularToleranceRadians: 1e-6, expectedOutputCount: 1,
      profiles: [{ shape: profile }], direction: [0, 0, 1],
      extent: { kind: "distance", distanceMeters, symmetric: false },
      taperAngleRadians: 0, outputMode: "new-body", targets: []
    }
  };
}

function booleanRequest(mode: "join" | "cut" | "intersect", target: ExactShapeHandle, tool: ExactShapeHandle): ExecuteKernelOperationRequest {
  return {
    ...boxRequest("request:bool-1"),
    operation: {
      operationId: "operation:bool-1", kind: "solid.boolean", semanticOutputIds: ["body:bool"],
      linearToleranceMeters: 1e-6, angularToleranceRadians: 1e-6, expectedOutputCount: 1,
      mode, targets: [{ shape: target }], tools: [{ shape: tool }], keepTools: false, fuzzyToleranceMeters: 1e-7
    }
  };
}

test("the reference B-rep runtime extrudes a stored profile loop into an exact prism", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const box = await runtime.execute(boxRequest("request:box-a"));
  const prism = await runtime.execute(extrudeRequest(box.outputs[0]!));
  assert.deepEqual(prism.outputs[0]!.topology, { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  const volume = meshVolume(prism.tessellations[0]!.positions, prism.tessellations[0]!.indices);
  assert.ok(Math.abs(volume - 0.1 * 0.2 * 0.5) < 1e-9, `prism volume ${volume}`);
});

test("the reference Boolean intersects two boxes into the exact overlap solid", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const a = (await runtime.execute(customBoxRequest("request:a", "operation:a", [0.1, 0.2, 0.3], [0, 0, 0]))).outputs[0]!;
  const b = (await runtime.execute(customBoxRequest("request:b", "operation:b", [0.1, 0.2, 0.3], [0.05, 0, 0]))).outputs[0]!;
  const result = await runtime.execute(booleanRequest("intersect", a, b));
  assert.deepEqual(result.outputs[0]!.boundsMeters, { min: [0.05, 0, 0], max: [0.1, 0.2, 0.3] });
  const volume = meshVolume(result.tessellations[0]!.positions, result.tessellations[0]!.indices);
  assert.ok(Math.abs(volume - 0.05 * 0.2 * 0.3) < 1e-9, `intersect volume ${volume}`);
});

test("the reference Boolean cut trims a box into a smaller exact box", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const a = (await runtime.execute(customBoxRequest("request:a", "operation:a", [0.1, 0.2, 0.3], [0, 0, 0]))).outputs[0]!;
  const b = (await runtime.execute(customBoxRequest("request:b", "operation:b", [0.3, 0.4, 0.2], [-0.1, -0.1, -0.1]))).outputs[0]!;
  const result = await runtime.execute(booleanRequest("cut", a, b));
  assert.deepEqual(result.outputs[0]!.boundsMeters, { min: [0, 0, 0.1], max: [0.1, 0.2, 0.3] });
});

test("the reference Boolean join of nested boxes returns the enclosing box", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const outer = (await runtime.execute(customBoxRequest("request:a", "operation:a", [0.2, 0.2, 0.2], [0, 0, 0]))).outputs[0]!;
  const inner = (await runtime.execute(customBoxRequest("request:b", "operation:b", [0.05, 0.05, 0.05], [0.05, 0.05, 0.05]))).outputs[0]!;
  const result = await runtime.execute(booleanRequest("join", outer, inner));
  assert.deepEqual(result.outputs[0]!.boundsMeters, { min: [0, 0, 0], max: [0.2, 0.2, 0.2] });
});

test("the reference Boolean rejects a general non-convex configuration explicitly", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const a = (await runtime.execute(customBoxRequest("request:a", "operation:a", [0.1, 0.1, 0.1], [0, 0, 0]))).outputs[0]!;
  const b = (await runtime.execute(customBoxRequest("request:b", "operation:b", [0.1, 0.1, 0.1], [0.05, 0.05, 0.05]))).outputs[0]!;
  await assert.rejects(runtime.execute(booleanRequest("join", a, b)));
});

test("box faces carry stable lineage-anchored references that survive a dimensional rebuild", async () => {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:test");
  const first = await runtime.execute(customBoxRequest("request:r1", "operation:plate", [0.1, 0.2, 0.3], [0, 0, 0]));
  const second = await runtime.execute(customBoxRequest("request:r2", "operation:plate", [0.5, 0.6, 0.7], [0, 0, 0]));
  assert.equal(first.topologyEntities.length, 6);
  const roles = first.topologyEntities.map((entity) => entity.stableReference.producer.role).sort();
  assert.deepEqual(roles, ["face.x-max", "face.x-min", "face.y-max", "face.y-min", "face.z-max", "face.z-min"]);
  assert.ok(first.topologyEntities.every((entity) => entity.adjacentReferenceKeys.length === 4), "each box face has four first-ring neighbors");
  const keyByRole = (entities: readonly import("../../exact-kernel-api/src/index.js").ResolvedTopologyEntity[]) => new Map(entities.map((entity) => [entity.stableReference.producer.role, entity.stableReference.key]));
  const firstKeys = keyByRole(first.topologyEntities);
  const secondKeys = keyByRole(second.topologyEntities);
  for (const role of roles) assert.equal(firstKeys.get(role), secondKeys.get(role), `the ${role} key must survive the rebuild`);
  const zTop1 = first.topologyEntities.find((entity) => entity.stableReference.producer.role === "face.z-max")!;
  const zTop2 = second.topologyEntities.find((entity) => entity.stableReference.producer.role === "face.z-max")!;
  assert.equal(zTop1.stableReference.lineageDigest, zTop2.stableReference.lineageDigest);
  assert.notEqual(zTop1.stableReference.signature.signatureDigest, zTop2.stableReference.signature.signatureDigest);
  assert.ok(Math.abs(zTop1.stableReference.signature.measure - 0.1 * 0.2) < 1e-9, "the top face area is width*depth");
});

test("the browser prism facade returns exact topology, volume, and stable named faces", async () => {
  const { evaluateProfilePrism } = await import("../src/index.js");
  const result = await evaluateProfilePrism({
    operationId: "operation:plate", semanticId: "body:plate",
    profilePointsMeters: [[0, 0, 0], [0.02, 0, 0], [0.02, 0.01, 0], [0, 0.01, 0]],
    normal: [0, 0, 1], heightMeters: 0.005
  });
  assert.deepEqual(result.topology, { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  assert.ok(Math.abs(result.volumeCubicMeters - 0.02 * 0.01 * 0.005) < 1e-12, `prism volume ${result.volumeCubicMeters}`);
  assert.equal(result.faces.length, 6);
  const roles = result.faces.map((face) => face.role).sort();
  assert.deepEqual(roles, ["face.cap-bottom", "face.cap-top", "face.side-0", "face.side-1", "face.side-2", "face.side-3"]);
  assert.ok(result.faces.every((face) => /^face:[a-f0-9]{40}$/u.test(face.key)), "each face carries a stable reference key");
  const rebuilt = await evaluateProfilePrism({
    operationId: "operation:plate", semanticId: "body:plate",
    profilePointsMeters: [[0, 0, 0], [0.04, 0, 0], [0.04, 0.03, 0], [0, 0.03, 0]],
    normal: [0, 0, 1], heightMeters: 0.01
  });
  assert.equal(result.faces.find((face) => face.role === "face.cap-top")!.key, rebuilt.faces.find((face) => face.role === "face.cap-top")!.key, "the cap-top key survives a dimensional rebuild");
});

test("the revolve facade builds a genus-1 full ring and a genus-0 partial sweep with named faces", async () => {
  const { evaluateProfileRevolution } = await import("../src/index.js");
  const profile: readonly (readonly [number, number])[] = [[0.01, -0.002], [0.02, -0.002], [0.02, 0.002], [0.01, 0.002]];
  const analyticVolume = (0.01 * 0.004) * 0.015; // area * centroid radius, times the sweep angle below

  const full = await evaluateProfileRevolution({ operationId: "operation:ring", semanticId: "body:ring", profilePoints: profile, degrees: 360 });
  assert.deepEqual(full.topology, { vertices: 0, edges: 4, wires: 4, faces: 4, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  assert.deepEqual(full.faces.map((face) => face.role).sort(), ["face.revolve-0", "face.revolve-1", "face.revolve-2", "face.revolve-3"]);
  const fullVolume = meshVolume(Float64Array.from(full.positionsMeters), Uint32Array.from(full.indices));
  const fullExact = analyticVolume * 2 * Math.PI;
  assert.ok(fullVolume > fullExact * 0.99 && fullVolume <= fullExact + 1e-12, `full revolve volume ${fullVolume} vs ${fullExact}`);

  const quarter = await evaluateProfileRevolution({ operationId: "operation:ring", semanticId: "body:ring", profilePoints: profile, degrees: 90 });
  assert.deepEqual(quarter.topology, { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  assert.deepEqual(quarter.faces.map((face) => face.role).sort(), ["face.cap-end", "face.cap-start", "face.swept-0", "face.swept-1", "face.swept-2", "face.swept-3"]);
  const quarterVolume = meshVolume(Float64Array.from(quarter.positionsMeters), Uint32Array.from(quarter.indices));
  const quarterExact = analyticVolume * (Math.PI / 2);
  assert.ok(quarterVolume > quarterExact * 0.99 && quarterVolume <= quarterExact + 1e-12, `quarter revolve volume ${quarterVolume} vs ${quarterExact}`);
  assert.ok(full.faces.every((face) => /^face:[a-f0-9]{40}$/u.test(face.key)), "revolve faces carry stable keys");
});

test("chamfering every corner of a prism builds bevel faces with exact area, volume, and Euler-valid topology", async () => {
  const { evaluateProfilePrism } = await import("../src/index.js");
  const rectangle: readonly (readonly [number, number, number])[] = [[0, 0, 0], [0.02, 0, 0], [0.02, 0.01, 0], [0, 0.01, 0]];
  const plain = await evaluateProfilePrism({ operationId: "operation:plate", semanticId: "body:plate", profilePointsMeters: rectangle, normal: [0, 0, 1], heightMeters: 0.005 });
  const chamfered = await evaluateProfilePrism({
    operationId: "operation:plate", semanticId: "body:plate", profilePointsMeters: rectangle, normal: [0, 0, 1], heightMeters: 0.005,
    cornerTreatment: { kind: "chamfer", sizeMeters: 0.002 }
  });
  // 4 sides + 4 chamfers + 2 caps = 10 faces; 8 side faces -> 16 vertices, 24 edges (Euler 16 - 24 + 10 = 2).
  assert.deepEqual(chamfered.topology, { vertices: 16, edges: 24, wires: 10, faces: 10, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  assert.deepEqual(chamfered.faces.map((face) => face.role).sort(), [
    "face.cap-bottom", "face.cap-top", "face.chamfer-0", "face.chamfer-1", "face.chamfer-2", "face.chamfer-3",
    "face.side-0", "face.side-1", "face.side-2", "face.side-3"
  ]);
  // Four triangular corners of 0.5 * 2 mm * 2 mm are removed from the 200 mm^2 rectangle.
  const exactArea = 200e-6 - 4 * 0.5 * 0.002 * 0.002;
  const volume = meshVolume(Float64Array.from(chamfered.positionsMeters), Uint32Array.from(chamfered.indices));
  assert.ok(Math.abs(volume - exactArea * 0.005) < 1e-12, `chamfered volume ${volume} vs ${exactArea * 0.005}`);
  const chamferArea = chamfered.faces.find((face) => face.role === "face.chamfer-0")!.areaSquareMeters;
  assert.ok(Math.abs(chamferArea - Math.hypot(0.002, 0.002) * 0.005) < 1e-12, "a bevel face is its slant width times the height");
  // The original side faces keep the very same stable keys when corners are chamfered.
  for (const role of ["face.side-0", "face.side-1", "face.side-2", "face.side-3", "face.cap-top", "face.cap-bottom"]) {
    assert.equal(plain.faces.find((face) => face.role === role)!.key, chamfered.faces.find((face) => face.role === role)!.key, `${role} key survives the chamfer`);
  }
  assert.equal(chamfered.faceTriangles.length * 3, chamfered.indices.length);
});

test("filleting a prism builds one cylindrical face per corner whose volume matches the rounded outline", async () => {
  const { evaluateProfilePrism } = await import("../src/index.js");
  const radius = 0.002;
  const filleted = await evaluateProfilePrism({
    operationId: "operation:plate", semanticId: "body:plate",
    profilePointsMeters: [[0, 0, 0], [0.02, 0, 0], [0.02, 0.01, 0], [0, 0.01, 0]], normal: [0, 0, 1], heightMeters: 0.005,
    cornerTreatment: { kind: "fillet", sizeMeters: radius }
  });
  // Each fillet is a single face however many facets approximate it: 4 sides + 4 fillets + 2 caps.
  assert.equal(filleted.topology.faces, 10);
  assert.equal(filleted.topology.vertices - filleted.topology.edges + filleted.topology.faces, 2);
  assert.ok(filleted.faces.some((face) => face.role === "face.fillet-2"));
  const exactArea = 200e-6 - 4 * (radius * radius - (Math.PI * radius * radius) / 4);
  const volume = meshVolume(Float64Array.from(filleted.positionsMeters), Uint32Array.from(filleted.indices));
  // The faceted arc sits just inside the true arc, so the mesh is marginally under the analytic volume.
  assert.ok(volume < exactArea * 0.005 + 1e-15 && volume > exactArea * 0.005 * 0.9995, `filleted volume ${volume} vs ${exactArea * 0.005}`);
  const arcArea = filleted.faces.find((face) => face.role === "face.fillet-0")!.areaSquareMeters;
  assert.ok(arcArea < (Math.PI / 2) * radius * 0.005 && arcArea > (Math.PI / 2) * radius * 0.005 * 0.99, `fillet face area ${arcArea}`);
});

test("corner treatment can target a subset, rejects oversized settings, and normalises clockwise loops", async () => {
  const { evaluateProfilePrism } = await import("../src/index.js");
  const base = { operationId: "operation:plate", semanticId: "body:plate", normal: [0, 0, 1] as const, heightMeters: 0.005 };
  const counterClockwise: readonly (readonly [number, number, number])[] = [[0, 0, 0], [0.02, 0, 0], [0.02, 0.01, 0], [0, 0.01, 0]];

  const single = await evaluateProfilePrism({ ...base, profilePointsMeters: counterClockwise, cornerTreatment: { kind: "chamfer", sizeMeters: 0.002, cornerIndices: [2] } });
  assert.equal(single.topology.faces, 7, "one chamfer adds exactly one face");
  assert.ok(single.faces.some((face) => face.role === "face.chamfer-2") && !single.faces.some((face) => face.role === "face.chamfer-0"));

  await assert.rejects(evaluateProfilePrism({ ...base, profilePointsMeters: counterClockwise, cornerTreatment: { kind: "chamfer", sizeMeters: 0.006 } }), /too large/u);
  await assert.rejects(evaluateProfilePrism({ ...base, profilePointsMeters: counterClockwise, cornerTreatment: { kind: "fillet", sizeMeters: 0 } }), /positive/u);

  // A clockwise loop must still produce an outward-wound solid of positive volume.
  const clockwise = [...counterClockwise].reverse();
  const reversed = await evaluateProfilePrism({ ...base, profilePointsMeters: clockwise });
  const volume = meshVolume(Float64Array.from(reversed.positionsMeters), Uint32Array.from(reversed.indices));
  assert.ok(Math.abs(volume - 200e-6 * 0.005) < 1e-12, `clockwise loop volume ${volume}`);
});

test("a circular profile extrudes into one cylindrical face with cylinder topology", async () => {
  const { evaluateProfilePrism } = await import("../src/index.js");
  const radius = 0.005;
  const height = 0.01;
  const circle = Array.from({ length: 72 }, (_, step): readonly [number, number, number] => {
    const angle = (2 * Math.PI * step) / 72;
    return [radius * Math.cos(angle), radius * Math.sin(angle), 0];
  });
  const base = { operationId: "operation:pin", semanticId: "body:pin", profilePointsMeters: circle, normal: [0, 0, 1] as const, heightMeters: height };

  const smooth = await evaluateProfilePrism({ ...base, smoothSides: true });
  assert.deepEqual(smooth.topology, { vertices: 2, edges: 3, wires: 3, faces: 3, shells: 1, solids: 1, components: 1, closed: true, manifold: true });
  assert.deepEqual(smooth.faces.map((face) => face.role).sort(), ["face.cap-bottom", "face.cap-top", "face.lateral"]);
  assert.equal(smooth.faceTriangles.length * 3, smooth.indices.length);
  assert.ok(smooth.faceTriangles.every((face) => face >= 0 && face < 3), "every triangle maps to one of the three faces");

  const exactVolume = Math.PI * radius * radius * height;
  const volume = meshVolume(Float64Array.from(smooth.positionsMeters), Uint32Array.from(smooth.indices));
  assert.ok(volume < exactVolume && volume > exactVolume * 0.995, `cylinder volume ${volume} vs ${exactVolume}`);
  const lateral = smooth.faces.find((face) => face.role === "face.lateral")!.areaSquareMeters;
  assert.ok(lateral < 2 * Math.PI * radius * height && lateral > 2 * Math.PI * radius * height * 0.995, `lateral area ${lateral}`);

  // The default (non-smooth) path is unchanged: one planar face per segment.
  const faceted = await evaluateProfilePrism(base);
  assert.equal(faceted.topology.faces, 74);

  // The lateral face is stable across a size change, and the caps keep their names.
  const bigger = await evaluateProfilePrism({ ...base, profilePointsMeters: circle.map(([x, y]) => [x * 2, y * 2, 0] as const), smoothSides: true });
  assert.equal(smooth.faces.find((face) => face.role === "face.lateral")!.key, bigger.faces.find((face) => face.role === "face.lateral")!.key, "the lateral key survives a resize");

  await assert.rejects(evaluateProfilePrism({ ...base, smoothSides: true, cornerTreatment: { kind: "fillet", sizeMeters: 0.001 } }), /no corners/u);
});
