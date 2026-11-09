import { parseDimensionOffsets, serializeDimensionOffsets, type DimensionOffsets } from "./dimension-display.js";

/**
 * Where a dimension label was dragged to is a per-viewer convenience kept in the browser, not in the project. It used to share one storage
 * key for every project (the sketch's id is the same text in all of them), so the seeded outline dimensions of one project moved the
 * labels of another, and an offset for a dimension that had been deleted stayed for ever.
 */

/** The storage key for one sketch of one project. */
export function dimensionOffsetsKey(projectId: string, sketchId: string): string {
  return `ps3d.sketch.dimensionOffsets.${projectId}.${sketchId}`;
}

/** The key every project shared before offsets were kept per project; it is removed the first time a project's offsets are saved. */
export const LEGACY_DIMENSION_OFFSETS_KEY_PREFIX = "ps3d.sketch.dimensionOffsets.sketch:";

/** The offsets of the dimensions that still exist. Returns the same object when nothing was dropped, so an unchanged sketch never re-saves. */
export function pruneDimensionOffsets(offsets: DimensionOffsets, liveConstraintIds: ReadonlySet<string>): DimensionOffsets {
  const stale = Object.keys(offsets).filter((id) => !liveConstraintIds.has(id));
  if (stale.length === 0) return offsets;
  return Object.fromEntries(Object.entries(offsets).filter(([id]) => liveConstraintIds.has(id)));
}

/** Reads one sketch's offsets from storage; nothing, a blocked storage or damaged text all give no offsets. */
export function loadDimensionOffsets(storage: Pick<Storage, "getItem"> | undefined, projectId: string, sketchId: string): DimensionOffsets {
  try {
    return parseDimensionOffsets(storage?.getItem(dimensionOffsetsKey(projectId, sketchId)) ?? null);
  } catch {
    return {};
  }
}

/** Writes one sketch's offsets (an empty set removes the entry) and clears the old shared entry. A full or blocked storage keeps them in memory only. */
export function saveDimensionOffsets(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, projectId: string, sketchId: string, offsets: DimensionOffsets): void {
  try {
    const key = dimensionOffsetsKey(projectId, sketchId);
    if (Object.keys(offsets).length === 0) storage?.removeItem(key);
    else storage?.setItem(key, serializeDimensionOffsets(offsets));
    storage?.removeItem(`${LEGACY_DIMENSION_OFFSETS_KEY_PREFIX}${sketchId.replace(/^sketch:/u, "")}`);
  } catch {
    // The offsets last for this visit only.
  }
}
