import type { DocumentCommand } from "../../../packages/commands/src/index.js";
import type { RevisionEvidence } from "../../../packages/evidence/src/index.js";
import type { CadDocument, DisplayUnit } from "../../../packages/model-schema/src/index.js";
import {
  requestCorrelation,
  validateExpectedWorkerResponse,
  type WorkerRequest,
  type WorkerResponse
} from "../../../packages/worker-protocol/src/index.js";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "protocolVersion" | "requestId" | "generation"> : never;
type WorkerRequestPayload = WithoutEnvelope<WorkerRequest>;

export class GeometryWorkerClient {
  readonly #onFailure: (message: string) => void;
  #worker: Worker;
  #generation = 1;
  #sequence = 0;
  #disposed = false;
  #responseQueue: Promise<void> = Promise.resolve();
  readonly #pending = new Map<string, {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
    timer: number;
    request: WorkerRequest;
  }>();

  constructor(onFailure: (message: string) => void) {
    this.#onFailure = onFailure;
    this.#worker = this.#createWorker();
  }

  bootstrap(fallbackDocument: CadDocument, recoverLocal: boolean, fallbackEvidence: RevisionEvidence | null = null): Promise<WorkerResponse> {
    return this.#send({ kind: "bootstrap", fallbackDocument, fallbackEvidence, recoverLocal });
  }

  commit(baseRevision: number, command: DocumentCommand): Promise<WorkerResponse> {
    return this.#send({ kind: "commit", baseRevision, command });
  }

  history(baseRevision: number, direction: "undo" | "redo", commandId: string): Promise<WorkerResponse> {
    return this.#send({ kind: "history", baseRevision, direction, commandId });
  }

  exportStl(baseRevision: number, unit: DisplayUnit): Promise<WorkerResponse> {
    return this.#send({ kind: "export-stl", baseRevision, unit });
  }

  persist(baseRevision: number): Promise<WorkerResponse> {
    return this.#send({ kind: "persist", baseRevision });
  }

  restart(): void {
    this.#rejectPending("Geometry worker restarted before the operation completed.");
    this.#worker.terminate();
    this.#generation += 1;
    this.#worker = this.#createWorker();
  }

  dispose(): void {
    this.#disposed = true;
    this.#rejectPending("Geometry worker disposed.");
    this.#worker.terminate();
  }

  #send(payload: WorkerRequestPayload): Promise<WorkerResponse> {
    const requestId = `request:${this.#generation}-${++this.#sequence}`;
    const request = { protocolVersion: 1, requestId, generation: this.#generation, ...payload } as WorkerRequest;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#failWorker("Geometry operation exceeded the 15 second Phase 0 limit.");
      }, 15_000);
      this.#pending.set(requestId, { resolve, reject, timer, request });
      try {
        this.#worker.postMessage(request);
      } catch {
        this.#failWorker("The geometry request could not be sent; the last durable revision remains authoritative.");
      }
    });
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("../../../packages/model-worker/src/worker.ts", import.meta.url), { type: "module", name: "ps3d-model-worker" });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      this.#responseQueue = this.#responseQueue.then(() => this.#handleWorkerMessage(worker, event.data)).catch(() => {
        if (worker === this.#worker) this.#failWorker("The geometry worker response could not be verified.");
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (worker !== this.#worker) return;
      this.#failWorker("The geometry worker failed; the last durable document remains authoritative.");
    };
    worker.onmessageerror = () => {
      if (worker !== this.#worker) return;
      this.#failWorker("The geometry worker returned an unreadable message.");
    };
    return worker;
  }

  async #handleWorkerMessage(worker: Worker, value: unknown): Promise<void> {
    if (worker !== this.#worker) return;
    const correlation = requestCorrelation(value);
    if (correlation === null) {
      this.#failWorker("The geometry worker returned an uncorrelated protocol response.");
      return;
    }
    if (correlation.generation !== this.#generation) return;
    const pending = this.#pending.get(correlation.requestId);
    if (pending === undefined) return;
    const response = await validateExpectedWorkerResponse(value, pending.request);
    if (worker !== this.#worker || correlation.generation !== this.#generation) return;
    if (this.#pending.get(correlation.requestId) !== pending) return;
    if (response === null) {
      this.#failWorker("The geometry worker returned a malformed, corrupted, or mismatched protocol response.");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
  }

  #failWorker(message: string): void {
    if (this.#disposed) return;
    this.#rejectPending(message);
    this.#worker.terminate();
    this.#generation += 1;
    this.#worker = this.#createWorker();
    this.#onFailure(message);
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }
}
