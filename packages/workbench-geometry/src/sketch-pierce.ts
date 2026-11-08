import type {
  ConstructionAxis,
  GeneralSolidBody,
  SketchEntity,
  SketchPierceReference,
  Vec2,
  Vec3,
  WorkbenchOperation,
  WorkbenchProject,
  WorkbenchSketch
} from "../../workbench-core/src/index.js";
import { evaluateConstructionAxis } from "./construction-geometry.js";
import { pickableEdges } from "./mesh-modify.js";
import { placeDirection, placePoint, type SketchPlacement } from "./sketch-placement.js";

/**
 * Pierce: a sketch point held where a construction axis or a body edge crosses the sketch plane.
 *
 * The sketch plane is the datum plane (XY, XZ or YZ) moved along its normal by the plane offset, then turned by the plane tilt
 * or moved onto the three-point frame (see `sketch-placement.ts`). To find a crossing the line or edge is taken back into the
 * datum plane's own frame (`placePoint` with `inverse`), where the plane is `normal . p = offset` and the sketch coordinates are
 * two of the world coordinates; that is the same mapping the extruded solids use, so a point found here sits exactly where
 * geometry drawn in the sketch lands in the world.
 */

type PlaneName = "datum:xy" | "datum:xz" | "datum:yz";

const NORMALS: Readonly<Record<PlaneName, Vec3>> = { "datum:xy": [0, 0, 1], "datum:xz": [0, -1, 0], "datum:yz": [1, 0, 0] };

/** The sketch coordinates (u, v) of a point in the datum plane's own frame. */
function datumToSketch(plane: PlaneName, point: Vec3): Vec2 {
  if (plane === "datum:xz") return [point[0], point[2]];
  if (plane === "datum:yz") return [-point[2], point[1]];
  return [point[0], point[1]];
}

/** The point in the datum plane's own frame at sketch coordinates (u, v), on the plane moved `offsetMm` along its normal. */
function sketchToDatum(plane: PlaneName, uv: Vec2, offsetMm: number): Vec3 {
  if (plane === "datum:xz") return [uv[0], -offsetMm, uv[1]];
  if (plane === "datum:yz") return [offsetMm, uv[1], -uv[0]];
  return [uv[0], uv[1], offsetMm];
}

type PlacedSketch = Pick<WorkbenchSketch, "plane" | "planeOffsetMm" | "planeTilt" | "planeFrame">;

function placementOf(sketch: PlacedSketch): SketchPlacement {
  return { planeTilt: sketch.planeTilt, planeFrame: sketch.planeFrame };
}

/** World position of a point on the sketch plane. */
export function sketchPointToWorld(sketch: PlacedSketch, uv: Vec2): Vec3 {
  return placePoint(sketchToDatum(sketch.plane, uv, sketch.planeOffsetMm ?? 0), placementOf(sketch));
}

/** Sketch coordinates of a world point projected along the plane's normal, and how far the point stands from the plane (signed, along the normal). */
export function worldToSketchPoint(sketch: PlacedSketch, world: Vec3): { readonly uv: Vec2; readonly heightMm: number } {
  const datum = placePoint(world, placementOf(sketch), true);
  const normal = NORMALS[sketch.plane];
  return { uv: datumToSketch(sketch.plane, datum), heightMm: normal[0] * datum[0] + normal[1] * datum[1] + normal[2] * datum[2] - (sketch.planeOffsetMm ?? 0) };
}

export interface PierceHit {
  /** The crossing in sketch coordinates. */
  readonly pointMm: Vec2;
  /** The crossing in world coordinates. */
  readonly worldMm: Vec3;
  /** What crosses the plane there. */
  readonly reference: SketchPierceReference;
  /** A short name for the crossing, for the list a person picks from. */
  readonly label: string;
}

