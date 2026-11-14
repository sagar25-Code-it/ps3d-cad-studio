import type { DesignSketchFeature, SketchEntity, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, isSketchShown, sketchPathPolyline } from "../../../packages/workbench-core/src/index.js";
import type { PreviewPrimitive, PreviewScene } from "../../../packages/workbench-geometry/src/index.js";
import { sketchToWorld } from "./sketch-world.js";

/**
 * HS-24: the curves of the timeline sketches that are shown, as lines in the Part view, in the sketch's own place in space (its plane
 * with the offset, tilt or frame it was drawn with). They are guides: not selectable, not part of any solid, and a hidden or
 * suppressed sketch adds nothing. A curve made for construction is drawn dashed and dimmer, as the sketcher draws it.
 */

const SKETCH_COLOR = "#e6a23c";
const CONSTRUCTION_COLOR = "#9aa5ad";

/** The line primitive of one sketch curve in world space, or undefined for a curve with no length (a lone point). */
export function sketchCurvePrimitive(feature: DesignSketchFeature, entity: SketchEntity): PreviewPrimitive | undefined {
  const path = sketchPathPolyline(entity);
  if (path === undefined) return undefined;
  const ring = path.closed ? [...path.points, path.points[0]!] : path.points;
  const pointsMm = ring.flatMap(([u, v]) => { const point = sketchToWorld(feature.sketch, u, v); return [point[0], point[1], point[2]]; });
  return {
    id: `${feature.id}:curve:${entity.id}`,
    name: `${feature.name} curve`,
    color: entity.construction ? CONSTRUCTION_COLOR : SKETCH_COLOR,
    opacity: entity.construction ? 0.7 : 0.95,
    selectable: false,
    kind: "line",
    pointsMm,
    dashed: entity.construction
  };
}

/** Every curve line of every shown timeline sketch, in timeline order. */
export function sketchCurvePrimitives(project: WorkbenchProject): readonly PreviewPrimitive[] {
  const history = designOf(project);
  const lines: PreviewPrimitive[] = [];
  for (const feature of history.features) {
    if (feature.kind !== "sketch" || !isSketchShown(history, feature)) continue;
    for (const entity of feature.sketch.entities) {
      if (entity.visible === false) continue;
      const line = sketchCurvePrimitive(feature, entity);
      if (line !== undefined) lines.push(line);
    }
  }
  return lines;
}

/** The part scene with the curves of every shown sketch added. */
export function withSketchCurves(scene: PreviewScene, project: WorkbenchProject): PreviewScene {
  const lines = sketchCurvePrimitives(project);
  return lines.length === 0 ? scene : { ...scene, primitives: [...scene.primitives, ...lines] };
}
