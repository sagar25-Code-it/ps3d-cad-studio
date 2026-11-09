import { datumPointOf } from "../../../packages/workbench-core/src/index.js";
import type { SketchEntity, SketchDatumPlane, Vec2, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { placeDirection, placePoint } from "../../../packages/workbench-geometry/src/index.js";
import { detectSketchProfiles, sampleArcToBound, sampleSplineToBound } from "../../../packages/workbench-sketch/src/index.js";

type V3 = readonly [number, number, number];

/** The normal of each datum plane, in world space. */
const DATUM_NORMAL: Readonly<Record<"xy" | "xz" | "yz", V3>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

const planeKey = (plane: SketchDatumPlane): "xy" | "xz" | "yz" => (plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy");

/** The normal of the plane a sketch lies in (its datum plane's, moved onto a tilt or three-point plane). */
export function sketchPlaneNormal(sketch: WorkbenchSketch): V3 {
  return placeDirection(DATUM_NORMAL[planeKey(sketch.plane)], sketch);
}

/** A sketch point in world millimetres: onto its datum plane, along the normal by the plane offset, then onto a tilted or three-point plane. */
export function sketchPointToWorld(sketch: WorkbenchSketch, point: Vec2): V3 {
  const key = planeKey(sketch.plane);
  const flat: V3 = datumPointOf(sketch, point[0], point[1]);
  const normal = DATUM_NORMAL[key];
  const offset = sketch.planeOffsetMm ?? 0;
  return placePoint([flat[0] + normal[0] * offset, flat[1] + normal[1] * offset, flat[2] + normal[2] * offset], sketch);
}

type Curve = Extract<SketchEntity, { readonly kind: "line" | "arc" | "spline" }>;

const isCurve = (entity: SketchEntity): entity is Curve => entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline";

function samplesOf(entity: Curve): readonly Vec2[] {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "arc") return sampleArcToBound(entity.start, entity.mid, entity.end);
  return sampleSplineToBound(entity.fitPoints);
}

/** The ids of the visible curves of a sketch that are not part of a closed profile: the open profiles a rib can follow. */
export function openCurveIds(sketch: WorkbenchSketch): readonly string[] {
  const closed = new Set(detectSketchProfiles(sketch).flatMap((profile) => profile.entityIds));
  return sketch.entities.filter((entity): entity is Curve => isCurve(entity) && !entity.construction && entity.visible !== false && !closed.has(entity.id)).map((entity) => entity.id);
}

/**
 * Joins the named curves end to end into chains of points. Curves that meet (within the sketch tolerance) become one chain;
 * curves that do not touch stay separate chains, which is what makes a web of several ribs.
 */
export function openChains(sketch: WorkbenchSketch, entityIds: readonly string[]): readonly (readonly Vec2[])[] {
  const tolerance = Math.max(sketch.snapToleranceMm, 1e-3);
  const pieces = entityIds.flatMap((id) => {
    const entity = sketch.entities.find((candidate) => candidate.id === id);
    return entity !== undefined && isCurve(entity) ? [[...samplesOf(entity)]] : [];
  });
  const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
  const chains: Vec2[][] = [];
  const pool = pieces.filter((piece) => piece.length >= 2);
  while (pool.length > 0) {
    const chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let index = 0; index < pool.length; index += 1) {
        const piece = pool[index]!;
        const head = chain[0]!; const tail = chain[chain.length - 1]!;
        const start = piece[0]!; const end = piece[piece.length - 1]!;
        if (near(tail, start)) chain.push(...piece.slice(1));
        else if (near(tail, end)) chain.push(...piece.slice(0, -1).reverse());
        else if (near(head, end)) chain.unshift(...piece.slice(0, -1));
        else if (near(head, start)) chain.unshift(...piece.slice(1).reverse());
        else continue;
        pool.splice(index, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}
