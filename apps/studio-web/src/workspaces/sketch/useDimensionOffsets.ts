import { useCallback, useEffect, useState } from "react";
import type { DimensionOffsets } from "../../../../../packages/workbench-sketch/src/dimension-display.js";
import { dimensionOffsetsKey, loadDimensionOffsets, pruneDimensionOffsets, saveDimensionOffsets } from "../../../../../packages/workbench-sketch/src/dimension-offsets.js";

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/**
 * The dragged positions of dimension labels: remembered in this browser, separately for every sketch of every project, and dropped for
 * dimensions that no longer exist. `liveIds` are the ids of the sketch's constraints now.
 */
export function useDimensionOffsets(projectId: string, sketchId: string, liveIds: ReadonlySet<string>): readonly [DimensionOffsets, (next: DimensionOffsets | ((current: DimensionOffsets) => DimensionOffsets)) => void] {
  const key = dimensionOffsetsKey(projectId, sketchId);
  const [held, setHeld] = useState(() => ({ key, offsets: loadDimensionOffsets(storage(), projectId, sketchId) }));
  // A different project or sketch brings its own offsets in the same render, never the previous one's.
  let current = held;
  if (held.key !== key) {
    current = { key, offsets: loadDimensionOffsets(storage(), projectId, sketchId) };
    setHeld(current);
  }
  const update = useCallback((next: DimensionOffsets | ((current: DimensionOffsets) => DimensionOffsets)): void => {
    setHeld((previous) => {
      const base = previous.key === key ? previous.offsets : loadDimensionOffsets(storage(), projectId, sketchId);
      const resolved = typeof next === "function" ? next(base) : next;
      saveDimensionOffsets(storage(), projectId, sketchId, resolved);
      return { key, offsets: resolved };
    });
  }, [key, projectId, sketchId]);
  // Offsets of deleted dimensions are forgotten.
  useEffect(() => {
    const pruned = pruneDimensionOffsets(current.offsets, liveIds);
    if (pruned !== current.offsets) update(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds]);
  return [current.offsets, update];
}
