import type {
  ExactKernelAdapter,
  KernelCapabilityRequirements,
  KernelDiagnostic,
  KernelNegotiationSuccess,
  NegotiateKernelRequest
} from "../../exact-kernel-api/src/index.js";
import { validateKernelResponse } from "../../exact-kernel-api/src/index.js";

export interface QualifiedKernelSelection {
  readonly adapter: ExactKernelAdapter;
  readonly negotiation: KernelNegotiationSuccess;
  readonly reason: "preferred-wasm" | "required-native" | "wasm-insufficient" | "preferred-native";
}

export interface RejectedKernelSelection {
  readonly adapter: ExactKernelAdapter;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface KernelSelectionFailure {
  readonly ok: false;
  readonly rejected: readonly RejectedKernelSelection[];
}

export interface KernelSelectionSuccess {
  readonly ok: true;
  readonly selection: QualifiedKernelSelection;
}

export type KernelSelectionResult = KernelSelectionSuccess | KernelSelectionFailure;

export async function chooseKernelAdapter(
  request: NegotiateKernelRequest,
  adapters: readonly ExactKernelAdapter[]
): Promise<KernelSelectionResult> {
  const rejected: RejectedKernelSelection[] = [];
  const qualified: Array<{ adapter: ExactKernelAdapter; response: KernelNegotiationSuccess }> = [];

  for (const adapter of adapters) {
    const response = await adapter.handle(request);
    const protocolDiagnostics = await validateKernelResponse(request, response, adapter.identity, adapter.capabilities);
    if (protocolDiagnostics.length > 0) {
      rejected.push({ adapter, diagnostics: protocolDiagnostics });
    } else if (response.status === "ok" && response.kind === "negotiated" && response.satisfied) {
      qualified.push({ adapter, response });
    } else {
      rejected.push({
        adapter,
        diagnostics: response.status === "error" ? response.diagnostics : response.kind === "negotiated" ? response.diagnostics : []
      });
    }
  }
  if (qualified.length === 0) return { ok: false, rejected };

  const preference = normalizedPreference(request.requirements);
  const selected = preference
    .map((target) => qualified.find((candidate) => candidate.adapter.identity.executionTarget === target))
    .find((candidate) => candidate !== undefined)
    ?? qualified[0]!;
  const target = selected.adapter.identity.executionTarget;
  const wasmQualified = qualified.some((candidate) => candidate.adapter.identity.executionTarget === "wasm-worker");
  const reason: QualifiedKernelSelection["reason"] = target === "wasm-worker"
    ? "preferred-wasm"
    : preference[0] === "native-worker"
      ? "preferred-native"
      : wasmQualified
        ? "required-native"
        : "wasm-insufficient";
  return { ok: true, selection: { adapter: selected.adapter, negotiation: selected.response, reason } };
}

function normalizedPreference(requirements: KernelCapabilityRequirements): readonly ("wasm-worker" | "native-worker" | "recorded-reference")[] {
  return requirements.preferredTargets.length > 0
    ? requirements.preferredTargets
    : ["wasm-worker", "native-worker", "recorded-reference"];
}
