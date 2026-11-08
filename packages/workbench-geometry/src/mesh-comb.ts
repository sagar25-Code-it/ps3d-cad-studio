/**
 * Curvature comb on the section curves of a body: the body is cut by an axis plane, the cut edges are chained into
 * curves, and at every vertex of a curve a tooth is drawn along the in-plane normal, pointing away from the centre of
 * curvature, with a length proportional to the curvature there. The curvature is the Menger curvature of three
 * consecutive curve points (1 / R for points on a circle of radius R), so a polygonal circle gives equal teeth.
 */

import { sectionAnalysis } from "../../workbench-core/src/solid-metrics.js";

type V3 = readonly [number, number, number];

export interface SectionCurve {
  readonly points: readonly V3[];
  readonly closed: boolean;
}

export interface CurvatureCombOptions {
  /** Tooth length (mm) = curvature (1/mm) x scale. Default: the median tooth is 6% of the section's size. */
  readonly scale?: number;
  /** A tooth is never longer than this many times the median tooth (default 4). */
  readonly maxToothFactor?: number;
}

export interface SectionCurvatureComb {
  readonly curves: readonly SectionCurve[];
  /** Tooth segments, flat x1,y1,z1,x2,y2,z2 (curve point, then tooth tip), in mm. */
  readonly teethMm: readonly number[];
  /** Polyline joining the tooth tips of each curve (the comb envelope), same layout as `teethMm`. */
  readonly envelopeMm: readonly number[];
  readonly scale: number;
  readonly maxCurvaturePerMm: number;
  /** Smallest radius of curvature on the section (mm); Infinity for a straight section. */
  readonly minRadiusMm: number;
  readonly vertexCount: number;
}

/** Chains the cut edges of a plane section into polylines (closed loops where the section closes). */
export function chainSectionCurves(edges: readonly { readonly start: V3; readonly end: V3 }[], toleranceMm = 1e-6): readonly SectionCurve[] {
  const key = (point: V3): string => `${Math.round(point[0] / toleranceMm)}|${Math.round(point[1] / toleranceMm)}|${Math.round(point[2] / toleranceMm)}`;
  const points = new Map<string, V3>();
  const links = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = key(edge.start); const to = key(edge.end);
    if (from === to) continue;
    if (!points.has(from)) points.set(from, edge.start);
    if (!points.has(to)) points.set(to, edge.end);
    if (!links.has(from)) links.set(from, new Set());
    if (!links.has(to)) links.set(to, new Set());
    links.get(from)!.add(to);
    links.get(to)!.add(from);
  }
  const used = new Set<string>();
  const edgeKey = (a: string, b: string): string => (a < b ? `${a}>${b}` : `${b}>${a}`);
  const curves: SectionCurve[] = [];
  const walk = (startKey: string): SectionCurve => {
    const chain = [startKey];
    let previous = "";
    let current = startKey;
    let closed = false;
    for (;;) {
      const next = [...(links.get(current) ?? [])].find((candidate) => candidate !== previous && !used.has(edgeKey(current, candidate)));
      if (next === undefined) break;
      used.add(edgeKey(current, next));
      if (next === startKey) { closed = true; break; }
      chain.push(next);
      previous = current;
      current = next;
    }
    return { points: chain.map((entry) => points.get(entry)!), closed };
  };
  // Open chains first (start at an end point), then closed loops.
  for (const [pointKey, neighbours] of links) if (neighbours.size === 1 && ![...neighbours].every((other) => used.has(edgeKey(pointKey, other)))) curves.push(walk(pointKey));
  for (const pointKey of links.keys()) {
    if ([...(links.get(pointKey) ?? [])].some((other) => !used.has(edgeKey(pointKey, other)))) curves.push(walk(pointKey));
  }
  return curves.map(dropCollinearPoints).filter((curve) => curve.points.length >= 3);
}

/** Removes points that sit on the straight line between their neighbours (the cut through a triangulated planar face leaves such points). */
function dropCollinearPoints(curve: SectionCurve): SectionCurve {
  const count = curve.points.length;
  const kept: V3[] = [];
  for (let index = 0; index < count; index += 1) {
    const endpoint = !curve.closed && (index === 0 || index === count - 1);
    if (endpoint) { kept.push(curve.points[index]!); continue; }
    const a = curve.points[(index + count - 1) % count]!;
    const b = curve.points[index]!;
    const c = curve.points[(index + 1) % count]!;
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const bc: V3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const cross = Math.hypot(ab[1] * bc[2] - ab[2] * bc[1], ab[2] * bc[0] - ab[0] * bc[2], ab[0] * bc[1] - ab[1] * bc[0]);
    const scale = Math.hypot(...ab) * Math.hypot(...bc);
    if (scale > 1e-300 && cross / scale < 1e-9) continue;
    kept.push(b);
  }
  return { points: kept, closed: curve.closed };
}

