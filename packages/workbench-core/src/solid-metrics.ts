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
  return {
    triangleCount: triangles,
    volumeMm3: volume,
    surfaceAreaMm2: area,
    boundsMm: { min, max },
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    centroidMm: centroid,
    outward: signedVolume >= 0
  };
}
