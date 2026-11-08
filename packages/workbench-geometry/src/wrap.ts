import { analyzeFaces, cross, dot, resolveFace, scale, sub, add, unit, type FaceRefLike, type MeshLike, type V3 } from "./face-analysis.js";

/**
 * Wrap: emboss or deboss a sketch profile onto a cylindrical face.
 *
 * The profile's x runs round the cylinder (arc length at the cylinder's radius, not projected) and its y runs along the axis, so a
 * 10 mm wide profile covers 10 mm of the surface however it curves away. This file finds the cylinder from a picked curved face
 * (a fit over the smooth run of facets round the pick); `wrap-apply.ts` imprints the profile on it and raises or sinks the patch.
 */
export interface CylinderFit {
  /** A point on the axis. */
  readonly axisPointMm: V3;
  /** Unit axis, pointing along the largest world component. */
  readonly axisMm: V3;
  readonly radiusMm: number;
  /** The number of flats round the tessellated cylinder. */
  readonly segments: number;
  /** Largest distance of a vertex from the fitted radius, as a fraction of the radius. */
  readonly deviation: number;
  /** Where along the axis the cylindrical face starts and ends. */
  readonly axialRangeMm: readonly [number, number];
  readonly facets: number;
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 matrix, by Jacobi rotations; also returns the eigenvalues. */
function smallestEigen(matrix: readonly number[]): { readonly vector: V3; readonly values: readonly number[] } {
  const a = [matrix.slice(0, 3), matrix.slice(3, 6), matrix.slice(6, 9)];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += Math.abs(a[p]![q]!);
    if (off < 1e-14) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p]![q]!) < 1e-18) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1); const s = t * c;
        for (let k = 0; k < 3; k += 1) { const akp = a[k]![p]!; const akq = a[k]![q]!; a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k += 1) { const apk = a[p]![k]!; const aqk = a[q]![k]!; a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k += 1) { const vkp = v[k]![p]!; const vkq = v[k]![q]!; v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq; }
      }
    }
  }
  const values = [a[0]![0]!, a[1]![1]!, a[2]![2]!];
  const smallest = values.indexOf(Math.min(...values));
  return { vector: [v[0]![smallest]!, v[1]![smallest]!, v[2]![smallest]!], values };
}

/** Two unit vectors that, with `axis`, make a right-handed frame (e1, e2 = axis x e1). */
export function frameAboutAxis(axis: V3): readonly [V3, V3] {
  const helper: V3 = Math.abs(axis[0]) <= Math.abs(axis[1]) && Math.abs(axis[0]) <= Math.abs(axis[2]) ? [1, 0, 0] : Math.abs(axis[1]) <= Math.abs(axis[2]) ? [0, 1, 0] : [0, 0, 1];
  const e1 = unit(cross(axis, helper))!;
  return [e1, cross(axis, e1)];
}

