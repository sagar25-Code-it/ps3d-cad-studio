import { entityNames } from "./sketch-translate.js";
import { isSketchDatumEntityId, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "./types.js";

/**
 * A line that lies exactly across the direction a relation asks for (a horizontal line asked to be Vertical, a vertical one asked to be
 * Horizontal, a line square to another asked to be Parallel, a parallel one asked to be Perpendicular) sits where the solver's
 * gradient has nothing to push with: the nearest answer in the linearised relations is to squash the line to a point. A designer who
 * asks for the relation wants the line turned a quarter turn, so the line is turned to the required direction before the solve, about
 * its joined end (its start when neither or both ends are joined) and keeping its length, and the solver only has to tidy what is joined
 * to it. A line held in place (Fixed) is never turned: the pin would be read from the turned line, so the conflict is reported as before.
 * Horizontal and Vertical alone are the "quarter turn" of the re-audit (N-08); `seedQuarterTurns` is that subset, used to word an
 * exact-edit refusal.
 */
const ACROSS = 1e-3;
/** How exactly vertical or horizontal a line must be for an exact edit to name the quarter turn. */
const EXACT = 1e-6;

type LineEntity = Extract<SketchEntity, { kind: "line" }>;

const AXIS_DIRECTION: Readonly<Record<string, Vec2>> = { "sketch:axis-x": [1, 0], "sketch:axis-y": [0, 1] };

function directionOf(id: string, lines: ReadonlyMap<string, LineEntity>): Vec2 | undefined {
  const axis = AXIS_DIRECTION[id];
  if (axis !== undefined) return axis;
  const line = lines.get(id);
  if (line === undefined) return undefined;
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length = Math.hypot(dx, dy);
  return length > 0 ? [dx / length, dy / length] : undefined;
}

/** The turned copy of a line: same length, the given unit direction, swinging about its start (or about its end when `aboutEnd`). */
function pointed(line: LineEntity, direction: Vec2, aboutEnd = false): LineEntity {
  const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
  const along: Vec2 = [direction[0] * length, direction[1] * length];
  return aboutEnd ? { ...line, start: [line.end[0] - along[0], line.end[1] - along[1]] } : { ...line, end: [line.start[0] + along[0], line.start[1] + along[1]] };
}

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

/** True when another curve meets this point of the line or it sits on the sketch origin. */
function isJoined(sketch: WorkbenchSketch, line: LineEntity, point: Vec2): boolean {
  if (near(point, [0, 0])) return true;
  for (const other of sketch.entities) {
    if (other.id === line.id) continue;
    if (joinPoints(other).some((candidate) => near(candidate, point))) return true;
  }
  return false;
}

/** True when the line swings about its end: the end is joined to something and the start is free. */
function swingsAboutEnd(sketch: WorkbenchSketch, line: LineEntity): boolean {
  return isJoined(sketch, line, line.end) && !isJoined(sketch, line, line.start);
}

/**
 * Returns the sketch with each exactly-across line turned to the direction its relation needs. The sketch is returned unchanged
 * (the same object) when no line needs turning. `turned` lists the lines that were turned.
 */
export function turnAcrossLines(sketch: WorkbenchSketch, component: ReadonlySet<string>, forceActive?: ReadonlySet<string>, onlyQuarterTurns = false): { readonly sketch: WorkbenchSketch; readonly turned: readonly string[] } {
  const lines = new Map<string, LineEntity>();
  for (const entity of sketch.entities) if (entity.kind === "line" && component.has(entity.id)) lines.set(entity.id, entity);
  if (lines.size === 0) return { sketch, turned: [] };
  const active = sketch.constraints.filter((candidate) => candidate.suppressed !== true || forceActive?.has(candidate.id) === true);
  const fixed = (id: string): boolean => active.some((candidate) => candidate.kind === "fixed" && candidate.entityIds.includes(id));
  const hasKind = (id: string, kind: WorkbenchSketchConstraint["kind"]): boolean => active.some((candidate) => candidate.kind === kind && candidate.entityIds.includes(id));
  const replaced = new Map<string, LineEntity>();
  const current = (id: string): LineEntity | undefined => replaced.get(id) ?? lines.get(id);
  const view = (): ReadonlyMap<string, LineEntity> => new Map([...lines, ...replaced]);
  for (const constraint of active) {
    const [first, second] = constraint.entityIds;
    if (first === undefined) continue;
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const line = current(first);
      if (line === undefined || constraint.entityIds.length !== 1 || fixed(first)) continue;
      // Horizontal and Vertical on one line contradict each other; the solver names that conflict.
      if (hasKind(first, constraint.kind === "horizontal" ? "vertical" : "horizontal")) continue;
      const direction = directionOf(first, view());
      if (direction === undefined) continue;
      const across = constraint.kind === "horizontal" ? Math.abs(direction[0]) <= ACROSS : Math.abs(direction[1]) <= ACROSS;
      if (across) replaced.set(first, pointed(line, constraint.kind === "horizontal" ? [1, 0] : [0, 1], swingsAboutEnd(sketch, line)));
      continue;
    }
    if (onlyQuarterTurns || (constraint.kind !== "parallel" && constraint.kind !== "perpendicular") || second === undefined) continue;
    // The second line is the one that turns; a sketch axis never does.
    const turning = !isSketchDatumEntityId(second) && current(second) !== undefined ? second : !isSketchDatumEntityId(first) && current(first) !== undefined ? first : undefined;
    if (turning === undefined || fixed(turning)) continue;
    const reference = turning === second ? first : second;
    const refDirection = directionOf(reference, view());
    const ownDirection = directionOf(turning, view());
    const line = current(turning);
    if (refDirection === undefined || ownDirection === undefined || line === undefined) continue;
    const dot = refDirection[0] * ownDirection[0] + refDirection[1] * ownDirection[1];
    const cross = refDirection[0] * ownDirection[1] - refDirection[1] * ownDirection[0];
    if (constraint.kind === "parallel" && Math.abs(dot) <= ACROSS) {
      // Square to the reference: turn to run the same way as it.
      replaced.set(turning, pointed(line, refDirection, swingsAboutEnd(sketch, line)));
    } else if (constraint.kind === "perpendicular" && Math.abs(cross) <= ACROSS) {
      // Along the reference: turn a quarter turn counter-clockwise from where it points.
      replaced.set(turning, pointed(line, [-ownDirection[1], ownDirection[0]], swingsAboutEnd(sketch, line)));
    }
  }
  if (replaced.size === 0) return { sketch, turned: [] };
  return { sketch: { ...sketch, entities: sketch.entities.map((entity) => replaced.get(entity.id) ?? entity) }, turned: [...replaced.keys()] };
}

export interface QuarterTurnSeed {
  readonly sketch: WorkbenchSketch;
  /** The lines that were turned, by ID. */
  readonly turnedIds: readonly string[];
}

/** The Horizontal and Vertical quarter turns alone (not Parallel and Perpendicular): the lines a Horizontal or Vertical relation turns. */
export function seedQuarterTurns(sketch: WorkbenchSketch, component: ReadonlySet<string>, forceActive?: ReadonlySet<string>): QuarterTurnSeed {
  const result = turnAcrossLines(sketch, component, forceActive, true);
  return { sketch: result.sketch, turnedIds: result.turned };
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
