import { describeConstraint, entityNames } from "./sketch-translate.js";
import type { SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * Outline guard (second re-audit F3). A dimension or relation that the solver can satisfy only by folding a closed outline flat or
 * making it cross itself (two opposite sides of a parallelogram, a rounded rectangle or a slot given different lengths) is a
 * contradiction in the design even though the equations have a degenerate solution. This finds the closed chains of joined lines and
 * arcs, remembers how each one was walked, and says whether an edit turned a plain outline into a flat or self-crossing one.
 */

const JOIN_MM = 1e-4;
const MAX_SEGMENTS = 1_600;
const ARC_STEPS = 16;
const FLAT_RATIO = 1e-7;

interface Edge {
  readonly id: string;
  readonly reversed: boolean;
}

export interface Outline {
  readonly edges: readonly Edge[];
}

export interface OutlineProblem {
  readonly how: "crosses" | "flat" | "inverted" | "doubles-back";
  readonly entityIds: readonly string[];
}

interface Ends {
  readonly start: Vec2;
  readonly end: Vec2;
}

function endsOf(entity: SketchEntity): Ends | undefined {
  if (entity.construction) return undefined;
  if (entity.kind === "line" || entity.kind === "arc") return { start: entity.start, end: entity.end };
  return undefined;
}

/** The direction an arc turns from its start to its end through its middle point: 1 counter-clockwise, -1 clockwise, 0 for a straight one. */
function arcTurn(entity: SketchEntity): number {
  if (entity.kind !== "arc") return 0;
  const cross = (entity.mid[0] - entity.start[0]) * (entity.end[1] - entity.mid[1]) - (entity.mid[1] - entity.start[1]) * (entity.end[0] - entity.mid[0]);
  return Math.abs(cross) < 1e-12 ? 0 : Math.sign(cross);
}

/** The points of one edge from its start to its end; arcs are sampled through their middle point. */
function samples(entity: SketchEntity): readonly Vec2[] {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind !== "arc") return [];
  const [ax, ay] = entity.start;
  const [bx, by] = entity.mid;
  const [cx, cy] = entity.end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [entity.start, entity.mid, entity.end];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const radius = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const turn = (from: number, to: number): number => {
    let delta = (to - from) % (2 * Math.PI);
    if (delta < 0) delta += 2 * Math.PI;
    return delta;
  };
  let sweep = turn(a0, a1);
  if (turn(a0, am) > sweep) sweep -= 2 * Math.PI;
  const out: Vec2[] = [entity.start];
  for (let step = 1; step < ARC_STEPS; step += 1) {
    const angle = a0 + (sweep * step) / ARC_STEPS;
    out.push([ux + radius * Math.cos(angle), uy + radius * Math.sin(angle)] as const);
  }
  out.push(entity.end);
  return out;
}

/** The closed chains of the sketch: every set of lines and arcs whose ends meet in a ring with exactly two curves at each corner. */
export function closedOutlines(sketch: Pick<WorkbenchSketch, "entities">): readonly Outline[] {
  const nodes: Vec2[] = [];
  const cells = new Map<string, number[]>();
  const nodeAt = (point: Vec2): number => {
    const cx = Math.floor(point[0] / 1e-3);
    const cy = Math.floor(point[1] / 1e-3);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const index of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const node = nodes[index]!;
          if (Math.hypot(node[0] - point[0], node[1] - point[1]) <= JOIN_MM) return index;
        }
      }
    }
    nodes.push(point);
    const key = `${cx},${cy}`;
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [nodes.length - 1]);
    else bucket.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const edges: { readonly id: string; readonly a: number; readonly b: number }[] = [];
  for (const entity of sketch.entities) {
    const ends = endsOf(entity);
    if (ends === undefined) continue;
    edges.push({ id: entity.id, a: nodeAt(ends.start), b: nodeAt(ends.end) });
  }
  const incident = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    for (const node of [edge.a, edge.b]) {
      const list = incident.get(node);
      if (list === undefined) incident.set(node, [index]);
      else list.push(index);
    }
  });
  const seen = new Set<number>();
  const outlines: Outline[] = [];
  for (let first = 0; first < edges.length; first += 1) {
    if (seen.has(first)) continue;
    // Walk from this edge; the component is a ring only if every corner it meets has exactly two curves and the walk returns.
    const ring: Edge[] = [];
    let ok = true;
    let edge = first;
    let node = edges[first]!.a;
    const members: number[] = [];
    for (let guard = 0; guard <= edges.length; guard += 1) {
      const current = edges[edge]!;
      members.push(edge);
      const reversed = current.b === node && current.a !== node;
      ring.push({ id: current.id, reversed });
      const far = reversed ? current.a : current.b;
      const here = incident.get(far) ?? [];
      if (here.length !== 2 || current.a === current.b) { ok = false; break; }
      const next = here[0] === edge ? here[1]! : here[0]!;
      if (next === first) {
        ok = far === edges[first]!.a;
        break;
      }
      if (members.includes(next)) { ok = false; break; }
      edge = next;
      node = far;
    }
    for (const member of members) seen.add(member);
    if (ok && ring.length >= 2) outlines.push({ edges: ring });
  }
  return outlines;
}

