import {
  failure,
  type SketchEntity,
  type Vec2,
  type WorkbenchResult,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../../workbench-core/src/index.js";
import { analyzeWorkbenchSketch, detectSketchProfiles, entityPoints, sampleSpline } from "./index.js";
import { solveLiveSketch } from "../../workbench-core/src/sketch-solve.js";
import { isDimensionConstraint } from "../../workbench-core/src/sketch-measure.js";

/** One atomic sketch edit, applied by the `apply-sketch-edit` operation. */
export interface SketchEditPlan {
  readonly label: string;
  readonly removeEntityIds: readonly string[];
  readonly updateEntities: readonly SketchEntity[];
  readonly addEntities: readonly SketchEntity[];
  readonly addConstraints: readonly WorkbenchSketchConstraint[];
  /** Relations to delete by ID (re-pointed or no longer true after the edit). Absent means none. */
  readonly removeConstraintIds?: readonly string[];
}

export type SketchEditResult = WorkbenchResult<SketchEditPlan>;

export interface SketchEditContext {
  readonly sketch: WorkbenchSketch;
  /** Produces a fresh stable ID such as `entity:user-<uuid>` or `constraint:user-<uuid>`. */
  readonly newId: (prefix: "entity" | "constraint") => string;
}

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Rectangle = Extract<SketchEntity, { kind: "rectangle" }>;

const EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;
const MAX_COPIES = 100;

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the values and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function find(sketch: WorkbenchSketch, id: string): SketchEntity | undefined {
  return sketch.entities.find((entity) => entity.id === id);
}

function plan(label: string, parts: Partial<Omit<SketchEditPlan, "label">>): SketchEditResult {
  return {
    ok: true,
    value: {
      label,
      removeEntityIds: parts.removeEntityIds ?? [],
      updateEntities: parts.updateEntities ?? [],
      addEntities: parts.addEntities ?? [],
      addConstraints: parts.addConstraints ?? [],
      ...(parts.removeConstraintIds === undefined || parts.removeConstraintIds.length === 0 ? {} : { removeConstraintIds: parts.removeConstraintIds })
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------------------------

/**
 * Offsets the selected curves by `distanceMm`. For a circle, arc or rectangle a positive distance
 * moves outward; for a line (or a connected chain of lines) it moves to the left of the line's
 * direction, except that a closed loop of lines offsets outward. Connected lines are re-joined with
 * mitred corners. Each result is a new, unconstrained entity; the originals stay.
 */
export function offsetEntities(context: SketchEditContext, ids: readonly string[], distanceMm: number): SketchEditResult {
  if (!Number.isFinite(distanceMm) || Math.abs(distanceMm) < 0.01 || Math.abs(distanceMm) > 5000) return reject("Enter an offset distance between 0.01 mm and 5000 mm (negative offsets to the other side).");
  const entities = ids.map((id) => find(context.sketch, id));
  if (entities.length === 0 || entities.some((entity) => entity === undefined)) return reject("Select the curves to offset.");
  const selected = entities as SketchEntity[];
  const added: SketchEntity[] = [];
  const lines = selected.filter((entity): entity is Line => entity.kind === "line");
  for (const entity of selected) {
    if (entity.kind === "line") continue;
    if (entity.kind === "circle") {
      const radiusMm = entity.radiusMm + distanceMm;
      if (radiusMm < 0.01) return reject("The inward offset is larger than the circle's radius.", [entity.id]);
      added.push({ ...entity, id: context.newId("entity"), radiusMm });
    } else if (entity.kind === "arc") {
      const circle = circumcircle(entity.start, entity.mid, entity.end);
      if (circle === undefined) return reject("The arc is degenerate.", [entity.id]);
      const radiusMm = circle.radiusMm + distanceMm;
      if (radiusMm < 0.01) return reject("The inward offset is larger than the arc's radius.", [entity.id]);
      const scale = radiusMm / circle.radiusMm;
      const about = (point: Vec2): Vec2 => [circle.center[0] + (point[0] - circle.center[0]) * scale, circle.center[1] + (point[1] - circle.center[1]) * scale];
      added.push({ ...entity, id: context.newId("entity"), start: about(entity.start), mid: about(entity.mid), end: about(entity.end) });
    } else if (entity.kind === "rectangle") {
      const widthMm = entity.widthMm + 2 * distanceMm;
      const heightMm = entity.heightMm + 2 * distanceMm;
      if (widthMm < 0.01 || heightMm < 0.01) return reject("The inward offset is larger than the rectangle.", [entity.id]);
      added.push({ ...entity, id: context.newId("entity"), widthMm, heightMm });
    } else {
      return reject(`Offset applies to lines, arcs, circles and rectangles; a ${entity.kind} cannot be offset.`, [entity.id]);
    }
  }
  if (lines.length > 0) {
    const chains = buildLineChains(lines, context.sketch.snapToleranceMm);
    for (const chain of chains) {
      const result = offsetChain(chain, distanceMm, context);
      if (typeof result === "string") return reject(result, chain.lines.map((line) => line.id));
      added.push(...result);
    }
  }
  return plan(`Offset ${selected.length} curve${selected.length === 1 ? "" : "s"} by ${format(distanceMm)} mm`, { addEntities: added });
}

interface LineChain {
  /** Vertices in traversal order; a closed chain repeats no vertex. */
  readonly vertices: readonly Vec2[];
  readonly closed: boolean;
  readonly lines: readonly Line[];
}

function buildLineChains(lines: readonly Line[], tolerance: number): readonly LineChain[] {
  const nodes: Vec2[] = [];
  const nodeOf = (point: Vec2): number => {
    const existing = nodes.findIndex((candidate) => distance(candidate, point) <= Math.max(tolerance, 1e-6));
    if (existing >= 0) return existing;
    nodes.push(point);
    return nodes.length - 1;
  };
  const edges = lines.map((line) => ({ line, a: nodeOf(line.start), b: nodeOf(line.end) }));
  const incident = (node: number): number[] => edges.flatMap((edge, index) => (edge.a === node || edge.b === node ? [index] : []));
  const visited = new Set<number>();
  const chains: LineChain[] = [];
  for (let seed = 0; seed < edges.length; seed += 1) {
    if (visited.has(seed)) continue;
    // Collect the connected component of edges.
    const component = new Set<number>();
    const stack = [seed];
    while (stack.length > 0) {
      const edge = stack.pop()!;
      if (component.has(edge)) continue;
      component.add(edge);
      for (const node of [edges[edge]!.a, edges[edge]!.b]) for (const next of incident(node)) if (!component.has(next)) stack.push(next);
    }
    for (const edge of component) visited.add(edge);
    const degrees = new Map<number, number>();
    for (const edge of component) for (const node of [edges[edge]!.a, edges[edge]!.b]) degrees.set(node, (degrees.get(node) ?? 0) + 1);
    const simple = [...degrees.values()].every((degree) => degree <= 2);
    if (!simple) {
      // A branching network cannot be mitred as one chain, so offset every line on its own.
      for (const edge of component) chains.push({ vertices: [edges[edge]!.line.start, edges[edge]!.line.end], closed: false, lines: [edges[edge]!.line] });
      continue;
    }
    const ends = [...degrees.entries()].filter(([, degree]) => degree === 1).map(([node]) => node);
    const closed = ends.length === 0 && component.size >= 3;
    // Walk from an open end (or the seed's start for a loop), starting along the first selected line's own direction.
    let node = closed ? edges[seed]!.a : (ends.includes(edges[seed]!.a) ? edges[seed]!.a : ends.includes(edges[seed]!.b) ? edges[seed]!.b : ends[0]!);
    const used = new Set<number>();
    const vertices: Vec2[] = [nodes[node]!];
    const ordered: Line[] = [];
    for (let step = 0; step < component.size; step += 1) {
      const nextEdge = incident(node).find((edge) => component.has(edge) && !used.has(edge));
      if (nextEdge === undefined) break;
      used.add(nextEdge);
      const edge = edges[nextEdge]!;
      node = edge.a === node ? edge.b : edge.a;
      ordered.push(edge.line);
      if (!(closed && step === component.size - 1)) vertices.push(nodes[node]!);
    }
    chains.push({ vertices, closed, lines: ordered });
  }
  return chains;
}

function offsetChain(chain: LineChain, distanceMm: number, context: SketchEditContext): readonly SketchEntity[] | string {
  const vertices = chain.vertices;
  const count = vertices.length;
  const segmentCount = chain.closed ? count : count - 1;
  // Positive means left of travel; a closed loop offsets outward, which is the right side for a counter-clockwise loop.
  const signed = chain.closed && polygonArea(vertices) > 0 ? -distanceMm : distanceMm;
  const normals: Vec2[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % count]!;
    const length = distance(from, to);
    if (length < EPSILON) return "A line in the chain has no length.";
    normals.push([-(to[1] - from[1]) / length, (to[0] - from[0]) / length]);
  }
  const shifted = (index: number, point: Vec2): Vec2 => [point[0] + normals[index]![0] * signed, point[1] + normals[index]![1] * signed];
  const next: Vec2[] = [];
  for (let vertex = 0; vertex < count; vertex += 1) {
    const incoming = chain.closed ? (vertex + segmentCount - 1) % segmentCount : vertex - 1;
    const outgoing = chain.closed ? vertex % segmentCount : vertex;
    if (incoming < 0) { next.push(shifted(outgoing, vertices[vertex]!)); continue; }
    if (outgoing >= segmentCount) { next.push(shifted(incoming, vertices[vertex]!)); continue; }
    const a1 = shifted(incoming, vertices[(incoming) % count]!);
    const a2 = shifted(incoming, vertices[(incoming + 1) % count]!);
    const b1 = shifted(outgoing, vertices[outgoing % count]!);
    const b2 = shifted(outgoing, vertices[(outgoing + 1) % count]!);
    const hit = intersectInfinite(a1, a2, b1, b2);
    if (hit === undefined) { next.push(shifted(outgoing, vertices[vertex]!)); continue; }
    if (distance(hit, shifted(outgoing, vertices[vertex]!)) > 10 * Math.abs(signed)) return "A corner is too sharp to offset with a mitre; offset the lines one at a time.";
    next.push(hit);
  }
  const created: SketchEntity[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const from = next[index]!;
    const to = next[(index + 1) % count]!;
    const before = vertices[index]!;
    const after = vertices[(index + 1) % count]!;
    const flipped = (to[0] - from[0]) * (after[0] - before[0]) + (to[1] - from[1]) * (after[1] - before[1]) <= 0;
    if (distance(from, to) < 0.01 || flipped) return "The offset distance collapses part of the shape; use a smaller distance.";
    created.push({ id: context.newId("entity"), kind: "line", start: from, end: to, construction: chain.lines[index]?.construction ?? false });
  }
  return created;
}

// ---------------------------------------------------------------------------------------------
// Mirror and pattern
// ---------------------------------------------------------------------------------------------

/** Maps every defining point of an entity, and its rectangle rotation, onto a new entity with a fresh ID. */
function mapEntity(entity: SketchEntity, id: string, point: (value: Vec2) => Vec2, rotation: (degrees: number) => number): SketchEntity {
  if (entity.kind === "line") return { ...entity, id, start: point(entity.start), end: point(entity.end) };
  if (entity.kind === "circle") return { ...entity, id, center: point(entity.center) };
  if (entity.kind === "arc") return { ...entity, id, start: point(entity.start), mid: point(entity.mid), end: point(entity.end) };
  if (entity.kind === "rectangle") return { ...entity, id, center: point(entity.center), rotationDeg: wrapDegrees(rotation(entity.rotationDeg)) };
  if (entity.kind === "point") return { ...entity, id, point: point(entity.point) };
  if (entity.kind === "ellipse") return { ...entity, id, center: point(entity.center), rotationDeg: wrapDegrees(rotation(entity.rotationDeg)) };
  return { ...entity, id, fitPoints: entity.fitPoints.map(point) };
}

/** Mirrors the selected entities about the axis line (the last id) and records symmetric relations. */
export function mirrorEntities(context: SketchEditContext, ids: readonly string[]): SketchEditResult {
  const axis = ids.length >= 2 ? find(context.sketch, ids[ids.length - 1]!) : undefined;
  if (axis?.kind !== "line") return reject("Select the entities to mirror, then the mirror line last.");
  const sources = ids.slice(0, -1).map((id) => find(context.sketch, id));
  if (sources.some((entity) => entity === undefined || entity.id === axis.id)) return reject("Select the entities to mirror before the mirror line.");
  const axisAngle = Math.atan2(axis.end[1] - axis.start[1], axis.end[0] - axis.start[0]);
  const reflect = (value: Vec2): Vec2 => reflectAcross(value, axis);
  const added: SketchEntity[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  for (const source of sources as SketchEntity[]) {
    const copy = mapEntity(source, context.newId("entity"), reflect, (degrees) => 2 * (axisAngle * 180 / Math.PI) - degrees);
    added.push(copy);
    const symmetric = (source.kind === "line" && copy.kind === "line") || (source.kind === "circle" && copy.kind === "circle");
    if (symmetric) constraints.push({ id: context.newId("constraint"), kind: "symmetry", entityIds: [source.id, copy.id, axis.id] });
  }
  return plan(`Mirrored ${added.length} entit${added.length === 1 ? "y" : "ies"} about ${axis.id.replace(/^entity:/u, "")}`, { addEntities: added, addConstraints: constraints });
}

export type PatternSpec =
  | { readonly kind: "rectangular"; readonly countX: number; readonly countY: number; readonly dxMm: number; readonly dyMm: number }
  | { readonly kind: "circular"; readonly count: number; readonly angleDeg: number; readonly center: Vec2 };

/** Copies the selected entities in a rectangular grid or around a centre. The original stays as the first instance. */
export function patternEntities(context: SketchEditContext, ids: readonly string[], spec: PatternSpec): SketchEditResult {
  const sources = ids.map((id) => find(context.sketch, id));
  if (sources.length === 0 || sources.some((entity) => entity === undefined)) return reject("Select the entities to pattern.");
  const entities = sources as SketchEntity[];
  const added: SketchEntity[] = [];
  if (spec.kind === "rectangular") {
    const { countX, countY, dxMm, dyMm } = spec;
    if (![countX, countY].every((count) => Number.isInteger(count) && count >= 1) || countX * countY < 2) return reject("Enter whole-number counts of at least 1, with at least 2 instances in total.");
    if (countX * countY - 1 > MAX_COPIES) return reject(`A pattern is limited to ${MAX_COPIES + 1} instances.`);
    if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm) || (countX > 1 && Math.abs(dxMm) < 0.01) || (countY > 1 && Math.abs(dyMm) < 0.01)) return reject("Enter a spacing of at least 0.01 mm in each direction that has more than one instance.");
    for (let row = 0; row < countY; row += 1) {
      for (let column = 0; column < countX; column += 1) {
        if (row === 0 && column === 0) continue;
        const offset: Vec2 = [column * dxMm, row * dyMm];
        for (const entity of entities) added.push(mapEntity(entity, context.newId("entity"), (point) => [point[0] + offset[0], point[1] + offset[1]], (degrees) => degrees));
      }
    }
    return plan(`Rectangular pattern ${countX} × ${countY}`, { addEntities: added });
  }
  const { count, angleDeg, center } = spec;
  if (!Number.isInteger(count) || count < 2 || count - 1 > MAX_COPIES) return reject(`Enter a count from 2 to ${MAX_COPIES + 1}.`);
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 0.01 || Math.abs(angleDeg) > 360) return reject("Enter a total angle between 0.01 and 360 degrees.");
  // A full turn spaces the instances evenly around the circle; a partial angle puts the last instance at that angle.
  const step = Math.abs(angleDeg) >= 360 - EPSILON ? angleDeg / count : angleDeg / (count - 1);
  for (let index = 1; index < count; index += 1) {
    const radians = (step * index * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotate = (point: Vec2): Vec2 => [center[0] + (point[0] - center[0]) * cos - (point[1] - center[1]) * sin, center[1] + (point[0] - center[0]) * sin + (point[1] - center[1]) * cos];
    for (const entity of entities) added.push(mapEntity(entity, context.newId("entity"), rotate, (degrees) => degrees + step * index));
  }
  return plan(`Circular pattern of ${count}`, { addEntities: added });
}

// ---------------------------------------------------------------------------------------------
// Move, rotate and scale
// ---------------------------------------------------------------------------------------------

export type TransformSpec =
  | { readonly kind: "move"; readonly dxMm: number; readonly dyMm: number }
  | { readonly kind: "rotate"; readonly angleDeg: number; readonly center: Vec2 }
  | { readonly kind: "scale"; readonly factor: number; readonly center: Vec2 };

/** Scales every defining point about `center` and the size fields by `factor`, giving the entity `id`. */
function scaleEntity(entity: SketchEntity, id: string, center: Vec2, factor: number): SketchEntity {
  const point = (value: Vec2): Vec2 => [center[0] + (value[0] - center[0]) * factor, center[1] + (value[1] - center[1]) * factor];
  if (entity.kind === "circle") return { ...entity, id, center: point(entity.center), radiusMm: entity.radiusMm * factor };
  if (entity.kind === "rectangle") return { ...entity, id, center: point(entity.center), widthMm: entity.widthMm * factor, heightMm: entity.heightMm * factor };
  if (entity.kind === "ellipse") return { ...entity, id, center: point(entity.center), majorRadiusMm: entity.majorRadiusMm * factor, minorRadiusMm: entity.minorRadiusMm * factor };
  return mapEntity(entity, id, point, (degrees) => degrees);
}

/**
 * Moves, rotates or scales the selected entities. With `copy` the originals stay and transformed copies with fresh IDs are
 * added; otherwise the entities are updated in place, and the solver rejects the edit if a relation outside the selection
 * would be broken (Relax Relations first).
 */
export function transformEntities(context: SketchEditContext, ids: readonly string[], spec: TransformSpec, copy: boolean): SketchEditResult {
  const sources = ids.map((id) => find(context.sketch, id));
  if (sources.length === 0 || sources.some((entity) => entity === undefined)) return reject("Select the entities to transform.");
  const entities = sources as SketchEntity[];
  if (copy && entities.length > MAX_COPIES) return reject(`A copy is limited to ${MAX_COPIES} entities.`);
  let apply: (entity: SketchEntity, id: string) => SketchEntity;
  let label: string;
  if (spec.kind === "move") {
    if (!Number.isFinite(spec.dxMm) || !Number.isFinite(spec.dyMm) || Math.hypot(spec.dxMm, spec.dyMm) < 0.001 || Math.abs(spec.dxMm) > 100_000 || Math.abs(spec.dyMm) > 100_000) return reject("Enter a move distance of at least 0.001 mm.");
    apply = (entity, id) => mapEntity(entity, id, (point) => [point[0] + spec.dxMm, point[1] + spec.dyMm], (degrees) => degrees);
    label = `${copy ? "Copied" : "Moved"} ${entities.length} entit${entities.length === 1 ? "y" : "ies"} by (${format(spec.dxMm)}, ${format(spec.dyMm)}) mm`;
  } else if (spec.kind === "rotate") {
    if (!Number.isFinite(spec.angleDeg) || Math.abs(spec.angleDeg) < 0.001 || Math.abs(spec.angleDeg) > 360) return reject("Enter a rotation angle between 0.001 and 360 degrees.");
    const radians = (spec.angleDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const [cx, cy] = spec.center;
    apply = (entity, id) => mapEntity(entity, id, (point) => [cx + (point[0] - cx) * cos - (point[1] - cy) * sin, cy + (point[0] - cx) * sin + (point[1] - cy) * cos], (degrees) => degrees + spec.angleDeg);
    label = `${copy ? "Copied" : "Rotated"} ${entities.length} entit${entities.length === 1 ? "y" : "ies"} ${format(spec.angleDeg)}°`;
  } else {
    if (!Number.isFinite(spec.factor) || spec.factor < 0.01 || spec.factor > 100 || Math.abs(spec.factor - 1) < 1e-6) return reject("Enter a scale factor between 0.01 and 100 (other than 1).");
    apply = (entity, id) => scaleEntity(entity, id, spec.center, spec.factor);
    label = `${copy ? "Copied" : "Scaled"} ${entities.length} entit${entities.length === 1 ? "y" : "ies"} by ${format(spec.factor)}x`;
  }
  return copy
    ? plan(label, { addEntities: entities.map((entity) => apply(entity, context.newId("entity"))) })
    : plan(label, { updateEntities: entities.map((entity) => apply(entity, entity.id)) });
}

// ---------------------------------------------------------------------------------------------
// Stretch
// ---------------------------------------------------------------------------------------------

export interface StretchWindow {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The smallest box that holds the selected entities (circles and ellipses by their extent), for seeding a stretch window. */
export function selectionBounds(sketch: WorkbenchSketch, ids: readonly string[]): StretchWindow | undefined {
  const points: Vec2[] = [];
  for (const id of ids) {
    const entity = find(sketch, id);
    if (entity === undefined) continue;
    if (entity.kind === "circle") points.push([entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm], [entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm]);
    else if (entity.kind === "ellipse") points.push([entity.center[0] - entity.majorRadiusMm, entity.center[1] - entity.majorRadiusMm], [entity.center[0] + entity.majorRadiusMm, entity.center[1] + entity.majorRadiusMm]);
    else if (entity.kind === "spline") points.push(...entity.fitPoints);
    else points.push(...entityPoints(entity));
  }
  if (points.length === 0) return undefined;
  return { x1: Math.min(...points.map((point) => point[0])), y1: Math.min(...points.map((point) => point[1])), x2: Math.max(...points.map((point) => point[0])), y2: Math.max(...points.map((point) => point[1])) };
}

/**
 * Moves only the points of the selected entities that lie inside the window, by (dx, dy), so the rest of each entity stays put
 * and it stretches. A line end, arc point or spline fit point inside the window moves; a circle, ellipse or point moves whole when
 * its centre is inside; a rectangle moves whole when all four corners are inside, and otherwise each side that lies fully inside
 * moves, which changes its width or height. A rectangle with only a corner inside is left alone.
 */
export function stretchEntities(context: SketchEditContext, ids: readonly string[], window: StretchWindow, dxMm: number, dyMm: number): SketchEditResult {
  if (![window.x1, window.y1, window.x2, window.y2, dxMm, dyMm].every(Number.isFinite)) return reject("Enter numbers for the window and the distance.");
  if (Math.hypot(dxMm, dyMm) < 0.001 || Math.abs(dxMm) > 100_000 || Math.abs(dyMm) > 100_000) return reject("Enter a stretch distance of at least 0.001 mm.");
  const low: Vec2 = [Math.min(window.x1, window.x2), Math.min(window.y1, window.y2)];
  const high: Vec2 = [Math.max(window.x1, window.x2), Math.max(window.y1, window.y2)];
  if (high[0] - low[0] < 1e-6 || high[1] - low[1] < 1e-6) return reject("The window needs a width and a height.");
  const inside = (point: Vec2): boolean => point[0] >= low[0] - 1e-9 && point[0] <= high[0] + 1e-9 && point[1] >= low[1] - 1e-9 && point[1] <= high[1] + 1e-9;
  const shift = (point: Vec2): Vec2 => (inside(point) ? [point[0] + dxMm, point[1] + dyMm] : point);
  const sources = ids.map((id) => find(context.sketch, id));
  if (sources.length === 0 || sources.some((entity) => entity === undefined)) return reject("Select the entities to stretch, then set the window over the part to move.");
  const updated: SketchEntity[] = [];
  for (const entity of sources as SketchEntity[]) {
    if (entity.kind === "line") {
      if (inside(entity.start) || inside(entity.end)) updated.push({ ...entity, start: shift(entity.start), end: shift(entity.end) });
    } else if (entity.kind === "arc") {
      if (inside(entity.start) || inside(entity.mid) || inside(entity.end)) updated.push({ ...entity, start: shift(entity.start), mid: shift(entity.mid), end: shift(entity.end) });
    } else if (entity.kind === "spline") {
      if (entity.fitPoints.some(inside)) updated.push({ ...entity, fitPoints: entity.fitPoints.map(shift) });
    } else if (entity.kind === "circle" || entity.kind === "ellipse") {
      if (inside(entity.center)) updated.push({ ...entity, center: shift(entity.center) });
    } else if (entity.kind === "point") {
      if (inside(entity.point)) updated.push({ ...entity, point: shift(entity.point) });
    } else {
      const corners = entityPoints(entity);
      const hit = corners.map(inside);
      if (hit.every(Boolean)) { updated.push({ ...entity, center: [entity.center[0] + dxMm, entity.center[1] + dyMm] }); continue; }
      // Corners run (-w,-h), (w,-h), (w,h), (-w,h): a side is a pair of neighbouring corners.
      const left = hit[0]! && hit[3]!;
      const right = hit[1]! && hit[2]!;
      const bottom = hit[0]! && hit[1]!;
      const top = hit[2]! && hit[3]!;
      if (!left && !right && !bottom && !top) continue;
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const localDx = dxMm * cos + dyMm * sin;
      const localDy = -dxMm * sin + dyMm * cos;
      const halfW = entity.widthMm / 2;
      const halfH = entity.heightMm / 2;
      const newLeft = -halfW + (left ? localDx : 0);
      const newRight = halfW + (right ? localDx : 0);
      const newBottom = -halfH + (bottom ? localDy : 0);
      const newTop = halfH + (top ? localDy : 0);
      const width = newRight - newLeft;
      const height = newTop - newBottom;
      if (width < 0.01 || height < 0.01) return reject(`The stretch would collapse ${shortId(entity.id)}; use a smaller distance.`, [entity.id]);
      const centerX = (newLeft + newRight) / 2;
      const centerY = (newBottom + newTop) / 2;
      updated.push({ ...entity, widthMm: width, heightMm: height, center: [entity.center[0] + centerX * cos - centerY * sin, entity.center[1] + centerX * sin + centerY * cos] });
    }
  }
  if (updated.length === 0) return reject("Nothing in the selection lies inside the window. Move the window over the points or sides you want to stretch.");
  return plan(`Stretched ${updated.length} entit${updated.length === 1 ? "y" : "ies"} by (${format(dxMm)}, ${format(dyMm)}) mm`, { updateEntities: updated });
}

// ---------------------------------------------------------------------------------------------
// Corner, fillet, chamfer
// ---------------------------------------------------------------------------------------------

export { chamferCorners, chamferCornersAngle, chamferCornersAsymmetric, cornerLines, filletCorners } from "./corner-tools.js";
export type { CornerOptions, CornerPicks, CornerSpec } from "./corner-tools.js";


// ---------------------------------------------------------------------------------------------
// Trim and extend
// ---------------------------------------------------------------------------------------------

type Curve =
  | { readonly kind: "line"; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: "circle"; readonly center: Vec2; readonly radius: number }
  | { readonly kind: "arc"; readonly center: Vec2; readonly radius: number; readonly startAngle: number; readonly sweep: number };

function curvesOf(entity: SketchEntity): readonly Curve[] {
  if (entity.kind === "line") return [{ kind: "line", a: entity.start, b: entity.end }];
  if (entity.kind === "circle") return [{ kind: "circle", center: entity.center, radius: entity.radiusMm }];
  if (entity.kind === "arc") {
    const frame = arcFrame(entity);
    return frame === undefined ? [] : [{ kind: "arc", center: frame.center, radius: frame.radius, startAngle: frame.startAngle, sweep: frame.sweep }];
  }
  if (entity.kind === "rectangle") {
    const corners = entityPoints(entity);
    return corners.map((corner, index): Curve => ({ kind: "line", a: corner, b: corners[(index + 1) % corners.length]! }));
  }
  if (entity.kind === "spline") {
    const samples = sampleSpline(entity.fitPoints);
    return samples.slice(0, -1).map((sample, index): Curve => ({ kind: "line", a: sample, b: samples[index + 1]! }));
  }
  if (entity.kind === "ellipse") {
    // A closed polyline of short chords (within 0.01 mm of the true ellipse up to 100 mm), so Trim and Extend can use it as a boundary.
    const samples = ellipseSamples(entity, 256);
    return samples.map((sample, index): Curve => ({ kind: "line", a: sample, b: samples[(index + 1) % samples.length]! }));
  }
  return [];
}

/** Points on an ellipse at evenly spaced parameter values, counter-clockwise from the major axis end. */
export function ellipseSamples(entity: Extract<SketchEntity, { kind: "ellipse" }>, count: number): readonly Vec2[] {
  const radians = (entity.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return Array.from({ length: count }, (_, index): Vec2 => {
    const t = (index / count) * TWO_PI;
    const x = entity.majorRadiusMm * Math.cos(t);
    const y = entity.minorRadiusMm * Math.sin(t);
    return [entity.center[0] + x * cos - y * sin, entity.center[1] + x * sin + y * cos];
  });
}

interface ArcFrame {
  readonly center: Vec2;
  readonly radius: number;
  /** Counter-clockwise start angle and sweep, regardless of the arc's drawing direction. */
  readonly startAngle: number;
  readonly sweep: number;
  readonly clockwise: boolean;
}

function arcFrame(arc: Arc): ArcFrame | undefined {
  const circle = circumcircle(arc.start, arc.mid, arc.end);
  if (circle === undefined) return undefined;
  const clockwise = cross(arc.start, arc.mid, arc.end) < 0;
  const angleOf = (point: Vec2): number => Math.atan2(point[1] - circle.center[1], point[0] - circle.center[0]);
  const startAngle = clockwise ? angleOf(arc.end) : angleOf(arc.start);
  const endAngle = clockwise ? angleOf(arc.start) : angleOf(arc.end);
  return { center: circle.center, radius: circle.radiusMm, startAngle, sweep: wrapTwoPi(endAngle - startAngle), clockwise };
}

function arcEntity(template: SketchEntity, id: string, center: Vec2, radius: number, startAngle: number, sweep: number, clockwise: boolean): Arc {
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  const first = at(startAngle);
  const last = at(startAngle + sweep);
  const mid = at(startAngle + sweep / 2);
  return { id, kind: "arc", start: clockwise ? last : first, mid, end: clockwise ? first : last, construction: template.construction, ...(template.visible === undefined ? {} : { visible: template.visible }) };
}

export { extendAt, powerTrim, trimAt, trimToClosest } from "./trim-extend.js";

/** Parameters t (0 at a, 1 at b, extended beyond) where the infinite line a-b meets a bounded curve. */
function lineHits(a: Vec2, b: Vec2, curve: Curve): number[] {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  if (curve.kind === "line") {
    const e: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const denominator = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(denominator) < 1e-12) return [];
    const t = ((curve.a[0] - a[0]) * e[1] - (curve.a[1] - a[1]) * e[0]) / denominator;
    const u = ((curve.a[0] - a[0]) * d[1] - (curve.a[1] - a[1]) * d[0]) / denominator;
    return u >= -1e-9 && u <= 1 + 1e-9 ? [t] : [];
  }
  const fx = a[0] - curve.center[0];
  const fy = a[1] - curve.center[1];
  const qa = d[0] * d[0] + d[1] * d[1];
  const qb = 2 * (fx * d[0] + fy * d[1]);
  const qc = fx * fx + fy * fy - curve.radius * curve.radius;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0 || qa < 1e-18) return [];
  const root = Math.sqrt(discriminant);
  const candidates = discriminant < 1e-12 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
  return candidates.filter((t) => {
    if (curve.kind === "circle") return true;
    const angle = Math.atan2(a[1] + d[1] * t - curve.center[1], a[0] + d[0] * t - curve.center[0]);
    return wrapTwoPi(angle - curve.startAngle) <= curve.sweep + 1e-9;
  });
}

/** Angles on the circle (center, radius) where it meets a bounded curve. */
function circleHits(center: Vec2, radius: number, curve: Curve): number[] {
  if (curve.kind === "line") {
    const far: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const fx = curve.a[0] - center[0];
    const fy = curve.a[1] - center[1];
    const qa = far[0] * far[0] + far[1] * far[1];
    const qb = 2 * (fx * far[0] + fy * far[1]);
    const qc = fx * fx + fy * fy - radius * radius;
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant < 0 || qa < 1e-18) return [];
    const root = Math.sqrt(discriminant);
    const parameters = discriminant < 1e-12 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
    return parameters.filter((u) => u >= -1e-9 && u <= 1 + 1e-9).map((u) => Math.atan2(curve.a[1] + far[1] * u - center[1], curve.a[0] + far[0] * u - center[0]));
  }
  const between = distance(center, curve.center);
  if (between < 1e-12 || between > radius + curve.radius + 1e-9 || between < Math.abs(radius - curve.radius) - 1e-9) return [];
  const along = (radius * radius - curve.radius * curve.radius + between * between) / (2 * between);
  const height = Math.sqrt(Math.max(0, radius * radius - along * along));
  const ux = (curve.center[0] - center[0]) / between;
  const uy = (curve.center[1] - center[1]) / between;
  const points: Vec2[] = height < 1e-9
    ? [[center[0] + ux * along, center[1] + uy * along]]
    : [[center[0] + ux * along - uy * height, center[1] + uy * along + ux * height], [center[0] + ux * along + uy * height, center[1] + uy * along - ux * height]];
  return points
    .filter((point) => curve.kind === "circle" || wrapTwoPi(Math.atan2(point[1] - curve.center[1], point[0] - curve.center[0]) - curve.startAngle) <= curve.sweep + 1e-9)
    .map((point) => Math.atan2(point[1] - center[1], point[0] - center[0]));
}

/** The nearest curve to a point within `toleranceMm`, for click-to-trim and click-to-extend. */
export function nearestEntityId(sketch: WorkbenchSketch, point: Vec2, toleranceMm: number): string | undefined {
  let best: { readonly id: string; readonly distance: number } | undefined;
  for (const entity of sketch.entities) {
    if (entity.visible === false || entity.kind === "point") continue;
    for (const curve of curvesOf(entity)) {
      const gap = distanceToCurve(point, curve);
      if (gap <= toleranceMm && (best === undefined || gap < best.distance)) best = { id: entity.id, distance: gap };
    }
  }
  return best?.id;
}

function distanceToCurve(point: Vec2, curve: Curve): number {
  if (curve.kind === "line") {
    const d: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const lengthSquared = d[0] * d[0] + d[1] * d[1];
    const t = lengthSquared < 1e-18 ? 0 : clamp(((point[0] - curve.a[0]) * d[0] + (point[1] - curve.a[1]) * d[1]) / lengthSquared, 0, 1);
    return distance(point, [curve.a[0] + d[0] * t, curve.a[1] + d[1] * t]);
  }
  const angle = Math.atan2(point[1] - curve.center[1], point[0] - curve.center[0]);
  if (curve.kind === "circle" || wrapTwoPi(angle - curve.startAngle) <= curve.sweep) return Math.abs(distance(point, curve.center) - curve.radius);
  const startPoint: Vec2 = [curve.center[0] + curve.radius * Math.cos(curve.startAngle), curve.center[1] + curve.radius * Math.sin(curve.startAngle)];
  const endPoint: Vec2 = [curve.center[0] + curve.radius * Math.cos(curve.startAngle + curve.sweep), curve.center[1] + curve.radius * Math.sin(curve.startAngle + curve.sweep)];
  return Math.min(distance(point, startPoint), distance(point, endPoint));
}

// ---------------------------------------------------------------------------------------------
// Relax relations and dimensions
// ---------------------------------------------------------------------------------------------

/** Constraint IDs on the given entities that are driving dimensions (radius, distance, angle, arc length, perimeter) or geometric relations (everything else). */
export function constraintsOnEntities(sketch: WorkbenchSketch, entityIds: readonly string[], family: "relations" | "dimensions", suppressed: boolean): readonly string[] {
  return sketch.constraints
    .filter((constraint) => constraint.entityIds.some((id) => entityIds.includes(id)))
    .filter((constraint) => constraint.driven !== true)
    .filter((constraint) => isDimensionConstraint(constraint) === (family === "dimensions"))
    .filter((constraint) => (constraint.suppressed === true) === suppressed)
    .map((constraint) => constraint.id);
}

// ---------------------------------------------------------------------------------------------
// Sketch checking
// ---------------------------------------------------------------------------------------------

export interface SketchCheckItem {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly entityIds: readonly string[];
}

export interface SketchCheckReport {
  readonly items: readonly SketchCheckItem[];
  readonly errors: number;
  readonly warnings: number;
}

/** Read-only diagnostics: gaps, tiny or duplicate curves, conflicting or unsolved relations and the degree-of-freedom state. */
export function checkSketch(sketch: WorkbenchSketch): SketchCheckReport {
  const items: SketchCheckItem[] = [];
  const tolerance = Math.max(sketch.snapToleranceMm, 1e-6);
  const curves = sketch.entities.filter((entity) => !entity.construction && (entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline"));
  const endOf = (entity: SketchEntity): readonly Vec2[] => (entity.kind === "line" || entity.kind === "arc" ? [entity.start, entity.end] : entity.kind === "spline" ? [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!] : []);
  const ends = curves.flatMap((entity) => endOf(entity).map((point) => ({ entity, point })));
  for (const end of ends) {
    const partners = ends.filter((other) => other !== end && distance(other.point, end.point) <= tolerance).length;
    if (partners === 0) items.push({ severity: "warning", message: `Open end at (${format(end.point[0])}, ${format(end.point[1])}) mm on ${shortId(end.entity.id)}; the curve does not close a profile there.`, entityIds: [end.entity.id] });
    else if (partners > 1) items.push({ severity: "info", message: `More than two curves meet at (${format(end.point[0])}, ${format(end.point[1])}) mm; profiles need exactly two.`, entityIds: [end.entity.id] });
  }
  for (const entity of sketch.entities) {
    if (entity.kind === "line" && distance(entity.start, entity.end) < 0.1) items.push({ severity: "warning", message: `${shortId(entity.id)} is shorter than 0.1 mm.`, entityIds: [entity.id] });
    if (entity.kind === "circle" && entity.radiusMm < 0.1) items.push({ severity: "warning", message: `${shortId(entity.id)} has a radius under 0.1 mm.`, entityIds: [entity.id] });
  }
  sketch.entities.forEach((entity, index) => {
    for (const other of sketch.entities.slice(index + 1)) {
      if (sameGeometry(entity, other, tolerance)) items.push({ severity: "warning", message: `${shortId(entity.id)} and ${shortId(other.id)} are the same curve drawn twice.`, entityIds: [entity.id, other.id] });
    }
  });
  const profiles = detectSketchProfiles(sketch);
  items.push({ severity: "info", message: `${profiles.length} closed profile${profiles.length === 1 ? "" : "s"} detected.`, entityIds: [] });
  const analysis = analyzeWorkbenchSketch(sketch);
  for (const conflict of analysis.conflicts) items.push({ severity: "error", message: conflict, entityIds: [] });
  const solved = solveLiveSketch(sketch);
  if (!solved.ok) items.push({ severity: "error", message: `Constraint solve fails: ${solved.message}`, entityIds: solved.relatedIds });
  else {
    for (const entry of solved.unsolved) items.push({ severity: "warning", message: `Recorded, not solved: ${entry.reason}`, entityIds: [] });
    if (solved.movedIds.length > 0) items.push({ severity: "warning", message: `${solved.movedIds.length} entit${solved.movedIds.length === 1 ? "y does" : "ies do"} not satisfy the recorded relations yet and would move on the next solve.`, entityIds: solved.movedIds });
  }
  const relaxed = sketch.constraints.filter((constraint) => constraint.suppressed === true).length;
  if (relaxed > 0) items.push({ severity: "info", message: `${relaxed} relation${relaxed === 1 ? " is" : "s are"} relaxed (ignored by the solver).`, entityIds: [] });
  items.push({ severity: "info", message: `Estimated degrees of freedom: ${analysis.degreesOfFreedom} (${analysis.classification}).`, entityIds: [] });
  return { items, errors: items.filter((item) => item.severity === "error").length, warnings: items.filter((item) => item.severity === "warning").length };
}

function sameGeometry(a: SketchEntity, b: SketchEntity, tolerance: number): boolean {
  if (a.kind === "line" && b.kind === "line") {
    return (distance(a.start, b.start) <= tolerance && distance(a.end, b.end) <= tolerance) || (distance(a.start, b.end) <= tolerance && distance(a.end, b.start) <= tolerance);
  }
  if (a.kind === "circle" && b.kind === "circle") return distance(a.center, b.center) <= tolerance && Math.abs(a.radiusMm - b.radiusMm) <= tolerance;
  if (a.kind === "point" && b.kind === "point") return distance(a.point, b.point) <= tolerance;
  return false;
}

function shortId(id: string): string {
  const bare = id.replace(/^entity:/u, "");
  return bare.length > 18 ? `${bare.slice(0, 12)}…` : bare;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function unitVector(from: Vec2, to: Vec2): Vec2 {
  const length = distance(from, to) || 1;
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

function pointAlong(origin: Vec2, direction: Vec2, length: number): Vec2 {
  return [origin[0] + direction[0] * length, origin[1] + direction[1] * length];
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function wrapTwoPi(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function polygonArea(points: readonly Vec2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - next[0] * current[1];
  }
  return twice / 2;
}

function intersectInfinite(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | undefined {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 1e-12 * Math.max(1, Math.hypot(...r) * Math.hypot(...s))) return undefined;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denominator;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

function reflectAcross(point: Vec2, axis: Line): Vec2 {
  const dx = axis.end[0] - axis.start[0];
  const dy = axis.end[1] - axis.start[1];
  const parameter = ((point[0] - axis.start[0]) * dx + (point[1] - axis.start[1]) * dy) / (dx * dx + dy * dy);
  const foot: Vec2 = [axis.start[0] + parameter * dx, axis.start[1] + parameter * dy];
  return [2 * foot[0] - point[0], 2 * foot[1] - point[1]];
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: distance(center, a) };
}

// Geometry helpers shared with the other sketch-edit modules (split, jog, path, clipboard, repair).
export { arcEntity, arcFrame, buildLineChains, circleHits, circumcircle, curvesOf, distanceToCurve, intersectInfinite, lineHits, mapEntity, offsetChain, plan as editPlan, reflectAcross, wrapTwoPi };
export type { ArcFrame, Curve, LineChain };
