import type {
  AnyCadReference,
  BodyId,
  ComponentId,
  DrawingAnnotationId,
  DrawingId,
  DrawingViewId,
  FeatureId,
  JointId,
  OccurrenceId,
  OriginId,
  ProjectId,
  SketchConstraintId,
  SketchDimensionId,
  SketchEntityId,
  SketchId
} from "./ids.js";

export const CAD_DOCUMENT_FORMAT = "ps3d-cad-document" as const;
export const CAD_DOCUMENT_SCHEMA_VERSION = 1 as const;

export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";
export type AngleUnit = "deg" | "rad";
export type MassUnit = "g" | "kg" | "lb";

export interface UnitSystem {
  readonly length: LengthUnit;
  readonly angle: AngleUnit;
  readonly mass: MassUnit;
}

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];

export interface Transform3 {
  readonly translationMeters: Vec3;
  readonly rotation: Quaternion;
  readonly scale: Vec3;
}

export const IDENTITY_TRANSFORM: Transform3 = Object.freeze({
  translationMeters: Object.freeze([0, 0, 0]) as Vec3,
  rotation: Object.freeze([0, 0, 0, 1]) as Quaternion,
  scale: Object.freeze([1, 1, 1]) as Vec3
});

export const CAD_DIAGNOSTIC_CODES = [
  "DUPLICATE_ID",
  "ID_KIND_MISMATCH",
  "MISSING_REFERENCE",
  "INVALID_REFERENCE",
  "OWNERSHIP_MISMATCH",
  "INVALID_TIMELINE",
  "FEATURE_CYCLE",
  "OCCURRENCE_CYCLE",
  "ROLLBACK_TARGET_INVALID",
  "INVALID_TRANSFORM",
  "INVALID_PARAMETER",
  "INVALID_SKETCH",
  "INVALID_JOINT",
  "INVALID_DRAWING",
  "FEATURE_EVALUATION_FAILED",
  "DEPENDENCY_BLOCKED"
] as const;

export type CadDiagnosticCode = (typeof CAD_DIAGNOSTIC_CODES)[number];
export type CadDiagnosticSeverity = "info" | "warning" | "error";

export interface CadDiagnostic {
  readonly code: CadDiagnosticCode;
  readonly severity: CadDiagnosticSeverity;
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export type CadResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly diagnostics: readonly CadDiagnostic[] };

export type EvaluationStatus =
  | "clean"
  | "dirty"
  | "queued"
  | "evaluating"
  | "succeeded"
  | "failed"
  | "blocked"
  | "suppressed"
  | "rolled-back";

export interface CadExpression {
  /** User-authored expression, retained verbatim for editing. */
  readonly expression: string;
  /** Dimension resolved by the expression engine. */
  readonly dimension: "scalar" | "length" | "angle" | "integer" | "boolean" | "text";
  /** Kernel-neutral SI value; text and boolean dimensions use string/boolean. */
  readonly value: number | string | boolean;
}

export interface FeatureParameter {
  readonly name: string;
  readonly label: string;
  readonly value: CadExpression;
  readonly driving: boolean;
}

export interface TopologyReference {
  readonly kind: "topology";
  readonly bodyId: BodyId;
  readonly subshape: "face" | "edge" | "vertex";
  /** Persistent semantic name supplied by the geometry adapter, never an array index. */
  readonly persistentName: string;
  readonly sourceFeatureId: FeatureId;
  readonly expectedGeometry: "any" | "planar" | "cylindrical" | "conical" | "linear" | "circular";
}

export interface SketchElementReference {
  readonly kind: "sketch-element";
  readonly sketchId: SketchId;
  readonly entityId: SketchEntityId;
}

export type FeatureInputReference = AnyCadReference | TopologyReference | SketchElementReference;

export interface CadOrigin {
  readonly id: OriginId;
  readonly componentId: ComponentId;
  readonly transform: Transform3;
  readonly axes: Readonly<Record<"x" | "y" | "z", Vec3>>;
  readonly planes: Readonly<Record<"xy" | "yz" | "xz", readonly [Vec3, Vec3]>>;
  readonly visible: boolean;
}

export interface SketchPointEntity {
  readonly id: SketchEntityId;
  readonly type: "point";
  readonly pointMeters: Vec2;
  readonly construction: boolean;
}

export interface SketchLineEntity {
  readonly id: SketchEntityId;
  readonly type: "line";
  readonly startMeters: Vec2;
  readonly endMeters: Vec2;
  readonly construction: boolean;
}

