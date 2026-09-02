import type {
  AxisPlacement,
  ExactShapeHandle,
  PlanePlacement,
  ShapeReference,
  StableTopologyReference,
  TopologySelection,
  Vector3
} from "../../exact-kernel-api/src/index.js";

export const SURFACE_QUALITY_SCHEMA_VERSION = 1 as const;

export type SurfaceQualitySchemaVersion = typeof SURFACE_QUALITY_SCHEMA_VERSION;
export type SurfaceFeatureId = string;
export type SurfaceAnalysisId = string;
export type ContinuityGoal = "G0" | "G1" | "G2";
export type SurfaceOperationKind =
  | "surface.extrude"
  | "surface.revolve"
  | "surface.sweep"
  | "surface.loft"
  | "surface.patch"
  | "surface.offset"
  | "surface.trim"
  | "surface.extend"
  | "surface.stitch"
  | "surface.thicken";
export type SurfaceAnalysisKind =
  | "surface-analysis.zebra"
  | "surface-analysis.reflection-lines"
  | "surface-analysis.curvature"
  | "surface-analysis.draft"
  | "surface-analysis.curvature-comb";

export interface SurfaceTolerancePolicy {
  readonly positionalMeters: number;
  readonly angularRadians: number;
  readonly curvaturePerMeter: number;
  readonly parameterTolerance: number;
}

export interface SurfaceBoundaryCondition {
  readonly boundaryId: string;
  readonly boundary: TopologySelection;
  readonly goal: ContinuityGoal;
  readonly referenceSurface?: TopologySelection;
  readonly tolerance: SurfaceTolerancePolicy;
  readonly influence: number;
  readonly reverseDirection: boolean;
}

export interface SurfacePath {
  readonly pathId: string;
  readonly segments: readonly TopologySelection[];
  readonly closed: boolean;
  readonly requireTangentChain: boolean;
}

export interface SurfaceGuideRail {
  readonly railId: string;
  readonly path: SurfacePath;
  readonly sectionParameters: readonly number[];
  readonly requireIntersectionWithEverySection: boolean;
}

export interface SurfaceCenterline {
  readonly centerlineId: string;
  readonly path: SurfacePath;
  readonly parameterization: "arc-length" | "normalized";
}

export interface SurfaceSection {
  readonly sectionId: string;
  readonly profile: TopologySelection;
  readonly parameter: number;
  readonly closed: boolean;
}

export interface SurfaceFeatureRequestBase {
  readonly schemaVersion: SurfaceQualitySchemaVersion;
  readonly featureId: SurfaceFeatureId;
  readonly revision: number;
  readonly operation: SurfaceOperationKind;
  readonly tolerance: SurfaceTolerancePolicy;
  readonly boundaryConditions: readonly SurfaceBoundaryCondition[];
}

export interface SurfaceExtrudeRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.extrude";
  readonly profile: TopologySelection;
  readonly direction: Vector3;
  readonly distanceMeters: number;
  readonly draftAngleRadians: number;
}

export interface SurfaceRevolveRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.revolve";
  readonly profile: TopologySelection;
  readonly axis: AxisPlacement;
  readonly startAngleRadians: number;
  readonly sweepAngleRadians: number;
}

export interface SurfaceSweepRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.sweep";
  readonly profile: TopologySelection;
  readonly path: SurfacePath;
  readonly guideRails: readonly SurfaceGuideRail[];
  readonly centerline?: SurfaceCenterline;
  readonly orientation: "perpendicular" | "parallel" | "fixed";
  readonly scale: number;
  readonly twistAngleRadians: number;
}

export interface SurfaceLoftRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.loft";
  readonly sections: readonly SurfaceSection[];
  readonly guideRails: readonly SurfaceGuideRail[];
  readonly centerline?: SurfaceCenterline;
  readonly closed: boolean;
}

export interface SurfacePatchRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.patch";
  readonly outerLoop: SurfacePath;
  readonly innerLoops: readonly SurfacePath[];
  readonly internalRails: readonly SurfaceGuideRail[];
}

export interface SurfaceOffsetRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.offset";
  readonly faces: readonly TopologySelection[];
  readonly distanceMeters: number;
  readonly healSelfIntersections: boolean;
}

export interface SurfaceTrimRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.trim";
  readonly targetFaces: readonly TopologySelection[];
  readonly tools: readonly TopologySelection[];
  readonly keepPoint: Vector3;
  readonly keepSide: "containing-point" | "opposite-point";
}

export interface SurfaceExtendRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.extend";
  readonly boundaryEdges: readonly TopologySelection[];
  readonly distanceMeters: number;
  readonly mode: "natural" | "linear" | "circular";
  readonly mergeAdjacent: boolean;
}

export interface SurfaceStitchRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.stitch";
  readonly inputs: readonly ShapeReference[];
  readonly sewToleranceMeters: number;
  readonly requireClosedShell: boolean;
  readonly heal: boolean;
}

