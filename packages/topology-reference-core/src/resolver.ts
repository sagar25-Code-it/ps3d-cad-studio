import { compareStrings, createTopologyResolutionReceipt, freezeArray } from "./canonical.js";
import {
  compareGeometry,
  lineageRank,
  neighborhoodMismatch,
  normalizedGeometryScore
} from "./metrics.js";
import { signatureOf } from "./snapshot.js";
import {
  DEFAULT_TOPOLOGY_RESOLUTION_POLICY,
  type CandidateRejectionReason,
  type PersistentTopologyEntity,
  type TopologyCandidateEvaluation,
  type TopologyResolutionDiagnostic,
  type TopologyResolutionOutcome,
  type TopologyResolutionPolicy,
  type TopologyResolutionRequest,
  type TopologyResolutionResult,
  type TopologyRevisionSnapshot
} from "./types.js";

const STABLE_PROTOCOL_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;

export async function resolvePersistentTopologyReference(
  request: TopologyResolutionRequest
): Promise<TopologyResolutionResult> {
  const policy = mergePolicy(request.policy);
  const validationDiagnostics = validateRequest(request, policy);
  const source = findSource(request.sourceSnapshot, request.sourceReferenceKey);
  if (validationDiagnostics.length > 0 || source === null) {
    const diagnostics = source === null && !validationDiagnostics.some((item) => item.code === "SOURCE_REFERENCE_MISSING")
      ? [...validationDiagnostics, diagnostic(
        "SOURCE_REFERENCE_MISSING",
        "error",
        `Source topology reference '${request.sourceReferenceKey}' is absent from the source snapshot.`,
        [],
        "Reload the source revision or discard the stale canonical reference."
      )]
      : validationDiagnostics;
    return buildResult(request, policy, "invalid", source, null, [], [], diagnostics);
  }

  const evaluations = request.targetSnapshot.entities
    .map((candidate) => evaluateCandidate(source, candidate, policy))
    .sort((first, second) => compareStrings(first.referenceKey, second.referenceKey));
  const exactCandidates = evaluations.filter((candidate) => candidate.exactKey);
  if (exactCandidates.length === 1) {
    const exact = exactCandidates[0];
    if (exact?.eligible !== true) {
      return buildResult(request, policy, "invalid", source, null, evaluations, [], [diagnostic(
        "INVALID_SNAPSHOT",
        "error",
        "The target reused the stable reference key for topology that failed its lineage or geometry integrity checks.",
        [exact?.referenceKey ?? request.sourceReferenceKey],
        "Reject the kernel result and inspect persistent-name generation for a key collision."
      )]);
    }
    const selected = entityByReferenceKey(request.targetSnapshot, exact.referenceKey);
    if (selected === null) return impossibleMissingCandidate(request, policy, source, evaluations);
    return buildResult(request, policy, "exact", source, selected, evaluations, [], [diagnostic(
      "EXACT_REFERENCE_RESOLVED",
      "info",
      "The exact stable topology key survived recomputation and passed integrity checks.",
      [exact.referenceKey],
      "No recovery action is required."
    )]);
  }

  const eligible = evaluations.filter((candidate) => candidate.eligible && candidate.totalScore !== null);
  if (eligible.length === 0) {
    const rejectedByTolerance = evaluations.some((candidate) => candidate.rejectionReasons.some((reason) =>
      reason === "entity-tolerance" || reason === "centroid" || reason === "bounds"
      || reason === "measure" || reason === "orientation" || reason === "analytic-parameters"
    ));
    return buildResult(request, policy, "missing", source, null, evaluations, [], [diagnostic(
      rejectedByTolerance ? "TOLERANCE_REJECTED" : "REFERENCE_MISSING",
      "error",
      rejectedByTolerance
        ? "No lineage-compatible topology candidate remained inside the configured geometric tolerances."
        : "The referenced topology was deleted or no lineage-compatible candidate exists in the target revision.",
      [],
      "Repair the feature selection, increase a justified tolerance explicitly, or roll back to the last valid revision."
    )]);
  }

  const minimumScore = Math.min(...eligible.map((candidate) => candidate.totalScore ?? Number.POSITIVE_INFINITY));
  const best = eligible.filter((candidate) => Math.abs((candidate.totalScore ?? Number.POSITIVE_INFINITY) - minimumScore)
    <= policy.ambiguityScoreEpsilon);
  if (best.length !== 1) {
    const ambiguous = best
      .map((candidate) => entityByReferenceKey(request.targetSnapshot, candidate.referenceKey))
      .filter((entity): entity is PersistentTopologyEntity => entity !== null)
      .sort(compareEntities);
    return buildResult(request, policy, "ambiguous", source, null, evaluations, ambiguous, [diagnostic(
      "REFERENCE_AMBIGUOUS",
      "error",
      `${best.length} candidates are equivalent within the ambiguity epsilon; no candidate was selected.`,
      best.map((candidate) => candidate.referenceKey).sort(compareStrings),
      "Ask the user for disambiguating geometry or add a stable semantic role/neighborhood constraint."
    )]);
  }

  const winner = best[0];
  const selected = winner === undefined ? null : entityByReferenceKey(request.targetSnapshot, winner.referenceKey);
  if (selected === null) return impossibleMissingCandidate(request, policy, source, evaluations);
  return buildResult(request, policy, "unique-recovered", source, selected, evaluations, [], [diagnostic(
    "UNIQUE_REFERENCE_RECOVERED",
    "info",
    "One candidate uniquely matched feature lineage, geometry, topology neighborhood, and tolerance policy.",
    [selected.trackedReference.kernelReference.key],
    "Persist the returned reference only with its receipt and target revision."
  )]);
}

