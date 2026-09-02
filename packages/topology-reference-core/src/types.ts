import type {
  BodyId,
  FeatureId,
  ProjectId,
  TopologyReference
} from "../../cad-document-core/src/index.js";
import type {
  GeometricSignature,
  KernelTopologyKind,
  ResolvedTopologyEntity,
  StableTopologyReference
} from "../../exact-kernel-api/src/index.js";

export const TOPOLOGY_REFERENCE_RESOLVER_VERSION = 1 as const;

export type PersistentSubshapeKind = "vertex" | "edge" | "face";
export type TopologyResolutionOutcome = "exact" | "unique-recovered" | "ambiguous" | "missing" | "invalid";

export interface FeatureLineageIdentity {
  /** Stable canonical feature identity, independent of timeline array position. */
  readonly featureId: FeatureId;
  /** Stable semantic operation ID submitted to the exact kernel. */
  readonly operationId: string;
  readonly operationKind: StableTopologyReference["producer"]["operationKind"];
  /** Semantic output role such as `extrude:end-face` or `hole:wall`. */
  readonly role: string;
}

export interface TrackedTopologyReference {
  readonly referenceVersion: 1;
  readonly documentReference: TopologyReference;
  readonly kernelReference: StableTopologyReference;
  readonly featureLineage: FeatureLineageIdentity;
  readonly createdDocumentRevision: number;
}

export interface TopologyNeighborContext {
  readonly kind: PersistentSubshapeKind;
  readonly semanticId: string;
  readonly producerRole: string;
  readonly geometryClass: GeometricSignature["geometryClass"];
  readonly measure: number;
}

export interface PersistentTopologyEntity {
  readonly entityId: string;
  readonly kind: PersistentSubshapeKind;
  readonly trackedReference: TrackedTopologyReference;
  readonly orientation: ResolvedTopologyEntity["orientation"];
  readonly toleranceMeters: number;
  /** Complete first-ring adjacency, represented semantically rather than by transient array indexes. */
  readonly neighbors: readonly TopologyNeighborContext[];
}

export interface TopologyRevisionSnapshot {
  readonly snapshotVersion: 1;
  readonly projectId: ProjectId;
  readonly documentRevision: number;
  readonly bodyId: BodyId;
  readonly topologyRevision: number;
  readonly shapeDigest: string;
  readonly entities: readonly PersistentTopologyEntity[];
}

export interface KernelTopologyAssociation {
  readonly documentReference: TopologyReference;
  readonly featureLineage: FeatureLineageIdentity;
  readonly kernelEntity: ResolvedTopologyEntity;
  readonly createdDocumentRevision: number;
}

export interface TopologyResolutionPolicy {
  /** Maximum allowed centroid movement, before kernel uncertainty is added. */
  readonly centroidToleranceMeters: number;
  /** Maximum coordinate delta between the old and new bounding boxes. */
  readonly boundsToleranceMeters: number;
  /** Maximum relative change in length, area, or other topology measure. */
  readonly relativeMeasureTolerance: number;
  readonly angularToleranceRadians: number;
  readonly analyticParameterTolerance: number;
  /** Reject an entity whose own modeling tolerance is worse than this ceiling. */
  readonly maximumEntityToleranceMeters: number;
  /** Maximum normalized first-ring neighborhood mismatch in [0, 1]. */
  readonly maximumNeighborhoodMismatch: number;
  /** Scores within this epsilon are a tie and therefore ambiguous. */
  readonly ambiguityScoreEpsilon: number;
}

export const DEFAULT_TOPOLOGY_RESOLUTION_POLICY: Readonly<TopologyResolutionPolicy> = Object.freeze({
  centroidToleranceMeters: 1e-4,
  boundsToleranceMeters: 1e-4,
  relativeMeasureTolerance: 1e-3,
  angularToleranceRadians: 1e-4,
  analyticParameterTolerance: 1e-6,
  maximumEntityToleranceMeters: 1e-3,
  maximumNeighborhoodMismatch: 0.34,
  ambiguityScoreEpsilon: 1e-10
});

export interface TopologyResolutionRequest {
  readonly requestId: string;
  readonly sourceSnapshot: TopologyRevisionSnapshot;
  readonly sourceReferenceKey: string;
  readonly targetSnapshot: TopologyRevisionSnapshot;
  readonly policy?: Readonly<Partial<TopologyResolutionPolicy>>;
}

