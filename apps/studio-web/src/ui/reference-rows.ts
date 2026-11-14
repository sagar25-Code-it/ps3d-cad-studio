import type { DesignHistory, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import { describeReference, featureStatus, featureStatusText, isHealthNote, legacyReferenceItems, referenceStepOf } from "../../../../packages/workbench-core/src/index.js";

/**
 * How a browser row of a construction plane, axis, point or primitive reads and behaves. When a timeline step makes the item, the row says
 * what the step is made of and how it stands (rolled back, suppressed), and a double-click opens the step. An item that predates the
 * timeline has no step: its row says so, and it is put into the timeline with "Add to the timeline".
 */
export interface ReferenceRow {
  /** The timeline step of the item, when there is one: what a double-click on the row opens. */
  readonly featureId?: string;
  /** What follows the row's kind in its second line: "offset · 20 mm from the XY plane" or "not in the timeline". */
  readonly note: string;
  /** The step could not be rebuilt: the row is drawn in the error colour. */
  readonly failed: boolean;
}

export const NOT_IN_TIMELINE = "not in the timeline";

export function referenceRow(history: DesignHistory, itemId: string): ReferenceRow {
  const step = referenceStepOf(history, itemId);
  if (step === undefined) return { note: NOT_IN_TIMELINE, failed: false };
  const status = featureStatusText(featureStatus(history, step));
  const health = step.health !== undefined && !isHealthNote(step.health.message) ? step.health.message : undefined;
  return {
    featureId: step.id,
    note: `${describeReference(step.reference)}${status === "" ? "" : ` · ${status}`}${health === undefined ? "" : ` · ${health}`}`,
    failed: health !== undefined
  };
}

/** The sentence of the browser's "Add to the timeline" row, or undefined when every item is already a step. */
export function adoptRowLabel(project: WorkbenchProject): string | undefined {
  const count = legacyReferenceItems(project).length;
  return count === 0 ? undefined : `Add ${count} construction ${count === 1 ? "item" : "items"} to the timeline`;
}
