import type { SketchEntity, Vec2, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { autoConstraintsFor, dropConstraintFor, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-auto").sketch, entities, constraints: [] };
}

let counter = 0;
const newId = (): string => `constraint:auto-${(counter += 1)}`;

/** Draws a line the way the canvas does: infer each point from the sketch (the second one also from the first). */
function draw(sketch: WorkbenchSketch, first: Vec2, second: Vec2, tolerance = 1) {
  const startInference = inferSketchPoint(first, sketch, { toleranceMm: tolerance });
  const endInference = inferSketchPoint(second, sketch, { toleranceMm: tolerance, anchor: startInference.point });
  const placed: readonly PlacedPointInference[] = [
    { point: startInference.point, ...(startInference.primary === undefined ? {} : { primary: startInference.primary }), guides: startInference.guides },
    { point: endInference.point, ...(endInference.primary === undefined ? {} : { primary: endInference.primary }), guides: endInference.guides, anchor: startInference.point }
  ];
  const built = buildSketchEntity("line", [startInference.point, endInference.point], "entity:new");
  assert(built.ok, "the line builds");
  return { entity: built.value, constraints: autoConstraintsFor({ tool: "line", entity: built.value, placed, sketch, newId }) };
}

function kinds(constraints: readonly { readonly kind: string }[]): string {
  return constraints.map((constraint) => constraint.kind).sort().join(",");
}

export const sketchAutoConstraintTests: readonly TestCase[] = [
  {
    name: "a line that starts on another line's end is Coincident with it, and the existing point is the one that stays",
    run: () => {
      const sketch = sketchOf([line("entity:a", [0, 0], [10, 0])]);
      const { constraints } = draw(sketch, [10.2, 0.1], [20, 12]);
      equal(kinds(constraints), "coincident", "one coincident relation");
      const joint = constraints[0]!;
      equal(joint.entityIds.join(","), "entity:a,entity:new", "the existing entity is listed first");
      equal(joint.points?.join(","), "end,start", "A's end joins the new line's start");
    }
  },
  {
    name: "both ends of a line can snap: a bridge between two lines is Coincident at each end",
    run: () => {
      const sketch = sketchOf([line("entity:a", [0, 0], [10, 0]), line("entity:b", [30, 20], [40, 20])]);
      const { constraints } = draw(sketch, [10, 0], [30.1, 19.9]);
      equal(kinds(constraints), "coincident,coincident", "a joint at each end");
      const targets = constraints.map((constraint) => `${constraint.entityIds[0]}:${constraint.points?.join("/")}`).sort();
      equal(targets.join(" "), "entity:a:end/start entity:b:start/end", "start joins A's end, end joins B's start");
    }
  },
  {
    name: "a circle drawn from an existing centre or end is Coincident there, and a point on a line's middle is a Midpoint",
    run: () => {
      const sketch = sketchOf([circle("entity:c", [50, 50], 10), line("entity:l", [0, 0], [40, 0])]);
      const onCentre = inferSketchPoint([50.2, 49.9], sketch, { toleranceMm: 1 });
      const built = buildSketchEntity("circle", [onCentre.point, [60, 50]], "entity:new");
      assert(built.ok, "the circle builds");
      const concentric = autoConstraintsFor({ tool: "circle", entity: built.value, placed: [{ point: onCentre.point, ...(onCentre.primary === undefined ? {} : { primary: onCentre.primary }) }, { point: [60, 50] }], sketch, newId });
      equal(kinds(concentric), "coincident", "the new circle shares the existing centre");
      equal(concentric[0]?.points?.join(","), "center,center", "centre to centre");

      const onMiddle = inferSketchPoint([20.3, 0.2], sketch, { toleranceMm: 1 });
      const second = buildSketchEntity("circle", [onMiddle.point, [20, 8]], "entity:mid");
      assert(second.ok, "the second circle builds");
      const midpoint = autoConstraintsFor({ tool: "circle", entity: second.value, placed: [{ point: onMiddle.point, ...(onMiddle.primary === undefined ? {} : { primary: onMiddle.primary }) }, { point: [20, 8] }], sketch, newId });
      equal(kinds(midpoint), "midpoint", "a centre on a line's middle is a Midpoint relation");
      equal(midpoint[0]?.entityIds.join(","), "entity:mid,entity:l", "the new circle is the point, the line is the line");
    }
  },
  {
    name: "a line that follows a level or plumb guide from its start is Horizontal or Vertical",
    run: () => {
      const empty = sketchOf([]);
      const level = draw(empty, [10, 10], [60, 10.4]);
      equal(kinds(level.constraints), "horizontal", "level with its own start");
      const plumb = draw(empty, [10, 10], [10.3, 70]);
      equal(kinds(plumb.constraints), "vertical", "plumb with its own start");
      // Lining up with some other point is not a relation of the line to its own start.
      const other = sketchOf([line("entity:ref", [100, 50], [140, 50])]);
      const aligned = draw(other, [10, 10], [60, 50.4]);
      equal(kinds(aligned.constraints), "", "aligned with an unrelated point records nothing");
      const free = draw(empty, [10, 10], [80, 45]);
      equal(kinds(free.constraints), "", "a free line has no relations");
    }
  },
  {
    name: "a line that ends on a perpendicular or tangent hint is Perpendicular or Tangent to that curve",
    run: () => {
      const wall = sketchOf([line("entity:wall", [0, 0], [100, 0])]);
      const perpendicular = draw(wall, [40, 30], [40.3, 0.4]);
      equal(kinds(perpendicular.constraints), "perpendicular", "ending at the foot of a perpendicular");
      equal(perpendicular.constraints[0]?.entityIds.join(","), "entity:new,entity:wall", "between the new line and the wall");

      const ring = sketchOf([circle("entity:ring", [0, 0], 10)]);
      const tangent = draw(ring, [20, 4], [3.1, 9.5]);
      equal(kinds(tangent.constraints), "tangent", "ending at the tangent point of a circle");
    }
  },
  {
    name: "arc ends and rectangle corners are joined now that the solver moves them, and hints that are not relations produce no constraints",
    run: () => {
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 0], mid: [7.07, 7.07], end: [0, 10], construction: false };
      const rect: SketchEntity = { id: "entity:rect", kind: "rectangle", center: [60, 60], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const sketch = sketchOf([arc, rect]);
      const onArcEnd = draw(sketch, [10, 0], [30, 30]).constraints;
      equal(kinds(onArcEnd), "coincident", "a line starting on an arc end is joined to it");
      equal(onArcEnd[0]?.points?.join(","), "start,start", "the arc's start meets the new line's start");
      const onCorner = draw(sketch, [50, 55], [30, 30]).constraints;
      equal(kinds(onCorner), "coincident", "a line starting on a rectangle corner is joined to it");
      equal(onCorner[0]?.points?.join(","), "corner-0,start", "the rectangle's lower left corner meets the new line's start");
      equal(kinds(draw(sketchOf([]), [5, 5], [40, 25.2], 0.5).constraints), "", "empty canvas: nothing to relate to");
    }
  },
  {
    name: "auto-constraints are accepted together with their shape in one edit and the sketch stays solved",
    run: () => {
      const base = createWorkbenchProject("project:test-auto-apply");
      const project: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities: [line("entity:a", [0, 0], [10, 0])], constraints: [] } };
      const { entity, constraints } = draw(project.sketch, [10.2, 0.2], [20, 0.3]);
      equal(kinds(constraints), "coincident,collinear", "the new line joins A and continues it (collinear, which also keeps it level with A)");
      const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: "operation:test-auto-line", expectedRevision: 0, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: constraints, label: "Added a line" });
      assert(applied.ok, `the shape and its relations apply in one edit: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
      equal(applied.value.project.sketch.constraints.length, constraints.length, "the relations are recorded");
      const added = applied.value.project.sketch.entities.find((candidate) => candidate.id === "entity:new");
      assert(added?.kind === "line" && added.start[0] === 10 && added.start[1] === 0, "the new line starts exactly on A's end");
    }
  },
  {
    name: "dropping a dragged end on another end joins them, dropping a centre on a line middle makes a Midpoint, and nothing is repeated",
    run: () => {
      const sketch = sketchOf([line("entity:a", [0, 0], [10, 0]), line("entity:b", [30, 5], [40, 9]), circle("entity:c", [60, 60], 5)]);
      const dragged = sketch.entities.find((entity) => entity.id === "entity:b")!;
      const onEnd = inferSketchPoint([10.2, 0.1], sketch, { toleranceMm: 1, excludeEntityIds: ["entity:b"] });
      const joined = dropConstraintFor({ entity: dragged, ref: "start", primary: onEnd.primary, sketch, newId });
      equal(joined?.kind, "coincident", "an end dropped on an end is Coincident");
      equal(joined?.entityIds.join(","), "entity:a,entity:b", "the target is listed first");
      equal(joined?.points?.join(","), "end,start", "A's end and B's start");
      const again = dropConstraintFor({ entity: dragged, ref: "start", primary: onEnd.primary, sketch: { ...sketch, constraints: [joined!] }, newId });
      equal(again, undefined, "an existing joint is not repeated");
      const circleEntity = sketch.entities.find((entity) => entity.id === "entity:c")!;
      const onMiddle = inferSketchPoint([5.2, 0.2], sketch, { toleranceMm: 1, excludeEntityIds: ["entity:c"] });
      const centred = dropConstraintFor({ entity: circleEntity, ref: "center", primary: onMiddle.primary, sketch, newId });
      equal(centred?.kind, "midpoint", "a centre dropped on a line middle is a Midpoint");
      const onCurve = inferSketchPoint([7.3, 0.2], sketch, { toleranceMm: 1, excludeEntityIds: ["entity:c"] });
      equal(dropConstraintFor({ entity: circleEntity, ref: "center", primary: onCurve.primary, sketch, newId }), undefined, "a point on a curve is not a relation");
      equal(dropConstraintFor({ entity: dragged, ref: "start", primary: undefined, sketch, newId }), undefined, "dropping on nothing adds nothing");
    }
  }
];
