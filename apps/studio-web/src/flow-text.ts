/**
 * Status and hint text that tells a person what to do next. Extrude (E) and Revolve now start in the Part workspace, so the text that
 * used to point only at the Sketch palette's Create solid names E as well. Kept in one place so the wording is tested.
 */

/** After Finish Sketch: the next step is Extrude in Part, or Create solid in the Sketch palette. */
export const FINISHED_SKETCH_NEXT = "Finished the sketch into the timeline. Press E in the Part workspace to extrude it (Revolve is in the Create group), or use Create solid in the Sketch palette; editing the sketch later rebuilds what is built on it.";

/** After choosing a sketch plane: what to do with the profile. */
export const DRAW_PROFILE_NEXT = "Draw a closed profile, finish the sketch, then press E in Part to extrude it (or use Create solid in the Sketch palette).";

/** A command that needs a second solid says how to make one. */
export function needsSecondSolid(command: string): string {
  return `${command} needs a second solid body. Create another with Extrude (E) or Revolve first.`;
}
