import { assert, near, type TestCase } from "./test-kit.js";
import { circ, fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";

export const pipelineTangentTests: readonly TestCase[] = [
  {
    name: "P26 (changed by wave 3 R2-6) a tangent relation between far-apart geometry moves the circle and keeps its radius, and says so, instead of resizing it or refusing",
    run: () => {
      let project = fresh();
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("l1", [0, 0], [10, 0]), circ("c1", 30, 30, 5), circ("c2", 50, 10, 3)], addConstraints: [], label: "Draw" });
      const far = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:t1", kind: "tangent", entityIds: ["entity:l1", "entity:c1"] } });
      // Wave 3 R2-6: a routine Tangent is no longer refused when the geometry is far apart; the circle keeps its radius and travels to the contact.
      assert(far.ok, `a line and a circle 25 mm apart are made tangent by moving the circle, not refused: ${far.ok ? "" : message(far)}`);
      const farCircle = far.ok ? far.value.project.sketch.entities.find((entity) => entity.id === "entity:c1") : undefined;
      assert(farCircle?.kind === "circle" && farCircle.radiusMm === 5, "and the circle is still 5 mm");
      assert(far.ok && farCircle?.kind === "circle" && Math.abs(farCircle.center[1] - 5) < 1e-9, "its centre is now one radius above the line");
      assert(far.ok && /Circle [0-9]+ is far from Line [0-9]+/u.test(far.value.summary) && /radius stays 5 mm/u.test(far.value.summary), `the status explains it with names: ${far.ok ? far.value.summary : ""}`);
      const circles = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:t2", kind: "tangent", entityIds: ["entity:c1", "entity:c2"] } });
      assert(circles.ok, `two far circles are treated the same way: ${circles.ok ? "" : message(circles)}`);
      const still = circles.ok ? circles.value.project.sketch.entities.find((entity) => entity.id === "entity:c2") : undefined;
      assert(still?.kind === "circle" && still.radiusMm === 3, "the second circle keeps its 3 mm radius");
      // The original project is untouched.
      const unchanged = project.sketch.entities.find((entity) => entity.id === "entity:c1");
      assert(unchanged?.kind === "circle" && unchanged.radiusMm === 5, "the project the operation started from keeps the circle at radius 5");

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
