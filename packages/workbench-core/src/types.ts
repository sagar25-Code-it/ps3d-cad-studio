import type { PatternDefinition } from "./pattern.js";
import type { BodyEditSpec } from "./body-edit.js";
import type { SheetBendTable } from "./sheet-features.js";

export const WORKBENCH_FORMAT = "ps3d-workbench-project" as const;
export const WORKBENCH_SCHEMA_VERSION = 1 as const;
export const WORKBENCH_APPLICATION_VERSION = "0.2.0-preview.1" as const;
export const ELECTRICAL_SHEET_BOUNDS = { minX: 72, maxX: 1_528, minY: 135, maxY: 650 } as const;
export const ELECTRICAL_SHEET_RESERVED_REGIONS = [
  { id: "concept-bom", minX: 1_130, maxX: 1_545, minY: 72, maxY: 282 },
  { id: "erc-panel", minX: 45, maxX: 695, minY: 622, maxY: 832 },
  { id: "release-title", minX: 1_130, maxX: 1_545, minY: 640, maxY: 832 }
] as const;
export const ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT = { minX: -72, maxX: 72, minY: -58, maxY: 118 } as const;

export type WorkspaceId = "sketch" | "part" | "assembly" | "surface" | "drawing" | "electrical" | "vehicle" | "automate";
export type CapabilityLevel = "qualified" | "preview" | "unavailable";
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export function electricalComponentSheetFootprint(position: Vec2, rotationDeg = 0): { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number } {
  const radians = rotationDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxY]
  ] as const;
  const rotated = corners.map(([x, y]) => [position[0] + x * cosine - y * sine, position[1] + x * sine + y * cosine] as const);
  return {
    minX: Math.min(...rotated.map((point) => point[0])),
    maxX: Math.max(...rotated.map((point) => point[0])),
    minY: Math.min(...rotated.map((point) => point[1])),
    maxY: Math.max(...rotated.map((point) => point[1]))
  };
}

export function isElectricalSheetPositionAvailable(position: Vec2, rotationDeg = 0): boolean {
  const footprint = electricalComponentSheetFootprint(position, rotationDeg);
  return footprint.minX >= ELECTRICAL_SHEET_BOUNDS.minX && footprint.maxX <= ELECTRICAL_SHEET_BOUNDS.maxX
    && footprint.minY >= ELECTRICAL_SHEET_BOUNDS.minY && footprint.maxY <= ELECTRICAL_SHEET_BOUNDS.maxY
    && !ELECTRICAL_SHEET_RESERVED_REGIONS.some((region) => rectanglesOverlap(footprint, region));
}

export function constrainElectricalSheetPosition(position: Vec2, rotationDeg = 0): Vec2 {
  const initial = electricalComponentSheetFootprint([0, 0], rotationDeg);
  const minimumX = ELECTRICAL_SHEET_BOUNDS.minX - initial.minX;
  const maximumX = ELECTRICAL_SHEET_BOUNDS.maxX - initial.maxX;
  const minimumY = ELECTRICAL_SHEET_BOUNDS.minY - initial.minY;
  const maximumY = ELECTRICAL_SHEET_BOUNDS.maxY - initial.maxY;
  let candidate: Vec2 = [Math.min(maximumX, Math.max(minimumX, position[0])), Math.min(maximumY, Math.max(minimumY, position[1]))];
  for (let pass = 0; pass < ELECTRICAL_SHEET_RESERVED_REGIONS.length * 2; pass += 1) {
    const footprint = electricalComponentSheetFootprint(candidate, rotationDeg);
    const region = ELECTRICAL_SHEET_RESERVED_REGIONS.find((item) => rectanglesOverlap(footprint, item));
    if (region === undefined) break;
    const alternatives: readonly Vec2[] = [
      [region.minX - initial.maxX - 1, candidate[1]], [region.maxX - initial.minX + 1, candidate[1]],
      [candidate[0], region.minY - initial.maxY - 1], [candidate[0], region.maxY - initial.minY + 1]
    ];
    candidate = alternatives
      .filter((item) => item[0] >= minimumX && item[0] <= maximumX && item[1] >= minimumY && item[1] <= maximumY)
      .sort((left, right) => Math.hypot(left[0] - position[0], left[1] - position[1]) - Math.hypot(right[0] - position[0], right[1] - position[1]))[0] ?? candidate;
  }
  return candidate;
}

function rectanglesOverlap(left: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }, right: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }): boolean {
  return left.maxX >= right.minX && left.minX <= right.maxX && left.maxY >= right.minY && left.minY <= right.maxY;
}

export interface WorkbenchDiagnostic {
  readonly code:
    | "INVALID_PROJECT"
    | "INVALID_OPERATION"
    | "REVISION_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "OUTSIDE_SUPPORTED_ENVELOPE"
    | "RESOURCE_LIMIT"
    | "BROKEN_REFERENCE"
    | "CONSTRAINT_CONFLICT"
    | "DEGENERATE_GEOMETRY"
    | "UNSUPPORTED_CAPABILITY"
    | "PREVIEW_RECEIPT_MISMATCH"
    | "CONFIRMATION_REQUIRED";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export type WorkbenchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly WorkbenchDiagnostic[] };

export type SketchEntity =
  | {
      readonly id: string;
      readonly kind: "line";
      readonly start: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "rectangle";
      readonly center: Vec2;
      readonly widthMm: number;
      readonly heightMm: number;
      readonly rotationDeg: number;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "circle";
      readonly center: Vec2;
      readonly radiusMm: number;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "ellipse";
      readonly center: Vec2;
      readonly majorRadiusMm: number;
      readonly minorRadiusMm: number;
      /** Orientation of the major axis in degrees from +X, CCW. */
      readonly rotationDeg: number;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "arc";
      readonly start: Vec2;
      readonly mid: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "point";
      readonly point: Vec2;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "spline";
      /** Fit points the smooth curve passes through (3 to 24). */
      readonly fitPoints: readonly Vec2[];
      readonly construction: boolean;
      readonly visible?: boolean;
    };

export type SketchConstraintKind =
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "collinear"
  | "midpoint"
  | "symmetry"
  | "coincident"
  | "concentric"
  | "equal"
  | "radius"
  | "distance"
  | "fixed"
  | "angle"
  | "arc-length"
  | "perimeter"
  | "smooth"
  | "pierce"
  | "refraction";

/** Which defining point of an entity a point-level relation (Coincident, Midpoint) refers to. */
export const SKETCH_POINT_REFS = ["start", "end", "mid", "center", "self"] as const;
export type SketchPointRef = (typeof SKETCH_POINT_REFS)[number];

/** The dimensions `set-sketch-dimension` can drive or measure. */
export type SketchDimensionName = "length" | "width" | "height" | "radius" | "angle" | "arc-length" | "perimeter";

export interface WorkbenchSketchConstraint {
  readonly id: string;
  readonly kind: SketchConstraintKind;
  readonly entityIds: readonly string[];
  /**
   * Coincident and Midpoint only: the defining point each referenced entity contributes, in the same order as
   * `entityIds` (a Midpoint names only the point's owner; its second entity is the whole line).
   */
  readonly points?: readonly SketchPointRef[];
  readonly valueMm?: number;
  readonly dimension?: "length" | "width" | "height" | "radius";
  /**
   * Angle dimension only: the angle in degrees, counter-clockwise, from the direction of `entityIds[0]` to the direction of
   * `entityIds[1]` (each line runs from its start to its end). Held by the solver unless the dimension is `driven`.
   */
  readonly valueDeg?: number;
  /**
   * A driven (reference) dimension is measured from the geometry and never moves it, so it carries no value. Any dimension kind
   * (distance, radius, angle, arc length, perimeter) can be driven.
   */
  readonly driven?: boolean;
  /** Pierce only: the construction axis or body edge chain that crosses the sketch plane at the point named by `entityIds[0]`. */
  readonly pierce?: SketchPierceReference;
  /** Refraction only: the ratio n2 / n1 of the refractive index beyond the interface line to the index before it. */
  readonly ratio?: number;
  /**
   * A dimension only: the expression that drives `valueMm` (`2 * pin_r`). `valueMm` keeps the last value the expression gave, and is
   * recomputed whenever a parameter it uses changes. Absent for a dimension typed as a plain number.
   */
  readonly expression?: string;
  /** A relaxed constraint stays recorded but is ignored by the solver and the degree-of-freedom estimate. */
  readonly suppressed?: boolean;
}

/** What a Pierce constraint holds its point to: a construction axis, or one chain of sharp edges (by chain number) of a general body. */
export type SketchPierceReference =
  | { readonly kind: "axis"; readonly axisId: string }
  | { readonly kind: "body-edge"; readonly bodyId: string; readonly chain: number };

/** The datum planes a sketch can lie on. The plane is persisted with the sketch so it survives reload and Undo. */
export const SKETCH_DATUM_PLANES = ["datum:xy", "datum:xz", "datum:yz"] as const;
export type SketchDatumPlane = (typeof SKETCH_DATUM_PLANES)[number];

/**
 * A sketch plane turned about a world axis through the origin: the datum plane (and its offset) is built first, then rotated by
 * `angleDeg` right-handed about `axis`. This is how a sketch sits on an "angle" construction plane.
 */
export interface SketchPlaneTilt {
  readonly axis: "x" | "y" | "z";
  readonly angleDeg: number;
}

/**
 * A sketch plane given by its own frame: the sketch's (0, 0) sits at `originMm`, its X runs along `uAxis` and it rises along `normal`
 * (so its Y is `normal × uAxis`). This is how a sketch sits on a "three points" construction plane. The axes are unit length and
 * perpendicular. The sketch is built on the XY datum with no offset or tilt, then moved onto this frame.
 */
export interface SketchPlaneFrame {
  readonly originMm: Vec3;
  readonly uAxis: Vec3;
  readonly normal: Vec3;
}

