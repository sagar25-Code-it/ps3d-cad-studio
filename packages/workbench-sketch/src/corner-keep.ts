import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { SketchEditContext } from "./edit-tools.js";
import { entityPoints } from "./index.js";

/**
 * What an edit that rebuilds a corner (fillet, chamfer) or replaces a rectangle by its sides keeps.
 *
 * A fillet shortens the two lines that met at the corner, so a length dimension on either of them, a distance measured to the corner,
 * a joint of a third curve at the corner, or a pin of the corner to the origin would all stop being true. CAD systems keep them by
 * leaving a "virtual sharp": the point where the two lines would still meet. That point is added here as a construction point that
 * lies on both carrier lines, and every such relation is moved onto it. The part keeps its overall size (an 80 x 50 plate stays
 * 80 x 50 whatever the corner radius becomes) and stays anchored.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;

export interface CornerCutEnd {
  /** The curve that is cut back. */
  readonly id: string;
  /** Its end that the cut moves away from the old corner. */
  readonly end: "start" | "end";
}

export interface KeptCorner {
  readonly addEntities: readonly SketchEntity[];
  readonly addConstraints: readonly WorkbenchSketchConstraint[];
  readonly removeConstraintIds: readonly string[];
  /** How many relations were moved onto the virtual corner. */
  readonly kept: number;
}

const NOTHING: KeptCorner = { addEntities: [], addConstraints: [], removeConstraintIds: [], kept: 0 };

const POINT_DISTANCES = new Set(["aligned", "horizontal", "vertical", "point-line"]);

/**
 * The relations that touch a cut end of the corner, moved onto a construction point at the old corner. Nothing is added when no
 * relation needs it, so a plain fillet of an undimensioned corner stays as small as before.
 */
export function keepRelationsAtCorner(context: SketchEditContext, sketch: WorkbenchSketch, cuts: readonly CornerCutEnd[], at: Vec2): KeptCorner {
  const cutOf = new Map(cuts.map((cut) => [cut.id, cut] as const));
  const lines = new Map(sketch.entities.filter((entity): entity is Line => entity.kind === "line").map((line) => [line.id, line] as const));
  let made: string | undefined;
  const sharp = (): string => (made ??= context.newId("entity"));
  const replacements: { readonly old: string; readonly made: WorkbenchSketchConstraint }[] = [];
  const touchesCut = (id: string | undefined, ref: SketchPointRef | undefined): boolean => {
    if (id === undefined) return false;
    const cut = cutOf.get(id);
    return cut !== undefined && ref === cut.end;
  };
  for (const constraint of sketch.constraints) {
    if (constraint.suppressed === true) continue;
    const ids = constraint.entityIds;
    if (!ids.some((id) => cutOf.has(id))) continue;
    const refs = constraint.points ?? [];
    if (constraint.kind === "distance" && constraint.driven !== true && constraint.valueMm !== undefined) {
      if (ids.length === 1 && (constraint.dimension === undefined || constraint.dimension === "length") && lines.has(ids[0]!)) {
        // A line's length becomes the distance from its other end to the old corner.
        const cut = cutOf.get(ids[0]!);
        if (cut === undefined) continue;
        const near = cut.end === "start";
        replacements.push({
          old: constraint.id,
          made: {
            id: context.newId("constraint"),
            kind: "distance",
            dimension: "aligned",
            entityIds: near ? [sharp(), ids[0]!] : [ids[0]!, sharp()],
            points: near ? ["self", "end"] : ["start", "self"],
            valueMm: constraint.valueMm,
            ...(constraint.expression === undefined ? {} : { expression: constraint.expression })
          }
        });
        continue;
      }
      if (constraint.dimension !== undefined && POINT_DISTANCES.has(constraint.dimension)) {
        // A distance measured to the cut end is measured to the old corner instead.
        const limit = constraint.dimension === "point-line" ? 1 : ids.length;
        let changed = false;
        const entityIds = [...ids];
        const points = [...refs];
        for (let index = 0; index < limit; index += 1) {
          if (touchesCut(ids[index], refs[index])) { entityIds[index] = sharp(); points[index] = "self"; changed = true; }
        }
        if (changed) replacements.push({ old: constraint.id, made: { ...constraint, id: context.newId("constraint"), entityIds, points } });
      }
      continue;
    }
    if (constraint.kind === "coincident" || constraint.kind === "midpoint") {
      // A third curve (or the origin) joined at the corner stays joined at the old corner. The joint between the two cut curves is replaced by the fillet itself.
      const cutIndexes = ids.flatMap((id, index) => (cutOf.has(id) ? [index] : []));
      if (cutIndexes.length !== 1) continue;
      const mine = cutIndexes[0]!;
      if (!touchesCut(ids[mine], refs[mine]) || (constraint.kind === "midpoint" && mine !== 0)) continue;
      const entityIds = [...ids];
      const points = [...refs];
      entityIds[mine] = sharp();
      points[mine] = "self";
      replacements.push({ old: constraint.id, made: { ...constraint, id: context.newId("constraint"), entityIds, points } });
    }
  }
  if (replacements.length === 0) return NOTHING;
  const sample = sketch.entities.find((entity) => cutOf.has(entity.id));
  const point: SketchEntity = { id: sharp(), kind: "point", point: at, construction: true, ...(sample?.visible === undefined ? {} : { visible: sample.visible }) };
  const onCurve = cuts.map((cut): WorkbenchSketchConstraint => ({ id: context.newId("constraint"), kind: "coincident", entityIds: [sharp(), cut.id], points: ["self", "curve"] }));
  return {
    addEntities: [point],
    addConstraints: [...onCurve, ...replacements.map((item) => item.made)],
    removeConstraintIds: replacements.map((item) => item.old),
    kept: replacements.length
  };
}

