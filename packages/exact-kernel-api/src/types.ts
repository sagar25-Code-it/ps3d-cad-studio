export const EXACT_KERNEL_PROTOCOL_VERSION = 1 as const;
export const EXACT_KERNEL_CANONICAL_LENGTH_UNIT = "m" as const;
export const EXACT_KERNEL_CANONICAL_ANGLE_UNIT = "rad" as const;

export type ExactKernelProtocolVersion = typeof EXACT_KERNEL_PROTOCOL_VERSION;
export type KernelExecutionTarget = "wasm-worker" | "native-worker" | "recorded-reference";
export type KernelTopologyKind = "vertex" | "edge" | "wire" | "face" | "shell" | "solid" | "compsolid" | "compound";
export type KernelShapeKind = "wire" | "face" | "shell" | "solid" | "compsolid" | "compound";
export type KernelBooleanMode = "join" | "cut" | "intersect";
export type SurfaceContinuity = "g0" | "g1" | "g2";
export type NeutralCadFormat = "step" | "iges" | "brep";
export type MeshExchangeFormat = "stl" | "obj" | "3mf";
export type Vector3 = readonly [number, number, number];
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export interface KernelIdentity {
  readonly implementation: string;
  readonly implementationVersion: string;
  readonly kernel: string;
  readonly kernelVersion: string;
  readonly buildId: string;
  readonly executionTarget: KernelExecutionTarget;
  readonly contractVersion: ExactKernelProtocolVersion;
}

export interface KernelResourceLimits {
  readonly maximumInputShapes: number;
  readonly maximumOutputShapes: number;
  readonly maximumTopologyEntities: number;
  readonly maximumExchangeBytes: number;
  readonly maximumOperationMilliseconds: number;
}

export const EXACT_KERNEL_OPERATION_KINDS = [
  "primitive.box", "primitive.cylinder", "primitive.cone", "primitive.sphere", "primitive.torus",
  "solid.extrude", "solid.revolve", "solid.sweep", "solid.loft", "solid.boolean", "solid.hole",
  "solid.thread", "solid.fillet", "solid.chamfer", "solid.draft", "solid.shell", "solid.rib",
  "solid.thin-extrude", "solid.pattern-linear", "solid.pattern-circular", "solid.pattern-path",
  "solid.mirror", "direct.move-face", "direct.offset-face", "direct.replace-face", "direct.delete-face",
  "surface.extrude", "surface.revolve", "surface.sweep", "surface.loft", "surface.patch",
  "surface.offset", "surface.trim", "surface.extend", "surface.stitch", "surface.thicken",
  "construct.plane", "construct.axis", "construct.point", "shape.heal", "shape.validate",
  "topology.describe", "exchange.import", "exchange.export", "display.tessellate"
] as const;

export type ExactKernelOperationKind = typeof EXACT_KERNEL_OPERATION_KINDS[number];

export interface ExactKernelCapabilities {
  readonly capabilityVersion: string;
  readonly supportedOperations: readonly ExactKernelOperationKind[];
  readonly importFormats: readonly NeutralCadFormat[];
  readonly exportFormats: readonly (NeutralCadFormat | MeshExchangeFormat)[];
  readonly supportedContinuity: readonly SurfaceContinuity[];
  readonly canonicalLengthUnit: typeof EXACT_KERNEL_CANONICAL_LENGTH_UNIT;
  readonly canonicalAngleUnit: typeof EXACT_KERNEL_CANONICAL_ANGLE_UNIT;
  readonly minimumLinearToleranceMeters: number;
  readonly maximumLinearToleranceMeters: number;
  readonly minimumAngularToleranceRadians: number;
  readonly deterministicForIdenticalBuildAndInputs: boolean;
  readonly supportsPersistentSessions: boolean;
  readonly supportsCancellation: boolean;
  readonly resourceLimits: KernelResourceLimits;
}

export interface AxisPlacement {
  readonly origin: Vector3;
  readonly direction: Vector3;
  readonly xDirection: Vector3;
}

export interface PlanePlacement {
  readonly origin: Vector3;
  readonly normal: Vector3;
  readonly xDirection: Vector3;
}

export interface KernelBounds {
  readonly min: Vector3;
  readonly max: Vector3;
}

export interface GeometricSignature {
  readonly geometryClass: "point" | "line" | "circle" | "ellipse" | "bspline-curve" | "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline-surface" | "other";
  readonly centroidMeters: Vector3;
  readonly measure: number;
  readonly boundsMeters: KernelBounds;
  readonly orientationHint?: Vector3;
  readonly analyticParameters?: Readonly<Record<string, number>>;
  readonly signatureDigest: string;
}

export interface TopologyProducer {
  readonly operationId: string;
  readonly operationKind: ExactKernelOperationKind;
  readonly outputIndex: number;
  readonly role: string;
}

export interface TopologyAncestry {
  readonly sourceShapeDigest: string;
  readonly sourceReferenceKeys: readonly string[];
  readonly relation: "generated-from" | "modified-from" | "preserved-from" | "intersection-of" | "unknown";
}

