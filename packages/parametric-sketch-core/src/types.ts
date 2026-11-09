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

/** A rectangle with a centre, side lengths and a turn about the centre (radians, counter-clockwise). Its corners are numbered counter-clockwise from the lower left in its own frame. */
export interface RectangleGeometry extends GeometryBase {
  readonly kind: "rectangle";
  readonly center: Vec2;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly rotationRad: number;
}

export type SketchGeometry =
  | PointGeometry
  | LineGeometry
  | CircleGeometry
  | ArcGeometry
  | EllipseGeometry
  | SplineGeometry
  | PolygonGeometry
  | SlotGeometry
  | RectangleGeometry;

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
  | "minor-axis"
  | "corner-0"
  | "corner-1"
  | "corner-2"
  | "corner-3";

/**
 * The sketch origin and the two axes are always present and never move. They are referenced by these reserved entity
 * IDs and need no geometry record: the origin is a point (selector "point" or "self"), the axes are infinite lines.
 */
export const SKETCH_ORIGIN_ID = "sketch:origin";
export const SKETCH_AXIS_X_ID = "sketch:axis-x";
export const SKETCH_AXIS_Y_ID = "sketch:axis-y";
export const SKETCH_DATUM_IDS: readonly string[] = [SKETCH_ORIGIN_ID, SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID];

export function isSketchDatumId(id: string): boolean {
  return id === SKETCH_ORIGIN_ID || id === SKETCH_AXIS_X_ID || id === SKETCH_AXIS_Y_ID;
}

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
  | (ConstraintBase & { readonly kind: "symmetric"; readonly first: GeometryReference; readonly second: GeometryReference; readonly axis: GeometryReference })
  /** A point lies on the (infinite extension of a) line, circle, arc or ellipse, or on the X or Y axis. */
  | (ConstraintBase & { readonly kind: "on-curve"; readonly point: GeometryReference; readonly curve: GeometryReference })
  /**
   * Snell's law at an interface line: the refracted line leaves the end of the incident line (2 equations) and bends so that the
   * component of its direction along the interface is the incident one divided by `ratio` = n2 / n1 (1 equation). The side of the
   * interface each line lies on is kept from the geometry the solve began with.
   */
  | (ConstraintBase & { readonly kind: "refraction"; readonly incident: GeometryReference; readonly refracted: GeometryReference; readonly boundary: GeometryReference; readonly ratio: number });

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
  /** Length along an arc (radius times the swept angle). Driving it sweeps the arc's end angle with the radius held. */
  | (DimensionBase & { readonly kind: "arc-length"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "diameter"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & {
      readonly kind: "angle";
      readonly first: GeometryReference;
      readonly second: GeometryReference;
      readonly unit: "rad";
    })
  | (DimensionBase & { readonly kind: "coordinate-x"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "coordinate-y"; readonly target: GeometryReference; readonly unit: "mm" })
  /** Perpendicular distance from a point to the infinite line through a line entity (or an axis). The side it is on is kept. */
  | (DimensionBase & { readonly kind: "point-line-distance"; readonly point: GeometryReference; readonly line: GeometryReference; readonly unit: "mm" })
  /** Perpendicular distance from the first line to the midpoint of the second (the distance between two parallel lines). */
  | (DimensionBase & { readonly kind: "line-line-distance"; readonly first: GeometryReference; readonly second: GeometryReference; readonly unit: "mm" })
  /** Length of a circle's circumference, an ellipse's perimeter or a rectangle's perimeter. */
  | (DimensionBase & { readonly kind: "perimeter"; readonly target: GeometryReference; readonly unit: "mm" })
  /** A rectangle's side along its own X (width) or Y (height). */
  | (DimensionBase & { readonly kind: "width"; readonly target: GeometryReference; readonly unit: "mm" })
  | (DimensionBase & { readonly kind: "height"; readonly target: GeometryReference; readonly unit: "mm" });

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

/**
 * A group of relations that depend on each other. `redundant` sets are consistent (the geometry satisfies all of them, but
 * one is implied by the others); `conflicting` sets cannot all hold. Every ID is a constraint, dimension or fix ID of the
 * document; `labels` are the matching human-readable names (for example "horizontal on Line 2").
 */
export interface SketchRelationSet {
  readonly kind: "redundant" | "conflicting";
  readonly ids: readonly string[];
  readonly labels: readonly string[];
  readonly message: string;
  /** For a redundant set: the relation, made last, that the others already imply (the one to delete). */
  readonly implied?: string;
}

export interface SketchDofState {
  readonly classification: "fully-constrained" | "under-constrained" | "over-constrained" | "invalid";
  /** Degrees of freedom left: the number of free variables minus the rank of the relations' Jacobian. */
  readonly total: number;
  /** Per entity: how many independent ways that entity can still move or change shape, with every other entity free to follow. */
  readonly byEntity: Readonly<Record<string, number>>;
  readonly unconstrainedEntityIds: readonly string[];
  readonly method: "analytic-rank-estimate-v1" | "jacobian-rank-v2";
  /** Rank of the stacked relation Jacobian (jacobian-rank-v2 only). */
  readonly rank?: number;
  /** Number of free (not Fixed) variables the sketch has (jacobian-rank-v2 only). */
  readonly variables?: number;
  /** Relations that add nothing because others already imply them, and relations that contradict others. */
  readonly relationSets?: readonly SketchRelationSet[];
  readonly redundantIds?: readonly string[];
  readonly conflictingIds?: readonly string[];
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

/**
 * A hint about which geometry should stay put when a relation can be met several ways. `priority` 2 is held almost rigidly,
 * 1 moves only when it must, 0 resets the geometry to the default (free). Later entries override earlier ones for the
 * same variable, so "everything of this line except its start" is a priority-2 `self` followed by a priority-0 `start`.
 */
export interface SolveAnchor {
  readonly reference: GeometryReference;
  readonly priority: 0 | 1 | 2;
}

export interface SketchSolveRequest {
  readonly document: ParametricSketchDocument;
  readonly mode: "validate" | "regenerate" | "drag";
  readonly dragTarget?: DragTarget;
  readonly toleranceMm?: number;
  /** Kept for compatibility; the simultaneous solver bounds its own iterations. */
  readonly maxPasses?: number;
  readonly anchors?: readonly SolveAnchor[];
  /** Entities whose size (a line's length, a circle's radius, a rectangle's sides) should be kept while their direction or position changes. */
  readonly preserve?: readonly string[];
  /** Entities whose size is kept only as a mild preference (it gives way to `preserve`): the lines of a chain or loop. */
  readonly preserveWeak?: readonly string[];
  /**
   * Two-level solve. After every relation holds exactly and the geometry has moved as little as it can, the curves that had to move are
   * pulled back toward their original shape inside the freedom the relations leave: a line keeps its direction and length, a circle or
   * arc its radius, as far as the relations allow. Geometry the relations did not force to move stays exactly where it was.
   */
  readonly keepShape?: boolean;
  /** Human-readable names for constraints, dimensions and geometry, used in diagnostics. */
  readonly labels?: Readonly<Record<string, string>>;
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
