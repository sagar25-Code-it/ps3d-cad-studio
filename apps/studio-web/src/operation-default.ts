import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";

/**
 * PT-14: a create feature's operation gets a sensible default. In Fusion, Extrude defaults to Join when the result
 * touches an existing body and to New Body otherwise, and the dialog names the bodies affected. The touch test here is
 * the bodies' bounding boxes — an honest, cheap stand-in for a full overlap test on a tessellated kernel: a box touch is
 * only a proposal the user confirms in the operation prompt, never a silent choice.
 */

export interface BoundsMm {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The axis-aligned bounds of a triangle mesh's vertices, or undefined for an empty mesh. */
export function meshBoundsMm(positionsMm: readonly number[]): BoundsMm | undefined {
  if (positionsMm.length < 3) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positionsMm.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionsMm[index + axis]!;
      if (!Number.isFinite(value)) return undefined;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** Whether two bounds overlap (touching within `clearanceMm` counts: an extrude that lands exactly on a face should offer Join). */
export function boundsOverlap(a: BoundsMm, b: BoundsMm, clearanceMm = 0.01): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a.max[axis]! < b.min[axis]! - clearanceMm || b.max[axis]! < a.min[axis]! - clearanceMm) return false;
  }
  return true;
}

/** The visible bodies the tool's bounds touch, in the order given. */
export function touchingBodies(toolPositionsMm: readonly number[], bodies: readonly GeneralSolidBody[]): readonly GeneralSolidBody[] {
  const tool = meshBoundsMm(toolPositionsMm);
  if (tool === undefined) return [];
  return bodies.filter((body) => {
    if (!body.visible) return false;
    const bounds = meshBoundsMm(body.positionsMm);
    return bounds !== undefined && boundsOverlap(tool, bounds);
  });
}

/** Fusion's default: Join when the result touches a body it could modify, New Body otherwise. */
export function defaultCreateOperation(touchingCount: number, hasTarget: boolean): "join" | "new" {
  return touchingCount > 0 && hasTarget ? "join" : "new";
}
