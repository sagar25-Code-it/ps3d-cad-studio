import type {
  ComponentId,
  JointId,
  OccurrenceId,
  Transform3,
  Vec3
} from "./canonical.js";

export const ASSEMBLY_SCHEMA_VERSION = 1 as const;

export type AssemblyDiagnosticSeverity = "info" | "warning" | "error";

export type AssemblyDiagnosticCode =
  | "DUPLICATE_ID"
  | "MISSING_COMPONENT"
  | "MISSING_OCCURRENCE"
  | "MISSING_JOINT_ORIGIN"
  | "MISSING_JOINT"
  | "INVALID_TRANSFORM"
  | "INVALID_AXIS"
  | "INVALID_LIMIT"
  | "INVALID_MOTION_LINK"
  | "MOTION_LINK_CYCLE"
  | "DEPENDENCY_CYCLE"
  | "RIGID_GROUP_CONFLICT"
  | "UNANCHORED_ASSEMBLY"
  | "UNSUPPORTED_JOINT_EVALUATION"
  | "COORDINATE_OUT_OF_RANGE"
  | "INCONSISTENT_LOOP"
  | "DISCONNECTED_OCCURRENCE"
  | "MISSING_ENVELOPE"
  | "INVALID_EXPLODED_REPRESENTATION"
  | "COLLISION_ADAPTER_REQUIRED"
  | "STALE_GEOMETRY_REFERENCE";

export interface AssemblyDiagnostic {
  readonly code: AssemblyDiagnosticCode;
  readonly severity: AssemblyDiagnosticSeverity;
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export type AssemblyResult<Value> =
  | { readonly ok: true; readonly value: Value; readonly diagnostics: readonly AssemblyDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly AssemblyDiagnostic[] };

/** Reusable design definition. It has no placement in an assembly by itself. */
export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly name: string;
  readonly revision: number;
}

/** A positioned instance of a reusable component definition. */
export interface AssemblyOccurrence {
  readonly id: OccurrenceId;
  readonly ownerComponentId: ComponentId;
  readonly componentDefinitionId: ComponentId;
  readonly parentOccurrenceId: OccurrenceId | null;
  readonly name: string;
  readonly initialTransform: Transform3;
  readonly grounded: boolean;
  readonly suppressed: boolean;
}

export interface RigidGroup {
  readonly id: string;
  readonly ownerComponentId: ComponentId;
  readonly occurrenceIds: readonly OccurrenceId[];
  readonly suppressed: boolean;
}

/** Optional exact-kernel association. The kinematics layer never resolves it. */
export interface JointGeometryReference {
  readonly bodyId: string;
  readonly persistentTopologyName: string;
  readonly topologyRevision: number;
}

export interface JointOrigin {
  readonly id: string;
  readonly occurrenceId: OccurrenceId;
  readonly localTransform: Transform3;
  readonly geometry: JointGeometryReference | null;
}

export interface ScalarLimit {
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly rest: number;
}

export interface JointCoordinates {
  readonly angleRadians?: number;
  readonly offsetMeters?: number;
  readonly slotPositionMeters?: number;
  readonly planarXMeters?: number;
  readonly planarYMeters?: number;
  readonly swingRadians?: number;
  readonly twistRadians?: number;
}

interface JointBase<Type extends AssemblyJointType> {
  readonly id: JointId;
  readonly ownerComponentId: ComponentId;
  readonly name: string;
  readonly type: Type;
  readonly firstOriginId: string;
  readonly secondOriginId: string;
  readonly suppressed: boolean;
}

export interface RigidJoint extends JointBase<"rigid"> {}

export interface RevoluteJoint extends JointBase<"revolute"> {
  readonly angularLimit: ScalarLimit | null;
}

export interface SliderJoint extends JointBase<"slider"> {
  readonly linearLimit: ScalarLimit | null;
}

export interface CylindricalJoint extends JointBase<"cylindrical"> {
  readonly angularLimit: ScalarLimit | null;
  readonly linearLimit: ScalarLimit | null;
}

export interface PinSlotJoint extends JointBase<"pin-slot"> {
  readonly slotLimit: ScalarLimit | null;
  readonly angularLimit: ScalarLimit | null;
}

export interface PlanarJoint extends JointBase<"planar"> {
  readonly xLimit: ScalarLimit | null;
  readonly yLimit: ScalarLimit | null;
  readonly angularLimit: ScalarLimit | null;
}

export interface BallJoint extends JointBase<"ball"> {
  readonly swingLimit: ScalarLimit | null;
  readonly twistLimit: ScalarLimit | null;
}

export type AssemblyJointType =
  | "rigid"
  | "revolute"
  | "slider"
  | "cylindrical"
  | "pin-slot"
  | "planar"
  | "ball";

export type AssemblyJoint =
  | RigidJoint
  | RevoluteJoint
  | SliderJoint
  | CylindricalJoint
  | PinSlotJoint
  | PlanarJoint
  | BallJoint;