export interface SurfaceThickenRequest extends SurfaceFeatureRequestBase {
  readonly operation: "surface.thicken";
  readonly faces: readonly TopologySelection[];
  readonly firstSideMeters: number;
  readonly secondSideMeters: number;
  readonly result: "solid" | "shell";
  readonly heal: boolean;
}

export type SurfaceFeatureRequest =
  | SurfaceExtrudeRequest
  | SurfaceRevolveRequest
  | SurfaceSweepRequest
  | SurfaceLoftRequest
  | SurfacePatchRequest
  | SurfaceOffsetRequest
  | SurfaceTrimRequest
  | SurfaceExtendRequest
  | SurfaceStitchRequest
  | SurfaceThickenRequest;

export interface EdgeMatchReport {
  readonly first: StableTopologyReference;
  readonly second: StableTopologyReference;
  readonly status: "exact" | "within-tolerance" | "gap" | "overlap" | "ambiguous";
  readonly samplesEvaluated: number;
  readonly maximumGapMeters: number;
  readonly maximumAngleRadians: number;
  readonly maximumCurvatureDeltaPerMeter: number;
  readonly achievedContinuity: ContinuityGoal;
}

export interface TrimLoopReport {
  readonly loopId: string;
  readonly edges: readonly StableTopologyReference[];
  readonly closed: boolean;
  readonly orientation: "clockwise" | "counter-clockwise" | "unknown";
  readonly maximumClosureGapMeters: number;
  readonly selfIntersectionCount: number;
}

export interface StitchGap {
  readonly first: StableTopologyReference;
  readonly second: StableTopologyReference;
  readonly maximumGapMeters: number;
}

export interface StitchGapReport {
  readonly sewToleranceMeters: number;
  readonly matchedEdgePairs: number;
  readonly freeEdges: readonly StableTopologyReference[];
  readonly gaps: readonly StitchGap[];
  readonly maximumGapMeters: number;
  readonly closedShell: boolean;
}

export interface SurfaceDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export interface SurfaceFeatureBackendResult {
  readonly requestDigest: string;
  readonly operation: SurfaceOperationKind;
  readonly evaluatedFromExactGeometry: true;
  readonly outputs: readonly ExactShapeHandle[];
  readonly edgeMatches: readonly EdgeMatchReport[];
  readonly trimLoops: readonly TrimLoopReport[];
  readonly stitchReport?: StitchGapReport;
  readonly diagnostics: readonly SurfaceDiagnostic[];
}

export interface SurfaceSamplingPolicy {
  readonly uSamples: number;
  readonly vSamples: number;
  readonly adaptive: boolean;
  readonly chordToleranceMeters: number;
  readonly angularToleranceRadians: number;
}

export interface SurfaceAnalysisRequestBase {
  readonly schemaVersion: SurfaceQualitySchemaVersion;
  readonly analysisId: SurfaceAnalysisId;
  readonly revision: number;
  readonly analysis: SurfaceAnalysisKind;
  readonly faces: readonly TopologySelection[];
  readonly sampling: SurfaceSamplingPolicy;
}

export interface ZebraAnalysisRequest extends SurfaceAnalysisRequestBase {
  readonly analysis: "surface-analysis.zebra";
  readonly stripeDirection: Vector3;
  readonly stripeCount: number;
  readonly phase: number;
}

export interface ReflectionLineAnalysisRequest extends SurfaceAnalysisRequestBase {
  readonly analysis: "surface-analysis.reflection-lines";
  readonly viewDirection: Vector3;
  readonly lightDirections: readonly Vector3[];
  readonly lineToleranceMeters: number;
}

export interface CurvatureAnalysisRequest extends SurfaceAnalysisRequestBase {
  readonly analysis: "surface-analysis.curvature";
  readonly quantity: "gaussian" | "mean" | "both";
  readonly clampRangePerSquareMeter?: readonly [number, number];
}

export interface DraftAnalysisRequest extends SurfaceAnalysisRequestBase {
  readonly analysis: "surface-analysis.draft";
  readonly pullDirection: Vector3;
  readonly requiredDraftAngleRadians: number;
  readonly neutralPlane?: PlanePlacement;
}

export interface CurvatureCombAnalysisRequest extends SurfaceAnalysisRequestBase {
  readonly analysis: "surface-analysis.curvature-comb";
  readonly curves: readonly TopologySelection[];
  readonly combScaleMetersSquared: number;
  readonly samplesPerCurve: number;
}

export type SurfaceAnalysisRequest =
  | ZebraAnalysisRequest
  | ReflectionLineAnalysisRequest
  | CurvatureAnalysisRequest
  | DraftAnalysisRequest
  | CurvatureCombAnalysisRequest;

export interface SurfaceFieldPoint {
  readonly face: StableTopologyReference;
  readonly uv: readonly [number, number];
  readonly positionMeters: Vector3;
  readonly normal: Vector3;
}

export interface ZebraFieldSample extends SurfaceFieldPoint {
  readonly stripeCoordinate: number;
  readonly reflectionIntensity: number;
}

export interface ReflectionPolyline {
  readonly face: StableTopologyReference;
  readonly lightDirection: Vector3;
  readonly pointsMeters: readonly Vector3[];
  readonly closed: boolean;
}

