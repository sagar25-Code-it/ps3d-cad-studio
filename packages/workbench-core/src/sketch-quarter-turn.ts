import { entityNames } from "./sketch-translate.js";
import type { SketchEntity, Vec2, WorkbenchSketch } from "./types.js";

/**
 * Horizontal on a line that is exactly vertical (and Vertical on one that is exactly horizontal) needs a quarter turn. The solver finds the
 * nearest answer, and for a line turned the wrong way exactly the nearest answer is to squash it to a point, which is refused as a collapse
 * (re-audit N-08; Fusion and SolidWorks turn the line instead). The turn is a choice of starting point, not of the answer: before the solve the
 * line is turned a quarter turn about the end that is joined to something else (its start when neither or both are), keeping its length, so
 * the solver starts from the horizontal line and only has to settle the other relations around it.
 */
const EXACT = 1e-6;

const near = (a: Vec2, b: Vec2): boolean => Math.abs(a[0] - b[0]) <= 1e-6 && Math.abs(a[1] - b[1]) <= 1e-6;

/** The points of an entity other geometry can be joined at. */
function joinPoints(entity: SketchEntity): readonly Vec2[] {
  switch (entity.kind) {
    case "line": return [entity.start, entity.end];
    case "arc": return [entity.start, entity.end];
    case "point": return [entity.point];
    case "circle": return [entity.center];
    case "ellipse": return [entity.center];
    case "spline": return entity.fitPoints.length === 0 ? [] : [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!];
    default: return [];
  }
}

export interface QuarterTurnSeed {
  readonly sketch: WorkbenchSketch;
  /** The lines that were turned, by ID. */
  readonly turnedIds: readonly string[];
}

/**
 * The sketch with every line that a Horizontal or Vertical relation needs to turn a quarter turn already turned, or the sketch itself
 * when there is none. Only lines in `component` are touched, and only while the relation is not already met.
 */
export function seedQuarterTurns(sketch: WorkbenchSketch, component: ReadonlySet<string>): QuarterTurnSeed {
  const turned = new Map<string, SketchEntity>();
  for (const constraint of sketch.constraints) {
    if (constraint.suppressed === true || (constraint.kind !== "horizontal" && constraint.kind !== "vertical") || constraint.entityIds.length !== 1) continue;
    const id = constraint.entityIds[0]!;
    if (!component.has(id) || turned.has(id)) continue;
    const line = sketch.entities.find((entity) => entity.id === id);
    if (line === undefined || line.kind !== "line") continue;
    const opposite = constraint.kind === "horizontal" ? "vertical" : "horizontal";
    if (sketch.constraints.some((other) => other.suppressed !== true && other.kind === opposite && other.entityIds.includes(id))) continue;
    // A line held in place (Fixed) is not turned: the pin would be read from the turned line. It is refused with its conflict as before.
    if (sketch.constraints.some((other) => other.suppressed !== true && other.kind === "fixed" && other.entityIds.includes(id))) continue;
    const dx = line.end[0] - line.start[0];
    const dy = line.end[1] - line.start[1];
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) continue;
    const verticalNow = Math.abs(dx) <= EXACT * Math.max(1, length);
    const horizontalNow = Math.abs(dy) <= EXACT * Math.max(1, length);
    if (!(constraint.kind === "horizontal" ? verticalNow : horizontalNow)) continue;
    const startJoined = isJoined(sketch, line, line.start);
    const endJoined = isJoined(sketch, line, line.end);
    const pivotIsEnd = endJoined && !startJoined;
    // The line always runs start to end toward +X (Horizontal) or +Y (Vertical) afterwards.
    const along: Vec2 = constraint.kind === "horizontal" ? [length, 0] : [0, length];
    const next: SketchEntity = pivotIsEnd
      ? { ...line, start: [line.end[0] - along[0], line.end[1] - along[1]] }
      : { ...line, end: [line.start[0] + along[0], line.start[1] + along[1]] };
    turned.set(id, next);
  }
  if (turned.size === 0) return { sketch, turnedIds: [] };
  return { sketch: { ...sketch, entities: sketch.entities.map((entity) => turned.get(entity.id) ?? entity) }, turnedIds: [...turned.keys()] };
}

/** True when another curve meets this point of the line, a relation pins it, or it sits on the sketch origin. */
function isJoined(sketch: WorkbenchSketch, line: SketchEntity, point: Vec2): boolean {
  if (near(point, [0, 0])) return true;
  for (const other of sketch.entities) {
    if (other.id === line.id) continue;
    if (joinPoints(other).some((candidate) => near(candidate, point))) return true;
  }
  return false;
}

/**
 * Why an exact edit that adds Horizontal to a vertical line (or Vertical to a horizontal one) is refused, and where the turn is done:
 * an edit keeps geometry exactly as sent, so it cannot also turn a line; add-sketch-constraint turns it.
 */
export function quarterTurnEditProblem(sketch: WorkbenchSketch, turnedIds: readonly string[]): { readonly message: string; readonly recovery: string } | undefined {
  const id = turnedIds[0];
  if (id === undefined) return undefined;
  const line = sketch.entities.find((entity) => entity.id === id);
  if (line === undefined || line.kind !== "line") return undefined;
  const names = entityNames(sketch);
  const vertical = Math.abs(line.end[0] - line.start[0]) <= EXACT * Math.max(1, Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]));
  return {
    message: `${names.get(id) ?? id} is exactly ${vertical ? "vertical" : "horizontal"} (from ${line.start[0]}, ${line.start[1]} to ${line.end[0]}, ${line.end[1]}), so ${vertical ? "Horizontal" : "Vertical"} needs a quarter turn, and an exact edit cannot turn a line.`,
    recovery: `Add the relation with add-sketch-constraint, which turns the line a quarter turn about its joined end and keeps its length, or draw the line ${vertical ? "level" : "upright"} in this edit.`
  };
}
