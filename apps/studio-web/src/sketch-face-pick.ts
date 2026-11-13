import { faceReferenceOf, planarFacesOfBody, planeOffsetForCoordinate, type GeneralSolidBody, type SketchDatumPlane, type SketchPlaneFaceRef, type SketchPlaneFrame } from "../../../packages/workbench-core/src/index.js";
import { chooseFace } from "../../../packages/workbench-geometry/src/index.js";

/**
 * Create Sketch on a face that was clicked on the model, with no list to read. A flat face square to a world axis gives the datum
 * plane and offset the plane dialog would give for it, and when it is a named face of the solid the sketch follows that face on
 * every rebuild. A flat face at any other angle gives the sketch its own frame on the face (it sits there; it does not follow the
 * face when the solid changes, which the status line says). A curved face is refused with the reason.
 */
type Vec3 = readonly [number, number, number];

export type PickedSketchPlane =
  | {
      readonly ok: true;
      readonly plane: SketchDatumPlane;
      readonly offsetMm: number;
      /** A named axis-aligned face: the sketch follows it. */
      readonly face?: SketchPlaneFaceRef;
      /** A flat face that is not square to an axis: the sketch's own frame on it. */
      readonly frame?: SketchPlaneFrame;
      /** What the status line calls the place, for example "the z = 6 mm face of Plate". */
      readonly label: string;
      /** False when the sketch will stay where it is if the solid changes. */
      readonly follows: boolean;
    }
  | { readonly ok: false; readonly message: string };

export interface FacePick {
  /** The index of the clicked face in the body's named faces, when the body has them. */
  readonly faceIndex?: number | null | undefined;
  /** Where on the model the click landed. */
  readonly pointMm?: Vec3 | undefined;
}

const PLANE_OF_AXIS: Readonly<Record<"x" | "y" | "z", SketchDatumPlane>> = { x: "datum:yz", y: "datum:xz", z: "datum:xy" };
const AXES = ["x", "y", "z"] as const;
/** The same tolerance the plane dialog's face list uses for "square to an axis". */
const ALIGNED_COS = 0.9998;
const round = (value: number): number => Number(value.toFixed(6));

export function sketchPlaneOfFace(body: GeneralSolidBody, pick: FacePick): PickedSketchPlane {
  const faceIndex = pick.faceIndex ?? null;
  const key = faceIndex === null ? undefined : body.brep?.faces[faceIndex]?.key;
  const named = key === undefined ? undefined : planarFacesOfBody(body).find((face) => face.faceKey === key);
  if (named !== undefined) {
    const plane = PLANE_OF_AXIS[named.axis];
    return { ok: true, plane, offsetMm: planeOffsetForCoordinate(plane, named.coordinateMm), face: faceReferenceOf(body.id, named), label: `the ${named.axis} = ${Number(named.coordinateMm.toFixed(3))} mm face of ${body.name}`, follows: true };
  }
  const mesh = { positionsMm: body.positionsMm, indices: body.indices };
  const chosen = chooseFace(mesh, { pointMm: pick.pointMm, faceIndex, faceTriangles: body.brep?.faceTriangles });
  if (typeof chosen === "string") return { ok: false, message: chosen };
  if (!chosen.planar) return { ok: false, message: "That face is curved. A sketch needs a flat face: click a flat face, or choose a plane from the list." };
  // The face's outward normal and middle, weighted by triangle area.
  let nx = 0; let ny = 0; let nz = 0; let cx = 0; let cy = 0; let cz = 0; let total = 0;
  const p = body.positionsMm;
  for (const triangle of chosen.triangles) {
    const a = body.indices[triangle * 3]! * 3; const b = body.indices[triangle * 3 + 1]! * 3; const c = body.indices[triangle * 3 + 2]! * 3;
    const ab: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const ac: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const cross: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const twice = Math.hypot(cross[0], cross[1], cross[2]);
    nx += cross[0]; ny += cross[1]; nz += cross[2];
    cx += ((p[a]! + p[b]! + p[c]!) / 3) * twice; cy += ((p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3) * twice; cz += ((p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3) * twice;
    total += twice;
  }
  const size = Math.hypot(nx, ny, nz);
  if (!(size > 1e-9) || !(total > 1e-9)) return { ok: false, message: "That face is too small to sketch on." };
  const normal: Vec3 = [nx / size, ny / size, nz / size];
  const centre: Vec3 = [cx / total, cy / total, cz / total];
  const axis = AXES.findIndex((_, index) => Math.abs(normal[index]!) >= ALIGNED_COS);
  if (axis >= 0) {
    const name = AXES[axis]!;
    const plane = PLANE_OF_AXIS[name];
    const coordinate = centre[axis]!;
    return { ok: true, plane, offsetMm: planeOffsetForCoordinate(plane, coordinate), label: `the ${name} = ${Number(coordinate.toFixed(3))} mm face of ${body.name}`, follows: false };
  }
  // A slanted flat face: the sketch's X runs level along the face (world Z crossed with the normal), so its Y points up the slope.
  const level: Vec3 = [-normal[1], normal[0], 0];
  const levelSize = Math.hypot(level[0], level[1]);
  const uAxis: Vec3 = [round(level[0] / levelSize), round(level[1] / levelSize), 0];
  return {
    ok: true,
    plane: "datum:xy",
    offsetMm: 0,
    frame: { originMm: [round(centre[0]), round(centre[1]), round(centre[2])], uAxis, normal: [round(normal[0]), round(normal[1]), round(normal[2])] },
    label: `a slanted face of ${body.name}`,
    follows: false
  };
}

/** The placement fields of the new-design-sketch operation for a picked face. */
export function placementOfPickedPlane(picked: Extract<PickedSketchPlane, { readonly ok: true }>): { readonly offsetMm?: number; readonly face?: SketchPlaneFaceRef; readonly frame?: SketchPlaneFrame } {
  return { ...(picked.offsetMm === 0 ? {} : { offsetMm: picked.offsetMm }), ...(picked.face === undefined ? {} : { face: picked.face }), ...(picked.frame === undefined ? {} : { frame: picked.frame }) };
}
