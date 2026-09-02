/**
 * Canonical parametric sketch contract.
 *
 * Coordinates are millimetres and angles are radians. Geometry is immutable at
 * the package boundary; solver implementations return a new document revision.
 */
export type Vec2 = readonly [number, number];

export interface SketchPlane {
  readonly kind: "principal" | "datum" | "planar-face";
  readonly referenceId: string;
  readonly originMm: readonly [number, number, number];
  readonly xAxis: readonly [number, number, number];
  readonly yAxis: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

interface GeometryBase {
  readonly id: string;
  readonly construction: boolean;
  readonly suppressed: boolean;
  readonly source?: ProjectedSource;
}

export interface ProjectedSource {
  readonly documentId: string;
  readonly topologyId: string;
  readonly revision: number;
  readonly associative: boolean;
}

export interface PointGeometry extends GeometryBase {
  readonly kind: "point";
  readonly point: Vec2;
}

export interface LineGeometry extends GeometryBase {
  readonly kind: "line";
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface CircleGeometry extends GeometryBase {
  readonly kind: "circle";
  readonly center: Vec2;
  readonly radiusMm: number;
}

export interface ArcGeometry extends GeometryBase {
  readonly kind: "arc";
  readonly center: Vec2;
  readonly radiusMm: number;
  readonly startAngleRad: number;
  readonly endAngleRad: number;
}

export interface EllipseGeometry extends GeometryBase {
  readonly kind: "ellipse";
  readonly center: Vec2;
  readonly majorAxis: Vec2;
  readonly minorToMajorRatio: number;
}

export interface SplineGeometry extends GeometryBase {
  readonly kind: "spline";
  readonly degree: number;
  readonly controlPoints: readonly Vec2[];
  readonly knots: readonly number[];
  readonly closed: boolean;
}

export interface PolygonGeometry extends GeometryBase {
  readonly kind: "polygon";
  readonly center: Vec2;
  readonly vertex: Vec2;
  readonly sides: number;
}

export interface SlotGeometry extends GeometryBase {
  readonly kind: "slot";
  readonly startCenter: Vec2;
  readonly endCenter: Vec2;
  readonly widthMm: number;
}

export type SketchGeometry =
  | PointGeometry
  | LineGeometry
  | CircleGeometry
  | ArcGeometry
  | EllipseGeometry
  | SplineGeometry
  | PolygonGeometry
  | SlotGeometry;

export type GeometrySelector =
  | "self"
  | "point"
  | "start"
  | "end"
  | "center"
  | "midpoint"
  | "curve"
  | "radius"
  | "major-axis"
  | "minor-axis";

export interface GeometryReference {
  readonly entityId: string;
  readonly selector: GeometrySelector;
}

interface ConstraintBase {
  readonly id: string;
  readonly suppressed: boolean;
}

export type SketchConstraint =
  | (ConstraintBase & { readonly kind: "fix"; readonly target: GeometryReference })
  | (ConstraintBase & { readonly kind: "horizontal"; readonly line: GeometryReference })
  | (ConstraintBase & { readonly kind: "vertical"; readonly line: GeometryReference })
  | (ConstraintBase & { readonly kind: "coincident"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "parallel"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "perpendicular"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "collinear"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "tangent"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "concentric"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "equal"; readonly first: GeometryReference; readonly second: GeometryReference })
  | (ConstraintBase & { readonly kind: "midpoint"; readonly point: GeometryReference; readonly line: GeometryReference })
  | (ConstraintBase & { readonly kind: "symmetric"; readonly first: GeometryReference; readonly second: GeometryReference; readonly axis: GeometryReference });

export type DimensionMode = "driving" | "driven";

export interface DimensionValue {
  /** Literal fallback in the unit declared on the dimension. */
  readonly value: number;
  /** Optional parameter expression, for example `plateWidth / 2 + 4`. */
  readonly expression?: string;
}

interface DimensionBase {
  readonly id: string;
  readonly mode: DimensionMode;
  readonly suppressed: boolean;
  readonly value: DimensionValue;
}

export type SketchDimension =
  | (DimensionBase & {
      readonly kind: "linear";
      readonly first: GeometryReference;
      readonly second: GeometryReference;
      readonly orientation: "aligned" | "horizontal" | "vertical";
      readonly unit: "mm";
    })
  | (DimensionBase & { readonly kind: "length"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "radius"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "diameter"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & {
      readonly kind: "angle";
      readonly first: GeometryReference;
      readonly second: GeometryReference;
      readonly unit: "rad";
    })
  | (DimensionBase & { readonly kind: "coordinate-x"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "coordinate-y"; readonly target: GeometryReference; readonly unit: "mm" });

export interface ParametricSketchDocument {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly revision: number;
  readonly plane: SketchPlane;
  /** Scalar parameters use the consumer-defined unit expected by the expression. */
  readonly parameters: Readonly<Record<string, number>>;
  readonly geometry: readonly SketchGeometry[];
  readonly constraints: readonly SketchConstraint[];
  readonly dimensions: readonly SketchDimension[];
}

export type SketchDiagnosticCode =
  | "DUPLICATE_ID"
  | "INVALID_NUMBER"
  | "DEGENERATE_GEOMETRY"
  | "MISSING_REFERENCE"
  | "INVALID_REFERENCE"
  | "INVALID_EXPRESSION"
  | "CONSTRAINT_CONFLICT"
  | "DIMENSION_CONFLICT"
  | "DRAG_CONFLICT"
  | "UNSUPPORTED_ENTITY_SOLVE"
  | "UNSUPPORTED_CONSTRAINT"
  | "UNSUPPORTED_DIMENSION"
  | "UNSUPPORTED_OPERATION"
  | "SOLVER_DID_NOT_CONVERGE";

export interface SketchDiagnostic {
  readonly code: SketchDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
  /** True only when the requested behavior is intentionally outside this backend. */
  readonly unsupported: boolean;
}

export interface SketchDofState {
  readonly classification: "fully-constrained" | "under-constrained" | "over-constrained" | "invalid";
  readonly total: number;
  readonly byEntity: Readonly<Record<string, number>>;
  readonly unconstrainedEntityIds: readonly string[];
  readonly method: "analytic-rank-estimate-v1";
}

export interface DimensionMeasurement {
  readonly dimensionId: string;
  readonly value: number;
  readonly unit: "mm" | "rad";
  readonly mode: DimensionMode;
}

export interface DragTarget {
  readonly reference: GeometryReference;
  readonly positionMm: Vec2;
}

export interface SketchSolveRequest {
  readonly document: ParametricSketchDocument;
  readonly mode: "validate" | "regenerate" | "drag";
  readonly dragTarget?: DragTarget;
  readonly toleranceMm?: number;
  readonly maxPasses?: number;
}

export interface SketchSolveResult {
  readonly status: "solved" | "partial" | "failed";
  readonly document: ParametricSketchDocument;
  readonly diagnostics: readonly SketchDiagnostic[];
  readonly dof: SketchDofState;
  readonly measurements: readonly DimensionMeasurement[];
  readonly appliedConstraintIds: readonly string[];
  readonly appliedDimensionIds: readonly string[];
  readonly deterministicFingerprint: string;
}

/** Interchangeable orchestration boundary for analytic, WASM, or native solvers. */
export interface ParametricSketchSolver {
  readonly identity: {
    readonly name: string;
    readonly version: string;
    readonly deterministic: true;
  };
  solve(request: SketchSolveRequest): SketchSolveResult;
}

export interface TrimSketchRequest {
  readonly kind: "trim";
  readonly requestId: string;
  readonly entityId: string;
  readonly pickPointMm: Vec2;
  readonly boundaryEntityIds: readonly string[];
}

export interface ExtendSketchRequest {
  readonly kind: "extend";
  readonly requestId: string;
  readonly entityId: string;
  readonly end: "start" | "end";
  readonly targetEntityIds: readonly string[];
}

export interface OffsetSketchRequest {
  readonly kind: "offset";
  readonly requestId: string;
  readonly entityIds: readonly string[];
  readonly resultEntityIds: readonly string[];
  readonly distanceMm: number;
  readonly side: "left" | "right";
  readonly associative: boolean;
}

export interface ProjectSketchRequest {
  readonly kind: "project";
  readonly requestId: string;
  readonly sourceDocumentId: string;
  readonly sourceTopologyIds: readonly string[];
  readonly resultEntityIds: readonly string[];
  readonly associative: boolean;
}

export type SketchEditRequest = TrimSketchRequest | ExtendSketchRequest | OffsetSketchRequest | ProjectSketchRequest;

export interface SketchEditResult {
  readonly status: "applied" | "rejected" | "unsupported";
  readonly document: ParametricSketchDocument;
  readonly createdEntityIds: readonly string[];
  readonly diagnostics: readonly SketchDiagnostic[];
}

export interface DragSolveSession {
  readonly id: string;
  readonly target: GeometryReference;
  readonly baseRevision: number;
  readonly updateSequence: number;
  readonly state: "active" | "committed" | "cancelled";
  readonly baseDocument: ParametricSketchDocument;
  readonly latestResult: SketchSolveResult;
}