export type PierceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Where an infinite line (a point and a direction in world coordinates) crosses the sketch plane. */
export function linePlaneCrossing(sketch: PlacedSketch, origin: Vec3, direction: Vec3): PierceResult<{ readonly pointMm: Vec2; readonly worldMm: Vec3; readonly t: number }> {
  const placement = placementOf(sketch);
  const o = placePoint(origin, placement, true);
  const d = placeDirection(direction, placement, true);
  const normal = NORMALS[sketch.plane];
  const speed = Math.hypot(d[0], d[1], d[2]);
  const across = normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2];
  if (speed < 1e-12) return { ok: false, message: "The direction has no length." };
  const height = normal[0] * o[0] + normal[1] * o[1] + normal[2] * o[2] - (sketch.planeOffsetMm ?? 0);
  if (Math.abs(across) < 1e-9 * speed) {
    return { ok: false, message: Math.abs(height) < 1e-6 ? "The axis lies in the sketch plane, so it crosses it everywhere." : "The axis runs parallel to the sketch plane, so it never crosses it." };
  }
  const t = -height / across;
  const point: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  return { ok: true, value: { pointMm: datumToSketch(sketch.plane, point), worldMm: placePoint(point, placement), t } };
}

/** Where a construction axis crosses the sketch plane. */
export function axisPierce(sketch: PlacedSketch, axis: ConstructionAxis, bodies: readonly GeneralSolidBody[] = []): PierceResult<PierceHit> {
  const frame = evaluateConstructionAxis(axis, bodies);
  if ("error" in frame) return { ok: false, message: frame.error };
  const crossing = linePlaneCrossing(sketch, frame.origin, frame.direction);
  if (!crossing.ok) return crossing;
  return { ok: true, value: { pointMm: crossing.value.pointMm, worldMm: crossing.value.worldMm, reference: { kind: "axis", axisId: axis.id }, label: `${axis.name} axis` } };
}

