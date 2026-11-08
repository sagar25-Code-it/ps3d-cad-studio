/** Helpers for outlines that are wrapped onto a cylinder (see wrap.ts). */
type P2 = readonly [number, number];

/** Douglas-Peucker on an open run: keeps the points that stray more than `tolerance` from the line between the ends. */
function simplifyRun(points: readonly P2[], tolerance: number): P2[] {
  if (points.length <= 2) return [...points];
  const a = points[0]!; const b = points[points.length - 1]!;
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const l = Math.hypot(dx, dy);
  let worst = -1; let at = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const q = points[i]!;
    const d = l < 1e-12 ? Math.hypot(q[0] - a[0], q[1] - a[1]) : Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tolerance) return [a, b];
  return [...simplifyRun(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplifyRun(points.slice(at), tolerance)];
}

/** Thins a closed polygon to the points that matter at `tolerance` (a 72-point circle keeps about 20), and removes repeated points. */
export function simplifyClosed(polygon: readonly P2[], tolerance: number): P2[] {
  const unique = polygon.filter((p, i) => { const q = polygon[(i + polygon.length - 1) % polygon.length]!; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9; });
  if (unique.length <= 4) return unique;
  let far = 0; let best = -1;
  for (let i = 1; i < unique.length; i += 1) { const d = Math.hypot(unique[i]![0] - unique[0]![0], unique[i]![1] - unique[0]![1]); if (d > best) { best = d; far = i; } }
  const first = simplifyRun(unique.slice(0, far + 1), tolerance);
  const second = simplifyRun([...unique.slice(far), unique[0]!], tolerance);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  return merged.length >= 3 ? merged : unique;
}

/** Whether `point` is inside the polygon (even-odd). */
export function insidePolygon(point: P2, ring: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!; const b = ring[j]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
