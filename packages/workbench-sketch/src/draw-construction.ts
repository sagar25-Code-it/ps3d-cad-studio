import type { SketchEntity } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * "Draw as construction": while the mode is on, everything the drawing tools create is construction geometry (a guide that
 * never bounds a profile). The mode is a toggle on the Sketch palette and the Q key; it only changes what is created, never
 * the curves already in the sketch, and it is not stored in the project.
 */
export function asConstruction(entity: SketchEntity): SketchEntity {
  return entity.construction ? entity : { ...entity, construction: true };
}

/** The same drawing edit with every curve it adds made construction geometry. Updates and removals are left alone. */
export function planAsConstruction(plan: SketchEditPlan): SketchEditPlan {
  if (plan.addEntities.every((entity) => entity.construction)) return plan;
  return { ...plan, addEntities: plan.addEntities.map(asConstruction) };
}

/** Applies the mode to a plan: construction when on, unchanged when off. */
export function planForDrawMode(plan: SketchEditPlan, drawAsConstruction: boolean): SketchEditPlan {
  return drawAsConstruction ? planAsConstruction(plan) : plan;
}

/** The entity as the drawing tool should create it under the current mode. */
export function entityForDrawMode(entity: SketchEntity, drawAsConstruction: boolean): SketchEntity {
  return drawAsConstruction ? asConstruction(entity) : entity;
}

export const DRAW_CONSTRUCTION_ON_MESSAGE = "Draw as construction is ON: everything you draw is construction geometry (guides that do not form profiles). Press Q to turn it off.";
export const DRAW_CONSTRUCTION_OFF_MESSAGE = "Draw as construction is off: new curves are profile geometry.";
