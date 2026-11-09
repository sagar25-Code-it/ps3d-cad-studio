import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { MAX_BODY_MESH_NUMBERS, MAX_BODY_VERTICES, splitPieceId, splitPieceName } from "../../../packages/workbench-core/src/index.js";
import { adaptiveFacetCount, booleanMeshes, splitMeshPieces, revolveAxisRelation, revolveSegmentsForRadius, tessellateDome, tessellateExtrude, tessellateHelix, tessellateLoft, tessellateLoftTwoProfiles, tessellateBentStrip, tessellateRevolve, tessellateRevolveRegion, tessellateSweep, tessellateSweepPath, type BooleanMode, type TessellatePlane } from "../../../packages/workbench-geometry/src/index.js";
import { evaluateProfilePrism, evaluateProfileRevolution, stableFaceKey } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import { profileOutlineMm, stableEntityToken, type SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import type { ProfileEdgeGroup, ProfileHole } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import { planHoleFacets } from "./many-holes.js";

/** Sketch-plane identifier shared with the solid builder UI. */
export type SketchPlane = TessellatePlane;

type PolygonPoint = readonly [number, number];
type WorldPoint = readonly [number, number, number];

/**
 * Convert a detected sketch profile boundary into a closed polygon (millimetres). Every curve follows the one chord-error rule of the
 * sketch (profileOutlineMm: within 1/2,000 of the radius, at most 0.01 mm), so the outline of an extrusion, a sweep and a loft is as
 * round as the sketch curve at any size. `maxFacets` caps a round outline for a caller that multiplies it by another count (a revolve).
 */
export function profilePolygonMm(boundary: SketchProfile["boundary"], maxFacets?: number, fine = false): readonly PolygonPoint[] {
  return profileOutlineMm(boundary, { ...(maxFacets === undefined ? {} : { maxFacets }), ...(fine ? { fine: true } : {}) }).map((point) => [point[0], point[1]] as PolygonPoint);
}

/** The coarser faceting a revolve gives the round outline of its profile (the file grows with the facets times the turns): see adaptiveFacetCount. */
function revolveProfileFacets(boundary: SketchProfile["boundary"]): number | undefined {
  if (boundary.kind === "circle") return adaptiveFacetCount(boundary.radiusMm);
  if (boundary.kind === "ellipse") return adaptiveFacetCount(boundary.majorRadiusMm);
  return undefined;
}

/**
 * Offset a profile inward by `insetMm`. Supported for rectangles (shrink each side) and circles (reduce the radius). For
 * arbitrary polygons the shell operation is refused upstream, so this helper returns `undefined` only when the inset leaves
 * nothing behind.
 */
function insetPolygon(polygonMm: readonly PolygonPoint[], insetMm: number, kind: "rectangle" | "circle"): readonly PolygonPoint[] | undefined {
  if (kind === "rectangle") {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of polygonMm) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const newMinX = minX + insetMm;
    const newMaxX = maxX - insetMm;
    const newMinY = minY + insetMm;
    const newMaxY = maxY - insetMm;
    if (newMaxX - newMinX < 0.1 || newMaxY - newMinY < 0.1) return undefined;
    return [[newMinX, newMinY], [newMaxX, newMinY], [newMaxX, newMaxY], [newMinX, newMaxY]];
  }
  // Circle: polygonMm is a faceted circle. Shrink each vertex toward the centroid.
  const centroid = polygonMm.reduce((sum, point) => [sum[0] + point[0] / polygonMm.length, sum[1] + point[1] / polygonMm.length] as const, [0, 0] as const);
  const radius = Math.hypot(polygonMm[0]![0] - centroid[0], polygonMm[0]![1] - centroid[1]);
  const newRadius = radius - insetMm;
  if (newRadius < 0.05) return undefined;
  const scale = newRadius / radius;
  return polygonMm.map(([x, y]) => [centroid[0] + (x - centroid[0]) * scale, centroid[1] + (y - centroid[1]) * scale] as PolygonPoint);
}

/** One kernel side face per sketch entity of a curve loop, so arcs stay single cylindrical walls with stable names. */
function curveEdgeGroups(boundary: SketchProfile["boundary"], rolePrefix: string): readonly ProfileEdgeGroup[] | undefined {
  if (boundary.kind !== "curve-loop") return undefined;
  // A curve split in two where another touches it gives two segments with one key; the walls still need distinct names.
  const seen = new Map<string, number>();
  return boundary.segments.map((segment) => {
    const token = stableEntityToken([segment.key ?? segment.entityId]);
    const count = (seen.get(token) ?? 0) + 1;
    seen.set(token, count);
    return { role: `${rolePrefix}-${count === 1 ? token : `${token}.${count}`}`, edgeCount: segment.edgeCount, curved: segment.kind !== "line" };
  });
}