function evaluateCandidate(
  source: PersistentTopologyEntity,
  candidate: PersistentTopologyEntity,
  policy: Readonly<TopologyResolutionPolicy>
): TopologyCandidateEvaluation {
  const sourceKey = source.trackedReference.kernelReference.key;
  const candidateKey = candidate.trackedReference.kernelReference.key;
  const exactKey = sourceKey === candidateKey;
  const rejections: CandidateRejectionReason[] = [];
  if (source.kind !== candidate.kind) rejections.push("kind");
  const rank = source.kind === candidate.kind ? lineageRank(source, candidate) : null;
  if (rank === null) rejections.push("lineage");

  const comparison = compareGeometry(signatureOf(source), signatureOf(candidate));
  if (!comparison.geometryClassMatches) rejections.push("geometry-class");
  if (source.toleranceMeters > policy.maximumEntityToleranceMeters
    || candidate.toleranceMeters > policy.maximumEntityToleranceMeters) rejections.push("entity-tolerance");
  const centroidGate = policy.centroidToleranceMeters + source.toleranceMeters + candidate.toleranceMeters;
  const boundsGate = policy.boundsToleranceMeters + source.toleranceMeters + candidate.toleranceMeters;
  const neighborhood = neighborhoodMismatch(source.neighbors, candidate.neighbors, policy);
  // A surviving stable key is semantic identity, so ordinary parametric edits
  // may legitimately move or resize it. Geometry gates are recovery evidence
  // only; they must not invalidate an otherwise consistent exact key.
  if (!exactKey) {
    if (comparison.centroidDeltaMeters > centroidGate) rejections.push("centroid");
    if (comparison.boundsDeltaMeters > boundsGate) rejections.push("bounds");
    if (comparison.relativeMeasureDelta > policy.relativeMeasureTolerance) rejections.push("measure");
    if (comparison.orientationDeltaRadians !== null
      && comparison.orientationDeltaRadians > policy.angularToleranceRadians) rejections.push("orientation");
    if (comparison.analyticParameterDelta === Number.POSITIVE_INFINITY
      || (comparison.analyticParameterDelta !== null
        && comparison.analyticParameterDelta > policy.analyticParameterTolerance)) rejections.push("analytic-parameters");
    if (neighborhood > policy.maximumNeighborhoodMismatch) rejections.push("neighborhood");
  }

  const eligible = rejections.length === 0 && rank !== null;
  const geometryScore = eligible
    ? normalizedGeometryScore(comparison, source.toleranceMeters, candidate.toleranceMeters, policy)
    : null;
  const totalScore = geometryScore === null || rank === null ? null : rank * 100 + geometryScore + neighborhood * 10;
  return Object.freeze({
    entityId: candidate.entityId,
    referenceKey: candidateKey,
    eligible,
    exactKey,
    lineageRank: rank,
    centroidDeltaMeters: finiteOrNull(comparison.centroidDeltaMeters),
    boundsDeltaMeters: finiteOrNull(comparison.boundsDeltaMeters),
    relativeMeasureDelta: finiteOrNull(comparison.relativeMeasureDelta),
    orientationDeltaRadians: finiteOrNull(comparison.orientationDeltaRadians),
    analyticParameterDelta: finiteOrNull(comparison.analyticParameterDelta),
    neighborhoodMismatch: finiteOrNull(neighborhood),
    totalScore: finiteOrNull(totalScore),
    rejectionReasons: freezeArray(rejections)
  });
}

