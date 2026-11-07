import type { SketchEntity, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { entityPoints, sampleSpline } from "./index.js";

/**
 * Cursor inference for the sketch canvas: while a tool is active the pointer snaps to the most meaningful nearby geometry
 * (endpoints, centres, midpoints, quadrants, intersections, the foot of a perpendicular, a tangent point, a point on a
 * curve) or lines up horizontally and vertically with existing points and with the point just placed.
 *
 * Everything here is pure: it takes the pointer, the sketch and a reach in millimetres, and returns the snapped point plus
 * the reason, so the canvas can draw a glyph for it and the tools can turn it into constraints.
 */
export type InferenceKind =
  | "endpoint"
  | "center"
  | "origin"
  | "midpoint"
  | "quadrant"
  | "intersection"
  | "perpendicular"
  | "tangent"
  | "on-curve"
  | "horizontal"
  | "vertical"
  | "grid";

/** Which defining point of an entity an inference landed on. */
export type InferenceSelector = "start" | "end" | "center" | "mid" | "point" | "corner";

export interface InferenceCandidate {
  readonly kind: InferenceKind;
  readonly point: Vec2;
  readonly entityId?: string;
  readonly otherEntityId?: string;
  readonly selector?: InferenceSelector;
  readonly distanceMm: number;
}

export interface InferenceGuide {
  readonly kind: "horizontal" | "vertical";
  readonly from: Vec2;
  readonly to: Vec2;
}

export interface InferenceResult {
  readonly point: Vec2;
  readonly snapped: boolean;
  readonly primary?: InferenceCandidate;
  readonly guides: readonly InferenceGuide[];
}

export interface InferenceOptions {
  /** Snap reach in millimetres (the canvas passes a fixed number of screen pixels). */
  readonly toleranceMm: number;
  /** Grid spacing to snap to when nothing else applies; omit to disable grid snapping. */
  readonly gridMm?: number;
  /** The last point placed by the active tool: enables perpendicular, tangent and alignment from it. */
  readonly anchor?: Vec2;
  /** Entities to ignore, for example the ones being dragged. */
  readonly excludeEntityIds?: readonly string[];
}

export const INFERENCE_LABELS: Readonly<Record<InferenceKind, string>> = {
  endpoint: "Endpoint",
  center: "Center",
  origin: "Origin",
  midpoint: "Midpoint",
  quadrant: "Quadrant",
  intersection: "Intersection",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  "on-curve": "On curve",
  horizontal: "Horizontal",
  vertical: "Vertical",
  grid: "Grid"
};

/** Lower tiers win: an endpoint inside the reach always beats a point on a curve, which beats the grid. */
const TIER: Readonly<Record<InferenceKind, number>> = {
  endpoint: 0, center: 0, origin: 0,
  // Within the second tier an intersection is the most informative label when several coincide.
  intersection: 1, midpoint: 1.1, quadrant: 1.2,
  perpendicular: 2, tangent: 2,
  "on-curve": 3,
  horizontal: 4, vertical: 4,
  grid: 5
};

/** A point on a curve is a weaker hint than a named point, so it needs the pointer to be closer. */
const ON_CURVE_REACH = 0.6;
const EPSILON = 1e-9;

type Segment = { readonly kind: "segment"; readonly a: Vec2; readonly b: Vec2 };
type Round = { readonly kind: "round"; readonly center: Vec2; readonly radius: number; readonly startAngle: number; readonly sweep: number; readonly full: boolean };
type Primitive = Segment | Round;

const TWO_PI = Math.PI * 2;

function wrap(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < EPSILON) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  ];
  return { center, radius: dist(center, a) };
}

function arcPrimitive(start: Vec2, mid: Vec2, end: Vec2): Round | undefined {
  const circle = circumcircle(start, mid, end);
  if (circle === undefined) return undefined;
  const counterClockwise = (mid[0] - start[0]) * (end[1] - start[1]) - (mid[1] - start[1]) * (end[0] - start[0]) > 0;
  // A 3-point arc runs start -> mid -> end; normalise it to a counter-clockwise sweep.
  const from = counterClockwise ? start : end;
  const to = counterClockwise ? end : start;
  const startAngle = Math.atan2(from[1] - circle.center[1], from[0] - circle.center[0]);
  const sweep = wrap(Math.atan2(to[1] - circle.center[1], to[0] - circle.center[0]) - startAngle);
  return { kind: "round", center: circle.center, radius: circle.radius, startAngle, sweep, full: false };
}

