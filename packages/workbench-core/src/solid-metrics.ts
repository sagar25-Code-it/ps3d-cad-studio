import type { Vec3 } from "./types.js";

/** Measurements of a closed triangle mesh, all in millimetres. */
export interface SolidMetrics {
  readonly triangleCount: number;
  /** Enclosed volume (mm³). Always positive; see `outward` for the winding. */
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  readonly boundsMm: { readonly min: Vec3; readonly max: Vec3 };
  /** Bounding-box size along X, Y and Z. */
  readonly sizeMm: Vec3;
  /** Centre of the enclosed volume. Falls back to the box centre when the mesh encloses no volume. */
  readonly centroidMm: Vec3;
  /** True when the triangles wind counter-clockwise seen from outside, which is what a valid solid does. */
  readonly outward: boolean;
  /**
   * 3×3 inertia tensor about the body's centroid (mm⁵; divide by density to get kg·mm², multiply by 1e-12 to get kg·m²
   * once a density in kg/mm³ is folded in). Row-major: [[Ixx, Ixy, Ixz], [Iyx, Iyy, Iyz], [Izx, Izy, Izz]]. Off-diagonal
   * terms are the products of inertia (they share the same sign convention as Ixy = ∫xy dV about the centroid).
   */
  readonly inertiaTensorMm5: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
  ];
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * Measures a triangle mesh with the divergence theorem: the signed volume is the sum of the tetrahedra between each
 * triangle and the origin, and the centroid is their volume-weighted centres. Triangles that name a vertex that is not
 * in the mesh are skipped rather than trusted, so a damaged body measures as what is left instead of throwing.
 */
export function solidMetrics(positionsMm: readonly number[], indices: readonly number[]): SolidMetrics {
  const vertexCount = Math.floor(positionsMm.length / 3);
  let signedVolume = 0;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let triangles = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = positionsMm[vertex * 3]!;
    const y = positionsMm[vertex * 3 + 1]!;
    const z = positionsMm[vertex * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const a = indices[corner]!;
    const b = indices[corner + 1]!;
    const c = indices[corner + 2]!;
    if (!(a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount)) continue;
    const ax = positionsMm[a * 3]!, ay = positionsMm[a * 3 + 1]!, az = positionsMm[a * 3 + 2]!;
    const bx = positionsMm[b * 3]!, by = positionsMm[b * 3 + 1]!, bz = positionsMm[b * 3 + 2]!;
    const cx2 = positionsMm[c * 3]!, cy2 = positionsMm[c * 3 + 1]!, cz2 = positionsMm[c * 3 + 2]!;
    // a · (b × c) is six times the signed volume of the tetrahedron (origin, a, b, c).
    const tetra = ax * (by * cz2 - bz * cy2) + ay * (bz * cx2 - bx * cz2) + az * (bx * cy2 - by * cx2);
    signedVolume += tetra / 6;
    cx += (tetra / 6) * ((ax + bx + cx2) / 4);
    cy += (tetra / 6) * ((ay + by + cy2) / 4);
    cz += (tetra / 6) * ((az + bz + cz2) / 4);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    triangles += 1;
  }
  const empty = !Number.isFinite(minX);
  const min: Vec3 = empty ? ZERO : [minX, minY, minZ];
  const max: Vec3 = empty ? ZERO : [maxX, maxY, maxZ];
  const volume = Math.abs(signedVolume);
  const centroid: Vec3 = volume > 1e-9
    ? [cx / signedVolume, cy / signedVolume, cz / signedVolume]
    : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  // Inertia tensor at the centroid: integrate x², y², z², xy, xz, yz over the volume using the tetrahedron formula
  // against the computed centroid as the reference point. Standard divergence-theorem accumulation.
  let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
  if (volume > 1e-9) {
    const [rx, ry, rz] = centroid;
    for (let corner = 0; corner + 2 < indices.length; corner += 3) {
      const a = indices[corner]!;
      const b = indices[corner + 1]!;
      const c = indices[corner + 2]!;
      if (!(a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount)) continue;
      // Centroid-relative tetrahedron vertices.
      const ax = positionsMm[a * 3]! - rx, ay = positionsMm[a * 3 + 1]! - ry, az = positionsMm[a * 3 + 2]! - rz;
      const bx = positionsMm[b * 3]! - rx, by = positionsMm[b * 3 + 1]! - ry, bz = positionsMm[b * 3 + 2]! - rz;
      const cx3 = positionsMm[c * 3]! - rx, cy3 = positionsMm[c * 3 + 1]! - ry, cz3 = positionsMm[c * 3 + 2]! - rz;
      // Signed tetrahedron volume (origin = centroid).
      const det = ax * (by * cz3 - bz * cy3) + ay * (bz * cx3 - bx * cz3) + az * (bx * cy3 - by * cx3);
      // Second moments over the tetrahedron (from Tonon 2004, "Explicit Exact Formulas for the 3-D Tetrahedron
      // Inertia Tensor"): for each pair of axes (p, q) ∈ {x, y, z}², the integral of p·q over the tetrahedron equals
      // |det| / 20 × (2·p_a·q_a + 2·p_b·q_b + 2·p_c·q_c + p_a·q_b + p_b·q_a + p_a·q_c + p_c·q_a + p_b·q_c + p_c·q_b) / 6.
      // (det / 6 is the signed volume; we fold the 1/60 constant in at the end.)
      const sign = det >= 0 ? 1 : -1;
      const absDet = Math.abs(det);
      const moment = (p0: number, p1: number, p2: number, q0: number, q1: number, q2: number): number =>
        absDet * (2 * (p0 * q0 + p1 * q1 + p2 * q2) + (p0 * q1 + p1 * q0 + p0 * q2 + p2 * q0 + p1 * q2 + p2 * q1)) / 120;
      // Standard inertia tensor diagonal: Ixx = ∫ (y² + z²) dV; off-diagonal Ixy = −∫ xy dV (physics convention).
      // We expose the raw second moments here (unsigned sign of det is baked in through sign *) so the sum is well-defined for both windings.
      const mxx = moment(ax, bx, cx3, ax, bx, cx3);
      const myy = moment(ay, by, cy3, ay, by, cy3);
      const mzz = moment(az, bz, cz3, az, bz, cz3);
      const mxy = moment(ax, bx, cx3, ay, by, cy3);
      const mxz = moment(ax, bx, cx3, az, bz, cz3);
      const myz = moment(ay, by, cy3, az, bz, cz3);
      Ixx += sign * (myy + mzz);
      Iyy += sign * (mxx + mzz);
      Izz += sign * (mxx + myy);
      // Products of inertia use the standard negative-integral convention.
      Ixy += sign * (-mxy);
      Ixz += sign * (-mxz);
      Iyz += sign * (-myz);
    }
    if (signedVolume < 0) { Ixx = -Ixx; Iyy = -Iyy; Izz = -Izz; Ixy = -Ixy; Ixz = -Ixz; Iyz = -Iyz; }
  }
  return {
    triangleCount: triangles,
    volumeMm3: volume,
    surfaceAreaMm2: area,
    boundsMm: { min, max },
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    centroidMm: centroid,
    outward: signedVolume >= 0,
    inertiaTensorMm5: [
      [Ixx, Ixy, Ixz],
      [Ixy, Iyy, Iyz],
      [Ixz, Iyz, Izz]
    ]
  };
}

