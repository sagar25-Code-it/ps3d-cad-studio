/**
 * Help strings the Sketch workspace shows. They live here, apart from the components, so a test can check that every control a string
 * points to exists (the audit found text that sent engineers to a ribbon group and an inspector field that were not there).
 */

import { getActiveSketchKeymap, keyLabelForCommand, type SketchKeymap } from "../../../packages/workbench-sketch/src/hotkeys.js";

/** Shown in the model browser's Relations tab while the sketch has none. The Constrain buttons are in the right-hand "Selection controller". */
export const RELATIONS_EMPTY_HELP = "No relations yet. Select curves and use the Constrain buttons in the Selection controller (right-hand panel), or press D for Sketch Dimension.";

/** The same help with the key the Sketch Dimension command has right now (the user may have rebound it, or removed it). */
export function relationsEmptyHelp(keymap: SketchKeymap = getActiveSketchKeymap()): string {
  const key = keyLabelForCommand("dimension", keymap);
  return `No relations yet. Select curves and use the Constrain buttons in the Selection controller (right-hand panel), or use Sketch Dimension${key === undefined ? " from the ribbon" : ` (press ${key})`}.`;
}

/** The status line when Sketch Dimension starts. The value editor opens on the canvas, not in the inspector. */
export function dimensionModeStatus(source: string): string {
  return `Sketch Dimension active ${source}: pick a curve or two displayed definition points; the value editor opens on the canvas next to them. Esc finishes.`;
}
