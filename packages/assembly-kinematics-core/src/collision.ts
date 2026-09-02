import { validateRigidTransform } from "./validation.js";
import type {
  AssemblyDiagnostic,
  AssemblyResult,
  ClearanceAnalysisRequest,
  ClearanceFinding,
  CollisionAnalysisAdapter,
  InterferenceAnalysisRequest,
  InterferenceFinding
} from "./types.js";

function adapterRequired(requestId: string): AssemblyResult<never> {
  return {
    ok: false,
    diagnostics: [{
      code: "COLLISION_ADAPTER_REQUIRED",
      severity: "error",
      message: "Interference and clearance require a qualified exact-geometry collision adapter.",
      relatedIds: [requestId],
      recovery: "Route this request to an exact B-rep or independently qualified collision worker."
    }]
  };
}

function validateRequest(request: InterferenceAnalysisRequest): readonly AssemblyDiagnostic[] {
  const diagnostics: AssemblyDiagnostic[] = [];
  const geometry = new Map(request.geometry.map((item) => [item.occurrenceId, item]));
  if (geometry.size !== request.geometry.length) {
    diagnostics.push({ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: "Collision geometry contains duplicate occurrence IDs.", relatedIds: [request.requestId], recovery: "Supply exactly one qualified geometry handle per occurrence." });
  }
  if (!Number.isFinite(request.toleranceMeters) || request.toleranceMeters < 0) {
    diagnostics.push({ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: "Collision tolerance must be finite and non-negative.", relatedIds: [request.requestId], recovery: "Provide a valid model-space tolerance." });
  }
  for (const item of request.geometry) {
    diagnostics.push(...validateRigidTransform(item.transform, item.occurrenceId));
    if (item.geometryHandle.length === 0 || !Number.isSafeInteger(item.geometryRevision) || item.geometryRevision < 0) {
      diagnostics.push({ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: `Geometry reference for '${item.occurrenceId}' is empty or has an invalid revision.`, relatedIds: [item.occurrenceId], recovery: "Rebuild the occurrence and supply its current qualified geometry handle and revision." });
    }
  }
  const pairs = new Set<string>();
  for (const pair of request.pairs) {
    const key = pairKey(pair.firstOccurrenceId, pair.secondOccurrenceId);
    if (pairs.has(key)) {
      diagnostics.push({ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: "Collision request contains a duplicate occurrence pair.", relatedIds: [pair.firstOccurrenceId, pair.secondOccurrenceId], recovery: "Request each unordered occurrence pair once." });
    }
    pairs.add(key);
    if (pair.firstOccurrenceId === pair.secondOccurrenceId
      || !geometry.has(pair.firstOccurrenceId)
      || !geometry.has(pair.secondOccurrenceId)) {
      diagnostics.push({ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: "Collision pair is self-referential or lacks qualified geometry.", relatedIds: [pair.firstOccurrenceId, pair.secondOccurrenceId], recovery: "Supply two distinct occurrences with current qualified geometry handles." });
    }
  }
  return diagnostics;
}

function validateInterferenceFindings(findings: readonly InterferenceFinding[], request: InterferenceAnalysisRequest): boolean {
  const requestedPairs = new Set(request.pairs.map((pair) => pairKey(pair.firstOccurrenceId, pair.secondOccurrenceId)));
  return findings.every((finding) => Number.isFinite(finding.volumeCubicMeters)
    && finding.volumeCubicMeters >= 0
    && requestedPairs.has(pairKey(finding.pair.firstOccurrenceId, finding.pair.secondOccurrenceId))
    && finding.evidenceHandle.length > 0);
}

function validateClearanceFindings(findings: readonly ClearanceFinding[], request: ClearanceAnalysisRequest): boolean {
  const requestedPairs = new Set(request.pairs.map((pair) => pairKey(pair.firstOccurrenceId, pair.secondOccurrenceId)));
  return findings.every((finding) => Number.isFinite(finding.minimumDistanceMeters)
    && finding.minimumDistanceMeters >= 0
    && requestedPairs.has(pairKey(finding.pair.firstOccurrenceId, finding.pair.secondOccurrenceId))
    && finding.firstClosestPointMeters.length === 3
    && finding.secondClosestPointMeters.length === 3
    && finding.firstClosestPointMeters.every(Number.isFinite)
    && finding.secondClosestPointMeters.every(Number.isFinite)
    && finding.evidenceHandle.length > 0);
}

export async function analyzeInterference(
  request: InterferenceAnalysisRequest,
  adapter?: CollisionAnalysisAdapter
): Promise<AssemblyResult<readonly InterferenceFinding[]>> {
  const diagnostics = validateRequest(request);
  if (diagnostics.some(({ severity }) => severity === "error")) return { ok: false, diagnostics };
  if (adapter === undefined) return adapterRequired(request.requestId);
  const result = await adapter.analyzeInterference(request);
  if (!result.ok || validateInterferenceFindings(result.value, request)) return result;
  return { ok: false, diagnostics: [{ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: `Collision adapter '${adapter.adapterId}' returned an invalid interference result.`, relatedIds: [request.requestId], recovery: "Reject the result and inspect the adapter evidence pipeline." }] };
}

export async function analyzeClearance(
  request: ClearanceAnalysisRequest,
  adapter?: CollisionAnalysisAdapter
): Promise<AssemblyResult<readonly ClearanceFinding[]>> {
  const diagnostics = validateRequest(request);
  if (!Number.isFinite(request.requiredClearanceMeters) || request.requiredClearanceMeters < 0) {
    return { ok: false, diagnostics: [...diagnostics, { code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: "Required clearance must be finite and non-negative.", relatedIds: [request.requestId], recovery: "Provide a valid required clearance." }] };
  }
  if (diagnostics.some(({ severity }) => severity === "error")) return { ok: false, diagnostics };
  if (adapter === undefined) return adapterRequired(request.requestId);
  const result = await adapter.analyzeClearance(request);
  if (!result.ok || validateClearanceFindings(result.value, request)) return result;
  return { ok: false, diagnostics: [{ code: "STALE_GEOMETRY_REFERENCE", severity: "error", message: `Collision adapter '${adapter.adapterId}' returned an invalid clearance result.`, relatedIds: [request.requestId], recovery: "Reject the result and inspect the adapter evidence pipeline." }] };
}

function pairKey(firstOccurrenceId: string, secondOccurrenceId: string): string {
  return firstOccurrenceId < secondOccurrenceId
    ? `${firstOccurrenceId}\u0000${secondOccurrenceId}`
    : `${secondOccurrenceId}\u0000${firstOccurrenceId}`;
}