/**
 * Compute a planar cross-section of a triangle mesh at `plane` (an axis-aligned plane + offset). Returns the ordered
 * set of edges (pairs of 3D points) where each triangle crosses the plane. For a closed solid the edges form one or
 * more closed loops; the caller can polyline them for display. Used by Section Analysis (Inspect menu).
 */
export interface SectionResult {
  readonly edges: readonly { readonly start: Vec3; readonly end: Vec3 }[];
  readonly plane: "xy" | "xz" | "yz";
  readonly offsetMm: number;
}

export function sectionAnalysis(positionsMm: readonly number[], indices: readonly number[], plane: "xy" | "xz" | "yz", offsetMm: number): SectionResult {
  const axis = plane === "xy" ? 2 : plane === "xz" ? 1 : 0;
  const edges: { start: Vec3; end: Vec3 }[] = [];
  const vertexCount = Math.floor(positionsMm.length / 3);
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const a = indices[corner]!;
    const b = indices[corner + 1]!;
    const c = indices[corner + 2]!;
    if (!(a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount)) continue;
    const va: Vec3 = [positionsMm[a * 3]!, positionsMm[a * 3 + 1]!, positionsMm[a * 3 + 2]!];
    const vb: Vec3 = [positionsMm[b * 3]!, positionsMm[b * 3 + 1]!, positionsMm[b * 3 + 2]!];
    const vc: Vec3 = [positionsMm[c * 3]!, positionsMm[c * 3 + 1]!, positionsMm[c * 3 + 2]!];
    const da = va[axis] - offsetMm;
    const db = vb[axis] - offsetMm;
    const dc = vc[axis] - offsetMm;
    // Triangle entirely above or below the plane: no intersection.
    if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
    const intersect = (p: Vec3, q: Vec3, dp: number, dq: number): Vec3 => {
      const t = dp / (dp - dq);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    };
    const hits: Vec3[] = [];
    if ((da > 0) !== (db > 0)) hits.push(intersect(va, vb, da, db));
    if ((db > 0) !== (dc > 0)) hits.push(intersect(vb, vc, db, dc));
    if ((dc > 0) !== (da > 0)) hits.push(intersect(vc, va, dc, da));
    if (hits.length === 2) edges.push({ start: hits[0]!, end: hits[1]! });
  }
  return { edges, plane, offsetMm };
}
