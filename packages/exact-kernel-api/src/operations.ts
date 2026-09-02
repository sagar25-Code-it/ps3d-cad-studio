import type {
  AxisPlacement,
  ExactKernelOperationKind,
  ExactShapeHandle,
  KernelBooleanMode,
  Matrix4,
  MeshExchangeFormat,
  NeutralCadFormat,
  PlanePlacement,
  ShapeReference,
  StableTopologyReference,
  SurfaceContinuity,
  TopologySelection,
  Vector3
} from "./types.js";

export type ExactKernelOperation =
  | PrimitiveOperation
  | ExtrudeOperation
  | RevolveOperation
  | SweepOperation
  | LoftOperation
  | BooleanOperation
  | HoleOperation
  | ThreadOperation
  | FilletOperation
  | ChamferOperation
  | DraftOperation
  | ShellOperation
  | RibOperation
  | ThinExtrudeOperation
  | PatternOperation
  | MirrorOperation
  | DirectFaceOperation
  | SurfaceOperation
  | ConstructionOperation
  | HealOperation
  | ValidateOperation
  | DescribeTopologyOperation
  | ImportOperation
  | ExportOperation
  | TessellateOperation;

export interface OperationBase<K extends ExactKernelOperationKind> {
  readonly operationId: string;
  readonly kind: K;
  readonly semanticOutputIds: readonly string[];
  readonly linearToleranceMeters: number;
  readonly angularToleranceRadians: number;
  readonly expectedOutputCount: number;
}

export interface PrimitiveBoxOperation extends OperationBase<"primitive.box"> {
  readonly sizeMeters: Vector3;
  readonly placement: PlanePlacement;
}

export interface PrimitiveCylinderOperation extends OperationBase<"primitive.cylinder"> {
  readonly radiusMeters: number;
  readonly heightMeters: number;
  readonly placement: AxisPlacement;
}

export interface PrimitiveConeOperation extends OperationBase<"primitive.cone"> {
  readonly startRadiusMeters: number;
  readonly endRadiusMeters: number;
  readonly heightMeters: number;
  readonly placement: AxisPlacement;
}

export interface PrimitiveSphereOperation extends OperationBase<"primitive.sphere"> {
  readonly radiusMeters: number;
  readonly centerMeters: Vector3;
}

export interface PrimitiveTorusOperation extends OperationBase<"primitive.torus"> {
  readonly majorRadiusMeters: number;
  readonly minorRadiusMeters: number;
  readonly placement: AxisPlacement;
}

export type PrimitiveOperation = PrimitiveBoxOperation | PrimitiveCylinderOperation | PrimitiveConeOperation | PrimitiveSphereOperation | PrimitiveTorusOperation;

export type FeatureOutputMode = "new-body" | "new-component" | KernelBooleanMode;

export type LinearExtent =
  | { readonly kind: "distance"; readonly distanceMeters: number; readonly symmetric: boolean }
  | { readonly kind: "two-sided"; readonly firstDistanceMeters: number; readonly secondDistanceMeters: number }
  | { readonly kind: "to-face"; readonly limit: TopologySelection; readonly offsetMeters: number }
  | { readonly kind: "through-all"; readonly direction: "positive" | "negative" | "both" };

export interface ExtrudeOperation extends OperationBase<"solid.extrude"> {
  readonly profiles: readonly ShapeReference[];
  readonly direction: Vector3;
  readonly extent: LinearExtent;
  readonly taperAngleRadians: number;
  readonly outputMode: FeatureOutputMode;
  readonly targets: readonly ShapeReference[];
}

export type AngularExtent =
  | { readonly kind: "angle"; readonly angleRadians: number; readonly symmetric: boolean }
  | { readonly kind: "full" };

export interface RevolveOperation extends OperationBase<"solid.revolve"> {
  readonly profiles: readonly ShapeReference[];
  readonly axis: AxisPlacement;
  readonly extent: AngularExtent;
  readonly outputMode: FeatureOutputMode;
  readonly targets: readonly ShapeReference[];
}

