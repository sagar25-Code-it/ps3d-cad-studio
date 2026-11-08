import { assert, near, type TestCase } from "./test-kit.js";
import { circ, fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";

export const pipelineTangentTests: readonly TestCase[] = [
  {
    name: "P26 a tangent relation between far-apart geometry is reported instead of silently resizing the circle",
    run: () => {
      let project = fresh();
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("l1", [0, 0], [10, 0]), circ("c1", 30, 30, 5), circ("c2", 50, 10, 3)], addConstraints: [], label: "Draw" });
      const far = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:t1", kind: "tangent", entityIds: ["entity:l1", "entity:c1"] } });
      assert(!far.ok, "a line and a circle 25 mm apart are not quietly made tangent by growing the circle to 30 mm");
      assert(/c1/u.test(message(far)) && /from radius 5 mm to/u.test(message(far)) && /far apart/u.test(message(far)), `the report names the circle and both radii: ${message(far)}`);
      assert(far.ok === false && far.diagnostics[0]!.recovery.includes("dimension the radius"), "and says what to do");
      const circles = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:t2", kind: "tangent", entityIds: ["entity:c1", "entity:c2"] } });
      assert(!circles.ok && /would resize/u.test(message(circles)), `two far circles are reported the same way: ${message(circles)}`);
      // The radius is untouched in the project that was refused.
      const unchanged = project.sketch.entities.find((entity) => entity.id === "entity:c1");
      assert(unchanged?.kind === "circle" && unchanged.radiusMm === 5, "the refused operation leaves the circle at radius 5");

      // A circle a hair away from the line is still pulled tangent: that is what the relation is for.
      let close = fresh();
      close = pipelineRun(close, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("l1", [0, 0], [10, 0]), circ("c1", 5, 5.3, 5)], addConstraints: [], label: "Draw" });
      const snug = pipelineApply(close, { kind: "add-sketch-constraint", constraint: { id: "constraint:t3", kind: "tangent", entityIds: ["entity:l1", "entity:c1"] } });
      assert(snug.ok, `a small gap closes: ${message(snug)}`);

      // A dimensioned radius holds the circle, so the far line is the one that moves, as before.
      let held = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("l1", [0, 0], [10, 0]), circ("c1", 30, 30, 5)], addConstraints: [], label: "Draw" });
      held = pipelineRun(held, { kind: "set-sketch-dimension", entityId: "entity:c1", dimension: "radius", valueMm: 5 });
      const moved = pipelineApply(held, { kind: "add-sketch-constraint", constraint: { id: "constraint:t4", kind: "tangent", entityIds: ["entity:l1", "entity:c1"] } });
      assert(moved.ok, `with its radius dimensioned the circle keeps 5 mm and the line moves: ${message(moved)}`);
      const kept = moved.ok ? moved.value.project.sketch.entities.find((entity) => entity.id === "entity:c1") : undefined;
      near(kept?.kind === "circle" ? kept.radiusMm : 0, 5, 1e-9, "the radius is 5 mm after the solve");
    }
  }
];
