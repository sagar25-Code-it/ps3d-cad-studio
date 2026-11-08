import type { SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, constraintFit, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { splineEndFrame, splineRadiusReport } from "../packages/workbench-core/src/spline-curvature.js";
import { analyzeWorkbenchSketch, sampleSpline } from "../packages/workbench-sketch/src/index.js";
import { entityRadiusReport, minimumRadiusCheck, nearestSmoothJoint, setSplineEndCurvature, setSplineTangent, splineTangentHandles } from "../packages/workbench-sketch/src/spline-helpers.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Vec = readonly [number, number];
type Spline = Extract<SketchEntity, { kind: "spline" }>;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function apply(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-wp-g2-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = apply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  assert(validateWorkbenchProject(result.value.project).ok, "the resulting project validates");
  return result.value.project;
}

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-wp-g2");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

const spline = (id: string, fitPoints: readonly Vec[]): Spline => ({ id: `entity:${id}`, kind: "spline", fitPoints, construction: false });
const line = (id: string, start: Vec, end: Vec): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });

function arcOf(id: string, radius: number, fromDeg: number, toDeg: number, clockwise = false): SketchEntity {
  const at = (deg: number): Vec => [radius * Math.cos((deg * Math.PI) / 180), radius * Math.sin((deg * Math.PI) / 180)];
  const mid = (fromDeg + toDeg) / 2;
  return { id: `entity:${id}`, kind: "arc", start: clockwise ? at(toDeg) : at(fromDeg), mid: at(mid), end: clockwise ? at(fromDeg) : at(toDeg), construction: false };
}

function splineOf(project: WorkbenchProject, id: string): Spline {
  const found = project.sketch.entities.find((entity) => entity.id === `entity:${id}`);
  if (found === undefined || found.kind !== "spline") throw new Error(`entity ${id} is not a spline`);
  return found;
}

/**
 * Position, unit tangent and signed curvature of the drawn spline at one end, found by finite differences of the polyline the
 * canvas actually draws (`sampleSpline`), so this check shares no code with the spline module. Direction: increasing fit-point order.
 */
function drawnEnd(fit: readonly Vec[], end: "start" | "end"): { readonly point: Vec; readonly tangent: Vec; readonly curvature: number } {
  const steps = 2000;
  const samples = sampleSpline(fit, steps);
  const h = 1 / steps;
  const q = end === "start" ? [0, 1, 2, 3].map((k) => samples[k]!) : [0, 1, 2, 3].map((k) => samples[samples.length - 1 - k]!);
  const sign = end === "start" ? 1 : -1;
  const d1: Vec = [sign * (-3 * q[0]![0] + 4 * q[1]![0] - q[2]![0]) / (2 * h), sign * (-3 * q[0]![1] + 4 * q[1]![1] - q[2]![1]) / (2 * h)];
  const d2: Vec = [(2 * q[0]![0] - 5 * q[1]![0] + 4 * q[2]![0] - q[3]![0]) / (h * h), (2 * q[0]![1] - 5 * q[1]![1] + 4 * q[2]![1] - q[3]![1]) / (h * h)];
  const speed = Math.hypot(d1[0], d1[1]);
  return { point: q[0]!, tangent: [d1[0] / speed, d1[1] / speed], curvature: (d1[0] * d2[1] - d1[1] * d2[0]) / speed ** 3 };
}

/** Curvature of a circle through three points, signed positive for a left turn. */
function threePointCurvature(a: Vec, b: Vec, c: Vec): number {
  const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
  return (2 * cross) / (ab * bc * ac);
}

const smooth = (id: string, first: string, second: string, points: readonly ("start" | "end")[]): WorkbenchSketchConstraint => ({ id: `constraint:${id}`, kind: "smooth", entityIds: [`entity:${first}`, `entity:${second}`], points });

