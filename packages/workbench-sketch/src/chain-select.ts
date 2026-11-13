import type { WorkbenchSketch } from "../../workbench-core/src/index.js";
import { selectConnectedSketchEntities, sketchChainBranchCount } from "./index.js";

/**
 * Double-click on a curve selects the whole chain it belongs to: every curve reached by walking from end to end. A construction curve
 * walks along construction curves only, a profile curve along profile curves only, so the centreline of a slot does not pull in its
 * outline. With Shift the chain is added to what is already selected.
 */
export interface ChainSelection {
  readonly ids: readonly string[];
  /** The curves of the chain itself (without what was selected before). */
  readonly chainIds: readonly string[];
  readonly message: string;
}

export function chainSelectionFor(sketch: WorkbenchSketch, seedId: string, current: readonly string[], additive: boolean): ChainSelection | undefined {
  const seed = sketch.entities.find((entity) => entity.id === seedId);
  if (seed === undefined || seed.visible === false) return undefined;
  // The chain walk reads profile curves only; for a construction curve it is given the construction curves instead.
  const view: WorkbenchSketch = seed.construction
    ? { ...sketch, entities: sketch.entities.filter((entity) => entity.construction && entity.visible !== false).map((entity) => ({ ...entity, construction: false })) }
    : { ...sketch, entities: sketch.entities.filter((entity) => entity.visible !== false) };
  const chain = selectConnectedSketchEntities(view, seedId);
  const chainIds = chain.length === 0 ? [seedId] : chain;
  const ids = additive ? [...new Set([...current, ...chainIds])] : chainIds;
  const branches = chainIds.length > 1 ? sketchChainBranchCount(view, chainIds) : 0;
  const message = chainIds.length === 1
    ? "This curve meets no other curve end to end, so only it is selected."
    : `Selected the chain of ${chainIds.length} connected curves${additive && ids.length > chainIds.length ? ` (${ids.length} selected in all)` : ""}${branches > 0 ? "; the chain branches, so check what is highlighted" : ""}.`;
  return { ids, chainIds, message };
}
