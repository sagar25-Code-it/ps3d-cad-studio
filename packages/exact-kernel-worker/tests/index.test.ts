import assert from "node:assert/strict";
import test from "node:test";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  type ExactKernelAdapter,
  type ExactKernelCapabilities,
  type ExactKernelRequest,
  type ExactKernelResponse,
  type KernelIdentity,
  type NegotiateKernelRequest
} from "../../exact-kernel-api/src/index.js";
import {
  WorkerExactKernelAdapter,
  chooseKernelAdapter,
  createExactKernelWorkerHandler,
  type StructuredCloneWorkerPort
} from "../src/index.js";

const capabilities: ExactKernelCapabilities = {
  capabilityVersion: "test-v1",
  supportedOperations: ["primitive.box"],
  importFormats: [],
  exportFormats: ["step"],
  supportedContinuity: ["g0"],
  canonicalLengthUnit: "m",
  canonicalAngleUnit: "rad",
  minimumLinearToleranceMeters: 1e-7,
  maximumLinearToleranceMeters: 1e-2,
  minimumAngularToleranceRadians: 1e-7,
  deterministicForIdenticalBuildAndInputs: true,
  supportsPersistentSessions: true,
  supportsCancellation: true,
  resourceLimits: {
    maximumInputShapes: 8,
    maximumOutputShapes: 8,
    maximumTopologyEntities: 1000,
    maximumExchangeBytes: 1024,
    maximumOperationMilliseconds: 1000
  }
};

function identity(target: "wasm-worker" | "native-worker"): KernelIdentity {
  return {
    implementation: `test-${target}`,
    implementationVersion: "1",
    kernel: "test",
    kernelVersion: "1",
    buildId: `build-${target}`,
    executionTarget: target,
    contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
  };
}

function negotiation(preferredTargets: NegotiateKernelRequest["requirements"]["preferredTargets"] = []): NegotiateKernelRequest {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:negotiate",
    generation: 0,
    documentId: "document:test",
    documentRevision: 0,
    kind: "negotiate",
    requirements: {
      requiredOperations: ["primitive.box"],
      requiredImportFormats: [],
      requiredExportFormats: ["step"],
      preferredTargets,
      maximumRequiredToleranceMeters: 1e-6,
      persistentSessionRequired: true,
      cancellationRequired: true
    }
  };
}

class LoopbackPort implements StructuredCloneWorkerPort {
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();
  peer?: LoopbackPort;

  postMessage(message: unknown): void {
    queueMicrotask(() => {
      if (this.peer !== undefined) this.peer.#emit(message);
    });
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#listeners.delete(listener);
  }

  #emit(data: unknown): void {
    for (const listener of this.#listeners) listener({ data } as MessageEvent<unknown>);
  }
}

function connectedPorts(): readonly [LoopbackPort, LoopbackPort] {
  const client = new LoopbackPort();
  const host = new LoopbackPort();
  client.peer = host;
  host.peer = client;
  return [client, host];
}

function negotiationAdapter(target: "wasm-worker" | "native-worker"): ExactKernelAdapter {
  return {
    identity: identity(target),
    capabilities,
    async handle(request: ExactKernelRequest): Promise<ExactKernelResponse> {
      assert.equal(request.kind, "negotiate");
      return {
        protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
        requestId: request.requestId,
        generation: request.generation,
        documentId: request.documentId,
        documentRevision: request.documentRevision,
        status: "ok",
        kind: "negotiated",
        identity: identity(target),
        capabilities,
        satisfied: true,
        diagnostics: []
      };
    }
  };
}

test("moves a validated negotiation through a structured-clone worker", async () => {
  const [clientPort, hostPort] = connectedPorts();
  const hostAdapter = negotiationAdapter("wasm-worker");
  hostPort.addEventListener("message", createExactKernelWorkerHandler(hostAdapter, (frame) => hostPort.postMessage(frame)));
  const client = new WorkerExactKernelAdapter(clientPort, hostAdapter.identity, capabilities, { timeoutMilliseconds: 500 });
  const response = await client.handle(negotiation());
  assert.equal(response.status, "ok");
  assert.equal(response.kind, "negotiated");
  client.close();
});

