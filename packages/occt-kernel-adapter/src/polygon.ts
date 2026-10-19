/**
 * Planar polygon triangulation for the reference B-rep kernel.
 *
 * Caps of an extruded or revolved profile used to be triangulated as a fan from the
 * profile centroid, which is only valid for star-shaped outlines. A C-shaped profile
 * came out with 13% too much volume. This module triangulates any simple outline,
 * with any number of holes, by bridging each hole into the outline and then
 * ear-clipping. It validates its input and throws rather than guessing, so a profile
 * that crosses itself fails closed.
 */

export type Point2 = readonly [number, number];

const COINCIDENT = 1e-12;
const DEGENERATE_AREA = 1e-14;

/** Signed area of a closed loop: positive when counter-clockwise. */
export function signedArea2(points: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - next[0] * current[1];
  }
  return twice / 2;
}

/**
 * Throws if the loops do not form a valid region: every loop needs three or more
 * points and a non-zero area, no edge may cross or touch a non-adjacent edge, and
 * every hole must lie inside the outline and outside every other hole.
 */
export function validateLoops(outer: readonly Point2[], holes: readonly (readonly Point2[])[] = []): void {
  const frame = normalizeFrame([outer, ...holes]);
  checkLoops(frame.loops[0]!, frame.loops.slice(1));
}

/**
 * Triangulates a region. The result is a flat list of index triples into the
 * concatenated point list `[...outer, ...holes[0], ...holes[1], ...]`, each triangle
 * wound counter-clockwise in the plane of the input coordinates.
 */
export function triangulateLoops(outer: readonly Point2[], holes: readonly (readonly Point2[])[] = []): readonly number[] {
  const frame = normalizeFrame([outer, ...holes]);
  const outerPoints = frame.loops[0]!;
  const holePoints = frame.loops.slice(1);
  checkLoops(outerPoints, holePoints);

  const points: Point2[] = [...outerPoints, ...holePoints.flat()];
  let ring = indexRange(0, outerPoints.length);
  if (signedArea2(outerPoints) < 0) ring.reverse();

  const holeRings: number[][] = [];
  let offset = outerPoints.length;
  for (const hole of holePoints) {
    const indices = indexRange(offset, hole.length);
    if (signedArea2(hole) > 0) indices.reverse();
    holeRings.push(indices);
    offset += hole.length;
  }
  // Bridge the right-most holes first, which keeps the bridges short and non-crossing.
  const pending = holeRings
    .map((indices) => ({ indices, maxX: Math.max(...indices.map((index) => points[index]![0])) }))
    .sort((left, right) => right.maxX - left.maxX);
  while (pending.length > 0) {
    const next = pending.shift()!;
    ring = bridgeHole(ring, next.indices, points, pending.map((entry) => entry.indices));
  }
  return earClip(ring, points);
}

interface Frame {
  readonly loops: readonly (readonly Point2[])[];
}

/** Scales the input into a unit box so tolerances are independent of the unit (metres or millimetres). */
function normalizeFrame(loops: readonly (readonly Point2[])[]): Frame {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    for (const [x, y] of loop) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("The profile contains a non-finite coordinate.");
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!(scale > 0)) throw new Error("The profile has no extent.");
  return { loops: loops.map((loop) => loop.map(([x, y]): Point2 => [(x - minX) / scale, (y - minY) / scale])) };
}