/** Signed curvature and unit tangent of a neighbour curve at its joint, travelling toward the joint, from its own geometry. */
function neighbourTravel(entity: SketchEntity, ref: "start" | "end"): { readonly point: Vec; readonly tangent: Vec; readonly curvature: number } {
  if (entity.kind === "line") {
    const length = Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
    const along: Vec = [(entity.end[0] - entity.start[0]) / length, (entity.end[1] - entity.start[1]) / length];
    return ref === "end" ? { point: entity.end, tangent: along, curvature: 0 } : { point: entity.start, tangent: [-along[0], -along[1]], curvature: 0 };
  }
  if (entity.kind === "arc") {
    // Centre from the three points; direction of travel from the sign of the turn from start through mid to end.
    const [a, b, c] = [entity.start, entity.mid, entity.end];
    const curvature = threePointCurvature(a, b, c);
    const point = ref === "end" ? c : a;
    const toward = ref === "end" ? 1 : -1;
    // The tangent at an arc end: from the chord to the neighbouring sample on the arc, refined by the circle's own geometry.
    const radius = 1 / Math.abs(curvature);
    const turn = Math.sign(curvature);
    // Natural tangent at the end point of the arc, from the circle centre found by perpendicular bisectors.
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    const cx = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
    const cy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
    const radial: Vec = [(point[0] - cx) / radius, (point[1] - cy) / radius];
    const natural: Vec = turn > 0 ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
    return { point, tangent: [toward * natural[0], toward * natural[1]], curvature: toward * curvature };
  }
  if (entity.kind === "spline") {
    const frame = drawnEnd(entity.fitPoints, ref);
    return ref === "end" ? frame : { point: frame.point, tangent: [-frame.tangent[0], -frame.tangent[1]], curvature: -frame.curvature };
  }
  throw new Error("unsupported neighbour");
}

/** Position, tangent and curvature of the adapted spline at its joint, in the direction of travel away from the joint. */
function splineTravel(fit: readonly Vec[], ref: "start" | "end"): { readonly point: Vec; readonly tangent: Vec; readonly curvature: number } {
  const frame = drawnEnd(fit, ref);
  return ref === "start" ? frame : { point: frame.point, tangent: [-frame.tangent[0], -frame.tangent[1]], curvature: -frame.curvature };
}

function expectG2(project: WorkbenchProject, splineId: string, splineRef: "start" | "end", neighbour: SketchEntity, neighbourRef: "start" | "end", label: string): void {
  const adapted = splineOf(project, splineId);
  const away = splineTravel(adapted.fitPoints, splineRef);
  const toward = neighbourTravel(neighbour, neighbourRef);
  near(away.point[0], toward.point[0], 1e-9, `${label}: the ends meet (x)`);
  near(away.point[1], toward.point[1], 1e-9, `${label}: the ends meet (y)`);
  const cross = away.tangent[0] * toward.tangent[1] - away.tangent[1] * toward.tangent[0];
  const dot = away.tangent[0] * toward.tangent[0] + away.tangent[1] * toward.tangent[1];
  near(cross, 0, 1e-5, `${label}: the tangents are parallel`);
  assert(dot > 0.999, `${label}: the spline continues in the direction the neighbour arrives (dot ${dot})`);
  near(away.curvature, toward.curvature, 2e-4, `${label}: the curvature matches across the joint`);
}

const FIT: readonly Vec[] = [[1, 9], [6, 17], [14, 19], [22, 15], [28, 8], [30, 0]];

