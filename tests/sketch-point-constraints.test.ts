import type { SketchEntity, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, constraintFit, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id, kind: "line", start, end, construction: false });

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-point-constraints");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

function addConstraint(project: WorkbenchProject, constraint: WorkbenchSketchConstraint) {
  return applyWorkbenchOperation(project, { kind: "add-sketch-constraint", operationId: `operation:test-${constraint.id.replace(/[^a-z0-9]/gu, "-")}`, expectedRevision: project.revision, constraint });
}

export const sketchPointConstraintTests: readonly TestCase[] = [
  {
    name: "Coincident joins two line endpoints: the second point moves onto the first and the rest of the line keeps its place",
    run: () => {
      const project = projectWith([line("entity:a", [0, 0], [10, 0]), line("entity:b", [14, 3], [20, 9])]);
      const joined = addConstraint(project, { id: "constraint:join", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] });
      assert(joined.ok, `the endpoints join: ${joined.ok ? "" : joined.diagnostics[0]?.message ?? ""}`);
      const b = joined.value.project.sketch.entities.find((entity) => entity.id === "entity:b");
      assert(b?.kind === "line", "line B exists");
      near(b.start[0], 10, 1e-9, "B's start moved to A's end (x)");
      near(b.start[1], 0, 1e-9, "B's start moved to A's end (y)");
      near(b.end[0], 20, 1e-9, "B's far end stayed (x)");
      near(b.end[1], 9, 1e-9, "B's far end stayed (y)");
      const a = joined.value.project.sketch.entities.find((entity) => entity.id === "entity:a");
      assert(a?.kind === "line" && a.end[0] === 10 && a.end[1] === 0, "A did not move");
    }
  },
  {
    name: "Coincident also joins a line end to a circle centre and to a point entity, and Midpoint centres a point on a line",
    run: () => {
      const entities: SketchEntity[] = [
        line("entity:l", [0, 0], [20, 0]),
        { id: "entity:c", kind: "circle", center: [4, 9], radiusMm: 2, construction: false },
        { id: "entity:p", kind: "point", point: [30, 12], construction: false }
      ];
      const project = projectWith(entities);
      const centred = addConstraint(project, { id: "constraint:mid", kind: "midpoint", entityIds: ["entity:c", "entity:l"], points: ["center"] });
      assert(centred.ok, `the circle centre goes to the line midpoint: ${centred.ok ? "" : centred.diagnostics[0]?.message ?? ""}`);
      const circle = centred.value.project.sketch.entities.find((entity) => entity.id === "entity:c");
      assert(circle?.kind === "circle", "circle exists");
      near(circle.center[0], 10, 1e-9, "centre x is the line midpoint");
      near(circle.center[1], 0, 1e-9, "centre y is the line midpoint");
      near(circle.radiusMm, 2, 1e-9, "the radius is untouched");

      const pointJoined = addConstraint(centred.value.project, { id: "constraint:pt", kind: "coincident", entityIds: ["entity:l", "entity:p"], points: ["end", "self"] });
      assert(pointJoined.ok, `a point entity joins a line end: ${pointJoined.ok ? "" : pointJoined.diagnostics[0]?.message ?? ""}`);
      const point = pointJoined.value.project.sketch.entities.find((entity) => entity.id === "entity:p");
      assert(point?.kind === "point" && Math.abs(point.point[0] - 20) < 1e-9 && Math.abs(point.point[1]) < 1e-9, "the point entity moved onto the line end");
    }
  },
  {
    name: "a Midpoint of a shifted line follows the line when the line is resized",
    run: () => {
      const project = projectWith([line("entity:l", [0, 0], [20, 0]), { id: "entity:c", kind: "circle", center: [10, 0], radiusMm: 2, construction: false }], [
        { id: "constraint:mid", kind: "midpoint", entityIds: ["entity:c", "entity:l"], points: ["center"] }
      ]);
      const resized = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: "operation:test-resize-mid", expectedRevision: 0, entityId: "entity:l", dimension: "length", valueMm: 40 });
      assert(resized.ok, `the line is resized: ${resized.ok ? "" : resized.diagnostics[0]?.message ?? ""}`);
      const l = resized.value.project.sketch.entities.find((entity) => entity.id === "entity:l");
      const c = resized.value.project.sketch.entities.find((entity) => entity.id === "entity:c");
      assert(l?.kind === "line" && c?.kind === "circle", "both entities exist");
      near(c.center[0], (l.start[0] + l.end[0]) / 2, 1e-9, "the circle centre stays at the line's midpoint (x)");
      near(c.center[1], (l.start[1] + l.end[1]) / 2, 1e-9, "the circle centre stays at the line's midpoint (y)");
    }
  },
  {
    name: "points that the solver cannot move are recorded with a reason instead of being approximated",
    run: () => {
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 0], mid: [7, 7], end: [0, 10], construction: false };
      const project = projectWith([line("entity:l", [30, 0], [40, 5]), arc]);
      const recorded = addConstraint(project, { id: "constraint:arc-end", kind: "coincident", entityIds: ["entity:l", "entity:arc"], points: ["start", "end"] });
      assert(recorded.ok, "the relation is still recorded");
      assert(/Arc end points cannot be joined yet/.test(recorded.value.summary), `the summary explains why: ${recorded.value.summary}`);
      const before = project.sketch.entities.find((entity) => entity.id === "entity:l");
      const after = recorded.value.project.sketch.entities.find((entity) => entity.id === "entity:l");
      assert(JSON.stringify(before) === JSON.stringify(after), "nothing moved");
    }
  },
  {
    name: "the rule table knows which points can be joined",
    run: () => {
      equal(constraintFit("coincident", ["line", "line"], ["end", "start"]).ok, true, "line ends join");
      equal(constraintFit("coincident", ["line", "circle"], ["start", "center"]).ok, true, "a line end joins a circle centre");
      equal(constraintFit("coincident", ["line", "line"], ["mid", "start"]).ok, true, "a line midpoint can be joined");
      equal(constraintFit("coincident", ["line", "arc"], ["end", "end"]).ok, false, "an arc end cannot");
      equal(constraintFit("coincident", ["line", "rectangle"], ["end", "corner" as never]).ok, false, "a rectangle corner cannot");
      equal(constraintFit("coincident", ["circle", "circle"], ["start" as never, "center"]).ok, false, "a circle has no start point");
      equal(constraintFit("coincident", ["line", "line"]).ok, false, "without the points there is nothing to join");
      equal(constraintFit("coincident", ["line"], ["start"]).ok, false, "one point cannot be coincident");
      equal(constraintFit("midpoint", ["circle", "line"], ["center"]).ok, true, "a circle centre can sit at a line's midpoint");
      equal(constraintFit("midpoint", ["circle", "circle"], ["center"]).ok, false, "the second entity must be a line");
    }
  },
  {
    name: "point references are validated when a project is loaded",
    run: () => {
      const good = projectWith([line("entity:a", [0, 0], [10, 0]), line("entity:b", [10, 0], [20, 5])], [
        { id: "constraint:join", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] }
      ]);
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(good)));
      assert(reloaded.ok, "a project with point references round-trips");
      const withPoints = (constraint: Record<string, unknown>) => validateWorkbenchProject({ ...JSON.parse(JSON.stringify(good)), sketch: { ...JSON.parse(JSON.stringify(good.sketch)), constraints: [constraint] } });
      assert(!withPoints({ id: "constraint:bad-ref", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "teapot"] }).ok, "an unknown point reference is refused");
      assert(!withPoints({ id: "constraint:bad-kind", kind: "horizontal", entityIds: ["entity:a"], points: ["start"] }).ok, "only Coincident and Midpoint take point references");
      assert(!withPoints({ id: "constraint:too-many", kind: "midpoint", entityIds: ["entity:a", "entity:b"], points: ["start", "end", "mid"] }).ok, "more points than entities is refused");
      assert(!withPoints({ id: "constraint:not-array", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: "end" }).ok, "points must be a list");
    }
  },
  {
    name: "a Coincident joint removes two degrees of freedom in the analysis",
    run: () => {
      const loose = projectWith([line("entity:a", [0, 0], [10, 0]), line("entity:b", [10, 0], [20, 5])]);
      const joined = projectWith(loose.sketch.entities, [{ id: "constraint:join", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] }]);
      const before = analyzeWorkbenchSketch(loose.sketch).degreesOfFreedom;
      const after = analyzeWorkbenchSketch(joined.sketch).degreesOfFreedom;
      equal(before - after, 2, "joining two points takes two degrees of freedom away");
    }
  },
  {
    name: "a joint takes one degree of freedom from each curve, and a Fixed partner passes its share on to the free one",
    run: () => {
      const entities = [line("entity:a", [0, 0], [10, 0]), line("entity:b", [10, 0], [20, 5])];
      const joint: WorkbenchSketchConstraint = { id: "constraint:join", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] };
      const shared = analyzeWorkbenchSketch(projectWith(entities, [joint]).sketch);
      equal(shared.entityFreedom["entity:a"], 3, "the first curve loses one");
      equal(shared.entityFreedom["entity:b"], 3, "the second curve loses one");
      const pinned = analyzeWorkbenchSketch(projectWith(entities, [{ id: "constraint:fix", kind: "fixed", entityIds: ["entity:a"] }, joint]).sketch);
      equal(pinned.entityFreedom["entity:a"], 0, "a Fixed curve has nothing left");
      equal(pinned.entityFreedom["entity:b"], 2, "its partner takes the whole joint, so the joined end is pinned");
      equal(pinned.degreesOfFreedom, 2, "the total is the free end only");
    }
  }
];