/** Place a 2D sketch point (millimetres) onto its datum plane in world metres, matching the analytic tessellator's orientation. */
function placeOnPlane(point: PolygonPoint, plane: SketchPlane): WorldPoint {
  const u = point[0] / 1000;
  const v = point[1] / 1000;
  if (plane === "xz") return [u, 0, v];
  if (plane === "yz") return [0, v, -u];
  return [u, v, 0];
}

/** The outward extrusion normal for each datum plane (matches placeOnPlane). */
function planeNormal(plane: SketchPlane): WorldPoint {
  if (plane === "xz") return [0, -1, 0];
  if (plane === "yz") return [1, 0, 0];
  return [0, 0, 1];
}

/** Rotate a kernel local-space revolve point (revolved about Y) onto its datum plane, matching the analytic tessellator. */
function rotateLocalToPlane(point: WorldPoint, plane: SketchPlane): WorldPoint {
  if (plane === "xz") return [point[0], -point[2], point[1]];
  if (plane === "yz") return [point[2], point[1], -point[0]];
  return point;
}

export interface CreateGeneralSolidRequest {
  readonly profile: SketchProfile;
  readonly plane: SketchPlane;
  readonly operation: "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem";
  /** Extrusion height / revolve angle (deg) / sweep distance / loft height, in millimetres (angle: degrees). For edge-fillet/chamfer, shell and draft this is still the extrusion height. */
  readonly valueMm: number;
  readonly bodyId: string;
  readonly name: string;
  readonly color: string;
  /** Optional chamfer or fillet of the extruded prism's vertical edges (extrude / edge-fillet / edge-chamfer). */
  readonly edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number };
  /** Further separate regions built in the same feature (extrude and revolve): disjoint bosses, or an island in a hole. */
  readonly extraGroups?: readonly { readonly profile: SketchProfile; readonly holes?: readonly SketchProfile[] }[];
  /** Profiles that lie inside `profile` and are cut through it (extrude only). */
  readonly holes?: readonly SketchProfile[];
  /** Sweep only: world-space direction vector (will be normalized). Builder refuses a direction with zero length. */
  readonly sweepDirectionMm?: readonly [number, number, number];
  /** Sweep only: already-sampled sketch-plane path samples in local 2D mm. Taking precedence over `sweepDirectionMm` when both are present. */
  readonly sweepPathSamplesMm?: readonly (readonly [number, number])[];
  /** Sweep only: twist in degrees across the whole sweep. */
  readonly sweepTwistDeg?: number;
  /** Sweep-along-path only: when true, each ring is reoriented perpendicular to the path's local tangent. */
  readonly sweepFrameTransport?: boolean;
  /** Loft only: top scale factor (>0). */
  readonly loftTopScale?: number;
  /** Loft only: an explicit top profile (same sketch). When set, `loftTopScale` is ignored and two-profile loft is used. */
  readonly loftSecondaryProfile?: SketchProfile;
  /** Loft only: ribbon continuity. */
  readonly loftContinuity?: "position" | "tangent" | "curvature";
  /** Loft only: already-sampled rail path in local 2D mm (one sample per ring). */
  readonly loftRailSamplesMm?: readonly (readonly [number, number])[];
  /** Loft two-profile only: strength of the G1/G2 ease curve (0 reverts to linear, 1 is the plain ease, up to 2 over-applies it). */
  readonly loftTangencyWeight?: number;
  /** Shell only: wall thickness in mm (the inset the inner cavity is offset by). */
  readonly shellThicknessMm?: number;
  /** Shell only: which cap face to leave open. */
  readonly shellOpenFace?: "top" | "bottom" | "none";
  /** Draft only: taper angle in degrees. */
  readonly draftAngleDeg?: number;
  /** Draft only: which cap stays fixed. */
  readonly draftNeutralFace?: "top" | "bottom";
  /** Helix only: coil radius (centerline of the swept profile) in millimetres. */
  readonly helixRadiusMm?: number;
  /** Helix only: axial advance per turn in millimetres. */
  readonly helixPitchMm?: number;
  /** Helix only: how many turns to wind. */
  readonly helixTurns?: number;
  /** Helix only: winding handedness. */
  readonly helixHandedness?: "right" | "left";
  /** Thread (helical ridge on a cylinder) only: pitch, turns, depth (radius), and handedness. */
  readonly threadPitchMm?: number;
  readonly threadTurns?: number;
  readonly threadDepthMm?: number;
  readonly threadHandedness?: "right" | "left";
  /** Rib only: thickness of the thin-wall extrusion in millimetres. */
  readonly ribThicknessMm?: number;
  readonly ribDirection?: "symmetric" | "one-side";
  /** Dome only: dome height above the target face's plane in millimetres. */
  readonly domeHeightMm?: number;
  /** Edge-fillet only: optional end radius (start → end along the vertical edge). */
  readonly edgeEndSizeMm?: number;
  /** Sheet metal: thickness, inner bend radius, flange length (mm) and bend angle (deg); hem style. */
  readonly sheetThicknessMm?: number;
  readonly sheetBendRadiusMm?: number;
  readonly flangeLengthMm?: number;
  readonly flangeAngleDeg?: number;
  readonly hemStyle?: "closed" | "open";
}

