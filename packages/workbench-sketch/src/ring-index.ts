import type { Vec2 } from "../../workbench-core/src/index.js";

/**
 * A ring cut into horizontal slabs, each listing the edges that reach into it, so "is this point inside" and "is anything of the ring
 * within a margin of this point" look at a handful of edges instead of all of them. The outline of a plate with hundreds of notches has tens
 * of thousands of edges, and every hole and region is asked about it.
 */
export class RingIndex {
  private readonly slabs: number[][];
  private readonly minY: number;
  private readonly slabHeight: number;

  constructor(private readonly points: readonly Vec2[]) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point[1] < minY) minY = point[1];
      if (point[1] > maxY) maxY = point[1];
    }
    const count = Math.max(1, Math.min(2048, Math.ceil(Math.sqrt(points.length) * 2)));
    this.minY = minY;
    this.slabHeight = maxY > minY ? (maxY - minY) / count : 1;
    this.slabs = Array.from({ length: count }, () => []);
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const from = this.slabOf(Math.min(a[1], b[1]));
      const to = this.slabOf(Math.max(a[1], b[1]));
      for (let slab = from; slab <= to; slab += 1) this.slabs[slab]!.push(index);
    }
  }

  private slabOf(y: number): number {
    return Math.max(0, Math.min(this.slabs.length - 1, Math.floor((y - this.minY) / this.slabHeight)));
  }

  /** Even-odd test, the same rule as `pointInRing`. */
  contains(point: Vec2): boolean {
    const ring = this.points;
    let inside = false;
    for (const index of this.slabs[this.slabOf(point[1])]!) {
      const a = ring[index]!;
      const b = ring[(index + 1) % ring.length]!;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  /** Whether any edge passes within `margin` of the point. */
  within(point: Vec2, margin: number): boolean {
    const ring = this.points;
    const from = this.slabOf(point[1] - margin);
    const to = this.slabOf(point[1] + margin);
    for (let slab = from; slab <= to; slab += 1) {
      for (const index of this.slabs[slab]!) {
        const a = ring[index]!;
        const b = ring[(index + 1) % ring.length]!;
        if (Math.min(a[0], b[0]) - margin > point[0] || Math.max(a[0], b[0]) + margin < point[0]) continue;
        if (Math.min(a[1], b[1]) - margin > point[1] || Math.max(a[1], b[1]) + margin < point[1]) continue;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lengthSquared = dx * dx + dy * dy;
        const w = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
        if (Math.hypot(point[0] - (a[0] + dx * w), point[1] - (a[1] + dy * w)) <= margin) return true;
      }
    }
    return false;
  }
}
