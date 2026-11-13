import { analyzeWorkbenchSketch, buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { autoConstraintsFor, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { LINE_ARC_DRAG_PIXELS, buildLineTangentArc, lineArcDragStart } from "../packages/workbench-sketch/src/line-arc-drag.js";
import { extendLineChain, reconcileLineChain, startLineChain } from "../packages/workbench-sketch/src/line-chain.js";
import { dragLiveSketch, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { fresh, line, pipelineRun } from "./pipeline-kit.js";
import { tangencyProblem } from "./sketch-shapes3-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Line, tangent arc, line without leaving the Line tool: a press on the chain's last point that is dragged draws an arc tangent to
 * the last segment, and the chain carries on from the arc's end.
 */

const endOf = (id: string, point: Vec2): PlacedPointInference => ({ point, primary: { kind: "endpoint", point, entityId: id, selector: "end", distanceMm: 0 } });

/** A sketch with one level line from the origin to (40, 0), as the Line tool leaves it after its first segment. */
function oneLine(): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("a", [0, 0], [40, 0])], addConstraints: [], label: "Line" });
}

const arcOf = (entities: readonly SketchEntity[], id: string): Extract<SketchEntity, { kind: "arc" }> => {
  const entity = entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "arc", `${id} is an arc`);
  return entity;
};

