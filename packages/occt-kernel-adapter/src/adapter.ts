import { inputShapeHandles } from "../../exact-kernel-api/src/operations.js";
import {
  bytesToHex,
  canonicalKernelJson,
  failureResponse,
  finalizeOperationProducts,
  negotiateKernelCapabilities,
  protocolDiagnostic,
  responseEnvelope,
  validateKernelRequest,
  validateKernelResponse,
  type ExactKernelAdapter,
  type ExactKernelCapabilities,
  type ExactKernelRequest,
  type ExactKernelResponse,
  type ExactShapeHandle,
  type ExecuteKernelOperationRequest,
  type KernelDiagnostic,
  type KernelExecutionSuccess,
  type KernelIdentity,
  type OperationResultDraft
} from "../../exact-kernel-api/src/index.js";
import { OcctAttestationError, verifyOcctRuntimeAttestation } from "./attestation.js";
import type {
  AttestedOcctKernel,
  OcctAdapterOptions,
  OcctRuntimeAttestation,
  OcctRuntimePort,
  TrustedOcctRuntimeLoader
} from "./types.js";

type SessionStatus = "open" | "busy";

interface SessionState {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly generation: number;
  readonly shapes: Map<string, ExactShapeHandle>;
  status: SessionStatus;
}

interface ActiveOperation {
  readonly sessionId: string;
  readonly controller: AbortController;
  timedOut: boolean;
  externallyAborted: boolean;
}

const MAXIMUM_TRACKED_RUNTIME_REQUEST_IDS = 100_000;
const MAXIMUM_PROTOCOL_TREE_NODES = 250_000;
const MAXIMUM_PROTOCOL_TEXT_BYTES = 1_000_000;
const KERNEL_DIAGNOSTIC_CODES = new Set([
  "INVALID_REQUEST", "PROTOCOL_MISMATCH", "CAPABILITY_UNAVAILABLE", "RESOURCE_LIMIT", "CANCELLED", "TIMEOUT",
  "SESSION_NOT_FOUND", "SHAPE_NOT_FOUND", "STALE_SHAPE_HANDLE", "TOPOLOGY_REFERENCE_NOT_FOUND",
  "TOPOLOGY_REFERENCE_AMBIGUOUS", "INVALID_GEOMETRY", "DEGENERATE_GEOMETRY", "SELF_INTERSECTION",
  "NON_MANIFOLD_RESULT", "OPEN_SHELL", "BOOLEAN_FAILED", "HEALING_INCOMPLETE", "IMPORT_FAILED", "EXPORT_FAILED",
  "UNSUPPORTED_FORMAT", "KERNEL_FAILURE", "FIXTURE_MISSING", "FIXTURE_INVALID"
]);
const KERNEL_OPERATION_KINDS = new Set([
  "primitive.box", "primitive.cylinder", "primitive.cone", "primitive.sphere", "primitive.torus",
  "solid.extrude", "solid.revolve", "solid.sweep", "solid.loft", "solid.boolean", "solid.hole", "solid.thread",
  "solid.fillet", "solid.chamfer", "solid.draft", "solid.shell", "solid.rib", "solid.thin-extrude",
  "solid.pattern-linear", "solid.pattern-circular", "solid.pattern-path", "solid.mirror", "direct.move-face",
  "direct.offset-face", "direct.replace-face", "direct.delete-face", "surface.extrude", "surface.revolve",
  "surface.sweep", "surface.loft", "surface.patch", "surface.offset", "surface.trim", "surface.extend",
  "surface.stitch", "surface.thicken", "construct.plane", "construct.axis", "construct.point", "shape.heal",
  "shape.validate", "topology.describe", "exchange.import", "exchange.export", "display.tessellate"
]);
const TOPOLOGY_KINDS = new Set(["vertex", "edge", "wire", "face", "shell", "solid", "compsolid", "compound"]);

export async function createAttestedOcctKernelAdapter(
  loader: TrustedOcctRuntimeLoader,
  manifest: import("./types.js").OcctQualificationManifest,
  options: OcctAdapterOptions = {},
  signal?: AbortSignal
): Promise<AttestedOcctKernel> {
  let runtime: OcctRuntimePort | undefined;
  try {
    const loaded = await loader.load(manifest, signal);
    runtime = loaded.runtime;
    if (signal?.aborted === true) throw new BoundedRuntimeError("cancelled");
    const findings = [...verifyOcctRuntimeAttestation(manifest, loaded.attestation)];
    const runtimeRecord = runtime as unknown as Readonly<Record<string, unknown>>;
    for (const method of ["openSession", "execute", "releaseShapes", "closeSession", "terminate"] as const) {
      if (typeof runtimeRecord[method] !== "function") findings.push({
        code: "RUNTIME_CONTRACT_MISMATCH",
        field: `runtime.${method}`,
        message: `The isolated runtime does not expose required '${method}' lifecycle behavior.`
      });
    }
    if (runtime.dispose !== undefined && typeof runtime.dispose !== "function") findings.push({
      code: "RUNTIME_CONTRACT_MISMATCH",
      field: "runtime.dispose",
      message: "The optional runtime disposal entrypoint is not callable."
    });
    if (loaded.attestation.capabilities.supportsCancellation && runtime.cancel === undefined) findings.push({
      code: "RUNTIME_CONTRACT_MISMATCH",
      field: "runtime.cancel",
      message: "The runtime advertises cancellation but exposes no cancellation entrypoint."
    });
    if (findings.length > 0) throw new OcctAttestationError(findings);
    const adapter = new OcctKernelAdapter(runtime, loaded.attestation, options);
    return {
      adapter,
      attestation: deepFreezeClone(loaded.attestation),
      manifestId: manifest.manifestId
    };
  } catch (error) {
    if (runtime !== undefined) {
      terminateWithoutMasking(runtime, "OCCT activation failed");
      await disposeWithoutMasking(runtime);
    }
    throw error;
  }
}