export const sketchG2WpTests: readonly TestCase[] = [
  {
    name: "a Smooth constraint blends a spline end into a line: same point, same tangent, zero curvature there",
    run: () => {
      const start = projectWith([line("l", [-20, 0], [0, 0]), spline("s", [[2, 3], [8, 12], [16, 14], [24, 10], [30, 2]])]);
      const before = neighbourTravel(start.sketch.entities[0]!, "end");
      const raw = splineTravel(splineOf(start, "s").fitPoints, "start");
      assert(Math.abs(raw.curvature - before.curvature) > 0.01, "before the constraint the curvature does not match (the test means something)");
      const project = run(start, { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "l", ["start", "end"]) });
      expectG2(project, "s", "start", start.sketch.entities[0]!, "end", "spline start to line end");
      near(drawnEnd(splineOf(project, "s").fitPoints, "start").curvature, 0, 2e-4, "the spline starts straight, like the line");
      equal(splineOf(project, "s").fitPoints.length, 5, "the spline kept its fit points");
      near(splineOf(project, "s").fitPoints[4]![0], 30, 1e-12, "the far end of the spline stayed where it was");
    }
  },
  {
    name: "Smooth matches the curvature of a counter-clockwise and a clockwise arc, at either end of the arc and either end of the spline",
    run: () => {
      for (const clockwise of [false, true]) {
        for (const arcRef of ["start", "end"] as const) {
          for (const splineRef of ["start", "end"] as const) {
            const arc = arcOf("a", 10, 0, 90, clockwise);
            const joint = arc.kind === "arc" ? (arcRef === "start" ? arc.start : arc.end) : [0, 0] as Vec;
            // A raw spline whose chosen end sits a little away from the joint, heading roughly outward.
            const fit: Vec[] = FIT.map((point) => [point[0] + joint[0] - 1, point[1] + joint[1] - 9] as Vec);
            const ordered = splineRef === "start" ? fit : [...fit].reverse();
            const project = run(projectWith([arc, spline("s", ordered)]), { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "a", [splineRef, arcRef]) });
            expectG2(project, "s", splineRef, arc, arcRef, `${clockwise ? "clockwise" : "counter-clockwise"} arc ${arcRef}, spline ${splineRef}`);
            const reported = neighbourTravel(arc, arcRef);
            near(Math.abs(reported.curvature), 0.1, 1e-9, "the arc's curvature is one over its radius");
            near(Math.abs(splineTravel(splineOf(project, "s").fitPoints, splineRef).curvature), 0.1, 2e-4, "so is the spline's at the joint");
          }
        }
      }
    }
  },
  {
    name: "the curve through the joint has a continuous radius: a three-point circle over the arc side, the joint and the spline side matches the arc radius",
    run: () => {
      const arc = arcOf("a", 10, 0, 90);
      const project = run(projectWith([arc, spline("s", FIT.map((point) => [point[0] - 1, point[1] + 1] as Vec))]), { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "a", ["start", "end"]) });
      const samples = sampleSpline(splineOf(project, "s").fitPoints, 6000);
      const delta = 0.03;
      // A point on the arc just before the joint, and the spline sample about the same distance after it.
      const angle = Math.PI / 2 - delta / 10;
      const before: Vec = [10 * Math.cos(angle), 10 * Math.sin(angle)];
      let after = samples[1]!;
      for (const sample of samples) { if (Math.hypot(sample[0] - 0, sample[1] - 10) >= delta) { after = sample; break; } }
      const curvature = threePointCurvature(before, [0, 10], after);
      near(curvature, 0.1, 0.008, "the circle through the three points has the arc's curvature to within 8 percent");
    }
  },
  {
    name: "Smooth between two splines moves the first spline's end into the second's, with matching tangent and curvature",
    run: () => {
      const reference = spline("ref", [[-30, 0], [-22, 9], [-14, 12], [-6, 9], [0, 0]]);
      const mover = spline("mov", [[3, -3], [9, -9], [17, -10], [25, -4], [30, 3]]);
      const project = run(projectWith([reference, mover]), { kind: "add-sketch-constraint", constraint: smooth("g2", "mov", "ref", ["start", "end"]) });
      expectG2(project, "mov", "start", reference, "end", "second spline into the first");
      equal(JSON.stringify(splineOf(project, "ref").fitPoints), JSON.stringify(reference.fitPoints), "the reference spline was not touched");
      const mismatch = neighbourTravel(reference, "end").curvature;
      assert(Math.abs(mismatch) > 0.005, `the reference has real curvature at the joint (${mismatch}) so this is a true G2 join`);
    }
  },
  {
    name: "the spline follows its neighbour: resizing the arc re-blends the spline to the new radius, and moving the line end drags the joint",
    run: () => {
      const arc = arcOf("a", 10, 0, 90);
      let project = run(projectWith([arc, spline("s", FIT.map((point) => [point[0] - 1, point[1] + 1] as Vec))]), { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "a", ["start", "end"]) });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "radius", valueMm: 16 });
      const resized = project.sketch.entities.find((entity) => entity.id === "entity:a")!;
      expectG2(project, "s", "start", resized, "end", "after the arc grew to radius 16");
      near(Math.abs(splineTravel(splineOf(project, "s").fitPoints, "start").curvature), 1 / 16, 2e-4, "the curvature is now one over sixteen");

      const lineProject = run(projectWith([line("l", [-20, 0], [0, 0]), spline("s", [[2, 3], [8, 12], [16, 14], [24, 10], [30, 2]])]), { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "l", ["start", "end"]) });
      const lengthened = run(lineProject, { kind: "set-sketch-dimension", entityId: "entity:l", dimension: "length", valueMm: 12 });
      const moved = lengthened.sketch.entities.find((entity) => entity.id === "entity:l")!;
      expectG2(lengthened, "s", "start", moved, "end", "after the line was shortened");
      near(splineOf(lengthened, "s").fitPoints[0]![0], -8, 1e-9, "the spline start followed the line end to x = -8");
    }
  },
  {
    name: "a spline can be smooth at both ends with six or more fit points, and the constraint is refused where it cannot hold",
    run: () => {
      const arc = arcOf("a", 10, 0, 90);
      const second = line("l", [60, 0], [80, 0]);
      const fit: Vec[] = [[0, 10], [6, 20], [20, 26], [34, 22], [46, 12], [58, 2], [60, 0]];
      const first = run(projectWith([arc, second, spline("s", fit)]), { kind: "add-sketch-constraint", constraint: smooth("g2a", "s", "a", ["start", "end"]) });
      const both = run(first, { kind: "add-sketch-constraint", constraint: smooth("g2b", "s", "l", ["end", "start"]) });
      expectG2(both, "s", "start", arc, "end", "start of the spline into the arc");
      expectG2(both, "s", "end", second, "start", "end of the spline into the line");

      // Too few fit points to be smooth at both ends: recorded, reported, and the first end is not disturbed.
      const short = projectWith([arc, line("l2", [20, 0], [40, 0]), spline("t", [[0, 10], [10, 14], [20, 0]])]);
      const withFirst = run(short, { kind: "add-sketch-constraint", constraint: smooth("h1", "t", "a", ["start", "end"]) });
      const result = apply(withFirst, { kind: "add-sketch-constraint", constraint: smooth("h2", "t", "l2", ["end", "start"]) });
      assert(result.ok && result.value.summary.includes("six fit points"), `the second end is reported, not forced: ${result.ok ? result.value.summary : result.diagnostics[0]?.message}`);
    }
  },
  {
    name: "Smooth validates and fits only a spline joined to a line, arc or spline end; it takes four degrees of freedom and relaxes cleanly",
    run: () => {
      equal(constraintFit("smooth", ["spline", "line"], ["start", "end"]).ok, true, "spline + line fits");
      equal(constraintFit("smooth", ["arc", "spline"], ["end", "start"]).ok, true, "arc + spline fits");
      equal(constraintFit("smooth", ["spline", "spline"], ["start", "end"]).ok, true, "spline + spline fits");
      equal(constraintFit("smooth", ["line", "arc"], ["start", "end"]).ok, false, "line + arc does not (no spline)");
      equal(constraintFit("smooth", ["spline", "circle"], ["start", "end"]).ok, false, "a circle has no end");
      equal(constraintFit("smooth", ["spline", "line"]).ok, false, "the ends must be named");
      equal(constraintFit("smooth", ["spline", "line"], ["self", "end"]).ok, false, "only start or end");

      const arc = arcOf("a", 10, 0, 90);
      const base = projectWith([arc, spline("s", FIT.map((point) => [point[0] - 1, point[1] + 1] as Vec))]);
      const bad = apply(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:bad", kind: "smooth", entityIds: ["entity:s", "entity:a"] } });
      assert(!bad.ok, "a smooth constraint with no end points is rejected by validation");
      const free = analyzeWorkbenchSketch(base.sketch).degreesOfFreedom;
      const joined = run(base, { kind: "add-sketch-constraint", constraint: smooth("g2", "s", "a", ["start", "end"]) });
      equal(analyzeWorkbenchSketch(joined.sketch).degreesOfFreedom, free - 4, "joining position, tangent and curvature removes four degrees of freedom");

      const relaxed = run(joined, { kind: "set-sketch-constraints-suppressed", constraintIds: ["constraint:g2"], suppressed: true });
      const moved = run(relaxed, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "radius", valueMm: 14 });
      const stillAt = splineOf(moved, "s").fitPoints[0]!;
      near(stillAt[0], splineOf(joined, "s").fitPoints[0]![0], 1e-12, "a relaxed Smooth no longer follows the arc (x)");
      near(stillAt[1], splineOf(joined, "s").fitPoints[0]![1], 1e-12, "a relaxed Smooth no longer follows the arc (y)");
      const restored = run(moved, { kind: "set-sketch-constraints-suppressed", constraintIds: ["constraint:g2"], suppressed: false });
      expectG2(restored, "s", "start", restored.sketch.entities.find((entity) => entity.id === "entity:a")!, "end", "after restoring");
    }
  },
  {
    name: "nearestSmoothJoint picks the ends that are closest, whichever order the curves were chosen in",
    run: () => {
      const arc = arcOf("a", 10, 0, 90);
      const s = spline("s", [[30, 30], [20, 20], [1, 11]]);
      const joint = nearestSmoothJoint(s, arc)!;
      equal(joint.points[0], "end", "the spline's last fit point is the near one");
      equal(joint.points[1], "end", "and the arc's end");
      near(joint.gapMm, Math.hypot(1, 1), 1e-12, "and their gap is reported");
      const reversed = nearestSmoothJoint(arc, s)!;
      equal(reversed.points[0], "end", "the arc end comes first when the arc was chosen first");
      assert(nearestSmoothJoint({ id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 1, construction: false }, s) === undefined, "a circle has no end to join");
    }
  },
  {
    name: "spline tangent handles read the real tangent at every fit point, and dragging one sets it exactly while the curve still passes through every fit point",
    run: () => {
      const s = spline("s", [[0, 0], [10, 8], [20, 0], [30, 8], [40, 0]]);
      const handles = splineTangentHandles(s, 0.5);
      equal(handles.length, 5, "one handle per fit point");
      near(handles[0]!.tangent[0], 5, 1e-12, "at the start the tangent is half the step to the next point (x)");
      near(handles[0]!.tangent[1], 4, 1e-12, "(y)");
      near(handles[2]!.tangent[0], 10, 1e-12, "at an interior point it is half the span between the neighbours (x)");
      near(handles[2]!.tangent[1], 0, 1e-12, "(y)");
      near(handles[2]!.tip[0], 25, 1e-12, "the tip stands the scaled tangent from the point");
      // Cross-check the tangent against the drawn curve's finite differences at an interior node.
      const samples = sampleSpline(s.fitPoints, 1000);
      const node = 2 * 1000;
      const slope: Vec = [(samples[node + 1]![0] - samples[node]![0]) * 1000, (samples[node + 1]![1] - samples[node]![1]) * 1000];
      near(slope[0], handles[2]!.tangent[0], 0.05, "the drawn curve leaves the node with the handle's velocity (x)");

      const dragged = setSplineTangent(s, 2, [6, 6]);
      assert(dragged.ok, "an interior tangent can be set");
      if (!dragged.ok) return;
      const after = splineTangentHandles({ ...s, fitPoints: dragged.fitPoints }, 1);
      near(after[2]!.tangent[0], 6, 1e-12, "the tangent at the node is now (6, 6) (x)");
      near(after[2]!.tangent[1], 6, 1e-12, "(y)");
      near(dragged.fitPoints[2]![0], 20, 1e-12, "the node itself did not move (x)");
      near(dragged.fitPoints[2]![1], 0, 1e-12, "(y)");
      near(dragged.fitPoints[1]![0] + dragged.fitPoints[3]![0], 40, 1e-12, "the neighbours moved by equal and opposite amounts (x)");
      near(dragged.fitPoints[1]![1] + dragged.fitPoints[3]![1], 16, 1e-12, "(y)");
      const drawn = sampleSpline(dragged.fitPoints, 50);
      assert(dragged.fitPoints.every((point) => drawn.some((sample) => Math.hypot(sample[0] - point[0], sample[1] - point[1]) < 1e-9)), "the redrawn curve still passes through every fit point");

      const endDrag = setSplineTangent(s, 0, [3, 9]);
      assert(endDrag.ok, "an end tangent can be set");
      if (endDrag.ok) {
        const frame = splineEndFrame(endDrag.fitPoints, "start")!;
        near(frame.tangent[0], 3 / Math.hypot(3, 9), 1e-12, "the end tangent direction is set (x)");
        near(frame.tangent[1], 9 / Math.hypot(3, 9), 1e-12, "(y)");
      }
      const lastDrag = setSplineTangent(s, 4, [4, -2]);
      assert(lastDrag.ok, "the last tangent can be set");
      if (lastDrag.ok) near(splineTangentHandles({ ...s, fitPoints: lastDrag.fitPoints })[4]!.tangent[1], -2, 1e-12, "the last point's tangent is set");
      assert(!setSplineTangent(s, 9, [1, 1]).ok, "a missing fit point is refused");
      assert(!setSplineTangent(s, 1, [0, 0]).ok, "a zero tangent is refused");
    }
  },
  {
    name: "curvature control sets the signed curvature at either end of a spline and keeps the end point and its tangent",
    run: () => {
      const s = spline("s", [[0, 0], [10, 8], [20, 10], [30, 6], [40, 0]]);
      for (const end of ["start", "end"] as const) {
        for (const wanted of [0, 0.05, -0.08]) {
          const before = drawnEnd(s.fitPoints, end);
          const result = setSplineEndCurvature(s, end, wanted);
          assert(result.ok, `${end} curvature ${wanted} can be set`);
          if (!result.ok) continue;
          const after = drawnEnd(result.fitPoints, end);
          near(after.curvature, wanted, 2e-4, `the ${end} curvature is ${wanted}`);
          near(after.point[0], before.point[0], 1e-9, "the end point did not move (x)");
          near(after.point[1], before.point[1], 1e-9, "(y)");
          near(after.tangent[0], before.tangent[0], 1e-6, "the tangent direction is kept (x)");
          near(after.tangent[1], before.tangent[1], 1e-6, "(y)");
        }
      }
      const crowded = setSplineEndCurvature(spline("crowded", [[0, 0], [10, 0], [10, 3], [20, 0]]), "start", 0);
      equal(crowded.ok, false, "a curvature that would put two fit points on top of each other is refused, not applied");
    }
  },
  {
    name: "the minimum-radius check finds the tightest bend of a spline, where it is, and every stretch below a limit",
    run: () => {
      // A gentle curve with one sharp corner-like bend between the third and fourth fit points.
      const s = spline("s", [[0, 0], [20, 2], [40, 3], [43, 10], [46, 3], [66, 2], [86, 0]]);
      const fit = s.fitPoints as readonly (readonly [number, number])[];
      const report = splineRadiusReport(fit);
      // Brute force: the tightest circumradius over a very dense sampling of the drawn curve.
      const dense = sampleSpline(s.fitPoints, 400);
      let brute = Infinity;
      let bruteAt: Vec = dense[0]!;
      for (let i = 1; i < dense.length - 1; i += 1) {
        const k = Math.abs(threePointCurvature(dense[i - 1]!, dense[i]!, dense[i + 1]!));
        if (k > 1e-12 && 1 / k < brute) { brute = 1 / k; bruteAt = dense[i]!; }
      }
      near(report.minRadiusMm, brute, brute * 0.02, `the exact minimum radius ${report.minRadiusMm.toFixed(3)} agrees with brute force ${brute.toFixed(3)}`);
      assert(Math.hypot(report.minRadiusPoint[0] - bruteAt[0], report.minRadiusPoint[1] - bruteAt[1]) < 0.6, "and it is found at the same place");
      assert(report.minRadiusMm < 10, "the bend is tight");
      const limit = report.minRadiusMm * 3;
      const limited = entityRadiusReport(s, limit)!;
      equal(limited.belowLimit, true, "with a limit above the tightest radius the spline is flagged");
      assert(limited.tight.length >= 1, "and the stretches below the limit are listed");
      for (const stretch of limited.tight) {
        assert(stretch.minRadiusMm < limit, "each stretch is tighter than the limit");
        assert(stretch.minRadiusMm >= report.minRadiusMm - 1e-9, "and none is tighter than the global minimum");
      }
      equal(entityRadiusReport(s, report.minRadiusMm / 2)!.belowLimit, false, "a limit below the tightest radius flags nothing");
      equal(entityRadiusReport(s, report.minRadiusMm / 2)!.tight.length, 0, "and lists no stretch");
    }
  },
  {
    name: "the minimum-radius check covers circles, arcs and ellipses exactly and reports a sketch's violations tightest first",
    run: () => {
      const entities: SketchEntity[] = [
        { id: "entity:circle", kind: "circle", center: [0, 0], radiusMm: 6, construction: false },
        arcOf("arc", 3, 0, 90),
        { id: "entity:ellipse", kind: "ellipse", center: [50, 0], majorRadiusMm: 20, minorRadiusMm: 6, rotationDeg: 30, construction: false },
        line("line", [0, 0], [10, 0]),
        { id: "entity:ghost", kind: "circle", center: [0, 0], radiusMm: 0.5, construction: true }
      ];
      const check = minimumRadiusCheck({ entities }, 5);
      equal(check.ok, false, "something is tighter than 5 mm");
      equal(check.entities.length, 3, "a line and a construction circle are not checked");
      equal(check.entities.map((report) => report.entityId).join(","), "entity:ellipse,entity:arc,entity:circle", "ordered tightest first: the ellipse (1.8 mm at its major-axis ends), the 3 mm arc, the 6 mm circle");
      near(check.entities[1]!.minRadiusMm, 3, 1e-9, "the arc's radius is reported exactly");
      const ellipse = check.entities.find((report) => report.kind === "ellipse")!;
      near(ellipse.minRadiusMm, 36 / 20, 1e-12, "an ellipse's tightest radius is b squared over a");
      // The ellipse's tightest point is the end of its major axis, 20 mm from the centre at 30 degrees.
      near(ellipse.at[0], 50 + 20 * Math.cos(Math.PI / 6), 1e-9, "found at the end of the major axis (x)");
      near(ellipse.at[1], 20 * Math.sin(Math.PI / 6), 1e-9, "(y)");
      // Brute force over the ellipse parameter agrees.
      let tightest = Infinity;
      for (let i = 0; i < 20000; i += 1) {
        const t = (i / 20000) * Math.PI * 2;
        const k = (20 * 6) / ((20 * Math.sin(t)) ** 2 + (6 * Math.cos(t)) ** 2) ** 1.5;
        tightest = Math.min(tightest, 1 / k);
      }
      near(ellipse.minRadiusMm, tightest, 1e-3, "the closed form matches a brute-force sweep of the ellipse");
      equal(check.violations.map((report) => report.entityId).join(","), "entity:ellipse,entity:arc", "the ellipse and the arc violate a 5 mm limit, tightest first");
      equal(minimumRadiusCheck({ entities }, 1).ok, true, "a 1 mm limit is satisfied by everything");
    }
  }
];
