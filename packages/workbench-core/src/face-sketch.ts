import { planeOffsetForCoordinate } from "./planar-faces.js";
import type { GeneralSolidBody, SketchDatumPlane, SketchPlaneFaceRef, WorkbenchSketch } from "./types.js";

/**
 * Sketches that follow the face they were drawn on.
 *
 * A sketch started on a face used to store the face's position as a plain number, so changing the solid upstream left every feature built on
 * that sketch floating or buried, with no message. The sketch now also records which face it is on (the body, the face's stable key and
 * role). At every rebuild the face is found again on the solid as it now is: by its key, then by its role, then as the same-facing flat face
 * nearest to where it was. The sketch's plane offset follows; when no such face exists any more the feature says so.
 */

export interface BodyPlanarFace {
  readonly faceKey: string;
  readonly faceRole: string;
  readonly axis: "x" | "y" | "z";
  readonly outwardPositive: boolean;
  readonly coordinateMm: number;
  readonly areaMm2: number;
}

const AXES = ["x", "y", "z"] as const;
const ALIGNED_COS = 0.9998;
/** Vertices of one face may differ by this much along its axis and still count as one flat face. */
const FLAT_TOLERANCE_MM = 0.05;

/** The named faces of a body that are flat and square to a world axis: the ones a sketch can follow. */
export function planarFacesOfBody(body: Pick<GeneralSolidBody, "positionsMm" | "indices" | "brep">): readonly BodyPlanarFace[] {
  const brep = body.brep;
  if (brep === undefined || brep.faceTriangles.length * 3 !== body.indices.length) return [];
  const p = body.positionsMm;
  const result: BodyPlanarFace[] = [];
  for (const [faceIndex, face] of brep.faces.entries()) {
    let axis = -1;
    let sign = 0;
    let area = 0;
    let low = Infinity;
    let high = -Infinity;
    let flat = true;
    for (let triangle = 0; triangle < brep.faceTriangles.length && flat; triangle += 1) {
      if (brep.faceTriangles[triangle] !== faceIndex) continue;
      const a = body.indices[triangle * 3]! * 3; const b = body.indices[triangle * 3 + 1]! * 3; const c = body.indices[triangle * 3 + 2]! * 3;
      const ab = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!] as const;
      const ac = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!] as const;
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]] as const;
      const size = Math.hypot(cross[0], cross[1], cross[2]);
      if (!(size > 1e-9)) continue;
      const found = AXES.findIndex((_, index) => Math.abs(cross[index]! / size) >= ALIGNED_COS);
      if (found < 0) { flat = false; break; }
      const triangleSign = cross[found]! > 0 ? 1 : -1;
      if (axis >= 0 && (found !== axis || triangleSign !== sign)) { flat = false; break; }
      axis = found; sign = triangleSign; area += size / 2;
      for (const vertex of [a, b, c]) { low = Math.min(low, p[vertex + axis]!); high = Math.max(high, p[vertex + axis]!); }
    }
    if (!flat || axis < 0 || high - low > FLAT_TOLERANCE_MM) continue;
    result.push({ faceKey: face.key, faceRole: face.role, axis: AXES[axis]!, outwardPositive: sign > 0, coordinateMm: (low + high) / 2, areaMm2: area });
  }
  return result;
}

const PLANE_OF_AXIS: Readonly<Record<"x" | "y" | "z", SketchDatumPlane>> = { x: "datum:yz", y: "datum:xz", z: "datum:xy" };

/** The reference a sketch on this face keeps, ready for a `new-design-sketch` or `set-sketch-plane` operation. */
export function faceReferenceOf(bodyId: string, face: BodyPlanarFace): SketchPlaneFaceRef {
  return { bodyId, faceKey: face.faceKey, faceRole: face.faceRole, axis: face.axis, outwardPositive: face.outwardPositive, coordinateMm: Number(face.coordinateMm.toFixed(6)), areaMm2: Number(face.areaMm2.toFixed(4)) };
}

export type SketchFaceResolution =
  | { readonly ok: true; readonly offsetMm: number; readonly how: "key" | "role" | "nearest"; readonly coordinateMm: number }
  | { readonly ok: false; readonly message: string };

/** Finds the face a sketch lies on again on the body as it is now. */
export function resolveSketchFace(ref: SketchPlaneFaceRef, body: Pick<GeneralSolidBody, "positionsMm" | "indices" | "brep" | "name"> | undefined): SketchFaceResolution {
  if (body === undefined) return { ok: false, message: `The solid this sketch was drawn on (${ref.bodyId}) is no longer in the part, so the sketch keeps its last position.` };
  const faces = planarFacesOfBody(body);
  const match = (face: BodyPlanarFace): boolean => face.axis === ref.axis && face.outwardPositive === ref.outwardPositive;
  const done = (face: BodyPlanarFace, how: "key" | "role" | "nearest"): SketchFaceResolution => ({ ok: true, offsetMm: planeOffsetForCoordinate(PLANE_OF_AXIS[face.axis], face.coordinateMm), how, coordinateMm: face.coordinateMm });
  const byKey = faces.find((face) => face.faceKey === ref.faceKey && match(face));
  if (byKey !== undefined) return done(byKey, "key");
  const byRole = faces.find((face) => face.faceRole === ref.faceRole && match(face));
  if (byRole !== undefined) return done(byRole, "role");
  const candidates = faces.filter(match);
  if (candidates.length === 0) {
    return { ok: false, message: `The face this sketch was drawn on (${ref.faceRole}) no longer exists on ${body.name}: no flat ${ref.axis.toUpperCase()}${ref.outwardPositive ? "+" : "-"} face is left. The sketch keeps its last position (${ref.coordinateMm.toFixed(2)} mm), so features built on it may float. Move the sketch to a face, or delete those features.` };
  }
  // The same-facing flat face whose size is closest to the one the sketch was on; ties go to the one nearest where it was.
  const best = candidates.slice().sort((a, b) => Math.abs(a.areaMm2 - ref.areaMm2) / Math.max(1, ref.areaMm2) - Math.abs(b.areaMm2 - ref.areaMm2) / Math.max(1, ref.areaMm2)
    || Math.abs(a.coordinateMm - ref.coordinateMm) - Math.abs(b.coordinateMm - ref.coordinateMm))[0]!;
  return done(best, "nearest");
}

/** A sketch moved onto the offset a resolved face gives it (the offset is dropped when it is zero, as everywhere else). */
export function sketchOnFace(sketch: WorkbenchSketch, offsetMm: number): WorkbenchSketch {
  if ((sketch.planeOffsetMm ?? 0) === offsetMm) return sketch;
  const { planeOffsetMm: _previous, ...rest } = sketch;
  return offsetMm === 0 ? rest : { ...rest, planeOffsetMm: offsetMm };
}
