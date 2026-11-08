/**
 * Offsets a closed polygon sideways by a distance, for thin walls. Each edge moves along its normal and neighbouring edges meet at a sharp
 * (mitred) corner. The result is checked, so an offset that folds over itself (a wall thicker than the profile allows) is refused rather
 * than returned as garbage.
 */

type P2 = readonly [number, number];

export type PolygonOffset =
  | { readonly ok: true; readonly points: readonly P2[] }
  | { readonly ok: false; readonly message: string };

const MITRE_LIMIT = 4;

function signedArea(points: readonly P2[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

function distanceToSegment(point: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const orient = (p: P2, q: P2, r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c); const o2 = orient(a, b, d); const o3 = orient(c, d, a); const o4 = orient(c, d, b);
  return ((o1 > 1e-9 && o2 < -1e-9) || (o1 < -1e-9 && o2 > 1e-9)) && ((o3 > 1e-9 && o4 < -1e-9) || (o3 < -1e-9 && o4 > 1e-9));
}

function insideOrOn(point: P2, polygon: readonly P2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index]!;
    const [xj, yj] = polygon[previous]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Moves every edge of `polygon` sideways by `distanceMm`: positive shrinks the polygon (offsets inward), negative grows it. The points
 * come back in the order they were given.
 */
export function offsetPolygon(polygon: readonly P2[], distanceMm: number): PolygonOffset {
  if (!Number.isFinite(distanceMm)) return { ok: false, message: "The wall thickness is not a number." };
  const cleaned: P2[] = [];
  for (const point of polygon) {
    const previous = cleaned[cleaned.length - 1];
    if (previous === undefined || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 1e-9) cleaned.push(point);
  }
  while (cleaned.length > 1 && Math.hypot(cleaned[0]![0] - cleaned[cleaned.length - 1]![0], cleaned[0]![1] - cleaned[cleaned.length - 1]![1]) <= 1e-9) cleaned.pop();
  if (cleaned.length < 3) return { ok: false, message: "The profile has fewer than three corners." };
  if (distanceMm === 0) return { ok: true, points: cleaned };
  const reversed = signedArea(cleaned) < 0;
  const ccw = reversed ? [...cleaned].reverse() : cleaned;
  const count = ccw.length;
  // Edge i runs ccw[i] -> ccw[i+1]; its inward normal (counter-clockwise polygon) is the direction turned left.
  const edges = ccw.map((start, index) => {
    const end = ccw[(index + 1) % count]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const direction: P2 = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    return { start, direction, normal: [-direction[1], direction[0]] as P2 };
  });
  const moved: P2[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = edges[(index + count - 1) % count]!;
    const after = edges[index]!;
    const corner = ccw[index]!;
    const turn = before.direction[0] * after.direction[1] - before.direction[1] * after.direction[0];
    const bend = before.direction[0] * after.direction[0] + before.direction[1] * after.direction[1];
    if (Math.abs(turn) < 1e-9) {
      if (bend < 0) return { ok: false, message: "The profile doubles back on itself, so it cannot be given a wall." };
      moved.push([corner[0] + after.normal[0] * distanceMm, corner[1] + after.normal[1] * distanceMm]);
      continue;
    }
    // Intersect the two moved edge lines.
    const p1: P2 = [corner[0] + before.normal[0] * distanceMm, corner[1] + before.normal[1] * distanceMm];
    const p2: P2 = [corner[0] + after.normal[0] * distanceMm, corner[1] + after.normal[1] * distanceMm];
    const t = ((p2[0] - p1[0]) * after.direction[1] - (p2[1] - p1[1]) * after.direction[0]) / turn;
    const point: P2 = [p1[0] + before.direction[0] * t, p1[1] + before.direction[1] * t];
    if (Math.hypot(point[0] - corner[0], point[1] - corner[1]) > MITRE_LIMIT * Math.abs(distanceMm)) return { ok: false, message: "A corner of the profile is too sharp to give a wall; round it or use a thinner wall." };
    moved.push(point);
  }
  const grows = distanceMm < 0;
  const area = signedArea(moved);
  if (area <= 1e-9 || (!grows && area >= signedArea(ccw)) || (grows && area <= signedArea(ccw))) return { ok: false, message: "The wall is thicker than the profile allows." };
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      if (segmentsCross(moved[i]!, moved[(i + 1) % count]!, moved[j]!, moved[(j + 1) % count]!)) return { ok: false, message: "The wall is thicker than the profile allows." };
    }
  }
  // Every moved corner must really sit a wall's thickness from the original outline, on the correct side of it.
  const wanted = Math.abs(distanceMm) * (1 - 1e-3) - 1e-6;
  for (const point of moved) {
    const inside = insideOrOn(point, ccw);
    if (inside === grows) return { ok: false, message: "The wall is thicker than the profile allows." };
    let nearest = Infinity;
    for (let index = 0; index < count; index += 1) nearest = Math.min(nearest, distanceToSegment(point, ccw[index]!, ccw[(index + 1) % count]!));
    if (nearest < wanted) return { ok: false, message: "The wall is thicker than the profile allows." };
  }
  return { ok: true, points: reversed ? moved.reverse() : moved };
}
