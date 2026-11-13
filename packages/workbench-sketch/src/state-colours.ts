import type { WorkbenchSketch } from "../../workbench-core/src/index.js";

/**
 * The colour language of the sketch canvas: what a curve's colour says about it. A designer reads the state of a sketch from
 * these at a glance, so each state has one colour and the Sketch palette shows the key.
 */
export interface SketchStateColour {
  /** The CSS class the canvas puts on the curve (beside `sketch-entity`). */
  readonly key: "free" | "constrained" | "fixed" | "construction" | "selected" | "reference";
  readonly label: string;
  /** What the state means, for the tooltip of the key. */
  readonly meaning: string;
}

export const SKETCH_STATE_COLOURS: readonly SketchStateColour[] = [
  { key: "free", label: "Can still move", meaning: "The curve has freedom left: a relation or dimension is still missing. Drag it to see what moves." },
  { key: "constrained", label: "Fully defined", meaning: "Relations and dimensions decide the curve completely; it cannot move." },
  { key: "fixed", label: "Fixed", meaning: "The curve is held where it is by a Fix relation. Remove or relax the Fix to move it." },
  { key: "construction", label: "Construction", meaning: "Reference geometry: it guides other curves and never bounds a profile." },
  { key: "selected", label: "Selected", meaning: "The curves the next command acts on." },
  { key: "reference", label: "Model behind sketch", meaning: "Edges of solids and curves of other sketches. The pointer snaps to them; they are not part of this sketch." }
];

/**
 * The curves held by an active Fix on the whole curve. A Fix on one point of a curve (its start, its centre) pins that point only,
 * so the curve is not shown as fixed; a relaxed Fix holds nothing.
 */
export function fixedEntityIds(sketch: Pick<WorkbenchSketch, "constraints">): ReadonlySet<string> {
  const fixed = new Set<string>();
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "fixed" || constraint.suppressed === true) continue;
    constraint.entityIds.forEach((id, index) => { if (constraint.points?.[index] === undefined) fixed.add(id); });
  }
  return fixed;
}
