import { featureOfBody, type DesignFeature, type DesignHistory } from "../../../packages/workbench-core/src/index.js";
import { timelineRowSelectionId } from "./sketch-plane-ui.js";

/**
 * HS-01: a click on a timeline step selects that one step. The viewport still highlights the step's solid, so the selection ID
 * stays the body's (a sketch's own), and the pick remembers which step of that body was meant. Edit, Suppress and Delete then
 * act on the step the user picked instead of the first step of its body.
 */
export interface StepPick {
  readonly featureId: string;
  /** The selection ID the pick set: the pick only counts while that is still what is selected. */
  readonly selectionId: string;
}

export function pickStep(feature: DesignFeature): StepPick {
  return { featureId: feature.id, selectionId: timelineRowSelectionId(feature) };
}

/**
 * The timeline step the current selection means. A step the user picked wins while its selection is still current; a solid that
 * was selected another way (clicked in the view, picked from the body list) means the step that made it; a step selected by its
 * own ID (a sketch) means itself. Anything else is not a step.
 */
export function resolveSelectedStep(history: DesignHistory, selectedId: string | null, pick: StepPick | null): DesignFeature | undefined {
  if (selectedId === null) return undefined;
  if (pick !== null && pick.selectionId === selectedId) {
    const picked = history.features.find((feature) => feature.id === pick.featureId);
    if (picked !== undefined) return picked;
  }
  return history.features.find((feature) => feature.id === selectedId) ?? featureOfBody(history, selectedId);
}