function validateRequest(
  request: TopologyResolutionRequest,
  policy: Readonly<TopologyResolutionPolicy>
): TopologyResolutionDiagnostic[] {
  const diagnostics: TopologyResolutionDiagnostic[] = [];
  if (!STABLE_PROTOCOL_ID.test(request.requestId)) diagnostics.push(diagnostic(
    "INVALID_REQUEST", "error", "requestId is not a stable protocol identifier.", [], "Create a namespaced request ID."
  ));
  if (!STABLE_PROTOCOL_ID.test(request.sourceReferenceKey)) diagnostics.push(diagnostic(
    "INVALID_REQUEST", "error", "sourceReferenceKey is not a stable protocol identifier.", [], "Use the exact-kernel stable reference key."
  ));
  if (request.sourceSnapshot.projectId !== request.targetSnapshot.projectId) diagnostics.push(diagnostic(
    "INVALID_REQUEST", "error", "Source and target snapshots belong to different projects.", [], "Resolve only within one canonical project lineage."
  ));
  if (request.sourceSnapshot.bodyId !== request.targetSnapshot.bodyId) diagnostics.push(diagnostic(
    "BODY_MISMATCH", "error", "Source and target snapshots belong to different bodies.", [], "Select the matching body revision."
  ));
  if (request.targetSnapshot.documentRevision < request.sourceSnapshot.documentRevision
    || request.targetSnapshot.topologyRevision < request.sourceSnapshot.topologyRevision) diagnostics.push(diagnostic(
    "REVISION_REGRESSION", "error", "Topology recovery cannot run from a newer snapshot into an older revision.", [], "Swap the snapshots or use revision rollback."
  ));
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) diagnostics.push(diagnostic(
      "INVALID_REQUEST", "error", `Resolution policy '${name}' must be finite and non-negative.`, [], "Provide an explicit valid tolerance policy."
    ));
  }
  if (policy.centroidToleranceMeters === 0 || policy.boundsToleranceMeters === 0
    || policy.relativeMeasureTolerance === 0 || policy.angularToleranceRadians === 0
    || policy.analyticParameterTolerance === 0 || policy.maximumEntityToleranceMeters === 0) diagnostics.push(diagnostic(
    "INVALID_REQUEST", "error", "Geometric and entity tolerance ceilings must be greater than zero.", [], "Use a positive engineering tolerance."
  ));
  if (policy.maximumNeighborhoodMismatch > 1) diagnostics.push(diagnostic(
    "INVALID_REQUEST", "error", "maximumNeighborhoodMismatch must be in [0, 1].", [], "Choose a normalized mismatch ceiling."
  ));
  diagnostics.push(...validateSnapshot(request.sourceSnapshot, "source"));
  diagnostics.push(...validateSnapshot(request.targetSnapshot, "target"));
  if (findSource(request.sourceSnapshot, request.sourceReferenceKey) === null) diagnostics.push(diagnostic(
    "SOURCE_REFERENCE_MISSING", "error", "The source stable reference key is not present in the source snapshot.", [], "Reload the correct source revision."
  ));
  return diagnostics;
}

