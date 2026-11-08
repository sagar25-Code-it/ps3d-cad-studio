import type { SketchEntity, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { arcShape } from "../../workbench-core/src/sketch-measure.js";
import { entityPoints } from "./index.js";

/**
 * The sketch Measure tool: pick two points for the distance and its components, two lines for the angle (and the gap when they
 * are parallel), or a point and a line for the perpendicular distance. It only reads the sketch: it never adds a constraint or a
 * dimension, so measuring cannot change the model.
 */
type Line = Extract<SketchEntity, { kind: "line" }>;

export type MeasureTarget =
  | { readonly kind: "point"; readonly at: Vec2; readonly label: string }
  | { readonly kind: "line"; readonly entityId: string; readonly start: Vec2; readonly end: Vec2; readonly label: string };

export type Measurement =
  | { readonly kind: "points"; readonly from: Vec2; readonly to: Vec2; readonly distanceMm: number; readonly dxMm: number; readonly dyMm: number; readonly angleDeg: number }
  | { readonly kind: "lines"; readonly first: MeasureTarget & { readonly kind: "line" }; readonly second: MeasureTarget & { readonly kind: "line" }; readonly angleDeg: number; readonly acuteDeg: number; readonly parallel: boolean; readonly gapMm: number | undefined; readonly crossing: Vec2 | undefined }
  | { readonly kind: "point-line"; readonly point: Vec2; readonly foot: Vec2; readonly distanceMm: number };

export interface MeasureState {
  readonly picks: readonly MeasureTarget[];
  readonly result: Measurement | undefined;
}

export const EMPTY_MEASURE: MeasureState = { picks: [], result: undefined };

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function measurePoints(from: Vec2, to: Vec2): Extract<Measurement, { kind: "points" }> {
  const dxMm = to[0] - from[0];
  const dyMm = to[1] - from[1];
  let angleDeg = (Math.atan2(dyMm, dxMm) * 180) / Math.PI;
  if (angleDeg < 0) angleDeg += 360;
  return { kind: "points", from, to, distanceMm: Math.hypot(dxMm, dyMm), dxMm, dyMm, angleDeg: dist(from, to) < 1e-12 ? 0 : angleDeg };
}

function footOnLine(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-18) return start;
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  return [start[0] + dx * t, start[1] + dy * t];
}

export function measurePointToLine(point: Vec2, line: { readonly start: Vec2; readonly end: Vec2 }): Extract<Measurement, { kind: "point-line" }> {
  const foot = footOnLine(point, line.start, line.end);
  return { kind: "point-line", point, foot, distanceMm: dist(point, foot) };
}

/**
 * The angle between two lines as they are drawn (from the first line's direction to the second's, 0 to 180 degrees) and the acute
 * angle between the two infinite lines. Lines within a hair of parallel report the perpendicular gap instead of a crossing.
 */
export function measureLines(first: MeasureTarget & { readonly kind: "line" }, second: MeasureTarget & { readonly kind: "line" }): Extract<Measurement, { kind: "lines" }> {
  const a: Vec2 = [first.end[0] - first.start[0], first.end[1] - first.start[1]];
  const b: Vec2 = [second.end[0] - second.start[0], second.end[1] - second.start[1]];
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  const cos = la < 1e-12 || lb < 1e-12 ? 1 : Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)));
  const angleDeg = (Math.acos(cos) * 180) / Math.PI;
  const acuteDeg = Math.min(angleDeg, 180 - angleDeg);
  const cross = la < 1e-12 || lb < 1e-12 ? 0 : (a[0] * b[1] - a[1] * b[0]) / (la * lb);
  const parallel = Math.abs(cross) < 1e-9;
  if (parallel) {
    const foot = footOnLine(second.start, first.start, first.end);
    return { kind: "lines", first, second, angleDeg, acuteDeg, parallel, gapMm: dist(second.start, foot), crossing: undefined };
  }
  const t = ((second.start[0] - first.start[0]) * b[1] - (second.start[1] - first.start[1]) * b[0]) / (a[0] * b[1] - a[1] * b[0]);
  return { kind: "lines", first, second, angleDeg, acuteDeg, parallel, gapMm: undefined, crossing: [first.start[0] + a[0] * t, first.start[1] + a[1] * t] };
}