export interface SweepOperation extends OperationBase<"solid.sweep"> {
  readonly profiles: readonly ShapeReference[];
  readonly path: ShapeReference;
  readonly guideRails: readonly ShapeReference[];
  readonly orientation: "perpendicular" | "parallel" | "fixed";
  readonly twistAngleRadians: number;
  readonly scale: number;
  readonly outputMode: FeatureOutputMode;
  readonly targets: readonly ShapeReference[];
}

export interface LoftSection {
  readonly profile: ShapeReference;
  readonly continuity: SurfaceContinuity;
  readonly tangentMagnitude?: number;
}

export interface LoftOperation extends OperationBase<"solid.loft"> {
  readonly sections: readonly LoftSection[];
  readonly guideRails: readonly ShapeReference[];
  readonly centerline?: ShapeReference;
  readonly closed: boolean;
  readonly outputMode: FeatureOutputMode;
  readonly targets: readonly ShapeReference[];
}

export interface BooleanOperation extends OperationBase<"solid.boolean"> {
  readonly mode: KernelBooleanMode;
  readonly targets: readonly ShapeReference[];
  readonly tools: readonly ShapeReference[];
  readonly keepTools: boolean;
  readonly fuzzyToleranceMeters: number;
}

export type HoleTermination =
  | { readonly kind: "distance"; readonly distanceMeters: number }
  | { readonly kind: "through-all" }
  | { readonly kind: "to-face"; readonly limit: TopologySelection; readonly offsetMeters: number };

export interface HoleOperation extends OperationBase<"solid.hole"> {
  readonly target: ShapeReference;
  readonly placementFace: TopologySelection;
  readonly centersMeters: readonly Vector3[];
  readonly direction: Vector3;
  readonly diameterMeters: number;
  readonly tipAngleRadians: number;
  readonly termination: HoleTermination;
  readonly counterbore?: { readonly diameterMeters: number; readonly depthMeters: number };
  readonly countersink?: { readonly diameterMeters: number; readonly angleRadians: number };
}

export interface ThreadOperation extends OperationBase<"solid.thread"> {
  readonly target: ShapeReference;
  readonly cylindricalFaces: readonly TopologySelection[];
  readonly standard: string;
  readonly designation: string;
  readonly threadClass: string;
  readonly handedness: "right" | "left";
  readonly modeled: boolean;
  readonly fullLength: boolean;
  readonly lengthMeters: number;
  readonly offsetMeters: number;
}

export interface FilletOperation extends OperationBase<"solid.fillet"> {
  readonly target: ShapeReference;
  readonly edges: readonly TopologySelection[];
  readonly radiusMeters: number;
  readonly variableRadii?: readonly { readonly edgeReferenceKey: string; readonly normalizedPosition: number; readonly radiusMeters: number }[];
  readonly continuity: "g1" | "g2";
}

export interface ChamferOperation extends OperationBase<"solid.chamfer"> {
  readonly target: ShapeReference;
  readonly edges: readonly TopologySelection[];
  readonly definition:
    | { readonly kind: "equal-distance"; readonly distanceMeters: number }
    | { readonly kind: "two-distances"; readonly firstDistanceMeters: number; readonly secondDistanceMeters: number }
    | { readonly kind: "distance-angle"; readonly distanceMeters: number; readonly angleRadians: number };
}

export interface DraftOperation extends OperationBase<"solid.draft"> {
  readonly target: ShapeReference;
  readonly faces: readonly TopologySelection[];
  readonly neutralPlane: PlanePlacement;
  readonly pullDirection: Vector3;
  readonly angleRadians: number;
  readonly tangentPropagation: boolean;
}

export interface ShellOperation extends OperationBase<"solid.shell"> {
  readonly target: ShapeReference;
  readonly removeFaces: readonly TopologySelection[];
  readonly thicknessMeters: number;
  readonly direction: "inside" | "outside" | "symmetric";
  readonly join: "arc" | "intersection";
}

export interface RibOperation extends OperationBase<"solid.rib"> {
  readonly target: ShapeReference;
  readonly profiles: readonly ShapeReference[];
  readonly thicknessMeters: number;
  readonly thicknessSide: "left" | "right" | "symmetric";
  readonly extent: "to-next" | "finite";
  readonly depthMeters: number;
  readonly draftAngleRadians: number;
}