function validateSnapshot(snapshot: TopologyRevisionSnapshot, label: string): TopologyResolutionDiagnostic[] {
  const diagnostics: TopologyResolutionDiagnostic[] = [];
  if (snapshot.snapshotVersion !== 1 || !Number.isSafeInteger(snapshot.documentRevision)
    || snapshot.documentRevision < 0 || !Number.isSafeInteger(snapshot.topologyRevision)
    || snapshot.topologyRevision < 0 || snapshot.shapeDigest.length < 3) diagnostics.push(diagnostic(
    "INVALID_SNAPSHOT", "error", `The ${label} snapshot header is invalid.`, [], "Rebuild the topology snapshot from verified kernel provenance."
  ));
  const keys = new Set<string>();
  const entityIds = new Set<string>();
  for (const entity of snapshot.entities) {
    const key = entity.trackedReference.kernelReference.key;
    if (keys.has(key)) diagnostics.push(diagnostic(
      "DUPLICATE_REFERENCE_KEY", "error", `The ${label} snapshot contains duplicate reference key '${key}'.`, [key], "Reject the kernel topology result."
    ));
    keys.add(key);
    if (entityIds.has(entity.entityId)) diagnostics.push(diagnostic(
      "INVALID_SNAPSHOT", "error", `The ${label} snapshot contains duplicate entity ID '${entity.entityId}'.`, [key], "Regenerate unique transient entity IDs."
    ));
    entityIds.add(entity.entityId);
    const tracked = entity.trackedReference;
    const document = tracked.documentReference;
    const kernel = tracked.kernelReference;
    if (document.bodyId !== snapshot.bodyId || document.subshape !== entity.kind || kernel.expectedKind !== entity.kind
      || document.sourceFeatureId !== tracked.featureLineage.featureId
      || tracked.featureLineage.operationId !== kernel.producer.operationId
      || tracked.featureLineage.operationKind !== kernel.producer.operationKind
      || tracked.featureLineage.role !== kernel.producer.role
      || tracked.createdDocumentRevision > snapshot.documentRevision) diagnostics.push(diagnostic(
      "INVALID_SNAPSHOT", "error", `Reference '${key}' has inconsistent canonical ownership or kernel lineage.`, [key], "Rebuild the association from canonical feature and kernel provenance."
    ));
    if (!expectedGeometryMatches(document.expectedGeometry, kernel.signature.geometryClass)) diagnostics.push(diagnostic(
      "INVALID_SNAPSHOT",
      "error",
      `Reference '${key}' does not satisfy its canonical expected geometry '${document.expectedGeometry}'.`,
      [key],
      "Repair the feature input or regenerate the exact topology association."
    ));
    if (!STABLE_PROTOCOL_ID.test(key) || !STABLE_PROTOCOL_ID.test(kernel.semanticId)
      || !STABLE_PROTOCOL_ID.test(kernel.producer.operationId)) diagnostics.push(diagnostic(
      "INVALID_SNAPSHOT", "error", `Reference '${key}' contains an invalid stable identifier.`, [key], "Regenerate stable semantic identifiers."
    ));
    if (!finiteEntity(entity)) diagnostics.push(diagnostic(
      "INVALID_SNAPSHOT", "error", `Reference '${key}' contains non-finite geometry or tolerance data.`, [key], "Reject the kernel output before topology recovery."
    ));
  }
  return diagnostics;
}

