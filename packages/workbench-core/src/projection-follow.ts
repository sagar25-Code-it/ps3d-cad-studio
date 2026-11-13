import { linkedSketchEntityIds } from "./sketch-objects.js";
import { solveLiveSketch } from "./sketch-solve.js";
import type { SketchEntity, WorkbenchSketch } from "./types.js";

/**
 * Puts the linked (projected) curves of a sketch where their solid has them now, and lets everything tied to them follow: the
 * relations and dimensions of the sketch are solved again with the linked curves held, so a hole dimensioned from a projected edge
 * moves with the edge. `curves` are the new shapes by curve id. Only a curve the sketch holds as linked, and that is still the same
 * kind of curve, is replaced; anything else in `curves` is ignored. Returns the same sketch when nothing moved.
 *
 * The rebuild (which works the curves out) and the project (which stores them) both call this, so they agree on the result.
 */
export function applyProjectedCurves(sketch: WorkbenchSketch, curves: ReadonlyMap<string, SketchEntity>): WorkbenchSketch {
  if (curves.size === 0) return sketch;
  const linked = linkedSketchEntityIds(sketch);
  const movedIds: string[] = [];
  const entities = sketch.entities.map((entity) => {
    const target = curves.get(entity.id);
    if (target === undefined || !linked.has(entity.id) || target.kind !== entity.kind) return entity;
    movedIds.push(entity.id);
    return { ...target, id: entity.id, construction: entity.construction, ...(entity.visible === undefined ? {} : { visible: entity.visible }) } as SketchEntity;
  });
  if (movedIds.length === 0) return sketch;
  const moved: WorkbenchSketch = { ...sketch, entities };
  const solved = solveLiveSketch(moved, movedIds);
  // A sketch whose other relations cannot follow keeps its curves where they were; the linked ones are still where the solid is.
  return solved.ok ? { ...moved, entities: solved.entities } : moved;
}