export interface WorkbenchSketch {
  readonly id: "sketch:primary-profile";
  readonly name: string;
  readonly plane: SketchDatumPlane;
  /**
   * How far the sketch plane sits from its datum plane, in mm along the plane's normal (`DATUM_NORMALS`).
   * Absent means 0 (on the datum itself). Sketching on a planar face of a solid stores that face's plane this way.
   */
  readonly planeOffsetMm?: number;
  /** Absent means the sketch plane is not tilted. Solids built from the sketch are rotated by this after they are placed. */
  readonly planeTilt?: SketchPlaneTilt;
  /** Absent for a datum plane. Present only with `plane: "datum:xy"` and neither an offset nor a tilt. */
  readonly planeFrame?: SketchPlaneFrame;
  readonly gridMm: number;
  readonly snapToleranceMm: number;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

export interface PartIntent {
  readonly id: "part:mounting-plate";
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly thicknessMm: number;
  readonly holeDiameterMm: number;
  readonly edgeTreatmentMm: number;
  readonly patternCount: number;
  readonly revolveAngleDeg: number;
  /**
   * Monotonic user-requested rebuild counter for the bounded analytic feature
   * layer. Geometry is generated deterministically from the records below;
   * incrementing this value provides an explicit, auditable Update Model step.
   */
  readonly modelUpdateSerial?: number;
  /**
   * Independent editable preview bodies. These deliberately remain separate
   * from the qualified centered-bore body until an exact persistent-topology
   * kernel can evaluate their Boolean and face-level relationships.
   * Optional for backward compatibility with earlier workbench/1 documents.
   */
  readonly previewBodies?: readonly PartPreviewBody[];
  /**
   * General mesh-solid bodies from the Stage 1 Manifold evaluator (arbitrary profile extrude/
   * revolve on any datum plane). Separate from the qualified body and the analytic preview bodies.
   * Optional for backward compatibility with earlier documents.
   */
  readonly generalBodies?: readonly GeneralSolidBody[];
  /**
   * User-authored datum planes (offset, angled, three-point, midplane). Shown as translucent
   * framed quads in the 3D viewport; not yet selectable as sketch planes (that comes with the
   * next sketch-plane picker refresh). Optional for backward compatibility.
   */
  readonly construction?: readonly ConstructionPlane[];
  /**
   * User-authored construction axes. Rendered as thin cyan line segments in the 3D viewport
   * and listed in the model browser's Origin / Construction tree. Optional for backward
   * compatibility with earlier documents.
   */
  readonly constructionAxes?: readonly ConstructionAxis[];
  /**
   * User-authored construction points. Rendered as small spheres in the 3D viewport. Optional
   * for backward compatibility.
   */
  readonly constructionPoints?: readonly ConstructionPoint[];
  /**
   * User-authored user coordinate systems (UCS). A UCS stores an origin and three orthonormal basis vectors;
   * it is a named world-space frame that other features (future: a sketch plane on a UCS, a hole aligned with it)
   * can refer to. Rendered as a small tri-axis gizmo in the 3D viewport. Optional for backward compatibility.
   */
  readonly constructionUcses?: readonly ConstructionUcs[];
  /** Shape and sub-shape binders: references to a body, a face or an edge that re-resolve when the body is rebuilt. */
  readonly constructionBinders?: readonly ConstructionBinder[];
}

export type PartPreviewBodyShape = "block" | "cylinder" | "cone" | "sphere" | "torus" | "ellipsoid" | "prism" | "wedge" | "spiral" | "tube";

/** Count-like inputs of the newer primitives that are not lengths; see primitive-bodies.ts for the full sizeMm encoding. */
export interface PartPrimitiveParams {
  /** Prism: number of flat sides, 3 to 64. */
  readonly sides?: number;
  /** Spiral: number of turns, 0.5 to 20. */
  readonly turns?: number;
}

/**
 * A user-authored datum plane in the Part workspace. These sit alongside the
 * three primary datums (XY, XZ, YZ) and are shown in the 3D viewport as a
 * translucent framed quad. Each `definition` records how the plane was built
 * so the renderer can recompute origin, normal and in-plane axes from scratch
 * (a simple parametric rebuild, no persistent kernel state).
 */
export type ConstructionPlaneDefinition =
  | { readonly kind: "offset"; readonly basePlane: SketchDatumPlane; readonly offsetMm: number }
  | { readonly kind: "angle"; readonly basePlane: SketchDatumPlane; readonly axis: "x" | "y" | "z"; readonly angleDeg: number }
  | { readonly kind: "three-points"; readonly points: readonly [Vec3, Vec3, Vec3] }
  | { readonly kind: "midplane"; readonly basePlane: SketchDatumPlane; readonly fromMm: number; readonly toMm: number }
  /**
   * Tangent to a cylinder-class body (revolve / extrude general body) at a given angle around its axis. The body's
   * axis comes from its originating `feature.plane`; the origin sits on the cylinder's surface at the requested
   * angle (measured in the plane perpendicular to the axis, zero along the first perpendicular basis), and the
   * plane's normal is the outward radial direction. The plane's in-plane axes line up with the body's axis.
   */
  | { readonly kind: "tangent-to-cylinder"; readonly bodyId: string; readonly angleDeg: number }
  /**
   * Perpendicular to a construction axis, passing through a world-space point. The plane's normal is the axis's
   * direction; its in-plane axes line up with two orthonormal vectors in the plane (one chosen along world +X when that
   * is not parallel to the normal, else world +Y).
   */
  | { readonly kind: "perpendicular-to-axis"; readonly axisId: string; readonly point: Vec3 }
  /**
   * The plane that contains two straight edges. The edges must be parallel (and distinct) or cross each other; skew
   * edges, and two edges on the same line, have no such plane. Each edge may be a construction axis, a typed segment,
   * a straight edge picked on a body (re-matched to the rebuilt body by its end points) or an edge binder.
   */
  | { readonly kind: "through-two-edges"; readonly edgeA: ConstructionEdgeRef; readonly edgeB: ConstructionEdgeRef }
  /**
   * A plane at fraction `t` (0 to 1, by arc length) along a path. "perpendicular" puts the path's tangent along the plane's
   * normal (the plane cuts the path at a right angle); "tangent" makes the plane contain the tangent and the path's
   * bending direction (its osculating plane), or a world-aligned direction when the path is straight there.
   */
  | { readonly kind: "along-path"; readonly path: ConstructionPathRef; readonly t: number; readonly orientation: "perpendicular" | "tangent" };

/** A straight edge a construction plane can be built from. */
export type ConstructionEdgeRef =
  | { readonly kind: "axis"; readonly axisId: string }
  | { readonly kind: "segment"; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: "body-edge"; readonly bodyId: string; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: "binder"; readonly binderId: string };

/**
 * A path a construction plane can ride along: a construction axis (its drawn segment), or a polyline of world-space
 * points. A polyline taken from a sketch curve records where it came from and is a snapshot of the curve when it was picked.
 */
export type ConstructionPathRef =
  | { readonly kind: "axis"; readonly axisId: string }
  | { readonly kind: "polyline"; readonly pointsMm: readonly Vec3[]; readonly sketchFeatureId?: string; readonly entityId?: string };

/**
 * What a binder points at. A body binder follows a whole body by id; a face binder follows one face by the body's stable face
 * key (falling back to the recorded normal, centre and area when the key is gone); an edge binder follows a straight edge by
 * its end points. All of them re-resolve against the current mesh each time they are evaluated.
 */
export type ConstructionBinderTarget =
  | { readonly kind: "body"; readonly bodyId: string }
  | { readonly kind: "face"; readonly bodyId: string; readonly faceKey: string; readonly normal: Vec3; readonly centroidMm: Vec3; readonly areaMm2: number }
  | { readonly kind: "edge"; readonly bodyId: string; readonly a: Vec3; readonly b: Vec3 };

/** A Shape binder (whole body) or Sub-shape binder (face or edge): a named construction reference to part of a body. */
export interface ConstructionBinder {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly target: ConstructionBinderTarget;
}

export interface ConstructionPlane {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly definition: ConstructionPlaneDefinition;
}

/**
 * A user-authored construction axis. Built from any of five definitions and recomputed on demand
 * by `evaluateConstructionAxis`. Not a selectable sketch reference yet (that comes with the sketch
 * plane picker's next refresh), but listed in the model browser and rendered in the 3D viewport.
 */
export type ConstructionAxisDefinition =
  | { readonly kind: "two-points"; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: "point-and-direction"; readonly origin: Vec3; readonly direction: Vec3 }
  | { readonly kind: "plane-intersection"; readonly planeA: SketchDatumPlane; readonly planeB: SketchDatumPlane }
  | { readonly kind: "perpendicular-to-plane"; readonly plane: SketchDatumPlane; readonly point: Vec3 }
  | { readonly kind: "cylinder-axis"; readonly bodyId: string };

export interface ConstructionAxis {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly definition: ConstructionAxisDefinition;
}

/**
 * A user-authored construction point. Three modes: direct world coordinates, midpoint between
 * two points, and intersection of a construction axis with a (primary) datum plane.
 */
export type ConstructionPointDefinition =
  | { readonly kind: "xyz"; readonly position: Vec3 }
  | { readonly kind: "midpoint"; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: "axis-plane-intersection"; readonly axisId: string; readonly plane: SketchDatumPlane };

export interface ConstructionPoint {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly definition: ConstructionPointDefinition;
}

/**
 * A user-coordinate system (UCS). Stores a world-space origin plus a direction vector for the +X axis and a direction
 * for the +Y axis (the +Z axis is their cross product). The directions do not need to be normalized; the renderer and
 * evaluator normalize them and Gram-Schmidt the Y axis against the X axis. A degenerate definition (parallel axes, or
 * a zero vector) renders as a flagged node in the browser.
 */
export interface ConstructionUcs {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
}

export type PartAnalyticBodyShape = PartPreviewBodyShape | "revolved";
export type PartBodyFaceId = "x-negative" | "x-positive" | "y-negative" | "y-positive" | "z-negative" | "z-positive";
export type PartBodyEdgeTreatment = "blend" | "chamfer";
export type PartBodyFeatureKind =
  | "primitive"
  | "revolve"
  | "pattern"
  | "mirror"
  | "unite"
  | "subtract"
  | "trim"
  | "face-edit"
  | "edge-treatment"
  | "draft"
  | "shell"
  | "heal";

export interface PartBodyFeatureTrace {
  readonly kind: PartBodyFeatureKind;
  readonly operationId: string;
  readonly parentIds: readonly string[];
}

export interface PartPreviewBody {
  readonly id: string;
  readonly name: string;
  readonly shape: PartAnalyticBodyShape;
  readonly visible: boolean;
  readonly color: string;
  readonly translationMm: Vec3;
  readonly rotationDeg: Vec3;
  /**
   * Shape parameters encoded as a bounded XYZ tuple:
   * block = width/depth/height; cylinder = diameter/diameter/height;
   * cone = base diameter/top diameter/height; sphere = diameter/diameter/diameter.
   */
  readonly sizeMm: Vec3;
  /** Optional closed analytic through-bore for supported block/cylinder bodies. */
  readonly boreDiameterMm?: number;
  /** Optional supported vertical-edge treatment for analytic blocks. */
  readonly edgeTreatment?: { readonly kind: PartBodyEdgeTreatment; readonly sizeMm: number };
  /** Optional open-top wall thickness for supported block/cylinder bodies. */
  readonly shellThicknessMm?: number;
  /** Supported positive taper from the smaller lower face to the nominal upper face. */
  readonly draftAngleDeg?: number;
  /** Sweep angle for a revolved annular rectangular profile. */
  readonly revolveAngleDeg?: number;
  /** Prism side count / spiral turn count; present exactly for those two shapes. */
  readonly primitiveParams?: PartPrimitiveParams;
  /** Stable trace used by feature history, Update Model, and MCP inspection. */
  readonly featureTrace?: PartBodyFeatureTrace;
}

/**
 * A general mesh-solid body produced by the Stage 1 Manifold evaluator (arbitrary sketch
 * profile extruded/revolved on a datum plane, optionally boolean-combined). The baked closed
 * triangle mesh is stored for deterministic rendering; `feature` records the generating
 * definition for future parametric rebuild.
 */
/** Every operation that can build a general solid body from a sketch profile; the body validators accept exactly these. */
export const GENERAL_BODY_OPERATIONS = [
  "extrude", "revolve", "sweep", "loft", "edge-fillet", "edge-chamfer", "shell", "draft",
  "helix", "thread", "rib", "dome", "sheet-base", "sheet-flange", "sheet-hem"
] as const;

export interface GeneralSolidBody {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly color: string;
  /** Flat [x,y,z,...] vertex positions in millimetres; length is a multiple of 3. */
  readonly positionsMm: readonly number[];
  /** Flat triangle vertex indices; length is a multiple of 3. */
  readonly indices: readonly number[];
  readonly feature?: {
    readonly operation: (typeof GENERAL_BODY_OPERATIONS)[number];
    readonly plane: "xy" | "xz" | "yz";
    /** Extrusion height / revolve angle (degrees) / sweep distance / loft height / treatment size. */
    readonly valueMm: number;
  };
  /**
   * Exact B-rep topology and stable, lineage-anchored face names supplied by the
   * reference kernel when the body was built through it (extrude path). Absent
   * for bodies produced by the analytic fallback.
   */
  readonly brep?: {
    readonly topology: { readonly vertices: number; readonly edges: number; readonly faces: number };
    readonly faces: readonly { readonly role: string; readonly key: string; readonly areaMm2: number }[];
    /** Face index (into `faces`) for each render triangle, enabling per-face selection and highlight. */
    readonly faceTriangles: readonly number[];
    /** "kernel" for exact reference-kernel faces; "mesh-boolean" for labelled regions of a tessellated Boolean result. */
    readonly origin?: "kernel" | "mesh-boolean";
  };
}

export type MasterCartTemplateId =
  | "socket-head-cap-screw"
  | "hex-head-bolt"
  | "flat-head-socket-screw"
  | "shoulder-screw"
  | "hex-nut"
  | "flat-washer"
  | "deep-groove-ball-bearing"
  | "sleeve-bushing"
  | "flanged-bushing"
  | "spur-gear"
  | "roller-chain-sprocket"
  | "roller-chain-link"
  | "timing-belt-pulley"
  | "timing-belt-loop"
  | "o-ring"
  | "linear-bearing"
  | "linear-shaft"
  | "acme-lead-screw"
  | "shaft-collar"
  | "hydraulic-straight-fitting"
  | "hydraulic-elbow-fitting"
  | "tube-compression-union"
  | "tube-compression-elbow"
  | "hex-key"
  | "combination-wrench";

export type ComponentShape =
  | "plate"
  | "spacer"
  | "pin"
  | "cap"
  | "box"
  | "cylinder"
  | "cone"
  | "sphere"
  | "hex-prism"
  | "ring"
  | "torus"
  | "gear"
  | "mesh";

export interface MasterCartComponentTrace {
  readonly instanceId: string;
  readonly templateId: MasterCartTemplateId;
  readonly role: string;
  readonly sizeLabel: string;
  readonly materialLabel: string;
  readonly finishLabel: string;
  readonly parameterSummary: string;
  readonly provenance: "original-ps3d-parametric-preview";
}

export interface ComponentMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** Optional face index per triangle, kept so face highlighting still works on the snapshot. */
  readonly faceTriangles?: readonly number[];
}

