import { type SketchEntity, type Vec2, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { arcFrame, type SketchEditContext } from "./edit-tools.js";

/** Moving and joining the free ends of open curves (lines, arcs and splines), used by Make Path and the sketch repair fixes. */

export type CurveEnd = "first" | "last";

export function isOpenCurve(entity: SketchEntity): entity is Extract<SketchEntity, { kind: "line" | "arc" | "spline" }> {
  return entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline";
}

export function curveEnd(entity: Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>, which: CurveEnd): Vec2 {
  if (entity.kind === "spline") return which === "first" ? entity.fitPoints[0]! : entity.fitPoints[entity.fitPoints.length - 1]!;
  return which === "first" ? entity.start : entity.end;
}

/** The curve with one end moved to `to`; an arc keeps its middle point. Undefined if that would make an arc degenerate or collapse a curve. */
export function withCurveEnd(entity: Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>, which: CurveEnd, to: Vec2): SketchEntity | undefined {
  if (entity.kind === "line") {
    const next = which === "first" ? { ...entity, start: to } : { ...entity, end: to };
    return Math.hypot(next.end[0] - next.start[0], next.end[1] - next.start[1]) < 1e-6 ? undefined : next;
  }
  if (entity.kind === "arc") {
    const next = which === "first" ? { ...entity, start: to } : { ...entity, end: to };
    return arcFrame(next) === undefined ? undefined : next;
  }
  const points = entity.fitPoints.map((point, index) => ((which === "first" && index === 0) || (which === "last" && index === entity.fitPoints.length - 1) ? to : point));
  return { ...entity, fitPoints: points };
}

/** A coincident relation between two line ends; undefined for arcs and splines, whose ends the solver cannot join. */
export function jointBetween(context: SketchEditContext, a: SketchEntity, aEnd: CurveEnd, b: SketchEntity, bEnd: CurveEnd): WorkbenchSketchConstraint | undefined {
  if (a.kind !== "line" || b.kind !== "line") return undefined;
  const ref = (which: CurveEnd): "start" | "end" => (which === "first" ? "start" : "end");
  return { id: context.newId("constraint"), kind: "coincident", entityIds: [a.id, b.id], points: [ref(aEnd), ref(bEnd)] };
}