function polyline(outline: Outline, byId: ReadonlyMap<string, SketchEntity>): { readonly points: readonly Vec2[]; readonly segments: number } | undefined {
  const points: Vec2[] = [];
  for (const edge of outline.edges) {
    const entity = byId.get(edge.id);
    if (entity === undefined) return undefined;
    const run = samples(entity);
    const ordered = edge.reversed ? [...run].reverse() : run;
    for (let index = points.length === 0 ? 0 : 1; index < ordered.length; index += 1) points.push(ordered[index]!);
  }
  return { points, segments: points.length - 1 };
}

function signedArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[index + 1]!;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function perimeter(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) total += Math.hypot(points[index + 1]![0] - points[index]![0], points[index + 1]![1] - points[index]![1]);
  return total;
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Whether any two segments that are not neighbours cross each other properly. */
function crossesItself(points: readonly Vec2[], scale: number): boolean {
  const count = points.length - 1;
  const eps = scale * 1e-9;
  for (let i = 0; i < count; i += 1) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[i + 1]!;
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      const [cx, cy] = points[j]!;
      const [dx, dy] = points[j + 1]!;
      const d1 = cross(ax, ay, bx, by, cx, cy);
      const d2 = cross(ax, ay, bx, by, dx, dy);
      const d3 = cross(cx, cy, dx, dy, ax, ay);
      const d4 = cross(cx, cy, dx, dy, bx, by);
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
    }
  }
  return false;
}

interface Verdict {
  readonly crosses: boolean;
  readonly flat: boolean;
  readonly area: number;
  /** For each edge of the ring: 1 when it bulges outwards, -1 when it bulges inwards (a corner turned the wrong way), 0 for a line. */
  readonly bulges: readonly number[];
  /** For each corner (the end of edge i meeting the start of edge i+1): the cosine between the way the outline arrives and leaves. */
  readonly turns: readonly number[];
}

function judge(outline: Outline, byId: ReadonlyMap<string, SketchEntity>): Verdict | undefined {
  const line = polyline(outline, byId);
  if (line === undefined || line.segments > MAX_SEGMENTS || line.segments < 2) return undefined;
  const length = perimeter(line.points);
  if (!(length > 0)) return undefined;
  const area = signedArea(line.points);
  const flat = Math.abs(area) / (length * length) < FLAT_RATIO;
  const bulges = outline.edges.map((edge) => {
    const entity = byId.get(edge.id);
    return entity === undefined ? 0 : arcTurn(entity) * (edge.reversed ? -1 : 1) * Math.sign(area);
  });
  const heading = (from: Vec2, to: Vec2): Vec2 => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const size = Math.hypot(dx, dy) || 1;
    return [dx / size, dy / size] as const;
  };
  const ends = outline.edges.map((edge) => {
    const entity = byId.get(edge.id);
    const run = entity === undefined ? [] : samples(entity);
    const ordered = edge.reversed ? [...run].reverse() : run;
    return ordered.length < 2 ? undefined : { first: heading(ordered[0]!, ordered[1]!), last: heading(ordered[ordered.length - 2]!, ordered[ordered.length - 1]!) };
  });
  const turns = ends.map((edge, index) => {
    const next = ends[(index + 1) % ends.length];
    return edge === undefined || next === undefined ? 0 : edge.last[0] * next.first[0] + edge.last[1] * next.first[1];
  });
  return { crosses: !flat && crossesItself(line.points, length), flat, area, bulges, turns };
}