export interface ComponentInstance {
  readonly id: string;
  readonly name: string;
  readonly shape: ComponentShape;
  readonly grounded: boolean;
  readonly visible: boolean;
  readonly color: string;
  readonly translationMm: Vec3;
  readonly rotationDeg: Vec3;
  readonly sizeMm: Vec3;
  readonly explosionDirection: Vec3;
  /** Optional radial detail used by original PS3D gear and sprocket preview meshes. */
  readonly featureCount?: number;
  /**
   * Triangle mesh for shape "mesh" (a snapshot of a Part solid, not associative), in millimetres and local
   * to the component origin (the body bounds centre). Required exactly when the shape is "mesh".
   */
  readonly mesh?: ComponentMesh;
  /** Trace for one grouped, independently generated Master Cart preview item. */
  readonly masterCart?: MasterCartComponentTrace;
  /** Present only on deterministic schematic-to-assembly package instances. */
  readonly sourceElectricalComponentId?: string;
  readonly catalogPartId?: string;
}

export interface AssemblyMate {
  readonly id: string;
  readonly name: string;
  readonly kind: "fixed" | "coincident-origin" | "aligned-axis";
  readonly componentIds: readonly string[];
  readonly axis?: "x" | "y" | "z";
  readonly status: "satisfied" | "redundant" | "conflict";
}

export interface AssemblyIntent {
  readonly id: "assembly:fixture-demo";
  readonly name: string;
  readonly explodeMm: number;
  readonly components: readonly ComponentInstance[];
  readonly mates: readonly AssemblyMate[];
  /** Optional for schema-1 compatibility. `custom` is assumed when absent. */
  readonly template?: AssemblyTemplateId;
  /** Nominal planning envelope only; never a certification or as-built record. */
  readonly nominalEnvelopeMm?: Vec3;
  readonly designStatus?: "editable-preview" | "arrangement-study" | "electromechanical-layout";
  readonly safetyNotes?: readonly string[];
  /** Traceability records for generated generic electromechanical packages. */
  readonly electricalLinks?: readonly ElectromechanicalDeviceLink[];
  /** Orthogonal planning guides only; these are not sized conductors or harnesses. */
  readonly electricalRoutes?: readonly ElectromechanicalRouteIntent[];
  readonly electromechanicalSource?: ElectromechanicalSourceRecord;
}

export type AssemblyTemplateId = "custom" | "cargo-20ft" | "cargo-40ft-hc" | "bess-20ft-hc" | "electrical-panel";

export type ElectricalStandard = "IEC" | "ANSI";
export type ElectricalTemplateId = "bess-single-line" | "dc-control" | "motor-starter";
export type ElectricalComponentKind =
  | "battery"
  | "fuse"
  | "disconnect"
  | "contactor"
  | "inverter"
  | "transformer"
  | "breaker"
  | "load"
  | "motor"
  | "ground"
  | "terminal"
  | "sensor"
  | "hvac";
export type ElectricalNetClass = "power-dc" | "power-ac" | "control" | "ground";

export interface ElectricalComponent {
  readonly id: string;
  readonly kind: ElectricalComponentKind;
  readonly reference: string;
  readonly label: string;
  readonly value: string;
  readonly position: Vec2;
  readonly rotationDeg: number;
  readonly terminals: readonly string[];
}

export interface ElectricalNetEndpoint {
  readonly componentId: string;
  readonly terminal: string;
}

export interface ElectricalNet {
  readonly id: string;
  readonly name: string;
  readonly class: ElectricalNetClass;
  readonly endpoints: readonly ElectricalNetEndpoint[];
}

export interface ElectricalIntent {
  readonly id: "electrical:main";
  readonly title: string;
  readonly standard: ElectricalStandard;
  readonly template: ElectricalTemplateId;
  readonly components: readonly ElectricalComponent[];
  readonly nets: readonly ElectricalNet[];
  readonly notes: string;
}

export type VehicleTemplateId = "ice-road-motorcycle" | "step-through-scooter" | "ev-street-motorcycle" | "delta-cargo-three-wheeler" | "tadpole-geometry-three-wheeler";
export type VehicleKind = "motorcycle" | "scooter" | "three-wheeler";
export type VehiclePowertrainKind = "ice" | "electric";
export type VehicleLayout = "single-track" | "delta-1f2r" | "tadpole-2f1r";
export type VehicleSimulationState = "full-droop" | "design-ride" | "full-bump";
export type VehicleLayerId = "skeleton" | "hardpoints" | "envelopes" | "wheels" | "chassis" | "suspension" | "steering" | "brakes" | "powertrain" | "cg-loads";
export type VehicleSide = "center" | "left" | "right";
export type VehicleGeometryStatus = "pass" | "review" | "fail";
export type VehicleFrontSuspensionTopology = "telescopic-fork" | "double-wishbone";
export type VehicleRearSuspensionTopology = "swingarm" | "unit-swing" | "trailing-arm-beam";
export type VehicleSteeringTopology = "steered-fork" | "rack-and-tie-rod";
export type VehicleFrameTopology = "diamond-cradle" | "step-through-underbone" | "cargo-twin-rail" | "reverse-trike-spaceframe";

export interface VehicleTopology {
  readonly frontSuspension: VehicleFrontSuspensionTopology;
  readonly rearSuspension: VehicleRearSuspensionTopology;
  readonly steering: VehicleSteeringTopology;
  readonly frame: VehicleFrameTopology;
  readonly frontWheelCount: 1 | 2;
  readonly rearWheelCount: 1 | 2;
  readonly drivenAxle: "front" | "rear";
}

