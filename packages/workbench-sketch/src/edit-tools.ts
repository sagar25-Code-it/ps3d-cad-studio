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

/** One atomic sketch edit, applied by the `apply-sketch-edit` operation. */
export interface SketchEditPlan {
  readonly label: string;
  readonly removeEntityIds: readonly string[];
  readonly updateEntities: readonly SketchEntity[];
  readonly addEntities: readonly SketchEntity[];
  readonly addConstraints: readonly WorkbenchSketchConstraint[];
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
      addConstraints: parts.addConstraints ?? []
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
// Corner, fillet, chamfer
// ---------------------------------------------------------------------------------------------

/** Extends or trims two lines so they meet exactly at their intersection. */
export function cornerLines(context: SketchEditContext, ids: readonly string[]): SketchEditResult {
  const pair = twoLines(context, ids);
  if (typeof pair === "string") return reject(pair);
  const [first, second] = pair;
  const hit = intersectInfinite(first.start, first.end, second.start, second.end);
  if (hit === undefined) return reject("The two lines are parallel, so they never meet.", [first.id, second.id]);
  const moved = [moveNearEnd(first, hit), moveNearEnd(second, hit)];
  if (moved.every((line, index) => line === [first, second][index])) return reject("The two lines already meet at that corner.", [first.id, second.id]);
  if (moved.some((line) => distance(line.start, line.end) < 0.01)) return reject("The corner would collapse a line.", [first.id, second.id]);
  return plan("Corner", { updateEntities: moved });
}

/** Rounds the corner between two lines, or all four corners of a rectangle, with a tangent arc of the given radius. */
export function filletCorners(context: SketchEditContext, ids: readonly string[], radiusMm: number): SketchEditResult {
  if (!Number.isFinite(radiusMm) || radiusMm < 0.01 || radiusMm > 5000) return reject("Enter a fillet radius between 0.01 mm and 5000 mm.");
  const rectangle = singleRectangle(context, ids);
  if (rectangle !== undefined) return roundRectangle(context, rectangle, radiusMm, "fillet");
  const pair = twoLines(context, ids);
  if (typeof pair === "string") return reject(pair);
  const geometry = cornerGeometry(pair[0], pair[1]);
  if (typeof geometry === "string") return reject(geometry, [pair[0].id, pair[1].id]);
  const tangent = radiusMm / Math.tan(geometry.angle / 2);
  if (tangent >= geometry.firstLength - 1e-6 || tangent >= geometry.secondLength - 1e-6) return reject("The fillet radius is too large for these lines.", [pair[0].id, pair[1].id], "Use a smaller radius or lengthen the lines.");
  const first = pointAlong(geometry.corner, geometry.firstDirection, tangent);
  const second = pointAlong(geometry.corner, geometry.secondDirection, tangent);
  const centerDistance = radiusMm / Math.sin(geometry.angle / 2);
  const center = pointAlong(geometry.corner, geometry.bisector, centerDistance);
  const mid = pointAlong(center, geometry.bisector, -radiusMm);
  return plan(`Fillet R${format(radiusMm)}`, {
    updateEntities: [replaceNearEnd(pair[0], geometry.firstFar, first), replaceNearEnd(pair[1], geometry.secondFar, second)],
    addEntities: [{ id: context.newId("entity"), kind: "arc", start: first, mid, end: second, construction: false }]
  });
}

/** Cuts the corner between two lines, or all four corners of a rectangle, with a straight chamfer of the given distance. */
export function chamferCorners(context: SketchEditContext, ids: readonly string[], distanceMm: number): SketchEditResult {
  if (!Number.isFinite(distanceMm) || distanceMm < 0.01 || distanceMm > 5000) return reject("Enter a chamfer distance between 0.01 mm and 5000 mm.");
  const rectangle = singleRectangle(context, ids);
  if (rectangle !== undefined) return roundRectangle(context, rectangle, distanceMm, "chamfer");
  const pair = twoLines(context, ids);
  if (typeof pair === "string") return reject(pair);
  const geometry = cornerGeometry(pair[0], pair[1]);
  if (typeof geometry === "string") return reject(geometry, [pair[0].id, pair[1].id]);
  if (distanceMm >= geometry.firstLength - 1e-6 || distanceMm >= geometry.secondLength - 1e-6) return reject("The chamfer distance is too large for these lines.", [pair[0].id, pair[1].id], "Use a smaller distance or lengthen the lines.");
  const first = pointAlong(geometry.corner, geometry.firstDirection, distanceMm);
  const second = pointAlong(geometry.corner, geometry.secondDirection, distanceMm);
  return plan(`Chamfer ${format(distanceMm)} mm`, {
    updateEntities: [replaceNearEnd(pair[0], geometry.firstFar, first), replaceNearEnd(pair[1], geometry.secondFar, second)],
    addEntities: [{ id: context.newId("entity"), kind: "line", start: first, end: second, construction: false }]
  });
}

function twoLines(context: SketchEditContext, ids: readonly string[]): readonly [Line, Line] | string {
  const lines = ids.map((id) => find(context.sketch, id));
  if (lines.length !== 2 || lines.some((entity) => entity?.kind !== "line")) return "Select exactly two lines.";
  return [lines[0] as Line, lines[1] as Line];
}

function singleRectangle(context: SketchEditContext, ids: readonly string[]): Rectangle | undefined {
  if (ids.length !== 1) return undefined;
  const entity = find(context.sketch, ids[0]!);
  return entity?.kind === "rectangle" ? entity : undefined;
}

interface CornerGeometry {
  readonly corner: Vec2;
  readonly firstDirection: Vec2;
  readonly secondDirection: Vec2;
  readonly bisector: Vec2;
  readonly angle: number;
  readonly firstFar: Vec2;
  readonly secondFar: Vec2;
  readonly firstLength: number;
  readonly secondLength: number;
}

/** The meeting point of two lines and the directions leading away from it along the longer side of each. */
function cornerGeometry(first: Line, second: Line): CornerGeometry | string {
  const corner = intersectInfinite(first.start, first.end, second.start, second.end);
  if (corner === undefined) return "The two lines are parallel, so they have no corner.";
  const farEnd = (line: Line): Vec2 => (distance(line.start, corner) >= distance(line.end, corner) ? line.start : line.end);
  const firstFar = farEnd(first);
  const secondFar = farEnd(second);
  const firstLength = distance(firstFar, corner);
  const secondLength = distance(secondFar, corner);
  if (firstLength < 0.01 || secondLength < 0.01) return "A line has no length beyond the corner.";
  const firstDirection: Vec2 = [(firstFar[0] - corner[0]) / firstLength, (firstFar[1] - corner[1]) / firstLength];
  const secondDirection: Vec2 = [(secondFar[0] - corner[0]) / secondLength, (secondFar[1] - corner[1]) / secondLength];
  const cosine = Math.max(-1, Math.min(1, firstDirection[0] * secondDirection[0] + firstDirection[1] * secondDirection[1]));
  const angle = Math.acos(cosine);
  if (angle < 0.01 || angle > Math.PI - 0.01) return "The lines are almost parallel, so the corner cannot be rounded.";
  const sum: Vec2 = [firstDirection[0] + secondDirection[0], firstDirection[1] + secondDirection[1]];
  const sumLength = Math.hypot(sum[0], sum[1]);
  return { corner, firstDirection, secondDirection, bisector: [sum[0] / sumLength, sum[1] / sumLength], angle, firstFar, secondFar, firstLength, secondLength };
}

/** Moves whichever end of the line is nearer the target onto it. */
function moveNearEnd(line: Line, target: Vec2): Line {
  if (distance(line.start, target) <= EPSILON || distance(line.end, target) <= EPSILON) return line;
  return distance(line.start, target) <= distance(line.end, target) ? { ...line, start: target } : { ...line, end: target };
}

/** Replaces the end of the line that is not `far` with `point`. */
function replaceNearEnd(line: Line, far: Vec2, point: Vec2): Line {
  return distance(line.start, far) <= EPSILON ? { ...line, end: point } : { ...line, start: point };
}

function roundRectangle(context: SketchEditContext, rectangle: Rectangle, size: number, mode: "fillet" | "chamfer"): SketchEditResult {
  if (size >= Math.min(rectangle.widthMm, rectangle.heightMm) / 2 - 1e-6) return reject(`The ${mode === "fillet" ? "fillet radius" : "chamfer distance"} is too large for this rectangle (at most half of its shorter side).`, [rectangle.id]);
  const corners = entityPoints(rectangle);
  const added: SketchEntity[] = [];
  const entry: Vec2[] = [];
  const exit: Vec2[] = [];
  corners.forEach((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length]!;
    const following = corners[(index + 1) % corners.length]!;
    entry.push(pointAlong(corner, unitVector(corner, previous), size));
    exit.push(pointAlong(corner, unitVector(corner, following), size));
  });
  corners.forEach((corner, index) => {
    const nextIndex = (index + 1) % corners.length;
    added.push({ id: context.newId("entity"), kind: "line", start: exit[index]!, end: entry[nextIndex]!, construction: rectangle.construction });
    if (mode === "chamfer") {
      added.push({ id: context.newId("entity"), kind: "line", start: entry[index]!, end: exit[index]!, construction: rectangle.construction });
      return;
    }
    const center: Vec2 = [entry[index]![0] + exit[index]![0] - corner[0], entry[index]![1] + exit[index]![1] - corner[1]];
    const mid = pointAlong(center, unitVector(center, corner), size);
    added.push({ id: context.newId("entity"), kind: "arc", start: entry[index]!, mid, end: exit[index]!, construction: rectangle.construction });
  });
  return plan(`${mode === "fillet" ? "Fillet" : "Chamfer"} all corners of the rectangle (now ${added.length} lines and arcs)`, { removeEntityIds: [rectangle.id], addEntities: added });
}

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
  return [];
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

