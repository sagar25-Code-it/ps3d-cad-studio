import { type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { entityPoints } from "./index.js";
import { mapEntity, reflectAcross, type SketchEditContext, type SketchEditPlan } from "./edit-tools.js";
import { planHolds } from "./sketch-clone.js";
import { pruneRedundantAdditions } from "./edit-prune.js";

/**
 * Dynamic Mirror: with an axis line chosen in advance, everything drawn afterwards is created together with its mirror image,
 * as one undoable edit. Every image gets a symmetry relation with its source, so editing one side moves the other.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;

/** The axis a Dynamic Mirror session would use: the last selected line, or undefined when none is selected. */
export function resolveMirrorAxis(sketch: WorkbenchSketch, selectionIds: readonly string[]): Line | undefined {
  for (const id of [...selectionIds].reverse()) {
    const entity = sketch.entities.find((candidate) => candidate.id === id);
    if (entity?.kind === "line" && Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]) > 1e-6) return entity;
  }
  return undefined;
}

/** The mirror image of points drawn so far, for the live ghost that follows the cursor. */
export function mirrorPoints(axis: Line, points: readonly Vec2[]): readonly Vec2[] {
  return points.map((point) => reflectAcross(point, axis));
}

function sameShape(a: SketchEntity, b: SketchEntity, tolerance: number): boolean {
  if (a.kind !== b.kind) return false;
  const pa = entityPoints(a);
  const pb = entityPoints(b);
  if (pa.length !== pb.length) return false;
  const matched = (left: readonly Vec2[], right: readonly Vec2[]): boolean => left.every((p) => right.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance));
  if (a.kind === "circle" && b.kind === "circle" && Math.abs(a.radiusMm - b.radiusMm) > tolerance) return false;
  return matched(pa, pb) && matched(pb, pa);
}

export interface DynamicMirrorOutcome {
  readonly plan: SketchEditPlan;
  /** How many mirror images were added. */
  readonly mirrored: number;
  /** Entities that were not mirrored because they lie on the axis or are already symmetric about it. */
  readonly skipped: number;
  /** True when the symmetry relations were left out because the solver would not take them. */
  readonly withoutRelations: boolean;
}

/**
 * Adds the mirror images of the plan's new entities (and their symmetry relations) to a drawing plan.
 * If `axisId` is not a usable line in the sketch the plan is returned as it was.
 */
export function withDynamicMirror(context: SketchEditContext, axisId: string | null, drawn: SketchEditPlan): DynamicMirrorOutcome {
  const unchanged: DynamicMirrorOutcome = { plan: drawn, mirrored: 0, skipped: 0, withoutRelations: false };
  if (axisId === null) return unchanged;
  const axis = context.sketch.entities.find((entity) => entity.id === axisId);
  if (axis?.kind !== "line" || drawn.addEntities.length === 0) return unchanged;
  if (drawn.addEntities.some((entity) => entity.id === axis.id)) return unchanged;
  const axisAngleDeg = Math.atan2(axis.end[1] - axis.start[1], axis.end[0] - axis.start[0]) * 180 / Math.PI;
  const tolerance = Math.max(1e-6, context.sketch.snapToleranceMm * 1e-3);
  const reflect = (point: Vec2): Vec2 => reflectAcross(point, axis);
  const images: SketchEntity[] = [];
  const relations: WorkbenchSketchConstraint[] = [];
  let skipped = 0;
  for (const entity of drawn.addEntities) {
    const image = mapEntity(entity, context.newId("entity"), reflect, (degrees) => 2 * axisAngleDeg - degrees);
    if (sameShape(entity, image, tolerance)) { skipped += 1; continue; }
    images.push(image);
    // Every kind is tied to its image by a symmetry the solver holds (an arc by its ends and middle, a rectangle by centre, size and corner, an
    // ellipse by centre, size and turn, a spline point by point), so editing one side moves the other and the joints of a drawn chain stay joined.
    relations.push({ id: context.newId("constraint"), kind: "symmetry", entityIds: [entity.id, image.id, axis.id] });
  }
  if (images.length === 0) return { plan: drawn, mirrored: 0, skipped, withoutRelations: false };
  const build = (withRelations: boolean): SketchEditPlan => ({
    ...drawn,
    label: `${drawn.label} (mirrored)`.slice(0, 80),
    addEntities: [...drawn.addEntities, ...images],
    addConstraints: withRelations ? [...drawn.addConstraints, ...relations] : drawn.addConstraints
  });
  const full = build(true);
  if (planHolds(context.sketch, full).ok) {
    // Relations the symmetry already implies are not added twice (the sketch would read as over-defined).
    const pruned = pruneRedundantAdditions(context.sketch, full);
    return { plan: planHolds(context.sketch, pruned).ok ? pruned : full, mirrored: images.length, skipped, withoutRelations: false };
  }
  // The solver could not take the symmetry relations (for example alongside the drawing's own relations): keep the exact mirror geometry.
  return { plan: build(false), mirrored: images.length, skipped, withoutRelations: relations.length > 0 };
}

/** The mirror images of entities that are still being drawn (the live ghost), without relations; entities on the axis are left out. */
export function mirrorImages(axis: Line, entities: readonly SketchEntity[]): readonly SketchEntity[] {
  const axisAngleDeg = Math.atan2(axis.end[1] - axis.start[1], axis.end[0] - axis.start[0]) * 180 / Math.PI;
  return entities.flatMap((entity) => {
    const image = mapEntity(entity, `${entity.id}:mirror`, (point) => reflectAcross(point, axis), (degrees) => 2 * axisAngleDeg - degrees);
    return sameShape(entity, image, 1e-6) ? [] : [image];
  });
}