export type MotionCoordinate =
  | "angleRadians"
  | "offsetMeters"
  | "slotPositionMeters"
  | "planarXMeters"
  | "planarYMeters"
  | "swingRadians"
  | "twistRadians";

/** target = source * ratio + offset, evaluated before joint propagation. */
export interface MotionLink {
  readonly id: string;
  readonly sourceJointId: JointId;
  readonly sourceCoordinate: MotionCoordinate;
  readonly targetJointId: JointId;
  readonly targetCoordinate: MotionCoordinate;
  readonly ratio: number;
  readonly offset: number;
  readonly enabled: boolean;
}

export interface AssemblyDefinition {
  readonly schemaVersion: typeof ASSEMBLY_SCHEMA_VERSION;
  readonly rootComponentId: ComponentId;
  readonly components: readonly ComponentDefinition[];
  readonly occurrences: readonly AssemblyOccurrence[];
  readonly rigidGroups: readonly RigidGroup[];
  readonly jointOrigins: readonly JointOrigin[];
  readonly joints: readonly AssemblyJoint[];
  readonly motionLinks: readonly MotionLink[];
}

export interface JointCoordinateInput {
  readonly jointId: JointId;
  readonly coordinates: JointCoordinates;
}

export interface AssemblyEvaluationRequest {
  readonly assembly: AssemblyDefinition;
  readonly coordinates: readonly JointCoordinateInput[];
  readonly tolerance: {
    readonly translationMeters: number;
    readonly rotationRadians: number;
  };
}

export interface AssemblyEvaluation {
  readonly occurrenceTransforms: Readonly<Record<string, Transform3>>;
  readonly resolvedCoordinates: Readonly<Record<string, JointCoordinates>>;
  readonly dependencyOrder: readonly OccurrenceId[];
  readonly diagnostics: readonly AssemblyDiagnostic[];
}

export interface AssemblyDependencyGraph {
  readonly occurrenceIds: readonly OccurrenceId[];
  readonly edges: readonly {
    readonly jointId: JointId | null;
    readonly firstOccurrenceId: OccurrenceId;
    readonly secondOccurrenceId: OccurrenceId;
    readonly kind: AssemblyJointType | "rigid-group";
  }[];
  readonly connectedComponents: readonly (readonly OccurrenceId[])[];
  readonly cycleJointIds: readonly JointId[];
}

export interface DofBreakdown {
  readonly freeBodyDof: number;
  readonly groundedReduction: number;
  readonly rigidGroupReduction: number;
  readonly jointConstraintReduction: number;
  readonly residualDof: number;
  readonly jointDof: Readonly<Record<string, number>>;
  readonly diagnostics: readonly AssemblyDiagnostic[];
}

export interface AssemblyEnvelope {
  readonly dimensionsMeters: Vec3;
}

export interface ExplodedStep {
  readonly occurrenceId: OccurrenceId;
  readonly direction: Vec3;
  readonly requestedDistanceMeters: number;
  readonly startFraction: number;
  readonly endFraction: number;
}

export interface ExplodedRepresentation {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly ExplodedStep[];
  /** Maximum displacement as a fraction of the largest supplied envelope dimension. */
  readonly maximumEnvelopeFraction: number;
}

export interface ExplodedInterpolation {
  readonly fraction: number;
  readonly transforms: Readonly<Record<string, Transform3>>;
  readonly appliedDistancesMeters: Readonly<Record<string, number>>;
}

export interface QualifiedGeometryHandle {
  readonly occurrenceId: OccurrenceId;
  readonly geometryHandle: string;
  readonly geometryRevision: number;
  readonly transform: Transform3;
}

export interface OccurrencePair {
  readonly firstOccurrenceId: OccurrenceId;
  readonly secondOccurrenceId: OccurrenceId;
}

export interface InterferenceAnalysisRequest {
  readonly requestId: string;
  readonly geometry: readonly QualifiedGeometryHandle[];
  readonly pairs: readonly OccurrencePair[];
  readonly toleranceMeters: number;
}

export interface ClearanceAnalysisRequest extends InterferenceAnalysisRequest {
  readonly requiredClearanceMeters: number;
}

export interface InterferenceFinding {
  readonly pair: OccurrencePair;
  readonly volumeCubicMeters: number;
  readonly evidenceHandle: string;
}

export interface ClearanceFinding {
  readonly pair: OccurrencePair;
  readonly minimumDistanceMeters: number;
  readonly firstClosestPointMeters: Vec3;
  readonly secondClosestPointMeters: Vec3;
  readonly evidenceHandle: string;
}

export interface CollisionAnalysisAdapter {
  readonly adapterId: string;
  analyzeInterference(request: InterferenceAnalysisRequest): Promise<AssemblyResult<readonly InterferenceFinding[]>>;
  analyzeClearance(request: ClearanceAnalysisRequest): Promise<AssemblyResult<readonly ClearanceFinding[]>>;
}