export const sketchLineArcDragTests: readonly TestCase[] = [
  {
    name: "Line tool: a press on the chain's last point can become a tangent arc; a press elsewhere, or with nothing to continue, is a click",
    run: () => {
      const sketch = oneLine().sketch;
      const tail = endOf("entity:a", [40, 0]);
      assert(LINE_ARC_DRAG_PIXELS >= 4 && LINE_ARC_DRAG_PIXELS <= 10, "a few pixels of travel separate a drag from a click");
      const onTail = lineArcDragStart({ pending: [[40, 0]], pendingInference: [tail], pressMm: [40.3, -0.2], press: { point: [40, 0] }, reachMm: 1, sketch });
      assert(onTail !== undefined, "a press on the last point starts the gesture");
      equal(onTail.entityId, "entity:a", "it continues the last line");
      near(onTail.direction[0], 1, 1e-12, "along the line, x");
      near(onTail.direction[1], 0, 1e-12, "along the line, y");
      equal(lineArcDragStart({ pending: [[40, 0]], pendingInference: [tail], pressMm: [55, 10], press: { point: [55, 10] }, reachMm: 1, sketch }), undefined, "a press away from the last point is an ordinary click");
      // The first point of a chain that started on empty canvas has no segment to be tangent to.
      equal(lineArcDragStart({ pending: [[5, 5]], pendingInference: [{ point: [5, 5] }], pressMm: [5, 5], press: { point: [5, 5] }, reachMm: 1, sketch }), undefined, "nothing to be tangent to");
      // With no chain running, a press on the end of an existing line starts one with an arc.
      const fromExisting = lineArcDragStart({ pending: [], pendingInference: [], pressMm: [40, 0], press: tail, reachMm: 1, sketch });
      assert(fromExisting !== undefined && fromExisting.entityId === "entity:a", "a press on an existing end can start with a tangent arc");
      equal(lineArcDragStart({ pending: [], pendingInference: [], pressMm: [10, 10], press: { point: [10, 10] }, reachMm: 1, sketch }), undefined, "a press on empty canvas with no chain is a click");
      const startSnap: PlacedPointInference = { point: [0, 0], primary: { kind: "endpoint", point: [0, 0], entityId: "entity:a", selector: "start", distanceMm: 0 } };
      const backwards = lineArcDragStart({ pending: [], pendingInference: [], pressMm: [0, 0], press: startSnap, reachMm: 1, sketch });
      assert(backwards !== undefined, "the start of a line works too");
      near(backwards.direction[0], -1, 1e-12, "and the arc leaves away from the line");
    }
  },
  {
    name: "Line, tangent arc, line: the dragged arc is joined and tangent to the line in one edit, and the next line starts on the arc's end",
    run: () => {
      let project = oneLine();
      const start = lineArcDragStart({ pending: [[40, 0]], pendingInference: [endOf("entity:a", [40, 0])], pressMm: [40, 0], press: { point: [40, 0] }, reachMm: 1, sketch: project.sketch });
      assert(start !== undefined, "the gesture starts");
      let serial = 0;
      const built = buildLineTangentArc({ start, end: { point: [60, 20] }, sketch: project.sketch, id: "entity:arc", newId: () => `constraint:arc-${serial += 1}` });
      assert(built.ok, "the arc builds");
      if (!built.ok) return;
      equal(built.value.entity.kind, "arc", "an ordinary arc");
      equal(built.value.constraints.map((relation) => `${relation.kind}:${relation.entityIds.join("+")}${relation.points === undefined ? "" : `:${relation.points.join("+")}`}`).join(" "), "coincident:entity:a+entity:arc:end+start tangent:entity:a+entity:arc", "joined to the line's end and tangent to the line");
      const before = project.revision;
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [built.value.entity], addConstraints: built.value.constraints, label: "Tangent arc" });
      equal(project.revision, before + 1, "one edit, so one Undo step");
      const arc = arcOf(project.sketch.entities, "entity:arc");
      near(arc.start[0], 40, 1e-9, "the arc starts on the line's end");
      near(arc.end[0], 60, 1e-9, "and ends where the drag was released, x");
      near(arc.end[1], 20, 1e-9, "y");
      equal(tangencyProblem(project.sketch), undefined, "the arc leaves the line without a kink");
      equal(analyzeWorkbenchSketch(project.sketch).conflicts.length, 0, "nothing conflicts");
      // The chain continues from the arc's end: the next line is joined to it by the same rule a line after a line follows.
      const next = buildSketchEntity("line", [arc.end, [60, 45]], "entity:b");
      assert(next.ok, "the next line builds");
      if (!next.ok) return;
      const joints = autoConstraintsFor({ tool: "line", entity: next.value, placed: [endOf("entity:arc", arc.end), { point: [60, 45], anchor: arc.end }], sketch: project.sketch, newId: () => `constraint:next-${serial += 1}` });
      assert(joints.some((relation) => relation.kind === "coincident" && relation.entityIds.join("+") === "entity:arc+entity:b" && relation.points?.join("+") === "end+start"), "the next line starts on the arc's end");
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [next.value], addConstraints: joints, label: "Line" });
      // Dragging the far end of the first line keeps the three pieces joined and the arc tangent.
      const moved = dragLiveSketch(project.sketch, { entityId: "entity:a", point: "start", positionMm: [-5, 4] });
      assert(moved.ok, `the drag solves: ${moved.ok ? "" : moved.message}`);
      if (moved.ok) {
        const a = moved.entities.find((entity) => entity.id === "entity:a");
        const movedArc = arcOf(moved.entities, "entity:arc");
        const b = moved.entities.find((entity) => entity.id === "entity:b");
        assert(a?.kind === "line" && b?.kind === "line", "both lines are there");
        if (a?.kind === "line" && b?.kind === "line") {
          near(Math.hypot(a.end[0] - movedArc.start[0], a.end[1] - movedArc.start[1]), 0, 1e-6, "line and arc still meet");
          near(Math.hypot(b.start[0] - movedArc.end[0], b.start[1] - movedArc.end[1]), 0, 1e-6, "arc and next line still meet");
        }
        equal(tangencyProblem({ ...project.sketch, entities: moved.entities }), undefined, "and the arc is still tangent");
      }
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "the project reloads");
      if (reloaded.ok) {
        equal(reloaded.value.sketch.entities.map((entity) => entity.kind).join(","), "line,arc,line", "line, arc, line after reload");
        assert(reloaded.value.sketch.constraints.some((relation) => relation.kind === "tangent"), "with the Tangent relation");
      }
    }
  },
  {
    name: "Line chain with an arc in it: Undo of the arc steps the chain back to the line's end; a drag straight ahead is refused with a reason",
    run: () => {
      const project = oneLine();
      const start = lineArcDragStart({ pending: [[40, 0]], pendingInference: [endOf("entity:a", [40, 0])], pressMm: [40, 0], press: { point: [40, 0] }, reachMm: 1, sketch: project.sketch });
      assert(start !== undefined, "the gesture starts");
      const built = buildLineTangentArc({ start, end: { point: [50, -10] }, sketch: project.sketch, id: "entity:arc", newId: () => "constraint:x" });
      assert(built.ok, "the arc builds below the line too");
      if (!built.ok) return;
      const withArc = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [built.value.entity], addConstraints: [], label: "Tangent arc" });
      const chain = extendLineChain(extendLineChain(startLineChain([0, 0]), "entity:a"), "entity:arc");
      const kept = reconcileLineChain(chain, withArc.sketch.entities);
      equal(kept.changed, false, "with the arc in the sketch the chain is unchanged");
      near(kept.pending[0]![0], 50, 1e-9, "its tail is the arc's end, x");
      near(kept.pending[0]![1], -10, 1e-9, "y");
      equal(kept.tailInference?.primary?.entityId, "entity:arc", "and the next segment joins the arc");
      // Undo removes the arc: the chain steps back to the end of the line.
      const undone = reconcileLineChain(chain, project.sketch.entities);
      equal(undone.changed, true, "the chain notices the arc is gone");
      equal(undone.chain.entityIds.join(","), "entity:a", "and keeps the line");
      near(undone.pending[0]![0], 40, 1e-9, "the tail is the line's end again");
      const straight = buildLineTangentArc({ start, end: { point: [70, 0] }, sketch: project.sketch, id: "entity:none", newId: () => "constraint:y" });
      assert(!straight.ok, "a release straight ahead would be a line, not an arc");
      if (!straight.ok) assert(/straight line/u.test(straight.diagnostics[0]?.message ?? ""), "and the message says so");
    }
  },
];
