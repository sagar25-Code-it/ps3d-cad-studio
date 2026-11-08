import type { PartPreviewBody, Vec3 } from "../../workbench-core/src/index.js";

/**
 * Closed, outward-wound triangle meshes for the Ellipsoid, Prism, Wedge, Spiral and Tube primitives, built in the
 * body's local frame (centred on the bounding box, Z up) and the exact analytic volume of each solid. The mesh
 * volumes approach the analytic ones from below as the tessellation refines (the tests pin the tolerance).
 */

export interface NewPrimitiveMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

const AROUND = 64;
const STACKS = 32;
const SPIRAL_STEPS_PER_TURN = 64;

/** Ellipsoid with the given full axis lengths. Two pole vertices, STACKS-1 latitude rings of AROUND vertices. */
export function ellipsoidMesh(dx: number, dy: number, dz: number): NewPrimitiveMesh {
  const a = dx / 2; const b = dy / 2; const c = dz / 2;
  const positions: number[] = [0, 0, c];
  const ringStart = (ring: number): number => 1 + ring * AROUND;
  for (let ring = 1; ring < STACKS; ring += 1) {
    const phi = Math.PI * ring / STACKS;
    const s = Math.sin(phi); const cp = Math.cos(phi);
    for (let i = 0; i < AROUND; i += 1) {
      const theta = Math.PI * 2 * i / AROUND;
      positions.push(a * s * Math.cos(theta), b * s * Math.sin(theta), c * cp);
    }
  }
  const south = positions.length / 3;
  positions.push(0, 0, -c);
  const indices: number[] = [];
  for (let i = 0; i < AROUND; i += 1) {
    const next = (i + 1) % AROUND;
    indices.push(0, ringStart(0) + i, ringStart(0) + next);
    for (let ring = 0; ring < STACKS - 2; ring += 1) {
      const top = ringStart(ring); const bottom = ringStart(ring + 1);
      indices.push(top + i, bottom + i, top + next, top + next, bottom + i, bottom + next);
    }
    const last = ringStart(STACKS - 2);
    indices.push(south, last + next, last + i);
  }
  return { positions, indices };
}

/** Regular n-gon prism, vertex 0 on local +X, circumscribed diameter `diameter`, height `height`. */
export function prismMesh(sides: number, diameter: number, height: number): NewPrimitiveMesh {
  const radius = diameter / 2;
  const positions: number[] = [];
  const bottomZ = -height / 2; const topZ = height / 2;
  for (let i = 0; i < sides; i += 1) {
    const angle = Math.PI * 2 * i / sides;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), bottomZ);
  }
  for (let i = 0; i < sides; i += 1) {
    const angle = Math.PI * 2 * i / sides;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), topZ);
  }
  const bottomCenter = positions.length / 3; positions.push(0, 0, bottomZ);
  const topCenter = positions.length / 3; positions.push(0, 0, topZ);
  const indices: number[] = [];
  for (let i = 0; i < sides; i += 1) {
    const next = (i + 1) % sides;
    indices.push(i, next, sides + next, i, sides + next, sides + i);
    indices.push(bottomCenter, next, i);
    indices.push(topCenter, sides + i, sides + next);
  }
  return { positions, indices };
}

/**
 * Right-triangle wedge: a width x depth x height bounding box where the full height stands on the -Y edge and the
 * top face slopes down to a sharp edge at +Y. The cross-section in YZ is a right triangle; X is the extrusion.
 */
export function wedgeMesh(width: number, depth: number, height: number): NewPrimitiveMesh {
  const x = width / 2; const y = depth / 2; const z = height / 2;
  // Front triangle (x = -w/2) then back triangle (x = +w/2): low-back, low-front, high-back.
  const positions = [
    -x, -y, -z, -x, y, -z, -x, -y, z,
    x, -y, -z, x, y, -z, x, -y, z
  ];
  const faces: readonly (readonly number[])[] = [
    [0, 2, 1], [3, 4, 5],
    [0, 1, 4, 3],
    [0, 3, 5, 2],
    [1, 2, 5, 4]
  ];
  const indices: number[] = [];
  const centre: Vec3 = [0, -y / 3, -z / 3];
  for (const face of faces) {
    const triangles = face.length === 3 ? [[face[0]!, face[1]!, face[2]!]] : [[face[0]!, face[1]!, face[2]!], [face[0]!, face[2]!, face[3]!]];
    for (const [a, b, c] of triangles as [number, number, number][]) {
      // Orient every triangle so its normal points away from the interior point.
      const p = (index: number): Vec3 => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
      const pa = p(a); const pb = p(b); const pc = p(c);
      const e1: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const e2: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const outward = n[0] * (pa[0] - centre[0]) + n[1] * (pa[1] - centre[1]) + n[2] * (pa[2] - centre[2]);
      if (outward >= 0) indices.push(a, b, c); else indices.push(a, c, b);
    }
  }
  return { positions, indices };
}

/** Geometry of the flat Archimedean spiral ribbon: width w = pitch / 2, inner edge at radius w at the start. */
export function spiralDimensions(outerDiameter: number, turns: number): { readonly pitch: number; readonly width: number } {
  const pitch = (outerDiameter / 2) / (turns + 1);
  return { pitch, width: pitch / 2 };
}