function primitivesOf(entity: SketchEntity): readonly Primitive[] {
  if (entity.kind === "line") return [{ kind: "segment", a: entity.start, b: entity.end }];
  if (entity.kind === "circle") return [{ kind: "round", center: entity.center, radius: entity.radiusMm, startAngle: 0, sweep: TWO_PI, full: true }];
  if (entity.kind === "arc") {
    const arc = arcPrimitive(entity.start, entity.mid, entity.end);
    return arc === undefined ? [{ kind: "segment", a: entity.start, b: entity.end }] : [arc];
  }
  if (entity.kind === "rectangle") {
    const corners = entityPoints(entity);
    return corners.map((corner, index): Primitive => ({ kind: "segment", a: corner, b: corners[(index + 1) % corners.length]! }));
  }
  if (entity.kind === "spline") {
    const samples = sampleSpline(entity.fitPoints);
    return samples.slice(1).map((sample, index): Primitive => ({ kind: "segment", a: samples[index]!, b: sample }));
  }
  return [];
}

function onSweep(round: Round, angle: number): boolean {
  return round.full || wrap(angle - round.startAngle) <= round.sweep + 1e-9;
}

function pointOnRound(round: Round, angle: number): Vec2 {
  return [round.center[0] + round.radius * Math.cos(angle), round.center[1] + round.radius * Math.sin(angle)];
}

function nearestOnPrimitive(point: Vec2, primitive: Primitive): { readonly point: Vec2; readonly distance: number } | undefined {
  if (primitive.kind === "segment") {
    const dx = primitive.b[0] - primitive.a[0];
    const dy = primitive.b[1] - primitive.a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared < EPSILON ? 0 : Math.min(1, Math.max(0, ((point[0] - primitive.a[0]) * dx + (point[1] - primitive.a[1]) * dy) / lengthSquared));
    const foot: Vec2 = [primitive.a[0] + dx * t, primitive.a[1] + dy * t];
    return { point: foot, distance: dist(point, foot) };
  }
  const offset = dist(point, primitive.center);
  if (offset < EPSILON) return undefined;
  const angle = Math.atan2(point[1] - primitive.center[1], point[0] - primitive.center[0]);
  if (onSweep(primitive, angle)) {
    const foot = pointOnRound(primitive, angle);
    return { point: foot, distance: Math.abs(offset - primitive.radius) };
  }
  const start = pointOnRound(primitive, primitive.startAngle);
  const end = pointOnRound(primitive, primitive.startAngle + primitive.sweep);
  const nearStart = dist(point, start) <= dist(point, end);
  const endpoint = nearStart ? start : end;
  return { point: endpoint, distance: dist(point, endpoint) };
}

function intersectSegments(first: Segment, second: Segment): readonly Vec2[] {
  const rx = first.b[0] - first.a[0];
  const ry = first.b[1] - first.a[1];
  const sx = second.b[0] - second.a[0];
  const sy = second.b[1] - second.a[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < EPSILON) return [];
  const qpx = second.a[0] - first.a[0];
  const qpy = second.a[1] - first.a[1];
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  const slack = 1e-9;
  if (t < -slack || t > 1 + slack || u < -slack || u > 1 + slack) return [];
  return [[first.a[0] + rx * t, first.a[1] + ry * t]];
}

function intersectSegmentRound(segment: Segment, round: Round): readonly Vec2[] {
  const dx = segment.b[0] - segment.a[0];
  const dy = segment.b[1] - segment.a[1];
  const fx = segment.a[0] - round.center[0];
  const fy = segment.a[1] - round.center[1];
  const a = dx * dx + dy * dy;
  if (a < EPSILON) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - round.radius * round.radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  const hits: Vec2[] = [];
  for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const point: Vec2 = [segment.a[0] + dx * t, segment.a[1] + dy * t];
    if (onSweep(round, Math.atan2(point[1] - round.center[1], point[0] - round.center[0]))) hits.push(point);
    if (discriminant === 0) break;
  }
  return hits;
}

