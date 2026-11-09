import { type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { add, badShape, circumcircle, dist, normalize, polar, scale, sub, turn, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Line, rectangle and slot variants that are placed as real lines and arcs (never as a new entity kind), together
 * with the relations that keep them what they are. Everything here is a pure builder: points in, entities and
 * relations out.
 */

/**
 * Midpoint line: click the centre, then one end. The other end is the mirror image, so the line grows symmetrically.
 * A construction point marks the centre and a Midpoint relation keeps the line centred on it when it is resized.
 */
export function buildMidpointLine(center: Vec2, end: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (dist(center, end) < 0.05) return badShape("A midpoint line needs its end at least 0.05 mm from the centre.");
  const line: SketchEntity = { id: ids.entity(), kind: "line", start: [2 * center[0] - end[0], 2 * center[1] - end[1]], end, construction: false };
  const anchor: SketchEntity = { id: ids.entity(), kind: "point", point: center, construction: true };
  return { ok: true, value: { entities: [line, anchor], constraints: [{ id: ids.constraint(), kind: "midpoint", entityIds: [anchor.id, line.id], points: ["self"] }] } };
}

/**
 * Centerline: a construction line through two clicked points that is extended to `reachMm` on both sides of the first
 * point, so it spans the view it was drawn in. It is construction geometry, so it never bounds a profile; use it as an
 * axis for Revolve, Mirror and Symmetric relations. It is long, not truly infinite: a view that is zoomed out further
 * than its reach shows the line ending.
 */
export function buildCenterline(through: Vec2, direction: Vec2, reachMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (dist(through, direction) < 0.05) return badShape("A centerline needs a direction point at least 0.05 mm from the first point.");
  if (!(reachMm >= 1)) return badShape("A centerline needs a reach of at least 1 mm.");
  const unit = normalize(sub(direction, through));
  const reach = Math.min(reachMm, 9_000);
  const line: SketchEntity = { id: ids.entity(), kind: "line", start: add(through, scale(unit, -reach)), end: add(through, scale(unit, reach)), construction: true };
  return { ok: true, value: { entities: [line], constraints: [] } };
}

/** Parallelogram from three corners: p0 to p1 is one side, p1 to p2 the next, and the fourth corner completes the figure. */
export function buildParallelogram(p0: Vec2, p1: Vec2, p2: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (dist(p0, p1) < 0.05 || dist(p1, p2) < 0.05) return badShape("Each side of a parallelogram must be at least 0.05 mm long.");
  if (Math.abs(turn(p0, p1, p2)) < 0.01) return badShape("The three corners are in a straight line: place the third point away from the first side.");
  const p3: Vec2 = [p0[0] + p2[0] - p1[0], p0[1] + p2[1] - p1[1]];
  // The live solver treats Parallel as "same direction", so the opposite sides are drawn pointing the same way:
  // p0 to p1 and p3 to p2 run along one side pair, p1 to p2 and p0 to p3 along the other.
  const line = (start: Vec2, end: Vec2): SketchEntity => ({ id: ids.entity(), kind: "line", start, end, construction: false });
  const bottom = line(p0, p1);
  const right = line(p1, p2);
  const top = line(p3, p2);
  const left = line(p0, p3);
  const join = (a: SketchEntity, aRef: "start" | "end", b: SketchEntity, bRef: "start" | "end"): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "coincident", entityIds: [a.id, b.id], points: [aRef, bRef] });
  const constraints: WorkbenchSketchConstraint[] = [
    join(bottom, "end", right, "start"),
    join(right, "end", top, "end"),
    join(top, "start", left, "end"),
    join(left, "start", bottom, "start"),
    { id: ids.constraint(), kind: "parallel", entityIds: [bottom.id, top.id] },
    { id: ids.constraint(), kind: "parallel", entityIds: [right.id, left.id] }
  ];
  return { ok: true, value: { entities: [bottom, right, top, left], constraints } };
}

/** The largest corner radius that still leaves a straight piece on every side of a width by height rectangle. */
export function maxRoundedCornerRadius(widthMm: number, heightMm: number): number {
  return Math.max(0, Math.min(widthMm, heightMm) / 2 - 0.02);
}

/**
 * Rounded rectangle from two opposite corners and a corner radius: four lines and four quarter arcs, each arc held
 * tangent to the two lines it joins, the arcs equal, and the lines level or plumb.
 */