export class OcctKernelAdapter implements ExactKernelAdapter {
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  readonly #runtime: OcctRuntimePort;
  readonly #operationTimeoutMilliseconds: number;
  readonly #managementTimeoutMilliseconds: number;
  readonly #maximumTessellationBytes: number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #active = new Map<string, ActiveOperation>();
  readonly #seenRuntimeRequestIds = new Set<string>();
  #runtimeRequestId: string | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #disposed = false;

  constructor(runtime: OcctRuntimePort, attestation: OcctRuntimeAttestation, options: OcctAdapterOptions = {}) {
    this.#runtime = runtime;
    this.identity = deepFreezeClone(attestation.identity);
    this.capabilities = deepFreezeClone(attestation.capabilities);
    this.#operationTimeoutMilliseconds = options.operationTimeoutMilliseconds
      ?? attestation.capabilities.resourceLimits.maximumOperationMilliseconds;
    this.#managementTimeoutMilliseconds = options.managementTimeoutMilliseconds
      ?? Math.min(10_000, attestation.capabilities.resourceLimits.maximumOperationMilliseconds);
    this.#maximumTessellationBytes = options.maximumTessellationBytes
      ?? attestation.capabilities.resourceLimits.maximumExchangeBytes;
    for (const [label, value] of [
      ["operationTimeoutMilliseconds", this.#operationTimeoutMilliseconds],
      ["managementTimeoutMilliseconds", this.#managementTimeoutMilliseconds],
      ["maximumTessellationBytes", this.#maximumTessellationBytes]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
    }
    if (this.#operationTimeoutMilliseconds > attestation.capabilities.resourceLimits.maximumOperationMilliseconds
      || this.#managementTimeoutMilliseconds > attestation.capabilities.resourceLimits.maximumOperationMilliseconds) {
      throw new TypeError("Runtime deadlines cannot exceed the qualified runtime limit.");
    }
    if (this.#maximumTessellationBytes > attestation.capabilities.resourceLimits.maximumExchangeBytes) {
      throw new TypeError("maximumTessellationBytes cannot exceed the qualified binary-transfer limit.");
    }
  }

  async handle(request: ExactKernelRequest, signal?: AbortSignal): Promise<ExactKernelResponse> {
    let ownedRequest: ExactKernelRequest;
    try {
      ownedRequest = structuredClone(request);
    } catch {
      return failureResponse(request, [protocolDiagnostic(
        "INVALID_REQUEST", "The kernel request could not be copied into an owned protocol snapshot.", "Remove cyclic, shared, or unsupported values and rebuild the request."
      )]);
    }
    const requestDiagnostics = validateKernelRequest(ownedRequest);
    if (requestDiagnostics.length > 0) return failureResponse(ownedRequest, requestDiagnostics);
    if (this.#disposed) return failureResponse(ownedRequest, [protocolDiagnostic(
      "KERNEL_FAILURE", "The attested OCCT runtime is quarantined or disposed.", "Create and attest a fresh isolated runtime."
    )]);
    if (signal?.aborted === true) return failureResponse(ownedRequest, [protocolDiagnostic(
      "CANCELLED", "The request was cancelled before runtime dispatch.", "Submit a new request if the operation is still required."
    )]);

    if (ownedRequest.kind === "negotiate") {
      const diagnostics = negotiateKernelCapabilities(this.capabilities, ownedRequest.requirements, this.identity.executionTarget);
      return {
        ...responseEnvelope(ownedRequest), status: "ok", kind: "negotiated",
        identity: deepFreezeClone(this.identity), capabilities: deepFreezeClone(this.capabilities),
        satisfied: diagnostics.length === 0, diagnostics
      };
    }
    if (ownedRequest.kind === "open-session") return this.#openSession(ownedRequest, signal);
    if (ownedRequest.kind === "close-session") return this.#closeSession(ownedRequest, signal);
    if (ownedRequest.kind === "release-shapes") return this.#releaseShapes(ownedRequest, signal);
    if (ownedRequest.kind === "cancel") return this.#cancel(ownedRequest);
    return this.#execute(ownedRequest, signal);
  }

  async dispose(): Promise<void> {
    if (!this.#disposed) this.#quarantine("OCCT adapter disposed");
    await this.#cleanupPromise;
  }

  async #openSession(request: Extract<ExactKernelRequest, { readonly kind: "open-session" }>, signal?: AbortSignal): Promise<ExactKernelResponse> {
    if (request.expectedCapabilityVersion !== this.capabilities.capabilityVersion) return failureResponse(request, [protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", "The requested capability version is not active.", "Renegotiate and reopen the session."
    )]);
    if (this.#sessions.has(request.sessionId)) return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", `Session '${request.sessionId}' is already open.`, "Reuse the active session or choose a new stable session ID."
    )]);
    const dispatchDiagnostic = this.#beginRuntimeRequest(request.requestId);
    if (dispatchDiagnostic !== undefined) return failureResponse(request, [dispatchDiagnostic]);
    try {
      await this.#boundedManagement(signal, (boundedSignal) => this.#runtime.openSession(request.sessionId, boundedSignal));
      this.#sessions.set(request.sessionId, {
        documentId: request.documentId,
        documentRevision: request.documentRevision,
        generation: request.generation,
        status: "open",
        shapes: new Map()
      });
      return { ...responseEnvelope(request), status: "ok", kind: "session-opened", sessionId: request.sessionId };
    } catch (error) {
      this.#quarantine("OCCT session open failed or exceeded its boundary");
      return boundedFailure(request, error, "The OCCT runtime could not open the session.");
    } finally {
      this.#endRuntimeRequest(request.requestId);
    }
  }

  async #closeSession(request: Extract<ExactKernelRequest, { readonly kind: "close-session" }>, signal?: AbortSignal): Promise<ExactKernelResponse> {
    const session = this.#ownedSession(request, request.sessionId);
    if (session instanceof Object && "code" in session) return failureResponse(request, [session]);
    if (session.status !== "open") return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", "The session has an active exact operation.", "Wait for completion or cancel and create a fresh runtime."
    )]);
    const dispatchDiagnostic = this.#beginRuntimeRequest(request.requestId);
    if (dispatchDiagnostic !== undefined) return failureResponse(request, [dispatchDiagnostic]);
    session.status = "busy";
    try {
      await this.#boundedManagement(signal, (boundedSignal) => this.#runtime.closeSession(request.sessionId, boundedSignal));
      this.#sessions.delete(request.sessionId);
      return { ...responseEnvelope(request), status: "ok", kind: "session-closed", sessionId: request.sessionId };
    } catch (error) {
      this.#quarantine("OCCT session close failed or exceeded its boundary");
      return boundedFailure(request, error, "The OCCT runtime could not close the session.");
    } finally {
      if (this.#sessions.get(request.sessionId) === session) session.status = "open";
      this.#endRuntimeRequest(request.requestId);
    }
  }

  async #releaseShapes(request: Extract<ExactKernelRequest, { readonly kind: "release-shapes" }>, signal?: AbortSignal): Promise<ExactKernelResponse> {
    const session = this.#ownedSession(request, request.sessionId);
    if (session instanceof Object && "code" in session) return failureResponse(request, [session]);
    if (session.status !== "open") return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", "Shapes cannot be released during an exact operation.", "Wait for the session to become quiescent."
    )]);
    if (request.shapeIds.some((shapeId) => !session.shapes.has(shapeId))) return failureResponse(request, [protocolDiagnostic(
      "SHAPE_NOT_FOUND", "At least one requested shape is absent from the active session.", "Refresh the document geometry handles."
    )]);
    if (new Set(request.shapeIds).size !== request.shapeIds.length) return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", "A release request cannot contain duplicate shape IDs.", "Send each shape ID exactly once."
    )]);
    const dispatchDiagnostic = this.#beginRuntimeRequest(request.requestId);
    if (dispatchDiagnostic !== undefined) return failureResponse(request, [dispatchDiagnostic]);
    session.status = "busy";
    try {
      const released = await this.#boundedManagement(signal, (boundedSignal) => this.#runtime.releaseShapes(
        request.sessionId, request.shapeIds, boundedSignal
      ));
      const requested = new Set(request.shapeIds);
      if (new Set(released).size !== released.length || released.length !== request.shapeIds.length
        || released.some((shapeId) => !requested.has(shapeId))) {
        this.#quarantine("OCCT release protocol diverged from the requested side effect");
        return failureResponse(request, [protocolDiagnostic(
          "PROTOCOL_MISMATCH", "The OCCT runtime reported a divergent released-shape set.", "Discard the runtime and rebuild from the last valid document."
        )]);
      }
      for (const shapeId of released) session.shapes.delete(shapeId);
      return { ...responseEnvelope(request), status: "ok", kind: "shapes-released", sessionId: request.sessionId, releasedShapeIds: released };
    } catch (error) {
      this.#quarantine("OCCT shape release failed or exceeded its boundary");
      return boundedFailure(request, error, "The OCCT runtime could not release the requested shapes.");
    } finally {
      if (this.#sessions.get(request.sessionId) === session) session.status = "open";
      this.#endRuntimeRequest(request.requestId);
    }
  }

  #cancel(request: Extract<ExactKernelRequest, { readonly kind: "cancel" }>): ExactKernelResponse {
    if (!this.capabilities.supportsCancellation || this.#runtime.cancel === undefined) return failureResponse(request, [protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", "The qualified runtime does not expose cancellation.", "Use a runtime qualified with hard cancellation."
    )]);
    const active = this.#active.get(request.targetRequestId);
    if (active === undefined) return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", `No active operation '${request.targetRequestId}' exists.`, "Refresh active operation state before cancelling."
    )]);
    const session = this.#sessions.get(active.sessionId);
    if (session === undefined || session.documentId !== request.documentId
      || session.documentRevision !== request.documentRevision || session.generation !== request.generation) {
      return failureResponse(request, [protocolDiagnostic(
        "INVALID_REQUEST", "A cancellation request cannot target another document revision or generation.", "Cancel only an operation owned by the active document session."
      )]);
    }
    active.controller.abort();
    try {
      void this.#runtime.cancel(request.targetRequestId).catch(() => undefined);
    } catch {
      // Hard termination below remains the cancellation guarantee.
    } finally {
      // The synchronous hard boundary is authoritative even when a cooperative
      // cancellation implementation throws before returning its promise.
      this.#quarantine(`OCCT operation '${request.targetRequestId}' was cancelled`);
    }
    return { ...responseEnvelope(request), status: "ok", kind: "cancelled", targetRequestId: request.targetRequestId };
  }

  async #execute(request: ExecuteKernelOperationRequest, signal?: AbortSignal): Promise<ExactKernelResponse> {
    const session = this.#ownedSession(request, request.sessionId);
    if (session instanceof Object && "code" in session) return failureResponse(request, [session]);
    if (session.status !== "open") return failureResponse(request, [protocolDiagnostic(
      "INVALID_REQUEST", "This OCCT session already has an active exact operation.", "Serialize operations within each kernel session."
    )]);
    const preflight = this.#executionPreflight(request, session);
    if (preflight !== undefined) return failureResponse(request, [preflight]);
    const dispatchDiagnostic = this.#beginRuntimeRequest(request.requestId);
    if (dispatchDiagnostic !== undefined) return failureResponse(request, [dispatchDiagnostic]);

    session.status = "busy";
    const active: ActiveOperation = {
      sessionId: request.sessionId,
      controller: new AbortController(),
      timedOut: false,
      externallyAborted: false
    };
    const onExternalAbort = (): void => {
      active.externallyAborted = true;
      active.controller.abort();
      this.#quarantine(`OCCT operation '${request.requestId}' was externally cancelled`);
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort();
      this.#quarantine(`OCCT operation '${request.requestId}' exceeded its hard deadline`);
    }, this.#operationTimeoutMilliseconds);
    this.#active.set(request.requestId, active);
    if (signal?.aborted === true) onExternalAbort();
    try {
      if (active.controller.signal.aborted) throw new RuntimeInterruptedError();
      const interrupted = new Promise<never>((_resolve, reject) => {
        active.controller.signal.addEventListener("abort", () => reject(new RuntimeInterruptedError()), { once: true });
      });
      const runtimeRequest = structuredClone(request);
      const runtimeDraft = await Promise.race([this.#runtime.execute(runtimeRequest, active.controller.signal), interrupted]);
      // Never validate or expose buffers and objects still owned by a runtime
      // port. The snapshot also prevents a same-process test double from
      // mutating a result after it has passed validation.
      const draft = structuredClone(runtimeDraft);
      const draftDiagnostics = await validateOperationDraft(request, draft, session, this.capabilities, this.#maximumTessellationBytes);
      if (draftDiagnostics.length > 0) {
        this.#quarantine("OCCT returned an invalid or unbounded operation product");
        return failureResponse(request, draftDiagnostics);
      }
      const products = await finalizeOperationProducts(this.identity, this.capabilities, request, draft);
      const response: KernelExecutionSuccess = {
        ...responseEnvelope(request), status: "ok", kind: "executed", sessionId: request.sessionId, products
      };
      const diagnostics = await validateKernelResponse(request, response, this.identity, this.capabilities);
      if (diagnostics.length > 0) {
        this.#quarantine("OCCT response failed exact-kernel protocol validation");
        return failureResponse(request, diagnostics);
      }
      for (const output of products.geometry.outputs) session.shapes.set(output.shapeId, deepFreezeClone(output));
      session.status = "open";
      return response;
    } catch (error) {
      if (active.timedOut) return failureResponse(request, [protocolDiagnostic(
        "TIMEOUT", `OCCT operation exceeded ${this.#operationTimeoutMilliseconds} ms and its isolated runtime was terminated.`, "Rebuild from the last valid revision in a fresh qualified runtime."
      )]);
      if (active.externallyAborted || active.controller.signal.aborted) return failureResponse(request, [protocolDiagnostic(
        "CANCELLED", "The OCCT operation was cancelled and its isolated runtime was terminated.", "Rebuild from the prior valid geometry in a fresh runtime."
      )]);
      this.#quarantine("OCCT execution threw before returning a validated product");
      return runtimeFailure(request, error, "The OCCT runtime failed while evaluating exact geometry.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
      this.#active.delete(request.requestId);
      if (this.#sessions.get(request.sessionId) === session) session.status = "open";
      this.#endRuntimeRequest(request.requestId);
    }
  }

  #executionPreflight(request: ExecuteKernelOperationRequest, session: SessionState): KernelDiagnostic | undefined {
    if (request.expectedCapabilityVersion !== this.capabilities.capabilityVersion) return protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", "The execution request uses a stale capability version.", "Renegotiate capabilities and retry."
    );
    if (!this.capabilities.supportedOperations.includes(request.operation.kind)) return protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", `Operation '${request.operation.kind}' is not qualified by this runtime.`, "Route to a qualified worker."
    );
    if (request.operation.linearToleranceMeters < this.capabilities.minimumLinearToleranceMeters
      || request.operation.linearToleranceMeters > this.capabilities.maximumLinearToleranceMeters
      || request.operation.angularToleranceRadians < this.capabilities.minimumAngularToleranceRadians) return protocolDiagnostic(
      "CAPABILITY_UNAVAILABLE", "The requested modelling tolerances are outside the qualified range.", "Use qualified tolerances or a different worker."
    );
    if (request.operation.semanticOutputIds.length !== request.operation.expectedOutputCount
      || new Set(request.operation.semanticOutputIds).size !== request.operation.semanticOutputIds.length) return protocolDiagnostic(
      "INVALID_REQUEST", "Semantic output IDs must be unique and match the declared output count.", "Rebuild the deterministic feature operation request."
    );
    if (request.operation.kind === "exchange.import") {
      if (!this.capabilities.importFormats.includes(request.operation.format)) return protocolDiagnostic(
        "UNSUPPORTED_FORMAT", `Import format '${request.operation.format}' is not qualified.`, "Use an advertised neutral format."
      );
      if (!(request.operation.bytes instanceof Uint8Array) || !(request.operation.bytes.buffer instanceof ArrayBuffer)) return protocolDiagnostic(
        "INVALID_REQUEST", "The import payload must be a Uint8Array.", "Decode the bounded file into an owned binary buffer."
      );
      if (request.operation.bytes.byteLength > this.capabilities.resourceLimits.maximumExchangeBytes) return protocolDiagnostic(
        "RESOURCE_LIMIT", "The import exceeds the qualified byte limit.", "Split or reject the exchange job before kernel dispatch."
      );
    }
    if (request.operation.kind === "exchange.export" && !this.capabilities.exportFormats.includes(request.operation.format)) return protocolDiagnostic(
      "UNSUPPORTED_FORMAT", `Export format '${request.operation.format}' is not qualified.`, "Use an advertised export format."
    );
    if (!validBoundedProtocolValue(request.operation, this.capabilities.resourceLimits.maximumExchangeBytes)) return protocolDiagnostic(
      "INVALID_REQUEST", "The operation payload is non-finite, non-plain, or exceeds the bounded protocol envelope.", "Reduce the operation and use only canonical protocol values."
    );
    const inputs = inputShapeHandles(request.operation);
    if (inputs.length > this.capabilities.resourceLimits.maximumInputShapes
      || request.operation.expectedOutputCount > this.capabilities.resourceLimits.maximumOutputShapes) return protocolDiagnostic(
      "RESOURCE_LIMIT", "The operation exceeds qualified input or output shape limits.", "Split the operation into bounded feature steps."
    );
    for (const input of inputs) {
      if (input.sessionId !== request.sessionId) return protocolDiagnostic(
        "STALE_SHAPE_HANDLE", `Shape '${input.shapeId}' belongs to another session.`, "Resolve the input from the active session."
      );
      if (input.revision !== request.documentRevision) return protocolDiagnostic(
        "STALE_SHAPE_HANDLE", `Shape '${input.shapeId}' belongs to another document revision.`, "Rebuild the input in the active revision."
      );
      const current = session.shapes.get(input.shapeId);
      if (current === undefined) return protocolDiagnostic(
        "SHAPE_NOT_FOUND", `Shape '${input.shapeId}' is not present in the active OCCT session.`, "Rebuild or import the shape first."
      );
      if (!sameCanonicalValue(current, input)) return protocolDiagnostic(
        "STALE_SHAPE_HANDLE", `Shape '${input.shapeId}' does not match the complete active exact-shape handle.`, "Resolve the current feature result and retry."
      );
    }
    return undefined;
  }

  #ownedSession(request: ExactKernelRequest, sessionId: string): SessionState | KernelDiagnostic {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return sessionNotFound(sessionId);
    if (session.documentId !== request.documentId || session.documentRevision !== request.documentRevision
      || session.generation !== request.generation) return protocolDiagnostic(
      "STALE_SHAPE_HANDLE", "The kernel session belongs to another document generation or revision.", "Open a new isolated session for this document revision."
    );
    return session;
  }

  #beginRuntimeRequest(requestId: string): KernelDiagnostic | undefined {
    if (this.#seenRuntimeRequestIds.has(requestId)) return protocolDiagnostic(
      "INVALID_REQUEST", `Runtime request '${requestId}' was already used.`, "Use a new stable request ID for every kernel side effect."
    );
    if (this.#runtimeRequestId !== undefined) return protocolDiagnostic(
      "RESOURCE_LIMIT", `The isolated OCCT runtime is busy with '${this.#runtimeRequestId}'.`, "Serialize kernel session operations and retry after it becomes quiescent."
    );
    if (this.#seenRuntimeRequestIds.size >= MAXIMUM_TRACKED_RUNTIME_REQUEST_IDS) return protocolDiagnostic(
      "RESOURCE_LIMIT", "The isolated OCCT runtime reached its bounded request-history limit.", "Create and attest a fresh isolated runtime before submitting more side effects."
    );
    this.#seenRuntimeRequestIds.add(requestId);
    this.#runtimeRequestId = requestId;
    return undefined;
  }

  #endRuntimeRequest(requestId: string): void {
    if (this.#runtimeRequestId === requestId) this.#runtimeRequestId = undefined;
  }

  async #boundedManagement<Value>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Value>
  ): Promise<Value> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onAbort = (): void => { cancelled = true; controller.abort(); };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (externalSignal?.aborted === true) onAbort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#managementTimeoutMilliseconds);
    try {
      if (controller.signal.aborted) throw new BoundedRuntimeError(timedOut ? "timeout" : "cancelled");
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new BoundedRuntimeError(timedOut ? "timeout" : "cancelled")), { once: true });
      });
      return await Promise.race([operation(controller.signal), interrupted]);
    } catch (error) {
      if (error instanceof BoundedRuntimeError) throw error;
      if (timedOut) throw new BoundedRuntimeError("timeout");
      if (cancelled) throw new BoundedRuntimeError("cancelled");
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  #quarantine(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const active of this.#active.values()) active.controller.abort();
    this.#sessions.clear();
    terminateWithoutMasking(this.#runtime, reason);
    this.#cleanupPromise = disposeWithoutMasking(this.#runtime);
  }
}