function intersectRounds(first: Round, second: Round): readonly Vec2[] {
  const d = dist(first.center, second.center);
  if (d < EPSILON || d > first.radius + second.radius + 1e-9 || d < Math.abs(first.radius - second.radius) - 1e-9) return [];
  const along = (first.radius ** 2 - second.radius ** 2 + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(first.radius ** 2 - along * along, 0));
  const ux = (second.center[0] - first.center[0]) / d;
  const uy = (second.center[1] - first.center[1]) / d;
  const base: Vec2 = [first.center[0] + ux * along, first.center[1] + uy * along];
  const candidates: Vec2[] = height < 1e-9 ? [base] : [[base[0] - uy * height, base[1] + ux * height], [base[0] + uy * height, base[1] - ux * height]];
  return candidates.filter((point) => onSweep(first, Math.atan2(point[1] - first.center[1], point[0] - first.center[0])) && onSweep(second, Math.atan2(point[1] - second.center[1], point[0] - second.center[0])));
}

function intersect(first: Primitive, second: Primitive): readonly Vec2[] {
  if (first.kind === "segment" && second.kind === "segment") return intersectSegments(first, second);
  if (first.kind === "segment" && second.kind === "round") return intersectSegmentRound(first, second);
  if (first.kind === "round" && second.kind === "segment") return intersectSegmentRound(second, first);
  if (first.kind === "round" && second.kind === "round") return intersectRounds(first, second);
  return [];
}

/** The points on a primitive where a line from `anchor` meets it at a right angle. */
function perpendicularFeet(anchor: Vec2, primitive: Primitive): readonly Vec2[] {
  if (primitive.kind === "segment") {
    const dx = primitive.b[0] - primitive.a[0];
    const dy = primitive.b[1] - primitive.a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < EPSILON) return [];
    const t = ((anchor[0] - primitive.a[0]) * dx + (anchor[1] - primitive.a[1]) * dy) / lengthSquared;
    return t >= -1e-9 && t <= 1 + 1e-9 ? [[primitive.a[0] + dx * t, primitive.a[1] + dy * t]] : [];
  }
  const offset = dist(anchor, primitive.center);
  if (offset < EPSILON) return [];
  const angle = Math.atan2(anchor[1] - primitive.center[1], anchor[0] - primitive.center[0]);
  return [angle, angle + Math.PI].filter((candidate) => onSweep(primitive, candidate)).map((candidate) => pointOnRound(primitive, candidate));
}

/** The points on a circle or arc where a tangent from `anchor` touches it. */
function tangentPoints(anchor: Vec2, primitive: Primitive): readonly Vec2[] {
  if (primitive.kind !== "round") return [];
  const offset = dist(anchor, primitive.center);
  if (offset <= primitive.radius + 1e-9) return [];
  const angle = Math.atan2(anchor[1] - primitive.center[1], anchor[0] - primitive.center[0]);
  const spread = Math.acos(primitive.radius / offset);
  return [angle + spread, angle - spread].filter((candidate) => onSweep(primitive, candidate)).map((candidate) => pointOnRound(primitive, candidate));
}

interface PointOfInterest {
  readonly kind: "endpoint" | "center" | "midpoint" | "quadrant";
  readonly point: Vec2;
  readonly selector: InferenceSelector;
}

