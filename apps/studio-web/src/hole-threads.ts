import type { DesignSolidFeature, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, isFeatureActive } from "../../../packages/workbench-core/src/index.js";
import { cosmeticThreadCurves, cosmeticThreadOf, type CosmeticThread, type PreviewPrimitive, type PreviewScene } from "../../../packages/workbench-geometry/src/index.js";
import { holeSpecOf } from "./design-regeneration.js";

/** One tapped hole of the timeline, with the cosmetic thread annotation that goes with it (modelled threads are annotated too). */
export interface HoleThreadAnnotation {
  readonly stepId: string;
  readonly bodyId: string;
  readonly thread: CosmeticThread;
}

/**
 * The thread annotations of every live tapped hole in the timeline, in timeline order. A cosmetic thread is exactly this and nothing
 * more; a modelled thread also has its helix cut into the body.
 */
export function holeThreadsOf(project: WorkbenchProject): readonly HoleThreadAnnotation[] {
  const history = designOf(project);
  const bodies = project.part.generalBodies ?? [];
  const found: HoleThreadAnnotation[] = [];
  for (const feature of history.features) {
    if (feature.kind !== "hole" || feature.holeThread === undefined || !isFeatureActive(history, feature.id)) continue;
    const body = bodies.find((candidate) => candidate.id === feature.bodyId);
    if (body === undefined) continue;
    const spec = holeSpecOf(feature as DesignSolidFeature, body);
    if (spec === undefined || spec.thread === undefined) continue;
    found.push({ stepId: feature.id, bodyId: feature.bodyId, thread: cosmeticThreadOf(spec, spec.thread) });
  }
  return found;
}

/** The viewport lines of a cosmetic thread: the major circle at the face, the minor circle where the thread ends, and the axis. */
export function threadPrimitives(annotation: HoleThreadAnnotation): readonly PreviewPrimitive[] {
  return cosmeticThreadCurves(annotation.thread).map((curve, index): PreviewPrimitive => ({
    id: `${annotation.stepId}:thread-${index}`,
    name: `${annotation.thread.designation} cosmetic thread`,
    color: index === 2 ? "#9ad4ff" : "#f2c14e",
    opacity: 0.95,
    selectable: false,
    kind: "line",
    pointsMm: curve.flatMap((point) => [point[0], point[1], point[2]]),
    dashed: index === 1
  }));
}

/** The part scene with every tapped hole's cosmetic thread lines added. */
export function withCosmeticThreads(scene: PreviewScene, project: WorkbenchProject): PreviewScene {
  const annotations = holeThreadsOf(project);
  if (annotations.length === 0) return scene;
  return { ...scene, primitives: [...scene.primitives, ...annotations.flatMap(threadPrimitives)] };
}
