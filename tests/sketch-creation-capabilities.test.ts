import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import type { SketchEntity, Vec2, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildCurveTool, DEFAULT_CURVE_TOOL_OPTIONS } from "../packages/workbench-sketch/src/curve-tools.js";
import { buildEllipticalArc, ellipticalArcEnds } from "../packages/workbench-sketch/src/ellipse-arc.js";
import { nearestOnEllipse } from "../packages/workbench-sketch/src/ellipse-geometry.js";
import { detectSketchProfiles, sampleSpline } from "../packages/workbench-sketch/src/index.js";
import { buildFitSpline, insertSplineFitPoint, removeSplineFitPoint } from "../packages/workbench-sketch/src/spline-fit.js";
import { buildTangentCircleThree, buildTangentCircleTwo } from "../packages/workbench-sketch/src/tangent-circles.js";
import type { ShapeIds } from "../packages/workbench-sketch/src/shapes.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const ids: ShapeIds = { entity: () => `entity:cap-${(counter += 1)}`, constraint: () => `constraint:cap-${(counter += 1)}` };

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-creation-capabilities");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

function apply(project: WorkbenchProject, edit: { readonly addEntities?: readonly SketchEntity[]; readonly addConstraints?: readonly WorkbenchSketchConstraint[]; readonly updateEntities?: readonly SketchEntity[] }): WorkbenchProject {
  counter += 1;
  const result = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:cap-${counter}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: edit.updateEntities ?? [], addEntities: edit.addEntities ?? [], addConstraints: edit.addConstraints ?? [], label: "Capability test" });
  if (!result.ok) throw new Error(`the sketch edit was refused: ${result.diagnostics[0]?.message ?? "no reason"}`);
  return result.value.project;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function meshVolumeMm3(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return total / 6;
}

const toPolar = (radius: number, degrees: number, center: Vec2 = [0, 0]): Vec2 => [center[0] + radius * Math.cos((degrees * Math.PI) / 180), center[1] + radius * Math.sin((degrees * Math.PI) / 180)];

/** How far x ever runs backwards from the furthest point reached so far: 0 for a curve that only moves forward. */
function backtrackDepth(points: readonly Vec2[]): number {
  let furthest = Number.NEGATIVE_INFINITY;
  let depth = 0;
  for (const point of points) {
    furthest = Math.max(furthest, point[0]);
    depth = Math.max(depth, furthest - point[0]);
  }
  return depth;
}

const distanceTo = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointToLine(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return Math.abs((point[0] - start[0]) * dy - (point[1] - start[1]) * dx) / Math.hypot(dx, dy);
}