async function validateOperationDraft(
  request: ExecuteKernelOperationRequest,
  rawDraft: unknown,
  session: SessionState,
  capabilities: ExactKernelCapabilities,
  maximumTessellationBytes: number
): Promise<readonly KernelDiagnostic[]> {
  const diagnostics: KernelDiagnostic[] = [];
  const invalid = (message: string): void => { diagnostics.push(protocolDiagnostic(
    "PROTOCOL_MISMATCH", message, "Terminate the runtime and rebuild from the last valid document."
  )); };
  const limited = (message: string): void => { diagnostics.push(protocolDiagnostic(
    "RESOURCE_LIMIT", message, "Terminate the runtime and reduce the bounded operation payload."
  )); };
  if (!isRecord(rawDraft)) {
    invalid("The runtime operation product is not structurally valid.");
    return diagnostics;
  }
  const candidate = rawDraft as Partial<OperationResultDraft>;
  if (!Array.isArray(candidate.outputs) || !Array.isArray(candidate.validation)
    || !Array.isArray(candidate.diagnostics) || !Array.isArray(candidate.exchangeArtifacts)
    || !Array.isArray(candidate.tessellations) || !Array.isArray(candidate.topologyEntities)
    || !isRecord(candidate.provenance)) {
    invalid("The runtime operation product is not structurally valid.");
    return diagnostics;
  }
  const draft = candidate as OperationResultDraft;

  // Reject oversized collections before walking or hashing attacker-controlled
  // result trees. The binary limits below additionally bound typed-array bytes.
  if (draft.outputs.length > capabilities.resourceLimits.maximumOutputShapes) limited("Runtime output exceeds the qualified shape limit.");
  if (draft.topologyEntities.length > capabilities.resourceLimits.maximumTopologyEntities) limited("Runtime topology provenance exceeds the qualified entity limit.");
  if (draft.validation.length > capabilities.resourceLimits.maximumOutputShapes
    || draft.exchangeArtifacts.length > capabilities.resourceLimits.maximumOutputShapes
    || draft.tessellations.length > capabilities.resourceLimits.maximumInputShapes + capabilities.resourceLimits.maximumOutputShapes
    || draft.diagnostics.length > 1_024) limited("Runtime result collection counts exceed the bounded protocol envelope.");
  if (diagnostics.length > 0) return diagnostics;

  if (draft.operationId !== request.operation.operationId || draft.operationKind !== request.operation.kind) invalid("The runtime changed operation identity.");
  if (draft.outputs.length !== request.operation.expectedOutputCount || draft.validation.length !== draft.outputs.length) invalid("Runtime output and validation counts do not match the request.");
  const shapeIds = new Set<string>();
  const outputDigests: string[] = [];
  let topologyCount = 0;
  for (const rawOutput of draft.outputs as readonly unknown[]) {
    if (!isRecord(rawOutput)) {
      invalid("Runtime returned a non-object exact shape handle.");
      continue;
    }
    const output = rawOutput as unknown as OperationResultDraft["outputs"][number];
    if (output.sessionId !== request.sessionId || output.representation !== "exact-brep"
      || !validStableIdentifier(output.shapeId) || !validDigest(output.contentDigest)
      || output.revision !== request.documentRevision
      || !["wire", "face", "shell", "solid", "compsolid", "compound"].includes(output.kind)
      || !Number.isFinite(output.toleranceMeters) || output.toleranceMeters < capabilities.minimumLinearToleranceMeters
      || output.toleranceMeters > capabilities.maximumLinearToleranceMeters
      || !validBounds(output.boundsMeters) || !validTopologyCounts(output.topology)) {
      invalid("Runtime returned an invalid or cross-session exact shape handle.");
      continue;
    }
    if (shapeIds.has(output.shapeId) || session.shapes.has(output.shapeId)) invalid(`Runtime reused shape ID '${output.shapeId}'.`);
    shapeIds.add(output.shapeId);
    outputDigests.push(output.contentDigest);
    topologyCount = safeAdd(topologyCount, topologyEntityCount(output.topology));
  }
  if (!Number.isSafeInteger(topologyCount) || topologyCount > capabilities.resourceLimits.maximumTopologyEntities) {
    limited("Runtime shape topology summaries exceed the qualified entity limit.");
  }

  for (let index = 0; index < draft.validation.length; index += 1) {
    const rawReport: unknown = draft.validation[index];
    const output = draft.outputs[index];
    if (!isRecord(rawReport)) {
      invalid("Runtime returned a non-object shape-validation report.");
      continue;
    }
    const report = rawReport as unknown as OperationResultDraft["validation"][number];
    if (report.exact !== true || report.valid !== true || report.finite !== true
      || typeof report.closed !== "boolean" || typeof report.manifold !== "boolean" || typeof report.orientable !== "boolean"
      || !Number.isFinite(report.checkedToleranceMeters)
      || report.checkedToleranceMeters < capabilities.minimumLinearToleranceMeters
      || report.checkedToleranceMeters > capabilities.maximumLinearToleranceMeters
      || !Number.isSafeInteger(report.selfIntersections) || report.selfIntersections !== 0
      || !Array.isArray(report.invalidEntityReferenceKeys) || report.invalidEntityReferenceKeys.length !== 0
      || !Array.isArray(report.diagnostics) || !report.diagnostics.every(validKernelDiagnostic)
      || report.diagnostics.some((entry) => entry.severity === "error")
      || ((output?.kind === "solid" || output?.kind === "compsolid")
        && (!report.closed || !report.manifold || !report.orientable))) {
      invalid("Runtime returned a failed exact-shape validation report as success.");
    }
  }

  if (!draft.diagnostics.every(validKernelDiagnostic)
    || draft.diagnostics.some((entry) => entry.severity === "error")) invalid("Runtime returned malformed or error diagnostics in a successful operation product.");

  const inputDigests = inputShapeHandles(request.operation).map((input) => input.contentDigest);
  if (!Array.isArray(draft.provenance.inputShapeDigests) || !Array.isArray(draft.provenance.outputShapeDigests)
    || !Array.isArray(draft.provenance.topologyEntities) || !validDigest(draft.provenance.provenanceDigest)
    || draft.provenance.operationId !== request.operation.operationId
    || draft.provenance.operationKind !== request.operation.kind
    || !sameStrings(draft.provenance.outputShapeDigests, outputDigests)
    || !sameStrings(draft.provenance.inputShapeDigests, inputDigests)
    || !sameCanonicalValue(draft.provenance.topologyEntities, draft.topologyEntities)) {
    invalid("Runtime provenance is inconsistent with operation inputs or outputs.");
  }

  const availableDigests = new Set([...inputDigests, ...outputDigests]);
  let exchangeBytes = 0;
  for (const rawArtifact of draft.exchangeArtifacts as readonly unknown[]) {
    if (!isRecord(rawArtifact)) {
      invalid("Runtime returned a non-object exchange artifact.");
      continue;
    }
    const artifact = rawArtifact as unknown as OperationResultDraft["exchangeArtifacts"][number];
    if (!(artifact.bytes instanceof Uint8Array) || !(artifact.bytes.buffer instanceof ArrayBuffer)) {
      invalid("Runtime returned an exchange artifact without an owned Uint8Array payload.");
      continue;
    }
    exchangeBytes = safeAdd(exchangeBytes, artifact.bytes.byteLength);
    if (!capabilities.exportFormats.includes(artifact.format) || !validDigest(artifact.contentDigest)
      || !validBoundedText(artifact.fileName) || !validBoundedText(artifact.mediaType)
      || !Array.isArray(artifact.sourceShapeDigests)
      || !artifact.sourceShapeDigests.every((digest) => validDigest(digest) && availableDigests.has(digest))
      || (request.operation.kind === "exchange.export" && artifact.format !== request.operation.format)
      || (request.operation.kind !== "exchange.export" && draft.exchangeArtifacts.length > 0)) {
      invalid("Runtime returned a malformed, unadvertised, or unrelated exchange artifact.");
    } else if (!await digestMatchesBytes(artifact.contentDigest, artifact.bytes)) {
      invalid("Runtime exchange artifact bytes do not match their content digest.");
    }
  }
  if (!Number.isSafeInteger(exchangeBytes) || exchangeBytes > capabilities.resourceLimits.maximumExchangeBytes) {
    limited("Runtime exchange artifacts exceed the qualified byte limit.");
  }

  let tessellationBytes = 0;
  for (const rawItem of draft.tessellations as readonly unknown[]) {
    if (!isRecord(rawItem)) {
      invalid("Runtime returned a non-object tessellation product.");
      continue;
    }
    const item = rawItem as unknown as OperationResultDraft["tessellations"][number];
    tessellationBytes = safeAdd(tessellationBytes, safeAdd(byteLength(item.positions), safeAdd(byteLength(item.normals), byteLength(item.indices))));
    const vertexCount = item.positions instanceof Float64Array ? item.positions.length / 3 : -1;
    if (!(item.positions instanceof Float64Array) || !(item.positions.buffer instanceof ArrayBuffer)
      || !(item.normals instanceof Float32Array) || !(item.normals.buffer instanceof ArrayBuffer)
      || !(item.indices instanceof Uint32Array) || !(item.indices.buffer instanceof ArrayBuffer) || item.positions.length % 3 !== 0
      || item.indices.length % 3 !== 0 || (item.normals.length !== 0 && item.normals.length !== item.positions.length)
      || !allFinite(item.positions) || !allFinite(item.normals)
      || !allIndicesInRange(item.indices, vertexCount)
      || !Array.isArray(item.triangleFaceReferenceKeys)
      || (item.triangleFaceReferenceKeys.length !== 0 && item.triangleFaceReferenceKeys.length !== item.indices.length / 3)
      || !item.triangleFaceReferenceKeys.every(validBoundedText)
      || !validDigest(item.contentDigest) || !validDigest(item.sourceShapeDigest)
      || !availableDigests.has(item.sourceShapeDigest)
      || !Number.isFinite(item.linearDeflectionMeters) || item.linearDeflectionMeters <= 0
      || !Number.isFinite(item.angularDeflectionRadians) || item.angularDeflectionRadians <= 0) {
      invalid("Runtime returned a malformed or unrelated tessellation buffer.");
    }
  }
  if (!Number.isSafeInteger(tessellationBytes) || tessellationBytes > maximumTessellationBytes) {
    limited("Runtime tessellation exceeds the adapter byte limit.");
  }

  const entityIds = new Set<string>();
  for (const entity of draft.topologyEntities as readonly unknown[]) {
    if (!validTopologyEntity(entity)) {
      invalid("Runtime returned malformed persistent-topology provenance.");
      continue;
    }
    if (entityIds.has(entity.entityId)) invalid(`Runtime repeated topology entity '${entity.entityId}'.`);
    entityIds.add(entity.entityId);
  }
  return diagnostics;
}