function checkLoops(outer: readonly Point2[], holes: readonly (readonly Point2[])[]): void {
  const loops = [outer, ...holes];
  loops.forEach((loop, index) => {
    const label = index === 0 ? "The profile outline" : `Hole ${index}`;
    if (loop.length < 3) throw new Error(`${label} needs at least three points.`);
    if (Math.abs(signedArea2(loop)) <= DEGENERATE_AREA) throw new Error(`${label} has no area.`);
  });

  interface Edge { readonly loop: number; readonly index: number; readonly count: number; readonly from: Point2; readonly to: Point2 }
  const edges: Edge[] = [];
  loops.forEach((loop, loopIndex) => {
    for (let index = 0; index < loop.length; index += 1) {
      edges.push({ loop: loopIndex, index, count: loop.length, from: loop[index]!, to: loop[(index + 1) % loop.length]! });
    }
  });
  for (let first = 0; first < edges.length; first += 1) {
    for (let second = first + 1; second < edges.length; second += 1) {
      const left = edges[first]!;
      const right = edges[second]!;
      if (left.loop === right.loop) {
        const adjacent = right.index === left.index + 1 || (left.index === 0 && right.index === left.count - 1);
        if (adjacent) continue;
      }
      if (segmentsIntersect(left.from, left.to, right.from, right.to)) {
        throw new Error(left.loop === right.loop
          ? (left.loop === 0 ? "The profile outline crosses itself." : `Hole ${left.loop} crosses itself.`)
          : "A hole crosses the profile outline or another hole.");
      }
    }
  }
  holes.forEach((hole, index) => {
    if (!pointInRing(hole[0]!, outer)) throw new Error(`Hole ${index + 1} lies outside the profile outline.`);
    holes.forEach((other, otherIndex) => {
      if (otherIndex !== index && pointInRing(hole[0]!, other)) throw new Error(`Hole ${index + 1} overlaps hole ${otherIndex + 1}.`);
    });
  });
}

