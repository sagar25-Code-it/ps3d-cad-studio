import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";

/** Shared helpers of the wave-2 region tests: sketches, features and mesh measures built the way the app builds them. */

export function sketchOf(entities: readonly SketchEntity[], extra: Partial<WorkbenchSketch> = {}): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-region-wave2").sketch, entities, constraints: [], ...extra };
}

export const rect = (id: string, center: readonly [number, number], widthMm: number, heightMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center, widthMm, heightMm, rotationDeg: 0, construction: false });
export const circ = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
export const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });

export function sketchFeatureOf(sketch: WorkbenchSketch): DesignSketchFeature {
  return { id: "feature:s", name: "S", kind: "sketch", suppressed: false, sketch };
}

export function solidFeature(kind: DesignSolidFeature["kind"], extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature {
  return { id: "feature:e", name: "E", kind, suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 10, bodyId: "general-body:l", ...extra } as DesignSolidFeature;
}

/** Volume of a closed triangle mesh in cubic millimetres. */
export function volumeOf(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return Math.abs(total / 6);
}