export interface SketchCircleEntity {
  readonly id: SketchEntityId;
  readonly type: "circle";
  readonly centerMeters: Vec2;
  readonly radiusMeters: number;
  readonly construction: boolean;
}

export interface SketchArcEntity {
  readonly id: SketchEntityId;
  readonly type: "arc";
  readonly centerMeters: Vec2;
  readonly radiusMeters: number;
  readonly startAngleRadians: number;
  readonly endAngleRadians: number;
  readonly construction: boolean;
}

export interface SketchEllipseEntity {
  readonly id: SketchEntityId;
  readonly type: "ellipse";
  readonly centerMeters: Vec2;
  readonly majorAxisMeters: Vec2;
  readonly majorRadiusMeters: number;
  readonly minorRadiusMeters: number;
  readonly construction: boolean;
}

export interface SketchSplineEntity {
  readonly id: SketchEntityId;
  readonly type: "spline";
  readonly degree: 2 | 3 | 4 | 5;
  readonly controlPointsMeters: readonly Vec2[];
  readonly closed: boolean;
  readonly construction: boolean;
}

export type SketchEntity =
  | SketchPointEntity
  | SketchLineEntity
  | SketchCircleEntity
  | SketchArcEntity
  | SketchEllipseEntity
  | SketchSplineEntity;

export type SketchConstraintKind =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "concentric"
  | "equal"
  | "symmetric"
  | "midpoint"
  | "fix";

export interface SketchConstraint {
  readonly id: SketchConstraintId;
  readonly kind: SketchConstraintKind;
  readonly entityIds: readonly SketchEntityId[];
  readonly enabled: boolean;
}

export interface SketchDimension {
  readonly id: SketchDimensionId;
  readonly kind: "distance" | "horizontal-distance" | "vertical-distance" | "angle" | "radius" | "diameter";
  readonly entityIds: readonly SketchEntityId[];
  readonly value: CadExpression;
  readonly driving: boolean;
  readonly placementMeters: Vec2;
}

export type SketchSupport =
  | { readonly kind: "origin-plane"; readonly originId: OriginId; readonly plane: "xy" | "yz" | "xz" }
  | { readonly kind: "planar-face"; readonly face: TopologyReference };

export interface CadSketch {
  readonly id: SketchId;
  readonly componentId: ComponentId;
  readonly name: string;
  readonly support: SketchSupport;
  readonly transform: Transform3;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly SketchConstraint[];
  readonly dimensions: readonly SketchDimension[];
  readonly solveState: {
    readonly classification: "unknown" | "under-constrained" | "fully-constrained" | "over-constrained" | "conflicting";
    readonly degreesOfFreedom: number | null;
    readonly diagnostics: readonly CadDiagnostic[];
  };
  readonly visible: boolean;
  readonly suppressed: boolean;
}

export type FeatureKind =
  | "extrude"
  | "revolve"
  | "sweep"
  | "loft"
  | "hole"
  | "thread"
  | "fillet"
  | "chamfer"
  | "draft"
  | "shell"
  | "rib"
  | "thin-extrude"
  | "boolean"
  | "linear-pattern"
  | "circular-pattern"
  | "path-pattern"
  | "mirror"
  | "construction-plane"
  | "construction-axis"
  | "construction-point"
  | "move-face"
  | "offset-face"
  | "replace-face"
  | "delete-face"
  | "surface-extrude"
  | "surface-revolve"
  | "surface-sweep"
  | "surface-loft"
  | "surface-patch"
  | "surface-offset"
  | "surface-trim"
  | "surface-extend"
  | "surface-stitch"
  | "surface-thicken"
  | "imported-base"
  | "custom";