function validBounds(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as { readonly min?: unknown; readonly max?: unknown };
  if (!Array.isArray(bounds.min) || !Array.isArray(bounds.max) || bounds.min.length !== 3 || bounds.max.length !== 3
    || ![...bounds.min, ...bounds.max].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return false;
  return bounds.min.every((entry, index) => (entry as number) <= (bounds.max as number[])[index]!);
}

function validTopologyCounts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const counts = value as Readonly<Record<string, unknown>>;
  for (const key of ["vertices", "edges", "wires", "faces", "shells", "solids", "components"] as const) {
    const count = counts[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return false;
  }
  return typeof counts.closed === "boolean" && typeof counts.manifold === "boolean";
}

function topologyEntityCount(value: OperationResultDraft["outputs"][number]["topology"]): number {
  return safeAdd(value.vertices, safeAdd(value.edges, safeAdd(value.wires,
    safeAdd(value.faces, safeAdd(value.shells, safeAdd(value.solids, value.components))))));
}

function byteLength(value: unknown): number {
  return ArrayBuffer.isView(value) && typeof value.byteLength === "number" ? value.byteLength : Number.POSITIVE_INFINITY;
}

function validTopologyEntity(value: unknown): value is OperationResultDraft["topologyEntities"][number] {
  if (!isRecord(value)) return false;
  const entity = value as {
    readonly entityId?: unknown; readonly kind?: unknown; readonly orientation?: unknown;
    readonly toleranceMeters?: unknown; readonly adjacentReferenceKeys?: unknown;
    readonly stableReference?: unknown;
  };
  return validStableIdentifier(entity.entityId)
    && TOPOLOGY_KINDS.has(String(entity.kind))
    && ["forward", "reversed", "internal", "external"].includes(String(entity.orientation))
    && typeof entity.toleranceMeters === "number" && Number.isFinite(entity.toleranceMeters) && entity.toleranceMeters >= 0
    && Array.isArray(entity.adjacentReferenceKeys) && entity.adjacentReferenceKeys.length <= 4_096
    && entity.adjacentReferenceKeys.every(validBoundedText)
    && isRecord(entity.stableReference) && entity.stableReference.expectedKind === entity.kind
    && validStableTopologyReference(entity.stableReference);
}

function validStableTopologyReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const reference = value as Readonly<Record<string, unknown>>;
  if (reference.referenceVersion !== 1 || !validBoundedText(reference.key) || !validBoundedText(reference.semanticId)
    || !TOPOLOGY_KINDS.has(String(reference.expectedKind))
    || !validDigest(reference.lineageDigest) || !isRecord(reference.producer) || !Array.isArray(reference.ancestry)
    || reference.ancestry.length > 4_096 || !isRecord(reference.signature)) return false;
  const producer = reference.producer;
  if (!validStableIdentifier(producer.operationId) || !KERNEL_OPERATION_KINDS.has(String(producer.operationKind))
    || !Number.isSafeInteger(producer.outputIndex) || (producer.outputIndex as number) < 0 || !validBoundedText(producer.role)) return false;
  if (!reference.ancestry.every((rawAncestry) => {
    if (!isRecord(rawAncestry)) return false;
    return validDigest(rawAncestry.sourceShapeDigest)
      && Array.isArray(rawAncestry.sourceReferenceKeys) && rawAncestry.sourceReferenceKeys.length <= 4_096
      && rawAncestry.sourceReferenceKeys.every(validBoundedText)
      && ["generated-from", "modified-from", "preserved-from", "intersection-of", "unknown"].includes(String(rawAncestry.relation));
  })) return false;
  return validGeometricSignature(reference.signature);
}