/** Adds one pick. A third pick starts a new measurement; a point and a line measure the perpendicular distance. */
export function addMeasurePick(state: MeasureState, pick: MeasureTarget): MeasureState {
  if (state.result !== undefined || state.picks.length >= 2) return { picks: [pick], result: undefined };
  const picks = [...state.picks, pick];
  if (picks.length < 2) return { picks, result: undefined };
  const first = picks[0]!;
  const second = picks[1]!;
  if (first.kind === "point" && second.kind === "point") return { picks, result: measurePoints(first.at, second.at) };
  if (first.kind === "line" && second.kind === "line") {
    if (first.entityId === second.entityId) return { picks: [pick], result: undefined };
    return { picks, result: measureLines(first, second) };
  }
  const point = first.kind === "point" ? first : (second as MeasureTarget & { readonly kind: "point" });
  const line = first.kind === "line" ? first : (second as MeasureTarget & { readonly kind: "line" });
  return { picks, result: measurePointToLine(point.at, line) };
}

function pointCandidates(entity: SketchEntity): readonly { readonly at: Vec2; readonly label: string }[] {
  const found: { at: Vec2; label: string }[] = [];
  if (entity.kind === "line") {
    found.push({ at: entity.start, label: "line start" }, { at: entity.end, label: "line end" }, { at: [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], label: "line midpoint" });
  } else if (entity.kind === "circle") found.push({ at: entity.center, label: "circle centre" });
  else if (entity.kind === "ellipse") found.push({ at: entity.center, label: "ellipse centre" });
  else if (entity.kind === "arc") {
    found.push({ at: entity.start, label: "arc start" }, { at: entity.end, label: "arc end" }, { at: entity.mid, label: "arc middle" });
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape !== undefined) found.push({ at: shape.center, label: "arc centre" });
  } else if (entity.kind === "point") found.push({ at: entity.point, label: "sketch point" });
  else if (entity.kind === "rectangle") entityPoints(entity).forEach((corner, index) => found.push({ at: corner, label: `rectangle corner ${index + 1}` }));
  else if (entity.kind === "spline") entity.fitPoints.forEach((point, index) => found.push({ at: point, label: `spline point ${index + 1}` }));
  return found;
}

function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return dist(point, [start[0] + dx * t, start[1] + dy * t]);
}

/**
 * What a click at `pointMm` measures: the nearest defining point of any visible curve within `toleranceMm`, else a line within the
 * same reach, else (for the free cursor) the bare point. Points win over lines so a line's end is always reachable.
 */
export function pickMeasureTarget(sketch: Pick<WorkbenchSketch, "entities">, pointMm: Vec2, toleranceMm: number, wanted: "any" | "point" | "line" = "any"): MeasureTarget | undefined {
  const entities = sketch.entities.filter((entity) => entity.visible !== false);
  if (wanted !== "line") {
    let best: { at: Vec2; label: string; distance: number } | undefined;
    for (const entity of entities) {
      for (const candidate of pointCandidates(entity)) {
        const distance = dist(candidate.at, pointMm);
        if (distance <= toleranceMm && (best === undefined || distance < best.distance)) best = { ...candidate, distance };
      }
    }
    if (best !== undefined) return { kind: "point", at: best.at, label: best.label };
  }
  if (wanted !== "point") {
    let bestLine: { line: Line; distance: number } | undefined;
    for (const entity of entities) {
      if (entity.kind !== "line") continue;
      const distance = distanceToSegment(pointMm, entity.start, entity.end);
      if (distance <= toleranceMm && (bestLine === undefined || distance < bestLine.distance)) bestLine = { line: entity, distance };
    }
    if (bestLine !== undefined) return { kind: "line", entityId: bestLine.line.id, start: bestLine.line.start, end: bestLine.line.end, label: "line" };
  }
  return wanted === "line" ? undefined : { kind: "point", at: pointMm, label: "free point" };
}

const n3 = (value: number): string => String(Number(value.toFixed(3)));

/** One readable line per measurement for the status bar and the canvas readout. */
export function describeMeasurement(measurement: Measurement): string {
  if (measurement.kind === "points") return `Distance ${n3(measurement.distanceMm)} mm (ΔX ${n3(measurement.dxMm)} mm, ΔY ${n3(measurement.dyMm)} mm, direction ${n3(measurement.angleDeg)}°)`;
  if (measurement.kind === "point-line") return `Distance from the point to the line ${n3(measurement.distanceMm)} mm`;
  if (measurement.parallel) return `The lines are parallel, ${n3(measurement.gapMm ?? 0)} mm apart`;
  return `Angle between the lines ${n3(measurement.angleDeg)}° (acute ${n3(measurement.acuteDeg)}°)`;
}
