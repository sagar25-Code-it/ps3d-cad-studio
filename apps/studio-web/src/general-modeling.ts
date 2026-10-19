import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { revolveAxisRelation, tessellateRevolve, type TessellatePlane } from "../../../packages/workbench-geometry/src/index.js";
import { evaluateProfilePrism, evaluateProfileRevolution } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import { profileOutlineMm, stableEntityToken, type SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import type { ProfileEdgeGroup, ProfileHole } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";

/** Sketch-plane identifier shared with the solid builder UI. */
export type SketchPlane = TessellatePlane;

type PolygonPoint = readonly [number, number];
type WorldPoint = readonly [number, number, number];

/** Convert a detected sketch profile boundary into a closed polygon (millimetres). */
function profilePolygonMm(boundary: SketchProfile["boundary"]): readonly PolygonPoint[] {
  return profileOutlineMm(boundary).map((point) => [point[0], point[1]] as PolygonPoint);
}

/** One kernel side face per sketch entity of a curve loop, so arcs stay single cylindrical walls with stable names. */
function curveEdgeGroups(boundary: SketchProfile["boundary"], rolePrefix: string): readonly ProfileEdgeGroup[] | undefined {
  if (boundary.kind !== "curve-loop") return undefined;
  return boundary.segments.map((segment) => ({ role: `${rolePrefix}-${stableEntityToken([segment.entityId])}`, edgeCount: segment.edgeCount, curved: segment.kind === "arc" }));
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
  readonly operation: "extrude" | "revolve";
  /** Extrusion height in millimetres, or revolve angle in degrees. */
  readonly valueMm: number;
  readonly bodyId: string;
  readonly name: string;
  readonly color: string;
  /** Optional chamfer or fillet of the extruded prism's vertical edges (extrude only). */
  readonly edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number };
  /** Profiles that lie inside `profile` and are cut through it (extrude only). */
  readonly holes?: readonly SketchProfile[];
}

/** Maps a hole profile to the kernel's hole loop; the id comes from its sketch entities so wall names survive edits. */
function kernelHole(profile: SketchProfile, plane: SketchPlane): ProfileHole {
  const points = profilePolygonMm(profile.boundary).map((point) => placeOnPlane(point, plane));
  const id = stableEntityToken(profile.entityIds);
  const groups = curveEdgeGroups(profile.boundary, `face.hole-${id}-seg`);
  return {
    id,
    points,
    ...(profile.boundary.kind === "circle" ? { smoothSides: true } : {}),
    ...(groups === undefined ? {} : { edgeGroups: groups })
  };
}

export type CreateGeneralSolidResult =
  | { readonly ok: true; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

/**
 * Build a general mesh-solid body from a sketch profile.
 *
 * Extrude runs through the reference B-rep kernel (browser-safe): the body
 * carries the kernel's watertight tessellation plus its exact topology summary
 * and stable, lineage-anchored face names. Revolve still uses the analytic
 * tessellator because the reference kernel does not yet evaluate revolves.
 */
export async function createGeneralSolidBody(request: CreateGeneralSolidRequest): Promise<CreateGeneralSolidResult> {
  const polygonMm = profilePolygonMm(request.profile.boundary);
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

  if (request.operation === "extrude") {
    if (request.edge !== undefined) {
      if (request.profile.boundary.kind === "circle") return { ok: false, message: "Chamfer and fillet apply to polygon and rectangle profiles; a circle has no corners to treat." };
      if (request.profile.boundary.kind === "curve-loop") return { ok: false, message: "Chamfer and fillet are not available for profiles that contain arcs yet." };
      if (!Number.isFinite(request.edge.sizeMm) || request.edge.sizeMm <= 0) return { ok: false, message: `Enter a positive ${request.edge.kind === "chamfer" ? "chamfer distance" : "fillet radius"}.` };
    }
    const holes = request.holes ?? [];
    if (holes.length > 0 && request.edge !== undefined) return { ok: false, message: "Chamfer and fillet are not available for a profile with holes yet. Extrude without an edge treatment, or select the outer profile alone." };
    const outerGroups = curveEdgeGroups(request.profile.boundary, "face.seg");
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
        ...(holes.length === 0 ? {} : { holes: holes.map((hole) => kernelHole(hole, request.plane)) }),
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
        }
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      // The kernel's profile and treatment checks name what to fix (crossing outline, hole outside, corner too large), so show them.
      return { ok: false, message: detail !== "" ? `The solid kernel could not extrude this profile: ${detail}` : "The solid kernel could not extrude this profile." };
    }
  }
  if ((request.holes?.length ?? 0) > 0) return { ok: false, message: "Revolve does not support profiles with holes. Select the outer profile alone." };

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
        degrees: request.valueMm
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
