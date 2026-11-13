import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SKETCH_ORIGIN_ID, constraintFit, createWorkbenchProject, describeConstraint, dragLiveSketch, entityNames, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { layoutConstraintGlyphs } from "../packages/workbench-sketch/src/constraint-glyph-layout.js";
import { constraintToolStep, type ConstraintToolPick } from "../packages/workbench-sketch/src/constraint-tool.js";
import { ORIGIN_RELATION_POINT } from "../packages/workbench-sketch/src/relation-points.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { circ, fresh, line, message, pipelineApply, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Horizontal and Vertical between two points: a hole centre level with the origin, a line end straight above a corner. The relation is
 * stored as `horizontal` / `vertical` with two curves and one point of each; the one-curve form (a level line) is unchanged.
 */

function sketchOf(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: constraints, label: "Draw" });
}

const circleOf = (project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "circle" }> => {
  const found = project.sketch.entities.find((entity) => entity.id === id);
  assert(found?.kind === "circle", `${id} is a circle`);
  return found;
};

const noop = (): undefined => undefined;

export const sketchLevelPointsTests: readonly TestCase[] = [
  {
    name: "Horizontal / Vertical fit: one line or rectangle, or two points (the origin can be one); a circle alone, a missing point or a curve reference is refused",
    run: () => {
      assert(constraintFit("horizontal", ["line"]).ok && constraintFit("vertical", ["rectangle"]).ok, "the one-curve form is unchanged");
      assert(constraintFit("horizontal", ["origin", "circle"], ["self", "center"]).ok, "the origin and a circle centre");
      assert(constraintFit("vertical", ["line", "rectangle"], ["end", "corner-2"]).ok, "a line end and a rectangle corner");
      assert(constraintFit("horizontal", ["arc", "point"], ["mid", "self"]).ok, "an arc midpoint and a sketch point");
      const noPoints = constraintFit("horizontal", ["line", "circle"]);
      assert(!noPoints.ok && /point on each/u.test(noPoints.reason), `two curves without points: ${noPoints.reason}`);
      assert(!constraintFit("horizontal", ["line", "circle"], ["end", "curve"]).ok, "a curve is not a point");
      assert(!constraintFit("vertical", ["origin", "origin"], ["self", "self"]).ok, "the origin with itself");
      const circle = constraintFit("horizontal", ["circle"]);
      assert(!circle.ok && /two points/u.test(circle.reason), `a circle alone says what it takes: ${circle.reason}`);
      assert(!constraintFit("horizontal", ["spline", "line"], ["start", "end"]).ok, "a spline end is not solved");
    }
  },
  {
    name: "Horizontal between the origin and a hole centre drops the hole onto the origin's level, takes one degree of freedom, and survives a drag, save and reload",
    run: () => {
      const start = sketchOf([circ("hole", 30, 12, 4)]);
      equal(analyzeWorkbenchSketch(start.sketch).degreesOfFreedom, 3, "a free circle");
      const relation: WorkbenchSketchConstraint = { id: "constraint:level", kind: "horizontal", entityIds: [SKETCH_ORIGIN_ID, "entity:hole"], points: ["self", "center"] };
      const levelled = pipelineRun(start, { kind: "add-sketch-constraint", constraint: relation });
      const hole = circleOf(levelled, "entity:hole");
      near(hole.center[1], 0, 1e-7, "the centre is level with the origin");
      near(hole.center[0], 30, 1e-7, "and did not slide sideways");
      near(hole.radiusMm, 4, 1e-9, "the size is kept");
      const analysis = analyzeWorkbenchSketch(levelled.sketch);
      equal(`${analysis.classification}:${analysis.degreesOfFreedom}`, "underconstrained:2", "one freedom gone, nothing conflicts");
      equal(describeConstraint(relation, entityNames(levelled.sketch)), "Horizontal: the origin level with Circle 1 centre", "it reads as what it does");
      // Dragging the hole keeps it level.
      const dragged = dragLiveSketch(levelled.sketch, { entityId: "entity:hole", point: "center", positionMm: [55, 9] });
      assert(dragged.ok, `the drag solves: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const moved = dragged.entities.find((entity) => entity.id === "entity:hole");
      assert(moved?.kind === "circle", "still a circle");
      near(moved.center[1], 0, 1e-6, "it stays level while dragged");
      near(moved.center[0], 55, 1e-6, "and follows the pointer along X");
      // Save and reload.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(levelled));
      assert(reloaded.ok, "reloads");
      if (!reloaded.ok) return;
      equal(JSON.stringify(reloaded.value.sketch.constraints.find((constraint) => constraint.id === "constraint:level")), JSON.stringify(relation), "the relation is stored as written");
      equal(analyzeWorkbenchSketch(reloaded.value.sketch).degreesOfFreedom, 2, "and still holds");
      // Deleting it (what Delete on its glyph does) frees the hole; the project before the add is what Undo returns to.
      equal(analyzeWorkbenchSketch(pipelineRun(levelled, { kind: "delete-sketch-constraint", constraintId: "constraint:level" }).sketch).degreesOfFreedom, 3, "deleting it gives the freedom back");
      near(circleOf(start, "entity:hole").center[1], 12, 1e-12, "the earlier project is untouched");
    }
  },
  {
    name: "Vertical between a rectangle corner and a line end moves the second pick straight above the first; both together make the points meet",
    run: () => {
      const start = sketchOf([rect("plate", 0, 0, 40, 20), line("rib", [35, 30], [60, 50])]);
      const stacked = pipelineRun(start, { kind: "add-sketch-constraint", constraint: { id: "constraint:stack", kind: "vertical", entityIds: ["entity:plate", "entity:rib"], points: ["corner-2", "start"] } });
      const rib = stacked.sketch.entities.find((entity) => entity.id === "entity:rib");
      const plate = stacked.sketch.entities.find((entity) => entity.id === "entity:plate");
      assert(rib?.kind === "line" && plate?.kind === "rectangle", "both are still there");
      near(rib.start[0], 20, 1e-6, "the line start is above the corner at x = 20");
      near(rib.start[1], 30, 1e-6, "at the height it had");
      assert(plate.center[0] === 0 && plate.widthMm === 40, "the first pick stayed");
      const both = pipelineRun(stacked, { kind: "add-sketch-constraint", constraint: { id: "constraint:level", kind: "horizontal", entityIds: ["entity:plate", "entity:rib"], points: ["corner-2", "start"] } });
      const met = both.sketch.entities.find((entity) => entity.id === "entity:rib");
      assert(met?.kind === "line", "line");
      near(met.start[0], 20, 1e-6, "x");
      near(met.start[1], 10, 1e-6, "level and stacked: the start sits on the corner");
      equal(analyzeWorkbenchSketch(both.sketch).conflicts.length, 0, "Horizontal and Vertical between the same two points do not conflict");
      // Two points of one curve are refused with a reason; a level line is the one-curve form.
      const same = pipelineApply(start, { kind: "add-sketch-constraint", constraint: { id: "constraint:same", kind: "horizontal", entityIds: ["entity:rib", "entity:rib"], points: ["start", "end"] } });
      assert(!same.ok && /same one was picked twice/u.test(message(same)), `two points of one line: ${message(same)}`);
      const one = pipelineRun(start, { kind: "add-sketch-constraint", constraint: { id: "constraint:flat", kind: "horizontal", entityIds: ["entity:rib"] } });
      const flat = one.sketch.entities.find((entity) => entity.id === "entity:rib");
      assert(flat?.kind === "line" && Math.abs(flat.end[1] - flat.start[1]) < 1e-7, "Horizontal on one line still levels the line");
    }
  },
  {
    name: "A Horizontal saved before (one line, no points) loads as it always did; points on the one-curve form are refused with the reason",
    run: () => {
      const project = sketchOf([line("a", [0, 0], [10, 0]), circ("hole", 30, 12, 4)], [{ id: "constraint:old", kind: "horizontal", entityIds: ["entity:a"] }]);
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok && reloaded.value.sketch.constraints.length === 1 && reloaded.value.sketch.constraints[0]!.points === undefined, "the one-curve form loads unchanged");
      if (!reloaded.ok) return;
      equal(JSON.stringify(reloaded.value.sketch.entities), JSON.stringify(project.sketch.entities), "with the same geometry");
      const onePoint = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:bad", kind: "horizontal", entityIds: ["entity:a"], points: ["start"] } });
      assert(!onePoint.ok && /two curves and one point of each/u.test(message(onePoint)), `one point is not a relation: ${message(onePoint)}`);
      const onCurve = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:bad2", kind: "vertical", entityIds: ["entity:a", "entity:hole"], points: ["end", "curve"] } });
      assert(!onCurve.ok, "a curve reference is not a point to line up");
    }
  },
  {
    name: "Level points tool: a line click levels the line at once; two point picks level the second with the first; the tool keeps going",
    run: () => {
      const lineClick: ConstraintToolPick = { entityId: "entity:a", kind: "line", label: "Line 1" };
      const one = constraintToolStep("horizontal", [], lineClick);
      assert(one.status === "ready" && one.constraint.kind === "horizontal" && one.constraint.entityIds.join() === "entity:a" && one.constraint.points === undefined, "a line is levelled with one click");
      equal(one.picks.length, 0, "and the tool starts over, still on");
      const origin: ConstraintToolPick = { entityId: ORIGIN_RELATION_POINT.entityId, kind: "origin", ref: "self", label: "Sketch origin" };
      const first = constraintToolStep("horizontal", [], origin);
      assert(first.status === "more" && first.picks.length === 1 && /pick the point/u.test(first.prompt), "the first point waits for a second");
      const circleClick = constraintToolStep("horizontal", first.picks, { entityId: "entity:hole", kind: "circle", label: "Circle 1" });
      assert(circleClick.status === "ready", "a click on a circle counts as its centre");
      if (circleClick.status !== "ready") return;
      equal(JSON.stringify(circleClick.constraint), JSON.stringify({ kind: "horizontal", entityIds: [SKETCH_ORIGIN_ID, "entity:hole"], points: ["self", "center"] }), "the relation names the origin and the centre");
      const again = constraintToolStep("horizontal", first.picks, origin);
      assert(again.status === "more" && again.picks.length === 0, "picking the same point again clears it");
      const sameCurve = constraintToolStep("vertical", [{ entityId: "entity:a", kind: "line", ref: "start", label: "Line 1 start" }], { entityId: "entity:a", kind: "line", ref: "end", label: "Line 1 end" });
      assert(sameCurve.status === "refused" && /click the line itself/u.test(sameCurve.message) && sameCurve.picks.length === 1, "two points of one line point at the one-click form");
      const arc = constraintToolStep("horizontal", [], { entityId: "entity:c", kind: "arc", label: "Arc 1" });
      assert(arc.status === "refused" && /line or rectangle, or to two points/u.test(arc.message), "an arc alone is refused with the rule");
    }
  },
  {
    name: "The glyph of a two-point Horizontal sits at the point that was lined up, and the inspector offers Level points and Stack points",
    run: () => {
      const entities: readonly SketchEntity[] = [circ("hole", 30, 0, 4), line("a", [0, 0], [10, 0])];
      const relation: WorkbenchSketchConstraint = { id: "constraint:level", kind: "horizontal", entityIds: [SKETCH_ORIGIN_ID, "entity:hole"], points: ["self", "center"] };
      const [glyph] = layoutConstraintGlyphs([relation], entities, { mmPerPx: 1 });
      assert(glyph !== undefined && glyph.anchor[0] === 30 && glyph.anchor[1] === 0 && glyph.label === "H", "anchored at the circle centre, not on its rim");
      const reversed = layoutConstraintGlyphs([{ ...relation, entityIds: ["entity:hole", SKETCH_ORIGIN_ID], points: ["center", "self"] }], entities, { mmPerPx: 1 })[0];
      assert(reversed !== undefined && reversed.anchor[0] === 30, "with the origin second it still sits at the real point");

      const project = createWorkbenchProject("project:level-ui");
      const base = {
        projectId: project.id, sketch: { ...project.sketch, entities, constraints: [relation] }, finishedSketches: [], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
        targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
        viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
      };
      const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
      const html = renderToStaticMarkup(createElement(SketchWorkspace, props as never));
      assert(html.includes("Level points") && html.includes("Stack points") && html.includes("Coincident") && html.includes("Midpoint"), "the four point relations are offered");
      assert(html.includes("Horizontal between two points: pick the point that stays"), "with what the pick order means");
    }
  },
];
