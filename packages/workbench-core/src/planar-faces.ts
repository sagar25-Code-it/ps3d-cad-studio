import type { SketchDatumPlane } from "./types.js";

/**
 * Axis-aligned planar faces of a triangle mesh, found from the mesh itself, so a sketch can be started on a real
 * face of a solid. Pure geometry: no project state, no kernel.
 */

/** The outward sketch-plane normals, matching the kernel's plane placement (xz sketches face −Y). */
export const DATUM_NORMALS: Readonly<Record<SketchDatumPlane, readonly [number, number, number]>> = {
  "datum:xy": [0, 0, 1],
  "datum:xz": [0, -1, 0],
  "datum:yz": [1, 0, 0]
};

const PLANE_AXIS: Readonly<Record<SketchDatumPlane, { readonly axis: 0 | 1 | 2; readonly axisName: "x" | "y" | "z"; readonly sign: 1 | -1 }>> = {
  "datum:xy": { axis: 2, axisName: "z", sign: 1 },
  "datum:xz": { axis: 1, axisName: "y", sign: -1 },
  "datum:yz": { axis: 0, axisName: "x", sign: 1 }
};

/** Where a sketch plane with this offset sits in the world: the fixed axis and its coordinate in mm. */
export function planeWorldCoordinate(plane: SketchDatumPlane, offsetMm: number): { readonly axisName: "x" | "y" | "z"; readonly valueMm: number } {
  const mapping = PLANE_AXIS[plane];
  return { axisName: mapping.axisName, valueMm: mapping.sign * offsetMm };
}

/** The plane offset that puts a sketch at this world coordinate on the plane's fixed axis. */
export function planeOffsetForCoordinate(plane: SketchDatumPlane, coordinateMm: number): number {
  return PLANE_AXIS[plane].sign * coordinateMm;
}

export interface PlanarFace {
  /** The datum plane this face is parallel to. */
  readonly plane: SketchDatumPlane;
  /** Sketch-plane offset along `DATUM_NORMALS[plane]` that puts a sketch on this face. */
  readonly offsetMm: number;
  /** The face's world coordinate on its fixed axis, for labels ("z = 25 mm"). */
  readonly axisName: "x" | "y" | "z";
  readonly coordinateMm: number;
  /** Whether the face looks along the positive world axis (a top face) or the negative one (a bottom face). */
  readonly outwardPositive: boolean;
  readonly areaMm2: number;
}

const AXIS_PLANES: readonly SketchDatumPlane[] = ["datum:yz", "datum:xz", "datum:xy"];
/** cos of ~1.15°: a triangle's normal must be this close to an axis to count as axis-aligned. */
const ALIGNED_COS = 0.9998;
/** Faces closer than this along the axis are the same face. */
const COPLANAR_TOLERANCE_MM = 0.01;

/**
 * Finds the axis-aligned planar faces of a closed triangle mesh: groups of triangles whose normals line up with ±X,
 * ±Y or ±Z and that lie at the same coordinate on that axis. Returns them largest first, each with the sketch plane
 * and offset that would put a sketch on it. Curved or tilted faces are left out, honestly: they cannot be sketched on yet.
 */
export function axisAlignedPlanarFaces(positionsMm: readonly number[], indices: readonly number[], minimumAreaMm2 = 1): readonly PlanarFace[] {
  const buckets = new Map<string, { plane: SketchDatumPlane; coordinate: number; outwardPositive: boolean; area: number }>();
  for (let cursor = 0; cursor + 2 < indices.length; cursor += 3) {
    const a = indices[cursor]! * 3; const b = indices[cursor + 1]! * 3; const c = indices[cursor + 2]! * 3;
    if (a < 0 || b < 0 || c < 0 || Math.max(a, b, c) + 2 >= positionsMm.length) continue;
    const ab = [positionsMm[b]! - positionsMm[a]!, positionsMm[b + 1]! - positionsMm[a + 1]!, positionsMm[b + 2]! - positionsMm[a + 2]!] as const;
    const ac = [positionsMm[c]! - positionsMm[a]!, positionsMm[c + 1]! - positionsMm[a + 1]!, positionsMm[c + 2]! - positionsMm[a + 2]!] as const;
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]] as const;
    const length = Math.hypot(cross[0], cross[1], cross[2]);
    if (!(length > 1e-9)) continue;
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      const aligned = cross[axis]! / length;
      if (Math.abs(aligned) < ALIGNED_COS) continue;
      const coordinate = positionsMm[a + axis]!;
      const key = `${axis}:${aligned > 0 ? "+" : "-"}:${Math.round(coordinate / COPLANAR_TOLERANCE_MM)}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, { plane: AXIS_PLANES[axis]!, coordinate, outwardPositive: aligned > 0, area: length / 2 });
      else bucket.area += length / 2;
      break;
    }
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.area >= minimumAreaMm2 && Number.isFinite(bucket.coordinate))
    .sort((first, second) => second.area - first.area)
    .map((bucket) => ({
      plane: bucket.plane,
      offsetMm: planeOffsetForCoordinate(bucket.plane, bucket.coordinate),
      axisName: PLANE_AXIS[bucket.plane].axisName,
      coordinateMm: bucket.coordinate,
      outwardPositive: bucket.outwardPositive,
      areaMm2: bucket.area
    }));
}