/** Menger curvature at b of the points a, b, c, and the unit in-plane direction pointing away from the centre of curvature (zero for collinear points). */
export function mengerCurvature(a: V3, b: V3, c: V3): { readonly curvaturePerMm: number; readonly away: V3 } {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const bc: V3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: V3 = [ab[1] * bc[2] - ab[2] * bc[1], ab[2] * bc[0] - ab[0] * bc[2], ab[0] * bc[1] - ab[1] * bc[0]];
  const lab = Math.hypot(...ab); const lbc = Math.hypot(...bc); const lac = Math.hypot(...ac);
  const denominator = lab * lbc * lac;
  if (denominator < 1e-300) return { curvaturePerMm: 0, away: [0, 0, 0] };
  const curvaturePerMm = 2 * Math.hypot(...cross) / denominator;
  // The change of unit tangent points toward the centre of curvature; the tooth points the other way.
  const t1: V3 = [ab[0] / lab, ab[1] / lab, ab[2] / lab];
  const t2: V3 = [bc[0] / lbc, bc[1] / lbc, bc[2] / lbc];
  const turn: V3 = [t2[0] - t1[0], t2[1] - t1[1], t2[2] - t1[2]];
  const turnLength = Math.hypot(...turn);
  if (turnLength < 1e-12) return { curvaturePerMm: 0, away: [0, 0, 0] };
  return { curvaturePerMm, away: [-turn[0] / turnLength, -turn[1] / turnLength, -turn[2] / turnLength] };
}

export function sectionCurvatureComb(positionsMm: readonly number[], indices: readonly number[], plane: "xy" | "xz" | "yz", offsetMm: number, options: CurvatureCombOptions = {}): SectionCurvatureComb {
  const section = sectionAnalysis(positionsMm, indices, plane, offsetMm);
  const curves = chainSectionCurves(section.edges);
  const samples: { readonly curve: number; readonly point: V3; readonly curvature: number; readonly away: V3 }[] = [];
  curves.forEach((curve, curveIndex) => {
    const count = curve.points.length;
    for (let index = 0; index < count; index += 1) {
      if (!curve.closed && (index === 0 || index === count - 1)) continue;
      const a = curve.points[(index + count - 1) % count]!;
      const b = curve.points[index]!;
      const c = curve.points[(index + 1) % count]!;
      const { curvaturePerMm, away } = mengerCurvature(a, b, c);
      samples.push({ curve: curveIndex, point: b, curvature: curvaturePerMm, away });
    }
  });
  const positive = samples.map((sample) => sample.curvature).filter((value) => value > 1e-12).sort((left, right) => left - right);
  const median = positive.length === 0 ? 0 : positive[Math.floor(positive.length / 2)]!;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const curve of curves) for (const point of curve.points) for (let axis = 0; axis < 3; axis += 1) { if (point[axis]! < min[axis]!) min[axis] = point[axis]!; if (point[axis]! > max[axis]!) max[axis] = point[axis]!; }
  const extent = curves.length === 0 ? 0 : Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : median > 0 ? 0.06 * extent / median : 0;
  const cap = median > 0 ? (options.maxToothFactor ?? 4) * median * scale : Infinity;
  const teeth: number[] = [];
  const envelope: number[] = [];
  const tips = new Map<number, V3[]>();
  for (const sample of samples) {
    const length = Math.min(sample.curvature * scale, cap);
    const tip: V3 = [sample.point[0] + sample.away[0] * length, sample.point[1] + sample.away[1] * length, sample.point[2] + sample.away[2] * length];
    teeth.push(sample.point[0], sample.point[1], sample.point[2], tip[0], tip[1], tip[2]);
    const list = tips.get(sample.curve) ?? [];
    list.push(tip);
    tips.set(sample.curve, list);
  }
  for (const [curveIndex, list] of tips) {
    for (let index = 0; index + 1 < list.length; index += 1) envelope.push(...list[index]!, ...list[index + 1]!);
    if (curves[curveIndex]!.closed && list.length > 2) envelope.push(...list[list.length - 1]!, ...list[0]!);
  }
  const maxCurvature = samples.reduce((largest, sample) => Math.max(largest, sample.curvature), 0);
  return { curves, teethMm: teeth, envelopeMm: envelope, scale, maxCurvaturePerMm: maxCurvature, minRadiusMm: maxCurvature > 1e-12 ? 1 / maxCurvature : Infinity, vertexCount: samples.length };
}
