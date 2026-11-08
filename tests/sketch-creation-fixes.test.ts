import type { SketchEntity, Vec2, WorkbenchProject, WorkbenchSketch, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { SPLINE_MAX_FIT_POINTS, applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { entityLengthMm } from "../packages/workbench-core/src/sketch-measure.js";
import { advanceArcSweepTrack, arcSweepDirection, startArcSweepTrack, type ArcSweepTrack } from "../packages/workbench-sketch/src/arc-sweep.js";
import { autoConstraintsFor, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { fitCamera, fitCameraToViewport, panCamera, zoomCamera, type SketchCamera } from "../packages/workbench-sketch/src/camera.js";
import { CONIC_FIT_POINTS, buildConicByRho, buildHyperbola, conicArcPoint } from "../packages/workbench-sketch/src/conic-curves.js";
import { buildCurveTool, DEFAULT_CURVE_TOOL_OPTIONS } from "../packages/workbench-sketch/src/curve-tools.js";
import { directionOfAngle, pointFromDynamicInput } from "../packages/workbench-sketch/src/dynamic-input.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { analyzeWorkbenchSketch, buildSketchEntity, detectSketchProfiles, sampleArc, sampleSpline, selectTangentSketchEntities, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { entitiesInSelectionBox } from "../packages/workbench-sketch/src/selection.js";
import { buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { TEXT_MAX_ENTITIES, buildSketchText } from "../packages/workbench-sketch/src/stroke-text.js";
import { typedIntentConstraints } from "../packages/workbench-sketch/src/typed-intent.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const ids = { entity: (): string => `entity:fix-${(counter += 1)}`, constraint: (): string => `constraint:fix-${(counter += 1)}` };
const newConstraintId = (): string => `constraint:fix-${(counter += 1)}`;

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-creation-fixes");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

/** Adds entities and relations through the real operation layer, the way the canvas does, and returns the new project. */
function applyEdit(project: WorkbenchProject, addEntities: readonly SketchEntity[], addConstraints: readonly WorkbenchSketchConstraint[] = [], label = "Test edit"): { readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string } {
  counter += 1;
  const result = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:fix-${counter}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities, addConstraints, label });
  return result.ok ? { ok: true, project: result.value.project } : { ok: false, message: result.diagnostics[0]?.message ?? "refused" };
}

function mustApply(project: WorkbenchProject, addEntities: readonly SketchEntity[], addConstraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const applied = applyEdit(project, addEntities, addConstraints);
  assert(applied.ok, `the edit is accepted: ${applied.ok ? "" : applied.message}`);
  return applied.project;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  assert(result.ok, `expected success: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value;
}

function build(tool: Exclude<SketchTool, "select">, points: readonly Vec2[], options?: { readonly sweepDirection?: 1 | -1 }): SketchEntity {
  return must(buildSketchEntity(tool, points, `entity:fix-${(counter += 1)}`, options));
}

const polar = (radius: number, degrees: number, center: Vec2 = [0, 0]): Vec2 => [center[0] + radius * Math.cos((degrees * Math.PI) / 180), center[1] + radius * Math.sin((degrees * Math.PI) / 180)];

function sweepDegrees(arc: Extract<SketchEntity, { kind: "arc" }>): number {
  // The arc's own length over its radius: independent of which way round it runs.
  const samples = sampleArc(arc.start, arc.mid, arc.end);
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) length += Math.hypot(samples[index]![0] - samples[index - 1]![0], samples[index]![1] - samples[index - 1]![1]);
  const radius = Math.hypot(arc.start[0], arc.start[1]);
  return (length / radius) * (180 / Math.PI);
}

/** What the canvas does for a line tool click: infer the point (the end also from the previous point) and keep the inference for auto-constraints. */
function inferred(point: Vec2, sketch: WorkbenchSketch, anchor?: Vec2): PlacedPointInference {
  const result = inferSketchPoint(point, sketch, { toleranceMm: 0.5, ...(anchor === undefined ? {} : { anchor }) });
  return { point: result.point, ...(result.primary === undefined ? {} : { primary: result.primary }), guides: result.guides, ...(anchor === undefined ? {} : { anchor }) };
}

/** Draws a chain of Line-tool clicks exactly as SketchWorkspace.placePoint does, applying each line with its automatic relations. */
function drawLineChain(clicks: readonly Vec2[]): { readonly project: WorkbenchProject; readonly lineIds: readonly string[] } {
  let project = emptyProject();
  const lineIds: string[] = [];
  let startInference: PlacedPointInference = inferred(clicks[0]!, project.sketch);
  for (let index = 1; index < clicks.length; index += 1) {
    const endInference = inferred(clicks[index]!, project.sketch, startInference.point);
    const entity = build("line", [startInference.point, endInference.point]);
    const relations = autoConstraintsFor({ tool: "line", entity, placed: [startInference, endInference], sketch: project.sketch, newId: newConstraintId });
    project = mustApply(project, [entity], relations);
    lineIds.push(entity.id);
    // The next segment starts where this one ended, so it is joined to it, as the workspace does.
    startInference = { point: endInference.point, primary: { kind: "endpoint", point: endInference.point, entityId: entity.id, selector: "end", distanceMm: 0 } };
  }
  return { project, lineIds };
}

function circleOf(id: string, center: Vec2, radiusMm: number): SketchEntity {
  return { id, kind: "circle", center, radiusMm, construction: false };
}

function lineOf(id: string, start: Vec2, end: Vec2): SketchEntity {
  return { id, kind: "line", start, end, construction: false };
}

export const sketchCreationFixTests: readonly TestCase[] = [
  // ------------------------------------------------------------------------------------------ walkthrough A1
  {
    name: "Sketch creation A1: a Line chain closed on its first point leaves the rectangle with 4 degrees of freedom, not 5",
    run: () => {
      const { project, lineIds } = drawLineChain([[10, 10], [40, 10], [40, 30], [10, 30], [10, 10]]);
      const closing = project.sketch.constraints.filter((constraint) => constraint.entityIds.length === 1 && constraint.entityIds[0] === lineIds[3]);
      equal(closing.map((constraint) => constraint.kind).join(","), "vertical", "the closing side is Vertical");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(analysis.degreesOfFreedom, 4, "a rectangle of four lines has 4 degrees of freedom (position, width, height)");
      equal(analysis.conflicts.length, 0, "no conflicts");
    }
  },
  {
    name: "Sketch creation A1: a rectangle that starts on the origin closes with its first corner joined, the origin and the Y axis holding the last side upright (2 degrees of freedom, nothing redundant)",
    run: () => {
      const { project, lineIds } = drawLineChain([[0, 0], [30, 0], [30, 20], [0, 20], [0, 0]]);
      const closing = project.sketch.constraints.filter((constraint) => constraint.entityIds.includes(lineIds[3]!));
      // Both ends of the closing side are held on the Y axis (the first corner on the origin, the third corner on the axis), which already makes it
      // vertical: a Vertical relation as well would be redundant, so none is added.
      assert(!closing.some((constraint) => constraint.kind === "vertical"), "no redundant Vertical on the closing side");
      equal(analyzeWorkbenchSketch(project.sketch).redundant.length, 0, "and nothing is redundant");
      assert(closing.some((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes(lineIds[0]!)), "and its end is joined to the first side");
      // The first corner is on the origin and now says so (Coincident with the sketch origin), so only the width and height are left.
      assert(project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin"), "the first corner is joined to the origin");
      equal(analyzeWorkbenchSketch(project.sketch).degreesOfFreedom, 2, "width and height are all that is left");
    }
  },
  {
    name: "Sketch creation A1: a closing side that is level gets Horizontal, a slanted one gets neither",
    run: () => {
      const level = drawLineChain([[10, 10], [10, 30], [40, 30], [40, 10], [10, 10]]);
      const closingLevel = level.project.sketch.constraints.filter((constraint) => constraint.entityIds.length === 1 && constraint.entityIds[0] === level.lineIds[3]).map((constraint) => constraint.kind);
      equal(closingLevel.join(","), "horizontal", "the bottom side closing the loop is Horizontal");
      equal(analyzeWorkbenchSketch(level.project.sketch).degreesOfFreedom, 4, "still 4 degrees of freedom");
      const triangle = drawLineChain([[10, 10], [40, 10], [20, 30], [10, 10]]);
      const closingSlanted = triangle.project.sketch.constraints.filter((constraint) => constraint.entityIds.length === 1 && constraint.entityIds[0] === triangle.lineIds[2]);
      equal(closingSlanted.length, 0, "a slanted closing side takes no orientation relation");
    }
  },

  // ------------------------------------------------------------------------------------------ T04
  {
    name: "Curve creation T04: a centerpoint arc follows the pointer past 180 degrees (181, 270 and 359 degree arcs)",
    run: () => {
      for (const degrees of [181, 270, 359]) {
        const arc = build("arc-center", [[0, 0], [10, 0], polar(10, degrees)], { sweepDirection: 1 });
        assert(arc.kind === "arc", "an arc");
        near(sweepDegrees(arc), degrees, 0.6, `the counter-clockwise arc sweeps ${degrees} degrees`);
        near(entityLengthMm(arc) ?? Number.NaN, (10 * degrees * Math.PI) / 180, 0.05, `arc length for ${degrees} degrees`);
        const mid = Math.atan2(arc.mid[1], arc.mid[0]) * (180 / Math.PI);
        const offHalfway = (((mid - degrees / 2) % 360) + 540) % 360 - 180;
        near(offHalfway, 0, 1e-6, "the mid point is half way round");
        const project = mustApply(emptyProject(), [arc]);
        assert(project.sketch.entities.some((entity) => entity.id === arc.id), `the ${degrees} degree arc is accepted by the sketch`);
      }
    }
  },
  {
    name: "Curve creation T04: the same end click makes a 270 degree arc counter-clockwise or a 90 degree arc clockwise, by pointer direction",
    run: () => {
      const end = polar(10, 270);
      const ccw = build("arc-center", [[0, 0], [10, 0], end], { sweepDirection: 1 });
      const cw = build("arc-center", [[0, 0], [10, 0], end], { sweepDirection: -1 });
      assert(ccw.kind === "arc" && cw.kind === "arc", "arcs");
      near(sweepDegrees(ccw), 270, 0.6, "counter-clockwise reaches 270");
      near(sweepDegrees(cw), 90, 0.3, "clockwise is the short 90 degree arc");
      // Without a pointer path the old behaviour holds: the shorter way.
      const plain = build("arc-center", [[0, 0], [10, 0], end]);
      assert(plain.kind === "arc", "arc");
      near(sweepDegrees(plain), 90, 0.3, "no direction hint: shorter way round");
    }
  },
  {
    name: "Curve creation T04: the pointer track passes 180 degrees continuously and sets the direction (both ways round)",
    run: () => {
      const centre: Vec2 = [0, 0];
      const start: Vec2 = [10, 0];
      const walk = (angles: readonly number[]): ArcSweepTrack => angles.reduce((track, degrees) => advanceArcSweepTrack(track, centre, polar(10, degrees)), startArcSweepTrack(centre, start));
      const counter = walk([30, 60, 90, 120, 150, 179, 200, 230, 270]);
      equal(arcSweepDirection(counter), 1, "travelling counter-clockwise");
      near((counter.sweepRad * 180) / Math.PI, 270, 1e-6, "the accumulated sweep is 270 degrees, not -90");
      const clockwise = walk([-30, -60, -90, -120, -150, -179, -200, -230, -270]);
      equal(arcSweepDirection(clockwise), -1, "travelling clockwise");
      near((clockwise.sweepRad * 180) / Math.PI, -270, 1e-6, "the accumulated sweep is -270 degrees");
      equal(arcSweepDirection(startArcSweepTrack(centre, start)), undefined, "no movement yet means no direction");
      // The arc built from the end of the counter-clockwise walk is the 270 degree arc.
      const arc = build("arc-center", [centre, start, polar(10, 270)], { sweepDirection: arcSweepDirection(counter)! });
      assert(arc.kind === "arc", "arc");
      near(sweepDegrees(arc), 270, 0.6, "270 degree arc from the tracked direction");
    }
  },
  {
    name: "Curve creation T04: a full turn or no sweep is still refused",
    run: () => {
      assert(!buildSketchEntity("arc-center", [[0, 0], [10, 0], [20, 0]], "entity:fix-zero", { sweepDirection: 1 }).ok, "end on the start direction is a zero sweep, not a circle");
    }
  },

  // ------------------------------------------------------------------------------------------ T05
  {
    name: "Curve creation T05: the Tangent filter keeps a line and the tangent arc that leaves it at every sweep (4 to 180 degrees)",
    run: () => {
      const base = emptyProject().sketch;
      for (const sweep of [4, 10, 20, 45, 90, 180]) {
        const radius = 10;
        const a = (sweep * Math.PI) / 180;
        // The arc starts at (10, 0) heading along +x, with its centre above.
        const centre: Vec2 = [10, radius];
        const arcAt = (angle: number): Vec2 => [centre[0] + radius * Math.sin(angle), centre[1] - radius * Math.cos(angle)];
        const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: arcAt(0), mid: arcAt(a / 2), end: arcAt(a), construction: false };
        const sketch = { ...base, entities: [lineOf("entity:line", [0, 0], [10, 0]), arc], constraints: [] };
        equal(selectTangentSketchEntities(sketch, "entity:line", 2, 0.01).join(","), "entity:arc,entity:line", `a ${sweep} degree tangent arc is selected with its line`);
        equal(selectTangentSketchEntities(sketch, "entity:arc", 2, 0.01).length, 2, `and from the arc side (${sweep} degrees)`);
      }
    }
  },
  {
    name: "Curve creation T05: a rounded rectangle selects as one tangent chain of 8, a slot as 4",
    run: () => {
      const rounded = must(buildCurveTool("rectangle-rounded", [[0, 0], [40, 20]], { ...DEFAULT_CURVE_TOOL_OPTIONS, cornerRadiusMm: 5 }, ids));
      const roundedSketch = { ...emptyProject().sketch, entities: rounded.entities, constraints: rounded.constraints };
      equal(selectTangentSketchEntities(roundedSketch, rounded.entities[0]!.id, 2, 0.01).length, 8, "all 8 curves of the rounded rectangle");
      const slot = must(buildSlot([0, 0], [20, 0], [10, 3], ids));
      const slotSketch = { ...emptyProject().sketch, entities: slot.entities, constraints: slot.constraints };
      equal(selectTangentSketchEntities(slotSketch, slot.entities[0]!.id, 2, 0.01).length, 4, "all 4 curves of the slot");
    }
  },
  {
    name: "Curve creation T05: an arc that meets a line at a corner (not tangent) is still left out",
    run: () => {
      const base = emptyProject().sketch;
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 0], mid: [14.14, 4.14], end: [10, 10], construction: false };
      const sketch = { ...base, entities: [lineOf("entity:line", [0, 0], [10, 0]), arc], constraints: [] };
      equal(selectTangentSketchEntities(sketch, "entity:line", 2, 0.01).join(","), "entity:line", "a 90 degree corner is not tangent");
    }
  },

  // ------------------------------------------------------------------------------------------ T13
  {
    name: "Curve creation T13: conic splines stay within 0.05 mm of the exact conic for every rho (60 mm span)",
    run: () => {
      const start: Vec2 = [0, 0];
      const end: Vec2 = [60, 0];
      const apex: Vec2 = [30, 40];
      for (const rho of [0.02, 0.05, 0.3, 0.5, 0.7, 0.9, 0.98]) {
        const shape = must(buildConicByRho(start, end, apex, rho, ids));
        const spline = shape.entities[0]!;
        assert(spline.kind === "spline", "a spline");
        equal(spline.fitPoints.length, CONIC_FIT_POINTS, "the documented fit-point count");
        const exact = Array.from({ length: 4001 }, (_, index) => conicArcPoint(start, apex, end, rho, index / 4000));
        let worst = 0;
        for (const sample of sampleSpline(spline.fitPoints, 16)) {
          let best = Infinity;
          for (let index = 1; index < exact.length; index += 1) {
            const a = exact[index - 1]!;
            const b = exact[index]!;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const lengthSquared = dx * dx + dy * dy;
            const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((sample[0] - a[0]) * dx + (sample[1] - a[1]) * dy) / lengthSquared));
            best = Math.min(best, Math.hypot(a[0] + dx * t - sample[0], a[1] + dy * t - sample[1]));
          }
          worst = Math.max(worst, best);
        }
        assert(worst <= 0.05, `rho ${rho}: spline deviates ${worst.toFixed(4)} mm from the exact conic (limit 0.05)`);
      }
    }
  },
  {
    name: "Curve creation T13: a hyperbola branch lies on the true hyperbola to 0.05 mm",
    run: () => {
      const centre: Vec2 = [0, 0];
      const shape = must(buildHyperbola(centre, [10, 0], [40, 30], ids));
      const spline = shape.entities[0]!;
      assert(spline.kind === "spline", "a spline");
      // The branch through (40, 30) with vertex (10, 0): b follows from the branch point.
      const b = 30 / Math.sqrt((40 * 40) / 100 - 1);
      let worst = 0;
      // Distance to the curve is about |f| / |grad f| for the implicit form f = x^2/a^2 - y^2/b^2 - 1.
      for (const [x, y] of sampleSpline(spline.fitPoints, 16)) worst = Math.max(worst, Math.abs((x * x) / 100 - (y * y) / (b * b) - 1) / Math.hypot((2 * x) / 100, (2 * y) / (b * b)));
      assert(worst < 0.05, `hyperbola samples sit on the curve (worst distance estimate ${worst})`);
    }
  },

  // ------------------------------------------------------------------------------------------ T14 / T15
  {
    name: "Curve creation T14: hovering along a spline snaps On curve, never Intersection with itself",
    run: () => {
      const spline = build("spline", [[0, 0], [10, 8], [20, -4], [30, 6]]);
      const sketch = { ...emptyProject().sketch, entities: [spline], constraints: [] };
      const samples = sampleSpline((spline as Extract<SketchEntity, { kind: "spline" }>).fitPoints);
      let hovered = 0;
      let bad = 0;
      for (let index = 1; index < samples.length - 1; index += 1) {
        for (const fraction of [0.3, 0.7]) {
          const a = samples[index]!;
          const b = samples[index + 1]!;
          const result = inferSketchPoint([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction + 0.05], sketch, { toleranceMm: 1 });
          hovered += 1;
          if (result.primary?.kind === "intersection") bad += 1;
        }
      }
      assert(hovered > 40, "many hover positions were tried");
      equal(bad, 0, "no spurious Intersection along a single spline");
    }
  },
  {
    name: "Curve creation T14: a spline still gives a real Intersection where it crosses another curve",
    run: () => {
      const spline = build("spline", [[0, 0], [10, 8], [20, -4], [30, 6]]);
      const crossing = lineOf("entity:crossing", [15, -20], [15, 20]);
      const sketch = { ...emptyProject().sketch, entities: [spline, crossing], constraints: [] };
      const samples = sampleSpline((spline as Extract<SketchEntity, { kind: "spline" }>).fitPoints);
      const onLine = samples.findIndex((sample, index) => index > 0 && (samples[index - 1]![0] - 15) * (sample[0] - 15) <= 0);
      const hit = samples[onLine]!;
      const result = inferSketchPoint([15.1, hit[1] + 0.1], sketch, { toleranceMm: 1 });
      equal(result.primary?.kind, "intersection", "the crossing is an Intersection");
      near(result.point[0], 15, 1e-6, "on the line");
    }
  },
  {
    name: "Curve creation T15: an ellipse snaps On curve, crosses a line exactly, and offers Perpendicular and Tangent hints",
    run: () => {
      const ellipse: SketchEntity = { id: "entity:ellipse", kind: "ellipse", center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10, rotationDeg: 30, construction: false };
      const rotate = (x: number, y: number): Vec2 => [x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6)];
      const onOutline = (t: number): Vec2 => rotate(20 * Math.cos(t), 10 * Math.sin(t));
      const sketch = { ...emptyProject().sketch, entities: [ellipse], constraints: [] };
      // On curve: 0.05 mm outside the outline.
      const target = onOutline(1.1);
      const outward = rotate(20 * Math.cos(1.1) / 20, 10 * Math.sin(1.1) / 10);
      const near1 = inferSketchPoint([target[0] + outward[0] * 0.05, target[1] + outward[1] * 0.05], sketch, { toleranceMm: 1 });
      equal(near1.primary?.kind, "on-curve", "snaps to the ellipse outline");
      const local = (p: Vec2): number => { const c = Math.cos(Math.PI / 6); const s = Math.sin(Math.PI / 6); const x = p[0] * c + p[1] * s; const y = -p[0] * s + p[1] * c; return (x / 20) ** 2 + (y / 10) ** 2; };
      near(local(near1.point), 1, 1e-9, "and the snapped point is exactly on the ellipse");
      // Intersection with a line through the centre.
      const diameter = lineOf("entity:diameter", [-30, 0], [30, 0]);
      const crossSketch = { ...sketch, entities: [ellipse, diameter] };
      const hitAt = (px: number): ReturnType<typeof inferSketchPoint> => inferSketchPoint([px, 0.1], crossSketch, { toleranceMm: 1 });
      // Along the x axis the ellipse (rotated 30) meets y = 0 where (x cos/20)^2 + (-x sin/10)^2 = 1.
      const xHit = 1 / Math.sqrt((Math.cos(Math.PI / 6) / 20) ** 2 + (Math.sin(Math.PI / 6) / 10) ** 2);
      const hit = hitAt(xHit + 0.1);
      equal(hit.primary?.kind, "intersection", "ellipse x line is an Intersection");
      near(hit.point[0], xHit, 1e-9, "at the exact crossing");
      near(hit.point[1], 0, 1e-9, "on the line");
      // Tangent from an outside anchor: the tangent line is perpendicular to the outline normal there.
      const anchor: Vec2 = [60, 5];
      let tangentFound = false;
      for (let step = 0; step < 720 && !tangentFound; step += 1) {
        const t = (step / 720) * Math.PI * 2;
        const p = onOutline(t);
        const probe = inferSketchPoint(p, sketch, { toleranceMm: 0.3, anchor });
        if (probe.primary?.kind === "tangent") {
          tangentFound = true;
          const q = probe.point;
          // Numerically: the anchor-to-point direction is parallel to the ellipse tangent at the point.
          const a = (Math.PI / 6);
          const lx = q[0] * Math.cos(a) + q[1] * Math.sin(a);
          const ly = -q[0] * Math.sin(a) + q[1] * Math.cos(a);
          const tangentLocal: Vec2 = [-20 * (ly / 10), 10 * (lx / 20)];
          const dirWorld: Vec2 = [tangentLocal[0] * Math.cos(a) - tangentLocal[1] * Math.sin(a), tangentLocal[0] * Math.sin(a) + tangentLocal[1] * Math.cos(a)];
          const toAnchor: Vec2 = [anchor[0] - q[0], anchor[1] - q[1]];
          const crossValue = (dirWorld[0] * toAnchor[1] - dirWorld[1] * toAnchor[0]) / (Math.hypot(...dirWorld) * Math.hypot(...toAnchor));
          near(crossValue, 0, 1e-6, "the line from the anchor touches the ellipse tangentially");
        }
      }
      assert(tangentFound, "a Tangent hint appears for an anchor outside the ellipse");
      let perpendicularFound = false;
      for (let step = 0; step < 720 && !perpendicularFound; step += 1) {
        const p = onOutline((step / 720) * Math.PI * 2);
        if (inferSketchPoint(p, sketch, { toleranceMm: 0.3, anchor }).primary?.kind === "perpendicular") perpendicularFound = true;
      }
      assert(perpendicularFound, "a Perpendicular hint appears from the anchor");
    }
  },
  {
    name: "Curve creation T15: an ellipse centre, an arc centre and a circle centre snap together as Coincident relations the solver keeps",
    run: () => {
      const base = emptyProject().sketch;
      const circle = circleOf("entity:circle", [40, 25], 12);
      const sketch = { ...base, entities: [circle], constraints: [] };
      // Ellipse tool: the first click lands on the circle centre.
      const centreClick = inferred([40.2, 25.1], sketch);
      equal(centreClick.primary?.kind, "center", "the centre click snaps to the circle centre");
      const ellipse = build("ellipse", [centreClick.point, [60, 25], [40, 35]]);
      const ellipseRelations = autoConstraintsFor({ tool: "ellipse", entity: ellipse, placed: [centreClick, { point: [60, 25] }, { point: [40, 35] }], sketch, newId: newConstraintId });
      equal(ellipseRelations.map((relation) => `${relation.kind}:${relation.points?.join("/")}`).join(","), "coincident:center/center", "ellipse centre joins the circle centre");
      const project = mustApply(mustApply(emptyProject(), [circle]), [ellipse], ellipseRelations);
      const placedEllipse = project.sketch.entities.find((entity) => entity.id === ellipse.id);
      assert(placedEllipse?.kind === "ellipse", "the ellipse is in the sketch");
      equal(placedEllipse.center.join(","), "40,25", "the ellipse centre sits exactly on the circle centre");
      // Centerpoint arc tool: the first click lands on the same centre.
      const arc = build("arc-center", [centreClick.point, [52, 25], [40, 37]]);
      const arcRelations = autoConstraintsFor({ tool: "arc-center", entity: arc, placed: [centreClick, { point: [52, 25] }, { point: [40, 37] }], sketch, newId: newConstraintId });
      equal(arcRelations.map((relation) => `${relation.kind}:${relation.points?.join("/")}`).join(","), "coincident:center/center", "arc centre joins the circle centre");
      mustApply(mustApply(emptyProject(), [circle]), [arc], arcRelations);
    }
  },

  // ------------------------------------------------------------------------------------------ T17
  {
    name: "Curve creation T17: a typed length and a typed 0 or 90 degree angle become a driving dimension and a Horizontal or Vertical relation",
    run: () => {
      const cursor: Vec2 = [37, 11];
      const flatEnd = pointFromDynamicInput("line", [[5, 5]], cursor, { length: 50, angle: 0 });
      assert(flatEnd !== undefined, "a point is made");
      const flat = build("line", [[5, 5], flatEnd]);
      const flatRelations = typedIntentConstraints({ tool: "line", entity: flat, typed: { length: 50, angle: 0 }, newId: newConstraintId });
      equal(flatRelations.map((relation) => `${relation.kind}:${relation.dimension ?? ""}:${relation.valueMm ?? ""}`).sort().join(" "), "distance:length:50 horizontal::", "50 mm at 0 degrees");
      const projectFlat = mustApply(emptyProject(), [flat], flatRelations);
      equal(analyzeWorkbenchSketch(projectFlat.sketch).degreesOfFreedom, 2, "the line keeps only its position free");
      const upEnd = pointFromDynamicInput("line", [[5, 5]], cursor, { length: 30, angle: 90 })!;
      equal(upEnd[0], 5, "a typed 90 degree line is exactly plumb (no 1e-15 lean)");
      const up = build("line", [[5, 5], upEnd]);
      const upRelations = typedIntentConstraints({ tool: "line", entity: up, typed: { length: 30, angle: 90 }, newId: newConstraintId });
      equal(upRelations.map((relation) => relation.kind).sort().join(","), "distance,vertical", "30 mm at 90 degrees");
      equal(typedIntentConstraints({ tool: "line", entity: build("line", [[0, 0], polar(20, 33)]), typed: { length: 20, angle: 33 }, newId: newConstraintId }).map((relation) => relation.kind).join(","), "distance", "a 33 degree line gets the length only");
      equal(directionOfAngle(270).join(","), "0,-1", "exact direction for 270");
      equal(directionOfAngle(-90).join(","), "0,-1", "and for -90");
      equal(directionOfAngle(180).join(","), "-1,0", "and for 180");
    }
  },
  {
    name: "Curve creation T17: the typed 50 mm horizontal line stays 50 mm and level when its dimension is edited through the operation layer",
    run: () => {
      const flat = build("line", [[5, 5], [55, 5]]);
      const relations = typedIntentConstraints({ tool: "line", entity: flat, typed: { length: 50, angle: 0 }, newId: newConstraintId });
      const project = mustApply(emptyProject(), [flat], relations);
      const resized = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: "operation:fix-resize", expectedRevision: project.revision, entityId: flat.id, dimension: "length", valueMm: 70 });
      assert(resized.ok, `the length changes: ${resized.ok ? "" : resized.diagnostics[0]?.message ?? ""}`);
      const line = resized.value.project.sketch.entities.find((entity) => entity.id === flat.id);
      assert(line?.kind === "line", "line");
      near(Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]), 70, 1e-6, "length 70");
      near(line.end[1], line.start[1], 1e-9, "still level");
    }
  },
  {
    name: "Curve creation T17: typed rectangle sizes, circle radius and 2-point diameter are driving dimensions",
    run: () => {
      const rectangle = build("rectangle", [[0, 0], [40, 25]]);
      const rectRelations = typedIntentConstraints({ tool: "rectangle", entity: rectangle, typed: { width: 40, height: 25 }, newId: newConstraintId });
      equal(rectRelations.map((relation) => `${relation.dimension}:${relation.valueMm}`).sort().join(" "), "height:25 width:40", "width and height");
      mustApply(emptyProject(), [rectangle], rectRelations);
      const circle = build("circle", [[0, 0], [8, 0]]);
      const radius = typedIntentConstraints({ tool: "circle", entity: circle, typed: { radius: 8 }, newId: newConstraintId });
      equal(radius.map((relation) => `${relation.kind}:${relation.valueMm}`).join(","), "radius:8", "radius");
      mustApply(emptyProject(), [circle], radius);
      const diameterCircle = build("circle-two-point", [[0, 0], [12, 0]]);
      const diameter = typedIntentConstraints({ tool: "circle-two-point", entity: diameterCircle, typed: { diameter: 12 }, newId: newConstraintId });
      equal(diameter.map((relation) => `${relation.kind}:${relation.valueMm}`).join(","), "radius:6", "a typed diameter of 12 is a radius of 6");
      mustApply(emptyProject(), [diameterCircle], diameter);
      equal(typedIntentConstraints({ tool: "line", entity: build("line", [[0, 0], [10, 0]]), typed: {}, newId: newConstraintId }).length, 0, "nothing typed, nothing recorded");
    }
  },

  // ------------------------------------------------------------------------------------------ T18 / T19 / T20
  {
    name: "Curve creation T18: no builder accepts NaN or Infinity, and nothing reaches the operation layer to throw",
    run: () => {
      const bad: readonly (readonly [Exclude<SketchTool, "select">, readonly Vec2[]])[] = [
        ["line", [[0, 0], [Number.NaN, 5]]],
        ["line", [[0, 0], [Number.POSITIVE_INFINITY, 5]]],
        ["rectangle", [[0, 0], [10, Number.NaN]]],
        ["rectangle-center", [[Number.NaN, 0], [10, 5]]],
        ["rectangle-three-point", [[0, 0], [10, 0], [10, Number.POSITIVE_INFINITY]]],
        ["circle", [[0, 0], [Number.NaN, 0]]],
        ["circle-two-point", [[0, 0], [Number.NEGATIVE_INFINITY, 0]]],
        ["circle-three-point", [[0, 0], [5, 5], [Number.NaN, 0]]],
        ["ellipse", [[0, 0], [10, 0], [0, Number.NaN]]],
        ["arc", [[0, 0], [5, 5], [Number.NaN, 0]]],
        ["arc-center", [[0, 0], [10, 0], [Number.NaN, 5]]],
        ["arc-tangent", [[0, 0], [10, 0], [10, Number.POSITIVE_INFINITY]]],
        ["spline", [[0, 0], [5, 5], [Number.NaN, 1]]],
        ["point", [[Number.NaN, 0]]]
      ];
      for (const [tool, points] of bad) {
        const result = buildSketchEntity(tool, points, "entity:fix-nan");
        assert(!result.ok, `${tool} with a non-finite coordinate is refused`);
        assert(/finite/u.test(result.diagnostics[0]!.message), `${tool}: the message says why (${result.diagnostics[0]!.message})`);
      }
    }
  },
  {
    name: "Curve creation T19: far geometry is refused by the builder with a message that names the 100,000 mm limit",
    run: () => {
      // The sketch limit is the model envelope: coordinates to +/-100,000 mm, radii to 100,000 mm, rectangle sides to 200,000 mm.
      for (const far of [200_000, 1e9]) {
        const result = buildSketchEntity("line", [[0, 0], [far, 5]], "entity:fix-far");
        assert(!result.ok, `a line out to ${far} mm is refused where it is built`);
        assert(/100,000/u.test(result.diagnostics[0]!.message), `the message names the limit: ${result.diagnostics[0]!.message}`);
      }
      assert(buildSketchEntity("line", [[0, 0], [100_000, 5]], "entity:fix-edge").ok, "exactly at the limit is fine");
      const bigCircle = buildSketchEntity("circle-three-point", [[-9_000, 0], [0, 9_000], [9_000, 0]], "entity:fix-big");
      assert(bigCircle.ok, "a 9,000 mm circle is within the limits");
      const tooBig = buildSketchEntity("circle", [[0, 0], [90_000, 90_000]], "entity:fix-bigger");
      assert(!tooBig.ok && /100,000/u.test(tooBig.diagnostics[0]!.message), "a circle radius above 100,000 mm names the limit");
      const wide = buildSketchEntity("rectangle", [[-9_000, -1], [9_000, 1]], "entity:fix-wide");
      assert(wide.ok, "an 18,000 mm wide rectangle is within its 200,000 limit");
    }
  },
  {
    name: "Curve creation T19: everything a builder accepts is accepted by the operation layer, and text is refused at 200 curves with the reason",
    run: () => {
      const accepted: SketchEntity[] = [
        build("line", [[0, 0], [9_999, 9_999]]),
        build("rectangle", [[-9_000, -9_000], [9_000, 9_000]]),
        build("circle", [[0, 0], [9_999, 0]]),
        build("ellipse", [[0, 0], [9_000, 0], [0, 3_000]]),
        build("arc", [[0, 0], [100, 40], [200, 0]]),
        build("spline", [[0, 0], [100, 40], [200, 0], [300, 50]]),
        build("point", [[9_999, -9_999]])
      ];
      let project = emptyProject();
      for (const entity of accepted) project = mustApply(project, [entity]);
      const text = buildSketchText([0, 0], "B".repeat(40), { heightMm: 10 }, ids);
      assert(!text.ok, "40 B characters need more than 200 curves");
      assert(/200/u.test(text.diagnostics[0]!.message), `the message names the limit: ${text.diagnostics[0]!.message}`);
      equal(TEXT_MAX_ENTITIES, 200, "the text limit is the per-edit limit");
      const fits = must(buildSketchText([0, 0], "AB 12", { heightMm: 10 }, ids));
      mustApply(emptyProject(), fits.entities);
    }
  },
  {
    name: "Curve creation T20: a nearly straight 3-point arc or circle is refused with the radius limit, and a tiny valid arc is accepted",
    run: () => {
      const circle = buildSketchEntity("circle-three-point", [[0, 0], [100, 0.0001], [200, 0]], "entity:fix-flat-circle");
      assert(!circle.ok && /100,000/u.test(circle.diagnostics[0]!.message), "circle through three nearly collinear points names the radius limit");
      const arc = buildSketchEntity("arc", [[0, 0], [1000, 0.001], [2000, 0]], "entity:fix-flat-arc");
      assert(!arc.ok && /100,000/u.test(arc.diagnostics[0]!.message), "arc with a 5e8 mm radius is refused");
      assert(!buildSketchEntity("arc", [[0, 0], [5, 0], [10, 0]], "entity:fix-line").ok, "truly collinear is refused");
      assert(!buildSketchEntity("arc", [[0, 0], [0, 0], [10, 5]], "entity:fix-dup").ok, "coincident points are refused");
      const tiny = buildSketchEntity("arc", [[0, 0], [0.005, 0.0005], [0.01, 0]], "entity:fix-tiny");
      assert(tiny.ok, `a 0.0125 mm radius arc is a valid arc: ${tiny.ok ? "" : tiny.diagnostics[0]!.message}`);
      mustApply(emptyProject(), [tiny.value]);
      const gentle = build("arc", [[0, 0], [500, 25], [1000, 0]]);
      mustApply(emptyProject(), [gentle]);
      const nearLimit = build("circle-three-point", [[0, 0], [100, 0.6], [200, 0]]);
      assert(nearLimit.kind === "circle" && nearLimit.radiusMm < 10_000, "a 10 km sag circle is below the limit and accepted");
    }
  },

  // ------------------------------------------------------------------------------------------ T25 / T26
  {
    name: "Curve creation T25: sketch text draws degree, diameter and the common engineering symbols, and a bad rotation says so",
    run: () => {
      for (const label of ["Ø12", "⌀12", "ø6.5", "90°", "±0.1", "5×45°", "M8 x 1.25 [2X]", "#4 40% @ 5*3 <5> {a} (b) &^~|\\\"`$;"]) {
        const result = buildSketchText([0, 0], label, { heightMm: 8 }, ids);
        assert(result.ok, `"${label}" can be drawn: ${result.ok ? "" : result.diagnostics[0]!.message}`);
        mustApply(emptyProject(), result.value.entities);
      }
      const slashed = must(buildSketchText([0, 0], "Ø", { heightMm: 6 }, ids));
      assert(slashed.entities.some((entity) => entity.kind === "line"), "the diameter sign has its slash");
      const rotation = buildSketchText([0, 0], "AB", { heightMm: 8, rotationDeg: Number.NaN }, ids);
      assert(!rotation.ok && /rotation/u.test(rotation.diagnostics[0]!.message), `NaN rotation: ${rotation.ok ? "" : rotation.diagnostics[0]!.message}`);
      const unsupported = buildSketchText([0, 0], "A§", { heightMm: 8 }, ids);
      assert(!unsupported.ok && unsupported.diagnostics[0]!.message.includes("§"), "an unknown symbol is still named");
    }
  },
  {
    name: "Curve creation T26: a fit-point spline takes up to 64 points, refuses 65, and refuses A-B-A and interior repeats",
    run: () => {
      equal(SPLINE_MAX_FIT_POINTS, 64, "the limit");
      const wave = (count: number): Vec2[] => Array.from({ length: count }, (_, index): Vec2 => [index * 5, (index % 2) * 3]);
      for (const count of [25, 40, 64]) {
        const spline = build("spline", wave(count));
        mustApply(emptyProject(), [spline]);
      }
      assert(!buildSketchEntity("spline", wave(65), "entity:fix-65").ok, "65 points are refused");
      const aba = buildSketchEntity("spline", [[0, 0], [10, 5], [0, 0]], "entity:fix-aba");
      assert(!aba.ok && /on top of each other/u.test(aba.diagnostics[0]!.message), "A, B, A doubles back and is refused");
      assert(!buildSketchEntity("spline", [[0, 0], [10, 5], [20, 0], [10, 5], [30, 8]], "entity:fix-repeat").ok, "an interior point visited twice is refused");
      assert(buildSketchEntity("spline", [[0, 0], [10, 0], [10, 10], [0, 0]], "entity:fix-closed").ok, "a loop that returns to its first point after at least three others is still allowed");
      assert(!buildSketchEntity("spline", [[0, 0], [1, 1]], "entity:fix-two").ok, "two points are a line, not a spline");
    }
  },

  // ------------------------------------------------------------------------------------------ T27
  {
    name: "Curve creation T27: grid snapping and derived sizes carry no float tail (0.3, not 0.30000000000000004)",
    run: () => {
      const sketch = emptyProject().sketch;
      const snapped = inferSketchPoint([0.31, 0.29], sketch, { toleranceMm: 0.04, gridMm: 0.1 });
      equal(snapped.point[0], 0.3, "x on the 0.1 grid");
      equal(snapped.point[1], 0.3, "y on the 0.1 grid");
      const rectangle = build("rectangle", [[0.1, 0.1], [0.8, 1.3]]);
      assert(rectangle.kind === "rectangle", "rectangle");
      equal(rectangle.widthMm, 0.7, "width between grid points 0.1 and 0.8");
      equal(rectangle.heightMm, 1.2, "height between 0.1 and 1.3");
      equal(rectangle.center[0], 0.45, "centre x");
      equal(rectangle.center[1], 0.7, "centre y");
      const centred = build("rectangle-center", [[0.1, 0.1], [0.4, 0.7]]);
      assert(centred.kind === "rectangle", "rectangle");
      equal(centred.widthMm, 0.6, "centre rectangle width");
      const twoPoint = build("circle-two-point", [[0.1, 0.1], [0.8, 0.1]]);
      assert(twoPoint.kind === "circle", "circle");
      equal(twoPoint.radiusMm, 0.35, "2-point circle radius");
      equal(twoPoint.center[0], 0.45, "2-point circle centre");
    }
  },
  {
    name: "Curve creation T27: an ellipse always stores its rotation in (-90, 90], however its axes were picked",
    run: () => {
      const cases: readonly (readonly [string, readonly Vec2[], number])[] = [
        ["major axis to the left", [[0, 0], [-10, 0], [0, 3]], 0],
        ["major axis down-left", [[0, 0], [-10, -10], [3, -3]], 45],
        ["minor picked first, pointing left", [[0, 0], [-3, 0], [0, 10]], 90],
        ["minor picked first, pointing right", [[0, 0], [3, 0], [0, 10]], 90],
        ["minor picked first, pointing down", [[0, 0], [0, -3], [10, 0]], 0],
        ["major axis up", [[0, 0], [0, 10], [3, 0]], 90],
        ["major axis down", [[0, 0], [0, -10], [3, 0]], 90]
      ];
      for (const [label, points, expected] of cases) {
        const ellipse = build("ellipse", points);
        assert(ellipse.kind === "ellipse", "ellipse");
        assert(ellipse.rotationDeg > -90 - 1e-9 && ellipse.rotationDeg <= 90 + 1e-9, `${label}: rotation ${ellipse.rotationDeg} is inside (-90, 90]`);
        near(ellipse.rotationDeg, expected, 1e-9, label);
        assert(ellipse.majorRadiusMm >= ellipse.minorRadiusMm, `${label}: major is not shorter than minor`);
      }
    }
  },

  // ------------------------------------------------------------------------------------------ performance guard
  {
    name: "Curve creation performance: inference over 500 mixed curves (ellipses and splines included) and profile detection on 500 arcs and lines stay fast",
    run: () => {
      const entities: SketchEntity[] = [];
      for (let index = 0; index < 500; index += 1) {
        const x = (index % 25) * 40;
        const y = Math.floor(index / 25) * 40;
        if (index % 5 === 0) entities.push({ id: `entity:perf-${index}`, kind: "ellipse", center: [x, y], majorRadiusMm: 15, minorRadiusMm: 8, rotationDeg: index % 90, construction: false });
        else if (index % 5 === 1) entities.push({ id: `entity:perf-${index}`, kind: "spline", fitPoints: [[x, y], [x + 8, y + 6], [x + 16, y - 3], [x + 24, y + 4]], construction: false });
        else if (index % 5 === 2) entities.push({ id: `entity:perf-${index}`, kind: "circle", center: [x, y], radiusMm: 9, construction: false });
        else if (index % 5 === 3) entities.push({ id: `entity:perf-${index}`, kind: "arc", start: [x, y], mid: [x + 6, y + 6], end: [x + 12, y], construction: false });
        else entities.push(lineOf(`entity:perf-${index}`, [x, y], [x + 20, y + 10]));
      }
      const sketch = { ...emptyProject().sketch, entities, constraints: [] };
      const startedAt = performance.now();
      for (let probe = 0; probe < 20; probe += 1) inferSketchPoint([probe * 37 % 1000, probe * 53 % 800], sketch, { toleranceMm: 4, anchor: [100, 100] });
      const perCall = (performance.now() - startedAt) / 20;
      assert(perCall < 100, `inference stays under 100 ms a call with 500 curves (took ${perCall.toFixed(1)} ms)`);
      const loopStart = performance.now();
      detectSketchProfiles(sketch);
      assert(performance.now() - loopStart < 1000, "profile detection on 500 curves is well under a second");
    }
  },

  // ------------------------------------------------------------------------------------------ T28
  {
    name: "Curve creation T28: the camera ignores NaN and infinite input instead of becoming NaN",
    run: () => {
      const camera: SketchCamera = { centerMm: [12, -7], widthMm: 120 };
      const finite = (value: SketchCamera): boolean => Number.isFinite(value.widthMm) && Number.isFinite(value.centerMm[0]) && Number.isFinite(value.centerMm[1]);
      assert(finite(zoomCamera(camera, [0, 0], Number.NaN)), "zoom by NaN");
      assert(finite(zoomCamera(camera, [Number.NaN, 0], 1.2)), "zoom about a NaN anchor");
      assert(finite(zoomCamera(camera, [0, 0], Number.POSITIVE_INFINITY)), "zoom by infinity");
      equal(zoomCamera(camera, [0, 0], Number.NaN).widthMm, 120, "the view stays where it was");
      assert(finite(panCamera(camera, Number.NaN, 5, 800)), "pan by NaN");
      assert(finite(fitCameraToViewport({ min: [Number.NaN, 0], max: [10, 10] }, { width: 800, height: 600 }, { left: 0, top: 0, right: 0, bottom: 0 })), "fit to NaN extents");
      assert(finite(fitCameraToViewport({ min: [0, 0], max: [Number.POSITIVE_INFINITY, 10] }, { width: 800, height: 600 }, { left: 0, top: 0, right: 0, bottom: 0 })), "fit to infinite extents");
      assert(finite(fitCamera({ min: [0, Number.NaN], max: [10, 10] }, 1.6)), "plain fit to NaN extents");
      const real = fitCameraToViewport({ min: [0, 0], max: [100, 50] }, { width: 800, height: 600 }, { left: 0, top: 0, right: 0, bottom: 0 });
      assert(finite(real) && real.widthMm > 100, "real extents still fit");
    }
  },
  {
    name: "Curve creation T28: a small crossing box on a large circle or arc is not missed between polygon samples",
    run: () => {
      const circle = circleOf("entity:big", [0, 0], 1000);
      // Half way between two vertices of a 64-gon, where the old polygon sat 1.2 mm inside the true circle.
      const angle = Math.PI / 64;
      const onCircle = polar(1000, (angle * 180) / Math.PI);
      const box = { min: [onCircle[0] - 0.1, onCircle[1] - 0.1] as Vec2, max: [onCircle[0] + 0.1, onCircle[1] + 0.1] as Vec2 };
      equal(entitiesInSelectionBox([circle], box, "crossing").join(","), "entity:big", "a 0.2 mm box centred on the outline selects the circle");
      const inside = { min: [-1, -1] as Vec2, max: [1, 1] as Vec2 };
      equal(entitiesInSelectionBox([circle], inside, "crossing").length, 0, "a box well inside the circle does not");
      const around = { min: [-1500, -1500] as Vec2, max: [1500, 1500] as Vec2 };
      equal(entitiesInSelectionBox([circle], around, "crossing").length, 1, "a box that contains the circle selects it in crossing mode");
      const arc = build("arc", [polar(1000, 0), polar(1000, 20), polar(1000, 40)]);
      const arcPoint = polar(1000, 22.5);
      const arcBox = { min: [arcPoint[0] - 0.1, arcPoint[1] - 0.1] as Vec2, max: [arcPoint[0] + 0.1, arcPoint[1] + 0.1] as Vec2 };
      equal(entitiesInSelectionBox([arc], arcBox, "crossing").length, 1, "and the same on a large arc");
    }
  }
];
