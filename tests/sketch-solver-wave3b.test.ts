import { dragLiveSketch } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { repairAll, validateSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { addConstraint, arc, get, line, projectWith, rel, type Arc, type Vec } from "./sketch-solver-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

/**
 * Wave 3 regression tests, second part (second re-audit: Curve creation tools F2 and F3, Constraint solver R2-8 and R2-10, Sketch
 * environment R2-6). Same rule as the first part: the re-audit repro through the real code path, then the outcome the audit asked for.
 */

function circleOf(a: Arc): { readonly c: Vec; readonly r: number } {
  const [ax, ay] = a.start;
  const [bx, by] = a.mid;
  const [cx, cy] = a.end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

/** The angle in degrees between the two radii at the point where arc `a` ends and arc `b` starts: 0 (or 180) when the joint is tangent. */
function jointKinkDeg(project: WorkbenchProject): number {
  const a = get(project, "ar", "arc");
  const b = get(project, "sim1", "arc");
  const first = circleOf(a);
  const second = circleOf(b);
  const p = a.end;
  const u: Vec = [(p[0] - first.c[0]) / first.r, (p[1] - first.c[1]) / first.r];
  const v: Vec = [(p[0] - second.c[0]) / second.r, (p[1] - second.c[1]) / second.r];
  const sin = Math.abs(u[0] * v[1] - u[1] * v[0]);
  return (Math.asin(Math.min(1, sin)) * 180) / Math.PI;
}

/** Arc (50,0)-(60,10)-(70,0) and the arc the Arc-tangent tool draws from its end to (90,-30): relations coincident and tangent. */
function tangentArcs(): WorkbenchProject {
  const centre: Vec = [102.5, 0];
  const radius = 32.5;
  const endAngle = (Math.atan2(-30, 90 - centre[0]) * 180) / Math.PI + 360;
  const midAngle = (180 + endAngle) / 2;
  const rad = (degrees: number): number => (degrees * Math.PI) / 180;
  const second = arc("sim1", [70, 0], [centre[0] + radius * Math.cos(rad(midAngle)), centre[1] + radius * Math.sin(rad(midAngle))], [90, -30]);
  return projectWith(
    [arc("ar", [50, 0], [60, 10], [70, 0]), second],
    [rel("coincident", ["ar", "sim1"], { points: ["end", "start"] }), rel("tangent", ["ar", "sim1"])]
  );
}

export const sketchSolverWave3bTests: readonly TestCase[] = [
  {
    name: "Wave3 F2: a tangent arc started on an arc end is not redundant: no over-defined warning, Fix all keeps the Tangent, and a drag keeps the joint tangent (was a 12.3 degree kink after Fix all deleted it)",
    run: () => {
      const project = tangentArcs();
      near(jointKinkDeg(project), 0, 0.01, "the drawn joint is tangent to begin with");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      assert(analysis.redundant.length === 0, `the analysis finds nothing redundant: ${analysis.redundant.map((entry) => entry.labels.join(" ; ")).join(" | ")}`);
      const context = { sketch: project.sketch, newId: (prefix: string) => `${prefix}:g1` };
      const report = validateSketch(context);
      assert(!report.issues.some((issue) => issue.category === "redundant"), `Validate Sketch raises no Over-defined issue: ${report.issues.map((issue) => issue.title).join(" | ")}`);
      const repaired = repairAll(context);
      assert(repaired.sketch.constraints.some((constraint) => constraint.kind === "tangent"), "Fix all keeps the Tangent");
      const arcOne = repaired.sketch.entities[0]!;
      assert(arcOne.kind === "arc", "the first entity is the arc");
      if (arcOne.kind !== "arc") return;
      const dragged = dragLiveSketch(repaired.sketch, { entityId: arcOne.id, point: "mid", positionMm: [arcOne.mid[0] + 4, arcOne.mid[1] + 6] });
      assert(dragged.ok, `the drag is accepted: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const after = { ...project, sketch: { ...repaired.sketch, entities: dragged.entities } };
      near(jointKinkDeg(after), 0, 0.01, "the joint is still tangent after the drag");
      const gap = Math.hypot(get(after, "ar", "arc").end[0] - get(after, "sim1", "arc").start[0], get(after, "ar", "arc").end[1] - get(after, "sim1", "arc").start[1]);
      near(gap, 0, 1e-6, "and still joined");
    }
  },
  {
    name: "Wave3 F2: a chain of three tangent arcs, and a tangent added later with the coincident already there, are not redundant either",
    run: () => {
      const base = tangentArcs();
      const third = arc("sim2", [90, -30], [100, -45], [120, -50]);
      const chain = projectWith([...base.sketch.entities, third], [...base.sketch.constraints, rel("coincident", ["sim1", "sim2"], { points: ["end", "start"] })]);
      const withTangent = addConstraint(chain, rel("tangent", ["sim1", "sim2"]));
      const analysis = analyzeWorkbenchSketch(withTangent.sketch);
      assert(analysis.redundant.length === 0, `no redundancy in a three-arc chain: ${analysis.redundant.map((entry) => entry.labels.join(" ; ")).join(" | ")}`);
      const bare = projectWith(base.sketch.entities, [rel("coincident", ["ar", "sim1"], { points: ["end", "start"] })]);
      const added = addConstraint(bare, rel("tangent", ["ar", "sim1"]));
      assert(analyzeWorkbenchSketch(added.sketch).redundant.length === 0, "adding the Tangent to joined arcs is not redundant");
      near(jointKinkDeg({ ...added, sketch: added.sketch }), 0, 0.01, "and makes the joint tangent");
      // A tangent that really is redundant (stated twice) is still found.
      const twice = projectWith(base.sketch.entities, [...base.sketch.constraints, rel("tangent", ["ar", "sim1"])]);
      assert(analyzeWorkbenchSketch(twice.sketch).redundant.length > 0, "a Tangent stated twice is still redundant");
    }
  }
];