function pointsOfInterest(entity: SketchEntity): readonly PointOfInterest[] {
  const found: PointOfInterest[] = [];
  const add = (kind: PointOfInterest["kind"], point: Vec2, selector: InferenceSelector): void => { found.push({ kind, point, selector }); };
  if (entity.kind === "line") {
    add("endpoint", entity.start, "start");
    add("endpoint", entity.end, "end");
    add("midpoint", [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], "mid");
  } else if (entity.kind === "circle") {
    add("center", entity.center, "center");
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const angle = (quarter * Math.PI) / 2;
      add("quadrant", [entity.center[0] + entity.radiusMm * Math.cos(angle), entity.center[1] + entity.radiusMm * Math.sin(angle)], "point");
    }
  } else if (entity.kind === "arc") {
    add("endpoint", entity.start, "start");
    add("endpoint", entity.end, "end");
    const arc = arcPrimitive(entity.start, entity.mid, entity.end);
    if (arc !== undefined) {
      add("center", arc.center, "center");
      add("midpoint", pointOnRound(arc, arc.startAngle + arc.sweep / 2), "mid");
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const angle = (quarter * Math.PI) / 2;
        if (onSweep(arc, angle) && wrap(angle - arc.startAngle) > 1e-6 && wrap(angle - arc.startAngle) < arc.sweep - 1e-6) add("quadrant", pointOnRound(arc, angle), "point");
      }
    }
  } else if (entity.kind === "rectangle") {
    const corners = entityPoints(entity);
    corners.forEach((corner, index) => {
      add("endpoint", corner, "corner");
      const next = corners[(index + 1) % corners.length]!;
      add("midpoint", [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2], "mid");
    });
    add("center", entity.center, "center");
  } else if (entity.kind === "spline") {
    entity.fitPoints.forEach((fit, index) => add("endpoint", fit, index === 0 ? "start" : index === entity.fitPoints.length - 1 ? "end" : "point"));
  } else if (entity.kind === "ellipse") {
    add("center", entity.center, "center");
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const axisEnd = (ax: number, ay: number): Vec2 => [entity.center[0] + ax * cos - ay * sin, entity.center[1] + ax * sin + ay * cos];
    add("quadrant", axisEnd(entity.majorRadiusMm, 0), "point");
    add("quadrant", axisEnd(-entity.majorRadiusMm, 0), "point");
    add("quadrant", axisEnd(0, entity.minorRadiusMm), "point");
    add("quadrant", axisEnd(0, -entity.minorRadiusMm), "point");
  } else {
    add("endpoint", entity.point, "point");
  }
  return found;
}

function boxDistance(point: Vec2, primitive: Primitive): number {
  if (primitive.kind === "segment") {
    const minX = Math.min(primitive.a[0], primitive.b[0]);
    const maxX = Math.max(primitive.a[0], primitive.b[0]);
    const minY = Math.min(primitive.a[1], primitive.b[1]);
    const maxY = Math.max(primitive.a[1], primitive.b[1]);
    return Math.hypot(Math.max(minX - point[0], 0, point[0] - maxX), Math.max(minY - point[1], 0, point[1] - maxY));
  }
  // Distance to the outline, not to the disc: a pointer well inside a circle is not near it.
  return Math.abs(dist(point, primitive.center) - primitive.radius);
}

/**
 * Finds the snapped point for `pointer`. Named points (endpoint, centre, origin) win over intersections, midpoints and
 * quadrants, which win over perpendicular and tangent hints, then a point on a curve, then horizontal/vertical
 * alignment, then the grid. Inside one tier the nearest candidate wins.
 */
