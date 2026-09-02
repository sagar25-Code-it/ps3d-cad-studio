import type { ExactKernelRequest, ExactKernelResponse } from "../../exact-kernel-api/src/index.js";

export const EXACT_KERNEL_WORKER_CHANNEL = "ps3d.exact-kernel.worker" as const;
export const EXACT_KERNEL_WORKER_VERSION = 1 as const;

export interface KernelWorkerRequestFrame {
  readonly channel: typeof EXACT_KERNEL_WORKER_CHANNEL;
  readonly version: typeof EXACT_KERNEL_WORKER_VERSION;
  readonly messageId: string;
  readonly kind: "request";
  readonly request: ExactKernelRequest;
}

export interface KernelWorkerResponseFrame {
  readonly channel: typeof EXACT_KERNEL_WORKER_CHANNEL;
  readonly version: typeof EXACT_KERNEL_WORKER_VERSION;
  readonly messageId: string;
  readonly kind: "response";
  readonly response: ExactKernelResponse;
}

export type KernelWorkerFrame = KernelWorkerRequestFrame | KernelWorkerResponseFrame;

export function isKernelWorkerRequestFrame(value: unknown): value is KernelWorkerRequestFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<KernelWorkerRequestFrame>;
  return frame.channel === EXACT_KERNEL_WORKER_CHANNEL
    && frame.version === EXACT_KERNEL_WORKER_VERSION
    && frame.kind === "request"
    && typeof frame.messageId === "string"
    && typeof frame.request === "object"
    && frame.request !== null;
}

export function isKernelWorkerResponseFrame(value: unknown): value is KernelWorkerResponseFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<KernelWorkerResponseFrame>;
  return frame.channel === EXACT_KERNEL_WORKER_CHANNEL
    && frame.version === EXACT_KERNEL_WORKER_VERSION
    && frame.kind === "response"
    && typeof frame.messageId === "string"
    && typeof frame.response === "object"
    && frame.response !== null;
}