function indexRange(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/** Splices a hole into the outer ring through the shortest bridge that crosses nothing. */
function bridgeHole(ring: readonly number[], hole: readonly number[], points: readonly Point2[], otherHoles: readonly (readonly number[])[]): number[] {
  let holeStart = 0;
  for (let index = 1; index < hole.length; index += 1) {
    const candidate = points[hole[index]!]!;
    const best = points[hole[holeStart]!]!;
    if (candidate[0] > best[0] + COINCIDENT || (Math.abs(candidate[0] - best[0]) <= COINCIDENT && candidate[1] < best[1])) holeStart = index;
  }
  const holePoint = points[hole[holeStart]!]!;
  const candidates = ring
    .map((pointIndex, position) => ({ position, distance: squaredDistance(points[pointIndex]!, holePoint) }))
    .sort((left, right) => left.distance - right.distance);
  for (const { position } of candidates) {
    const ringPoint = points[ring[position]!]!;
    if (!bridgeIsClear(holePoint, ringPoint, ring, hole, otherHoles, points)) continue;
    const holeSequence: number[] = [];
    for (let step = 0; step < hole.length; step += 1) holeSequence.push(hole[(holeStart + step) % hole.length]!);
    return [...ring.slice(0, position + 1), ...holeSequence, hole[holeStart]!, ring[position]!, ...ring.slice(position + 1)];
  }
  throw new Error("A hole could not be connected to the profile outline.");
}

function bridgeIsClear(from: Point2, to: Point2, ring: readonly number[], hole: readonly number[], otherHoles: readonly (readonly number[])[], points: readonly Point2[]): boolean {
  const touchesEnd = (a: Point2, b: Point2): boolean => samePosition(a, to) || samePosition(b, to) || samePosition(a, from) || samePosition(b, from);
  const crossesLoop = (loop: readonly number[]): boolean => {
    for (let index = 0; index < loop.length; index += 1) {
      const a = points[loop[index]!]!;
      const b = points[loop[(index + 1) % loop.length]!]!;
      if (touchesEnd(a, b)) continue;
      if (segmentsIntersect(from, to, a, b)) return true;
    }
    return false;
  };
  if (crossesLoop(ring) || crossesLoop(hole)) return false;
  for (const other of otherHoles) if (crossesLoop(other)) return false;
  const middle: Point2 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  if (!pointInRing(middle, ring.map((index) => points[index]!))) return false;
  if (pointInRing(middle, hole.map((index) => points[index]!))) return false;
  for (const other of otherHoles) if (pointInRing(middle, other.map((index) => points[index]!))) return false;
  return true;
}

function earClip(ringInput: readonly number[], points: readonly Point2[]): number[] {
  const ring = [...ringInput];
  const triangles: number[] = [];
  let guard = ring.length * ring.length + 16;
  while (ring.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let position = 0; position < ring.length; position += 1) {
      const previousIndex = ring[(position + ring.length - 1) % ring.length]!;
      const currentIndex = ring[position]!;
      const nextIndex = ring[(position + 1) % ring.length]!;
      const previous = points[previousIndex]!;
      const current = points[currentIndex]!;
      const next = points[nextIndex]!;
      const area = orient(previous, current, next);
      if (Math.abs(area) <= DEGENERATE_AREA) {
        // A collinear or repeated vertex adds no area; drop it without emitting a triangle.
        ring.splice(position, 1);
        clipped = true;
        break;
      }
      if (area < 0) continue;
      let blocked = false;
      for (const other of ring) {
        if (other === previousIndex || other === currentIndex || other === nextIndex) continue;
        const candidate = points[other]!;
        if (samePosition(candidate, previous) || samePosition(candidate, current) || samePosition(candidate, next)) continue;
        if (pointInTriangle(candidate, previous, current, next)) { blocked = true; break; }
      }
      if (blocked) continue;
      triangles.push(previousIndex, currentIndex, nextIndex);
      ring.splice(position, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("The profile could not be triangulated; it may cross itself or be degenerate.");
  }
  if (ring.length === 3) {
    const [a, b, c] = [points[ring[0]!]!, points[ring[1]!]!, points[ring[2]!]!];
    if (Math.abs(orient(a, b, c)) > DEGENERATE_AREA) triangles.push(ring[0]!, ring[1]!, ring[2]!);
  }
  return triangles;
}

function orient(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function samePosition(a: Point2, b: Point2): boolean {
  return Math.abs(a[0] - b[0]) <= COINCIDENT && Math.abs(a[1] - b[1]) <= COINCIDENT;
}

function squaredDistance(a: Point2, b: Point2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const first = orient(a, b, point);
  const second = orient(b, c, point);
  const third = orient(c, a, point);
  const hasNegative = first < -DEGENERATE_AREA || second < -DEGENERATE_AREA || third < -DEGENERATE_AREA;
  const hasPositive = first > DEGENERATE_AREA || second > DEGENERATE_AREA || third > DEGENERATE_AREA;
  return !(hasNegative && hasPositive);
}

function onSegment(a: Point2, b: Point2, point: Point2): boolean {
  return point[0] >= Math.min(a[0], b[0]) - COINCIDENT && point[0] <= Math.max(a[0], b[0]) + COINCIDENT
    && point[1] >= Math.min(a[1], b[1]) - COINCIDENT && point[1] <= Math.max(a[1], b[1]) + COINCIDENT;
}

/** True when the closed segments share any point, including a touching endpoint. */
function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const first = orient(c, d, a);
  const second = orient(c, d, b);
  const third = orient(a, b, c);
  const fourth = orient(a, b, d);
  if (((first > DEGENERATE_AREA && second < -DEGENERATE_AREA) || (first < -DEGENERATE_AREA && second > DEGENERATE_AREA))
    && ((third > DEGENERATE_AREA && fourth < -DEGENERATE_AREA) || (third < -DEGENERATE_AREA && fourth > DEGENERATE_AREA))) return true;
  if (Math.abs(first) <= DEGENERATE_AREA && onSegment(c, d, a)) return true;
  if (Math.abs(second) <= DEGENERATE_AREA && onSegment(c, d, b)) return true;
  if (Math.abs(third) <= DEGENERATE_AREA && onSegment(a, b, c)) return true;
  if (Math.abs(fourth) <= DEGENERATE_AREA && onSegment(a, b, d)) return true;
  return false;
}

/** Even-odd ray cast; a point exactly on the boundary is not reliably classified, so callers pass interior probes. */
function pointInRing(point: Point2, ring: readonly Point2[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