/** Every place the sharp edges of a body cross the sketch plane, grouped by edge chain (the chain number is the pierce reference). Edges lying in the plane are skipped. */
export function bodyEdgePierces(sketch: PlacedSketch, body: GeneralSolidBody): PierceResult<readonly PierceHit[]> {
  const edges = pickableEdges(body);
  if (typeof edges === "string") return { ok: false, message: edges };
  const placement = placementOf(sketch);
  const normal = NORMALS[sketch.plane];
  const offset = sketch.planeOffsetMm ?? 0;
  const heightOf = (point: Vec3): number => normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] - offset;
  const hits: PierceHit[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const a = placePoint(edge.a, placement, true);
    const b = placePoint(edge.b, placement, true);
    const ha = heightOf(a);
    const hb = heightOf(b);
    if (Math.abs(ha) < 1e-9 && Math.abs(hb) < 1e-9) continue;
    if (ha * hb > 0) continue;
    const t = ha / (ha - hb);
    const point: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const pointMm = datumToSketch(sketch.plane, point);
    // An edge that ends exactly on the plane is met by the neighbouring edge too; report the crossing once.
    const key = `${edge.chain}:${Math.round(pointMm[0] * 1e6)}:${Math.round(pointMm[1] * 1e6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ pointMm, worldMm: placePoint(point, placement), reference: { kind: "body-edge", bodyId: body.id, chain: edge.chain }, label: `${body.name} edge ${edge.chain + 1}` });
  }
  return { ok: true, value: hits };
}

/** Every axis and body-edge crossing of the working sketch plane in a project, for the list a person picks a Pierce point from. */
export function listPierceHits(project: WorkbenchProject): readonly PierceHit[] {
  const bodies = project.part.generalBodies ?? [];
  const hits: PierceHit[] = [];
  for (const axis of project.part.constructionAxes ?? []) {
    const hit = axisPierce(project.sketch, axis, bodies);
    if (hit.ok) hits.push(hit.value);
  }
  for (const body of bodies) {
    const crossings = bodyEdgePierces(project.sketch, body);
    if (crossings.ok) hits.push(...crossings.value);
  }
  return hits;
}

/**
 * Where a Pierce reference puts its point now. A body-edge chain can cross the plane in several places; the crossing nearest
 * `near` (the point's current position) is kept, so the point does not jump between them when the model changes.
 */
export function resolvePierce(project: WorkbenchProject, reference: SketchPierceReference, near?: Vec2): PierceResult<PierceHit> {
  const bodies = project.part.generalBodies ?? [];
  if (reference.kind === "axis") {
    const axis = (project.part.constructionAxes ?? []).find((candidate) => candidate.id === reference.axisId);
    if (axis === undefined) return { ok: false, message: "The construction axis this point pierces is no longer in the part." };
    return axisPierce(project.sketch, axis, bodies);
  }
  const body = bodies.find((candidate) => candidate.id === reference.bodyId);
  if (body === undefined) return { ok: false, message: "The body this point pierces is no longer in the part." };
  const crossings = bodyEdgePierces(project.sketch, body);
  if (!crossings.ok) return crossings;
  const onChain = crossings.value.filter((hit) => hit.reference.kind === "body-edge" && hit.reference.chain === reference.chain);
  if (onChain.length === 0) return { ok: false, message: `Edge ${reference.chain + 1} of ${body.name} does not cross the sketch plane.` };
  if (near === undefined) return { ok: true, value: onChain[0]! };
  const closest = [...onChain].sort((left, right) => Math.hypot(left.pointMm[0] - near[0], left.pointMm[1] - near[1]) - Math.hypot(right.pointMm[0] - near[0], right.pointMm[1] - near[1]))[0]!;
  return { ok: true, value: closest };
}

type SketchEditOperation = Extract<WorkbenchOperation, { readonly kind: "apply-sketch-edit" }>;
type SketchEditPayload = Omit<SketchEditOperation, "operationId" | "expectedRevision">;

/** The edit that adds a sketch point at a crossing and records the Pierce constraint that holds it there. */
export function createPierceEdit(project: WorkbenchProject, hit: PierceHit, ids: { readonly entityId: string; readonly constraintId: string }): SketchEditPayload {
  const point: SketchEntity = { id: ids.entityId, kind: "point", point: hit.pointMm, construction: false };
  return {
    kind: "apply-sketch-edit",
    removeEntityIds: [],
    updateEntities: [],
    addEntities: [point],
    addConstraints: [{ id: ids.constraintId, kind: "pierce", entityIds: [ids.entityId], pierce: hit.reference }],
    label: `Pierce point at ${hit.label}`
  };
}

export interface PierceRefresh {
  /** The points that have to move to stay on their crossing, already moved. */
  readonly updates: readonly SketchEntity[];
  /** One line per Pierce constraint that could not be resolved (its axis or edge is gone, or it no longer crosses the plane). */
  readonly unresolved: readonly { readonly constraintId: string; readonly message: string }[];
}

/** Re-evaluates every active Pierce constraint against the project's axes, bodies and sketch plane. */
export function refreshPierceConstraints(project: WorkbenchProject): PierceRefresh {
  const updates: SketchEntity[] = [];
  const unresolved: { constraintId: string; message: string }[] = [];
  for (const constraint of project.sketch.constraints) {
    if (constraint.kind !== "pierce" || constraint.suppressed === true || constraint.pierce === undefined) continue;
    const entity = project.sketch.entities.find((candidate) => candidate.id === constraint.entityIds[0]);
    if (entity?.kind !== "point") continue;
    const resolved = resolvePierce(project, constraint.pierce, entity.point);
    if (!resolved.ok) { unresolved.push({ constraintId: constraint.id, message: resolved.message }); continue; }
    if (Math.hypot(resolved.value.pointMm[0] - entity.point[0], resolved.value.pointMm[1] - entity.point[1]) > 1e-9) updates.push({ ...entity, point: resolved.value.pointMm });
  }
  return { updates, unresolved };
}

/** The sketch edit that moves stale Pierce points onto their crossings, or undefined when every Pierce point is already in place. */
export function pierceRefreshEdit(project: WorkbenchProject): SketchEditPayload | undefined {
  const refresh = refreshPierceConstraints(project);
  if (refresh.updates.length === 0) return undefined;
  return { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: refresh.updates, addEntities: [], addConstraints: [], label: "Follow Pierce points" };
}