export interface StableTopologyReference {
  readonly referenceVersion: 1;
  readonly key: string;
  readonly semanticId: string;
  readonly expectedKind: KernelTopologyKind;
  readonly producer: TopologyProducer;
  readonly ancestry: readonly TopologyAncestry[];
  readonly signature: GeometricSignature;
  readonly lineageDigest: string;
}

export interface ResolvedTopologyEntity {
  readonly entityId: string;
  readonly kind: KernelTopologyKind;
  readonly stableReference: StableTopologyReference;
  readonly orientation: "forward" | "reversed" | "internal" | "external";
  readonly toleranceMeters: number;
  readonly adjacentReferenceKeys: readonly string[];
}

export interface KernelTopologySummary {
  readonly vertices: number;
  readonly edges: number;
  readonly wires: number;
  readonly faces: number;
  readonly shells: number;
  readonly solids: number;
  readonly components: number;
  readonly closed: boolean;
  readonly manifold: boolean;
}

export interface ExactShapeHandle {
  readonly shapeId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly kind: KernelShapeKind;
  readonly representation: "exact-brep";
  readonly contentDigest: string;
  readonly toleranceMeters: number;
  readonly boundsMeters: KernelBounds;
  readonly topology: KernelTopologySummary;
}

export interface ShapeReference {
  readonly shape: ExactShapeHandle;
  readonly transform?: Matrix4;
}

export interface TopologySelection {
  readonly shape: ExactShapeHandle;
  readonly reference: StableTopologyReference;
}

export type KernelDiagnosticCode =
  | "INVALID_REQUEST"
  | "PROTOCOL_MISMATCH"
  | "CAPABILITY_UNAVAILABLE"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "TIMEOUT"
  | "SESSION_NOT_FOUND"
  | "SHAPE_NOT_FOUND"
  | "STALE_SHAPE_HANDLE"
  | "TOPOLOGY_REFERENCE_NOT_FOUND"
  | "TOPOLOGY_REFERENCE_AMBIGUOUS"
  | "INVALID_GEOMETRY"
  | "DEGENERATE_GEOMETRY"
  | "SELF_INTERSECTION"
  | "NON_MANIFOLD_RESULT"
  | "OPEN_SHELL"
  | "BOOLEAN_FAILED"
  | "HEALING_INCOMPLETE"
  | "IMPORT_FAILED"
  | "EXPORT_FAILED"
  | "UNSUPPORTED_FORMAT"
  | "KERNEL_FAILURE"
  | "FIXTURE_MISSING"
  | "FIXTURE_INVALID";

export interface KernelDiagnostic {
  readonly code: KernelDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relatedSemanticIds: readonly string[];
  readonly relatedReferenceKeys: readonly string[];
  readonly recovery: string;
  readonly kernelDetails?: Readonly<Record<string, string | number | boolean>>;
}

export interface ShapeValidationReport {
  readonly valid: boolean;
  readonly exact: true;
  readonly checkedToleranceMeters: number;
  readonly closed: boolean;
  readonly manifold: boolean;
  readonly orientable: boolean;
  readonly finite: boolean;
  readonly selfIntersections: number;
  readonly invalidEntityReferenceKeys: readonly string[];
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface ShapeProvenance {
  readonly operationId: string;
  readonly operationKind: ExactKernelOperationKind;
  readonly inputShapeDigests: readonly string[];
  readonly outputShapeDigests: readonly string[];
  readonly topologyEntities: readonly ResolvedTopologyEntity[];
  readonly provenanceDigest: string;
}

export interface KernelOperationReceipt {
  readonly protocolVersion: ExactKernelProtocolVersion;
  readonly requestDigest: string;
  readonly resultDigest: string;
  readonly kernel: KernelIdentity;
  readonly capabilityVersion: string;
  readonly operationId: string;
  readonly operationKind: ExactKernelOperationKind;
  readonly inputShapeDigests: readonly string[];
  readonly outputShapeDigests: readonly string[];
  readonly deterministic: boolean;
}

export interface ExactKernelOperationResult {
  readonly operationId: string;
  readonly operationKind: ExactKernelOperationKind;
  readonly outputs: readonly ExactShapeHandle[];
  readonly validation: readonly ShapeValidationReport[];
  readonly provenance: ShapeProvenance;
  readonly diagnostics: readonly KernelDiagnostic[];
  readonly receipt: KernelOperationReceipt;
}

export interface KernelExchangeArtifact {
  readonly format: NeutralCadFormat | MeshExchangeFormat;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
  readonly contentDigest: string;
  readonly sourceShapeDigests: readonly string[];
}

export interface TessellationResult {
  readonly sourceShapeDigest: string;
  readonly linearDeflectionMeters: number;
  readonly angularDeflectionRadians: number;
  readonly positions: Float64Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleFaceReferenceKeys: readonly string[];
  readonly contentDigest: string;
}