/** Maps a hole profile to the kernel's hole loop; the id comes from its sketch entities so wall names survive edits. */
function kernelHole(profile: SketchProfile, plane: SketchPlane, maxFacets?: number): ProfileHole {
  const points = profilePolygonMm(profile.boundary, maxFacets).map((point) => placeOnPlane(point, plane));
  const id = stableEntityToken(profile.entityIds);
  const groups = curveEdgeGroups(profile.boundary, `face.hole-${id}-seg`);
  return {
    id,
    points,
    ...(profile.boundary.kind === "circle" ? { smoothSides: true } : {}),
    ...(groups === undefined ? {} : { edgeGroups: groups })
  };
}

/** A revolve of an outline with holes: the holes turn into voids (a full turn) or tunnels through the end faces (a partial one). */
function revolveWithHoles(request: CreateGeneralSolidRequest, polygonMm: readonly PolygonPoint[], base: Omit<GeneralSolidBody, "positionsMm" | "indices">): CreateGeneralSolidResult {
  if (revolveAxisRelation(polygonMm) === "crosses") {
    return { ok: false, message: "The profile crosses the revolve axis (the sketch Y axis), so it would overlap itself. Draw the profile entirely on one side of the Y axis, or move it so it only touches the axis." };
  }
  try {
    const mesh = tessellateRevolveRegion(polygonMm, (request.holes ?? []).map((hole) => profilePolygonMm(hole.boundary)), request.valueMm, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be converted into a solid." };
    if (mesh.positionsMm.length / 3 > MAX_BODY_VERTICES) return { ok: false, message: `The revolved region has ${(mesh.positionsMm.length / 3).toLocaleString("en-US")} vertices and a solid holds at most ${MAX_BODY_VERTICES.toLocaleString("en-US")}. Use fewer holes or a smaller angle.` };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  } catch (error) {
    return { ok: false, message: `The solid kernel could not revolve this profile: ${error instanceof Error ? error.message : "a hole crosses the outline"}` };
  }
}

export type CreateGeneralSolidResult =
  | { readonly ok: true; readonly body: GeneralSolidBody; readonly pieces?: readonly GeneralSolidBody[]; /** Something worth telling the user that did not stop the build (the holes of a very perforated plate were given fewer edges). */ readonly note?: string }
  | { readonly ok: false; readonly message: string };

/** Joins solids that do not touch into one body: their meshes side by side, their faces named per region. */
function mergeRegionBodies(bodies: readonly GeneralSolidBody[], base: { readonly id: string; readonly name: string; readonly color: string }): GeneralSolidBody {
  const positionsMm: number[] = [];
  const indices: number[] = [];
  const faces: { role: string; key: string; areaMm2: number }[] = [];
  const faceTriangles: number[] = [];
  let vertices = 0;
  let edges = 0;
  let faceCount = 0;
  let withBrep = true;
  bodies.forEach((body, index) => {
    const offset = positionsMm.length / 3;
    for (const value of body.positionsMm) positionsMm.push(value);
    for (const value of body.indices) indices.push(value + offset);
    const brep = body.brep;
    if (brep === undefined) { withBrep = false; return; }
    vertices += brep.topology.vertices;
    edges += brep.topology.edges;
    const before = faces.length;
    for (const face of brep.faces) faces.push({ role: index === 0 ? face.role : `region${index + 1}.${face.role}`, key: face.key, areaMm2: face.areaMm2 });
    for (const face of brep.faceTriangles) faceTriangles.push(face + before);
    faceCount += brep.topology.faces;
  });
  const first = bodies[0]!;
  const merged: GeneralSolidBody = { ...first, id: base.id, name: base.name, color: base.color, positionsMm, indices };
  if (!withBrep) {
    const { brep: _dropped, ...withoutBrep } = merged;
    void _dropped;
    return withoutBrep;
  }
  return { ...merged, brep: { ...first.brep!, topology: { vertices, edges, faces: faceCount }, faces, faceTriangles } };
}

/**
 * Builds a feature from several regions at once (separate bosses, or an island standing in a hole): each region is built on its own
 * and the solids that result are one body. The regions come from one sketch arrangement, so they never overlap.
 */
async function createRegionGroups(request: CreateGeneralSolidRequest): Promise<CreateGeneralSolidResult> {
  const groups = [{ profile: request.profile, holes: request.holes ?? [] }, ...(request.extraGroups ?? [])];
  if (request.operation !== "extrude" && request.operation !== "revolve") return { ok: false, message: `A ${request.operation} is built from one region; several regions are selected. Select a single region.` };
  if (request.edge !== undefined) return { ok: false, message: "Chamfer and fillet are not available when several regions are selected. Treat the edges after the extrusion, or select one region." };
  const built: GeneralSolidBody[] = [];
  const notes: string[] = [];
  for (const [index, group] of groups.entries()) {
    const { extraGroups: _extra, holes: _holes, ...single } = request;
    void _extra; void _holes;
    const part = await createGeneralSolidBody({ ...single, profile: group.profile, ...((group.holes ?? []).length === 0 ? {} : { holes: group.holes }), bodyId: index === 0 ? request.bodyId : `${request.bodyId}.region-${index + 1}` });
    if (!part.ok) return { ok: false, message: groups.length > 1 ? `Region ${index + 1} of ${groups.length}: ${part.message}` : part.message };
    built.push(part.body);
    if (part.note !== undefined) notes.push(part.note);
  }
  return { ok: true, body: mergeRegionBodies(built, { id: request.bodyId, name: request.name, color: request.color }), ...(notes.length === 0 ? {} : { note: notes.join(" ") }) };
}

/**
 * Build a general mesh-solid body from a sketch profile.
 *
 * Extrude runs through the reference B-rep kernel (browser-safe): the body
 * carries the kernel's watertight tessellation plus its exact topology summary
 * and stable, lineage-anchored face names. Revolve still uses the analytic
 * tessellator because the reference kernel does not yet evaluate revolves.
 */
export async function createGeneralSolidBody(request: CreateGeneralSolidRequest): Promise<CreateGeneralSolidResult> {
  if (request.extraGroups !== undefined && request.extraGroups.length > 0) return createRegionGroups(request);
  const polygonMm = profilePolygonMm(request.profile.boundary, request.operation === "revolve" ? revolveProfileFacets(request.profile.boundary) : undefined);
  if (polygonMm.length < 3) return { ok: false, message: "The selected profile does not form a closed polygon." };
  if (!Number.isFinite(request.valueMm) || request.valueMm === 0) {
    return { ok: false, message: request.operation === "extrude" ? "Enter a non-zero extrusion height." : "Enter a non-zero revolve angle." };
  }

  const base = {
    id: request.bodyId,
    name: request.name,
    visible: true as const,
    color: request.color,
    feature: { operation: request.operation, plane: request.plane, valueMm: request.valueMm }
  };

  if (request.operation === "draft") {
    const angleDeg = request.draftAngleDeg;
    if (angleDeg === undefined || !Number.isFinite(angleDeg) || angleDeg <= 0 || angleDeg >= 80) return { ok: false, message: "Draft needs an angle between 0° and 80°." };
    const height = Math.abs(request.valueMm);
    // characteristicRadius: the largest distance from the centroid to any profile boundary vertex.
    const centroid = polygonMm.reduce((sum, point) => [sum[0] + point[0] / polygonMm.length, sum[1] + point[1] / polygonMm.length] as const, [0, 0] as const);
    const characteristic = polygonMm.reduce((maximum, point) => Math.max(maximum, Math.hypot(point[0] - centroid[0], point[1] - centroid[1])), 0);
    if (characteristic < 0.05) return { ok: false, message: "The profile is too small to receive a draft." };
    const shift = height * Math.tan(angleDeg * Math.PI / 180);
    const neutral = request.draftNeutralFace ?? "bottom";
    // Inward draft (positive angle): top shrinks relative to bottom when neutral is "bottom", bottom shrinks when neutral is "top".
    const topScale = Math.max(0.01, 1 - shift / characteristic);
    if (topScale < 0.05) return { ok: false, message: "The draft angle collapses the top face. Use a smaller angle or a shorter height." };
    // Rebuild the lofted mesh using the loft tessellator with the computed top scale. Flip the mesh if neutral is "top".
    const mesh = tessellateLoft(polygonMm, neutral === "bottom" ? topScale : 1, Math.abs(request.valueMm), request.plane);
    if (neutral === "top") {
      // Scale the BASE instead: reuse tessellateLoft for the top-scale-as-base interpretation by inverting.
      const inverted = tessellateLoft(polygonMm.map((point) => [centroid[0] + (point[0] - centroid[0]) * topScale, centroid[1] + (point[1] - centroid[1]) * topScale] as const), 1 / topScale, Math.abs(request.valueMm), request.plane);
      if (inverted.positionsMm.length < 9) return { ok: false, message: "The profile could not be drafted." };
      return { ok: true, body: { ...base, positionsMm: Array.from(inverted.positionsMm), indices: Array.from(inverted.indices) } };
    }
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be drafted." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "shell") {
    const thickness = request.shellThicknessMm;
    if (thickness === undefined || !Number.isFinite(thickness) || thickness <= 0) return { ok: false, message: "Shell needs a positive wall thickness." };
    const height = Math.abs(request.valueMm);
    if (height <= thickness * 2) return { ok: false, message: "The shell is thicker than the body it would hollow. Use a thinner wall or a taller body." };
    // For MVP we support rectangles and circles: the inner inset is well-defined.
    if (request.profile.boundary.kind !== "rectangle" && request.profile.boundary.kind !== "circle") {
      return { ok: false, message: "Shell is supported for rectangular and circular profiles in this slice." };
    }
    const outer = tessellateExtrude(polygonMm, height, request.plane);
    if (outer.positionsMm.length < 9) return { ok: false, message: "The outer shell could not be built." };
    const insetPoints = insetPolygon(polygonMm, thickness, request.profile.boundary.kind);
    if (insetPoints === undefined) return { ok: false, message: "The wall thickness is larger than the profile; nothing would remain." };
    const openFace = request.shellOpenFace ?? "top";
    const innerHeight = openFace === "none" ? height - thickness * 2 : height - thickness;
    const innerStart = openFace === "top" ? 0 : openFace === "bottom" ? thickness : thickness;
    const inner = tessellateExtrude(insetPoints, innerHeight, request.plane);
    if (inner.positionsMm.length < 9) return { ok: false, message: "The inner cavity could not be built." };
    // Translate the inner mesh along the plane normal by innerStart.
    const normal = planeNormal(request.plane);
    const innerShifted = inner.positionsMm.map((value, index) => value + normal[index % 3]! * innerStart);
    const booleanResult = booleanMeshes({ positionsMm: outer.positionsMm, indices: outer.indices }, { positionsMm: innerShifted, indices: inner.indices }, "cut");
    if (!booleanResult.ok) return { ok: false, message: `Shell could not be built: ${booleanResult.message}` };
    return { ok: true, body: { ...base, positionsMm: Array.from(booleanResult.value.positionsMm), indices: Array.from(booleanResult.value.indices) } };
  }
  if (request.operation === "edge-fillet" || request.operation === "edge-chamfer") {
    // These reuse the extrude kernel with the `edge` cornerTreatment overlaid.
    if (request.edge === undefined || !Number.isFinite(request.edge.sizeMm) || request.edge.sizeMm <= 0) {
      return { ok: false, message: `${request.operation === "edge-fillet" ? "Fillet" : "Chamfer"} needs a positive size.` };
    }
    // Fall through to the extrude path below by treating operation as extrude. We can't just reassign since operation is readonly,
    // so delegate to a nested call with operation swapped.
    return createGeneralSolidBody({ ...request, operation: "extrude" });
  }
  if (request.operation === "sheet-base") {
    const thickness = request.sheetThicknessMm;
    if (thickness === undefined || !Number.isFinite(thickness) || thickness <= 0) return { ok: false, message: "Sheet base needs a positive thickness." };
    const mesh = tessellateExtrude(polygonMm, thickness, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The sheet base could not be built." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "sheet-flange" || request.operation === "sheet-hem") {
    const thickness = request.sheetThicknessMm;
    const radius = request.sheetBendRadiusMm;
    const flangeLength = request.flangeLengthMm;
    if (thickness === undefined || !Number.isFinite(thickness) || thickness <= 0) return { ok: false, message: "Sheet flange needs a positive thickness." };
    if (radius === undefined || !Number.isFinite(radius) || radius < 0) return { ok: false, message: "Sheet flange needs a non-negative bend radius." };
    if (flangeLength === undefined || !Number.isFinite(flangeLength) || flangeLength <= 0) return { ok: false, message: "Sheet flange needs a positive flange length." };
    const isHem = request.operation === "sheet-hem";
    const angle = isHem ? 180 : request.flangeAngleDeg;
    if (angle === undefined || !Number.isFinite(angle) || angle <= 0 || angle > 180) return { ok: false, message: "The bend angle must be between 0° and 180°." };
    // The profile's X extent is the flat leg that stays in the sketch plane; valueMm is the strip width.
    const xs = polygonMm.map((point) => point[0]);
    const leg = Math.max(...xs) - Math.min(...xs);
    const innerRadius = isHem && (request.hemStyle ?? "closed") === "closed" ? 0.05 : radius;
    const mesh = tessellateBentStrip({ legMm: leg, flangeLengthMm: flangeLength, angleDeg: angle, innerRadiusMm: innerRadius, thicknessMm: thickness, widthMm: Math.abs(request.valueMm) }, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The flange could not be built. Check the leg, flange length, thickness and width are positive." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "thread") {
    // Thread is a helical ridge: a small triangular V-section profile at the thread depth / pitch over a given number of turns.
    const pitch = request.threadPitchMm;
    const turns = request.threadTurns;
    const depth = request.threadDepthMm;
    const hand = request.threadHandedness ?? "right";
    if (pitch === undefined || !Number.isFinite(pitch) || pitch <= 0) return { ok: false, message: "Thread needs a positive pitch." };
    if (turns === undefined || !Number.isFinite(turns) || turns <= 0) return { ok: false, message: "Thread needs a positive number of turns." };
    if (depth === undefined || !Number.isFinite(depth) || depth <= 0) return { ok: false, message: "Thread needs a positive thread depth (coil radius)." };
    // Override the sketch profile with a small triangular V (apex inward, base 0.6 × pitch): classic 60° thread section.
    const sectionBase = pitch * 0.6;
    const sectionHeight = pitch * 0.5;
    const threadSection: readonly (readonly [number, number])[] = [[-sectionBase / 2, 0], [sectionBase / 2, 0], [0, sectionHeight]];
    const mesh = tessellateHelix(threadSection, depth, pitch, turns, hand, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The thread could not be built." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "rib") {
    const ribThickness = request.ribThicknessMm;
    if (ribThickness === undefined || !Number.isFinite(ribThickness) || ribThickness <= 0) return { ok: false, message: "Rib needs a positive thickness." };
    // The sketch profile is used as the rib's plan; it's extruded by valueMm with the thickness baked into the profile already.
    const mesh = tessellateExtrude(polygonMm, Math.abs(request.valueMm), request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The rib could not be built." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "dome") {
    const height = request.domeHeightMm;
    if (height === undefined || !Number.isFinite(height) || height === 0) return { ok: false, message: "Dome needs a non-zero height." };
    const mesh = tessellateDome(polygonMm, height, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The dome could not be built." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "helix") {
    const radius = request.helixRadiusMm;
    const pitch = request.helixPitchMm;
    const turns = request.helixTurns;
    const handedness = request.helixHandedness ?? "right";
    if (radius === undefined || !Number.isFinite(radius) || radius <= 0) return { ok: false, message: "Helix needs a positive coil radius." };
    if (pitch === undefined || !Number.isFinite(pitch) || pitch <= 0) return { ok: false, message: "Helix needs a positive pitch." };
    if (turns === undefined || !Number.isFinite(turns) || turns <= 0) return { ok: false, message: "Helix needs a positive number of turns." };
    const mesh = tessellateHelix(polygonMm, radius, pitch, turns, handedness, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be wound into a helix." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "sweep") {
    const twist = request.sweepTwistDeg ?? 0;
    const frameTransport = request.sweepFrameTransport ?? false;
    if (request.sweepPathSamplesMm !== undefined && request.sweepPathSamplesMm.length >= 2) {
      const mesh = tessellateSweepPath(polygonMm, request.sweepPathSamplesMm, request.valueMm, request.plane, twist, frameTransport);
      if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be swept along the path." };
      return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
    }
    if (request.sweepDirectionMm === undefined) return { ok: false, message: "A sweep needs a direction vector or a path entity." };
    const length = Math.hypot(request.sweepDirectionMm[0], request.sweepDirectionMm[1], request.sweepDirectionMm[2]);
    if (length < 1e-6) return { ok: false, message: "The sweep direction must not be zero." };
    const normal = planeNormal(request.plane);
    const dotWithNormal = Math.abs(request.sweepDirectionMm[0] * normal[0] + request.sweepDirectionMm[1] * normal[1] + request.sweepDirectionMm[2] * normal[2]) / length;
    if (dotWithNormal < 1e-6) return { ok: false, message: "The sweep direction is parallel to the sketch plane, which would flatten the solid. Give it a component off the plane." };
    const mesh = tessellateSweep(polygonMm, request.sweepDirectionMm, request.valueMm, request.plane, twist);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be converted into a swept solid." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "loft") {
    if (request.loftSecondaryProfile !== undefined) {
      const topPolygon = profilePolygonMm(request.loftSecondaryProfile.boundary);
      if (topPolygon.length < 3) return { ok: false, message: "The top profile does not form a closed polygon." };
      const continuity = request.loftContinuity ?? "position";
      const tangencyWeight = request.loftTangencyWeight ?? 1;
      const mesh = tessellateLoftTwoProfiles(polygonMm, topPolygon, request.valueMm, continuity, request.plane, 12, request.loftRailSamplesMm, tangencyWeight);
      if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profiles could not be lofted. Check both have at least three points and a non-zero height." };
      return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
    }
    const scale = request.loftTopScale;
    if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return { ok: false, message: "Loft needs a positive top scale or a second profile." };
    const mesh = tessellateLoft(polygonMm, scale, request.valueMm, request.plane);
    if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The profile could not be converted into a lofted solid." };
    return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
  }
  if (request.operation === "extrude") {
    if (request.edge !== undefined) {
      if (request.profile.boundary.kind === "circle") return { ok: false, message: "Chamfer and fillet apply to polygon and rectangle profiles; a circle has no corners to treat." };
      if (request.profile.boundary.kind === "curve-loop") return { ok: false, message: "Chamfer and fillet are not available for profiles that contain arcs yet." };
      if (!Number.isFinite(request.edge.sizeMm) || request.edge.sizeMm <= 0) return { ok: false, message: `Enter a positive ${request.edge.kind === "chamfer" ? "chamfer distance" : "fillet radius"}.` };
    }
    const holes = request.holes ?? [];
    const outerGroups = curveEdgeGroups(request.profile.boundary, "face.seg");
    const facetPlan = planHoleFacets(request.profile.boundary, holes);
    if (facetPlan.refusal !== undefined) return { ok: false, message: facetPlan.refusal };
    try {
      const prism = await evaluateProfilePrism({
        operationId: request.bodyId,
        semanticId: request.bodyId,
        profilePointsMeters: polygonMm.map((point) => placeOnPlane(point, request.plane)),
        normal: planeNormal(request.plane),
        heightMeters: Math.abs(request.valueMm) / 1000,
        // A circle is one cylindrical face, not 72 planar ones: the faceted loop is only its tessellation.
        ...(request.profile.boundary.kind === "circle" ? { smoothSides: true } : {}),
        ...(outerGroups === undefined ? {} : { edgeGroups: outerGroups }),
        ...(holes.length === 0 ? {} : { holes: holes.map((hole) => kernelHole(hole, request.plane, facetPlan.maxFacets)) }),
        ...(request.edge === undefined ? {} : { cornerTreatment: { kind: request.edge.kind, sizeMeters: request.edge.sizeMm / 1000 } })
      });
      if (prism.indices.length < 3) return { ok: false, message: "The profile could not be converted into a solid." };
      return {
        ok: true,
        body: {
          ...base,
          positionsMm: prism.positionsMeters.map((value) => value * 1000),
          indices: prism.indices,
          brep: {
            topology: { vertices: prism.topology.vertices, edges: prism.topology.edges, faces: prism.topology.faces },
            faces: prism.faces.map((face) => ({ role: face.role, key: face.key, areaMm2: face.areaSquareMeters * 1e6 })),
            faceTriangles: prism.faceTriangles
          }
        },
        ...(facetPlan.note === undefined ? {} : { note: facetPlan.note })
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      // The kernel's profile and treatment checks name what to fix (crossing outline, hole outside, corner too large), so show them.
      return { ok: false, message: detail !== "" ? `The solid kernel could not extrude this profile: ${detail}` : "The solid kernel could not extrude this profile." };
    }
  }
  if ((request.holes?.length ?? 0) > 0) return revolveWithHoles(request, polygonMm, base);

  // A profile with points on both sides of the axis would sweep over itself. Reject it clearly
  // instead of producing an overlapping, unvalidated mesh (CAD tools do the same).
  if (revolveAxisRelation(polygonMm) === "crosses") {
    return { ok: false, message: "The profile crosses the revolve axis (the sketch Y axis), so it would overlap itself. Draw the profile entirely on one side of the Y axis, or move it so it only touches the axis." };
  }

  // Revolve through the B-rep kernel when the profile stays strictly on one side of the axis;
  // a profile that only touches the axis (or sits on the negative side) uses the analytic tessellator.
  const profilePoints = polygonMm.map((point) => [point[0] / 1000, point[1] / 1000] as const);
  if (profilePoints.every((point) => point[0] > 1e-9)) {
    try {
      const revolution = await evaluateProfileRevolution({
        operationId: request.bodyId,
        semanticId: request.bodyId,
        profilePoints,
        degrees: request.valueMm,
        segments: Math.min(256, revolveSegmentsForRadius(Math.max(...polygonMm.map((point) => Math.abs(point[0]))), polygonMm.length))
      });
      if (revolution.indices.length >= 3) {
        const positionsMm: number[] = [];
        for (let index = 0; index + 2 < revolution.positionsMeters.length; index += 3) {
          const world = rotateLocalToPlane([revolution.positionsMeters[index]!, revolution.positionsMeters[index + 1]!, revolution.positionsMeters[index + 2]!], request.plane);
          positionsMm.push(world[0] * 1000, world[1] * 1000, world[2] * 1000);
        }
        return {
          ok: true,
          body: {
            ...base,
            positionsMm,
            indices: revolution.indices,
            brep: {
              topology: { vertices: revolution.topology.vertices, edges: revolution.topology.edges, faces: revolution.topology.faces },
              faces: revolution.faces.map((face) => ({ role: face.role, key: face.key, areaMm2: face.areaSquareMeters * 1e6 })),
              faceTriangles: revolution.faceTriangles
            }
          }
        };
      }
    } catch {
      // fall through to the analytic tessellator
    }
  }

  const mesh = tessellateRevolve(polygonMm, request.valueMm, request.plane);
  if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) {
    return { ok: false, message: "The profile could not be converted into a solid." };
  }
  return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
}

export interface CombineGeneralBodiesRequest {
  readonly target: GeneralSolidBody;
  readonly tool: GeneralSolidBody;
  readonly mode: BooleanMode;
  readonly bodyId: string;
  readonly name: string;
  /** A cut that severs the target keeps every piece: the largest as `body`, the rest as `pieces`, instead of being refused. */
  readonly allowSplit?: boolean;
}

/**
 * Join, cut or intersect two general bodies with the pure-TypeScript mesh Boolean.
 *
 * The result is a tessellated solid, not an exact B-rep: its faces are labelled regions named
 * `target.<role>` and `tool.<role>` after the source faces they came from, so a face keeps its name as long as
 * the operands keep theirs. A result that is not a clean closed solid is refused and nothing changes.
 */
export async function combineGeneralBodies(request: CombineGeneralBodiesRequest): Promise<CreateGeneralSolidResult> {
  const input = (body: GeneralSolidBody): { positionsMm: readonly number[]; indices: readonly number[]; faceTriangles?: readonly number[] } => ({
    positionsMm: body.positionsMm,
    indices: body.indices,
    ...(body.brep === undefined ? {} : { faceTriangles: body.brep.faceTriangles })
  });
  const combined = booleanMeshes(input(request.target), input(request.tool), request.mode, request.allowSplit === true ? { allowSplit: true } : {});
  if (!combined.ok) return { ok: false, message: combined.message };
  if (combined.value.positionsMm.length > MAX_BODY_MESH_NUMBERS || combined.value.indices.length > MAX_BODY_MESH_NUMBERS) return { ok: false, message: `The result has ${(combined.value.positionsMm.length / 3).toLocaleString("en-US")} vertices and a solid holds at most ${MAX_BODY_VERTICES.toLocaleString("en-US")}. Simplify one of the bodies and try again.` };

  const sourceRole = (source: "target" | "tool", face: number): string => {
    const body = source === "target" ? request.target : request.tool;
    return `${source}.${face < 0 ? "mesh" : body.brep?.faces[face]?.role ?? `face-${face}`}`;
  };
  const build = async (positionsMm: readonly number[], indices: readonly number[], origins: typeof combined.value.origins, bodyId: string, name: string): Promise<GeneralSolidBody> => {
    const roles = [...new Set(origins.map((origin) => sourceRole(origin.source, origin.face)))].sort();
    const faceIndex = new Map(roles.map((role, index) => [role, index]));
    const faceTriangles = origins.map((origin) => faceIndex.get(sourceRole(origin.source, origin.face))!);
    const areas = new Array<number>(roles.length).fill(0);
    for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
      const [a, b, c] = [indices[triangle * 3]! * 3, indices[triangle * 3 + 1]! * 3, indices[triangle * 3 + 2]! * 3];
      const ux = positionsMm[b]! - positionsMm[a]!; const uy = positionsMm[b + 1]! - positionsMm[a + 1]!; const uz = positionsMm[b + 2]! - positionsMm[a + 2]!;
      const vx = positionsMm[c]! - positionsMm[a]!; const vy = positionsMm[c + 1]! - positionsMm[a + 1]!; const vz = positionsMm[c + 2]! - positionsMm[a + 2]!;
      areas[faceTriangles[triangle]!]! += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    const edges = new Set<string>();
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      for (const [from, to] of [[indices[triangle]!, indices[triangle + 1]!], [indices[triangle + 1]!, indices[triangle + 2]!], [indices[triangle + 2]!, indices[triangle]!]] as const) edges.add(from < to ? `${from},${to}` : `${to},${from}`);
    }
    const faces = await Promise.all(roles.map(async (role, index) => ({ role, key: await stableFaceKey(bodyId, role), areaMm2: areas[index]! })));
    return {
      id: bodyId,
      name,
      visible: true,
      color: request.target.color,
      positionsMm: [...positionsMm],
      indices: [...indices],
      brep: {
        topology: { vertices: positionsMm.length / 3, edges: edges.size, faces: roles.length },
        faces,
        faceTriangles,
        origin: "mesh-boolean"
      }
    };
  };
  const { positionsMm, indices, origins } = combined.value;
  if (combined.value.pieceCount <= 1) return { ok: true, body: await build(positionsMm, indices, origins, request.bodyId, request.name) };
  // The Boolean severed the target: the largest piece keeps the body, the others become bodies of their own.
  const parts = splitMeshPieces(positionsMm, indices);
  const bodies: GeneralSolidBody[] = [];
  for (const [position, part] of parts.entries()) {
    const ordinal = position + 1;
    bodies.push(await build(part.positionsMm, part.indices, part.sourceTriangles.map((triangle) => origins[triangle]!), ordinal === 1 ? request.bodyId : splitPieceId(request.bodyId, ordinal), ordinal === 1 ? request.name : splitPieceName(request.name, ordinal)));
  }
  return { ok: true, body: bodies[0]!, pieces: bodies.slice(1) };
}
