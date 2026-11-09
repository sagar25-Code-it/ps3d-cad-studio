import type { SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { angleBetweenLinesDeg, arcShape, entityLengthMm, measureDimensionConstraint } from "../packages/workbench-core/src/sketch-measure.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { splineLengthMm } from "../packages/workbench-core/src/spline-curvature.js";
import { analyzeWorkbenchSketch, sampleSpline } from "../packages/workbench-sketch/src/index.js";
import { angleDimensionLayout, arcLengthDimensionLayout, dimensionLayout, perimeterDimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function apply(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-wp-dim-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = apply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  const validated = validateWorkbenchProject(result.value.project);
  assert(validated.ok, "the resulting project validates");
  return result.value.project;
}

function refused(project: WorkbenchProject, operation: Op): string {
  const result = apply(project, operation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.ok ? "" : result.diagnostics[0]?.message ?? "";
}

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-wp-dim");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

const line = (id: string, start: readonly [number, number], end: readonly [number, number]): Line => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });

function get<K extends SketchEntity["kind"]>(project: WorkbenchProject, id: string, kind: K): Extract<SketchEntity, { kind: K }> {
  const found = project.sketch.entities.find((entity) => entity.id === `entity:${id}`);
  if (found === undefined || found.kind !== kind) throw new Error(`entity ${id} is not a ${kind}`);
  return found as Extract<SketchEntity, { kind: K }>;
}

const directionDeg = (entity: Line): number => (Math.atan2(entity.end[1] - entity.start[1], entity.end[0] - entity.start[0]) * 180) / Math.PI;
const lengthOf = (entity: Line): number => Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);

/** A 3-point arc of the given radius about the origin from `fromDeg` to `toDeg` counter-clockwise (or clockwise when reversed). */
function arcOf(id: string, radius: number, fromDeg: number, toDeg: number, clockwise = false): Arc {
  const at = (deg: number): readonly [number, number] => [radius * Math.cos((deg * Math.PI) / 180), radius * Math.sin((deg * Math.PI) / 180)];
  const mid = (fromDeg + toDeg) / 2;
  return { id: `entity:${id}`, kind: "arc", start: clockwise ? at(toDeg) : at(fromDeg), mid: at(mid), end: clockwise ? at(fromDeg) : at(toDeg), construction: false };
}