export function inferSketchPoint(pointer: Vec2, sketch: WorkbenchSketch, options: InferenceOptions): InferenceResult {
  const tolerance = Math.max(options.toleranceMm, 1e-9);
  const excluded = new Set(options.excludeEntityIds ?? []);
  const entities = sketch.entities.filter((entity) => entity.visible !== false && !excluded.has(entity.id));
  const candidates: InferenceCandidate[] = [];
  const add = (candidate: Omit<InferenceCandidate, "distanceMm">, reach = tolerance): void => {
    const distanceMm = dist(pointer, candidate.point);
    if (distanceMm <= reach) candidates.push({ ...candidate, distanceMm });
  };

  const alignmentSources: Vec2[] = [[0, 0]];
  add({ kind: "origin", point: [0, 0], selector: "point" });
  const nearby: { readonly entity: SketchEntity; readonly primitive: Primitive }[] = [];

  for (const entity of entities) {
    for (const interest of pointsOfInterest(entity)) {
      add({ kind: interest.kind, point: interest.point, entityId: entity.id, selector: interest.selector });
      if (interest.kind === "endpoint" || interest.kind === "center") alignmentSources.push(interest.point);
    }
    for (const primitive of primitivesOf(entity)) {
      if (boxDistance(pointer, primitive) > tolerance * 1.5) continue;
      nearby.push({ entity, primitive });
      const nearest = nearestOnPrimitive(pointer, primitive);
      if (nearest !== undefined) add({ kind: "on-curve", point: nearest.point, entityId: entity.id }, tolerance * ON_CURVE_REACH);
      if (options.anchor !== undefined) {
        for (const foot of perpendicularFeet(options.anchor, primitive)) add({ kind: "perpendicular", point: foot, entityId: entity.id });
        for (const touch of tangentPoints(options.anchor, primitive)) add({ kind: "tangent", point: touch, entityId: entity.id });
      }
    }
  }
  for (let first = 0; first < nearby.length; first += 1) {
    for (let second = first + 1; second < nearby.length; second += 1) {
      const a = nearby[first]!;
      const b = nearby[second]!;
      if (a.entity.id === b.entity.id && a.primitive.kind === "round") continue;
      for (const hit of intersect(a.primitive, b.primitive)) add({ kind: "intersection", point: hit, entityId: a.entity.id, otherEntityId: b.entity.id });
    }
  }

  const ranked = [...candidates].sort((left, right) => TIER[left.kind] - TIER[right.kind] || left.distanceMm - right.distanceMm);
  const best = ranked[0];
  if (best !== undefined) return { point: best.point, snapped: true, primary: best, guides: [] };

  // Nothing is under the pointer: try lining up horizontally and vertically with known points.
  let horizontal: { readonly source: Vec2; readonly gap: number } | undefined;
  let vertical: { readonly source: Vec2; readonly gap: number } | undefined;
  for (const source of alignmentSources) {
    const dy = Math.abs(pointer[1] - source[1]);
    const dx = Math.abs(pointer[0] - source[0]);
    if (dy <= tolerance && (horizontal === undefined || dy < horizontal.gap)) horizontal = { source, gap: dy };
    if (dx <= tolerance && (vertical === undefined || dx < vertical.gap)) vertical = { source, gap: dx };
  }
  // Lining up with the point just placed wins a tie, so the guide (and the relation it implies) belongs to the shape being drawn.
  const anchor = options.anchor;
  if (anchor !== undefined) {
    const dy = Math.abs(pointer[1] - anchor[1]);
    const dx = Math.abs(pointer[0] - anchor[0]);
    if (dy <= tolerance && (horizontal === undefined || dy <= horizontal.gap + 1e-9)) horizontal = { source: anchor, gap: dy };
    if (dx <= tolerance && (vertical === undefined || dx <= vertical.gap + 1e-9)) vertical = { source: anchor, gap: dx };
  }
  if (horizontal !== undefined || vertical !== undefined) {
    const gridMm = options.gridMm;
    const free = (value: number): number => gridMm !== undefined && Math.abs(roundTo(value, gridMm) - value) <= tolerance ? roundTo(value, gridMm) : value;
    const point: Vec2 = [vertical !== undefined ? vertical.source[0] : free(pointer[0]), horizontal !== undefined ? horizontal.source[1] : free(pointer[1])];
    const guides: InferenceGuide[] = [];
    if (horizontal !== undefined) guides.push({ kind: "horizontal", from: horizontal.source, to: point });
    if (vertical !== undefined) guides.push({ kind: "vertical", from: vertical.source, to: point });
    const kind: InferenceKind = horizontal !== undefined ? "horizontal" : "vertical";
    return { point, snapped: true, primary: { kind, point, distanceMm: dist(pointer, point) }, guides };
  }

  if (options.gridMm !== undefined) {
    const node: Vec2 = [roundTo(pointer[0], options.gridMm), roundTo(pointer[1], options.gridMm)];
    if (dist(node, pointer) <= tolerance) return { point: node, snapped: true, primary: { kind: "grid", point: node, distanceMm: dist(node, pointer) }, guides: [] };
  }
  return { point: pointer, snapped: false, guides: [] };
}