export interface VehicleParameters {
  readonly wheelbaseM: number;
  readonly frontLoadedRadiusM: number;
  readonly rearLoadedRadiusM: number;
  readonly frontRollingRadiusM: number;
  readonly rearRollingRadiusM: number;
  readonly frontTireWidthM: number;
  readonly rearTireWidthM: number;
  readonly trackM: number;
  readonly rakeRad: number;
  readonly forkNormalOffsetM: number;
  readonly casterRad: number;
  readonly kingpinInclinationRad: number;
  readonly scrubRadiusM: number;
  readonly toeRad: number;
  readonly ackermannPercent: number;
  readonly steeringAngleRad: number;
  readonly rearSwingarmPivotFromRearM: number;
  readonly rearSwingarmPivotHeightM: number;
  readonly rearShockUpperFromRearM: number;
  readonly rearShockUpperHeightM: number;
  readonly rearShockArmRatio: number;
  readonly frontSuspensionInboardHalfTrackM: number;
  readonly frontLowerArmHeightM: number;
  readonly frontUpperArmHeightM: number;
  readonly frontTravelM: number;
  readonly rearTravelM: number;
  readonly frontSagM: number;
  readonly rearSagM: number;
  readonly frontSpringRateNPerM: number;
  readonly rearSpringRateNPerM: number;
  readonly frontMotionRatio: number;
  readonly rearMotionRatio: number;
  readonly curbMassKg: number;
  readonly riderMassKg: number;
  readonly payloadKg: number;
  readonly cgFromRearM: number;
  readonly cgHeightM: number;
  readonly targetDecelerationMps2: number;
  readonly lateralAccelerationMps2: number;
  readonly tireFrictionCoefficient: number;
  readonly frontBrakeInputForceN: number;
  readonly rearBrakeInputForceN: number;
  readonly frontBrakeLeverRatio: number;
  readonly rearBrakeLeverRatio: number;
  readonly frontMasterCylinderDiameterM: number;
  readonly rearMasterCylinderDiameterM: number;
  readonly frontEquivalentClampAreaM2: number;
  readonly rearEquivalentClampAreaM2: number;
  readonly frontDiscCount: number;
  readonly rearDiscCount: number;
  readonly frontDiscEffectiveRadiusM: number;
  readonly rearDiscEffectiveRadiusM: number;
  readonly frontPadFrictionCoefficient: number;
  readonly rearPadFrictionCoefficient: number;
  readonly frontBrakeEfficiency: number;
  readonly rearBrakeEfficiency: number;
  readonly frontRatedPressurePa: number;
  readonly rearRatedPressurePa: number;
  readonly speedMps: number;
  readonly reactionTimeS: number;
  readonly gradeRad: number;
  readonly driveTorqueNm: number;
  readonly finalDriveRatio: number;
  readonly drivelineEfficiency: number;
  readonly rollingResistanceCoefficient: number;
  readonly dragCoefficient: number;
  readonly frontalAreaSquareM: number;
  readonly airDensityKgPerCubicM: number;
  readonly batteryEnergyCapacityJ: number;
  readonly usableBatteryFraction: number;
  readonly energyConsumptionJPerM: number;
}

export type VehicleParameterKey = keyof VehicleParameters;

export interface VehicleHardPoint {
  readonly id: string;
  readonly label: string;
  readonly category: "axle" | "contact" | "frame" | "suspension" | "steering" | "powertrain" | "cg";
  readonly positionM: Vec3;
  readonly side: VehicleSide;
  readonly source: "authored" | "derived";
  readonly stateDependent: boolean;
  readonly symmetryMateId?: string;
}

export interface VehicleGeometryMember {
  readonly id: string;
  readonly label: string;
  readonly layer: VehicleLayerId;
  readonly fromHardpointId: string;
  readonly toHardpointId: string;
  readonly radiusM: number;
  readonly style: "solid" | "construction";
}

export interface VehicleWheelPose {
  readonly id: string;
  readonly label: string;
  readonly axle: "front" | "rear";
  readonly side: VehicleSide;
  readonly centerHardpointId: string;
  readonly radiusM: number;
  readonly widthM: number;
  readonly steerRad: number;
  readonly camberRad: number;
}

export interface VehicleGeometryCheck {
  readonly id: string;
  readonly label: string;
  readonly status: VehicleGeometryStatus;
  readonly measured: string;
  readonly requirement: string;
}

export interface VehicleGeometryModel {
  readonly schema: "ps3d-vehicle-geometry/2";
  readonly coordinateSystem: "+X forward / +Y left / +Z up; chassis-fixed from design ride";
  readonly topology: VehicleTopology;
  readonly hardpoints: readonly VehicleHardPoint[];
  readonly members: readonly VehicleGeometryMember[];
  readonly wheels: readonly VehicleWheelPose[];
  readonly designWheelbaseM: number;
  readonly stateWheelbaseM: number;
  readonly frontTrackM: number;
  readonly rearTrackM: number;
  readonly rearSwingarmLengthM: number;
  readonly rearShockLengthM: number;
  readonly frontCamberChangeRad: number | null;
  readonly idealInnerSteerRad: number | null;
  readonly idealOuterSteerRad: number | null;
  readonly modeledInnerSteerRad: number | null;
  readonly modeledOuterSteerRad: number | null;
  readonly ackermannErrorRad: number | null;
  readonly checks: readonly VehicleGeometryCheck[];
  readonly errors: readonly string[];
}

export interface VehicleIntent {
  readonly id: "vehicle:primary";
  readonly name: string;
  readonly template: VehicleTemplateId;
  readonly kind: VehicleKind;
  readonly powertrain: VehiclePowertrainKind;
  readonly layout: VehicleLayout;
  readonly state: VehicleSimulationState;
  readonly parameters: VehicleParameters;
  readonly layers: Readonly<Record<VehicleLayerId, boolean>>;
  readonly inputStatus: "illustrative-unvalidated" | "user-reviewed";
  readonly tireDataStatus: "unverified" | "supplier-reviewed";
  readonly brakeDataStatus: "unverified" | "supplier-reviewed";
  readonly notes: readonly string[];
}

