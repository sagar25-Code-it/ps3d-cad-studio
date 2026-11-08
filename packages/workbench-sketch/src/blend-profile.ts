import { type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { add, badShape, circumcircle, dist, normalize, polar, sampleCurveToFitPoints, scale, splineFromPoints, sub, turn, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Blend (bridge) curve between two curve ends, and the Profile tool that chains lines and tangent arcs end to end.
 * Both are pure builders over the existing line, arc and spline entities.
 */

// ---------------------------------------------------------------- curve ends

/** One end of an open curve: where it is and the unit direction in which the curve leaves it (pointing away from the curve). */
export interface CurveEnd {
  readonly entityId: string;
  readonly which: "start" | "end";
  readonly point: Vec2;
  readonly outward: Vec2;
}

/** The two ends of a line, arc or fit-point spline; none for closed or point-like entities. */
export function curveEnds(entity: SketchEntity): readonly CurveEnd[] {
  if (entity.kind === "line") {
    const direction = normalize(sub(entity.end, entity.start));
    return [
      { entityId: entity.id, which: "start", point: entity.start, outward: scale(direction, -1) },
      { entityId: entity.id, which: "end", point: entity.end, outward: direction }
    ];
  }
  if (entity.kind === "arc") {
    const circle = circumcircle(entity.start, entity.mid, entity.end);
    if (circle === undefined) return [];
    const counterClockwise = turn(entity.start, entity.mid, entity.end) > 0;
    const travel = (point: Vec2): Vec2 => {
      const radial = normalize(sub(point, circle.center));
      return counterClockwise ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
    };
    return [
      { entityId: entity.id, which: "start", point: entity.start, outward: scale(travel(entity.start), -1) },
      { entityId: entity.id, which: "end", point: entity.end, outward: travel(entity.end) }
    ];
  }
  if (entity.kind === "spline") {
    const fit = entity.fitPoints;
    const last = fit.length - 1;
    return [
      { entityId: entity.id, which: "start", point: fit[0]!, outward: normalize(sub(fit[0]!, fit[1]!)) },
      { entityId: entity.id, which: "end", point: fit[last]!, outward: normalize(sub(fit[last]!, fit[last - 1]!)) }
    ];
  }
  return [];
}

/** The curve end nearest to a point, within `reachMm`. */
export function nearestCurveEnd(entities: readonly SketchEntity[], point: Vec2, reachMm: number): CurveEnd | undefined {
  let best: CurveEnd | undefined;
  let bestDistance = reachMm;
  for (const entity of entities) {
    if (entity.visible === false) continue;
    for (const end of curveEnds(entity)) {
      const gap = dist(end.point, point);
      if (gap <= bestDistance) { best = end; bestDistance = gap; }
    }
  }
  return best;
}

// ---------------------------------------------------------------- blend curve

export const BLEND_TENSION_MIN = 0.2;
export const BLEND_TENSION_MAX = 3;

/** The cubic Bezier a blend follows: it leaves each end along that end's tangent, so the join has no kink (G1). */
export function blendBezier(a: CurveEnd, b: CurveEnd, tension: number): readonly [Vec2, Vec2, Vec2, Vec2] {
  const handle = (tension * dist(a.point, b.point)) / 3;
  return [a.point, add(a.point, scale(a.outward, handle)), add(b.point, scale(b.outward, handle)), b.point];
}

export function blendPoint(curve: readonly [Vec2, Vec2, Vec2, Vec2], t: number): Vec2 {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [w0 * curve[0][0] + w1 * curve[1][0] + w2 * curve[2][0] + w3 * curve[3][0], w0 * curve[0][1] + w1 * curve[1][1] + w2 * curve[2][1] + w3 * curve[3][1]];
}

/**
 * Blend curve between two clicked curve ends. It starts and ends exactly on those ends and leaves each along its tangent
 * (tangent continuity, G1); `tension` scales how far it keeps to the tangent before turning. It is stored as a fit-point
 * spline, so it joins the loop it bridges into a profile. Curvature continuity (G2) is not made.
 */
export function buildBlendCurve(entities: readonly SketchEntity[], firstClick: Vec2, secondClick: Vec2, tension: number, reachMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (!Number.isFinite(tension) || tension < BLEND_TENSION_MIN || tension > BLEND_TENSION_MAX) return badShape(`Blend tension must be between ${BLEND_TENSION_MIN} and ${BLEND_TENSION_MAX}.`, "Type a tension in that range; 1 is the natural bridge.");
  const first = nearestCurveEnd(entities, firstClick, reachMm);
  if (first === undefined) return badShape("Click close to the end of a line, arc or spline for the first end of the blend.", "Click nearer a curve end, or press Esc to start over.");
  const second = nearestCurveEnd(entities, secondClick, reachMm);
  if (second === undefined) return badShape("Click close to the end of a line, arc or spline for the second end of the blend.", "Click nearer a curve end, or press Esc to start over.");
  if (first.entityId === second.entityId && first.which === second.which) return badShape("Pick two different curve ends to bridge.");
  if (dist(first.point, second.point) < 0.2) return badShape("The two curve ends are already together: there is no gap to bridge.");
  const bezier = blendBezier(first, second, tension);
  const fit = sampleCurveToFitPoints((t) => blendPoint(bezier, t), 0, 1, 24, 480, 0.01);
  const spline = splineFromPoints(fit, ids.entity());
  return spline.ok ? { ok: true, value: { entities: [spline.value], constraints: [] } } : spline;
}

// ---------------------------------------------------------------- profile chain

export type ProfileSegmentMode = "line" | "tangent-arc";

/** The state of a Profile being drawn: where it began, where it is now and which way it is heading. */
export interface ProfileChain {
  readonly start: Vec2;
  readonly tail: Vec2;
  /** Unit direction of travel at the tail, or undefined before the first segment. */
  readonly tailTangent: Vec2 | undefined;
  readonly tailId: string | undefined;
  readonly tailKind: "line" | "arc" | undefined;
  readonly firstId: string | undefined;
  readonly firstKind: "line" | "arc" | undefined;
  readonly segments: number;
}

export function startProfileChain(point: Vec2): ProfileChain {
  return { start: point, tail: point, tailTangent: undefined, tailId: undefined, tailKind: undefined, firstId: undefined, firstKind: undefined, segments: 0 };
}

export interface ProfileStep {
  readonly entity: SketchEntity;
  readonly constraints: readonly WorkbenchSketchConstraint[];
  readonly chain: ProfileChain;
  /** True when the segment ended on the profile's start: the loop is closed and the chain is over. */
  readonly closed: boolean;
}

/** The arc that leaves `anchor` along `tangent` and ends at `end`, with the direction it travels at its end. */
export function tangentArcFrom(anchor: Vec2, tangent: Vec2, end: Vec2): WorkbenchResult<{ readonly arc: { readonly start: Vec2; readonly mid: Vec2; readonly end: Vec2 }; readonly endTangent: Vec2 }> {
  const normal: Vec2 = [-tangent[1], tangent[0]];
  const d = sub(end, anchor);
  const lengthSquared = d[0] * d[0] + d[1] * d[1];
  if (lengthSquared < 1e-4) return badShape("The arc end must be at least 0.01 mm from where it starts.");
  const dn = d[0] * normal[0] + d[1] * normal[1];
  if (Math.abs(dn) < 1e-3 * Math.sqrt(lengthSquared)) return badShape("That end is straight ahead of the tangent, so the arc would be a straight line: use Line, or place the end to one side.");
  const signedRadius = lengthSquared / (2 * dn);
  const radius = Math.abs(signedRadius);
  if (radius < 0.01 || radius > 1e6) return badShape("The tangent arc's radius would be below 0.01 mm or absurdly large.");
  const center = add(anchor, scale(normal, signedRadius));
  const counterClockwise = signedRadius > 0;
  const startAngle = Math.atan2(anchor[1] - center[1], anchor[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const full = Math.PI * 2;
  const sweep = ((((counterClockwise ? endAngle - startAngle : startAngle - endAngle) % full) + full) % full);
  if (sweep < 1e-4) return badShape("The tangent arc has no sweep.");
  const midAngle = startAngle + (counterClockwise ? 1 : -1) * (sweep / 2);
  const radial = normalize(sub(end, center));
  const endTangent: Vec2 = counterClockwise ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
  return { ok: true, value: { arc: { start: anchor, mid: polar(center, radius, midAngle), end }, endTangent } };
}

/**
 * Adds one segment to a Profile: a straight line, or an arc that leaves the previous segment tangentially. A line after a
 * line is joined by a Coincident relation, an arc is held Tangent to what precedes it. Ending within `closeToleranceMm` of
 * the start (after at least two segments) snaps onto the start and closes the loop.
 */
export function extendProfileChain(chain: ProfileChain, point: Vec2, mode: ProfileSegmentMode, closeToleranceMm: number, ids: ShapeIds): WorkbenchResult<ProfileStep> {
  const closes = chain.segments >= 2 && dist(point, chain.start) <= closeToleranceMm;
  const end: Vec2 = closes ? chain.start : point;
  const id = ids.entity();
  let entity: SketchEntity;
  let tangent: Vec2;
  let kind: "line" | "arc";
  if (mode === "line") {
    if (dist(chain.tail, end) < 0.01) return badShape("A profile line must be at least 0.01 mm long.");
    entity = { id, kind: "line", start: chain.tail, end, construction: false };
    tangent = normalize(sub(end, chain.tail));
    kind = "line";
  } else {
    if (chain.tailTangent === undefined) return badShape("A tangent arc continues the previous segment: draw a line first, then switch to Tangent arc.", "Draw one line first, or choose the Line segment type.");
    const arc = tangentArcFrom(chain.tail, chain.tailTangent, end);
    if (!arc.ok) return arc;
    entity = { id, kind: "arc", ...arc.value.arc, construction: false };
    tangent = arc.value.endTangent;
    kind = "arc";
  }
  const constraints: WorkbenchSketchConstraint[] = [];
  if (chain.tailId !== undefined) {
    // The live solver only enforces tangency between a line and an arc, so an arc that follows an arc is tangent by construction only.
    if (mode === "tangent-arc") { if (chain.tailKind === "line") constraints.push({ id: ids.constraint(), kind: "tangent", entityIds: [chain.tailId, id] }); }
    else if (chain.tailKind === "line") constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [chain.tailId, id], points: ["end", "start"] });
  }
  // Closing joint between two lines.
  if (closes && kind === "line" && chain.firstKind === "line" && chain.firstId !== undefined) {
    constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [id, chain.firstId], points: ["end", "start"] });
  }
  const next: ProfileChain = {
    start: chain.start,
    tail: end,
    tailTangent: tangent,
    tailId: id,
    tailKind: kind,
    firstId: chain.firstId ?? id,
    firstKind: chain.firstKind ?? kind,
    segments: chain.segments + 1
  };
  return { ok: true, value: { entity, constraints, chain: next, closed: closes } };
}
