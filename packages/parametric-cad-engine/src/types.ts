import type {
  CadDocument,
  CadFeature,
  CadSketch,
  FeatureId,
  FeatureRebuildPlan,
  SketchId
} from "@ps3d/cad-document-core/src/index.js";
import type {
  ExactKernelAdapter,
  ExactKernelOperation,
  ExactKernelOperationKind,
  KernelExecutionProducts,
  KernelOperationReceipt
} from "@ps3d/exact-kernel-api/src/index.js";
import type {
  ParametricSketchDocument,
  ParametricSketchSolver,
  SketchSolveResult
} from "@ps3d/parametric-sketch-core/src/index.js";

export const PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION = 1 as const;

export type EngineDiagnosticCode =
  | "INVALID_DOCUMENT"
  | "INVALID_REQUEST"
  | "STALE_CACHE"
  | "SKETCH_SOURCE_MISSING"
  | "SKETCH_SOLVE_FAILED"
  | "FEATURE_MAPPING_FAILED"
  | "FEATURE_MAPPING_INVALID"
  | "FEATURE_UNSUPPORTED"
  | "DEPENDENCY_RESULT_MISSING"
  | "DEPENDENCY_BLOCKED"
  | "KERNEL_SESSION_FAILED"
  | "KERNEL_CAPABILITY_MISSING"
  | "KERNEL_PROTOCOL_FAILED"
  | "KERNEL_OPERATION_FAILED"
  | "KERNEL_RESULT_INVALID"
  | "CANCELLED";

export type EngineStage = "validation" | "planning" | "sketch" | "mapping" | "kernel" | "rebuild";

export interface EngineDiagnostic {
  readonly code: EngineDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly stage: EngineStage;
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
  readonly sourceCodes: readonly string[];
}

export interface SketchLastGoodResult {
  readonly sketchId: SketchId;
  readonly sourceDocumentRevision: number;
  readonly solverName: string;
  readonly solverVersion: string;
  readonly result: SketchSolveResult;
}

export interface FeatureLastGoodResult {
  readonly featureId: FeatureId;
  readonly sourceDocumentRevision: number;
  readonly operationKind: ExactKernelOperationKind;
  readonly products: KernelExecutionProducts;
  readonly kernelReceipt: KernelOperationReceipt;
}

export interface ParametricCadEngineCache {
  readonly schemaVersion: typeof PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION;
  readonly documentId: string;
  readonly sessionId: string;
  readonly sourceDocumentRevision: number;
  readonly sketches: readonly SketchLastGoodResult[];
  readonly features: readonly FeatureLastGoodResult[];
}

export interface SketchEvaluationRecord {
  readonly sketchId: SketchId;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly retainedLastGood: boolean;
  readonly deterministicFingerprint: string | null;
}

export interface FeatureEvaluationRecord {
  readonly featureId: FeatureId;
  readonly status: "succeeded" | "failed" | "blocked" | "skipped";
  readonly reason: string;
  readonly operationKind: ExactKernelOperationKind | null;
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly retainedLastGood: boolean;
  readonly kernelResultDigest: string | null;
}

export interface FeatureMappingContext {
  readonly document: CadDocument;
  readonly feature: CadFeature;
  readonly dependencyResults: readonly FeatureLastGoodResult[];
  readonly sketchResults: readonly SketchLastGoodResult[];
}

export type FeatureOperationMapping =
  | { readonly status: "mapped"; readonly operation: ExactKernelOperation }
  | { readonly status: "unsupported"; readonly diagnostics: readonly EngineDiagnostic[] };

/**
 * Converts a validated canonical feature into a fully specified exact-kernel
 * operation. The mapper is deliberately injected: guessing profiles, topology
 * selections, or feature parameters would create non-auditable geometry.
 */
export interface FeatureOperationMapper {
  map(context: FeatureMappingContext): FeatureOperationMapping | Promise<FeatureOperationMapping>;
}

export type FeatureOperationFactory = (
  context: FeatureMappingContext
) => ExactKernelOperation | Promise<ExactKernelOperation>;

export interface ParametricCadEngineDependencies {
  readonly sketchSolver: ParametricSketchSolver;
  readonly kernelAdapter: ExactKernelAdapter;
  readonly featureMapper: FeatureOperationMapper;
}

export interface ParametricCadRebuildRequest {
  readonly requestId: string;
  readonly mode: "preview" | "rebuild";
  readonly document: CadDocument;
  readonly generation: number;
  readonly sessionId: string;
  readonly changedFeatureIds?: readonly FeatureId[];
  readonly includeDirty?: boolean;
  /** Solver-ready documents supplied by a deterministic canonical-sketch bridge. */
  readonly sketchDocuments: Readonly<Record<string, ParametricSketchDocument>>;
  readonly priorCache?: ParametricCadEngineCache;
  /** Open the supplied session before evaluating. Leave false for a caller-managed persistent session. */
  readonly openSession?: boolean;
}

export interface ParametricCadReceipt {
  readonly schemaVersion: typeof PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION;
  readonly kind: "preview-receipt" | "rebuild-receipt";
  readonly requestId: string;
  readonly documentId: string;
  readonly sourceDocumentRevision: number;
  readonly candidateDocumentRevision: number | null;
  readonly sourceDocumentSha256: string;
  readonly planSha256: string;
  readonly priorCacheSha256: string;
  readonly resultCacheSha256: string;
  readonly kernelResultSha256: readonly string[];
  readonly outcomeSha256: string;
  readonly receiptSha256: string;
}

export interface ParametricCadRebuildOutcome {
  readonly status: "succeeded" | "partial" | "failed";
  readonly candidateDocument: CadDocument | null;
  readonly plan: FeatureRebuildPlan | null;
  readonly sketches: readonly SketchEvaluationRecord[];
  readonly features: readonly FeatureEvaluationRecord[];
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly cache: ParametricCadEngineCache;
  readonly receipt: ParametricCadReceipt;
}

export interface ParametricCadEngine {
  rebuild(request: ParametricCadRebuildRequest, signal?: AbortSignal): Promise<ParametricCadRebuildOutcome>;
}

export interface OperationTableEntry {
  readonly featureId: FeatureId;
  readonly factory: FeatureOperationFactory;
}

export interface CanonicalSketchBridge {
  toSolverDocument(sketch: CadSketch, document: CadDocument): ParametricSketchDocument;
}