export interface VehicleAnalysis {
  readonly schema: "ps3d-vehicle-analysis/2";
  readonly status: "review" | "blocked";
  readonly topology: VehicleTopology;
  readonly trailM: number | null;
  /** Null means straight-ahead steering has no finite circular turn radius. */
  readonly turningRadiusM: number | null;
  readonly stateWheelbaseM: number;
  readonly frontTrackM: number;
  readonly rearTrackM: number;
  readonly rearSwingarmLengthM: number;
  readonly rearShockLengthM: number;
  readonly frontCamberChangeRad: number | null;
  readonly idealInnerSteerRad: number | null;
  readonly idealOuterSteerRad: number | null;
  readonly modeledInnerSteerRad: number | null;
  readonly modeledOuterSteerRad: number | null;
  readonly ackermannErrorRad: number | null;
  readonly totalMassKg: number;
  readonly staticFrontLoadN: number;
  readonly staticRearLoadN: number;
  readonly brakingFrontLoadN: number;
  readonly brakingRearLoadN: number;
  readonly predictedBrakingFrontLoadN: number;
  readonly predictedBrakingRearLoadN: number;
  readonly idealFrontBrakePercent: number;
  readonly hardwareFrontBrakePercent: number;
  readonly frontLockMarginN: number;
  readonly rearLockMarginN: number;
  readonly frontWheelRateNPerM: number;
  readonly rearWheelRateNPerM: number;
  readonly frontAxleWheelRateNPerM: number;
  readonly rearAxleWheelRateNPerM: number;
  readonly frontNaturalFrequencyHz: number;
  readonly rearNaturalFrequencyHz: number;
  readonly frontHydraulicPressurePa: number;
  readonly rearHydraulicPressurePa: number;
  readonly availableFrontBrakeTorqueNm: number;
  readonly availableRearBrakeTorqueNm: number;
  readonly predictedBrakeDecelerationMps2: number;
  /** Null means utilization is undefined because the normal-force capacity is zero. */
  readonly frontCombinedTireUtilization: number | null;
  readonly rearCombinedTireUtilization: number | null;
  readonly firstBrakeLimit: "hydraulic-capacity" | "front-adhesion" | "rear-adhesion" | "wheel-lift" | "pressure-rating" | "none";
  /** Null means a moving vehicle has no finite stop under the modeled zero-deceleration state. */
  readonly brakingDistanceM: number | null;
  readonly totalStoppingDistanceM: number | null;
  readonly roadLoadN: number;
  readonly rawTractiveForceN: number;
  readonly tractiveForceN: number;
  readonly adhesionLimitedTractiveForceN: number;
  readonly wheelLiftAccelerationLimitMps2: number;
  readonly wheelSpeedRpm: number;
  readonly sourceSpeedRpm: number;
  readonly sourcePowerW: number;
  readonly firstDriveLimit: "source-input" | "adhesion" | "wheel-lift";
  readonly scenarioLongitudinalAccelerationMps2: number;
  readonly assumptionEvRangeKm: number | null;
  readonly steadyLeanAngleRad: number | null;
  readonly supportWheelLoadsN: readonly { readonly contactId: string; readonly loadN: number }[] | null;
  readonly minimumSupportLoadN: number | null;
  readonly approximateTipThresholdMps2: number | null;
  readonly hardpoints: readonly VehicleHardPoint[];
  readonly geometryChecks: readonly VehicleGeometryCheck[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
}

export const ELECTROMECHANICAL_CATALOG_REVISION = "ps3d-generic-panel/2" as const;
export type ElectromechanicalLayoutPreset = "panel-backplate" | "equipment-lineup";
export type ElectromechanicalMounting = "panel" | "din-rail" | "floor" | "field";
export type ElectricalTerminalRole = "positive" | "negative" | "line" | "load" | "ac" | "protective-earth" | "signal" | "unspecified";

export interface ElectromechanicalTerminalDefinition {
  readonly name: string;
  readonly role: ElectricalTerminalRole;
  readonly positionMm: Vec3;
  readonly direction: Vec3;
}

export interface ElectromechanicalCatalogPart {
  readonly id: string;
  readonly revision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
  readonly kind: ElectricalComponentKind;
  readonly label: string;
  readonly classification: "generic-envelope";
  readonly provenance: "original-ps3d-mit";
  readonly shape: Extract<ComponentShape, "box" | "cylinder">;
  readonly sizeMm: Vec3;
  readonly color: string;
  readonly mounting: ElectromechanicalMounting;
  readonly planningClearanceMm: Vec3;
  readonly terminals: readonly ElectromechanicalTerminalDefinition[];
}

export interface ElectromechanicalMapping {
  readonly electricalComponentId: string;
  readonly catalogPartId: string;
}

export interface ElectromechanicalDeviceLink {
  readonly electricalComponentId: string;
  readonly electricalReference: string;
  readonly assemblyComponentId: string;
  readonly catalogPartId: string;
  readonly terminalMap: readonly { readonly electricalTerminal: string; readonly catalogTerminal: string }[];
  readonly status: "mapped-generic";
}

export interface ElectromechanicalRouteIntent {
  readonly id: string;
  readonly electricalNetId: string;
  readonly name: string;
  readonly class: ElectricalNetClass;
  readonly endpoints: readonly ElectricalNetEndpoint[];
  readonly pointsMm: readonly Vec3[];
  readonly status: "routed-preview";
}

export interface ElectromechanicalSourceRecord {
  readonly catalogRevision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
  readonly electricalTitle: string;
  readonly electricalSignature: string;
  readonly sourceElectricalId?: ElectricalIntent["id"];
  readonly sourceProjectRevision?: number;
  readonly layoutPreset: ElectromechanicalLayoutPreset;
  readonly status: "current" | "stale";
}

export interface ElectromechanicalReadiness {
  readonly status: "ready" | "blocked";
  readonly mappedComponents: number;
  readonly totalComponents: number;
  readonly routableNets: number;
  readonly totalNets: number;
  readonly targetEnvelopeMm: Vec3;
  readonly blockingErrors: readonly string[];
  readonly warnings: readonly string[];
}

export interface SurfaceIntent {
  readonly id: "surface:primary";
  readonly name: string;
  readonly mode: "bezier" | "loft";
  readonly widthMm: number;
  readonly depthMm: number;
  readonly crownMm: number;
  readonly twistDeg: number;
  readonly uSegments: number;
  readonly vSegments: number;
}

export type DrawingViewPreset = "automatic-4-view" | "orthographic-3-view" | "front-only";
export type DrawingDisplayStyle = "visible-edges" | "visible-hidden-edges";
export type DrawingDraftingStandard = "ASME" | "ISO";
export type DrawingDatumScheme = "none" | "plate-3-2-1";
/** How linear dimensions are grouped on the sheet: individual callouts, chain (end-to-end), baseline (from a common origin), ordinate (coordinate readouts along one axis from a 0-datum). */
export type DrawingDimensionStyle = "individual" | "chain" | "baseline" | "ordinate";

export interface DrawingSettings {
  readonly id: "drawing:main-sheet";
  readonly title: string;
  readonly sheet: "A4" | "A3";
  readonly projection: "first-angle" | "third-angle";
  readonly scale: 1 | 2 | 5;
  readonly showDimensions: boolean;
  readonly notes: string;
  /** Optional for schema-1 compatibility. Missing values use the drawing generator defaults. */
  readonly viewPreset?: DrawingViewPreset;
  /** Drawing view edge style. Projected hidden edges are never inferred from this flag elsewhere. */
  readonly displayStyle?: DrawingDisplayStyle;
  /** Generates a model-derived full section through the centered bore. */
  readonly showSectionView?: boolean;
  /** Drafting basis used for projection defaults and sheet annotation vocabulary. */
  readonly draftingStandard?: DrawingDraftingStandard;
  /** Enables explicitly configured datum labels and feature-control frames. */
  readonly showGdt?: boolean;
  /** Explicit datum reference frame template. `none` never invents datum references. */
  readonly datumScheme?: DrawingDatumScheme;
  /** Linear-dimension grouping style. Omitted (or "individual") keeps the single-callout default. */
  readonly dimensionStyle?: DrawingDimensionStyle;
  /** Explicit GD&T values. They are intentionally independent of the general tolerance. */
  readonly gdtPositionToleranceMm?: number;
  readonly gdtFlatnessToleranceMm?: number;
  readonly gdtPerpendicularityToleranceMm?: number;
  /** User-defined general tolerance applied only where no individual tolerance is shown. */
  readonly generalToleranceLinearMm?: number;
  readonly generalToleranceAngularDeg?: number;
  /** Editable title-block identity and sign-off. Missing values fall back to generator defaults. */
  readonly drawingNumber?: string;
  readonly revisionTag?: string;
  readonly drawnBy?: string;
  readonly checkedBy?: string;
  readonly approvedBy?: string;
  readonly organization?: string;
}

export interface OperationAuditEntry {
  readonly revision: number;
  readonly operationId: string;
  readonly kind: WorkbenchOperation["kind"];
  readonly intentKey: string;
  readonly summary: string;
  readonly changedIds: readonly string[];
}

/** What a parametric history step is. Sketches keep a snapshot of the sketch; solids are rebuilt from a sketch feature. */
interface DesignFeatureBase {
  readonly id: string;
  readonly name: string;
  /** A suppressed feature is skipped (its solid is hidden) without being deleted. */
  readonly suppressed: boolean;
  /** Present only when the last rebuild of this feature failed; says why, so the timeline can flag it. */
  readonly health?: { readonly message: string };
}

export interface DesignSketchFeature extends DesignFeatureBase {
  readonly kind: "sketch";
  /** The sketch as it was when it was finished, including its plane. Editing a sketch replaces this snapshot. */
  readonly sketch: WorkbenchSketch;
}

/**
 * What a "to" termination reaches: a face, a whole body or a vertex of a body. The geometry is looked up again at every
 * rebuild, so the extrusion follows the target when it moves. The stored point (and face direction) is the fallback that
 * finds the target again when the face name no longer exists, and the feature's own `valueMm` is the last-resort distance.
 */
export interface DesignExtentTarget {
  readonly kind: "face" | "body" | "vertex";
  /** The body the target belongs to. It may be the body the feature itself modifies. */
  readonly bodyId: string;
  /** Face target: the face's stable role name in the body's B-rep. */
  readonly faceRole?: string;
  /** Face target: a point on the face when it was picked. Vertex target: the vertex position. Body target: where it was picked. */
  readonly pointMm?: readonly [number, number, number];
  /** Face target: the face's outward direction when it was picked (unit vector). */
  readonly normal?: readonly [number, number, number];
}

/** One edge run picked for an edge-blend step: its segments in order along the run (end points, millimetres), and what finds the same physical edge again after a rebuild. */
export interface EdgeBlendGroup {
  readonly segments: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[];
  /** The keys of the two faces beside the edge, from the body's B-rep when it had one. They survive edits that move the edge. */
  readonly faceKeys?: readonly [string, string];
  /** An inside corner: the blend adds material instead of removing it. */
  readonly concave?: boolean;
}

export interface DesignSolidFeature extends DesignFeatureBase {
  readonly kind: "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "move-body" | "scale-body" | "move-face" | "offset-face" | "helix" | "thread" | "rib" | "dome" | "emboss" | "indent" | "sheet-base" | "sheet-flange" | "sheet-hem" | "sheet-edge-flange" | "hole" | "pattern" | "edge-blend" | "offset-region" | "replace-face" | "web" | "wrap" | "flex" | "sheet-jog" | "sheet-lofted-bend";
  /**
   * A step that reshapes an existing body by picked faces or a transform (a general shell or draft, offset region, replace face,
   * a rib / web, wrap or flex). Always paired with `operation: "direct-edit"`; see `BodyEditSpec`.
   */
  readonly bodyEdit?: BodyEditSpec;
  /** The sketch feature whose closed profiles this feature turns into a solid. */
  readonly sketchFeatureId: string;
  /** Profiles to use, by their stable IDs; empty means the outermost profile with the profiles inside it as holes. */
  readonly profileIds: readonly string[];
  /** Extrusion distance in mm, or revolve angle in degrees, or sweep distance along direction, or loft bottom-to-top distance. For modifier kinds (edge-fillet/chamfer/shell/draft) this is the treatment's size (radius/distance/thickness/angle). */
  readonly valueMm: number;
  /**
   * Extrude and revolve: which way from the sketch plane. "symmetric" straddles the plane (a revolve: half the angle each way),
   * "flipped" goes the other way, and "two-side" goes `valueMm` one way and `secondValueMm` the other.
   */
  readonly direction?: "one-side" | "symmetric" | "flipped" | "two-side";
  /** Two-side extrude (distance in mm) or revolve (angle in degrees): how far the feature goes on the second side. */
  readonly secondValueMm?: number;
  /** Revolve only: builds a wall of this thickness along the profile outline instead of a solid, which leaves the inside hollow. */
  readonly thinWallMm?: number;
  /** Revolve with a thin wall: which side of the profile outline the wall grows to. Absent means "inside". */
  readonly thinSide?: "inside" | "outside" | "center";
  /** What the "to" extents reach. Present exactly when `extent` is one of the "to" values. */
  readonly extentTarget?: DesignExtentTarget;
  /**
   * What the feature does with the solid it builds. Absent (or "new-body") makes a body of its own. A "join" or "cut"
   * adds to or removes from the body named by `bodyId`, which an earlier new-body step made, and replays in timeline order.
   * "direct-edit" is for the synchronous direct-edit kinds (move-body, scale-body) which transform the target body in
   * place without building a tool solid. Modifier kinds (edge-fillet/chamfer/shell/draft) always modify the target body in
   * place; this field is left absent for them.
   */
  readonly operation?: "new-body" | "join" | "cut" | "direct-edit";
  /**
   * How far the feature reaches. Absent (or "distance") uses `valueMm`; "through-all" (an extruded cut) ignores the distance and
   * cuts through the whole body on both sides of the sketch plane, however the body later changes size. The "to" extents
   * measure the distance from `extentTarget` at every rebuild, so `valueMm` only keeps the last measured value as a fallback:
   * "to-face", "to-body" and "to-vertex" end an extrusion at a face, a body or a vertex; "to-first" and "to-last" revolve
   * until the profile first (or last) reaches a face.
   */
  readonly extent?: "distance" | "through-all" | "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last";
  /** The body this feature owns in `part.generalBodies` (for a join or cut: the body it modifies). */
  readonly bodyId: string;
  readonly edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number };
  /**
   * Sweep only: the direction in world space (unit vector; the builder normalizes it). The profile is translated along
   * this vector by `valueMm`. A direction parallel to the sketch plane is refused; a direction equal to the plane normal
   * is equivalent to an extrude of distance `valueMm`. Mutually exclusive with `sweepPathEntityId`.
   */
  readonly sweepDirectionMm?: readonly [number, number, number];
  /**
   * Sweep only: a sketch entity (line, arc or spline) from the same sketch whose samples the profile follows. Each
   * sample translates the profile in-plane by (sample − path_start); rings rise linearly out of the plane across the
   * whole path by `valueMm`. Mutually exclusive with `sweepDirectionMm`.
   */
  readonly sweepPathEntityId?: string;
  /** Loft only: the scale factor of the top profile relative to the base (0.1 – 10). 1 behaves like an extrude. Used only when `loftSecondaryProfileIds` is absent. */
  readonly loftTopScale?: number;
  /**
   * Loft only: profile IDs from the same sketch that drive the TOP ring (the second profile). When set, the loft
   * interpolates between the primary profile(s) at height 0 and these at height `valueMm`, with `loftContinuity`
   * controlling how the ribbon leaves each cap. When absent, the loft falls back to the `loftTopScale` form.
   */
  readonly loftSecondaryProfileIds?: readonly string[];
  /** Loft only: how the ribbon meets the caps — G0 straight, G1 tangent-smooth, G2 curvature-smooth. */
  readonly loftContinuity?: "position" | "tangent" | "curvature";
  /**
   * Loft only: a sketch entity (line / arc / spline) from the same sketch that bends the loft's ring centroids
   * away from the straight-line interpolation between the base and top centroids. The first rail sample lines up
   * with the base ring, the last with the top ring. Only valid on a two-profile loft.
   */
  readonly loftRailEntityId?: string;
  /**
   * Sweep only: total twist in degrees applied about the profile's 2D centroid across the whole sweep. At fraction
   * t along the sweep each ring is rotated by `t * twistDeg` before placement; 0 keeps the un-twisted behaviour.
   */
  readonly sweepTwistDeg?: number;
  /**
   * Sweep-along-path only: when true, each ring is reoriented so the profile sits perpendicular to the path's local
   * tangent (a Frenet-like frame). The profile's local X axis follows the path's in-plane perpendicular, the local Y
   * axis follows the plane's out-of-plane direction, and the ring normal is the path tangent. Omitted or false keeps
   * the old behaviour (every ring stays parallel to the sketch plane).
   */
  readonly sweepFrameTransport?: boolean;
  /**
   * Loft two-profile only: how strongly the G1/G2 ease curve pulls the ribbon away from the straight line. 0 reverts
   * to linear (G0) regardless of continuity, 1 (the default) is the plain G1/G2 ease, and values up to 2 over-apply
   * the ease for a punchier middle bulge. For the G0 "position" continuity this field has no effect.
   */
  readonly loftTangencyWeight?: number;
  /** Direct-edit (move-body) only: translation vector in millimetres applied to every vertex of the target body. */
  readonly moveDeltaMm?: readonly [number, number, number];
  /** Direct-edit (scale-body) only: uniform scale factor about the target body's centroid. 1 is a no-op; 0 or negative are refused. */
  readonly scaleFactor?: number;
  /**
   * Direct-edit (move-face / offset-face) only: the brep face role to drive. Move-face translates all vertices of that
   * face by `moveFaceDeltaMm`; offset-face translates them along the face's averaged normal by `offsetFaceMm`.
   */
  readonly targetFaceRole?: string;
  /** Direct-edit (move-face) only: translation vector in millimetres applied to the vertices of `targetFaceRole`. */
  readonly moveFaceDeltaMm?: readonly [number, number, number];
  /** Direct-edit (offset-face) only: signed distance in mm along the face's average normal (positive pushes the face outward). */
  readonly offsetFaceMm?: number;
  /**
   * Helix only: coil radius in millimetres (centerline radius of the swept profile's centroid about the helix axis).
   * Combined with `helixPitchMm` and `helixTurns` to size a solid coil built from the sketch profile as its section.
   */
  readonly helixRadiusMm?: number;
  /** Helix only: axial advance per turn in millimetres. Positive is required; handedness picks the direction. */
  readonly helixPitchMm?: number;
  /** Helix only: how many turns the coil winds. Positive, up to 100. */
  readonly helixTurns?: number;
  /** Helix only: coil handedness. "right" winds up with +Z as the rotation advances; "left" winds down. */
  readonly helixHandedness?: "right" | "left";
  /** Shell only: which cap face to leave open. */
  readonly shellOpenFace?: "top" | "bottom" | "none";
  /** Shell only: the wall thickness in mm (the inset the inner cavity is offset by). */
  readonly shellThicknessMm?: number;
  /** Draft only: which cap stays fixed (the opposite cap moves). */
  readonly draftNeutralFace?: "top" | "bottom";
  /** Draft only: taper angle in degrees. */
  readonly draftAngleDeg?: number;
  /** Edge-fillet only: optional end radius (makes the fillet variable-radius: start radius → end radius along the vertical edge). */
  readonly edgeEndSizeMm?: number;
  /** Thread (helical cut on a cylinder) only: pitch per turn in millimetres. */
  readonly threadPitchMm?: number;
  /** Thread only: how many turns to cut. */
  readonly threadTurns?: number;
  /** Thread only: thread cut depth in millimetres (how deep the V-groove bites into the cylinder surface). */
  readonly threadDepthMm?: number;
  /** Thread only: handedness of the thread (right/left). */
  readonly threadHandedness?: "right" | "left";
  /**
   * Rib only: thickness of the ribbon-wall swept down from the sketch line to the target body's base plane. The sketch
   * provides a single line (or a short polyline); the rib builds a thin extrusion of the chosen thickness, either
   * symmetrically about the sketch line or offset to one side.
   */
  readonly ribThicknessMm?: number;
  /** Rib only: how the thickness is distributed around the sketch line. */
  readonly ribDirection?: "symmetric" | "one-side";
  /**
   * Dome only: dome height above the target face's plane in millimetres (positive bulges outward, negative inward).
   * Combined with `targetFaceRole` to pick the face to cap.
   */
  readonly domeHeightMm?: number;
  /**
   * Emboss only: raise (positive) or depress (negative) the vertices of the target face by this distance along the
   * face's averaged normal, falling off with distance from the face centroid (a simple radial emboss pad).
   */
  readonly embossHeightMm?: number;
  /**
   * Indent only: a mesh-boolean indent of the tool body (identified by `indentToolBodyId`) into the target body.
   * The tool body is subtracted from the target to carve the indent cavity.
   */
  readonly indentToolBodyId?: string;
  /** Sheet-base / sheet-flange only: sheet thickness in millimetres. */
  readonly sheetThicknessMm?: number;
  /** Sheet-base / sheet-flange only: inner bend radius in millimetres (for the bend K-factor and flat-pattern unfold). */
  readonly sheetBendRadiusMm?: number;
  /**
   * Sheet-edge-flange only: which top-face edge of the sheet to bend the flange from. The index is into the edge list of the
   * sheet as its first step made it (`sheetFrameOf`), so it stays stable when other flanges are added later.
   */
  readonly flangeEdgeIndex?: number;
  /**
   * Sheet-edge-flange only: the gap in millimetres to leave at a corner shared with another edge flange. Each of the two flanges
   * stops half of it short of the corner; a flange end that meets no other flange is not shortened. 0 or absent means no relief.
   */
  readonly flangeReliefMm?: number;
  /**
   * Sheet-edge-flange only: makes the step a miter flange. The edges that follow `flangeEdgeIndex` along the plate's outline, in running
   * order; the flange bends along all of them with a mitre joint at every corner between two. All share this step's radius, length and angle.
   */
  readonly flangeMiterEdges?: readonly number[];
  /** Sheet-base / sheet-flange / sheet-hem / extruded plate / lofted bend: the bend table the flat pattern reads K-factors from. */
  readonly sheetBendTable?: SheetBendTable;
  /** Sheet-jog only: the plate edge the jog line runs parallel to (index as for an edge flange). */
  readonly jogEdgeIndex?: number;
  /** Sheet-jog only: distance from that edge, into the plate, to where the first bend of the jog starts (mm). */
  readonly jogPositionMm?: number;
  /** Sheet-jog only: how far the far side steps up (positive, along the sheet normal) or down (negative), in mm. */
  readonly jogOffsetMm?: number;
  /** Sheet-jog only: angle of the sloping web of the jog from the sheet, 1 to 89 degrees. */
  readonly jogAngleDeg?: number;
  /** Hole only: the shape. A tapped hole is recorded as a plain hole at its tap-drill diameter. */
  readonly holeStyle?: "simple" | "counterbore" | "countersink";
  /** Hole only: the point on the face where the hole starts, in millimetres. */
  readonly holePositionMm?: readonly [number, number, number];
  /** Hole only: the face's outward direction; the hole is drilled the opposite way. */
  readonly holeNormal?: readonly [number, number, number];
  readonly holeDiameterMm?: number;
  /** Hole only: depth of the full-diameter hole from the face; 0 means through all. */
  readonly holeDepthMm?: number;
  /** Counterbore hole only: the pocket's diameter and depth. */
  readonly holeCounterDiameterMm?: number;
  readonly holeCounterDepthMm?: number;
  /** Countersink hole only: the diameter at the face and the included cone angle. */
  readonly holeSinkDiameterMm?: number;
  readonly holeSinkAngleDeg?: number;
  /** Pattern only: the layout (rectangular, circular or mirror), what it copies and how the copies are kept. */
  readonly pattern?: PatternDefinition;
  /** Sheet-flange only: length of the flange in millimetres (how far the flange extends from the edge). */
  readonly flangeLengthMm?: number;
  /** Sheet-flange only: bend angle in degrees (90 is a right-angle flange). */
  readonly flangeAngleDeg?: number;
  /** Sheet-hem only: hem style — "closed" folds the flange back against the base, "open" leaves a gap of sheetThicknessMm. */
  readonly hemStyle?: "closed" | "open";
  /**
   * Numbers of this step that an expression drives, by field ID (`{ distance: "2 * pin_r" }`). The plain property (`valueMm` and so on) keeps
   * the last value the expression gave, so a step whose expression later fails still builds from its previous good number.
   */
  readonly expressions?: Readonly<Record<string, string>>;
  /** Edge-blend only: round the picked edges (`valueMm` is the radius) or bevel them (`valueMm` is the first distance). */
  readonly blendType?: "fillet" | "chamfer";
  /** Edge-blend only: the picked edge runs, re-found on the rebuilt body by their face keys or, without those, by position. */
  readonly blendEdges?: readonly EdgeBlendGroup[];
  /** Edge-blend fillet only: the radius at the end of each picked run, which makes the radius vary evenly from `valueMm` at its start. */
  readonly blendEndSizeMm?: number;
  /** Edge-blend chamfer only: the distance along the second face (the first face is the one pointing more toward +Z, then +Y, then +X). */
  readonly blendSecondSizeMm?: number;
  /** Edge-blend chamfer only: the angle the bevel makes with the first face, instead of a second distance. */
  readonly blendAngleDeg?: number;
  /** Edge-blend chamfer only: give `valueMm` to the second face instead of the first. */
  readonly blendFlip?: boolean;
}

