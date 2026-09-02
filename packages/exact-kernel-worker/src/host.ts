import {
  failureResponse,
  protocolDiagnostic,
  type ExactKernelAdapter,
  type ExactKernelResponse
} from "../../exact-kernel-api/src/index.js";
import {
  EXACT_KERNEL_WORKER_CHANNEL,
  EXACT_KERNEL_WORKER_VERSION,
  isKernelWorkerRequestFrame,
  type KernelWorkerResponseFrame
} from "./frames.js";

export type KernelWorkerPostMessage = (message: KernelWorkerResponseFrame) => void;

export function createExactKernelWorkerHandler(
  adapter: ExactKernelAdapter,
  postMessage: KernelWorkerPostMessage
): (event: MessageEvent<unknown>) => void {
  return (event): void => {
    if (!isKernelWorkerRequestFrame(event.data)) return;
    const { messageId, request } = event.data;
    void Promise.resolve()
      .then(() => adapter.handle(request))
      .catch((error: unknown): ExactKernelResponse => failureResponse(request, [protocolDiagnostic(
        "KERNEL_FAILURE",
        error instanceof Error ? error.message : "The exact-kernel worker threw a non-Error value.",
        "Keep the prior valid revision and inspect the worker diagnostics."
      )]))
      .then((response) => postMessage({
        channel: EXACT_KERNEL_WORKER_CHANNEL,
        version: EXACT_KERNEL_WORKER_VERSION,
        messageId,
        kind: "response",
        response
      }));
  };
}