export function buildRoundedRectangle(cornerA: Vec2, cornerB: Vec2, radiusMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const x0 = Math.min(cornerA[0], cornerB[0]);
  const x1 = Math.max(cornerA[0], cornerB[0]);
  const y0 = Math.min(cornerA[1], cornerB[1]);
  const y1 = Math.max(cornerA[1], cornerB[1]);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 0.1 || height < 0.1) return badShape("A rounded rectangle needs a width and a height of at least 0.1 mm.");
  if (!Number.isFinite(radiusMm) || radiusMm < 0.01) return badShape("A rounded rectangle needs a corner radius of at least 0.01 mm; use the plain rectangle for square corners.");
  const limit = maxRoundedCornerRadius(width, height);
  if (radiusMm > limit) return badShape(`The corner radius ${Number(radiusMm.toFixed(3))} mm is too large for a ${Number(width.toFixed(3))} by ${Number(height.toFixed(3))} mm rectangle; the most it can take is ${Number(limit.toFixed(3))} mm.`, "Lower the corner radius or draw a larger rectangle.");
  const r = radiusMm;
  const k = Math.SQRT1_2 * r;
  const line = (start: Vec2, end: Vec2): SketchEntity => ({ id: ids.entity(), kind: "line", start, end, construction: false });
  const arc = (start: Vec2, mid: Vec2, end: Vec2): SketchEntity => ({ id: ids.entity(), kind: "arc", start, mid, end, construction: false });
  const bottom = line([x0 + r, y0], [x1 - r, y0]);
  const cornerBR = arc([x1 - r, y0], [x1 - r + k, y0 + r - k], [x1, y0 + r]);
  const right = line([x1, y0 + r], [x1, y1 - r]);
  const cornerTR = arc([x1, y1 - r], [x1 - r + k, y1 - r + k], [x1 - r, y1]);
  const top = line([x1 - r, y1], [x0 + r, y1]);
  const cornerTL = arc([x0 + r, y1], [x0 + r - k, y1 - r + k], [x0, y1 - r]);
  const left = line([x0, y1 - r], [x0, y0 + r]);
  const cornerBL = arc([x0, y0 + r], [x0 + r - k, y0 + r - k], [x0 + r, y0]);
  const ring: readonly SketchEntity[] = [bottom, cornerBR, right, cornerTR, top, cornerTL, left, cornerBL];
  const constraints: WorkbenchSketchConstraint[] = [];
  ring.forEach((entity, index) => {
    // Every joint is a tangent line-and-arc pair: line, arc, line, arc ...
    // The joint also shares its end point, so an edit of one side drags the corner arc along instead of tearing the loop.
    const next = ring[(index + 1) % ring.length]!;
    constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [entity.id, next.id], points: ["end", "start"] });
    constraints.push({ id: ids.constraint(), kind: "tangent", entityIds: [entity.id, next.id] });
  });
  constraints.push(
    { id: ids.constraint(), kind: "equal", entityIds: [cornerBR.id, cornerTR.id] },
    { id: ids.constraint(), kind: "equal", entityIds: [cornerBR.id, cornerTL.id] },
    { id: ids.constraint(), kind: "equal", entityIds: [cornerBR.id, cornerBL.id] },
    { id: ids.constraint(), kind: "horizontal", entityIds: [bottom.id] },
    { id: ids.constraint(), kind: "horizontal", entityIds: [top.id] },
    { id: ids.constraint(), kind: "vertical", entityIds: [right.id] },
    { id: ids.constraint(), kind: "vertical", entityIds: [left.id] }
  );
  return { ok: true, value: { entities: ring, constraints } };
}

/** A centreline arc: centre, radius, start angle and a signed sweep (positive counter-clockwise). */
export interface CenterlineArc {
  readonly center: Vec2;
  readonly radiusMm: number;
  readonly startAngle: number;
  readonly sweep: number;
}

