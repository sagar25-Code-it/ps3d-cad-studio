import {
  dragLiveSketch,
  solveLiveSketch,
  type SketchEntity,
  type SketchPointRef,
  type Vec2,
  type WorkbenchSketch
} from "../../workbench-core/src/index.js";
import { entityPoints } from "./index.js";

/**
 * Direct manipulation: what a press-and-drag on a curve, one of its points or one of its handles does.
 *
 * Every call starts from the sketch as it was when the gesture began, so the result depends only on where the pointer is now
 * (no drift, nothing accumulates) and the input is never modified. Relations that touch the moved geometry relax around it
 * through the live solver, so a joint follows a dragged end and an equal-radius circle resizes with its twin.
 */
export type DragHandle =
  | { readonly kind: "point"; readonly ref: SketchPointRef }
  | { readonly kind: "arc-point"; readonly which: "start" | "mid" | "end" }
  | { readonly kind: "radius" }
  | { readonly kind: "corner"; readonly index: number }
  | { readonly kind: "fit"; readonly index: number }
  | { readonly kind: "body" };

export type DragResult =
  | { readonly ok: true; readonly entities: readonly SketchEntity[]; readonly movedIds: readonly string[] }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): DragResult => ({ ok: false, message });

function isFixed(sketch: WorkbenchSketch, id: string): boolean {
  return sketch.constraints.some((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true && constraint.entityIds.includes(id));
}

function replace(sketch: WorkbenchSketch, replacement: SketchEntity): WorkbenchSketch {
  return { ...sketch, entities: sketch.entities.map((entity) => entity.id === replacement.id ? replacement : entity) };
}

/** Applies a direct edit to one entity, then lets the relations around it settle. */
function settle(sketch: WorkbenchSketch, replacement: SketchEntity): DragResult {
  const edited = replace(sketch, replacement);
  const solved = solveLiveSketch(edited, [replacement.id]);
  if (!solved.ok) return fail(solved.message);
  return { ok: true, entities: solved.entities, movedIds: [...new Set([replacement.id, ...solved.movedIds])] };
}

function liveDrag(sketch: WorkbenchSketch, entityId: string, ref: SketchPointRef, position: Vec2): DragResult {
  const solved = dragLiveSketch(sketch, { entityId, point: ref, positionMm: position });
  if (!solved.ok) return fail(solved.message);
  const before = new Map(sketch.entities.map((entity) => [entity.id, entity]));
  const movedIds = solved.entities.filter((entity) => before.get(entity.id) !== entity).map((entity) => entity.id);
  return { ok: true, entities: solved.entities, movedIds };
}

function circumcircleOf(start: Vec2, mid: Vec2, end: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = start[0] ** 2 + start[1] ** 2;
  const b2 = mid[0] ** 2 + mid[1] ** 2;
  const c2 = end[0] ** 2 + end[1] ** 2;
  const center: Vec2 = [
    (a2 * (mid[1] - end[1]) + b2 * (end[1] - start[1]) + c2 * (start[1] - mid[1])) / determinant,
    (a2 * (end[0] - mid[0]) + b2 * (start[0] - end[0]) + c2 * (mid[0] - start[0])) / determinant
  ];
  return { center, radiusMm: Math.hypot(center[0] - start[0], center[1] - start[1]) };
}

export function dragSketchHandle(sketch: WorkbenchSketch, entityId: string, handle: DragHandle, startMm: Vec2, pointerMm: Vec2): DragResult {
  const entity = sketch.entities.find((candidate) => candidate.id === entityId);
  if (entity === undefined) return fail("The curve no longer exists.");
  const delta: Vec2 = [pointerMm[0] - startMm[0], pointerMm[1] - startMm[1]];
  const fixedNote = "This curve is Fixed. Use Unfix first to move it.";

  if (entity.kind === "line") {
    if (handle.kind === "point" && (handle.ref === "start" || handle.ref === "end")) return liveDrag(sketch, entityId, handle.ref, pointerMm);
    if (handle.kind === "body" || (handle.kind === "point" && handle.ref === "mid")) {
      const middle: Vec2 = [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
      return liveDrag(sketch, entityId, "mid", [middle[0] + delta[0], middle[1] + delta[1]]);
    }
  }

  if (entity.kind === "circle") {
    if (handle.kind === "point" && handle.ref === "center") return liveDrag(sketch, entityId, "center", pointerMm);
    if (handle.kind === "body") return liveDrag(sketch, entityId, "center", [entity.center[0] + delta[0], entity.center[1] + delta[1]]);
    if (handle.kind === "radius") {
      if (isFixed(sketch, entityId)) return fail(fixedNote);
      const radiusMm = Math.hypot(pointerMm[0] - entity.center[0], pointerMm[1] - entity.center[1]);
      if (radiusMm < 0.01) return fail("A circle radius must be at least 0.01 mm.");
      return settle(sketch, { ...entity, radiusMm });
    }
  }

  if (entity.kind === "arc") {
    const circle = circumcircleOf(entity.start, entity.mid, entity.end);
    if (circle === undefined) return fail("This arc is degenerate and cannot be dragged.");
    if (handle.kind === "point" && handle.ref === "center") return liveDrag(sketch, entityId, "center", pointerMm);
    if (handle.kind === "body") return liveDrag(sketch, entityId, "center", [circle.center[0] + delta[0], circle.center[1] + delta[1]]);
    if (handle.kind === "arc-point") {
      if (isFixed(sketch, entityId)) return fail(fixedNote);
      const next = { ...entity, [handle.which]: pointerMm } as typeof entity;
      if (circumcircleOf(next.start, next.mid, next.end) === undefined || Math.abs((next.mid[0] - next.start[0]) * (next.end[1] - next.start[1]) - (next.mid[1] - next.start[1]) * (next.end[0] - next.start[0])) < 1e-4) {
        return fail("The three arc points would be in a straight line.");
      }
      return settle(sketch, next);
    }
  }

  if (entity.kind === "point") {
    if (handle.kind === "point" || handle.kind === "body") return liveDrag(sketch, entityId, "self", handle.kind === "body" ? [entity.point[0] + delta[0], entity.point[1] + delta[1]] : pointerMm);
  }

  if (entity.kind === "rectangle") {
    if (isFixed(sketch, entityId)) return fail(fixedNote);
    if (handle.kind === "body") return settle(sketch, { ...entity, center: [entity.center[0] + delta[0], entity.center[1] + delta[1]] });
    if (handle.kind === "corner") {
      // A rectangle with a driving width or height keeps its size: the corner is pinned under the pointer and the rectangle follows it.
      const dimensioned = sketch.constraints.some((constraint) => constraint.kind === "distance" && constraint.driven !== true && constraint.suppressed !== true
        && (constraint.dimension === "width" || constraint.dimension === "height") && constraint.entityIds[0] === entityId);
      if (dimensioned) return liveDrag(sketch, entityId, `corner-${handle.index}` as SketchPointRef, pointerMm);
      // Resize about the opposite corner, in the rectangle's own (possibly rotated) frame.
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const axisX: Vec2 = [Math.cos(radians), Math.sin(radians)];
      const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
      const corners = entityPoints(entity);
      const opposite = corners[(handle.index + 2) % 4]!;
      const along = (pointerMm[0] - opposite[0]) * axisX[0] + (pointerMm[1] - opposite[1]) * axisX[1];
      const up = (pointerMm[0] - opposite[0]) * axisY[0] + (pointerMm[1] - opposite[1]) * axisY[1];
      const widthMm = Math.abs(along);
      const heightMm = Math.abs(up);
      if (widthMm < 0.01 || heightMm < 0.01) return fail("A rectangle needs a width and a height of at least 0.01 mm.");
      const sx = along < 0 ? -1 : 1;
      const sy = up < 0 ? -1 : 1;
      const center: Vec2 = [
        opposite[0] + axisX[0] * sx * widthMm / 2 + axisY[0] * sy * heightMm / 2,
        opposite[1] + axisX[1] * sx * widthMm / 2 + axisY[1] * sy * heightMm / 2
      ];
      return settle(sketch, { ...entity, center, widthMm, heightMm });
    }
  }

  if (entity.kind === "spline") {
    if (isFixed(sketch, entityId)) return fail(fixedNote);
    if (handle.kind === "body") return settle(sketch, { ...entity, fitPoints: entity.fitPoints.map((point): Vec2 => [point[0] + delta[0], point[1] + delta[1]]) });
    if (handle.kind === "fit") {
      const fitPoints = entity.fitPoints.map((point, index): Vec2 => index === handle.index ? pointerMm : point);
      const previous = fitPoints[handle.index - 1];
      const next = fitPoints[handle.index + 1];
      const tooClose = (a: Vec2 | undefined): boolean => a !== undefined && Math.hypot(a[0] - pointerMm[0], a[1] - pointerMm[1]) < 0.01;
      if (tooClose(previous) || tooClose(next)) return fail("Spline fit points must stay at least 0.01 mm apart.");
      return settle(sketch, { ...entity, fitPoints });
    }
  }

  return fail("That handle does not move this kind of curve.");
}

/** The grab handles a curve shows while it is hovered or selected, in the order they should be drawn. */
export interface SketchGrabHandle {
  readonly id: string;
  readonly handle: DragHandle;
  readonly point: Vec2;
  readonly label: string;
}

export function grabHandlesOf(entity: SketchEntity): readonly SketchGrabHandle[] {
  const make = (suffix: string, handle: DragHandle, point: Vec2, label: string): SketchGrabHandle => ({ id: `grab:${entity.id}:${suffix}`, handle, point, label });
  if (entity.kind === "line") {
    return [
      make("start", { kind: "point", ref: "start" }, entity.start, "Line start"),
      make("end", { kind: "point", ref: "end" }, entity.end, "Line end")
    ];
  }
  if (entity.kind === "circle") {
    return [
      make("center", { kind: "point", ref: "center" }, entity.center, "Circle center"),
      make("radius", { kind: "radius" }, [entity.center[0] + entity.radiusMm, entity.center[1]], "Circle radius")
    ];
  }
  if (entity.kind === "arc") {
    const circle = circumcircleOf(entity.start, entity.mid, entity.end);
    return [
      make("start", { kind: "arc-point", which: "start" }, entity.start, "Arc start"),
      make("mid", { kind: "arc-point", which: "mid" }, entity.mid, "Arc middle"),
      make("end", { kind: "arc-point", which: "end" }, entity.end, "Arc end"),
      ...(circle === undefined ? [] : [make("center", { kind: "point", ref: "center" } as const, circle.center, "Arc center")])
    ];
  }
  if (entity.kind === "point") return [make("self", { kind: "point", ref: "self" }, entity.point, "Sketch point")];
  if (entity.kind === "rectangle") return entityPoints(entity).map((corner, index) => make(`corner-${index}`, { kind: "corner", index }, corner, "Rectangle corner"));
  if (entity.kind === "ellipse") return [make("center", { kind: "point", ref: "center" } as const, entity.center, "Ellipse center")];
  return entity.fitPoints.map((point, index) => make(`fit-${index}`, { kind: "fit", index }, point, "Spline point"));
}