export interface ThinExtrudeOperation extends OperationBase<"solid.thin-extrude"> {
  readonly profiles: readonly ShapeReference[];
  readonly direction: Vector3;
  readonly extent: LinearExtent;
  readonly wallThicknessMeters: number;
  readonly wallSide: "left" | "right" | "symmetric";
  readonly outputMode: FeatureOutputMode;
  readonly targets: readonly ShapeReference[];
}

export interface LinearPatternOperation extends OperationBase<"solid.pattern-linear"> {
  readonly seeds: readonly ShapeReference[];
  readonly direction: Vector3;
  readonly quantity: number;
  readonly spacingMeters: number;
  readonly distribution: "extent" | "spacing";
}

export interface CircularPatternOperation extends OperationBase<"solid.pattern-circular"> {
  readonly seeds: readonly ShapeReference[];
  readonly axis: AxisPlacement;
  readonly quantity: number;
  readonly totalAngleRadians: number;
  readonly symmetric: boolean;
}

export interface PathPatternOperation extends OperationBase<"solid.pattern-path"> {
  readonly seeds: readonly ShapeReference[];
  readonly path: ShapeReference;
  readonly quantity: number;
  readonly spacingMeters: number;
  readonly orientation: "identical" | "path-direction";
}

export type PatternOperation = LinearPatternOperation | CircularPatternOperation | PathPatternOperation;

export interface MirrorOperation extends OperationBase<"solid.mirror"> {
  readonly seeds: readonly ShapeReference[];
  readonly plane: PlanePlacement;
  readonly keepOriginals: boolean;
}

export type DirectFaceOperation =
  | (OperationBase<"direct.move-face"> & { readonly target: ShapeReference; readonly faces: readonly TopologySelection[]; readonly transform: Matrix4 })
  | (OperationBase<"direct.offset-face"> & { readonly target: ShapeReference; readonly faces: readonly TopologySelection[]; readonly distanceMeters: number })
  | (OperationBase<"direct.replace-face"> & { readonly target: ShapeReference; readonly faces: readonly TopologySelection[]; readonly replacement: TopologySelection; readonly extendReplacement: boolean })
  | (OperationBase<"direct.delete-face"> & { readonly target: ShapeReference; readonly faces: readonly TopologySelection[]; readonly heal: boolean });

export type SurfaceOperation =
  | (OperationBase<"surface.extrude"> & { readonly profiles: readonly ShapeReference[]; readonly direction: Vector3; readonly extent: LinearExtent })
  | (OperationBase<"surface.revolve"> & { readonly profiles: readonly ShapeReference[]; readonly axis: AxisPlacement; readonly extent: AngularExtent })
  | (OperationBase<"surface.sweep"> & { readonly profiles: readonly ShapeReference[]; readonly path: ShapeReference; readonly guideRails: readonly ShapeReference[]; readonly orientation: "perpendicular" | "parallel" | "fixed" })
  | (OperationBase<"surface.loft"> & { readonly sections: readonly LoftSection[]; readonly guideRails: readonly ShapeReference[]; readonly centerline?: ShapeReference; readonly closed: boolean })
  | (OperationBase<"surface.patch"> & { readonly boundary: readonly ShapeReference[]; readonly interiorRails: readonly ShapeReference[]; readonly continuity: SurfaceContinuity })
  | (OperationBase<"surface.offset"> & { readonly faces: readonly TopologySelection[]; readonly distanceMeters: number })
  | (OperationBase<"surface.trim"> & { readonly target: ShapeReference; readonly tools: readonly ShapeReference[]; readonly keepPointMeters: Vector3 })
  | (OperationBase<"surface.extend"> & { readonly target: ShapeReference; readonly edges: readonly TopologySelection[]; readonly distanceMeters: number; readonly mode: "natural" | "tangent" })
  | (OperationBase<"surface.stitch"> & { readonly surfaces: readonly ShapeReference[]; readonly stitchToleranceMeters: number; readonly requireClosedSolid: boolean })
  | (OperationBase<"surface.thicken"> & { readonly surfaces: readonly ShapeReference[]; readonly thicknessMeters: number; readonly direction: "one-side" | "symmetric"; readonly outputMode: FeatureOutputMode; readonly targets: readonly ShapeReference[] });