/** Curved slot around a centreline arc: an outer and an inner arc closed by a half-circle cap at each end. */
export function buildArcSlot(arc: CenterlineArc, halfWidthMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const { center, radiusMm: R, startAngle: a0, sweep } = arc;
  const h = halfWidthMm;
  if (!(h >= 0.05)) return badShape("The slot width must be at least 0.1 mm: place the width point away from the centreline arc.");
  if (!(R - h >= 0.05)) return badShape(`The slot is wider than its bend: the half-width ${Number(h.toFixed(3))} mm must stay below the bend radius ${Number(R.toFixed(3))} mm so the inner arc keeps a radius.`, "Place the width point closer to the centreline arc or use a larger bend radius.");
  if (Math.abs(sweep) < 0.01 || Math.abs(sweep) > 2 * Math.PI - 0.05) return badShape("The slot's centreline arc must sweep between about 0.6 degrees and 357 degrees.");
  const a1 = a0 + sweep;
  const aMid = a0 + sweep / 2;
  const direction = sweep > 0 ? 1 : -1;
  // Direction of travel along the centreline at an angle.
  const along = (angle: number): Vec2 => [-direction * Math.sin(angle), direction * Math.cos(angle)];
  const mk = (start: Vec2, mid: Vec2, end: Vec2): SketchEntity => ({ id: ids.entity(), kind: "arc", start, mid, end, construction: false });
  const outerStart = polar(center, R + h, a0);
  const outerEnd = polar(center, R + h, a1);
  const innerStart = polar(center, R - h, a0);
  const innerEnd = polar(center, R - h, a1);
  const endCentre = polar(center, R, a1);
  const startCentre = polar(center, R, a0);
  const outer = mk(outerStart, polar(center, R + h, aMid), outerEnd);
  const endCap = mk(outerEnd, add(endCentre, scale(along(a1), h)), innerEnd);
  const inner = mk(innerEnd, polar(center, R - h, aMid), innerStart);
  const startCap = mk(innerStart, add(startCentre, scale(along(a0), -h)), outerStart);
  // The four joints are tangent by construction. They are not recorded as Tangent relations because the live solver
  // only enforces tangency between a line and an arc, and would misread an arc-to-arc pair as a conflict.
  const constraints: WorkbenchSketchConstraint[] = [
    { id: ids.constraint(), kind: "equal", entityIds: [endCap.id, startCap.id] },
    { id: ids.constraint(), kind: "concentric", entityIds: [outer.id, inner.id] }
  ];
  return { ok: true, value: { entities: [outer, endCap, inner, startCap], constraints } };
}

function signedSweep(startAngle: number, endAngle: number, counterClockwise: boolean): number {
  const full = Math.PI * 2;
  const raw = counterClockwise ? endAngle - startAngle : startAngle - endAngle;
  const wrapped = ((raw % full) + full) % full;
  return counterClockwise ? wrapped : -wrapped;
}

/**
 * 3-point arc slot: the centreline arc runs from `start` through `through` to `end` (these are the cap centres and a
 * point between them), and `widthPoint` sets the half-width as its distance from that arc.
 */
export function buildThreePointArcSlot(start: Vec2, through: Vec2, end: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const circle = circumcircle(start, through, end);
  if (circle === undefined || Math.abs(turn(start, through, end)) < 1e-3) return badShape("The three centreline points of an arc slot must not be in a straight line; use the straight slot for that.");
  const startAngle = Math.atan2(start[1] - circle.center[1], start[0] - circle.center[0]);
  const endAngle = Math.atan2(end[1] - circle.center[1], end[0] - circle.center[0]);
  const sweep = signedSweep(startAngle, endAngle, turn(start, through, end) > 0);
  const half = Math.abs(dist(widthPoint, circle.center) - circle.radiusMm);
  return buildArcSlot({ center: circle.center, radiusMm: circle.radiusMm, startAngle, sweep }, half, ids);
}

/**
 * Centerpoint arc slot: the bend centre, the start of the centreline arc (which sets its radius and where it starts), the
 * direction the arc ends in (the shorter way round, like the centerpoint arc) and a width point.
 */
export function buildCenterpointArcSlot(center: Vec2, start: Vec2, endDirection: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const radius = dist(center, start);
  if (radius < 0.1) return badShape("A centerpoint arc slot needs a bend radius of at least 0.1 mm.");
  if (dist(center, endDirection) < 0.01) return badShape("The slot's end direction must not sit on the bend centre.");
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(endDirection[1] - center[1], endDirection[0] - center[0]);
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  const half = Math.abs(dist(widthPoint, center) - radius);
  return buildArcSlot({ center, radiusMm: radius, startAngle, sweep }, half, ids);
}