function shoelaceArea(points: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function volumeOf(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3; const b = indices[index + 1]! * 3; const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return Math.abs(total / 6);
}

const setAngle = (project: WorkbenchProject, first: string, second: string, valueDeg: number, extra: { readonly driven?: boolean } = {}): WorkbenchProject =>
  run(project, { kind: "set-sketch-dimension", entityId: `entity:${first}`, secondEntityId: `entity:${second}`, dimension: "angle", valueMm: valueDeg, ...extra });

/** A triangle of three joined lines: a base on the X axis, a side up to the apex, and the closing side. */
function triangle(): WorkbenchProject {
  const entities = [line("base", [0, 0], [10, 0]), line("side", [10, 0], [5, 8]), line("close", [5, 8], [0, 0])];
  const joins: WorkbenchSketchConstraint[] = [
    { id: "constraint:j1", kind: "coincident", entityIds: ["entity:base", "entity:side"], points: ["end", "start"] },
    { id: "constraint:j2", kind: "coincident", entityIds: ["entity:side", "entity:close"], points: ["end", "start"] },
    { id: "constraint:j3", kind: "coincident", entityIds: ["entity:close", "entity:base"], points: ["end", "start"] },
    { id: "constraint:fix-base", kind: "fixed", entityIds: ["entity:base"] }
  ];
  return projectWith(entities, joins);
}

export const sketchDimensionWpTests: readonly TestCase[] = [
  {
    name: "a driving angle dimension turns the second line about the corner the lines share, and a new value moves it again",
    run: () => {
      const start = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 5])]);
      const length = lengthOf(get(start, "b", "line"));
      let project = setAngle(start, "a", "b", 60);
      let b = get(project, "b", "line");
      near(directionDeg(b), 60, 1e-9, "line B now runs at 60 degrees from line A");
      near(b.start[0], 0, 1e-9, "the shared corner stayed put (x)");
      near(b.start[1], 0, 1e-9, "the shared corner stayed put (y)");
      near(lengthOf(b), length, 1e-9, "turning the line does not change its length");
      near(angleBetweenLinesDeg(get(project, "a", "line"), b), 60, 1e-9, "the measured angle is 60");
      const stored = project.sketch.constraints.filter((constraint) => constraint.kind === "angle");
      equal(stored.length, 1, "one angle constraint is recorded");
      equal(stored[0]!.valueDeg, 60, "holding 60 degrees");
      project = setAngle(project, "a", "b", 135);
      b = get(project, "b", "line");
      near(directionDeg(b), 135, 1e-9, "editing the value turns the line to 135 degrees");
      equal(project.sketch.constraints.filter((constraint) => constraint.kind === "angle").length, 1, "the edit replaced the dimension rather than adding another");
      near(get(project, "a", "line").end[0], 10, 1e-12, "line A did not move");
      project = setAngle(project, "a", "b", 270);
      near(angleBetweenLinesDeg(get(project, "a", "line"), get(project, "b", "line")), 270, 1e-9, "an angle beyond 180 degrees is held as counter-clockwise from A to B");
    }
  },
  {
    name: "an angle pivots about the shared corner even when the second line ends there, and turns the first line when the second is fixed",
    run: () => {
      const reversed = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 5], [0, 0])]);
      // B is drawn toward the corner, so the directed angle from A to B is 206.6; a value over 180 is the directed angle exactly as typed (wave 3 R2-7: values up to 180 keep the side the lines are on).
      const turned = setAngle(reversed, "a", "b", 210);
      const b = get(turned, "b", "line");
      near(b.end[0], 0, 1e-9, "B ends on the corner, which stayed (x)");
      near(b.end[1], 0, 1e-9, "B ends on the corner, which stayed (y)");
      near(angleBetweenLinesDeg(get(turned, "a", "line"), b), 210, 1e-9, "B now makes 210 degrees with A");
      const mirrored = setAngle(reversed, "a", "b", 30);
      near(angleBetweenLinesDeg(get(mirrored, "a", "line"), get(mirrored, "b", "line")), 330, 1e-9, "30 keeps the clockwise side B was on, so it is stored as 330");

      const heldSecond = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])], [{ id: "constraint:fix-b", kind: "fixed", entityIds: ["entity:b"] }]);
      const rotated = setAngle(heldSecond, "a", "b", 45);
      near(directionDeg(get(rotated, "b", "line")), 90, 1e-9, "the fixed line did not move");
      near(directionDeg(get(rotated, "a", "line")), 45, 1e-9, "the first line turned to leave 45 degrees up to B");
      near(angleBetweenLinesDeg(get(rotated, "a", "line"), get(rotated, "b", "line")), 45, 1e-9, "measured angle matches");
    }
  },
  {
    name: "an angle between two fixed lines, between a line and a circle, or outside 0 to 360 degrees is refused",
    run: () => {
      const bothFixed = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])], [
        { id: "constraint:fa", kind: "fixed", entityIds: ["entity:a"] },
        { id: "constraint:fb", kind: "fixed", entityIds: ["entity:b"] }
      ]);
      refused(bothFixed, { kind: "set-sketch-dimension", entityId: "entity:a", secondEntityId: "entity:b", dimension: "angle", valueMm: 30 });
      const withCircle = projectWith([line("a", [0, 0], [10, 0]), { id: "entity:c", kind: "circle", center: [3, 3], radiusMm: 2, construction: false }]);
      refused(withCircle, { kind: "set-sketch-dimension", entityId: "entity:a", secondEntityId: "entity:c", dimension: "angle", valueMm: 30 });
      const lines = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])]);
      refused(lines, { kind: "set-sketch-dimension", entityId: "entity:a", secondEntityId: "entity:b", dimension: "angle", valueMm: 360 });
      refused(lines, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "angle", valueMm: 30 });
      refused(lines, { kind: "set-sketch-dimension", entityId: "entity:a", secondEntityId: "entity:a", dimension: "angle", valueMm: 30 });
    }
  },
  {
    name: "an angle dimension drives a joined profile: the triangle's area, and the extruded solid's volume, follow the angle",
    run: async () => {
      let project = triangle();
      const sideLength = lengthOf(get(project, "side", "line"));
      project = setAngle(project, "base", "side", 120);
      const a = get(project, "base", "line");
      const b = get(project, "side", "line");
      const c = get(project, "close", "line");
      near(angleBetweenLinesDeg(a, b), 120, 1e-6, "the corner holds 120 degrees");
      near(lengthOf(b), sideLength, 1e-6, "the side kept its length");
      near(b.end[0], c.start[0], 1e-6, "the closing line follows the apex (x)");
      near(b.end[1], c.start[1], 1e-6, "the closing line follows the apex (y)");
      near(c.end[0], 0, 1e-6, "and still ends on the base start");
      const expectedArea = 0.5 * 10 * sideLength * Math.sin((120 * Math.PI) / 180);
      near(shoelaceArea([a.start, a.end, b.end]), expectedArea, 1e-6, "triangle area is half base times side times sin(angle)");

      const committed = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketchFeature = designOf(committed).features[0]!;
      assert(sketchFeature.kind === "sketch", "the sketch is on the timeline");
      const solid = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude" as const, suppressed: false, sketchFeatureId: sketchFeature.id, profileIds: [], valueMm: 7, bodyId: "general-body:angled" };
      const first = await rebuildSolidFeature(solid, sketchFeature);
      assert(first.ok, `the angled profile extrudes: ${first.ok ? "" : first.message}`);
      near(volumeOf(first.body.positionsMm, first.body.indices), expectedArea * 7, expectedArea * 7 * 0.01, "the solid's volume is the area times the height");

      // Reopen the sketch, change the angle, finish it again: the same step rebuilds with the new volume.
      let edited = run(committed, { kind: "edit-design-sketch", featureId: sketchFeature.id });
      edited = setAngle(edited, "base", "side", 90);
      edited = run(edited, { kind: "commit-design-sketch", featureId: sketchFeature.id, name: "Sketch 1" });
      const second = await rebuildSolidFeature(solid, designOf(edited).features[0] as typeof sketchFeature);
      assert(second.ok, "the edited profile extrudes");
      const rightAngled = 0.5 * 10 * sideLength;
      near(volumeOf(second.body.positionsMm, second.body.indices), rightAngled * 7, rightAngled * 7 * 0.01, "at 90 degrees the area is half base times side");
    }
  },
  {
    name: "a driven (reference) angle never moves geometry, reads the live value, and follows a driving dimension elsewhere",
    run: () => {
      const start = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])]);
      const driven = setAngle(start, "a", "b", 0, { driven: true });
      const reference = driven.sketch.constraints.find((constraint) => constraint.kind === "angle");
      assert(reference !== undefined && reference.driven === true, "the reference angle is recorded as driven");
      assert(reference.valueDeg === undefined && reference.valueMm === undefined, "it carries no value of its own");
      equal(JSON.stringify(driven.sketch.entities), JSON.stringify(start.sketch.entities), "making it a reference moved nothing");
      near(measureDimensionConstraint(driven.sketch, reference)!, 45, 1e-9, "it measures 45 degrees");
      // A driving angle on the same pair replaces the reference, and a driving length changes what the reference would read.
      const lengthened = run(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])], driven.sketch.constraints), { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 20 });
      near(measureDimensionConstraint(lengthened.sketch, reference)!, 45, 1e-9, "changing a length alone leaves the angle where it was");
      const rotated = run(driven, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 20 });
      equal(rotated.sketch.constraints.length, 2, "the reference stays and the length dimension is added");
      // Re-driving the same angle turns the reference into a driving dimension.
      const redriven = setAngle(driven, "a", "b", 80);
      const angles = redriven.sketch.constraints.filter((constraint) => constraint.kind === "angle");
      equal(angles.length, 1, "still one angle dimension");
      assert(angles[0]!.driven === undefined && angles[0]!.valueDeg === 80, "it is driving now, at 80 degrees");
      near(angleBetweenLinesDeg(get(redriven, "a", "line"), get(redriven, "b", "line")), 80, 1e-9, "and the line turned to it");
      // Back to a reference: the geometry stays at 80.
      const back = setAngle(redriven, "a", "b", 0, { driven: true });
      near(angleBetweenLinesDeg(get(back, "a", "line"), get(back, "b", "line")), 80, 1e-9, "turning it back into a reference keeps the geometry");
      assert(back.sketch.constraints.find((constraint) => constraint.kind === "angle")?.driven === true, "recorded as driven again");
    }
  },
  {
    name: "a driven dimension takes no freedom out of the sketch, a driving one does",
    run: () => {
      const start = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])]);
      const free = analyzeWorkbenchSketch(start.sketch).degreesOfFreedom;
      const referenced = analyzeWorkbenchSketch(setAngle(start, "a", "b", 0, { driven: true }).sketch).degreesOfFreedom;
      const driving = analyzeWorkbenchSketch(setAngle(start, "a", "b", 30).sketch).degreesOfFreedom;
      equal(referenced, free, "a reference angle removes no degrees of freedom");
      equal(driving, free - 1, "a driving angle removes one");
    }
  },
  {
    name: "a driving arc length sweeps the arc to the length with the radius and start held, for counter-clockwise and clockwise arcs",
    run: () => {
      for (const clockwise of [false, true]) {
        const start = projectWith([arcOf("arc", 10, 0, 90, clockwise)]);
        const before = get(start, "arc", "arc");
        const anchor = clockwise ? before.end : before.start;
        const wanted = 25;
        const project = run(start, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "arc-length", valueMm: wanted });
        const arc = get(project, "arc", "arc");
        near(entityLengthMm(arc)!, wanted, 1e-9, `the arc is now ${wanted} mm long (${clockwise ? "clockwise" : "counter-clockwise"})`);
        const shape = arcShape(arc.start, arc.mid, arc.end)!;
        near(shape.radiusMm, 10, 1e-9, "the radius was held");
        near(shape.center[0], 0, 1e-9, "the centre did not move");
        const held = clockwise ? arc.end : arc.start;
        near(held[0], anchor[0], 1e-9, "the end that stays put kept x");
        near(held[1], anchor[1], 1e-9, "and y");
        near(shape.sweepRad * 10, wanted, 1e-9, "sweep times radius is the length");
        // The middle point lies on the circle and between the ends.
        near(Math.hypot(arc.mid[0], arc.mid[1]), 10, 1e-9, "the middle point is still on the circle");
        const longer = run(project, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "arc-length", valueMm: 40 });
        near(entityLengthMm(get(longer, "arc", "arc"))!, 40, 1e-9, "editing the length sweeps it further");
        const shorter = run(longer, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "arc-length", valueMm: 5 });
        near(entityLengthMm(get(shorter, "arc", "arc"))!, 5, 1e-9, "and back in");
        const again = solveLiveSketch(shorter.sketch);
        assert(again.ok && again.movedIds.length === 0, "solving the sketch again moves nothing: the arc already holds its length");
      }
    }
  },
  {
    name: "an arc length works together with a radius dimension, and an arc cannot be set longer than its circle",
    run: () => {
      let project = projectWith([arcOf("arc", 10, 0, 90)]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "radius", valueMm: 20 });
      near(arcShape(get(project, "arc", "arc").start, get(project, "arc", "arc").mid, get(project, "arc", "arc").end)!.radiusMm, 20, 1e-9, "the arc took the radius dimension");
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "arc-length", valueMm: 30 });
      const arc = get(project, "arc", "arc");
      const shape = arcShape(arc.start, arc.mid, arc.end)!;
      near(shape.radiusMm, 20, 1e-9, "the radius stayed at the dimensioned value");
      near(shape.radiusMm * shape.sweepRad, 30, 1e-9, "and the length is 30");
      // Changing the radius afterwards re-holds the length: same length, new sweep.
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "radius", valueMm: 15 });
      const resized = get(project, "arc", "arc");
      const resizedShape = arcShape(resized.start, resized.mid, resized.end)!;
      near(resizedShape.radiusMm, 15, 1e-9, "the radius changed");
      near(resizedShape.radiusMm * resizedShape.sweepRad, 30, 1e-6, "and the arc length is still held at 30");
      const message = refused(project, { kind: "set-sketch-dimension", entityId: "entity:arc", dimension: "arc-length", valueMm: 2 * Math.PI * 15 + 1 });
      assert(/circle/u.test(message), `the refusal explains the arc cannot pass a full circle: ${message}`);
      refused(projectWith([line("l", [0, 0], [5, 0])]), { kind: "set-sketch-dimension", entityId: "entity:l", dimension: "arc-length", valueMm: 5 });
    }
  },
  {
    name: "a driven arc length measures an arc, a line and a spline, and a driven perimeter sums a chain of curves",
    run: () => {
      const spline: SketchEntity = { id: "entity:s", kind: "spline", fitPoints: [[0, 0], [10, 6], [20, 0], [30, 5]], construction: false };
      const entities: SketchEntity[] = [arcOf("arc", 10, 0, 180), line("l", [0, 20], [3, 24]), spline, line("p", [0, 0], [10, 0]), line("q", [10, 0], [10, 5]), { id: "entity:r", kind: "rectangle", center: [50, 50], widthMm: 4, heightMm: 6, rotationDeg: 0, construction: false }];
      let project = projectWith(entities);
      for (const id of ["arc", "l", "s"]) {
        project = run(project, { kind: "set-sketch-dimension", entityId: `entity:${id}`, dimension: "arc-length", valueMm: 1, driven: true });
      }
      const measure = (id: string): number => measureDimensionConstraint(project.sketch, project.sketch.constraints.find((constraint) => constraint.entityIds[0] === `entity:${id}` && constraint.kind === "arc-length")!)!;
      near(measure("arc"), Math.PI * 10, 1e-9, "a half circle of radius 10 is pi times 10 long");
      near(measure("l"), 5, 1e-9, "a 3-4-5 line is 5 long");
      const splineEntity = entities[2] as Extract<SketchEntity, { kind: "spline" }>;
      const polyline = sampleSpline(splineEntity.fitPoints, 64);
      let polylineLength = 0;
      for (let i = 1; i < polyline.length; i += 1) polylineLength += Math.hypot(polyline[i]![0] - polyline[i - 1]![0], polyline[i]![1] - polyline[i - 1]![1]);
      near(measure("s"), polylineLength, polylineLength * 1e-3, "the spline length agrees with a fine polyline of the drawn curve");
      near(measure("s"), splineLengthMm(splineEntity.fitPoints), 1e-12, "and with the spline module");
      equal(JSON.stringify(project.sketch.entities), JSON.stringify(entities), "no reference dimension moved anything");

      const chain = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:chain-perimeter", kind: "perimeter", entityIds: ["entity:p", "entity:q"], driven: true } });
      near(measureDimensionConstraint(chain.sketch, chain.sketch.constraints.find((constraint) => constraint.id === "constraint:chain-perimeter")!)!, 15, 1e-9, "the chain of two lines is 15 long");
      const rectangle = run(chain, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "perimeter", valueMm: 1, driven: true });
      near(measureDimensionConstraint(rectangle.sketch, rectangle.sketch.constraints.find((constraint) => constraint.entityIds[0] === "entity:r")!)!, 20, 1e-9, "a 4 by 6 rectangle has perimeter 20");
    }
  },
  {
    name: "a driving perimeter resizes a circle, a rectangle (keeping a held side) and an ellipse, and is re-held when the sketch is solved again",
    run: () => {
      const circle: SketchEntity = { id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 3, construction: false };
      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [30, 0], widthMm: 10, heightMm: 20, rotationDeg: 0, construction: false };
      const ellipse: SketchEntity = { id: "entity:e", kind: "ellipse", center: [60, 0], majorRadiusMm: 10, minorRadiusMm: 4, rotationDeg: 0, construction: false };
      let project = projectWith([circle, rectangle, ellipse]);

      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "perimeter", valueMm: 100 });
      near(get(project, "c", "circle").radiusMm, 100 / (2 * Math.PI), 1e-9, "the circle's radius is the perimeter over two pi");
      near(entityLengthMm(get(project, "c", "circle"))!, 100, 1e-9, "its circumference is 100");

      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "perimeter", valueMm: 90 });
      const scaled = get(project, "r", "rectangle");
      near(2 * (scaled.widthMm + scaled.heightMm), 90, 1e-9, "the rectangle has perimeter 90");
      near(scaled.heightMm / scaled.widthMm, 2, 1e-9, "with no side held, it scaled uniformly and kept its proportions");

      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 15 });
      const held = get(project, "r", "rectangle");
      near(held.widthMm, 15, 1e-9, "the width dimension took");
      near(2 * (held.widthMm + held.heightMm), 90, 1e-9, "and the perimeter is still 90: the free side absorbed the change");
      near(held.heightMm, 30, 1e-9, "so the height is 30");

      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:e", dimension: "perimeter", valueMm: 80 });
      const ring = get(project, "e", "ellipse");
      near(entityLengthMm(ring)!, 80, 1e-9, "the ellipse has perimeter 80");
      near(ring.majorRadiusMm / ring.minorRadiusMm, 2.5, 1e-9, "scaled uniformly, so its shape is unchanged");

      const again = solveLiveSketch(project.sketch);
      assert(again.ok && again.movedIds.length === 0, "solving the sketch again moves nothing: every dimension already holds");
      const message = refused(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "perimeter", valueMm: 20 });
      assert(message.length > 0, "a perimeter too small for the held width is refused");
    }
  },
  {
    name: "a rectangle whose width, height and perimeter all hold but disagree is a conflict, not silently resolved",
    run: () => {
      let project = projectWith([{ id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 10, heightMm: 20, rotationDeg: 0, construction: false }]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 10 });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "height", valueMm: 20 });
      const message = refused(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "perimeter", valueMm: 70 });
      // The solver now names the relations that contradict each other instead of describing a pass count.
      assert(/contradict/u.test(message) && /Perimeter 70/u.test(message) && /Width 10/u.test(message) && /Height 20/u.test(message), `names the three dimensions that disagree: ${message}`);
      const consistent = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "perimeter", valueMm: 60 });
      near(2 * (get(consistent, "r", "rectangle").widthMm + get(consistent, "r", "rectangle").heightMm), 60, 1e-9, "a consistent perimeter is accepted");
    }
  },
  {
    name: "malformed angle, arc-length and driven constraints are rejected by validation, and survive a save-and-load round trip when well formed",
    run: () => {
      const base = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])]);
      const withConstraint = (constraint: WorkbenchSketchConstraint): boolean => validateWorkbenchProject({ ...base, sketch: { ...base.sketch, constraints: [constraint] } }).ok;
      assert(withConstraint({ id: "constraint:ok", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 45 }), "a driving angle validates");
      assert(withConstraint({ id: "constraint:ok", kind: "angle", entityIds: ["entity:a", "entity:b"], driven: true }), "a driven angle validates");
      assert(!withConstraint({ id: "constraint:bad", kind: "angle", entityIds: ["entity:a", "entity:b"] }), "a driving angle needs its value");
      assert(!withConstraint({ id: "constraint:bad", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 400 }), "an angle of 400 degrees is out of range");
      // One entity is a valid angle record (an ellipse's rotation); whether it fits its curve is the operation's rule, not the schema's.
      assert(withConstraint({ id: "constraint:ok-one", kind: "angle", entityIds: ["entity:a"], valueDeg: 20 }), "a single-entity angle record is well formed");
      assert(!withConstraint({ id: "constraint:bad", kind: "angle", entityIds: ["entity:a", "entity:b", "entity:a"], valueDeg: 20 }), "an angle names at most two entities");
      const oneLine = applyWorkbenchOperation(base, { kind: "add-sketch-constraint", operationId: "operation:test-angle-one-line", expectedRevision: base.revision, constraint: { id: "constraint:angle-one", kind: "angle", entityIds: ["entity:a"], valueDeg: 20 } });
      assert(!oneLine.ok && /two lines/u.test(oneLine.diagnostics[0]?.message ?? ""), "an angle on one line is refused with the reason");
      assert(!withConstraint({ id: "constraint:bad", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 20, driven: true }), "a driven dimension carries no value");
      assert(!withConstraint({ id: "constraint:bad", kind: "horizontal", entityIds: ["entity:a"], driven: true }), "only dimensions can be driven");
      assert(!withConstraint({ id: "constraint:bad", kind: "arc-length", entityIds: ["entity:a"], valueMm: -4 }), "a negative arc length is rejected");
      assert(withConstraint({ id: "constraint:ok", kind: "arc-length", entityIds: ["entity:a"], valueMm: 12 }), "an arc length validates");
      const rounded = JSON.parse(JSON.stringify(setAngle(base, "a", "b", 72)));
      assert(validateWorkbenchProject(rounded).ok, "the project with an angle dimension survives a JSON round trip");
    }
  },
  {
    name: "the dimension layouts: an angle arc sweeps the stated angle about the corner, an arc length stands off its arc, a reference is bracketed",
    run: () => {
      const a = line("a", [0, 0], [40, 0]);
      const b = line("b", [0, 0], [20, 20]);
      const angle = angleDimensionLayout(a, b, 45, 0.5)!;
      assert(angle.arc !== undefined, "an angle dimension line is an arc");
      near(angle.arc.center[0], 0, 1e-9, "centred on the corner (x)");
      near(angle.arc.center[1], 0, 1e-9, "centred on the corner (y)");
      near(angle.arc.fromRad, 0, 1e-12, "starting along line A");
      near(angle.arc.sweepRad, Math.PI / 4, 1e-12, "sweeping 45 degrees");
      near(angle.arc.radiusMm / 0.5, 52, 1e-9, "its radius is a fixed number of screen pixels at any zoom");
      equal(angle.label, "45°", "labelled in degrees");
      equal(angle.arrows.length, 2, "an arrow at each end");
      near(angle.arrows[1]!.direction[0], -Math.sin(Math.PI / 4), 1e-12, "the far arrow points along the sweep (x)");
      near(angle.arrows[1]!.direction[1], Math.cos(Math.PI / 4), 1e-12, "the far arrow points along the sweep (y)");
      const reference = angleDimensionLayout(a, b, 45, 0.5, true)!;
      equal(reference.label, "(45°)", "a driven angle is drawn in brackets");
      equal(reference.reference, true, "and flagged as a reference");
      // Lines that cross away from their ends get extension lines out to the crossing.
      const far = angleDimensionLayout(line("c", [10, 0], [30, 0]), line("d", [10, 10], [20, 20]), 45, 0.5)!;
      near(far.arc!.center[0], 0, 1e-9, "centred on the crossing of the two lines");
      equal(far.extensionLines.length, 2, "both lines are extended to the crossing");

      const arc = arcOf("arc", 10, 0, 90);
      const length = arcLengthDimensionLayout(arc, Math.PI * 5, 0.5)!;
      near(length.arc!.radiusMm, 10 + 30 * 0.5, 1e-9, "the dimension arc stands off the arc by 30 pixels");
      near(length.arc!.sweepRad, Math.PI / 2, 1e-9, "and sweeps the same angle");
      assert(length.label.includes("15.708"), `labelled with the length: ${length.label}`);
      const clockwise = arcLengthDimensionLayout(arcOf("cw", 10, 0, 90, true), Math.PI * 5, 0.5)!;
      near(clockwise.arc!.fromRad, 0, 1e-9, "a clockwise arc is described from its counter-clockwise start");
      near(clockwise.arc!.sweepRad, Math.PI / 2, 1e-9, "with the same sweep");
      const viaEntity = dimensionLayout(arc, "arc-length", Math.PI * 5, 0.5);
      assert(viaEntity?.arc !== undefined, "dimensionLayout dispatches arc-length on an arc");

      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 10, heightMm: 20, rotationDeg: 0, construction: false };
      const perimeter = perimeterDimensionLayout(rectangle, 60, 0.5)!;
      equal(perimeter.label, "P 60", "a perimeter reads P and the value");
      near(perimeter.dimensionLine.from[0], 5, 1e-9, "its leader starts on the outline's corner (x)");
      near(perimeter.dimensionLine.from[1], 10, 1e-9, "its leader starts on the outline's corner (y)");
      assert(perimeterDimensionLayout({ id: "entity:l", kind: "line", start: [0, 0], end: [1, 0], construction: false }, 1, 0.5) === undefined, "a line has no perimeter dimension");
    }
  }
];