/**
 * Compares the closed chains an edit touched before and after. A chain that was a plain, non-flat outline and is now flat, crossing
 * itself or turned inside out is reported; chains that were already bad are left alone, so a sketch that is not tidy can still be
 * edited. `touchedIds` are the curves the operation named or moved.
 */
export function outlineBroken(before: Pick<WorkbenchSketch, "entities">, after: Pick<WorkbenchSketch, "entities">, touchedIds: readonly string[]): OutlineProblem | undefined {
  const touched = new Set(touchedIds);
  const beforeById = new Map(before.entities.map((entity) => [entity.id, entity] as const));
  const afterById = new Map(after.entities.map((entity) => [entity.id, entity] as const));
  for (const outline of closedOutlines(before)) {
    if (!outline.edges.some((edge) => touched.has(edge.id))) continue;
    const was = judge(outline, beforeById);
    if (was === undefined || was.crosses || was.flat) continue;
    const now = judge(outline, afterById);
    if (now === undefined) continue;
    const entityIds = outline.edges.map((edge) => edge.id);
    if (now.flat) return { how: "flat", entityIds };
    if (now.crosses) return { how: "crosses", entityIds };
    if (Math.sign(now.area) !== Math.sign(was.area)) return { how: "inverted", entityIds };
    // A smooth (tangent) corner that carried on in the same direction and now doubles back (a cusp) is a tangent joint that flipped to the other side.
    if (was.turns.some((cosine, index) => cosine > 0.99 && now.turns[index]! < -0.9)) return { how: "doubles-back", entityIds };
    // A corner or cap arc that bulged outwards and now bulges inwards has jumped to the other branch of its relations.
    if (was.bulges.some((bulge, index) => bulge !== 0 && now.bulges[index] !== 0 && bulge !== now.bulges[index])) return { how: "inverted", entityIds };
  }
  return undefined;
}

const HOLDING_KINDS: readonly WorkbenchSketchConstraint["kind"][] = ["distance", "radius", "angle", "arc-length", "perimeter", "parallel", "perpendicular", "equal", "horizontal", "vertical", "collinear", "symmetry"];

/** The message of a refused edit that would fold or cross a closed outline, naming the curves and the relations that hold them. */
export function outlineBrokenMessage(problem: OutlineProblem, sketch: WorkbenchSketch, entered: WorkbenchSketchConstraint | undefined): { readonly message: string; readonly relatedIds: readonly string[]; readonly recovery: string } {
  const names = entityNames(sketch);
  const inside = new Set(problem.entityIds);
  const rank = (constraint: WorkbenchSketchConstraint): number => (HOLDING_KINDS.indexOf(constraint.kind) < 5 ? 0 : 1);
  // The dimensions come first: they are what the user typed and what the message is about.
  const holding = sketch.constraints.filter((constraint) => constraint.suppressed !== true && HOLDING_KINDS.includes(constraint.kind) && constraint.entityIds.some((id) => inside.has(id)))
    .map((constraint, index) => ({ constraint, index })).sort((a, b) => rank(a.constraint) - rank(b.constraint) || a.index - b.index).map((entry) => entry.constraint);
  const listed = holding.slice(0, 6).map((constraint) => describeConstraint(constraint, names));
  const outline = problem.entityIds.slice(0, 8).map((id) => names.get(id) ?? "a curve").join(", ") + (problem.entityIds.length > 8 ? ` and ${problem.entityIds.length - 8} more` : "");
  const what = problem.how === "flat" ? "fold the closed outline flat onto one line" : problem.how === "crosses" ? "make the closed outline cross itself" : problem.how === "doubles-back" ? "make the closed outline double back on itself at a corner" : "turn the closed outline inside out";
  const cause = entered === undefined ? "This change" : `${describeConstraint(entered, names)}`;
  const tail = holding.every((constraint) => constraint.id === entered?.id) ? "" : ` These relations contradict each other and cannot all hold while the outline stays closed: ${listed.join(", ")}${holding.length > listed.length ? ` and ${holding.length - listed.length} more` : ""}. Opposite sides of a parallelogram, rounded rectangle or slot must stay equal.`;
  return {
    message: `${cause} would ${what} (${outline}).${tail}`,
    relatedIds: [...problem.entityIds, ...holding.map((constraint) => constraint.id), ...(entered === undefined ? [] : [entered.id])],
    recovery: "Change the earlier dimension on the opposite side instead, or relax it, then set this one."
  };
}
