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
const MAX_BRIDGE_ATTEMPTS = 4000;

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
  // A grid over the unit box keeps the crossing test near-linear: a plate with hundreds of holes has tens of thousands of edges, and
  // comparing every pair took seconds. Each edge is compared only with the edges that share a grid cell; the lowest offending pair is
  // still the one reported, as with the plain double loop.
  const cells = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(edges.length))));
  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  const cellOf = (value: number): number => Math.max(0, Math.min(cells - 1, Math.floor(value * cells)));
  const pad = 1e-9;
  const spans = edges.map((edge): readonly [number, number, number, number] => [
    cellOf(Math.min(edge.from[0], edge.to[0]) - pad), cellOf(Math.max(edge.from[0], edge.to[0]) + pad),
    cellOf(Math.min(edge.from[1], edge.to[1]) - pad), cellOf(Math.max(edge.from[1], edge.to[1]) + pad)
  ]);
  spans.forEach((span, edgeIndex) => {
    for (let cx = span[0]; cx <= span[1]; cx += 1) for (let cy = span[2]; cy <= span[3]; cy += 1) grid[cy * cells + cx]!.push(edgeIndex);
  });
  const stamp = new Int32Array(edges.length).fill(-1);
  for (let first = 0; first < edges.length; first += 1) {
    const left = edges[first]!;
    const span = spans[first]!;
    let hit = -1;
    for (let cx = span[0]; cx <= span[1]; cx += 1) {
      for (let cy = span[2]; cy <= span[3]; cy += 1) {
        for (const second of grid[cy * cells + cx]!) {
          if (second <= first || stamp[second] === first) continue;
          stamp[second] = first;
          if (hit >= 0 && second > hit) continue;
          const right = edges[second]!;
          if (left.loop === right.loop) {
            const adjacent = right.index === left.index + 1 || (left.index === 0 && right.index === left.count - 1);
            if (adjacent) continue;
          }
          if (segmentsIntersect(left.from, left.to, right.from, right.to)) hit = second;
        }
      }
    }
    if (hit >= 0) {
      const right = edges[hit]!;
      throw new Error(left.loop === right.loop
        ? (left.loop === 0 ? "The profile outline crosses itself." : `Hole ${left.loop} crosses itself.`)
        : "A hole crosses the profile outline or another hole.");
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

/**
 * Whether the direction from the ring vertex at `position` toward `target` points into the region the ring encloses (the ring runs
 * counter-clockwise around its interior, so the interior is on the left). A vertex that appears twice because an earlier bridge touched
 * it has two corners; only the corner whose wedge holds the bridge is a valid place to splice.
 */
function opensToward(ring: readonly number[], position: number, target: Point2, points: readonly Point2[]): boolean {
  const here = points[ring[position]!]!;
  const before = points[ring[(position + ring.length - 1) % ring.length]!]!;
  const after = points[ring[(position + 1) % ring.length]!]!;
  const wx = after[0] - here[0];
  const wy = after[1] - here[1];
  const ux = before[0] - here[0];
  const uy = before[1] - here[1];
  const dx = target[0] - here[0];
  const dy = target[1] - here[1];
  const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;
  if (cross(wx, wy, ux, uy) > DEGENERATE_AREA) return cross(wx, wy, dx, dy) > 0 && cross(dx, dy, ux, uy) > 0;
  return !(cross(ux, uy, dx, dy) >= 0 && cross(dx, dy, wx, wy) >= 0);
}

/**
 * Splices a hole into the ring through the shortest bridge that crosses nothing and leaves both ends through their interior wedge.
 * Hole corners are tried right-most first and ring corners nearest first, so a hole that lines up with the others is still joined.
 */
function bridgeHole(ring: readonly number[], hole: readonly number[], points: readonly Point2[], otherHoles: readonly (readonly number[])[]): number[] {
  const holeOrder = hole
    .map((pointIndex, position) => ({ position, point: points[pointIndex]! }))
    .sort((left, right) => (Math.abs(left.point[0] - right.point[0]) <= COINCIDENT ? left.point[1] - right.point[1] : right.point[0] - left.point[0]));
  let tried = 0;
  for (const start of holeOrder) {
    const holePoint = start.point;
    for (const { position } of nearestRingCorners(ring, holePoint, points)) {
      tried += 1;
      if (tried > MAX_BRIDGE_ATTEMPTS) break;
      const ringPoint = points[ring[position]!]!;
      if (!opensToward(ring, position, holePoint, points) || !opensToward(hole, start.position, ringPoint, points)) continue;
      if (!bridgeIsClear(holePoint, ringPoint, ring, hole, otherHoles, points)) continue;
      const holeSequence: number[] = [];
      for (let step = 0; step < hole.length; step += 1) holeSequence.push(hole[(start.position + step) % hole.length]!);
      return [...ring.slice(0, position + 1), ...holeSequence, hole[start.position]!, ring[position]!, ...ring.slice(position + 1)];
    }
    if (tried > MAX_BRIDGE_ATTEMPTS) break;
  }
  throw new Error("A hole could not be connected to the profile outline.");
}

/**
 * The ring corners nearest to a point, nearest first. The first dozens are found in one pass without sorting the whole ring (a plate with
 * hundreds of holes has a ring of tens of thousands of corners and one search per hole); the rest follow in a full sort only when the
 * nearest ones were all refused, which is rare.
 */
function* nearestRingCorners(ring: readonly number[], target: Point2, points: readonly Point2[]): Generator<{ readonly position: number }> {
  const KEEP = 48;
  const best: { position: number; distance: number }[] = [];
  for (let position = 0; position < ring.length; position += 1) {
    const distance = squaredDistance(points[ring[position]!]!, target);
    if (best.length === KEEP && distance >= best[KEEP - 1]!.distance) continue;
    let slot = best.length < KEEP ? best.length : KEEP - 1;
    if (best.length < KEEP) best.push({ position, distance }); else best[slot] = { position, distance };
    while (slot > 0 && best[slot - 1]!.distance > best[slot]!.distance) { const swap = best[slot - 1]!; best[slot - 1] = best[slot]!; best[slot] = swap; slot -= 1; }
  }
  for (const entry of best) yield entry;
  if (ring.length <= KEEP) return;
  const taken = new Set(best.map((entry) => entry.position));
  const rest = ring
    .map((pointIndex, position) => ({ position, distance: squaredDistance(points[pointIndex]!, target) }))
    .filter((entry) => !taken.has(entry.position))
    .sort((left, right) => left.distance - right.distance);
  for (const entry of rest) yield entry;
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

/**
 * Ear clipping on a linked ring with a grid over its vertices. A candidate ear is checked only against the vertices that fall inside its
 * own bounding box, and the scan resumes where the last ear was cut, so a plate with hundreds of holes (tens of thousands of ring
 * vertices) clips in near-linear time instead of testing every vertex against every ear.
 */
function earClip(ringInput: readonly number[], points: readonly Point2[]): number[] {
  const count = ringInput.length;
  const pointOf = Int32Array.from(ringInput);
  const before = new Int32Array(count);
  const after = new Int32Array(count);
  const alive = new Uint8Array(count).fill(1);
  for (let node = 0; node < count; node += 1) { before[node] = (node + count - 1) % count; after[node] = (node + 1) % count; }
  const cells = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(count))));
  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  const cellOf = (value: number): number => Math.max(0, Math.min(cells - 1, Math.floor(value * cells)));
  for (let node = 0; node < count; node += 1) {
    const point = points[pointOf[node]!]!;
    grid[cellOf(point[1]) * cells + cellOf(point[0])]!.push(node);
  }
  const pad = 1e-7;
  const blockedBy = (previousIndex: number, currentIndex: number, nextIndex: number, previous: Point2, current: Point2, next: Point2): boolean => {
    const x0 = cellOf(Math.min(previous[0], current[0], next[0]) - pad);
    const x1 = cellOf(Math.max(previous[0], current[0], next[0]) + pad);
    const y0 = cellOf(Math.min(previous[1], current[1], next[1]) - pad);
    const y1 = cellOf(Math.max(previous[1], current[1], next[1]) + pad);
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        for (const node of grid[cy * cells + cx]!) {
          if (alive[node] === 0) continue;
          const other = pointOf[node]!;
          if (other === previousIndex || other === currentIndex || other === nextIndex) continue;
          const candidate = points[other]!;
          if (samePosition(candidate, previous) || samePosition(candidate, current) || samePosition(candidate, next)) continue;
          if (pointInTriangle(candidate, previous, current, next)) return true;
        }
      }
    }
    return false;
  };
  const triangles: number[] = [];
  let remaining = count;
  let cursor = 0;
  const remove = (node: number): void => {
    const previousNode = before[node]!;
    const nextNode = after[node]!;
    after[previousNode] = nextNode;
    before[nextNode] = previousNode;
    alive[node] = 0;
    remaining -= 1;
    cursor = previousNode;
  };
  let guard = count + 16;
  while (remaining > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    let straightNode = -1;
    let node = cursor;
    for (let step = 0; step < remaining; step += 1, node = after[node]!) {
      const previousIndex = pointOf[before[node]!]!;
      const currentIndex = pointOf[node]!;
      const nextIndex = pointOf[after[node]!]!;
      const previous = points[previousIndex]!;
      const current = points[currentIndex]!;
      const next = points[nextIndex]!;
      const area = orient(previous, current, next);
      if (Math.abs(area) <= DEGENERATE_AREA) {
        if (isStraightThrough(previous, current, next)) {
          // A vertex that sits on the straight line between its neighbours is a real corner of the walls (for example the point where
          // two bridges meet a hole). Dropping it would leave the cap edge spanning a vertex the wall still uses, a T-junction that opens the
          // mesh; keep it until a neighbour has been clipped, and only emit a sliver for it when nothing else can be clipped.
          if (straightNode < 0) straightNode = node;
          continue;
        }
        // A repeated vertex or a zero-width spike adds no area and has no partner edge to open; drop it without emitting a triangle.
        remove(node);
        clipped = true;
        break;
      }
      if (area < 0) continue;
      if (blockedBy(previousIndex, currentIndex, nextIndex, previous, current, next)) continue;
      triangles.push(previousIndex, currentIndex, nextIndex);
      remove(node);
      clipped = true;
      break;
    }
    if (!clipped && straightNode >= 0) {
      // A zero-area triangle keeps every edge paired: previous-current and current-next pair with the bridge side, next-previous with the ring.
      triangles.push(pointOf[before[straightNode]!]!, pointOf[straightNode]!, pointOf[after[straightNode]!]!);
      remove(straightNode);
      clipped = true;
    }
    if (!clipped) throw new Error("The profile could not be triangulated; it may cross itself or be degenerate.");
  }
  if (remaining === 3) {
    const first = cursor;
    const second = after[first]!;
    const third = after[second]!;
    const [a, b, c] = [points[pointOf[first]!]!, points[pointOf[second]!]!, points[pointOf[third]!]!];
    if (Math.abs(orient(a, b, c)) > DEGENERATE_AREA
      || isStraightThrough(a, b, c) || isStraightThrough(b, c, a) || isStraightThrough(c, a, b)) triangles.push(pointOf[first]!, pointOf[second]!, pointOf[third]!);
  }
  return triangles;
}

/** True when `current` lies strictly between `previous` and `next` on one straight line (a 180 degree corner, not a spike or a repeat). */
function isStraightThrough(previous: Point2, current: Point2, next: Point2): boolean {
  if (samePosition(previous, current) || samePosition(current, next) || samePosition(previous, next)) return false;
  const dot = (previous[0] - current[0]) * (next[0] - current[0]) + (previous[1] - current[1]) * (next[1] - current[1]);
  return dot < 0;
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