export type DesignFeature = DesignSketchFeature | DesignSolidFeature;

/**
 * A named, project-wide value that features and sketch dimensions can use in expressions. `unit` says what the value is: "mm" for a length,
 * "deg" for an angle, "" for a plain number; a bare number in the expression takes that unit.
 */
export interface DesignParameter {
  readonly name: string;
  readonly expression: string;
  readonly unit: "mm" | "deg" | "";
  readonly comment: string;
}

/** The parametric history (timeline). Optional so projects saved before it existed still load unchanged. */
export interface DesignHistory {
  readonly features: readonly DesignFeature[];
  /** The user parameter table (Change Parameters). Absent until the first parameter is added. */
  readonly parameters?: readonly DesignParameter[];
  /** How many features are active: the rollback marker sits after this many. `features.length` means no rollback. */
  readonly rollbackIndex: number;
  /** The sketch feature the working sketch was opened from, or null for a sketch that has not been finished yet. */
  readonly editingSketchId: string | null;
}

export interface WorkbenchProject {
  readonly format: typeof WORKBENCH_FORMAT;
  readonly schemaVersion: typeof WORKBENCH_SCHEMA_VERSION;
  readonly applicationVersion: string;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly unit: "mm";
  readonly activeWorkspace: WorkspaceId;
  readonly sketch: WorkbenchSketch;
  readonly part: PartIntent;
  readonly assembly: AssemblyIntent;
  readonly surface: SurfaceIntent;
  readonly drawing: DrawingSettings;
  readonly electrical: ElectricalIntent;
  readonly vehicle: VehicleIntent;
  readonly design?: DesignHistory;
  readonly audit: readonly OperationAuditEntry[];
}