async function buildResult(
  request: TopologyResolutionRequest,
  policy: Readonly<TopologyResolutionPolicy>,
  outcome: TopologyResolutionOutcome,
  source: PersistentTopologyEntity | null,
  selected: PersistentTopologyEntity | null,
  candidates: readonly TopologyCandidateEvaluation[],
  ambiguousCandidates: readonly PersistentTopologyEntity[],
  diagnostics: readonly TopologyResolutionDiagnostic[]
): Promise<TopologyResolutionResult> {
  const frozenCandidates = freezeArray(candidates);
  const frozenDiagnostics = freezeArray(diagnostics);
  const selectedReferenceKey = selected?.trackedReference.kernelReference.key ?? null;
  const receipt = await createTopologyResolutionReceipt({
    request,
    policy,
    outcome,
    selectedReferenceKey,
    candidates: frozenCandidates,
    diagnostics: frozenDiagnostics
  });
  const common = {
    requestId: request.requestId,
    source,
    candidates: frozenCandidates,
    diagnostics: frozenDiagnostics,
    receipt
  } as const;
  if (outcome === "exact" || outcome === "unique-recovered") {
    if (selected === null) throw new TypeError("A successful topology resolution requires a selected entity.");
    return Object.freeze({ ...common, outcome, selected, ambiguousCandidates: Object.freeze([]) });
  }
  if (outcome === "ambiguous") {
    return Object.freeze({
      ...common,
      outcome,
      selected: null,
      ambiguousCandidates: Object.freeze([...ambiguousCandidates].sort(compareEntities))
    });
  }
  if (outcome === "missing") {
    return Object.freeze({ ...common, outcome, selected: null, ambiguousCandidates: Object.freeze([]) });
  }
  return Object.freeze({ ...common, outcome: "invalid", selected: null, ambiguousCandidates: Object.freeze([]) });
}

function impossibleMissingCandidate(
  request: TopologyResolutionRequest,
  policy: Readonly<TopologyResolutionPolicy>,
  source: PersistentTopologyEntity,
  candidates: readonly TopologyCandidateEvaluation[]
): Promise<TopologyResolutionResult> {
  return buildResult(request, policy, "invalid", source, null, candidates, [], [diagnostic(
    "INVALID_SNAPSHOT", "error", "A candidate evaluation has no corresponding topology entity.", [], "Reject and rebuild the target snapshot."
  )]);
}

function mergePolicy(override: Readonly<Partial<TopologyResolutionPolicy>> | undefined): Readonly<TopologyResolutionPolicy> {
  return Object.freeze({ ...DEFAULT_TOPOLOGY_RESOLUTION_POLICY, ...(override ?? {}) });
}

function findSource(snapshot: TopologyRevisionSnapshot, referenceKey: string): PersistentTopologyEntity | null {
  const matches = snapshot.entities.filter((entity) => entity.trackedReference.kernelReference.key === referenceKey);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function entityByReferenceKey(snapshot: TopologyRevisionSnapshot, key: string): PersistentTopologyEntity | null {
  return snapshot.entities.find((entity) => entity.trackedReference.kernelReference.key === key) ?? null;
}

function compareEntities(first: PersistentTopologyEntity, second: PersistentTopologyEntity): number {
  return compareStrings(first.trackedReference.kernelReference.key, second.trackedReference.kernelReference.key);
}

function finiteEntity(entity: PersistentTopologyEntity): boolean {
  const signature = signatureOf(entity);
  return finiteNumbers([
    entity.toleranceMeters,
    signature.measure,
    ...signature.centroidMeters,
    ...signature.boundsMeters.min,
    ...signature.boundsMeters.max,
    ...(signature.orientationHint ?? []),
    ...Object.values(signature.analyticParameters ?? {}),
    ...entity.neighbors.map((neighbor) => neighbor.measure)
  ]) && entity.toleranceMeters >= 0 && signature.measure >= 0;
}

function finiteNumbers(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function expectedGeometryMatches(
  expected: PersistentTopologyEntity["trackedReference"]["documentReference"]["expectedGeometry"],
  actual: PersistentTopologyEntity["trackedReference"]["kernelReference"]["signature"]["geometryClass"]
): boolean {
  return expected === "any"
    || (expected === "planar" && actual === "plane")
    || (expected === "cylindrical" && actual === "cylinder")
    || (expected === "conical" && actual === "cone")
    || (expected === "linear" && actual === "line")
    || (expected === "circular" && actual === "circle");
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function diagnostic(
  code: TopologyResolutionDiagnostic["code"],
  severity: TopologyResolutionDiagnostic["severity"],
  message: string,
  candidateReferenceKeys: readonly string[],
  recovery: string,
  details: Readonly<Record<string, string | number | boolean>> = {}
): TopologyResolutionDiagnostic {
  return Object.freeze({
    code,
    severity,
    message,
    candidateReferenceKeys: Object.freeze([...candidateReferenceKeys].sort(compareStrings)),
    recovery,
    details: Object.freeze({ ...details })
  });
}