test("returns a typed cancellation without dispatching", async () => {
  const [clientPort] = connectedPorts();
  const client = new WorkerExactKernelAdapter(clientPort, identity("wasm-worker"), capabilities);
  const abort = new AbortController();
  abort.abort();
  const response = await client.handle(negotiation(), abort.signal);
  assert.equal(response.status, "error");
  if (response.status === "error") assert.equal(response.diagnostics[0]?.code, "CANCELLED");
  client.close();
});

test("prefers the WASM adapter unless native is explicitly preferred", async () => {
  const wasm = negotiationAdapter("wasm-worker");
  const native = negotiationAdapter("native-worker");
  const ordinary = await chooseKernelAdapter(negotiation(), [native, wasm]);
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) assert.equal(ordinary.selection.adapter.identity.executionTarget, "wasm-worker");
  const heavy = await chooseKernelAdapter(negotiation(["native-worker"]), [wasm, native]);
  assert.equal(heavy.ok, true);
  if (heavy.ok) assert.equal(heavy.selection.adapter.identity.executionTarget, "native-worker");
});

test("isolates default message IDs when multiple adapters share one port", async () => {
  const [clientPort, hostPort] = connectedPorts();
  const hostAdapter = negotiationAdapter("wasm-worker");
  hostPort.addEventListener("message", createExactKernelWorkerHandler(hostAdapter, (frame) => hostPort.postMessage(frame)));
  const first = new WorkerExactKernelAdapter(clientPort, hostAdapter.identity, capabilities, { timeoutMilliseconds: 500 });
  const second = new WorkerExactKernelAdapter(clientPort, hostAdapter.identity, capabilities, { timeoutMilliseconds: 500 });
  const firstRequest = { ...negotiation(), requestId: "request:negotiate-first" };
  const secondRequest = { ...negotiation(), requestId: "request:negotiate-second" };
  const [firstResponse, secondResponse] = await Promise.all([first.handle(firstRequest), second.handle(secondRequest)]);
  assert.equal(firstResponse.status, "ok");
  assert.equal(secondResponse.status, "ok");
  assert.equal(firstResponse.requestId, firstRequest.requestId);
  assert.equal(secondResponse.requestId, secondRequest.requestId);
  first.close();
  second.close();
});

test("returns a typed failure and clears pending state when postMessage throws", async () => {
  const port: StructuredCloneWorkerPort = {
    postMessage() { throw new Error("port is closed"); },
    addEventListener() {},
    removeEventListener() {}
  };
  const client = new WorkerExactKernelAdapter(port, identity("wasm-worker"), capabilities, { timeoutMilliseconds: 500 });
  const response = await client.handle(negotiation());
  assert.equal(response.status, "error");
  if (response.status === "error") {
    assert.equal(response.diagnostics[0]?.code, "KERNEL_FAILURE");
    assert.match(response.diagnostics[0]?.message ?? "", /port is closed/u);
  }
  client.close();
});

test("selection rejects negotiation identity spoofing", async () => {
  const adapter = negotiationAdapter("wasm-worker");
  const spoofing: ExactKernelAdapter = {
    ...adapter,
    async handle(request) {
      const response = await adapter.handle(request);
      assert.equal(response.status, "ok");
      assert.equal(response.kind, "negotiated");
      return { ...response, identity: { ...response.identity, buildId: "spoofed-build" } };
    }
  };
  const selection = await chooseKernelAdapter(negotiation(), [spoofing]);
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.ok(selection.rejected[0]?.diagnostics.some((item) => item.code === "PROTOCOL_MISMATCH"));
});