/** Flat spiral ribbon of constant radial width and the given thickness, swept over `turns` turns. */
export function spiralMesh(outerDiameter: number, turns: number, thickness: number): NewPrimitiveMesh {
  const { pitch, width } = spiralDimensions(outerDiameter, turns);
  const steps = Math.max(8, Math.ceil(turns * SPIRAL_STEPS_PER_TURN));
  const zBottom = -thickness / 2; const zTop = thickness / 2;
  const positions: number[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const theta = Math.PI * 2 * turns * step / steps;
    const inner = width + pitch * theta / (Math.PI * 2);
    const outer = inner + width;
    const cos = Math.cos(theta); const sin = Math.sin(theta);
    positions.push(inner * cos, inner * sin, zBottom, outer * cos, outer * sin, zBottom, outer * cos, outer * sin, zTop, inner * cos, inner * sin, zTop);
  }
  const indices: number[] = [];
  for (let step = 0; step < steps; step += 1) {
    for (let k = 0; k < 4; k += 1) {
      const a = step * 4 + k; const b = step * 4 + (k + 1) % 4;
      const c = (step + 1) * 4 + (k + 1) % 4; const d = (step + 1) * 4 + k;
      indices.push(a, c, b, a, d, c);
    }
  }
  const last = steps * 4;
  indices.push(0, 1, 2, 0, 2, 3);
  indices.push(last, last + 2, last + 1, last, last + 3, last + 2);
  return { positions, indices };
}

/** Straight hollow tube along Z, open at both ends (a closed solid: the end faces are annuli). */
export function tubeMesh(outerDiameter: number, innerDiameter: number, height: number): NewPrimitiveMesh {
  const outerRadius = outerDiameter / 2; const innerRadius = innerDiameter / 2;
  const zBottom = -height / 2; const zTop = height / 2;
  const positions: number[] = [];
  const rings: readonly { readonly radius: number; readonly z: number }[] = [
    { radius: outerRadius, z: zBottom }, { radius: outerRadius, z: zTop },
    { radius: innerRadius, z: zBottom }, { radius: innerRadius, z: zTop }
  ];
  for (const ring of rings) {
    for (let i = 0; i < AROUND; i += 1) {
      const theta = Math.PI * 2 * i / AROUND;
      positions.push(ring.radius * Math.cos(theta), ring.radius * Math.sin(theta), ring.z);
    }
  }
  const ob = 0; const ot = AROUND; const ib = AROUND * 2; const it = AROUND * 3;
  const indices: number[] = [];
  for (let i = 0; i < AROUND; i += 1) {
    const next = (i + 1) % AROUND;
    indices.push(ob + i, ob + next, ot + next, ob + i, ot + next, ot + i);
    indices.push(ib + i, it + next, ib + next, ib + i, it + i, it + next);
    indices.push(ot + i, ot + next, it + next, ot + i, it + next, it + i);
    indices.push(ob + i, ib + next, ob + next, ob + i, ib + i, ib + next);
  }
  return { positions, indices };
}

/** The local-frame mesh of one of the five new primitives, or undefined for any other shape. */
export function newPrimitiveMesh(body: Pick<PartPreviewBody, "shape" | "sizeMm" | "primitiveParams">): NewPrimitiveMesh | undefined {
  const [x, y, z] = body.sizeMm;
  if (body.shape === "ellipsoid") return ellipsoidMesh(x, y, z);
  if (body.shape === "prism") return prismMesh(body.primitiveParams?.sides ?? 6, x, z);
  if (body.shape === "wedge") return wedgeMesh(x, y, z);
  if (body.shape === "spiral") return spiralMesh(x, body.primitiveParams?.turns ?? 3, z);
  if (body.shape === "tube") return tubeMesh(x, y, z);
  return undefined;
}

/** Exact analytic volume (mm^3) of any preview-body primitive, or undefined for a shape without a closed formula here. */
export function primitiveVolumeMm3(body: Pick<PartPreviewBody, "shape" | "sizeMm" | "primitiveParams">): number | undefined {
  const [x, y, z] = body.sizeMm;
  if (body.shape === "block") return x * y * z;
  if (body.shape === "cylinder") return Math.PI * (x / 2) ** 2 * z;
  if (body.shape === "cone") return Math.PI * z * ((x / 2) ** 2 + (x / 2) * (y / 2) + (y / 2) ** 2) / 3;
  if (body.shape === "sphere") return Math.PI * x ** 3 / 6;
  if (body.shape === "torus") return 2 * Math.PI ** 2 * (x / 2) * (z / 2) ** 2;
  if (body.shape === "ellipsoid") return Math.PI * x * y * z / 6;
  if (body.shape === "prism") {
    const sides = body.primitiveParams?.sides ?? 6;
    return 0.5 * sides * (x / 2) ** 2 * Math.sin(Math.PI * 2 / sides) * z;
  }
  if (body.shape === "wedge") return x * y * z / 2;
  if (body.shape === "tube") return Math.PI * ((x / 2) ** 2 - (y / 2) ** 2) * z;
  if (body.shape === "spiral") {
    const turns = body.primitiveParams?.turns ?? 3;
    const { pitch, width } = spiralDimensions(x, turns);
    // Area swept between the inner and outer edges: integral over theta of (r_in * w + w^2 / 2).
    const sweep = Math.PI * 2 * turns;
    const area = width * width * sweep + width * pitch * sweep * sweep / (4 * Math.PI) + width * width * sweep / 2;
    return area * z;
  }
  return undefined;
}
