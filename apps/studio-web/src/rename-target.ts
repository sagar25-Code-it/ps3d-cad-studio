import type { DesignFeature, DesignHistory } from "../../../packages/workbench-core/src/index.js";
import type { StepPick } from "./timeline-selection.js";

/**
 * F2 in the Part workspace renames what is selected: a timeline step the user picked, else a selected solid body, else a step selected
 * by its own ID (a sketch). The request id is what the browser's inline rename opens (a step ID or a body ID).
 */
export type RenameTarget =
  | { readonly kind: "step"; readonly id: string; readonly name: string }
  | { readonly kind: "body"; readonly id: string; readonly name: string };

export function renameTargetFor(
  history: DesignHistory,
  selectedId: string | null,
  pick: StepPick | null,
  bodies: readonly { readonly id: string; readonly name: string }[]
): RenameTarget | undefined {
  if (selectedId === null) return undefined;
  const stepOf = (feature: DesignFeature | undefined): RenameTarget | undefined => feature === undefined ? undefined : { kind: "step", id: feature.id, name: feature.name };
  if (pick !== null && pick.selectionId === selectedId) {
    const picked = stepOf(history.features.find((feature) => feature.id === pick.featureId));
    if (picked !== undefined) return picked;
  }
  const body = bodies.find((candidate) => candidate.id === selectedId);
  if (body !== undefined) return { kind: "body", id: body.id, name: body.name };
  return stepOf(history.features.find((feature) => feature.id === selectedId));
}

/** Whether a key press is the global rename key: F2 alone, in the Part workspace, not while typing in a field and not under a dialog. */
export function isGlobalRenameKey(event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }, workspace: string, typingInField: boolean, dialogOpen: boolean): boolean {
  return event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && workspace === "part" && !typingInField && !dialogOpen;
}
