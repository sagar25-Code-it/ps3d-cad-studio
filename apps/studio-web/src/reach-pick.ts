import type { DesignExtentTarget, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { facePlaneOf, nearestMeshVertex, pickableVertices, vertexMarkerSegments, type PickableVertex } from "../../../packages/workbench-geometry/src/index.js";

/** What a click in the 3D view gave: the point, the solid under it, and its face when the solid has named faces. */
export interface ReachClick {
  readonly pointMm: readonly [number, number, number];
  readonly semanticId: string | null;
  readonly faceIndex?: number | null;
  readonly normalMm?: readonly [number, number, number];
  /** The corner found under the pointer on screen, when the view was asked for one. */
  readonly vertexTarget?: { readonly kind: string; readonly bodyId?: string; readonly pointMm?: readonly [number, number, number] };
}

export type ReachPickMode = "face" | "body" | "vertex";

export type ReachPick =
  | { readonly ok: true; readonly target: DesignExtentTarget; readonly description: string }
  | { readonly ok: false; readonly message: string };

/** The corner vertices of every solid, with the solid each belongs to. */
function cornersOf(bodies: readonly GeneralSolidBody[]): readonly { readonly body: GeneralSolidBody; readonly vertices: readonly PickableVertex[] }[] {
  return bodies.flatMap((body) => {
    const vertices = pickableVertices({ positionsMm: body.positionsMm, indices: body.indices });
    return typeof vertices === "string" ? [] : [{ body, vertices }];
  });
}

/** Small crosses on every corner of every solid, drawn while the user is picking a vertex. */
export function vertexPickGuides(bodies: readonly GeneralSolidBody[]): readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[] {
  return cornersOf(bodies).flatMap(({ body, vertices }) => {
    let size = Infinity;
    const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < body.positionsMm.length; index += 1) { const axis = index % 3; min[axis] = Math.min(min[axis]!, body.positionsMm[index]!); max[axis] = Math.max(max[axis]!, body.positionsMm[index]!); }
    size = Math.max(1, 0.04 * Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!));
    return vertexMarkerSegments(vertices, size);
  });
}

/** Turns a click into the target of a "to" extent: the face under it, the solid under it, or the corner nearest it. */
export function reachTargetFromClick(mode: ReachPickMode, click: ReachClick, bodies: readonly GeneralSolidBody[]): ReachPick {
  if (mode === "vertex") {
    const screen = click.vertexTarget;
    if (screen !== undefined && screen.kind === "vertex" && screen.pointMm !== undefined) {
      const owner = bodies.find((candidate) => candidate.id === screen.bodyId);
      if (owner !== undefined) return { ok: true, target: { kind: "vertex", bodyId: owner.id, pointMm: screen.pointMm }, description: `the corner (${screen.pointMm.map((value) => value.toFixed(2)).join(", ")}) mm of ${owner.name}` };
    }
    const all = cornersOf(bodies);
    // The solid under the click wins; a click on empty space takes the nearest corner of any solid.
    const hit = all.find((entry) => entry.body.id === click.semanticId);
    const pool = hit === undefined ? all : [hit];
    let best: { readonly body: GeneralSolidBody; readonly vertex: PickableVertex; readonly distanceMm: number } | undefined;
    for (const { body, vertices } of pool) {
      const nearest = nearestMeshVertex(vertices, click.pointMm);
      if (nearest !== undefined && (best === undefined || nearest.distanceMm < best.distanceMm)) best = { body, vertex: nearest.vertex, distanceMm: nearest.distanceMm };
    }
    if (best === undefined) return { ok: false, message: "No solid has a corner vertex to pick. Vertices are where three differently facing surfaces meet." };
    return { ok: true, target: { kind: "vertex", bodyId: best.body.id, pointMm: best.vertex.pointMm }, description: `the corner (${best.vertex.pointMm.map((value) => value.toFixed(2)).join(", ")}) mm of ${best.body.name}, ${best.distanceMm.toFixed(1)} mm from your click` };
  }
  const body = bodies.find((candidate) => candidate.id === click.semanticId);
  if (body === undefined) return { ok: false, message: "Click on a solid." };
  if (mode === "body") return { ok: true, target: { kind: "body", bodyId: body.id, pointMm: click.pointMm }, description: body.name };
  const face = click.faceIndex === undefined || click.faceIndex === null ? undefined : body.brep?.faces[click.faceIndex];
  if (face === undefined || body.brep === undefined) return { ok: false, message: `Click one of the named faces of ${body.name}.` };
  const plane = facePlaneOf({ positionsMm: body.positionsMm, indices: body.indices, faceTriangles: body.brep.faceTriangles }, click.faceIndex!);
  const normal = plane !== undefined && plane.planar ? plane.normal : click.normalMm;
  return { ok: true, target: { kind: "face", bodyId: body.id, faceRole: face.role, pointMm: plane !== undefined && plane.planar ? plane.pointMm : click.pointMm, ...(normal === undefined ? {} : { normal }) }, description: `face ${face.role.replace(/^face\./, "")} of ${body.name}` };
}
