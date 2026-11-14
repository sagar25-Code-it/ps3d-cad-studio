import type { DesignFeature, DesignSolidFeature } from "./types.js";

/**
 * Small, dependency-free facts about what a timeline step refers to. Kept apart from design.ts so the validator, the rebuild and
 * the delete logic can all share them without importing each other.
 */

/** Step kinds that read a sketch's curves when they are rebuilt. Every other kind only carries the sketch ID of the body it belongs to. */
const REFERENCE_ONLY_KINDS: ReadonlySet<DesignSolidFeature["kind"]> = new Set<DesignSolidFeature["kind"]>([
  "pattern", "sheet-edge-flange", "sheet-jog", "hole", "edge-blend", "combine", "indent",
  "move-body", "scale-body", "move-face", "offset-face", "emboss"
]);

/**
 * Whether a step builds from the curves of the sketch it names (an extrude, revolve, sweep, loft, a sheet base, a rib or wrap). A hole,
 * a blend, a pattern, a combine or a body edit by picked faces carries the sketch ID of its body but never reads that sketch, so a
 * missing sketch does not stop it.
 */
export function usesSketchGeometry(feature: DesignFeature): boolean {
  if (feature.kind === "sketch") return false;
  if (REFERENCE_ONLY_KINDS.has(feature.kind)) return false;
  if (feature.bodyEdit !== undefined && feature.bodyEdit.kind !== "web" && feature.bodyEdit.kind !== "wrap") return false;
  return true;
}

/** Every health message that says a step lost something it was built on contains this phrase ("Sketch 2 was deleted, so ..."). */
export const DELETED_REFERENCE_MARK = " was deleted";

/** Whether a health message is the kind written when something a step was built on was deleted and the step was kept. */
export function isDeletedReferenceMessage(message: string | undefined): boolean {
  return message !== undefined && message.includes(DELETED_REFERENCE_MARK) && !message.startsWith("Note: ");
}

/** Whether a step carries the mark that lets a saved timeline hold a reference to a step that is no longer there. */
export function isMarkedBroken(feature: DesignFeature): boolean {
  return isDeletedReferenceMessage(feature.health?.message);
}

/** The step kinds whose sketch can be replaced from the Edit panel: their profile is picked by the sketch's regions and nothing else in the step names a curve. */
export function canRepairSketch(feature: DesignFeature): boolean {
  return feature.kind === "extrude" || feature.kind === "revolve";
}