export const sketchCreationCapabilityTests: readonly TestCase[] = [
  // ------------------------------------------------------------------------------------------ elliptical arc
  {
    name: "Elliptical arc: an arc of a 20 x 10 ellipse follows the ellipse to 5 microns and its ends are exact ellipse points",
    run: () => {
      const shape = must(buildEllipticalArc([0, 0], [20, 0], [0, 10], toPolar(20, 0), [-20, 0], ids));
      const spline = shape.entities[0]!;
      assert(spline.kind === "spline", "stored as a fit-point spline");
      let worst = 0;
      for (const sample of sampleSpline(spline.fitPoints, 12)) worst = Math.max(worst, nearestOnEllipse(sample, { center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10, rotationDeg: 0 }).distance);
      assert(worst <= 0.005, `within 5 microns of the ellipse (worst ${worst.toFixed(5)})`);
      const first = spline.fitPoints[0]!;
      const last = spline.fitPoints[spline.fitPoints.length - 1]!;
      near(first[0], 20, 1e-9, "starts at the end of the major axis");
      near(last[0], -20, 1e-9, "and ends at the other end");
      near(last[1], 0, 1e-9, "on the axis");
      assert(spline.fitPoints.length <= 64, "within the fit-point limit");
      // The ellipse arc is counter-clockwise from the start to the end: the half in between lies above the axis.
      assert(spline.fitPoints.some((point) => point[1] > 9), "passes over the top (y near 10)");
      apply(emptyProject(), { addEntities: shape.entities });
    }
  },
  {
    name: "Elliptical arc: a half ellipse closed by a line is one profile of the exact area and extrudes to the matching volume",
    run: async () => {
      const ends = ellipticalArcEnds([0, 0], [20, 0], [0, 10], [20, 0], [-20, 0])!;
      const shape = must(buildEllipticalArc([0, 0], [20, 0], [0, 10], [20, 0], [-20, 0], ids));
      const closing = line("entity:cap-chord", ends.end, ends.start);
      const project = apply(emptyProject(), { addEntities: [...shape.entities, closing] });
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "the arc and the line close a loop");
      const exactArea = (Math.PI * 20 * 10) / 2;
      near(profiles[0]!.areaMm2, exactArea, exactArea * 0.003, "area of half an ellipse");
      const solid = await createGeneralSolidBody({ profile: profiles[0]!, plane: "xy", operation: "extrude", valueMm: 4, bodyId: "general-body:ellipse-arc", name: "Half ellipse", color: "#b9c2c8" });
      assert(solid.ok, "the loop extrudes");
      near(meshVolumeMm3(solid.body.positionsMm, solid.body.indices), profiles[0]!.areaMm2 * 4, profiles[0]!.areaMm2 * 4 * 1e-6, "volume is area times height");
    }
  },
  {
    name: "Elliptical arc: a rotated ellipse sector (two lines to the centre) has the exact area half a b times the swept angle",
    run: () => {
      const centre: Vec2 = [10, 5];
      const rotation = 30;
      const majorPoint: Vec2 = toPolar(30, rotation, centre);
      const minorPoint: Vec2 = toPolar(12, rotation + 90, centre);
      // Parameter angles 20 and 140 degrees on the ellipse itself.
      const onEllipse = (parameterDeg: number): Vec2 => {
        const t = (parameterDeg * Math.PI) / 180;
        const x = 30 * Math.cos(t);
        const y = 12 * Math.sin(t);
        const r = (rotation * Math.PI) / 180;
        return [centre[0] + x * Math.cos(r) - y * Math.sin(r), centre[1] + x * Math.sin(r) + y * Math.cos(r)];
      };
      const from = onEllipse(20);
      const to = onEllipse(140);
      const ends = ellipticalArcEnds(centre, majorPoint, minorPoint, from, to)!;
      const shape = must(buildEllipticalArc(centre, majorPoint, minorPoint, from, to, ids));
      const project = apply(emptyProject(), { addEntities: [...shape.entities, line("entity:cap-r1", centre, ends.start), line("entity:cap-r2", ends.end, centre)] });
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "the sector is closed");
      const exact = 0.5 * 30 * 12 * ((120 * Math.PI) / 180);
      near(profiles[0]!.areaMm2, exact, exact * 0.003, "sector area a b dt / 2");
    }
  },
  {
    name: "Elliptical arc: it joins a circular arc into a loop, and zero sweeps and bad points are refused",
    run: () => {
      const ends = ellipticalArcEnds([0, 0], [20, 0], [0, 10], [20, 0], [-20, 0])!;
      const shape = must(buildEllipticalArc([0, 0], [20, 0], [0, 10], [20, 0], [-20, 0], ids));
      const lower: SketchEntity = { id: "entity:cap-lower", kind: "arc", start: ends.end, mid: [0, -15], end: ends.start, construction: false };
      const project = apply(emptyProject(), { addEntities: [...shape.entities, lower] });
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "an elliptical arc and a circular arc close a loop");
      // Half the ellipse (314.16) plus the circular segment under the chord: radius 20.83, chord 40, sagitta 15 gives 441.9.
      near(profiles[0]!.areaMm2, 314.159 + 441.9, 756 * 0.01, "and bound the sum of the two areas");
      assert(!buildEllipticalArc([0, 0], [20, 0], [0, 10], [20, 0], [20, 0], ids).ok, "the same start and end is a zero sweep");
      assert(!buildEllipticalArc([0, 0], [20, 0], [0, 0], [20, 0], [0, 10], ids).ok, "no minor radius is refused");
      assert(!buildEllipticalArc([0, 0], [20, 0], [0, 10], [20, 0], [Number.NaN, 4], ids).ok, "a NaN end is refused");
      const viaTool = must(buildCurveTool("ellipse-arc", [[0, 0], [20, 0], [0, 10], [20, 0], [0, 10]], DEFAULT_CURVE_TOOL_OPTIONS, ids));
      equal(viaTool.entities.length, 1, "the curve tool dispatches to it");
    }
  },

  // ------------------------------------------------------------------------------------------ tangent circles
  {
    name: "3-tangent circle: three lines of a 30-40-50 triangle give the incircle (centre 10,10 radius 10) with three Tangent relations the solver keeps",
    run: () => {
      const lines = [line("entity:cap-a", [0, 0], [40, 0]), line("entity:cap-b", [40, 0], [0, 30]), line("entity:cap-c", [0, 30], [0, 0])];
      const shape = must(buildTangentCircleThree(lines, [[20, 0.5], [20, 15.2], [0.4, 15]], 2, ids));
      const made = shape.entities[0]!;
      assert(made.kind === "circle", "a circle");
      near(made.center[0], 10, 1e-9, "centre x");
      near(made.center[1], 10, 1e-9, "centre y");
      near(made.radiusMm, 10, 1e-9, "radius");
      equal(shape.constraints.filter((constraint) => constraint.kind === "tangent").length, 3, "one Tangent per curve");
      const base = emptyProject();
      const project = apply({ ...base, sketch: { ...base.sketch, entities: lines } }, { addEntities: shape.entities, addConstraints: shape.constraints });
      const placed = project.sketch.entities.find((entity) => entity.id === made.id);
      assert(placed?.kind === "circle", "in the sketch");
      near(placed.center[0], 10, 1e-6, "the solver leaves the circle where it is (x)");
      near(placed.center[1], 10, 1e-6, "(y)");
      near(placed.radiusMm, 10, 1e-6, "(radius)");
    }
  },
  {
    name: "3-tangent circle: tangent to a line and two circles, it is the one nearest the clicks and touches all three",
    run: () => {
      const curves = [line("entity:cap-floor", [-50, 0], [50, 0]), circle("entity:cap-left", [-20, 10], 10), circle("entity:cap-right", [20, 10], 10)];
      const shape = must(buildTangentCircleThree(curves, [[0.2, 0.1], [-10, 10.2], [10, 9.8]], 2, ids));
      const made = shape.entities[0]!;
      assert(made.kind === "circle", "a circle");
      near(made.center[0], 0, 1e-8, "centred between the two circles");
      near(made.center[1], 10, 1e-8, "resting on the line");
      near(made.radiusMm, 10, 1e-8, "radius 10");
      near(distanceTo(made.center, [-20, 10]), made.radiusMm + 10, 1e-8, "touches the left circle from outside");
      near(distanceTo(made.center, [20, 10]), made.radiusMm + 10, 1e-8, "touches the right circle from outside");
      near(pointToLine(made.center, [-50, 0], [50, 0]), made.radiusMm, 1e-8, "touches the line");
      const base = emptyProject();
      apply({ ...base, sketch: { ...base.sketch, entities: curves } }, { addEntities: shape.entities, addConstraints: shape.constraints });
    }
  },
  {
    name: "3-tangent circle: an internal touch works too (a circle inside a big one, tangent to two lines)",
    run: () => {
      // A circle of radius 30 about the origin and two lines through it; the circle tangent to both lines and inside the big circle.
      const curves = [circle("entity:cap-big", [0, 0], 30), line("entity:cap-l1", [-40, -40], [40, 40]), line("entity:cap-l2", [-40, 40], [40, -40])];
      const shape = must(buildTangentCircleThree(curves, [[29.5, 0.5], [18, 18.3], [18.4, -18]], 2, ids));
      const made = shape.entities[0]!;
      assert(made.kind === "circle", "a circle");
      near(distanceTo(made.center, [0, 0]), 30 - made.radiusMm, 1e-8, "inside the big circle and touching it");
      near(pointToLine(made.center, [-40, -40], [40, 40]), made.radiusMm, 1e-8, "touches the first line");
      near(pointToLine(made.center, [-40, 40], [40, -40]), made.radiusMm, 1e-8, "touches the second line");
      assert(made.center[0] > 0, "on the side of the clicks");
    }
  },
  {
    name: "2-tangent circle: a radius between a floor and a wall; the clicks pick which of the four fits",
    run: () => {
      const curves = [line("entity:cap-floor2", [-20, 0], [60, 0]), line("entity:cap-wall", [30, -20], [30, 40])];
      const shape = must(buildTangentCircleTwo(curves, [[24, 0.2], [30.1, 6]], 4, 2, ids));
      const made = shape.entities[0]!;
      assert(made.kind === "circle", "a circle");
      near(made.center[0], 26, 1e-9, "left of the wall");
      near(made.center[1], 4, 1e-9, "above the floor");
      near(made.radiusMm, 4, 1e-9, "the requested radius");
      equal(shape.constraints.map((constraint) => constraint.kind).sort().join(","), "radius,tangent,tangent", "two Tangent relations and the radius dimension");
      const right = must(buildTangentCircleTwo(curves, [[36, 0.2], [29.9, 6]], 4, 2, ids)).entities[0]!;
      assert(right.kind === "circle" && Math.abs(right.center[0] - 34) < 1e-9, "clicks on the other side give the circle on the other side");
      const base = emptyProject();
      const project = apply({ ...base, sketch: { ...base.sketch, entities: curves } }, { addEntities: shape.entities, addConstraints: shape.constraints });
      const placed = project.sketch.entities.find((entity) => entity.id === made.id);
      assert(placed?.kind === "circle" && Math.abs(placed.center[0] - 26) < 1e-6 && Math.abs(placed.center[1] - 4) < 1e-6, "the solver keeps it");
    }
  },
  {
    name: "2-tangent circle: it touches an arc from outside, and clicks that miss, repeat a curve or cannot be satisfied are refused with a reason",
    run: () => {
      const arc: SketchEntity = { id: "entity:cap-arc", kind: "arc", start: [-20, 0], mid: [0, 20], end: [20, 0], construction: false };
      const floor = line("entity:cap-floor3", [-60, -5], [60, -5]);
      const shape = must(buildTangentCircleTwo([arc, floor], [[14.2, 14.1], [30, -5]], 6, 3, ids));
      const made = shape.entities[0]!;
      assert(made.kind === "circle", "a circle");
      near(distanceTo(made.center, [0, 0]), 20 + 6, 1e-8, "outside the arc's circle");
      near(pointToLine(made.center, [-60, -5], [60, -5]), 6, 1e-8, "touching the floor");
      assert(made.center[0] > 0, "on the side of the clicks");
      const far = buildTangentCircleTwo([arc, floor], [[0, 80], [30, -5]], 6, 3, ids);
      assert(!far.ok && /closer/u.test(far.diagnostics[0]!.message), "a click far from every curve says so");
      const twice = buildTangentCircleTwo([arc, floor], [[30, -5], [31, -5]], 6, 3, ids);
      assert(!twice.ok && /different curve/u.test(twice.diagnostics[0]!.message), "two clicks on the same curve are refused");
      const parallel = [line("entity:cap-p1", [0, 0], [50, 0]), line("entity:cap-p2", [0, 10], [50, 10]), line("entity:cap-p3", [0, 20], [50, 20])];
      assert(!buildTangentCircleThree(parallel, [[25, 0], [25, 10], [25, 20]], 2, ids).ok, "three parallel lines have no tangent circle");
      assert(!buildTangentCircleTwo([arc, floor], [[14.2, 14.1], [30, -5]], 0, 3, ids).ok, "a zero radius is refused");
      assert(!buildTangentCircleTwo(parallel, [[25, 0], [25, 10]], 8, 3, ids).ok, "a radius that does not fit between two parallel lines has no circle");
    }
  },

  // ------------------------------------------------------------------------------------------ spline parameterisation, 64 points, add / remove
  {
    name: "Fit-point spline T07 option: centripetal and chord-length parameterisation stop the loops and backtracking that uneven clicks cause",
    run: () => {
      const cases: readonly (readonly Vec2[])[] = [[[0, 0], [1, 10], [100, 10]], [[0, 0], [1, 0], [2, 5], [40, 5], [41, 0]]];
      for (const clicks of cases) {
        const uniform = must(buildFitSpline(clicks, "uniform", "entity:cap-u"));
        assert(uniform.kind === "spline", "spline");
        assert(backtrackDepth(sampleSpline(uniform.fitPoints, 16)) > 1, "the classic uniform spline backtracks by millimetres on these clicks (the reason for the option)");
        const yRange = (points: readonly Vec2[]): readonly [number, number] => [Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[1]))];
        const [clickLow, clickHigh] = yRange(clicks);
        for (const mode of ["centripetal", "chord-length"] as const) {
          const built = must(buildFitSpline(clicks, mode, `entity:cap-${mode}`));
          assert(built.kind === "spline", "spline");
          assert(backtrackDepth(sampleSpline(built.fitPoints, 16)) <= 0.1, `${mode}: x does not run backwards (at most 0.1 mm of wobble where the clicks turn sharply, against millimetres for the classic spline)`);
          const [low, high] = yRange(sampleSpline(built.fitPoints, 16));
          // Chord-length spacing is known to swing wide at a sharp turn (that is why centripetal is the usual choice), so only centripetal is bounded.
          if (mode === "centripetal") assert(low >= clickLow - 5 && high <= clickHigh + 5, `${mode}: overshoot beyond the clicked range stays within half the sharpest step (${(clickLow - low).toFixed(2)}, ${(high - clickHigh).toFixed(2)})`);
          for (const click of clicks) assert(built.fitPoints.some((point) => point[0] === click[0] && point[1] === click[1]), `${mode}: passes through the clicked point ${click.join(",")}`);
          assert(built.fitPoints.length <= 64 && built.fitPoints.length >= clicks.length, `${mode}: ${built.fitPoints.length} fit points`);
          apply(emptyProject(), { addEntities: [built] });
        }
      }
      const classic = must(buildFitSpline([[0, 0], [10, 8], [20, -4]], "uniform", "entity:cap-same"));
      assert(classic.kind === "spline" && classic.fitPoints.length === 3, "uniform leaves the clicks exactly as they are");
    }
  },
  {
    name: "Fit-point spline: more than 24 points are kept, and a spline of 64 clicks stays valid in every parameterisation",
    run: () => {
      const wiggle = Array.from({ length: 64 }, (_, index): Vec2 => [index * 4 + (index % 3), Math.sin(index / 3) * 12]);
      for (const mode of ["uniform", "centripetal", "chord-length"] as const) {
        const built = must(buildFitSpline(wiggle, mode, `entity:cap-w-${mode}`));
        assert(built.kind === "spline" && built.fitPoints.length === 64, `${mode}: all 64 points kept`);
        apply(emptyProject(), { addEntities: [built] });
      }
      assert(!buildFitSpline([...wiggle, [300, 0]], "centripetal", "entity:cap-65").ok, "65 clicks are refused");
    }
  },
  {
    name: "Fit-point spline: a fit point can be added on the curve and an interior one removed, through the operation layer",
    run: () => {
      const spline = must(buildFitSpline([[0, 0], [20, 15], [40, -5], [60, 10]], "uniform", "entity:cap-edit"));
      assert(spline.kind === "spline", "spline");
      const base = apply(emptyProject(), { addEntities: [spline] });
      const added = must(insertSplineFitPoint(spline, [31, 3]));
      equal(added.spline.fitPoints.length, 5, "one more fit point");
      equal(added.index, 2, "between the second and third original points");
      const curve = sampleSpline(spline.fitPoints, 24);
      let gap = Infinity;
      for (let index = 1; index < curve.length; index += 1) {
        const a = curve[index - 1]!;
        const b = curve[index]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((added.spline.fitPoints[2]![0] - a[0]) * dx + (added.spline.fitPoints[2]![1] - a[1]) * dy) / (dx * dx + dy * dy)));
        gap = Math.min(gap, Math.hypot(a[0] + dx * t - added.spline.fitPoints[2]![0], a[1] + dy * t - added.spline.fitPoints[2]![1]));
      }
      near(gap, 0, 1e-9, "the new point sits on the original curve");
      const updated = apply(base, { updateEntities: [added.spline] });
      const stored = updated.sketch.entities.find((entity) => entity.id === spline.id);
      assert(stored?.kind === "spline" && stored.fitPoints.length === 5, "the update is accepted by the sketch");
      const removed = must(removeSplineFitPoint(added.spline, 2));
      equal(removed.fitPoints.length, 4, "and the point can be removed again");
      equal(removed.fitPoints.map((point) => point.join(",")).join(" "), spline.fitPoints.map((point) => point.join(",")).join(" "), "back to the original points");
      assert(!removeSplineFitPoint(spline, 0).ok && !removeSplineFitPoint(spline, 3).ok, "the end points hold the joints and stay");
      const three = must(buildFitSpline([[0, 0], [10, 5], [20, 0]], "uniform", "entity:cap-three"));
      assert(three.kind === "spline" && !removeSplineFitPoint(three, 1).ok, "a spline keeps at least three points");
      assert(!insertSplineFitPoint(spline, [20.001, 15]).ok, "clicking on an existing point is refused");
      const full = must(buildFitSpline(Array.from({ length: 64 }, (_, index): Vec2 => [index * 3, (index % 2) * 2]), "uniform", "entity:cap-full"));
      assert(full.kind === "spline" && !insertSplineFitPoint(full, [31.5, 1]).ok, "a spline at 64 points takes no more");
    }
  }
];