interface OperationEnvelope {
  readonly operationId: string;
  readonly expectedRevision: number;
}

export type WorkbenchOperation = OperationEnvelope & (
  | { readonly kind: "select-workspace"; readonly workspace: WorkspaceId }
  | { readonly kind: "add-sketch-entity"; readonly entity: SketchEntity }
  | { readonly kind: "delete-sketch-entity"; readonly entityId: string }
  | { readonly kind: "add-sketch-constraint"; readonly constraint: WorkbenchSketchConstraint }
  | { readonly kind: "delete-sketch-constraint"; readonly constraintId: string }
  | {
      readonly kind: "set-sketch-dimension";
      readonly entityId: string;
      readonly dimension: SketchDimensionName;
      /** Millimetres, or degrees for an angle dimension. Ignored (the measured value is kept) when `driven`. */
      readonly valueMm: number;
      /** Angle dimension only: the second line. The angle runs from `entityId` to this line. */
      readonly secondEntityId?: string;
      /** Make or keep this dimension a driven (reference) one: it is measured, never enforced. */
      readonly driven?: boolean;
      /** With `expression`, the dimension is bound to it and the evaluated expression wins over `valueMm`. */
      readonly expression?: string;
    }
  | { readonly kind: "toggle-sketch-construction"; readonly entityId: string }
  | { readonly kind: "toggle-sketch-entity-visibility"; readonly entityId: string }
  | {
      /** Atomic sketch edit: remove entities (and their relations), replace others by ID, add entities and relations. */
      readonly kind: "apply-sketch-edit";
      readonly removeEntityIds: readonly string[];
      readonly updateEntities: readonly SketchEntity[];
      readonly addEntities: readonly SketchEntity[];
      readonly addConstraints: readonly WorkbenchSketchConstraint[];
      /** Constraints to delete by ID, so an edit can re-point or drop relations that no longer hold. Absent means none. */
      readonly removeConstraintIds?: readonly string[];
      readonly label: string;
    }
  | { readonly kind: "set-sketch-constraints-suppressed"; readonly constraintIds: readonly string[]; readonly suppressed: boolean }
  | { readonly kind: "set-sketch-plane"; readonly plane: SketchDatumPlane; readonly offsetMm?: number; readonly tilt?: SketchPlaneTilt; readonly frame?: SketchPlaneFrame }
  /** Finishes the working sketch into the timeline: a new sketch feature, or an update of the one being edited. */
  | { readonly kind: "commit-design-sketch"; readonly featureId: string; readonly name: string }
  /** Reopens a sketch feature as the working sketch. */
  | { readonly kind: "edit-design-sketch"; readonly featureId: string }
  /** Starts a new, empty working sketch on a plane (the previous one should be finished first), optionally offset along its normal. */
  | { readonly kind: "new-design-sketch"; readonly plane: SketchDatumPlane; readonly offsetMm?: number; readonly tilt?: SketchPlaneTilt; readonly frame?: SketchPlaneFrame }
  /** Adds an extrude or revolve feature together with the solid the kernel built for it. */
  | { readonly kind: "add-design-solid"; readonly feature: DesignSolidFeature; readonly body: GeneralSolidBody }
  /** Changes a solid feature's parameters and replaces its solid. */
  | { readonly kind: "update-design-solid"; readonly feature: DesignSolidFeature; readonly body: GeneralSolidBody }
  /**
   * Replaces the user parameter table. `renames` lists parameters whose name changed (old to new): every expression that used the old name,
   * in the table, in features and in sketch dimensions, is rewritten, so a rename never breaks a reference. Every bound number is then
   * re-evaluated; the caller rebuilds the solids afterwards with `regenerate-design`.
   */
  | { readonly kind: "set-design-parameters"; readonly parameters: readonly DesignParameter[]; readonly renames?: readonly { readonly from: string; readonly to: string }[] }
  /** Applies the result of rebuilding features after a sketch changed: new solids, or the reason a feature failed. */
  | { readonly kind: "regenerate-design"; readonly results: readonly { readonly featureId: string; readonly body?: GeneralSolidBody; readonly message?: string }[] }
  | { readonly kind: "set-design-feature-suppressed"; readonly featureId: string; readonly suppressed: boolean }
  | { readonly kind: "delete-design-feature"; readonly featureId: string }
  | { readonly kind: "set-design-rollback"; readonly index: number }
  | { readonly kind: "rename-design-feature"; readonly featureId: string; readonly name: string }
  | {
      readonly kind: "set-part-parameter";
      readonly parameter: "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg";
      readonly value: number;
    }
  | { readonly kind: "add-part-preview-bodies"; readonly bodies: readonly PartPreviewBody[] }
  | { readonly kind: "delete-part-preview-body"; readonly bodyId: string }
  | { readonly kind: "add-general-body"; readonly body: GeneralSolidBody }
  | { readonly kind: "delete-general-body"; readonly bodyId: string }
  | {
      /** Replaces the target (and the tool unless kept) with the Boolean result computed by the caller. */
      readonly kind: "boolean-general-bodies";
      readonly targetBodyId: string;
      readonly toolBodyId: string;
      readonly mode: "join" | "cut" | "intersect";
      readonly keepTool: boolean;
      readonly body: GeneralSolidBody;
    }
  | { readonly kind: "toggle-general-body-visibility"; readonly bodyId: string }
  | { readonly kind: "add-construction-plane"; readonly plane: ConstructionPlane }
  | { readonly kind: "delete-construction-plane"; readonly planeId: string }
  | { readonly kind: "toggle-construction-plane-visibility"; readonly planeId: string }
  | { readonly kind: "rename-construction-plane"; readonly planeId: string; readonly name: string }
  | { readonly kind: "add-construction-binder"; readonly binder: ConstructionBinder }
  | { readonly kind: "delete-construction-binder"; readonly binderId: string }
  | { readonly kind: "toggle-construction-binder-visibility"; readonly binderId: string }
  | { readonly kind: "add-construction-axis"; readonly axis: ConstructionAxis }
  | { readonly kind: "delete-construction-axis"; readonly axisId: string }
  | { readonly kind: "toggle-construction-axis-visibility"; readonly axisId: string }
  | { readonly kind: "rename-construction-axis"; readonly axisId: string; readonly name: string }
  | { readonly kind: "add-construction-point"; readonly point: ConstructionPoint }
  | { readonly kind: "delete-construction-point"; readonly pointId: string }
  | { readonly kind: "toggle-construction-point-visibility"; readonly pointId: string }
  | { readonly kind: "rename-construction-point"; readonly pointId: string; readonly name: string }
  | { readonly kind: "add-construction-ucs"; readonly ucs: ConstructionUcs }
  | { readonly kind: "delete-construction-ucs"; readonly ucsId: string }
  | { readonly kind: "toggle-construction-ucs-visibility"; readonly ucsId: string }
  | { readonly kind: "rename-construction-ucs"; readonly ucsId: string; readonly name: string }
  | {
      /** Replaces the target body with the result of a mesh-level modify operation computed by the caller. */
      readonly kind: "modify-general-body";
      readonly targetBodyId: string;
      readonly modifier: "hole" | "shell" | "chamfer" | "fillet" | "counterbore" | "countersink" | "tapped-hole";
      readonly label: string;
      readonly body: GeneralSolidBody;
    }
  | { readonly kind: "set-part-preview-body-transform"; readonly bodyId: string; readonly translationMm: Vec3; readonly rotationDeg: Vec3 }
  | { readonly kind: "set-part-preview-body-size"; readonly bodyId: string; readonly sizeMm: Vec3; readonly primitiveParams?: PartPrimitiveParams }
  | { readonly kind: "set-part-preview-body-color"; readonly bodyId: string; readonly color: string }
  | { readonly kind: "toggle-part-preview-body-visibility"; readonly bodyId: string }
  | { readonly kind: "isolate-part-preview-body"; readonly bodyId: string }
  | { readonly kind: "set-part-preview-bodies-visibility"; readonly visible: boolean }
  | {
      readonly kind: "create-part-revolve";
      readonly bodyId: string;
      readonly name: string;
      readonly outerDiameterMm: number;
      readonly innerDiameterMm: number;
      readonly heightMm: number;
      readonly angleDeg: number;
      readonly translationMm: Vec3;
    }
  | { readonly kind: "pattern-part-feature"; readonly bodyId: string; readonly instanceIds: readonly string[]; readonly direction: "x" | "y" | "z"; readonly spacingMm: number }
  | { readonly kind: "mirror-part-feature"; readonly bodyId: string; readonly newBodyId: string; readonly plane: "xy" | "xz" | "yz" }
  | { readonly kind: "boolean-part-bodies"; readonly targetBodyId: string; readonly toolBodyId: string; readonly operation: "unite" | "subtract" }
  | { readonly kind: "trim-part-body"; readonly bodyId: string; readonly keptLengthMm: number; readonly side: "negative" | "positive" }
  | { readonly kind: "set-part-body-edge-treatment"; readonly bodyId: string; readonly treatment: PartBodyEdgeTreatment; readonly sizeMm: number }
  | { readonly kind: "set-part-body-draft"; readonly bodyId: string; readonly angleDeg: number }
  | { readonly kind: "set-part-body-shell"; readonly bodyId: string; readonly thicknessMm: number }
  | { readonly kind: "move-part-body-face"; readonly bodyId: string; readonly face: PartBodyFaceId; readonly offsetMm: number; readonly mode: "move" | "offset" }
  | { readonly kind: "replace-part-body-face"; readonly bodyId: string; readonly face: PartBodyFaceId; readonly localPositionMm: number }
  | { readonly kind: "delete-part-body-face"; readonly bodyId: string; readonly feature: "bore" | "edge-treatment" | "shell" | "draft" }
  | { readonly kind: "update-part-model" }
  | { readonly kind: "set-assembly-explode"; readonly valueMm: number }
  | { readonly kind: "apply-assembly-template"; readonly template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel"> }
  | { readonly kind: "add-assembly-component"; readonly component: ComponentInstance }
  | { readonly kind: "add-assembly-components"; readonly components: readonly ComponentInstance[] }
  | { readonly kind: "delete-assembly-component"; readonly componentId: string }
  | { readonly kind: "set-component-translation"; readonly componentId: string; readonly translationMm: Vec3 }
  | { readonly kind: "toggle-component-grounded"; readonly componentId: string }
  | { readonly kind: "toggle-component-visibility"; readonly componentId: string }
  | { readonly kind: "add-assembly-mate"; readonly mate: AssemblyMate }
  | { readonly kind: "delete-assembly-mate"; readonly mateId: string }
  | { readonly kind: "solve-assembly-mates" }
  | { readonly kind: "set-surface-mode"; readonly mode: "bezier" | "loft" }
  | {
      readonly kind: "set-surface-parameter";
      readonly parameter: "widthMm" | "depthMm" | "crownMm" | "twistDeg" | "uSegments" | "vSegments";
      readonly value: number;
    }
  | { readonly kind: "apply-surface-preset"; readonly preset: "flatten" | "canopy" }
  | { readonly kind: "set-drawing-sheet"; readonly sheet: "A4" | "A3" }
  | { readonly kind: "set-drawing-projection"; readonly projection: "first-angle" | "third-angle" }
  | { readonly kind: "set-drawing-scale"; readonly scale: 1 | 2 | 5 }
  | { readonly kind: "set-drawing-dimensions"; readonly show: boolean }
  | { readonly kind: "set-drawing-view-preset"; readonly preset: DrawingViewPreset }
  | { readonly kind: "set-drawing-display-style"; readonly style: DrawingDisplayStyle }
  | { readonly kind: "set-drawing-section-view"; readonly show: boolean }
  | { readonly kind: "set-drawing-drafting-standard"; readonly standard: DrawingDraftingStandard }
  | { readonly kind: "set-drawing-gdt"; readonly show: boolean }
  | { readonly kind: "set-drawing-datum-scheme"; readonly scheme: DrawingDatumScheme }
  | { readonly kind: "set-drawing-gdt-specification"; readonly positionMm: number; readonly flatnessMm: number; readonly perpendicularityMm: number }
  | { readonly kind: "set-drawing-general-tolerance"; readonly linearMm: number; readonly angularDeg: number }
  | { readonly kind: "set-drawing-notes"; readonly notes: string }
  | {
      readonly kind: "set-drawing-title-block";
      readonly drawingNumber: string;
      readonly revisionTag: string;
      readonly drawnBy: string;
      readonly checkedBy: string;
      readonly approvedBy: string;
      readonly organization: string;
    }
  | { readonly kind: "apply-electrical-template"; readonly template: ElectricalTemplateId }
  | { readonly kind: "set-electrical-standard"; readonly standard: ElectricalStandard }
  | { readonly kind: "set-electrical-component-position"; readonly componentId: string; readonly position: Vec2 }
  | { readonly kind: "add-electrical-component"; readonly component: ElectricalComponent }
  | { readonly kind: "delete-electrical-component"; readonly componentId: string }
  | { readonly kind: "add-electrical-net"; readonly net: ElectricalNet }
  | { readonly kind: "delete-electrical-net"; readonly netId: string }
  | { readonly kind: "set-electrical-notes"; readonly notes: string }
  | { readonly kind: "apply-vehicle-template"; readonly template: VehicleTemplateId }
  | { readonly kind: "set-vehicle-parameter"; readonly parameter: VehicleParameterKey; readonly value: number }
  | { readonly kind: "set-vehicle-evidence-status"; readonly field: "input" | "tire" | "brake"; readonly reviewed: boolean }
  | { readonly kind: "set-vehicle-simulation-state"; readonly state: VehicleSimulationState }
  | { readonly kind: "toggle-vehicle-layer"; readonly layer: VehicleLayerId }
  | {
      readonly kind: "generate-electromechanical-realization";
      readonly catalogRevision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
      readonly layoutPreset: ElectromechanicalLayoutPreset;
      readonly mappings: readonly ElectromechanicalMapping[];
      readonly replaceMode: "replace-assembly";
    }
);

/**
 * Canonical runtime operation registry shared by validation, MCP discovery,
 * documentation, and verification. `satisfies` rejects unknown entries while
 * the completeness assignment below makes TypeScript fail if a new operation
 * union member is added without updating this registry.
 */
export const WORKBENCH_OPERATION_KINDS = [
  "select-workspace", "add-sketch-entity", "delete-sketch-entity", "add-sketch-constraint", "delete-sketch-constraint",
  "set-sketch-dimension", "toggle-sketch-construction", "toggle-sketch-entity-visibility", "apply-sketch-edit", "set-sketch-constraints-suppressed", "set-sketch-plane",
  "commit-design-sketch", "edit-design-sketch", "new-design-sketch", "add-design-solid", "update-design-solid", "regenerate-design", "set-design-parameters",
  "set-design-feature-suppressed", "delete-design-feature", "set-design-rollback", "rename-design-feature", "set-part-parameter", "add-part-preview-bodies", "delete-part-preview-body",
  "add-general-body", "delete-general-body", "boolean-general-bodies", "toggle-general-body-visibility", "modify-general-body",
  "add-construction-plane", "delete-construction-plane", "toggle-construction-plane-visibility", "rename-construction-plane",
  "add-construction-binder", "delete-construction-binder", "toggle-construction-binder-visibility",
  "add-construction-axis", "delete-construction-axis", "toggle-construction-axis-visibility", "rename-construction-axis",
  "add-construction-point", "delete-construction-point", "toggle-construction-point-visibility", "rename-construction-point",
  "add-construction-ucs", "delete-construction-ucs", "toggle-construction-ucs-visibility", "rename-construction-ucs",
  "set-part-preview-body-transform", "set-part-preview-body-size", "set-part-preview-body-color", "toggle-part-preview-body-visibility",
  "isolate-part-preview-body", "set-part-preview-bodies-visibility", "create-part-revolve", "pattern-part-feature", "mirror-part-feature",
  "boolean-part-bodies", "trim-part-body", "set-part-body-edge-treatment", "set-part-body-draft", "set-part-body-shell",
  "move-part-body-face", "replace-part-body-face", "delete-part-body-face", "update-part-model", "set-assembly-explode", "apply-assembly-template",
  "add-assembly-component", "add-assembly-components", "delete-assembly-component", "set-component-translation", "toggle-component-grounded",
  "toggle-component-visibility", "add-assembly-mate", "delete-assembly-mate", "solve-assembly-mates", "set-surface-mode", "set-surface-parameter", "apply-surface-preset", "set-drawing-sheet", "set-drawing-projection",
  "set-drawing-scale", "set-drawing-dimensions", "set-drawing-view-preset", "set-drawing-display-style", "set-drawing-section-view",
  "set-drawing-drafting-standard", "set-drawing-gdt", "set-drawing-datum-scheme", "set-drawing-gdt-specification",
  "set-drawing-general-tolerance", "set-drawing-notes", "set-drawing-title-block", "apply-electrical-template", "set-electrical-standard",
  "set-electrical-component-position", "add-electrical-component", "delete-electrical-component", "add-electrical-net",
  "delete-electrical-net", "set-electrical-notes", "apply-vehicle-template", "set-vehicle-parameter",
  "set-vehicle-evidence-status", "set-vehicle-simulation-state", "toggle-vehicle-layer", "generate-electromechanical-realization"
] as const satisfies readonly WorkbenchOperation["kind"][];

const WORKBENCH_OPERATION_KIND_COMPLETENESS: Record<
  Exclude<WorkbenchOperation["kind"], (typeof WORKBENCH_OPERATION_KINDS)[number]>,
  never
> = {};
void WORKBENCH_OPERATION_KIND_COMPLETENESS;

export interface AppliedWorkbenchOperation {
  readonly project: WorkbenchProject;
  readonly changedIds: readonly string[];
  readonly summary: string;
  readonly exactRetry: boolean;
}

export interface CapabilityRecord {
  readonly id: string;
  readonly workspace: WorkspaceId;
  readonly name: string;
  readonly level: CapabilityLevel;
  readonly summary: string;
}
