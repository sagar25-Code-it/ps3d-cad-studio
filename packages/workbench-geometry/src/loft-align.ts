type Point2 = readonly [number, number];

function signedArea(loop: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

function meanOf(loop: readonly Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const point of loop) { x += point[0]; y += point[1]; }
  return [x / loop.length, y / loop.length];
}

/**
 * Lines up the second loop of a two-profile loft with the first: the same winding, and the start vertex that pairs the corners with the least
 * twist. The start vertex of an outline is an accident of how it was drawn, and pairing by index alone twisted two identical squares into a
 * bi-pyramid. Loops of one length are compared around their own centres, so where the profiles sit does not change the pairing.
 */
export function alignLoopStart(first: readonly Point2[], second: readonly Point2[]): readonly Point2[] {
  if (first.length !== second.length || first.length < 3) return second;
  let loop = second;
  if (signedArea(first) * signedArea(second) < 0) loop = [...second].reverse();
  const a = meanOf(first);
  const b = meanOf(loop);
  const count = first.length;
  let bestShift = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < count; shift += 1) {
    let cost = 0;
    for (let index = 0; index < count; index += 1) {
      const p = first[index]!;
      const q = loop[(index + shift) % count]!;
      const dx = p[0] - a[0] - (q[0] - b[0]);
      const dy = p[1] - a[1] - (q[1] - b[1]);
      cost += dx * dx + dy * dy;
    }
    // A strictly smaller cost wins, so a loop that is already aligned (or ties, as a circle does) keeps its own start.
    if (shift === 0 || cost < bestCost - 1e-9 * (1 + bestCost)) { bestCost = cost; bestShift = shift; }
  }
  return bestShift === 0 ? loop : loop.map((_, index) => loop[(index + bestShift) % count]!);
}
