/**
 * Closed, outward-wound triangle meshes for the plain analytic primitives (box, cylinder, cone / frustum, sphere), in
 * body-local millimetres and centred on the origin with the axis along Z. The Part preview draws these as renderer
 * primitives; the analysis tools need real triangles, so they are generated here.
 */

export interface PrimitiveMesh {
  readonly positionsMm: number[];
  readonly indices: number[];
}

export function boxMesh(widthMm: number, depthMm: number, heightMm: number): PrimitiveMesh {
  const x = widthMm / 2; const y = depthMm / 2; const z = heightMm / 2;
  const positionsMm = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  const quads: readonly (readonly [number, number, number, number])[] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return { positionsMm, indices };
}

/** A solid of revolution about Z from a profile of (radius, z) points running from the bottom pole up the outside to the top pole. */
export function latheMesh(profile: readonly (readonly [number, number])[], segments: number): PrimitiveMesh {
  const positionsMm: number[] = [];
  const rings: number[][] = [];
  const poleAt = (r: number): boolean => r < 1e-9;
  for (const [radius, z] of profile) {
    if (poleAt(radius)) {
      positionsMm.push(0, 0, z);
      rings.push([positionsMm.length / 3 - 1]);
    } else {
      const ring: number[] = [];
      for (let step = 0; step < segments; step += 1) {
        const angle = (2 * Math.PI * step) / segments;
        positionsMm.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
        ring.push(positionsMm.length / 3 - 1);
      }
      rings.push(ring);
    }
  }
  const indices: number[] = [];
  for (let level = 0; level + 1 < rings.length; level += 1) {
    const lower = rings[level]!; const upper = rings[level + 1]!;
    if (lower.length === 1 && upper.length === 1) continue;
    for (let step = 0; step < segments; step += 1) {
      const next = (step + 1) % segments;
      if (lower.length === 1) indices.push(lower[0]!, upper[next]!, upper[step]!);
      else if (upper.length === 1) indices.push(lower[step]!, lower[next]!, upper[0]!);
      else indices.push(lower[step]!, lower[next]!, upper[next]!, lower[step]!, upper[next]!, upper[step]!);
    }
  }
  return { positionsMm, indices };
}

export function cylinderMesh(radiusMm: number, heightMm: number, segments = 64): PrimitiveMesh {
  const h = heightMm / 2;
  return latheMesh([[0, -h], [radiusMm, -h], [radiusMm, h], [0, h]], segments);
}

/** A cone or frustum with its larger or smaller end on the bottom; a zero radius makes the end a point. */
export function coneMesh(baseRadiusMm: number, topRadiusMm: number, heightMm: number, segments = 64): PrimitiveMesh {
  const h = heightMm / 2;
  const profile: (readonly [number, number])[] = [];
  if (baseRadiusMm > 1e-9) profile.push([0, -h]);
  profile.push([baseRadiusMm, -h]);
  profile.push([topRadiusMm, h]);
  if (topRadiusMm > 1e-9) profile.push([0, h]);
  return latheMesh(profile, segments);
}

export function sphereMesh(radiusMm: number, segments = 48, rings = 24): PrimitiveMesh {
  const profile: (readonly [number, number])[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const theta = (Math.PI * ring) / rings;
    profile.push([ring === 0 || ring === rings ? 0 : radiusMm * Math.sin(theta), -radiusMm * Math.cos(theta)]);
  }
  return latheMesh(profile, segments);
}