/** Removes the part of a curve between its neighbouring intersections that is nearest the pick point. */
export function trimAt(context: SketchEditContext, targetId: string, pick: Vec2): SketchEditResult {
  const target = find(context.sketch, targetId);
  if (target === undefined) return reject("Pick a curve to trim.");
  const others = context.sketch.entities.filter((entity) => entity.id !== targetId && entity.visible !== false && entity.kind !== "point");
  const boundaries = others.flatMap(curvesOf);
  if (target.kind === "line") {
    const direction: Vec2 = [target.end[0] - target.start[0], target.end[1] - target.start[1]];
    const length = Math.hypot(direction[0], direction[1]);
    const hits = boundaries.flatMap((curve) => lineHits(target.start, target.end, curve)).filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b);
    const pickT = clamp(((pick[0] - target.start[0]) * direction[0] + (pick[1] - target.start[1]) * direction[1]) / (length * length), 0, 1);
    const lower = [...hits].reverse().find((t) => t <= pickT) ?? 0;
    const upper = hits.find((t) => t >= pickT) ?? 1;
    const at = (t: number): Vec2 => [target.start[0] + direction[0] * t, target.start[1] + direction[1] * t];
    if (lower === 0 && upper === 1) return plan("Trim (deleted the whole line: nothing crosses it)", { removeEntityIds: [target.id] });
    const pieces: Line[] = [];
    if (lower > 0) pieces.push({ ...target, end: at(lower) });
    if (upper < 1) pieces.push(lower > 0 ? { ...target, id: context.newId("entity"), start: at(upper) } : { ...target, start: at(upper) });
    return plan("Trim line", { updateEntities: pieces.filter((piece) => piece.id === target.id), addEntities: pieces.filter((piece) => piece.id !== target.id) });
  }
  if (target.kind === "circle") {
    const angles = boundaries.flatMap((curve) => circleHits(target.center, target.radiusMm, curve)).map(wrapTwoPi).sort((a, b) => a - b);
    const unique = angles.filter((angle, index) => index === 0 || angle - angles[index - 1]! > 1e-6);
    if (unique.length < 2) return reject(unique.length === 0 ? "Nothing crosses this circle, so there is nothing to trim against." : "A circle needs at least two crossings to trim an arc out of it.", [target.id]);
    const pickAngle = wrapTwoPi(Math.atan2(pick[1] - target.center[1], pick[0] - target.center[0]));
    const before = [...unique].reverse().find((angle) => angle <= pickAngle) ?? unique[unique.length - 1]!;
    const after = unique.find((angle) => angle > pickAngle) ?? unique[0]!;
    // Keep the arc from `after` counter-clockwise round to `before`.
    const kept = arcEntity(target, context.newId("entity"), target.center, target.radiusMm, after, wrapTwoPi(before - after), false);
    return plan("Trim circle into an arc", { removeEntityIds: [target.id], addEntities: [kept] });
  }
  if (target.kind === "arc") {
    const frame = arcFrame(target);
    if (frame === undefined) return reject("The arc is degenerate.", [target.id]);
    const offsets = boundaries.flatMap((curve) => circleHits(frame.center, frame.radius, curve)).map((angle) => wrapTwoPi(angle - frame.startAngle)).filter((offset) => offset > 1e-6 && offset < frame.sweep - 1e-6).sort((a, b) => a - b);
    const pickOffset = wrapTwoPi(Math.atan2(pick[1] - frame.center[1], pick[0] - frame.center[0]) - frame.startAngle);
    const pickClamped = pickOffset > frame.sweep ? (pickOffset - frame.sweep < TWO_PI - pickOffset ? frame.sweep : 0) : pickOffset;
    const lower = [...offsets].reverse().find((offset) => offset <= pickClamped) ?? 0;
    const upper = offsets.find((offset) => offset >= pickClamped) ?? frame.sweep;
    if (lower === 0 && upper === frame.sweep) return plan("Trim (deleted the whole arc: nothing crosses it)", { removeEntityIds: [target.id] });
    const added: Arc[] = [];
    const updated: Arc[] = [];
    if (lower > 0) updated.push(arcEntity(target, target.id, frame.center, frame.radius, frame.startAngle, lower, frame.clockwise));
    if (upper < frame.sweep) (lower > 0 ? added : updated).push(arcEntity(target, lower > 0 ? context.newId("entity") : target.id, frame.center, frame.radius, frame.startAngle + upper, frame.sweep - upper, frame.clockwise));
    return plan("Trim arc", { updateEntities: updated, addEntities: added });
  }
  return reject(`Trim applies to lines, arcs and circles; a ${target.kind} is a single entity.`, [target.id], "Fillet or Chamfer a rectangle first, which turns it into separate lines and arcs.");
}