// ---------------------------------------------------------------------------------------------
// A rectangle that is replaced by sides
// ---------------------------------------------------------------------------------------------

export interface RectangleSides {
  /** For corner k (0 to 3), the line that starts at it. */
  readonly cornerLine: readonly string[];
  /** The lines that replace the rectangle's sides, for picking the side a point-on-curve relation belongs to. */
  readonly lines: readonly Line[];
}

export interface CarriedRectangle {
  readonly addEntities: readonly SketchEntity[];
  readonly addConstraints: readonly WorkbenchSketchConstraint[];
  /** Relations on the rectangle that could not be expressed on its sides. */
  readonly lost: readonly WorkbenchSketchConstraint[];
}

const CORNER_REF = /^corner-([0-3])$/u;

function distanceToLine(point: Vec2, line: Line): number {
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length = Math.hypot(dx, dy) || 1;
  const t = Math.max(0, Math.min(1, ((point[0] - line.start[0]) * dx + (point[1] - line.start[1]) * dy) / (length * length)));
  return Math.hypot(point[0] - (line.start[0] + dx * t), point[1] - (line.start[1] + dy * t));
}

/**
 * Re-expresses the relations of a rectangle that are about its points (a corner pinned to the origin, a line joined to a corner, a
 * hole measured from the centre) on the lines that replace it. A corner is the start of its line; the centre becomes the middle of a
 * construction diagonal. Width, height and squareness are the caller's business.
 */
export function carryRectangleRelations(context: SketchEditContext, sketch: WorkbenchSketch, rectangle: Extract<SketchEntity, { kind: "rectangle" }>, sides: RectangleSides): CarriedRectangle {
  const addEntities: SketchEntity[] = [];
  const addConstraints: WorkbenchSketchConstraint[] = [];
  const lost: WorkbenchSketchConstraint[] = [];
  let diagonalId: string | undefined;
  const corners = entityPoints(rectangle);
  const diagonal = (): string => {
    if (diagonalId !== undefined) return diagonalId;
    diagonalId = context.newId("entity");
    addEntities.push({ id: diagonalId, kind: "line", start: corners[0]!, end: corners[2]!, construction: true, ...(rectangle.visible === undefined ? {} : { visible: rectangle.visible }) });
    addConstraints.push(
      { id: context.newId("constraint"), kind: "coincident", entityIds: [diagonalId, sides.cornerLine[0]!], points: ["start", "start"] },
      { id: context.newId("constraint"), kind: "coincident", entityIds: [diagonalId, sides.cornerLine[2]!], points: ["end", "start"] }
    );
    return diagonalId;
  };
  const pointOf = (id: string, ref: SketchPointRef | undefined): Vec2 | undefined => {
    const entity = sketch.entities.find((candidate) => candidate.id === id);
    if (entity === undefined) return undefined;
    if (entity.kind === "line") return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2] : undefined;
    if (entity.kind === "circle" || entity.kind === "ellipse") return ref === "center" ? entity.center : undefined;
    if (entity.kind === "point") return entity.point;
    return undefined;
  };
  for (const constraint of sketch.constraints) {
    if (constraint.suppressed === true || !constraint.entityIds.includes(rectangle.id)) continue;
    const kindOk = constraint.kind === "coincident" || constraint.kind === "midpoint"
      || (constraint.kind === "distance" && constraint.dimension !== undefined && POINT_DISTANCES.has(constraint.dimension) && constraint.driven !== true);
    if (!kindOk) {
      if (constraint.kind !== "horizontal" && constraint.kind !== "vertical" && !(constraint.kind === "distance" && (constraint.dimension === "width" || constraint.dimension === "height")) && constraint.kind !== "fixed") lost.push(constraint);
      continue;
    }
    const entityIds = [...constraint.entityIds];
    const points = [...(constraint.points ?? [])];
    let ok = true;
    constraint.entityIds.forEach((id, index) => {
      if (id !== rectangle.id || !ok) return;
      const ref = points[index];
      const corner = ref === undefined ? null : CORNER_REF.exec(ref);
      if (corner !== null) {
        entityIds[index] = sides.cornerLine[Number(corner[1])]!;
        points[index] = "start";
      } else if (ref === "center") {
        entityIds[index] = diagonal();
        points[index] = "mid";
      } else if (ref === "curve" && constraint.kind === "coincident") {
        const otherIndex = 1 - index;
        const where = pointOf(constraint.entityIds[otherIndex] ?? "", points[otherIndex]);
        const side = where === undefined ? undefined : sides.lines.map((line) => ({ line, gap: distanceToLine(where, line) })).sort((a, b) => a.gap - b.gap)[0];
        if (side === undefined || side.gap > 1e-6) { ok = false; return; }
        entityIds[index] = side.line.id;
        points[index] = "curve";
      } else ok = false;
    });
    if (!ok || (entityIds.length === 2 && entityIds[0] === entityIds[1])) { lost.push(constraint); continue; }
    addConstraints.push({ ...constraint, id: context.newId("constraint"), entityIds, points });
  }
  return { addEntities, addConstraints, lost };
}