export const TOPOLOGY_RESOLUTION_DIAGNOSTIC_CODES = [
  "INVALID_REQUEST",
  "INVALID_SNAPSHOT",
  "DUPLICATE_REFERENCE_KEY",
  "BODY_MISMATCH",
  "REVISION_REGRESSION",
  "SOURCE_REFERENCE_MISSING",
  "EXACT_REFERENCE_RESOLVED",
  "UNIQUE_REFERENCE_RECOVERED",
  "REFERENCE_AMBIGUOUS",
  "REFERENCE_MISSING",
  "KIND_REJECTED",
  "LINEAGE_REJECTED",
  "GEOMETRY_REJECTED",
  "TOLERANCE_REJECTED",
  "NEIGHBORHOOD_REJECTED"
] as const;

export type TopologyResolutionDiagnosticCode = typeof TOPOLOGY_RESOLUTION_DIAGNOSTIC_CODES[number];

export interface TopologyResolutionDiagnostic {
  readonly code: TopologyResolutionDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly candidateReferenceKeys: readonly string[];
  readonly recovery: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export type CandidateRejectionReason =
  | "kind"
  | "lineage"
  | "geometry-class"
  | "entity-tolerance"
  | "centroid"
  | "bounds"
  | "measure"
  | "orientation"
  | "analytic-parameters"
  | "neighborhood";

export interface TopologyCandidateEvaluation {
  readonly entityId: string;
  readonly referenceKey: string;
  readonly eligible: boolean;
  readonly exactKey: boolean;
  readonly lineageRank: number | null;
  readonly centroidDeltaMeters: number | null;
  readonly boundsDeltaMeters: number | null;
  readonly relativeMeasureDelta: number | null;
  readonly orientationDeltaRadians: number | null;
  readonly analyticParameterDelta: number | null;
  readonly neighborhoodMismatch: number | null;
  readonly totalScore: number | null;
  readonly rejectionReasons: readonly CandidateRejectionReason[];
}

export interface TopologyResolutionReceipt {
  readonly resolverVersion: typeof TOPOLOGY_REFERENCE_RESOLVER_VERSION;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly resultDigest: string;
  readonly sourceDocumentRevision: number;
  readonly targetDocumentRevision: number;
  readonly sourceReferenceKey: string;
  readonly outcome: TopologyResolutionOutcome;
  readonly selectedReferenceKey: string | null;
  readonly eligibleReferenceKeys: readonly string[];
  readonly deterministic: true;
}

interface TopologyResolutionResultBase {
  readonly requestId: string;
  readonly source: PersistentTopologyEntity | null;
  readonly candidates: readonly TopologyCandidateEvaluation[];
  readonly diagnostics: readonly TopologyResolutionDiagnostic[];
  readonly receipt: TopologyResolutionReceipt;
}

export interface TopologyResolutionSuccess extends TopologyResolutionResultBase {
  readonly outcome: "exact" | "unique-recovered";
  readonly selected: PersistentTopologyEntity;
  readonly ambiguousCandidates: readonly PersistentTopologyEntity[];
}

export interface TopologyResolutionAmbiguous extends TopologyResolutionResultBase {
  readonly outcome: "ambiguous";
  readonly selected: null;
  readonly ambiguousCandidates: readonly PersistentTopologyEntity[];
}

export interface TopologyResolutionMissing extends TopologyResolutionResultBase {
  readonly outcome: "missing";
  readonly selected: null;
  readonly ambiguousCandidates: readonly PersistentTopologyEntity[];
}

export interface TopologyResolutionInvalid extends TopologyResolutionResultBase {
  readonly outcome: "invalid";
  readonly selected: null;
  readonly ambiguousCandidates: readonly PersistentTopologyEntity[];
}

export type TopologyResolutionResult =
  | TopologyResolutionSuccess
  | TopologyResolutionAmbiguous
  | TopologyResolutionMissing
  | TopologyResolutionInvalid;

export interface CreateTopologySnapshotInput {
  readonly projectId: ProjectId;
  readonly documentRevision: number;
  readonly bodyId: BodyId;
  readonly topologyRevision: number;
  readonly shapeDigest: string;
  readonly associations: readonly KernelTopologyAssociation[];
}

export function isPersistentSubshapeKind(kind: KernelTopologyKind): kind is PersistentSubshapeKind {
  return kind === "vertex" || kind === "edge" || kind === "face";
}
