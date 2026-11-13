import type { DesignSketchFeature, GeneralSolidBody, SketchEntity, Vec2, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { planProjection, sketchFrameOf, sketchToWorld, worldToSketch, type SketchFrame } from "../../../packages/workbench-geometry/src/index.js";
import { entityPoints } from "../../../packages/workbench-sketch/src/index.js";

/**
 * The model behind the sketch. While a sketch is open, the edges of every visible solid and the curves of the other finished sketches
 * are worked out in the working sketch's own coordinates and shown dimmed behind it. They are reference only: they are not part of
 * the sketch, cannot be selected, dragged or dimensioned, and are not saved with it. The pointer snaps to their ends, centres,
 * middles and crossings so new geometry can be placed on the model, but no relation is recorded for such a snap (use Project to bring
 * a curve in when the sketch has to keep the tie).
 *
 * Limits, stated in the Sketch palette: the view is always straight at the sketch plane (no orbit while sketching); body edges are
 * the sharp edges of the mesh projected onto the plane; curves of a sketch on a plane that is not parallel to this one are shown
 * only where they stay lines.
 */
export const REFERENCE_ID_PREFIX = "reference:";

export const isReferenceId = (id: string | undefined | null): boolean => typeof id === "string" && id.startsWith(REFERENCE_ID_PREFIX);

/** How many reference curves are shown at most; a model with more shows the first ones and says so. */
export const REFERENCE_CURVE_LIMIT = 1200;

export interface SketchReferenceLayer {
  /** Curves in the working sketch's coordinates. Every id starts with `reference:` and names its source body or sketch. */
  readonly entities: readonly SketchEntity[];
  /** How many solids and how many other sketches contributed at least one curve. */
  readonly bodyCount: number;
  readonly sketchCount: number;
  /** Curves left out because the limit was reached. */
  readonly omitted: number;
}

export const EMPTY_REFERENCE_LAYER: SketchReferenceLayer = { entities: [], bodyCount: 0, sketchCount: 0, omitted: 0 };

export interface SketchReferenceInput {
  /** The sketch being drawn (its plane decides the projection). */
  readonly sketch: WorkbenchSketch;
  readonly bodies: readonly GeneralSolidBody[];
  /** The finished sketches of the timeline. */
  readonly sketches: readonly DesignSketchFeature[];
  /** The timeline sketch that is open for editing, which is the working sketch itself and so is not shown twice. */
  readonly editingSketchId?: string | null | undefined;
  readonly limit?: number;
}

const dot3 = (a: readonly [number, number, number], b: readonly [number, number, number]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const tidy = (value: number): number => Number(value.toFixed(9));

/** Moves the curves of a sketch on one plane onto another plane by dropping every point straight onto it. */
export function sketchCurvesOnPlane(source: WorkbenchSketch, target: SketchFrame, newId: (entity: SketchEntity) => string): readonly SketchEntity[] {
  const from = sketchFrameOf(source);
  const parallel = Math.abs(Math.abs(dot3(from.normal, target.normal)) - 1) < 1e-9;
  const map = (point: Vec2): Vec2 => {
    const xy = worldToSketch(sketchToWorld([point[0], point[1]], from), target).xy;
    return [tidy(xy[0]), tidy(xy[1])];
  };
  const turnOf = (rotationDeg: number, center: Vec2): number => {
    const radians = (rotationDeg * Math.PI) / 180;
    const base = map(center);
    const tip = map([center[0] + Math.cos(radians), center[1] + Math.sin(radians)]);
    return tidy((Math.atan2(tip[1] - base[1], tip[0] - base[0]) * 180) / Math.PI);
  };
  const found: SketchEntity[] = [];
  const line = (entity: SketchEntity, start: Vec2, end: Vec2): void => {
    const a = map(start);
    const b = map(end);
    // A line seen end-on has no length on this plane.
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) return;
    found.push({ id: newId(entity), kind: "line", start: a, end: b, construction: true });
  };
  for (const entity of source.entities) {
    if (entity.visible === false) continue;
    if (entity.kind === "line") line(entity, entity.start, entity.end);
    else if (entity.kind === "point") found.push({ id: newId(entity), kind: "point", point: map(entity.point), construction: true });
    else if (entity.kind === "rectangle") {
      const corners = entityPoints(entity);
      corners.forEach((corner, index) => line(entity, corner, corners[(index + 1) % corners.length]!));
    } else if (!parallel) continue;
    else if (entity.kind === "circle") found.push({ id: newId(entity), kind: "circle", center: map(entity.center), radiusMm: entity.radiusMm, construction: true });
    else if (entity.kind === "arc") found.push({ id: newId(entity), kind: "arc", start: map(entity.start), mid: map(entity.mid), end: map(entity.end), construction: true });
    else if (entity.kind === "ellipse") found.push({ id: newId(entity), kind: "ellipse", center: map(entity.center), majorRadiusMm: entity.majorRadiusMm, minorRadiusMm: entity.minorRadiusMm, rotationDeg: turnOf(entity.rotationDeg, entity.center), construction: true });
    else if (entity.kind === "spline") found.push({ id: newId(entity), kind: "spline", fitPoints: entity.fitPoints.map(map), construction: true });
  }
  return found;
}

/** The dimmed reference curves for the working sketch: visible solids first, then the other finished sketches. */
export function sketchReferenceLayer(input: SketchReferenceInput): SketchReferenceLayer {
  const limit = input.limit ?? REFERENCE_CURVE_LIMIT;
  const frame = sketchFrameOf(input.sketch);
  const entities: SketchEntity[] = [];
  let omitted = 0;
  let bodyCount = 0;
  let sketchCount = 0;
  const take = (curves: readonly SketchEntity[]): boolean => {
    const room = Math.max(0, limit - entities.length);
    entities.push(...curves.slice(0, room));
    omitted += Math.max(0, curves.length - room);
    return curves.length > 0;
  };
  for (const body of input.bodies) {
    if (!body.visible || body.indices.length < 9) continue;
    let serial = 0;
    const planned = planProjection({ mode: "project", body, sketch: input.sketch, construction: true, newId: () => `${REFERENCE_ID_PREFIX}body:${body.id}:${serial += 1}` });
    if (planned.ok && take(planned.plan.entities)) bodyCount += 1;
  }
  for (const feature of input.sketches) {
    if (feature.suppressed || feature.id === input.editingSketchId) continue;
    let serial = 0;
    if (take(sketchCurvesOnPlane(feature.sketch, frame, () => `${REFERENCE_ID_PREFIX}sketch:${feature.id}:${serial += 1}`))) sketchCount += 1;
  }
  return { entities, bodyCount, sketchCount, omitted };
}

/** The working sketch with the reference curves added, for the snapping code only. Nothing made from this is stored. */
export function sketchWithReference(sketch: WorkbenchSketch, layer: SketchReferenceLayer | undefined, shown: boolean): WorkbenchSketch {
  if (!shown || layer === undefined || layer.entities.length === 0) return sketch;
  return { ...sketch, entities: [...sketch.entities, ...layer.entities] };
}

/** One line for the Sketch palette: what is shown behind the sketch, or why nothing is. */
export function describeReferenceLayer(layer: SketchReferenceLayer | undefined): string {
  if (layer === undefined || layer.entities.length === 0) return "Nothing to show yet: there is no visible solid and no other finished sketch.";
  const parts: string[] = [];
  if (layer.bodyCount > 0) parts.push(`${layer.bodyCount} solid${layer.bodyCount === 1 ? "" : "s"}`);
  if (layer.sketchCount > 0) parts.push(`${layer.sketchCount} other sketch${layer.sketchCount === 1 ? "" : "es"}`);
  const more = layer.omitted > 0 ? ` ${layer.omitted} more curve${layer.omitted === 1 ? " is" : "s are"} not shown (the limit is ${REFERENCE_CURVE_LIMIT}).` : "";
  return `Showing ${parts.join(" and ")} as ${layer.entities.length} reference curve${layer.entities.length === 1 ? "" : "s"}.${more}`;
}
