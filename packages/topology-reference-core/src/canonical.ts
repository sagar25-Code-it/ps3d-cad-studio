import { kernelSha256 } from "../../exact-kernel-api/src/index.js";
import type {
  PersistentTopologyEntity,
  TopologyResolutionDiagnostic,
  TopologyResolutionOutcome,
  TopologyResolutionPolicy,
  TopologyResolutionRequest,
  TopologyResolutionReceipt,
  TopologyCandidateEvaluation
} from "./types.js";
import { TOPOLOGY_REFERENCE_RESOLVER_VERSION } from "./types.js";

export async function topologyResolutionRequestDigest(
  request: TopologyResolutionRequest,
  policy: Readonly<TopologyResolutionPolicy>
): Promise<string> {
  const value = {
    requestId: request.requestId,
    sourceSnapshot: canonicalSnapshot(request.sourceSnapshot),
    sourceReferenceKey: request.sourceReferenceKey,
    targetSnapshot: canonicalSnapshot(request.targetSnapshot),
    policy
  };
  try {
    return await kernelSha256(value);
  } catch {
    // Invalid requests still need auditable receipts. The marker form is only
    // used for hashing rejected input and is never passed to a geometry kernel.
    return kernelSha256({ invalidRequest: sanitizeForDigest(value, new Set<object>()) });
  }
}

export async function createTopologyResolutionReceipt(input: {
  readonly request: TopologyResolutionRequest;
  readonly policy: Readonly<TopologyResolutionPolicy>;
  readonly outcome: TopologyResolutionOutcome;
  readonly selectedReferenceKey: string | null;
  readonly candidates: readonly TopologyCandidateEvaluation[];
  readonly diagnostics: readonly TopologyResolutionDiagnostic[];
}): Promise<TopologyResolutionReceipt> {
  const requestDigest = await topologyResolutionRequestDigest(input.request, input.policy);
  const eligibleReferenceKeys = input.candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.referenceKey)
    .sort(compareStrings);
  const resultDigest = await kernelSha256({
    outcome: input.outcome,
    selectedReferenceKey: input.selectedReferenceKey,
    candidates: [...input.candidates].sort((a, b) => compareStrings(a.referenceKey, b.referenceKey)),
    diagnostics: [...input.diagnostics].sort(compareDiagnostics)
  });
  return Object.freeze({
    resolverVersion: TOPOLOGY_REFERENCE_RESOLVER_VERSION,
    requestId: input.request.requestId,
    requestDigest,
    resultDigest,
    sourceDocumentRevision: input.request.sourceSnapshot.documentRevision,
    targetDocumentRevision: input.request.targetSnapshot.documentRevision,
    sourceReferenceKey: input.request.sourceReferenceKey,
    outcome: input.outcome,
    selectedReferenceKey: input.selectedReferenceKey,
    eligibleReferenceKeys: Object.freeze(eligibleReferenceKeys),
    deterministic: true
  });
}

function canonicalSnapshot(snapshot: TopologyResolutionRequest["sourceSnapshot"]): unknown {
  return {
    ...snapshot,
    entities: [...snapshot.entities]
      .map(canonicalEntity)
      .sort((a, b) => compareStrings(a.trackedReference.kernelReference.key, b.trackedReference.kernelReference.key))
  };
}

function canonicalEntity(entity: PersistentTopologyEntity): PersistentTopologyEntity {
  const kernelReference = entity.trackedReference.kernelReference;
  return {
    ...entity,
    trackedReference: {
      ...entity.trackedReference,
      kernelReference: {
        ...kernelReference,
        ancestry: kernelReference.ancestry
          .map((ancestry) => ({
            ...ancestry,
            sourceReferenceKeys: [...ancestry.sourceReferenceKeys].sort(compareStrings)
          }))
          .sort((first, second) => compareStrings(
            `${first.relation}\u0000${first.sourceShapeDigest}\u0000${first.sourceReferenceKeys.join("\u0000")}`,
            `${second.relation}\u0000${second.sourceShapeDigest}\u0000${second.sourceReferenceKeys.join("\u0000")}`
          ))
      }
    },
    neighbors: [...entity.neighbors].sort((a, b) => compareStrings(neighborKey(a), neighborKey(b)))
  };
}

function neighborKey(neighbor: PersistentTopologyEntity["neighbors"][number]): string {
  return `${neighbor.kind}\u0000${neighbor.semanticId}\u0000${neighbor.producerRole}\u0000${neighbor.geometryClass}\u0000${neighbor.measure}`;
}

function compareDiagnostics(first: TopologyResolutionDiagnostic, second: TopologyResolutionDiagnostic): number {
  return compareStrings(
    `${first.code}\u0000${first.message}\u0000${first.candidateReferenceKeys.join("\u0000")}`,
    `${second.code}\u0000${second.message}\u0000${second.candidateReferenceKeys.join("\u0000")}`
  );
}

export function compareStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function freezeArray<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze([...values]);
}

function sanitizeForDigest(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $invalidNumber: String(value) };
  if (typeof value === "undefined") return { $invalid: "undefined" };
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return { $invalid: typeof value, value: String(value) };
  }
  if (typeof value !== "object") return { $invalid: "unknown" };
  if (ancestors.has(value)) return { $invalid: "cycle" };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { $invalid: "binary" };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeForDigest(item, ancestors));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = sanitizeForDigest((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