export interface CadFeature {
  readonly id: FeatureId;
  readonly componentId: ComponentId;
  readonly name: string;
  readonly kind: FeatureKind;
  readonly dependencies: readonly FeatureId[];
  readonly inputs: readonly FeatureInputReference[];
  readonly parameters: readonly FeatureParameter[];
  readonly outputBodyIds: readonly BodyId[];
  readonly suppressed: boolean;
  readonly status: EvaluationStatus;
  readonly evaluationRevision: number | null;
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface CadBody {
  readonly id: BodyId;
  readonly componentId: ComponentId;
  readonly name: string;
  readonly representation: "empty" | "exact-brep" | "mesh-proxy";
  readonly geometryHandle: string | null;
  readonly generatedByFeatureId: FeatureId | null;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly suppressed: boolean;
  readonly materialId: string | null;
  readonly status: EvaluationStatus;
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface CadOccurrence {
  readonly id: OccurrenceId;
  /** Component whose assembly owns this placement. */
  readonly ownerComponentId: ComponentId;
  /** Reusable component definition placed by this occurrence. */
  readonly componentId: ComponentId;
  readonly parentOccurrenceId: OccurrenceId | null;
  readonly name: string;
  readonly transform: Transform3;
  readonly grounded: boolean;
  readonly visible: boolean;
  readonly suppressed: boolean;
}

export interface JointFrame {
  readonly occurrenceId: OccurrenceId;
  readonly geometry: TopologyReference | null;
  readonly transform: Transform3;
}

export interface JointLimits {
  readonly linearMeters: readonly [number, number] | null;
  readonly angularRadians: readonly [number, number] | null;
}

export interface CadJoint {
  readonly id: JointId;
  readonly componentId: ComponentId;
  readonly name: string;
  readonly type: "rigid" | "revolute" | "slider" | "cylindrical" | "pin-slot" | "planar" | "ball";
  readonly first: JointFrame;
  readonly second: JointFrame;
  readonly limits: JointLimits;
  readonly motionLinkJointId: JointId | null;
  readonly motionRatio: number | null;
  readonly suppressed: boolean;
  readonly status: EvaluationStatus;
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface DrawingModelAssociation {
  readonly reference: FeatureInputReference;
  readonly topologyRevision: number | null;
}

export interface CadDrawingView {
  readonly id: DrawingViewId;
  readonly kind: "base" | "projected" | "section" | "detail" | "auxiliary";
  readonly parentViewId: DrawingViewId | null;
  readonly orientation: Transform3;
  readonly scale: number;
  readonly positionMeters: Vec2;
  readonly displayStyle: "visible-edges" | "visible-hidden-edges" | "shaded";
  readonly associations: readonly DrawingModelAssociation[];
}

export interface CadDrawingAnnotation {
  readonly id: DrawingAnnotationId;
  readonly kind: "dimension" | "centerline" | "centermark" | "hole-note" | "thread-note" | "datum" | "gdt" | "balloon" | "note";
  readonly text: string;
  readonly positionMeters: Vec2;
  readonly associations: readonly DrawingModelAssociation[];
}

export interface CadDrawing {
  readonly id: DrawingId;
  readonly componentId: ComponentId;
  readonly sourceOccurrenceId: OccurrenceId | null;
  readonly name: string;
  readonly standard: "ISO" | "ASME";
  readonly sheet: "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI-A" | "ANSI-B" | "ANSI-C" | "ANSI-D" | "ANSI-E";
  readonly projection: "first-angle" | "third-angle";
  readonly views: readonly CadDrawingView[];
  readonly annotations: readonly CadDrawingAnnotation[];
  readonly status: EvaluationStatus;
  readonly modelRevision: number;
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface CadComponent {
  readonly id: ComponentId;
  readonly parentComponentId: ComponentId | null;
  readonly name: string;
  readonly description: string;
  readonly originId: OriginId;
  readonly childComponentIds: readonly ComponentId[];
  readonly sketchIds: readonly SketchId[];
  readonly bodyIds: readonly BodyId[];
  /** Ordered parametric timeline for this component. */
  readonly featureIds: readonly FeatureId[];
  readonly occurrenceIds: readonly OccurrenceId[];
  readonly jointIds: readonly JointId[];
  readonly drawingIds: readonly DrawingId[];
  /** Features after this point are rolled back. Null means the full timeline is active. */
  readonly rollbackAfterFeatureId: FeatureId | null;
  readonly visible: boolean;
  readonly suppressed: boolean;
}

export interface CadProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly description: string;
  readonly units: UnitSystem;
  readonly rootComponentId: ComponentId;
  readonly components: readonly CadComponent[];
  readonly origins: readonly CadOrigin[];
  readonly sketches: readonly CadSketch[];
  readonly bodies: readonly CadBody[];
  readonly features: readonly CadFeature[];
  readonly occurrences: readonly CadOccurrence[];
  readonly joints: readonly CadJoint[];
  readonly drawings: readonly CadDrawing[];
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface CadDocument {
  readonly format: typeof CAD_DOCUMENT_FORMAT;
  readonly schemaVersion: typeof CAD_DOCUMENT_SCHEMA_VERSION;
  readonly applicationVersion: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly lastOperationId: string;
  readonly project: CadProject;
}