/** Finds the cylinder the picked curved face belongs to, or says why the face is not one. */
export function fitCylinder(mesh: MeshLike, ref: FaceRefLike): CylinderFit | string {
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return analysis;
  const found = resolveFace(mesh, analysis, ref, "The picked face");
  if (!found.ok) return found.message;
  if (!found.region.curved) return "The picked face is flat. Wrap needs a cylindrical face: click the round wall of a cylinder.";
  const triangleCount = mesh.indices.length / 3;
  const corner = (t: number, k: number): number => analysis.weld[mesh.indices[t * 3 + k]!]!;
  const partner = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = corner(t, k); const b = corner(t, (k + 1) % 3);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = partner.get(key);
      if (list === undefined) partner.set(key, [t]); else list.push(t);
    }
  }
  const normalOf = (t: number): V3 => {
    const pa = analysis.weldedPositions[corner(t, 0)]!;
    return unit(cross(sub(analysis.weldedPositions[corner(t, 1)]!, pa), sub(analysis.weldedPositions[corner(t, 2)]!, pa))) ?? [0, 0, 0];
  };
  const smooth = Math.cos((25 * Math.PI) / 180);
  const seed = found.region.triangles[0]!;
  const seen = new Set<number>([seed]);
  const queue = [seed];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (let k = 0; k < 3; k += 1) {
      const a = corner(t, k); const b = corner(t, (k + 1) % 3);
      for (const u of partner.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? []) {
        if (seen.has(u) || !analysis.regions[analysis.triangleRegion[u]!]?.curved) continue;
        if (dot(normalOf(t), normalOf(u)) < smooth) continue;
        seen.add(u); queue.push(u);
      }
    }
  }
  if (seen.size < 12) return "The picked face is too small or too coarse to be a cylinder: it is made of fewer than 12 triangles.";
  // The axis is the direction every facet normal is square to.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const vertices = new Set<number>();
  for (const t of seen) {
    const n = normalOf(t);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) m[i * 3 + j]! += n[i]! * n[j]!;
    for (let k = 0; k < 3; k += 1) vertices.add(corner(t, k));
  }
  const eigen = smallestEigen(m);
  const total = eigen.values.reduce((s, x) => s + x, 0);
  if (Math.min(...eigen.values) / total > 0.02) return "The picked face is curved but not a cylinder (its surface normals do not all lie square to one axis).";
  let axis = unit(eigen.vector)!;
  const largest = Math.max(Math.abs(axis[0]), Math.abs(axis[1]), Math.abs(axis[2]));
  if (Math.abs(axis[0]) === largest ? axis[0] < 0 : Math.abs(axis[1]) === largest ? axis[1] < 0 : axis[2] < 0) axis = scale(axis, -1);
  const [e1, e2] = frameAboutAxis(axis);
  const points = [...vertices].map((id) => analysis.weldedPositions[id]!);
  const flat = points.map((p) => [dot(p, e1), dot(p, e2)] as const);
  const cx0 = flat.reduce((s, p) => s + p[0], 0) / flat.length;
  const cy0 = flat.reduce((s, p) => s + p[1], 0) / flat.length;
  // Algebraic circle fit (Kåsa) on coordinates centred on the mean.
  let sxx = 0; let sxy = 0; let syy = 0; let sx = 0; let sy = 0; let sxz = 0; let syz = 0; let sz = 0;
  for (const [px, py] of flat) {
    const x = px - cx0; const y = py - cy0; const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = flat.length;
  const det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sy * sx) + sx * (sxy * sy - syy * sx);
  if (Math.abs(det) < 1e-12) return "The picked face does not curve enough to fit a cylinder.";
  const solve = (r: readonly number[]): [number, number, number] => {
    const d = (r[0]! * (syy * n - sy * sy) - sxy * (r[1]! * n - sy * r[2]!) + sx * (r[1]! * sy - syy * r[2]!)) / det;
    const e = (sxx * (r[1]! * n - sy * r[2]!) - r[0]! * (sxy * n - sy * sx) + sx * (sxy * r[2]! - r[1]! * sx)) / det;
    const f = (sxx * (syy * r[2]! - r[1]! * sy) - sxy * (sxy * r[2]! - r[1]! * sx) + r[0]! * (sxy * sy - syy * sx)) / det;
    return [d, e, f];
  };
  const [dd, ee] = solve([-sxz, -syz, -sz]);
  const cx = cx0 - dd / 2; const cy = cy0 - ee / 2;
  const distances = flat.map(([px, py]) => Math.hypot(px - cx, py - cy));
  const radius = distances.reduce((s, x) => s + x, 0) / distances.length;
  const deviation = Math.max(...distances.map((x) => Math.abs(x - radius))) / radius;
  if (!(radius > 1e-6) || deviation > 0.02) return `The picked face is not a cylinder: its points stray ${(deviation * 100).toFixed(1)}% from a circle.`;
  const axial = points.map((p) => dot(p, axis));
  const low = Math.min(...axial); const high = Math.max(...axial);
  const ring = axial.filter((a) => Math.abs(a - low) < 1e-6 * Math.max(1, high - low)).length;
  return {
    axisPointMm: add(scale(e1, cx), scale(e2, cy)), axisMm: axis, radiusMm: radius, segments: ring >= 8 ? ring : 72, deviation,
    axialRangeMm: [low, high], facets: Math.round(seen.size / 2)
  };
}

export interface WrapProfile {
  /** The outline in sketch millimetres. */
  readonly outer: readonly (readonly [number, number])[];
  readonly holes: readonly (readonly (readonly [number, number])[])[];
}

export interface WrapSpec {
  readonly mode: "emboss" | "deboss";
  readonly heightMm: number;
}

export type WrapResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };
