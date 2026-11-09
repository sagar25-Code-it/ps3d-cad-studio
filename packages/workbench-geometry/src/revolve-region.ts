import { triangulateLoops, validateLoops } from "../../occt-kernel-adapter/src/polygon.js";
import { outwardIndices, PLANE_ROTATION_DEG, revolveSegmentsForRadius, rotatePositions, sanitizePolygon, type TessellatedMesh, type TessellatePlane } from "./tessellate.js";

type Point2 = readonly [number, number];

function areaOf(loop: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

/**
 * Revolves a region (an outline with holes cut through it, millimetres as radius and axial position) about the plane's in-plane axis.
 *
 * The outline and each hole sweep their own surface; a hole's surface faces into the hole. A full turn leaves a hole as a closed void
 * inside the solid; a partial turn leaves it as a tunnel through the two end faces, which are triangulated with the holes cut out.
 * Throws when a hole crosses the outline or another hole, with the reason.
 */
export function tessellateRevolveRegion(outerMm: readonly Point2[], holesMm: readonly (readonly Point2[])[], degrees: number, plane: TessellatePlane): TessellatedMesh {
  const outer = sanitizePolygon(outerMm);
  const holes = holesMm.map((hole) => sanitizePolygon(hole));
  if (outer.length < 3 || holes.some((hole) => hole.length < 3)) return { positionsMm: [], indices: [] };
  validateLoops(outer, holes);
  // The outline counter-clockwise and the holes clockwise, so every swept surface faces away from the material.
  const loops: (readonly Point2[])[] = [areaOf(outer) > 0 ? outer : [...outer].reverse(), ...holes.map((hole) => (areaOf(hole) < 0 ? hole : [...hole].reverse()))];
  const flat = loops.flat();
  const total = flat.length;
  const offsets: number[] = [];
  loops.reduce((start, loop) => { offsets.push(start); return start + loop.length; }, 0);

  const sweep = Math.min(360, Math.max(1, Math.abs(degrees)));
  const full = Math.abs(sweep - 360) < 1e-6;
  const widest = flat.reduce((maximum, [radius]) => Math.max(maximum, Math.abs(radius)), 0);
  const segments = Math.max(3, Math.round((revolveSegmentsForRadius(widest, total) * sweep) / 360));
  const sampleCount = full ? segments : segments + 1;
  const angle = (sweep * Math.PI) / 180;

  const positions: number[] = [];
  for (let step = 0; step < sampleCount; step += 1) {
    const theta = (angle * step) / segments;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (const [radius, axial] of flat) positions.push(radius * cos, axial, radius * sin);
  }
  const indices: number[] = [];
  for (let step = 0; step < segments; step += 1) {
    const ring = step * total;
    const nextRing = (full ? (step + 1) % sampleCount : step + 1) * total;
    loops.forEach((loop, loopIndex) => {
      const base = offsets[loopIndex]!;
      for (let j = 0; j < loop.length; j += 1) {
        const here = base + j;
        const next = base + ((j + 1) % loop.length);
        indices.push(ring + here, ring + next, nextRing + next, ring + here, nextRing + next, nextRing + here);
      }
    });
  }
  if (!full) {
    const triangles = triangulateLoops(loops[0]!, loops.slice(1));
    const lastRing = (sampleCount - 1) * total;
    for (let index = 0; index < triangles.length; index += 3) {
      const a = triangles[index]!;
      const b = triangles[index + 1]!;
      const c = triangles[index + 2]!;
      indices.push(a, c, b);
      indices.push(lastRing + a, lastRing + b, lastRing + c);
    }
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices: outwardIndices(positions, indices) };
}