export interface CurvatureFieldSample extends SurfaceFieldPoint {
  readonly gaussianPerSquareMeter: number;
  readonly meanPerMeter: number;
  readonly minimumPrincipalPerMeter: number;
  readonly maximumPrincipalPerMeter: number;
  readonly minimumPrincipalDirection: Vector3;
  readonly maximumPrincipalDirection: Vector3;
}

export interface DraftFieldSample extends SurfaceFieldPoint {
  readonly signedDraftAngleRadians: number;
  readonly classification: "positive" | "negative" | "insufficient" | "vertical";
}

export interface CurvatureCombSample {
  readonly curve: StableTopologyReference;
  readonly parameter: number;
  readonly positionMeters: Vector3;
  readonly tangent: Vector3;
  readonly normal: Vector3;
  readonly curvaturePerMeter: number;
  readonly combVectorMeters: Vector3;
}

export interface ZebraAnalysisResult {
  readonly analysis: "surface-analysis.zebra";
  readonly samples: readonly ZebraFieldSample[];
}

export interface ReflectionLineAnalysisResult {
  readonly analysis: "surface-analysis.reflection-lines";
  readonly lines: readonly ReflectionPolyline[];
}

export interface CurvatureAnalysisResult {
  readonly analysis: "surface-analysis.curvature";
  readonly samples: readonly CurvatureFieldSample[];
}

export interface DraftAnalysisResult {
  readonly analysis: "surface-analysis.draft";
  readonly samples: readonly DraftFieldSample[];
  readonly minimumAngleRadians: number;
  readonly maximumAngleRadians: number;
}

export interface CurvatureCombAnalysisResult {
  readonly analysis: "surface-analysis.curvature-comb";
  readonly samples: readonly CurvatureCombSample[];
}

export type SurfaceAnalysisPayload =
  | ZebraAnalysisResult
  | ReflectionLineAnalysisResult
  | CurvatureAnalysisResult
  | DraftAnalysisResult
  | CurvatureCombAnalysisResult;

export interface SurfaceAnalysisBackendResult {
  readonly requestDigest: string;
  readonly analysis: SurfaceAnalysisKind;
  readonly evaluatedFromExactGeometry: true;
  readonly payload: SurfaceAnalysisPayload;
  readonly diagnostics: readonly SurfaceDiagnostic[];
}

export interface SurfaceBackendIdentity {
  readonly implementation: string;
  readonly implementationVersion: string;
  readonly exactKernel: string;
  readonly exactKernelVersion: string;
  readonly buildId: string;
  readonly executionTarget: "wasm-worker" | "native-worker";
}

export interface SurfaceBackendCapabilities {
  readonly supportedOperations: readonly SurfaceOperationKind[];
  readonly supportedAnalyses: readonly SurfaceAnalysisKind[];
  readonly supportedContinuity: readonly ContinuityGoal[];
  readonly deterministicForIdenticalBuildAndInputs: boolean;
  readonly minimumPositionalToleranceMeters: number;
  readonly minimumAngularToleranceRadians: number;
  readonly maximumSamplesPerAnalysis: number;
}

export interface ExactSurfaceBackend {
  readonly identity: SurfaceBackendIdentity;
  readonly capabilities: SurfaceBackendCapabilities;
  evaluateFeature(request: SurfaceFeatureRequest, requestDigest: string): Promise<SurfaceFeatureBackendResult>;
  analyze(request: SurfaceAnalysisRequest, requestDigest: string): Promise<SurfaceAnalysisBackendResult>;
}

export interface SurfaceEvaluationReceipt {
  readonly schemaVersion: SurfaceQualitySchemaVersion;
  readonly artifactId: string;
  readonly artifactKind: SurfaceOperationKind | SurfaceAnalysisKind;
  readonly requestDigest: string;
  readonly resultDigest: string;
  readonly dependencyKeys: readonly string[];
  readonly invalidationDigest: string;
  readonly backend: SurfaceBackendIdentity;
  readonly deterministic: boolean;
}

export interface SurfaceEvaluation<T> {
  readonly result: T;
  readonly receipt: SurfaceEvaluationReceipt;
}

export interface SurfaceDependencyChange {
  readonly changedKeys: readonly string[];
}

export interface SurfaceInvalidationReport {
  readonly changeDigest: string;
  readonly invalidatedArtifactIds: readonly string[];
  readonly retainedArtifactIds: readonly string[];
}

export type SurfaceContractErrorCode =
  | "EXACT_BACKEND_REQUIRED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_CAPABILITY"
  | "BACKEND_PROTOCOL_ERROR"
  | "NON_FINITE_BACKEND_RESULT";

export class SurfaceContractError extends Error {
  readonly code: SurfaceContractErrorCode;
  readonly diagnostics: readonly SurfaceDiagnostic[];

  constructor(code: SurfaceContractErrorCode, message: string, diagnostics: readonly SurfaceDiagnostic[] = []) {
    super(message);
    this.name = "SurfaceContractError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
