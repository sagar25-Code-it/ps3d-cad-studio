import assert from "node:assert/strict";
import test from "node:test";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  type ExactKernelCapabilities,
  type ExecuteKernelOperationRequest,
  type OperationResultDraft
} from "../../exact-kernel-api/src/index.js";
import {
  OcctAttestationError,
  createAttestedOcctKernelAdapter,
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
