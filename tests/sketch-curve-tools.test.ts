import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import type { SketchEntity, Vec2, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles, isShapeTool, requiredSketchPoints, sampleArc, sampleSpline, selectTangentSketchEntities, sketchToolLabel, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { buildCenterline, buildCenterpointArcSlot, buildMidpointLine, buildParallelogram, buildRoundedRectangle, buildThreePointArcSlot, maxRoundedCornerRadius } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { buildBlendCurve, curveEnds, extendProfileChain, startProfileChain, tangentArcFrom, type ProfileChain } from "../packages/workbench-sketch/src/blend-profile.js";
import { buildConicByRho, buildConicFromFivePoints, buildControlPointSpline, buildHyperbola, buildParabola, conicArcPoint, controlPointCurve, fitConicThroughFivePoints } from "../packages/workbench-sketch/src/conic-curves.js";
import { buildCurveTool, CURVE_TOOL_LABELS, DEFAULT_CURVE_TOOL_OPTIONS, curveToolRequiredPoints, isCurveTool, isFixedCurveTool, type CurveToolId, type FixedCurveToolId } from "../packages/workbench-sketch/src/curve-tools.js";
import type { ShapeIds, SketchShape } from "../packages/workbench-sketch/src/shapes.js";
import { resolveSketchHotkey, type SketchHotkeyContext } from "../packages/workbench-sketch/src/hotkeys.js";
import { createBlockLibrary, insertSketchBlock, makeSketchBlock, type BlockStorage } from "../packages/workbench-sketch/src/sketch-blocks.js";
import { buildSketchText, glyphWidthUnits, STROKE_FONT_CHARACTERS, unsupportedTextCharacters } from "../packages/workbench-sketch/src/stroke-text.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const ids: ShapeIds = { entity: () => `entity:curve-${(counter += 1)}`, constraint: () => `constraint:curve-${(counter += 1)}` };

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-curve-tools");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

/** Adds a shape through the real operation path (validated twice, solved against its relations) and returns the new project. */
function addThrough(project: WorkbenchProject, shape: SketchShape, label = "Added a curve shape"): WorkbenchProject {
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:curve-${(counter += 1)}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label });
  if (!applied.ok) throw new Error(`the sketch edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
  const revalidated = validateWorkbenchProject(JSON.parse(JSON.stringify(applied.value.project)) as unknown);
  if (!revalidated.ok) throw new Error(`the project no longer validates: ${revalidated.diagnostics[0]?.message ?? "no reason"}`);
  return applied.value.project;
}

function boundsOfEntitiesForText(entities: readonly SketchEntity[]): number {
  const box = boundsOf(entities);
  return box.max[1] - box.min[1];
}

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...emptyProject().sketch, entities, constraints: [] };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

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

/**
 * Extrudes the (single) profile of a sketch through the real extrude path and returns the mesh volume. The profile area is exact
 * (arcs are integrated, not faceted) while the mesh is the facet polygon, so the volume sits a chord-error bound (0.2 percent) below area x height.
 */
async function extrudedVolume(entities: readonly SketchEntity[], heightMm: number): Promise<{ readonly volume: number; readonly area: number }> {
  const profile = detectSketchProfiles(sketchOf(entities));
  equal(profile.length, 1, "exactly one closed profile to extrude");
  const result = await createGeneralSolidBody({ profile: profile[0]!, plane: "xy", operation: "extrude", valueMm: heightMm, bodyId: "general-body:curve", name: "Curve", color: "#b9c2c8" });
  assert(result.ok, "the profile extrudes");
  return { volume: meshVolumeMm3(result.body.positionsMm, result.body.indices), area: profile[0]!.areaMm2 };
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function boundsOf(entities: readonly SketchEntity[]): { readonly min: Vec2; readonly max: Vec2 } {
  const points: Vec2[] = [];
  for (const entity of entities) {
    if (entity.kind === "line") points.push(entity.start, entity.end);
    else if (entity.kind === "arc") points.push(...sampleArc(entity.start, entity.mid, entity.end));
    else if (entity.kind === "spline") points.push(...sampleSpline(entity.fitPoints));
  }
  return { min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))], max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))] };
}

const lineOf = (entity: SketchEntity | undefined): Extract<SketchEntity, { kind: "line" }> => {
  if (entity?.kind !== "line") throw new Error("expected a line");
  return entity;
};
const splineOf = (entity: SketchEntity | undefined): Extract<SketchEntity, { kind: "spline" }> => {
  if (entity?.kind !== "spline") throw new Error("expected a spline");
  return entity;
};

export const sketchCurveToolTests: readonly TestCase[] = [
  // ------------------------------------------------------------------ priority 1
  {
    name: "midpoint line: the click is the centre, the line grows symmetrically, and resizing it keeps it centred",
    run: () => {
      const shape = must(buildMidpointLine([10, 5], [16, 13], ids));
      const line = lineOf(shape.entities[0]);
      near(line.end[0], 16, 1e-12, "one end is the click");
      near(line.start[0], 4, 1e-12, "the other end is the mirror image (x)");
      near(line.start[1], -3, 1e-12, "the other end is the mirror image (y)");
      const anchor = shape.entities[1]!;
      assert(anchor.kind === "point" && anchor.construction, "a construction point marks the centre");
      equal(shape.constraints[0]?.kind, "midpoint", "and a Midpoint relation ties the line to it");
      const project = addThrough(emptyProject(), shape);
      const resized = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: "operation:curve-resize-midpoint", expectedRevision: project.revision, entityId: line.id, dimension: "length", valueMm: 40 });
      assert(resized.ok, `the midpoint line takes a length: ${resized.ok ? "" : resized.diagnostics[0]?.message ?? ""}`);
      const after = lineOf(resized.value.project.sketch.entities.find((entity) => entity.id === line.id));
      near(dist(after.start, after.end), 40, 1e-6, "the line now has the new length");
      const anchorAfter = resized.value.project.sketch.entities.find((entity) => entity.id === shape.entities[1]!.id);
      assert(anchorAfter?.kind === "point", "the centre point is still there");
      if (anchorAfter?.kind === "point") {
        near(anchorAfter.point[0], (after.start[0] + after.end[0]) / 2, 1e-6, "the Midpoint relation still holds after the resize (x)");
        near(anchorAfter.point[1], (after.start[1] + after.end[1]) / 2, 1e-6, "the Midpoint relation still holds after the resize (y)");
      }
      assert(!buildMidpointLine([0, 0], [0.01, 0], ids).ok, "a line of no length is refused");
    }
  },
  {
    name: "centerline: a long construction line through the two points that bounds no profile",
    run: () => {
      const shape = must(buildCenterline([10, 10], [20, 20], 500, ids));
      const line = lineOf(shape.entities[0]);
      assert(line.construction, "it is construction geometry");
      near(dist(line.start, line.end), 1000, 1e-6, "it reaches 500 mm each way");
      near((line.start[0] + line.end[0]) / 2, 10, 1e-9, "centred on the first point (x)");
      near((line.end[1] - line.start[1]) / (line.end[0] - line.start[0]), 1, 1e-9, "along the direction of the two clicks");
      equal(detectSketchProfiles(sketchOf(shape.entities)).length, 0, "construction geometry never makes a profile");
      assert(!buildCenterline([0, 0], [0, 0], 500, ids).ok, "two equal points have no direction");
      const project = addThrough(emptyProject(), shape);
      assert(project.sketch.entities[0]?.construction === true, "and it survives the operation path as construction");
    }
  },
  {
    name: "parallelogram: four joined sides, opposite sides parallel, area from the three corners",
    run: async () => {
      const shape = must(buildParallelogram([0, 0], [30, 0], [40, 20], ids));
      equal(shape.entities.length, 4, "four sides");
      const fourth = lineOf(shape.entities[2]);
      near(fourth.start[0], 10, 1e-12, "the fourth corner completes the figure (x)");
      near(fourth.start[1], 20, 1e-12, "the fourth corner completes the figure (y)");
      equal(shape.constraints.filter((constraint) => constraint.kind === "parallel").length, 2, "two parallel pairs");
      equal(shape.constraints.filter((constraint) => constraint.kind === "coincident").length, 4, "four joints");
      const project = addThrough(emptyProject(), shape);
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "one closed profile");
      near(profiles[0]!.areaMm2, 30 * 20, 1e-6, "base times height");
      const solid = await extrudedVolume(project.sketch.entities, 7);
      near(solid.volume, 30 * 20 * 7, 1e-6, "extrudes to the exact prism volume");
      assert(!buildParallelogram([0, 0], [10, 0], [20, 0], ids).ok, "three collinear corners are refused");
    }
  },
  {
    name: "rounded rectangle: lines and arcs with the exact area, tangent relations, and an exact extrusion",
    run: async () => {
      const shape = must(buildRoundedRectangle([40, 25], [0, 0], 6, ids));
      equal(shape.entities.filter((entity) => entity.kind === "line").length, 4, "four straight sides");
      equal(shape.entities.filter((entity) => entity.kind === "arc").length, 4, "four corner arcs");
      equal(shape.constraints.filter((constraint) => constraint.kind === "tangent").length, 8, "eight tangent joints");
      const project = addThrough(emptyProject(), shape);
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "one closed profile");
      const expected = 40 * 25 - (4 - Math.PI) * 36;
      near(profiles[0]!.areaMm2, expected, expected * 0.002, "area is the rectangle less the four corner gaps");
      const box = boundsOf(shape.entities);
      near(box.max[0] - box.min[0], 40, 1e-9, "overall width");
      near(box.max[1] - box.min[1], 25, 1e-9, "overall height");
      const solid = await extrudedVolume(project.sketch.entities, 4);
      near(solid.volume, solid.area * 4, solid.area * 4 * 2e-3, "extrudes to profile area times height");
      near(maxRoundedCornerRadius(40, 25), 12.48, 1e-9, "the limit is just under half the short side");
      const tooBig = buildRoundedRectangle([0, 0], [40, 25], 13, ids);
      assert(!tooBig.ok, "a radius that leaves no straight side is refused");
      assert(!tooBig.ok && /most it can take/u.test(tooBig.diagnostics[0]!.message), "and the message states the limit");
      assert(!buildRoundedRectangle([0, 0], [40, 25], 0, ids).ok, "no radius at all is refused (use the plain rectangle)");
    }
  },
  // ------------------------------------------------------------------ priority 2: slots
  {
    name: "3-point arc slot: an annular sector with half-disc caps, area and extrusion exact, relations apply",
    run: async () => {
      // A quarter-turn centreline of radius 30 around the origin, half-width 4.
      const shape = must(buildThreePointArcSlot([30, 0], [30 * Math.SQRT1_2, 30 * Math.SQRT1_2], [0, 30], [34, 0], ids));
      equal(shape.entities.map((entity) => entity.kind).join(","), "arc,arc,arc,arc", "outer arc, cap, inner arc, cap");
      equal(shape.constraints.map((constraint) => constraint.kind).sort().join(), "coincident,coincident,coincident,coincident,concentric,equal,tangent,tangent,tangent,tangent", "four joints (the arcs are joined by their real ends), a Tangent at each joint, equal caps and concentric side arcs");
      const project = addThrough(emptyProject(), shape);
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "closes into one profile");
      // Each joint is tangent: the cap leaves the side arc along its direction.
      const sides = project.sketch.entities;
      const joint = (a: SketchEntity, b: SketchEntity): number => {
        const ends = curveEnds(a).flatMap((left) => curveEnds(b).map((right) => ({ left, right }))).find(({ left, right }) => dist(left.point, right.point) < 1e-9);
        if (ends === undefined) throw new Error("the two arcs do not share an end");
        return (Math.acos(Math.max(-1, Math.min(1, -(ends.left.outward[0] * ends.right.outward[0] + ends.left.outward[1] * ends.right.outward[1])))) * 180) / Math.PI;
      };
      for (let index = 0; index < 4; index += 1) near(joint(sides[index]!, sides[(index + 1) % 4]!), 0, 1e-6, `joint ${index + 1} is tangent`);
      const R = 30;
      const h = 4;
      const expected = (Math.PI / 2) * ((R + h) ** 2 - (R - h) ** 2) / 2 + Math.PI * h * h;
      near(profiles[0]!.areaMm2, expected, expected * 0.004, "annular sector plus two half discs");
      const solid = await extrudedVolume(project.sketch.entities, 5);
      near(solid.volume, solid.area * 5, solid.area * 5 * 2e-3, "extrudes cleanly");
      // The same slot drawn the other way round (clockwise) still closes and has the same area.
      const clockwise = must(buildThreePointArcSlot([0, 30], [30 * Math.SQRT1_2, 30 * Math.SQRT1_2], [30, 0], [0, 26], ids));
      near(detectSketchProfiles(sketchOf(clockwise.entities))[0]!.areaMm2, expected, expected * 0.004, "direction does not change the slot");
      assert(!buildThreePointArcSlot([0, 0], [10, 0], [20, 0], [10, 3], ids).ok, "collinear centreline points are refused");
      const tooWide = buildThreePointArcSlot([30, 0], [30 * Math.SQRT1_2, 30 * Math.SQRT1_2], [0, 30], [0.01, 0], ids);
      assert(!tooWide.ok, "a width that swallows the bend radius is refused");
    }
  },
  {
    name: "centerpoint arc slot: centre, start, end direction and width; a 3/4-turn bend and a small one",
    run: () => {
      const shape = must(buildCenterpointArcSlot([0, 0], [20, 0], [0, 25], [23, 0], ids));
      const project = addThrough(emptyProject(), shape);
      const profile = detectSketchProfiles(project.sketch);
      equal(profile.length, 1, "one profile");
      const R = 20;
      const h = 3;
      const expected = (Math.PI / 2) * ((R + h) ** 2 - (R - h) ** 2) / 2 + Math.PI * h * h;
      near(profile[0]!.areaMm2, expected, expected * 0.004, "quarter bend area");
      const reverse = must(buildCenterpointArcSlot([0, 0], [20, 0], [0, -25], [23, 0], ids));
      near(detectSketchProfiles(sketchOf(reverse.entities))[0]!.areaMm2, expected, expected * 0.004, "the other way round has the same area");
      assert(!buildCenterpointArcSlot([0, 0], [0.01, 0], [0, 5], [1, 0], ids).ok, "a tiny bend radius is refused");
      assert(!buildCenterpointArcSlot([0, 0], [20, 0], [0, 25], [20, 0], ids).ok, "a width point on the centreline is refused");
    }
  },
  // ------------------------------------------------------------------ priority 3: splines and conics
  {
    name: "control-point spline: starts and ends on the end control points and follows the B-spline, not just the polygon",
    run: () => {
      const controls: readonly Vec2[] = [[0, 0], [10, 40], [30, 40], [40, 0], [60, -20]];
      const shape = must(buildControlPointSpline(controls, false, false, ids));
      const spline = splineOf(shape.entities[0]);
      equal(spline.fitPoints[0]![0], 0, "starts on the first control point");
      equal(spline.fitPoints[spline.fitPoints.length - 1]![0], 60, "ends on the last control point");
      assert(spline.fitPoints.length >= 10 && spline.fitPoints.length <= 24, "a sensible number of fit points");
      const exact = controlPointCurve(controls, false, 2000);
      const drawn = sampleSpline(spline.fitPoints, 16);
      let worst = 0;
      for (const point of drawn) worst = Math.max(worst, Math.min(...exact.map((candidate) => dist(point, candidate))));
      assert(worst < 0.6, `the drawn spline stays within 0.6 mm of the true B-spline (worst ${worst.toFixed(3)} mm)`);
      // The curve is pulled toward, but does not reach, the inner control points.
      assert(Math.max(...drawn.map((point) => point[1])) < 40 && Math.max(...drawn.map((point) => point[1])) > 20, "the bulge is between the polygon and the chord");
      const withPolygon = must(buildControlPointSpline(controls, false, true, ids));
      equal(withPolygon.entities.filter((entity) => entity.construction).length, 4, "the control polygon can be kept as 4 construction lines");
      assert(!buildControlPointSpline([[0, 0], [10, 0]], false, false, ids).ok, "two control points are not enough");
      assert(!buildControlPointSpline([[0, 0], [0, 0], [5, 5]], false, false, ids).ok, "coincident consecutive control points are refused");
      addThrough(emptyProject(), shape);
    }
  },
  {
    name: "closed control-point spline: two splines meeting at two points close into a profile that extrudes to its area",
    run: async () => {
      const controls: readonly Vec2[] = [[0, 0], [40, 0], [40, 30], [0, 30]];
      const shape = must(buildControlPointSpline(controls, true, false, ids));
      equal(shape.entities.length, 2, "cut into two splines so the loop is recognised");
      const project = addThrough(emptyProject(), shape);
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "one closed profile");
      // Area of the dense true curve by the shoelace formula.
      const dense = controlPointCurve(controls, true, 4000);
      let twice = 0;
      for (let index = 0; index < dense.length - 1; index += 1) twice += dense[index]![0] * dense[index + 1]![1] - dense[index + 1]![0] * dense[index]![1];
      const trueArea = Math.abs(twice) / 2;
      near(profiles[0]!.areaMm2, trueArea, trueArea * 0.01, "profile area matches the closed B-spline within 1 percent");
      assert(trueArea < 1200 && trueArea > 600, "and is a rounded shape inside the control polygon (1200 mm2)");
      const halves = project.sketch.entities.map((entity) => curveEnds(entity));
      const kink = (left: Vec2, right: Vec2): number => (Math.acos(Math.max(-1, Math.min(1, -(left[0] * right[0] + left[1] * right[1])))) * 180) / Math.PI;
      assert(kink(halves[0]![1]!.outward, halves[1]![0]!.outward) < 6 && kink(halves[1]![1]!.outward, halves[0]![0]!.outward) < 6, "the two joints between the halves are smooth to within 6 degrees");
      const solid = await extrudedVolume(project.sketch.entities, 6);
      near(solid.volume, solid.area * 6, solid.area * 6 * 2e-3, "extrudes to profile area times height");
    }
  },
  {
    name: "parabola: every point satisfies y = x^2/10 (the parabola through the ends, tangent to the chosen apex lines)",
    run: () => {
      const shape = must(buildParabola([-10, 10], [10, 10], [0, -10], ids));
      const spline = splineOf(shape.entities[0]);
      equal(spline.fitPoints.length, 32, "32 fit points (crowded where the conic bends, see T13)");
      for (const point of spline.fitPoints) near(point[1], (point[0] * point[0]) / 10, 1e-9, "fit point on the parabola");
      near(spline.fitPoints[0]![0], -10, 1e-12, "starts at the first point");
      near(spline.fitPoints[31]![0], 10, 1e-12, "ends at the second point");
      let worst = 0;
      for (const point of sampleSpline(spline.fitPoints, 12)) worst = Math.max(worst, Math.abs(point[1] - (point[0] * point[0]) / 10));
      assert(worst < 0.01, `the drawn curve stays within 0.01 mm of the parabola (worst ${worst.toFixed(4)})`);
      assert(!buildParabola([0, 0], [10, 0], [5, 0], ids).ok, "an apex on the chord has no bulge");
      addThrough(emptyProject(), shape);
    }
  },
  {
    name: "conic by rho: rho 0.4142 on a right-angle apex is a circular arc; rho moves the shoulder between chord and apex",
    run: () => {
      const rho = Math.SQRT2 - 1; // w = cos(45 deg) / (1 - ...) gives a circle for a quarter turn
      const w = Math.SQRT1_2;
      const circleRho = w / (1 + w);
      near(circleRho, rho, 1e-12, "the quarter-circle rho");
      const shape = must(buildConicByRho([20, 0], [0, 20], [20, 20], circleRho, ids));
      for (const point of splineOf(shape.entities[0]).fitPoints) near(Math.hypot(point[0], point[1]), 20, 1e-9, "every fit point is on the circle of radius 20");
      // Shoulder: the point halfway along the parameter sits rho of the way from the chord midpoint to the apex.
      const low = splineOf(must(buildConicByRho([0, 0], [40, 0], [20, 20], 0.3, ids)).entities[0]);
      const high = splineOf(must(buildConicByRho([0, 0], [40, 0], [20, 20], 0.8, ids)).entities[0]);
      const peak = (spline: Extract<SketchEntity, { kind: "spline" }>): number => Math.max(...spline.fitPoints.map((point) => point[1]));
      near(peak(low), 6, 0.05, "rho 0.3 puts the shoulder 6 mm above the chord");
      near(peak(high), 16, 0.2, "rho 0.8 puts the shoulder 16 mm above the chord");
      near(conicArcPoint([0, 0], [20, 20], [40, 0], 0.3, 0.5)[1], 6, 1e-12, "the exact shoulder (t = 1/2) is rho of the way to the apex");
      assert(!buildConicByRho([0, 0], [40, 0], [20, 20], 1, ids).ok, "rho of 1 is refused");
      assert(!buildConicByRho([0, 0], [40, 0], [20, 0], 0.5, ids).ok, "an apex on the chord is refused");
    }
  },
  {
    name: "hyperbola: the branch satisfies x^2/a^2 - y^2/b^2 = 1 and passes through the branch point and its mirror",
    run: () => {
      // Centre (5,5), vertex 6 mm along +x so a = 6, branch point at local (15, 12): b = 12 / sqrt(225/36 - 1)
      const shape = must(buildHyperbola([5, 5], [11, 5], [20, 17], ids));
      const spline = splineOf(shape.entities[0]);
      const a = 6;
      const b = 12 / Math.sqrt(225 / 36 - 1);
      for (const point of spline.fitPoints) {
        const x = point[0] - 5;
        const y = point[1] - 5;
        near((x * x) / (a * a) - (y * y) / (b * b), 1, 1e-9, "fit point on the hyperbola");
      }
      near(spline.fitPoints[spline.fitPoints.length - 1]![0], 20, 1e-6, "one end is the branch point (x)");
      near(spline.fitPoints[spline.fitPoints.length - 1]![1], 17, 1e-6, "one end is the branch point (y)");
      near(spline.fitPoints[0]![1], -7, 1e-6, "the other end is its mirror image");
      assert(!buildHyperbola([0, 0], [10, 0], [5, 3], ids).ok, "a branch point nearer than the vertex is refused");
      assert(!buildHyperbola([0, 0], [10, 0], [20, 0], ids).ok, "a branch point on the axis is refused");
      addThrough(emptyProject(), shape);
    }
  },
  {
    name: "conic through five points: an ellipse is recovered exactly, as a rotated ellipse entity",
    run: () => {
      const center: Vec2 = [12, -7];
      const a = 30;
      const b = 12;
      const rotation = (25 * Math.PI) / 180;
      const on = (t: number): Vec2 => [center[0] + a * Math.cos(t) * Math.cos(rotation) - b * Math.sin(t) * Math.sin(rotation), center[1] + a * Math.cos(t) * Math.sin(rotation) + b * Math.sin(t) * Math.cos(rotation)];
      const fitted = must(fitConicThroughFivePoints([0.3, 1.4, 2.6, 3.9, 5.2].map(on), "entity:conic-test"));
      equal(fitted.kind, "ellipse", "classified as an ellipse");
      const entity = fitted.entity;
      assert(entity.kind === "ellipse", "stored as an ellipse entity");
      if (entity.kind !== "ellipse") return;
      near(entity.center[0], 12, 1e-6, "centre x");
      near(entity.center[1], -7, 1e-6, "centre y");
      near(entity.majorRadiusMm, 30, 1e-6, "major radius");
      near(entity.minorRadiusMm, 12, 1e-6, "minor radius");
      near(entity.rotationDeg, 25, 1e-6, "rotation");
      const shape = must(buildConicFromFivePoints([0.3, 1.4, 2.6, 3.9, 5.2].map(on), ids));
      const project = addThrough(emptyProject(), shape);
      equal(detectSketchProfiles(project.sketch).length, 1, "a closed ellipse bounds a profile");
      // Five points of a circle give a circle-sized ellipse.
      const circle = must(fitConicThroughFivePoints([[10, 0], [0, 10], [-10, 0], [0, -10], [7.0710678, 7.0710678]], "entity:c"));
      assert(circle.entity.kind === "ellipse" && Math.abs(circle.entity.majorRadiusMm - 10) < 1e-5 && Math.abs(circle.entity.minorRadiusMm - 10) < 1e-5, "a circle has equal radii");
    }
  },
  {
    name: "conic through five points: a parabola and a hyperbola branch become splines through all five points; bad input is refused",
    run: () => {
      const parabola = must(fitConicThroughFivePoints([[-2, 4], [-1, 1], [0, 0], [1, 1], [2, 4]], "entity:p"));
      equal(parabola.kind, "parabola", "five points of y = x^2 are a parabola");
      const fitP = splineOf(parabola.entity).fitPoints;
      for (const point of fitP) near(point[1], point[0] * point[0], 1e-9, "fit points stay on y = x^2");
      near(fitP[0]![0], -2, 1e-9, "from the first extreme");
      near(fitP[fitP.length - 1]![0], 2, 1e-9, "to the other");
      // A hyperbola branch x^2/16 - y^2/9 = 1, right branch.
      const hyper = (t: number): Vec2 => [4 * Math.cosh(t), 3 * Math.sinh(t)];
      const hyperbola = must(fitConicThroughFivePoints([-1.2, -0.5, 0.1, 0.7, 1.3].map(hyper), "entity:h"));
      equal(hyperbola.kind, "hyperbola", "classified as a hyperbola");
      const fitH = splineOf(hyperbola.entity).fitPoints;
      for (const point of fitH) near((point[0] * point[0]) / 16 - (point[1] * point[1]) / 9, 1, 1e-6, "fit points stay on the hyperbola");
      const drawn = sampleSpline(fitH, 12);
      for (const t of [-1.2, -0.5, 0.1, 0.7, 1.3]) {
        const target = hyper(t);
        assert(Math.min(...drawn.map((point) => dist(point, target))) < 0.05, `the drawn curve passes within 0.05 mm of the point at t = ${t}`);
      }
      assert(!fitConicThroughFivePoints([[0, 0], [1, 1], [2, 2], [3, 3], [4, 5]], "entity:x").ok, "three collinear points have no single conic");
      assert(!fitConicThroughFivePoints([[0, 0], [10, 0], [20, 0], [0, 10], [20, 10]], "entity:y").ok, "points on two straight lines are refused");
      const bothBranches = fitConicThroughFivePoints([hyper(-1), hyper(1), hyper(0.4), [-4 * Math.cosh(0.5), 3 * Math.sinh(0.5)], [-4 * Math.cosh(1), 3 * Math.sinh(1)]], "entity:z");
      assert(!bothBranches.ok, "points on both branches are refused");
      assert(!fitConicThroughFivePoints([[0, 0], [1, 1], [2, 0]], "entity:w").ok, "fewer than five points are refused");
    }
  },
  // ------------------------------------------------------------------ priority 4: blend and profile
  {
    name: "blend curve: ties two line ends with the same direction at both joints, and the pieces chain as tangent",
    run: () => {
      const entities: readonly SketchEntity[] = [
        { id: "entity:left", kind: "line", start: [-20, 0], end: [0, 0], construction: false },
        { id: "entity:right", kind: "line", start: [30, 12], end: [50, 12], construction: false }
      ];
      const shape = must(buildBlendCurve(entities, [0.4, 0.3], [29.8, 11.9], 1, 3, ids));
      const blend = splineOf(shape.entities[0]);
      equal(blend.fitPoints[0]![0], 0, "starts exactly on the first line's end (x)");
      equal(blend.fitPoints[0]![1], 0, "starts exactly on the first line's end (y)");
      equal(blend.fitPoints[blend.fitPoints.length - 1]![0], 30, "ends exactly on the second line's start (x)");
      const ends = curveEnds(blend);
      const startAngle = Math.acos(Math.max(-1, Math.min(1, ends[0]!.outward[0] * -1)));
      const endAngle = Math.acos(Math.max(-1, Math.min(1, ends[1]!.outward[0] * 1)));
      // The blend leaves the first line along +x (its outward is -x) and arrives at the second line heading +x.
      assert((startAngle * 180) / Math.PI < 3, `leaves the first line within 3 degrees of its direction (${((startAngle * 180) / Math.PI).toFixed(2)})`);
      assert((endAngle * 180) / Math.PI < 3, `arrives at the second line within 3 degrees of its direction (${((endAngle * 180) / Math.PI).toFixed(2)})`);
      const project = addThrough(emptyProject(), { entities: [...entities, ...shape.entities], constraints: [] });
      const chain = selectTangentSketchEntities(project.sketch, "entity:left", 3, 0.01);
      equal(chain.length, 3, "the tangent chain from the first line runs through the blend into the second line");
      const tighter = must(buildBlendCurve(entities, [0, 0], [30, 12], 0.5, 3, ids));
      const looser = must(buildBlendCurve(entities, [0, 0], [30, 12], 2, 3, ids));
      const sag = (s: SketchShape): number => Math.max(...splineOf(s.entities[0]).fitPoints.map((p) => Math.abs(p[1] - 6 - (p[0] - 15) * 0.4)));
      assert(sag(looser) !== sag(tighter), "the tension changes the curve");
      assert(!buildBlendCurve(entities, [0, 0], [0.2, 0], 1, 3, ids).ok, "the same end twice is refused");
      assert(!buildBlendCurve(entities, [200, 200], [30, 12], 1, 3, ids).ok, "a click far from every curve end is refused");
    }
  },
  {
    name: "blend curve: bridges a line and an arc, and two blends close a loop into an extrudable profile",
    run: async () => {
      // Two horizontal bars joined at both ends by blends: a closed bean.
      const entities: SketchEntity[] = [
        { id: "entity:bar-top", kind: "line", start: [0, 20], end: [40, 20], construction: false },
        { id: "entity:bar-bottom", kind: "line", start: [40, 0], end: [0, 0], construction: false }
      ];
      const left = must(buildBlendCurve([entities[0]!, entities[1]!], [0, 20], [0, 0], 1, 3, ids));
      const leftSpline = splineOf(left.entities[0]);
      near(leftSpline.fitPoints[0]![0], 0, 1e-12, "left blend starts on the top bar's start");
      near(leftSpline.fitPoints[leftSpline.fitPoints.length - 1]![1], 0, 1e-12, "and ends on the bottom bar's end");
      assert(Math.min(...leftSpline.fitPoints.map((p) => p[0])) < -3, "it bulges out to the left, because both bars leave toward -x there");
      // A half-circle arc ending at (0,20) heading -x and a line starting at (-30,30) heading -x: the blend leaves left and arrives heading left.
      const arcEntities: SketchEntity[] = [
        { id: "entity:arc-a", kind: "arc", start: [0, 0], mid: [10, 10], end: [0, 20], construction: false },
        { id: "entity:line-b", kind: "line", start: [-30, 30], end: [-50, 30], construction: false }
      ];
      const arcBlend = must(buildBlendCurve(arcEntities, [0, 20], [-30, 30], 1, 3, ids));
      const arcBlendSpline = splineOf(arcBlend.entities[0]);
      const arcEnd = curveEnds(arcEntities[0]!)[1]!;
      const blendStart = curveEnds(arcBlendSpline)[0]!;
      const blendEnd = curveEnds(arcBlendSpline)[1]!;
      const lineStart = curveEnds(arcEntities[1]!)[0]!;
      const degreesBetween = (a: Vec2, b: Vec2): number => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
      assert(degreesBetween(arcEnd.outward, [-blendStart.outward[0], -blendStart.outward[1]]) < 2, "the blend leaves the arc along the arc's end direction");
      assert(degreesBetween(lineStart.outward, [-blendEnd.outward[0], -blendEnd.outward[1]]) < 2, "and arrives along the line's direction");
      equal(arcBlendSpline.fitPoints[0]![0], 0, "it starts on the arc end");
      equal(arcBlendSpline.fitPoints[23]![0], -30, "and ends on the line start");
      // Close a loop: bars + left blend + right blend (the right bars leave toward +x, so the blend bulges right).
      const rightBlend = must(buildBlendCurve([entities[0]!, entities[1]!], [40, 20], [40, 0], 1, 3, ids));
      const loop = [...entities, ...left.entities, ...rightBlend.entities];
      const solid = await extrudedVolume(loop, 3);
      assert(solid.area > 800, `the bean has an area of ${solid.area.toFixed(1)} mm2 (bars alone enclose 800)`);
      near(solid.volume, solid.area * 3, solid.area * 3 * 2e-3, "and extrudes to profile area times height");
    }
  },
  {
    name: "profile: lines and tangent arcs chain seamlessly, closing on the start into one extrudable profile",
    run: async () => {
      let chain: ProfileChain = startProfileChain([0, 0]);
      const placed: SketchEntity[] = [];
      let project = emptyProject();
      const steps: readonly { readonly point: Vec2; readonly mode: "line" | "tangent-arc" }[] = [
        { point: [40, 0], mode: "line" },
        { point: [60, 20], mode: "tangent-arc" },
        { point: [60, 40], mode: "line" },
        { point: [0, 40], mode: "line" },
        { point: [0, 0], mode: "line" }
      ];
      let closed = false;
      for (const step of steps) {
        const next = must(extendProfileChain(chain, step.point, step.mode, 0.5, ids));
        project = addThrough(project, { entities: [next.entity], constraints: next.constraints });
        placed.push(next.entity);
        chain = next.chain;
        closed = next.closed;
      }
      assert(closed, "the last click on the start closes the loop");
      equal(placed.length, 5, "five segments");
      equal(placed[1]!.kind, "arc", "the second segment is an arc");
      // The arc leaves the first line without a kink.
      const lineEnd = curveEnds(placed[0]!)[1]!.outward;
      const arcStart = curveEnds(placed[1]!)[0]!.outward;
      near(lineEnd[0] + arcStart[0], 0, 1e-9, "the arc starts along the line's direction (x)");
      near(lineEnd[1] + arcStart[1], 0, 1e-9, "the arc starts along the line's direction (y)");
      equal(project.sketch.constraints.filter((constraint) => constraint.kind === "tangent").length, 2, "the arc is tangent to the line before it, and the line that leaves it straight on is tangent to the arc");
      equal(project.sketch.constraints.filter((constraint) => constraint.kind === "coincident").length, 5, "a joint at every junction, including the one that closes the loop");
      equal(detectSketchProfiles(project.sketch).length, 1, "closes into a single profile");
      const solid = await extrudedVolume(project.sketch.entities, 2);
      near(solid.volume, solid.area * 2, solid.area * 2 * 2e-3, "extrudes to profile area times height");
      assert(solid.area > 2000, "with the area of the box plus the arc bulge");
    }
  },
  {
    name: "profile: a tangent arc needs something to be tangent to, refuses a straight-ahead end, and the arc maths is exact",
    run: () => {
      const first = startProfileChain([0, 0]);
      assert(!extendProfileChain(first, [10, 0], "tangent-arc", 0.5, ids).ok, "the first segment cannot be a tangent arc");
      const line = must(extendProfileChain(first, [10, 0], "line", 0.5, ids));
      assert(!extendProfileChain(line.chain, [20, 0], "tangent-arc", 0.5, ids).ok, "an end straight ahead would be a line");
      assert(!extendProfileChain(line.chain, [10, 0], "line", 0.5, ids).ok, "a zero-length line is refused");
      const arc = must(tangentArcFrom([0, 0], [1, 0], [10, 10]));
      // Heading +x then reaching (10,10): centre (0,10), radius 10, a quarter turn ending heading +y.
      near(arc.endTangent[0], 0, 1e-9, "ends heading +y (x)");
      near(arc.endTangent[1], 1, 1e-9, "ends heading +y (y)");
      near(arc.arc.mid[0], 10 * Math.sin(Math.PI / 4), 1e-9, "midpoint on the circle (x)");
      near(arc.arc.mid[1], 10 - 10 * Math.cos(Math.PI / 4), 1e-9, "midpoint on the circle (y)");
      // Clicking the start with fewer than two segments does not close.
      const early = must(extendProfileChain(line.chain, [0, 0.2], "line", 0.5, ids));
      assert(!early.closed, "a click near the start after only one segment does not close the loop");
      const second = must(extendProfileChain(line.chain, [10, 10], "line", 0.5, ids));
      const third = must(extendProfileChain(second.chain, [0, 0.2], "line", 0.5, ids));
      assert(third.closed, "after two segments a click near the start closes");
      near(lineOf(third.entity).end[1], 0, 1e-12, "and snaps exactly onto the start");
    }
  },
  // ------------------------------------------------------------------ priority 5: text
  {
    name: "sketch text: every character the font claims builds valid geometry at the asked height",
    run: () => {
      for (const character of STROKE_FONT_CHARACTERS) {
        if (character === " ") continue;
        const shape = must(buildSketchText([0, 0], character, { heightMm: 12 }, ids));
        assert(shape.entities.length >= 1, `"${character}" draws something`);
        const box = boundsOf(shape.entities);
        assert(box.max[1] - box.min[1] <= 12 * (8.6 / 6) + 1e-9, `"${character}" stays within the cap height plus ascender and descender room`);
        assert(box.max[0] - box.min[0] > 0 || box.max[1] - box.min[1] > 0, `"${character}" has extent`);
      }
      assert(STROKE_FONT_CHARACTERS.includes("Z") && STROKE_FONT_CHARACTERS.includes("9"), "letters and digits are present");
      equal(unsupportedTextCharacters("Hi§").join(""), "§", "unsupported characters are listed");
      assert(!buildSketchText([0, 0], "a§b", { heightMm: 10 }, ids).ok, "text with an unsupported character is refused");
      assert(!buildSketchText([0, 0], "   ", { heightMm: 10 }, ids).ok, "blank text is refused");
      assert(!buildSketchText([0, 0], "A", { heightMm: 0.1 }, ids).ok, "text under 0.5 mm is refused");
      assert(!buildSketchText([0, 0], "A".repeat(41), { heightMm: 10 }, ids).ok, "more than 40 characters is refused");
    }
  },
  {
    name: "sketch text: size, position, rotation and lowercase behave, and the result applies through the operations",
    run: () => {
      const small = must(buildSketchText([5, 7], "HELLO 42", { heightMm: 6 }, ids));
      const big = must(buildSketchText([5, 7], "HELLO 42", { heightMm: 12 }, ids));
      const sb = boundsOf(small.entities);
      const bb = boundsOf(big.entities);
      near(bb.max[0] - bb.min[0], 2 * (sb.max[0] - sb.min[0]), 1e-6, "twice the height is twice as wide");
      near(sb.min[1], 7, 1e-6, "the baseline sits at the click (y)");
      near(sb.max[1], 7 + 6, 0.12, "capitals are the asked height (round letters overshoot by under 2 percent)");
      near(sb.min[0], 5, 1e-6, "the text starts at the click (x)");
      const lower = must(buildSketchText([5, 7], "hello 42", { heightMm: 6 }, ids));
      assert(lower.entities.length !== small.entities.length || JSON.stringify(lower.entities.map((e) => e.kind)) !== JSON.stringify(small.entities.map((e) => e.kind)), "lowercase has its own forms (audit T25: it used to be the capitals)");
      near(boundsOfEntitiesForText(must(buildSketchText([0, 0], "o", { heightMm: 12 }, ids)).entities), 8, 1e-6, "a lowercase o is the x-height, two thirds of the capital");
      const turned = must(buildSketchText([0, 0], "HELLO", { heightMm: 10, rotationDeg: 90 }, ids));
      const tb = boundsOf(turned.entities);
      assert(tb.max[1] - tb.min[1] > 2 * (tb.max[0] - tb.min[0]), "rotated 90 degrees the text runs up the sketch");
      const wide = must(buildSketchText([0, 0], "HI", { heightMm: 10, spacing: 3 }, ids));
      const tight = must(buildSketchText([0, 0], "HI", { heightMm: 10, spacing: 0 }, ids));
      assert(boundsOf(wide.entities).max[0] > boundsOf(tight.entities).max[0], "letter spacing widens the text");
      near(glyphWidthUnits(" ")!, 3, 0, "a space advances the pen");
      const project = addThrough(emptyProject(), must(buildSketchText([0, 0], "PS3D CAD 2026", { heightMm: 8 }, ids)));
      assert(project.sketch.entities.length > 30, `${project.sketch.entities.length} line and arc entities went through validation`);
      assert(project.sketch.entities.every((entity) => entity.kind === "line" || entity.kind === "arc"), "text is only lines and arcs");
    }
  },
  {
    name: "sketch text: closed letters bound profiles that extrude, open letters do not",
    run: async () => {
      const o = must(buildSketchText([0, 0], "O", { heightMm: 30 }, ids));
      equal(o.entities.length, 2, "an O is two arcs");
      const profiles = detectSketchProfiles(sketchOf(o.entities));
      equal(profiles.length, 1, "which close into one profile");
      const solid = await extrudedVolume(o.entities, 2);
      near(solid.volume, solid.area * 2, solid.area * 2 * 2e-3, "that extrudes");
      const d = must(buildSketchText([0, 0], "D", { heightMm: 30 }, ids));
      equal(detectSketchProfiles(sketchOf(d.entities)).length, 1, "a D closes too");
      equal(detectSketchProfiles(sketchOf(must(buildSketchText([0, 0], "L", { heightMm: 30 }, ids)).entities)).length, 0, "an L is only a path");
    }
  },
  // ------------------------------------------------------------------ registry and dispatch
  {
    name: "every curve tool is registered: label, click count, shape-tool flag, and a full build through the operation path",
    run: () => {
      const samples: Readonly<Record<FixedCurveToolId, readonly Vec2[]>> = {
        "line-midpoint": [[0, 0], [10, 4]],
        centerline: [[0, 0], [5, 5]],
        parallelogram: [[0, 0], [20, 0], [28, 12]],
        "rectangle-rounded": [[0, 0], [30, 20]],
        "slot-arc-three-point": [[30, 0], [21.2132, 21.2132], [0, 30], [33, 0]],
        "slot-arc-center": [[0, 0], [20, 0], [0, 20], [23, 0]],
        parabola: [[-10, 10], [10, 10], [0, -10]],
        hyperbola: [[0, 0], [6, 0], [15, 12]],
        conic: [[0, 0], [40, 0], [20, 20]],
        "conic-five": [[-2, 4], [-1, 1], [0, 0], [1, 1], [2, 4]],
        "ellipse-arc": [[0, 40], [20, 40], [0, 50], [10, 40], [-10, 40]],
        "circle-tangent-3": [[-10, 0], [40, 12], [60, 5]],
        "circle-tangent-2": [[-10, 0], [60, 5]],
        blend: [[0, 0], [30, 12]],
        text: [[0, 0]],
        block: [[60, 40]]
      };
      const base = emptyProject();
      const sampleBlock = must(makeSketchBlock("sample", must(buildRoundedRectangle([0, 0], [10, 6], 1.5, ids)).entities, []));
      const withCurves: SketchEntity[] = [
        { id: "entity:blend-a", kind: "line", start: [-20, 0], end: [0, 0], construction: false },
        { id: "entity:blend-b", kind: "line", start: [30, 12], end: [50, 12], construction: false },
        { id: "entity:tangent-c", kind: "line", start: [60, -10], end: [60, 30], construction: false }
      ];
      let project: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities: withCurves } };
      for (const tool of Object.keys(samples) as FixedCurveToolId[]) {
        assert(isCurveTool(tool) && isFixedCurveTool(tool), `${tool} is registered`);
        const points = samples[tool];
        equal(requiredSketchPoints(tool), points.length, `${tool} takes ${points.length} clicks`);
        equal(curveToolRequiredPoints(tool), points.length, `${tool} registry count`);
        assert(isShapeTool(tool as SketchTool), `${tool} is placed as a shape`);
        equal(sketchToolLabel(tool), CURVE_TOOL_LABELS[tool], `${tool} label`);
        const shape = must(buildCurveTool(tool, points, { ...DEFAULT_CURVE_TOOL_OPTIONS, entities: withCurves, pickReachMm: 2, block: sampleBlock, blockRotationDeg: 90, blockScale: 2, cornerRadiusMm: tool === "circle-tangent-2" ? 6 : DEFAULT_CURVE_TOOL_OPTIONS.cornerRadiusMm }, ids));
        assert(shape.entities.length >= 1, `${tool} builds entities`);
        project = addThrough(project, shape, `Added ${tool}`);
        assert(!buildCurveTool(tool, points.slice(0, -1), DEFAULT_CURVE_TOOL_OPTIONS, ids).ok, `${tool} refuses a wrong click count`);
      }
      for (const tool of ["spline-control", "profile"] as const satisfies readonly CurveToolId[]) {
        assert(isCurveTool(tool) && !isFixedCurveTool(tool), `${tool} is an open tool`);
        assert(!isShapeTool(tool), `${tool} is not placed in one go`);
        assert((requiredSketchPoints(tool) ?? 0) >= 2, `${tool} has a minimum`);
      }
      equal(Object.keys(CURVE_TOOL_LABELS).length, 18, "eighteen curve tools (seventeen shapes and the block insert)");
      assert(!buildCurveTool("block", [[0, 0]], DEFAULT_CURVE_TOOL_OPTIONS, ids).ok, "inserting a block that was never saved is refused");
      assert(project.sketch.entities.length > 30, `${project.sketch.entities.length} entities from one of each tool are valid together`);
    }
  },
  {
    name: "Enter finishes a control-point spline (three or more points) and a profile chain, and nothing else changes",
    run: () => {
      const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
      const enter = { key: "Enter", ctrl: false, meta: false, alt: false, shift: false };
      equal(resolveSketchHotkey(enter, { ...idle, tool: "spline-control", pendingPoints: 3 })?.kind, "finish", "a control polygon of three points can be finished");
      equal(resolveSketchHotkey(enter, { ...idle, tool: "spline-control", pendingPoints: 2 }), undefined, "two points are not enough");
      equal(resolveSketchHotkey(enter, { ...idle, tool: "profile", pendingPoints: 1 })?.kind, "finish", "a started profile can be ended");
      equal(resolveSketchHotkey(enter, { ...idle, tool: "profile", pendingPoints: 0 }), undefined, "an unstarted profile has nothing to end");
      equal(resolveSketchHotkey(enter, { ...idle, tool: "blend", pendingPoints: 1 }), undefined, "other tools are left alone");
    }
  },
  // ------------------------------------------------------------------ reusable blocks
  {
    name: "sketch blocks: a rounded rectangle with its relations is saved once and inserted turned and scaled, with the exact area and an exact extrusion",
    run: async () => {
      const source = must(buildRoundedRectangle([0, 0], [40, 20], 4, ids));
      const sourceProject = addThrough(emptyProject(), source);
      const block = must(makeSketchBlock("Plate 40x20", sourceProject.sketch.entities, sourceProject.sketch.constraints));
      equal(block.entities.length, 8, "all eight curves are in the block");
      equal(block.constraints.length, source.constraints.length, "and every relation between them");
      const box = boundsOf(block.entities);
      near((box.min[0] + box.max[0]) / 2, 0, 1e-9, "the block is centred on its origin (x)");
      near((box.min[1] + box.max[1]) / 2, 0, 1e-9, "the block is centred on its origin (y)");
      const inserted = must(insertSketchBlock(block, [100, 50], { rotationDeg: 90, scale: 2 }, ids));
      const placedBox = boundsOf(inserted.entities);
      near(placedBox.max[0] - placedBox.min[0], 40, 1e-9, "turned 90 degrees the 40 mm width becomes the height, doubled: 40 wide (x)");
      near(placedBox.max[1] - placedBox.min[1], 80, 1e-9, "and 80 tall (y)");
      near((placedBox.min[0] + placedBox.max[0]) / 2, 100, 1e-9, "centred on the click (x)");
      near((placedBox.min[1] + placedBox.max[1]) / 2, 50, 1e-9, "centred on the click (y)");
      equal(inserted.constraints.filter((constraint) => constraint.kind === "horizontal").length, 2, "the plumb sides became level sides when turned a quarter turn");
      assert(new Set(inserted.entities.map((entity) => entity.id)).size === 8 && inserted.entities.every((entity) => !block.entities.some((original) => original.id === entity.id)), "fresh IDs for every copy");
      const project = addThrough(sourceProject, inserted, "Inserted block");
      equal(project.sketch.entities.length, 16, "the original and the copy sit in one sketch");
      const copyOnly = inserted.entities;
      const area = 40 * 20 - (4 - Math.PI) * 16;
      near(detectSketchProfiles(sketchOf(copyOnly))[0]!.areaMm2, area * 4, area * 4 * 0.003, "doubling the size quadruples the area");
      const solid = await extrudedVolume(copyOnly, 3);
      near(solid.volume, solid.area * 3, solid.area * 3 * 2e-3, "the copy extrudes");
    }
  },
  {
    name: "sketch blocks: a free angle drops level and plumb relations, dimensions scale, and Fixed is not carried over",
    run: () => {
      const line = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ id, kind: "line", start: a, end: b, construction: false });
      const entities: SketchEntity[] = [line("entity:b1", [0, 0], [10, 0]), line("entity:b2", [10, 0], [10, 6])];
      const block = must(makeSketchBlock("L", entities, [
        { id: "constraint:b-h", kind: "horizontal", entityIds: ["entity:b1"] },
        { id: "constraint:b-v", kind: "vertical", entityIds: ["entity:b2"] },
        { id: "constraint:b-d", kind: "distance", entityIds: ["entity:b1"], valueMm: 10, dimension: "length" },
        { id: "constraint:b-f", kind: "fixed", entityIds: ["entity:b1"] },
        { id: "constraint:b-out", kind: "equal", entityIds: ["entity:b1", "entity:outside"] }
      ]));
      equal(block.constraints.length, 4, "a relation to a curve outside the group is left out");
      const turned = must(insertSketchBlock(block, [0, 0], { rotationDeg: 30, scale: 1.5 }, ids));
      equal(turned.constraints.map((constraint) => constraint.kind).join(), "distance", "level, plumb and fixed are gone; the dimension stays");
      near(turned.constraints[0]!.valueMm ?? 0, 15, 1e-12, "the length dimension scaled with the block");
      const first = turned.entities[0]!;
      assert(first.kind === "line", "still lines");
      if (first.kind === "line") near(dist(first.start, first.end), 15, 1e-9, "and the geometry matches the scaled dimension");
      const kept = must(insertSketchBlock(block, [0, 0], { rotationDeg: 0, scale: 1 }, ids));
      equal(kept.constraints.map((constraint) => constraint.kind).sort().join(), "distance,horizontal,vertical", "unturned, level and plumb are kept");
      addThrough(emptyProject(), kept, "Inserted block");
      addThrough(emptyProject(), turned, "Inserted turned block");
      assert(!insertSketchBlock(block, [0, 0], { rotationDeg: 0, scale: 0 }, ids).ok, "scale zero is refused");
      assert(!insertSketchBlock(block, [0, 0], { rotationDeg: Number.NaN, scale: 1 }, ids).ok, "a non-numeric angle is refused");
      assert(!makeSketchBlock("  ", entities, []).ok, "a block needs a name");
      assert(!makeSketchBlock("empty", [], []).ok, "and some curves");
    }
  },
  {
    name: "sketch blocks: every entity kind round-trips through a block, and the library persists, replaces and survives bad storage",
    run: () => {
      const everything: SketchEntity[] = [
        { id: "entity:k-line", kind: "line", start: [0, 0], end: [10, 0], construction: false },
        { id: "entity:k-arc", kind: "arc", start: [10, 0], mid: [14, 4], end: [10, 8], construction: false },
        { id: "entity:k-circle", kind: "circle", center: [-8, 4], radiusMm: 3, construction: false },
        { id: "entity:k-ellipse", kind: "ellipse", center: [0, 12], majorRadiusMm: 6, minorRadiusMm: 3, rotationDeg: 20, construction: false },
        { id: "entity:k-rect", kind: "rectangle", center: [0, -8], widthMm: 8, heightMm: 4, rotationDeg: 10, construction: false },
        { id: "entity:k-point", kind: "point", point: [4, 4], construction: true },
        { id: "entity:k-spline", kind: "spline", fitPoints: [[-10, -10], [-5, -14], [0, -12], [5, -16]], construction: false }
      ];
      const block = must(makeSketchBlock("Everything", everything, []));
      const inserted = must(insertSketchBlock(block, [200, 0], { rotationDeg: 45, scale: 0.5 }, ids));
      equal(inserted.entities.map((entity) => entity.kind).join(), everything.map((entity) => entity.kind).join(), "same kinds in the same order");
      const circle = inserted.entities[2]!;
      assert(circle.kind === "circle" && Math.abs(circle.radiusMm - 1.5) < 1e-12, "the circle radius halved");
      const ellipse = inserted.entities[3]!;
      assert(ellipse.kind === "ellipse" && Math.abs(ellipse.rotationDeg - 65) < 1e-9 && Math.abs(ellipse.majorRadiusMm - 3) < 1e-12, "the ellipse turned with the block and halved");
      assert(inserted.entities[5]!.construction, "construction stays construction");
      addThrough(emptyProject(), inserted, "Inserted block");
      // The library keeps blocks across sessions through a storage, replaces by name, and shrugs off bad storage.
      const cells = new Map<string, string>();
      const storage: BlockStorage = { getItem: (key) => cells.get(key) ?? null, setItem: (key, value) => { cells.set(key, value); } };
      const library = createBlockLibrary(storage);
      library.save(block);
      library.save({ ...block, name: "Another" });
      library.save({ ...block, constraints: [] });
      equal(library.list().map((entry) => entry.name).join(), "Another,Everything", "saved blocks are listed by name, a repeated name replaces");
      const reopened = createBlockLibrary(storage);
      equal(reopened.get("Everything")?.entities.length, 7, "a new library over the same storage sees them");
      reopened.remove("Another");
      equal(createBlockLibrary(storage).list().length, 1, "removal persists too");
      cells.set("ps3d.sketch-blocks.v1", "not json {");
      equal(createBlockLibrary(storage).list().length, 0, "junk in storage is ignored");
      const throwing: BlockStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
      const inMemory = createBlockLibrary(throwing);
      inMemory.save(block);
      equal(inMemory.get("Everything")?.name, "Everything", "a blocked storage still leaves a working in-memory library");
    }
  }
];