function validGeometricSignature(value: unknown): boolean {
  if (!isRecord(value)
    || !["point", "line", "circle", "ellipse", "bspline-curve", "plane", "cylinder", "cone", "sphere", "torus", "bspline-surface", "other"].includes(String(value.geometryClass))
    || !validVector3(value.centroidMeters) || !validBounds(value.boundsMeters)
    || typeof value.measure !== "number" || !Number.isFinite(value.measure) || value.measure < 0
    || !validDigest(value.signatureDigest)) return false;
  if (value.orientationHint !== undefined && !validVector3(value.orientationHint)) return false;
  if (value.analyticParameters === undefined) return true;
  if (!isRecord(value.analyticParameters) || Object.keys(value.analyticParameters).length > 256) return false;
  return Object.entries(value.analyticParameters).every(([key, parameter]) => validBoundedText(key)
    && typeof parameter === "number" && Number.isFinite(parameter));
}

function validVector3(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3
    && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

function validKernelDiagnostic(value: unknown): value is KernelDiagnostic {
  if (!isRecord(value)) return false;
  if (!KERNEL_DIAGNOSTIC_CODES.has(String(value.code)) || !["info", "warning", "error"].includes(String(value.severity))
    || !validBoundedText(value.message) || !validBoundedText(value.recovery)
    || !Array.isArray(value.relatedSemanticIds) || value.relatedSemanticIds.length > 1_024
    || !value.relatedSemanticIds.every(validBoundedText)
    || !Array.isArray(value.relatedReferenceKeys) || value.relatedReferenceKeys.length > 1_024
    || !value.relatedReferenceKeys.every(validBoundedText)) return false;
  if (value.kernelDetails === undefined) return true;
  if (!isRecord(value.kernelDetails) || Object.keys(value.kernelDetails).length > 256) return false;
  return Object.entries(value.kernelDetails).every(([key, detail]) => validBoundedText(key)
    && (typeof detail === "string" ? validBoundedText(detail)
      : typeof detail === "boolean" || (typeof detail === "number" && Number.isFinite(detail))));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
}

function validBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function validBoundedProtocolValue(value: unknown, maximumBinaryBytes: number): boolean {
  const ancestors = new Set<object>();
  const budget = { nodes: 0, text: 0, binary: 0 };
  const visit = (current: unknown, depth: number): boolean => {
    budget.nodes += 1;
    if (budget.nodes > MAXIMUM_PROTOCOL_TREE_NODES || depth > 64) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      budget.text = safeAdd(budget.text, current.length);
      return current.length <= 16_384 && budget.text <= MAXIMUM_PROTOCOL_TEXT_BYTES;
    }
    if (typeof current !== "object") return false;
    if (current instanceof ArrayBuffer) {
      budget.binary = safeAdd(budget.binary, current.byteLength);
      return budget.binary <= maximumBinaryBytes;
    }
    if (ArrayBuffer.isView(current)) {
      if (!(current.buffer instanceof ArrayBuffer)) return false;
      budget.binary = safeAdd(budget.binary, current.byteLength);
      return budget.binary <= maximumBinaryBytes;
    }
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAXIMUM_PROTOCOL_TREE_NODES) return false;
        return current.every((item) => visit(item, depth + 1));
      }
      if (!isRecord(current)) return false;
      const entries = Object.entries(current);
      if (entries.length > 16_384) return false;
      return entries.every(([key, item]) => {
        budget.text = safeAdd(budget.text, key.length);
        return key.length > 0 && key.length <= 512 && budget.text <= MAXIMUM_PROTOCOL_TEXT_BYTES
          && visit(item, depth + 1);
      });
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function safeAdd(first: number, second: number): number {
  const result = first + second;
  return Number.isSafeInteger(result) && result >= 0 ? result : Number.POSITIVE_INFINITY;
}

