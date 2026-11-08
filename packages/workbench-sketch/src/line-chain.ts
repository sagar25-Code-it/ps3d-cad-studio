import type { SketchEntity, Vec2, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { PlacedPointInference } from "./auto-constraints.js";
import type { ProfileChain } from "./blend-profile.js";

/**
 * The state of a polyline being drawn with the Line tool, and the rules that keep it honest when the sketch changes under it.
 *
 * The canvas keeps the lines the chain added, in order, and the vertices between them. Undo (or any other edit that removes the
 * newest line) must walk the chain back to the previous vertex: otherwise the next click starts at a vertex that no longer
 * exists and carries an automatic Coincident to a line that is gone (audit Sketch edit E11).
 */
export interface LineChainState {
  /** Where the chain began; the tail returns here when every line it added is gone. */
  readonly start: Vec2 | undefined;
  /** What the first point was snapped to, kept so a chain that steps all the way back keeps its relation. */
  readonly startInference: PlacedPointInference | undefined;
  /** The lines this chain added, oldest first. */
  readonly entityIds: readonly string[];
}

export const EMPTY_LINE_CHAIN: LineChainState = { start: undefined, startInference: undefined, entityIds: [] };

export function startLineChain(point: Vec2, inference?: PlacedPointInference): LineChainState {
  return { start: point, startInference: inference, entityIds: [] };
}

export function extendLineChain(chain: LineChainState, entityId: string): LineChainState {
  return { ...chain, entityIds: [...chain.entityIds, entityId] };
}

/** Segments drawn so far; three or more that end on the start close the loop. */
export function lineChainSegments(chain: LineChainState): number {
  return chain.entityIds.length;
}

export interface LineChainReconcile {
  readonly chain: LineChainState;
  /** True when the sketch no longer matches what the chain remembered and the chain was changed. */
  readonly changed: boolean;
  /** The points still pending: the chain's tail (one point) or none when the chain has nothing left. */
  readonly pending: readonly Vec2[];
  /** The snap the tail point carries: the end of the last remaining line, or the chain's own first snap. */
  readonly tailInference: PlacedPointInference | undefined;
}

function endOfLine(entity: SketchEntity | undefined): Vec2 | undefined {
  return entity?.kind === "line" ? entity.end : undefined;
}

/**
 * Brings the chain in line with the sketch. Trailing lines of the chain that no longer exist (undone, deleted or cut) are dropped,
 * and the chain's tail moves back to the end of the newest line that is still there, or to the chain's first point when none is.
 * A chain whose newest line still exists is returned unchanged except that the tail follows that line's current end, so a solver
 * move cannot leave the next segment starting in the wrong place.
 */
export function reconcileLineChain(chain: LineChainState, entities: readonly SketchEntity[]): LineChainReconcile {
  if (chain.start === undefined) return { chain, changed: false, pending: [], tailInference: undefined };
  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  let ids = chain.entityIds;
  while (ids.length > 0 && endOfLine(byId.get(ids[ids.length - 1]!)) === undefined) ids = ids.slice(0, -1);
  const last = ids.length === 0 ? undefined : byId.get(ids[ids.length - 1]!);
  const lastEnd = endOfLine(last);
  const tail = lastEnd ?? chain.start;
  const tailInference: PlacedPointInference | undefined = last !== undefined && lastEnd !== undefined
    ? { point: lastEnd, primary: { kind: "endpoint", point: lastEnd, entityId: last.id, selector: "end", distanceMm: 0 } }
    : chain.startInference;
  const shrank = ids.length !== chain.entityIds.length;
  return { chain: shrank ? { ...chain, entityIds: ids } : chain, changed: shrank, pending: [tail], tailInference };
}

/** Relations that only name entities that exist (in the sketch or among the entities being added). Dangling ones are returned apart. */
export function keepResolvableConstraints(
  constraints: readonly WorkbenchSketchConstraint[],
  existingIds: Iterable<string>,
  addedIds: Iterable<string> = []
): { readonly kept: readonly WorkbenchSketchConstraint[]; readonly dropped: readonly WorkbenchSketchConstraint[] } {
  const known = new Set<string>([...existingIds, ...addedIds]);
  const kept: WorkbenchSketchConstraint[] = [];
  const dropped: WorkbenchSketchConstraint[] = [];
  for (const constraint of constraints) (constraint.entityIds.every((id) => known.has(id)) ? kept : dropped).push(constraint);
  return { kept, dropped };
}

/** A Profile chain follows its newest segment; once that segment is gone the chain's tangent and tail are stale and it must restart. */
export function profileChainStillValid(chain: ProfileChain, entities: readonly SketchEntity[]): boolean {
  if (chain.tailId === undefined) return true;
  return entities.some((entity) => entity.id === chain.tailId);
}
