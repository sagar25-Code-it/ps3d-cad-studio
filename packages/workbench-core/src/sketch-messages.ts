import { entityNames } from "./sketch-translate.js";
import type { WorkbenchSketch } from "./types.js";

/**
 * Solver messages are written against solver identifiers ("Geometry 'entity:s2' is degenerate."); the people reading them know the
 * curves as "Arc 1" and "Line 2". This puts the names in and rewrites the one message that has no useful wording of its own.
 */

/** Replaces every quoted or bare entity id in a solver message by the curve's name. */
export function nameEntitiesIn(sketch: Pick<WorkbenchSketch, "entities">, message: string): string {
  const names = entityNames(sketch);
  return message.replace(/'?(entity:[A-Za-z0-9_.:-]*[A-Za-z0-9_])'?/gu, (_match, id: string) => names.get(id) ?? id.replace(/^entity:/u, ""));
}

/** A solve failure in words: degenerate geometry says which curve would collapse, any other message just gets names for ids. */
export function friendlySolveMessage(sketch: Pick<WorkbenchSketch, "entities">, diagnostic: { readonly code: string; readonly message: string; readonly relatedIds: readonly string[] }): string {
  if (diagnostic.code === "DEGENERATE_GEOMETRY") {
    const names = entityNames(sketch);
    const id = diagnostic.relatedIds.find((candidate) => names.has(candidate));
    if (id !== undefined) return `${names.get(id)} would collapse to nothing at this position, so the move is not applied.`;
  }
  return nameEntitiesIn(sketch, diagnostic.message);
}