function allFinite(values: Float64Array | Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function allIndicesInRange(indices: Uint32Array, vertexCount: number): boolean {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) return false;
  for (const index of indices) if (index >= vertexCount) return false;
  return true;
}

function sameCanonicalValue(first: unknown, second: unknown): boolean {
  try {
    return canonicalKernelJson(first) === canonicalKernelJson(second);
  } catch {
    return false;
  }
}

async function digestMatchesBytes(digest: string, bytes: Uint8Array): Promise<boolean> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const observed = bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", ownedBytes.buffer)));
  return digest === observed || digest === `sha256:${observed}`;
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sessionNotFound(sessionId: string): KernelDiagnostic {
  return protocolDiagnostic("SESSION_NOT_FOUND", `Kernel session '${sessionId}' is not open.`, "Open a qualified session first.");
}

function boundedFailure(request: ExactKernelRequest, error: unknown, message: string): ExactKernelResponse {
  if (error instanceof BoundedRuntimeError) return failureResponse(request, [protocolDiagnostic(
    error.kind === "timeout" ? "TIMEOUT" : "CANCELLED",
    `${message} The isolated runtime was terminated.`,
    "Create a new qualified runtime and rebuild from the last valid revision."
  )]);
  return runtimeFailure(request, error, message);
}

function runtimeFailure(request: ExactKernelRequest, error: unknown, message: string): ExactKernelResponse {
  return failureResponse(request, [{
    ...protocolDiagnostic("KERNEL_FAILURE", message, "Preserve the prior valid revision and inspect isolated runtime logs."),
    kernelDetails: { cause: error instanceof Error ? error.message : String(error) }
  }]);
}

function terminateWithoutMasking(runtime: OcctRuntimePort, reason: string): void {
  try { runtime.terminate(reason); } catch { /* the primary boundary failure remains authoritative */ }
}

async function disposeWithoutMasking(runtime: OcctRuntimePort): Promise<void> {
  try { await runtime.dispose?.(); } catch { /* cleanup must not mask the primary result */ }
}

function deepFreezeClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

class RuntimeInterruptedError extends Error {}

class BoundedRuntimeError extends Error {
  constructor(readonly kind: "timeout" | "cancelled") {
    super(kind);
    this.name = "BoundedRuntimeError";
  }
}
