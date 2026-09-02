import {
  failureResponse,
  protocolDiagnostic,
  validateKernelResponse,
  type ExactKernelAdapter,
  type ExactKernelCapabilities,
  type ExactKernelRequest,
  type ExactKernelResponse,
  type KernelIdentity
} from "../../exact-kernel-api/src/index.js";
import {
  EXACT_KERNEL_WORKER_CHANNEL,
  EXACT_KERNEL_WORKER_VERSION,
  isKernelWorkerResponseFrame,
  type KernelWorkerRequestFrame
} from "./frames.js";

export interface StructuredCloneWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

interface PendingRequest {
  readonly request: ExactKernelRequest;
  readonly resolve: (response: ExactKernelResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly abortSignal?: AbortSignal;
  readonly abortListener?: () => void;
}

export interface WorkerAdapterOptions {
  readonly timeoutMilliseconds?: number;
  readonly messageIdPrefix?: string;
}

let workerAdapterInstanceSequence = 0;

export class WorkerExactKernelAdapter implements ExactKernelAdapter {
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  readonly #port: StructuredCloneWorkerPort;
  readonly #timeoutMilliseconds: number;
  readonly #messageIdPrefix: string;
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = 0;
  #closed = false;

  constructor(
    port: StructuredCloneWorkerPort,
    identity: KernelIdentity,
    capabilities: ExactKernelCapabilities,
    options: WorkerAdapterOptions = {}
  ) {
    if (identity.executionTarget !== "wasm-worker" && identity.executionTarget !== "native-worker") {
      throw new TypeError("A worker adapter must identify a WASM or native worker target.");
    }
    this.#port = port;
    this.identity = structuredClone(identity);
    this.capabilities = structuredClone(capabilities);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.#messageIdPrefix = options.messageIdPrefix ?? `kernel-worker-${++workerAdapterInstanceSequence}`;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds < 1) {
      throw new TypeError("timeoutMilliseconds must be a positive safe integer.");
    }
    this.#port.addEventListener("message", this.#onMessage);
  }

  handle(request: ExactKernelRequest, signal?: AbortSignal): Promise<ExactKernelResponse> {
    if (this.#closed) return Promise.resolve(failureResponse(request, [protocolDiagnostic(
      "KERNEL_FAILURE", "The exact-kernel worker bridge is closed.", "Create a new worker bridge and renegotiate capabilities."
    )]));
    if (signal?.aborted === true) return Promise.resolve(failureResponse(request, [protocolDiagnostic(
      "CANCELLED", "The exact-kernel request was cancelled before dispatch.", "Submit a new request if the operation is still required."
    )]));

    const messageId = `${this.#messageIdPrefix}:${++this.#sequence}`;
    const frame: KernelWorkerRequestFrame = {
      channel: EXACT_KERNEL_WORKER_CHANNEL,
      version: EXACT_KERNEL_WORKER_VERSION,
      messageId,
      kind: "request",
      request
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.#takePending(messageId);
        pending?.resolve(failureResponse(request, [protocolDiagnostic(
          "TIMEOUT",
          `Exact-kernel worker request '${request.requestId}' exceeded ${this.#timeoutMilliseconds} ms.`,
          "Keep the last valid revision and retry on a qualified native worker if the user requests it."
        )]));
      }, this.#timeoutMilliseconds);
      const pending: PendingRequest = { request, resolve, timeout, ...(signal === undefined ? {} : { abortSignal: signal }) };
      if (signal !== undefined) {
        const abortListener = (): void => {
          const aborted = this.#takePending(messageId);
          aborted?.resolve(failureResponse(request, [protocolDiagnostic(
            "CANCELLED", "The exact-kernel request was cancelled while running.", "The prior valid geometry remains authoritative."
          )]));
        };
        Object.assign(pending, { abortListener });
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#pending.set(messageId, pending);
      try {
        this.#port.postMessage(frame);
      } catch (error) {
        const failed = this.#takePending(messageId);
        failed?.resolve(failureResponse(request, [protocolDiagnostic(
          "KERNEL_FAILURE",
          error instanceof Error ? `The worker bridge rejected dispatch: ${error.message}` : "The worker bridge rejected dispatch.",
          "Create a healthy worker bridge and retry after renegotiating capabilities."
        )]));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener("message", this.#onMessage);
    for (const [messageId, pending] of this.#pending) {
      this.#takePending(messageId);
      pending.resolve(failureResponse(pending.request, [protocolDiagnostic(
        "KERNEL_FAILURE", "The exact-kernel worker bridge closed before returning a result.", "Keep the prior valid revision."
      )]));
    }
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isKernelWorkerResponseFrame(event.data)) return;
    const pending = this.#takePending(event.data.messageId);
    if (pending === undefined) return;
    void this.#acceptResponse(pending, event.data.response);
  };

  async #acceptResponse(pending: PendingRequest, response: ExactKernelResponse): Promise<void> {
    const diagnostics = await validateKernelResponse(pending.request, response, this.identity, this.capabilities);
    if (diagnostics.length > 0) {
      pending.resolve(failureResponse(pending.request, diagnostics));
      return;
    }
    pending.resolve(response);
  }

  #takePending(messageId: string): PendingRequest | undefined {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) return undefined;
    this.#pending.delete(messageId);
    clearTimeout(pending.timeout);
    if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }
}