/** Extends the end of a line nearest the pick point to the first curve it reaches. */
export function extendAt(context: SketchEditContext, targetId: string, pick: Vec2): SketchEditResult {
  const target = find(context.sketch, targetId);
  if (target?.kind !== "line") return reject("Extend applies to lines. Pick near the end of a line.");
  const nearStart = distance(pick, target.start) <= distance(pick, target.end);
  const from = nearStart ? target.start : target.end;
  const away: Vec2 = nearStart ? [target.start[0] - target.end[0], target.start[1] - target.end[1]] : [target.end[0] - target.start[0], target.end[1] - target.start[1]];
  const length = Math.hypot(away[0], away[1]);
  const ray: Vec2 = [from[0] + away[0] / length, from[1] + away[1] / length];
  const others = context.sketch.entities.filter((entity) => entity.id !== targetId && entity.visible !== false && entity.kind !== "point");
  // Parameters along the ray from `from`: positive values lie beyond the end.
  const hits = others.flatMap(curvesOf).flatMap((curve) => lineHits(from, ray, curve)).filter((t) => t > 1e-6).sort((a, b) => a - b);
  if (hits.length === 0) return reject("Nothing lies beyond that end of the line, so it cannot be extended.", [target.id]);
  const reach: Vec2 = [from[0] + (ray[0] - from[0]) * hits[0]!, from[1] + (ray[1] - from[1]) * hits[0]!];
  return plan("Extend line", { updateEntities: [nearStart ? { ...target, start: reach } : { ...target, end: reach }] });
}

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

/** Constraint IDs on the given entities that are dimensions (radius, distance) or geometric relations (everything else). */
export function constraintsOnEntities(sketch: WorkbenchSketch, entityIds: readonly string[], family: "relations" | "dimensions", suppressed: boolean): readonly string[] {
  return sketch.constraints
    .filter((constraint) => constraint.entityIds.some((id) => entityIds.includes(id)))
    .filter((constraint) => (constraint.kind === "radius" || constraint.kind === "distance") === (family === "dimensions"))
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