export type ConstructionOperation =
  | (OperationBase<"construct.plane"> & { readonly definition: PlanePlacement | { readonly kind: "offset"; readonly source: TopologySelection; readonly offsetMeters: number } })
  | (OperationBase<"construct.axis"> & { readonly definition: AxisPlacement | { readonly kind: "two-points"; readonly first: Vector3; readonly second: Vector3 } })
  | (OperationBase<"construct.point"> & { readonly pointMeters: Vector3 });

export interface HealOperation extends OperationBase<"shape.heal"> {
  readonly shapes: readonly ShapeReference[];
  readonly options: {
    readonly sewFaces: boolean;
    readonly fixSmallEdges: boolean;
    readonly fixWireGaps: boolean;
    readonly orientShells: boolean;
    readonly removeSlivers: boolean;
    readonly maximumToleranceMeters: number;
  };
}

export interface ValidateOperation extends OperationBase<"shape.validate"> {
  readonly shapes: readonly ShapeReference[];
  readonly checkSelfIntersections: boolean;
  readonly requireClosed: boolean;
  readonly requireManifold: boolean;
}

export interface DescribeTopologyOperation extends OperationBase<"topology.describe"> {
  readonly shape: ShapeReference;
  readonly includeKinds: readonly ("vertex" | "edge" | "wire" | "face" | "shell" | "solid")[];
  readonly includeAdjacency: boolean;
  readonly includeAnalyticGeometry: boolean;
}

export interface ImportOperation extends OperationBase<"exchange.import"> {
  readonly format: NeutralCadFormat;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly options: {
    readonly heal: boolean;
    readonly splitCompounds: boolean;
    readonly sourceLengthUnit: "m" | "mm" | "cm" | "in" | "ft" | "auto";
    readonly maximumToleranceMeters: number;
  };
}

export interface ExportOperation extends OperationBase<"exchange.export"> {
  readonly format: NeutralCadFormat | MeshExchangeFormat;
  readonly shapes: readonly ShapeReference[];
  readonly fileName: string;
  readonly options: {
    readonly schema: "ap203" | "ap214" | "ap242" | "default";
    readonly includeColors: boolean;
    readonly includeNames: boolean;
    readonly linearDeflectionMeters: number;
    readonly angularDeflectionRadians: number;
  };
}

export interface TessellateOperation extends OperationBase<"display.tessellate"> {
  readonly shape: ShapeReference;
  readonly linearDeflectionMeters: number;
  readonly angularDeflectionRadians: number;
  readonly computeNormals: boolean;
  readonly includeFaceMap: boolean;
}

export function inputShapeHandles(operation: ExactKernelOperation): readonly ExactShapeHandle[] {
  const handles: ExactShapeHandle[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (isExactShapeHandle(value)) {
      const key = `${value.sessionId}/${value.shapeId}/${value.revision}/${value.contentDigest}`;
      if (!seen.has(key)) {
        seen.add(key);
        handles.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested);
  };
  visit(operation);
  return handles;
}

function isExactShapeHandle(value: object): value is ExactShapeHandle {
  const candidate = value as Partial<ExactShapeHandle>;
  return candidate.representation === "exact-brep"
    && typeof candidate.shapeId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.contentDigest === "string";
}

export function inputTopologyReferences(operation: ExactKernelOperation): readonly StableTopologyReference[] {
  const references: StableTopologyReference[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    const candidate = value as Partial<StableTopologyReference>;
    if (candidate.referenceVersion === 1 && typeof candidate.key === "string" && typeof candidate.lineageDigest === "string") {
      if (!seen.has(candidate.key)) {
        seen.add(candidate.key);
        references.push(value as StableTopologyReference);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested);
  };
  visit(operation);
  return references;
}
