import { type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildArcSlot, buildCenterpointArcSlot, buildThreePointArcSlot } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { assistedInference, DEFAULT_SNAP_ASSIST } from "../packages/workbench-sketch/src/snap-assist.js";
import { dynamicFieldsFor } from "../packages/workbench-sketch/src/dynamic-input.js";
import { parseFieldEntry, plainEvaluator, resolveDynamicEntry } from "../packages/workbench-sketch/src/dynamic-entry.js";
import { buildEdgePolygon, buildPolygon } from "../packages/workbench-sketch/src/shapes.js";
import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { extendProfileChain, startProfileChain } from "../packages/workbench-sketch/src/blend-profile.js";
import { profileSnapRelations } from "../packages/workbench-sketch/src/shape-snap-relations.js";
import { typedIntentConstraints } from "../packages/workbench-sketch/src/typed-intent.js";
import { DEFAULT_CURVE_TOOL_OPTIONS, buildCurveTool } from "../packages/workbench-sketch/src/curve-tools.js";
import { gridSteps } from "../packages/workbench-sketch/src/camera.js";
import { buildSlot, buildSlotOverall } from "../packages/workbench-sketch/src/shapes.js";
import { buildFitSpline, tangentFromDegrees } from "../packages/workbench-sketch/src/spline-fit.js";
import { sampleSpline } from "../packages/workbench-sketch/src/index.js";
import { DEFAULT_SKETCH_KEYMAP, SKETCH_KEYMAP_COMMANDS, resolveSketchHotkey, sketchToolHotkeyChip } from "../packages/workbench-sketch/src/hotkeys.js";
import { buildConicByRho, buildControlPointSpline, buildHyperbola, conicArcPoint, controlPointCurve } from "../packages/workbench-sketch/src/conic-curves.js";
import { splineDeviationMm } from "../packages/workbench-sketch/src/fit-tolerance.js";
import { CURVE_TOOL_PROMPTS } from "../packages/workbench-sketch/src/curve-tools.js";
import { detectSketchProfiles, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import type { PolygonMode } from "../packages/workbench-sketch/src/regular-polygon.js";
import { worstJointGap } from "./sketch-shape-kit.js";
import { PROFILE_CHAINS, autoId, drawShape, inferPlaced, typedLineChain, arcSlotProblem, addShape, drawEntity, emptyProject3, tryAdd, profileProject, stressProblem, wholeProblem } from "./sketch-shapes3-kit.js";
import { arcRadius, dimension, shapeIds } from "./sketch-shape-kit.js";

/**
 * Wave 3, package "shapes3". Curve creation F1 (Profile tool tears apart on edit), and the guard that an edit never reports success on an open outline.
 * Each test draws the way the canvas does and goes through the real operations.
 */

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });

export const sketchShapes3Tests: readonly TestCase[] = [
  ...PROFILE_CHAINS.map((chain): TestCase => ({
    name: `Curve creation F1: the Profile tool (${chain.name}) joins every junction and stays one closed profile through every edit and drag`,
    run: () => {
      const { project, closed } = profileProject(chain.clicks);
      assert(closed, "the last click closes the loop");
      const coincident = project.sketch.constraints.filter((constraint) => constraint.kind === "coincident").length;
      equal(coincident, project.sketch.entities.length, "one Coincident joint per junction, closing joint included");
      equal(stressProblem(project, 1, chain.name.startsWith("wavy") ? null : 1), undefined, "the profile through every edit and drag");
    }
  })),
  {
    name: "Curve creation F1: a tangent arc started on a tangent arc is held Tangent, and the reported repro (line, tangent arc, line, line) holds through a vertex drag",
    run: () => {
      const { project } = profileProject([{ point: [40, 0], mode: "line" }, { point: [40, 30], mode: "tangent-arc" }, { point: [0, 30], mode: "line" }, { point: [0, 0], mode: "line" }]);
      const tangents = project.sketch.constraints.filter((constraint) => constraint.kind === "tangent").length;
      assert(tangents >= 1, "the arc is held tangent to the line before it");
      const chain = profileProject([{ point: [20, 0], mode: "line" }, { point: [40, 15], mode: "tangent-arc" }, { point: [60, 0], mode: "tangent-arc" }, { point: [80, -10], mode: "line" }, { point: [60, -30], mode: "tangent-arc" }, { point: [0, 0], mode: "line" }]).project;
      const kinds = chain.sketch.constraints.filter((constraint) => constraint.kind === "tangent").length;
      assert(kinds >= 3, `three tangent arcs are held tangent (found ${kinds})`);
    }
  },
  {
    name: "Curve creation F1 guard: a dimension edit never reports success while a touching outline is torn open",
    run: () => {
      // An outline from an older build: four lines that touch end to end but carry no Coincident relation.
      const entities = [line("entity:g1", [0, 0], [40, 0]), line("entity:g2", [40, 0], [40, 30]), line("entity:g3", [40, 30], [0, 30]), line("entity:g4", [0, 30], [0, 0])];
      const project = addShape(emptyProject3(), { entities, constraints: [] });
      equal(wholeProblem(project), undefined, "the loose outline is one profile");
      const edited = dimension(project, { entityId: "entity:g1", dimension: "length", valueMm: 24 });
      if (edited.ok) equal(wholeProblem(edited.project), undefined, "an accepted edit leaves the outline closed");
      else assert(/outline|touch/iu.test(edited.message), `a refusal says why: ${edited.message}`);
      assert(edited.ok, "the edit is carried out, the touching ends being held together for it");
    }
  }
];

const ARC_SLOTS = [
  { name: "arc slot (centreline arc)", build: () => buildArcSlot({ center: [0, 0], radiusMm: 30, startAngle: 0, sweep: Math.PI / 2 }, 4, shapeIds()) },
  { name: "3-point arc slot", build: () => buildThreePointArcSlot([30, 0], [21.2, 21.2], [0, 30], [30, 4], shapeIds()) },
  { name: "centerpoint arc slot", build: () => buildCenterpointArcSlot([0, 0], [30, 0], [0, 30], [30, 4], shapeIds()) }
] as const;

export const sketchArcSlots3Tests: readonly TestCase[] = ARC_SLOTS.flatMap((slot): TestCase[] => [
  {
    name: `Constraint solver R2-4 / Curve creation F4: the ${slot.name} holds all four joints tangent`,
    run: () => {
      const built = slot.build();
      assert(built.ok, "builds");
      equal(built.value.constraints.filter((constraint) => constraint.kind === "tangent").length, 4, "a Tangent at each of the four joints");
      equal(built.value.constraints.filter((constraint) => constraint.kind === "coincident").length, 4, "and the four joints");
      const project = addShape(emptyProject3(), built.value);
      equal(wholeProblem(project), undefined, "as drawn");
      equal(arcSlotProblem(project.sketch), undefined, "the slot as drawn");
    }
  },
  {
    name: `Constraint solver R2-4: the ${slot.name} keeps its width and its smooth joints through a radius edit of every arc and a drag of every handle`,
    run: () => {
      const built = slot.build();
      assert(built.ok, "builds");
      const project = addShape(emptyProject3(), built.value);
      const arcs = project.sketch.entities.filter((entity) => entity.kind === "arc");
      for (const arc of arcs) {
        for (const factor of [1.33, 0.8, 2.5]) {
          const edited = dimension(project, { entityId: arc.id, dimension: "radius", valueMm: arcRadius(arc)! * factor });
          if (!edited.ok) continue;
          equal(wholeProblem(edited.project), undefined, `after the radius of ${arc.id} x${factor}`);
          equal(arcSlotProblem(edited.project.sketch), undefined, `the slot after the radius of ${arc.id} x${factor}`);
        }
      }
      equal(stressProblem(project), undefined, "every edit and drag");
      // The reported repro: outer arc 30 + 4 -> 40 and a cap 4 -> 10 used to change the width and kink the corners.
      const outer = dimension(project, { entityId: arcs[0]!.id, dimension: "radius", valueMm: 40 });
      assert(outer.ok, `the outer arc takes radius 40: ${outer.ok ? "" : outer.message}`);
      equal(wholeProblem(outer.project), undefined, "outer radius 40");
      const cap = dimension(project, { entityId: arcs[1]!.id, dimension: "radius", valueMm: 10 });
      if (cap.ok) { equal(wholeProblem(cap.project), undefined, "cap radius 10 keeps smooth joints"); equal(arcSlotProblem(cap.project.sketch), undefined, "cap radius 10 keeps the slot a slot"); }
    }
  }
]);

const seedLine = (): WorkbenchProject => addShape(emptyProject3(), { entities: [line("entity:seed-line", [-10, 0], [10, 0])], constraints: [] });

export const sketchSnapRelations3Tests: readonly TestCase[] = [
  {
    name: "Curve creation F5: a 3-point arc whose through-point snaps to a line end is accepted and passes through that end",
    run: () => {
      const project = seedLine();
      const drawn = drawEntity("arc", project, [[40, 40], [10.2, 0.1], [-40, 40]]);
      const through = drawn.constraints.find((constraint) => constraint.kind === "coincident");
      assert(through !== undefined, "the through-point earns a relation");
      assert(through.points?.includes("curve") === true, "held as the line end ON the arc (a through-point is not the middle of the sweep)");
      const added = tryAdd(project, { entities: [drawn.entity], constraints: drawn.constraints });
      assert(added.ok, `the arc and its relation are accepted: ${added.ok ? "" : added.message}`);
      const arc = added.project.sketch.entities.find((entity) => entity.id === drawn.entity.id)!;
      assert(arc.kind === "arc", "an arc");
      const centre = circleThrough(arc.start, arc.mid, arc.end)!;
      near(Math.hypot(10 - centre[0], 0 - centre[1]), centre[2], 1e-6, "the line end lies on the arc's circle");
    }
  },
  ...([
    ["the origin", [[40, 40], [0.2, 0.1], [-30, 55]]],
    ["a line middle", [[40, 40], [0.2, 20.3], [-30, 55]]]
  ] as const).map(([name, pointers]): TestCase => ({
    name: `Curve creation F5: a 3-point arc whose through-point snaps to ${name} is accepted`,
    run: () => {
      const project = name === "a line middle" ? addShape(emptyProject3(), { entities: [line("entity:seed-line2", [-10, 20], [10, 20])], constraints: [] }) : seedLine();
      const drawn = drawEntity("arc", project, pointers as unknown as Vec2[]);
      assert(drawn.placed[1]?.primary !== undefined, `the through-point snapped (${name})`);
      const added = tryAdd(project, { entities: [drawn.entity], constraints: drawn.constraints });
      assert(added.ok, `accepted with ${drawn.constraints.map((constraint) => constraint.kind).join(",")}: ${added.ok ? "" : added.message}`);
    }
  })),
  {
    name: "Curve creation F5: a line that starts on an existing 3-point arc's through-point is accepted",
    run: () => {
      const project = addShape(emptyProject3(), { entities: [{ id: "entity:seed-arc", kind: "arc", start: [40, 40], mid: [10, 0], end: [-40, 40], construction: false }], constraints: [] });
      const drawn = drawEntity("line", project, [[10.1, 0.1], [30, -20]]);
      const added = tryAdd(project, { entities: [drawn.entity], constraints: drawn.constraints });
      assert(added.ok, `accepted with ${drawn.constraints.map((constraint) => constraint.kind).join(",")}: ${added.ok ? "" : added.message}`);
      assert(drawn.constraints.some((constraint) => constraint.kind === "coincident"), "and it is joined to the arc");
    }
  }
];

function circleThrough(a: Vec2, b: Vec2, c: Vec2): readonly [number, number, number] | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return [x, y, Math.hypot(a[0] - x, a[1] - y)];
}

const ellipse = (id: string, center: Vec2, majorRadiusMm: number, minorRadiusMm: number, rotationDeg: number): SketchEntity => ({ id, kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg, construction: false });

export const sketchEllipseCrossing3Tests: readonly TestCase[] = [
  {
    name: "Curve creation F6: an ellipse x circle crossing snap is exact and its two relations are accepted",
    run: () => {
      const project = addShape(emptyProject3(), { entities: [ellipse("entity:el1", [-8.3, 15.6], 47.6, 13.3, -74.9), { id: "entity:ci1", kind: "circle", center: [10, -0.15], radiusMm: 29.1, construction: false }], constraints: [] });
      let snapped = 0;
      for (let trial = 0; trial < 12; trial += 1) {
        const pointer: Vec2 = [-18.77 + (trial % 4) * 0.07 - 0.1, 4.3 + Math.floor(trial / 4) * 0.06 - 0.06];
        const drawn = drawEntity("point", project, [pointer], { tolerance: 1 });
        if (drawn.placed[0]?.primary?.kind !== "intersection") continue;
        snapped += 1;
        const at = drawn.placed[0].point;
        near(Math.hypot(at[0] - 10, at[1] + 0.15), 29.1, 1e-9, "the snap is on the circle");
        const added = tryAdd(project, { entities: [drawn.entity], constraints: drawn.constraints });
        assert(added.ok, `the point and its relations (${drawn.constraints.map((constraint) => constraint.kind).join(",")}) are accepted: ${added.ok ? "" : added.message}`);
      }
      assert(snapped >= 6, `the crossing snapped in most trials (${snapped})`);
    }
  },
  {
    name: "Curve creation F6: an ellipse x ellipse crossing snap is exact and its relations are accepted",
    run: () => {
      const project = addShape(emptyProject3(), { entities: [ellipse("entity:el1", [0, 0], 30, 12, 20), ellipse("entity:el2", [4, 3], 28, 10, -50)], constraints: [] });
      let snapped = 0;
      const seen: Vec2[] = [];
      for (let gx = -30; gx <= 30; gx += 0.7) for (let gy = -30; gy <= 30; gy += 0.7) {
        const drawn = drawEntity("point", project, [[gx, gy]], { tolerance: 0.6 });
        const at = drawn.placed[0]?.point;
        if (at === undefined || seen.some((earlier) => Math.hypot(earlier[0] - at[0], earlier[1] - at[1]) < 1e-6)) continue;
        if (drawn.placed[0]?.primary?.kind !== "intersection") continue;
        seen.push(at);
        snapped += 1;
        const added = tryAdd(project, { entities: [drawn.entity], constraints: drawn.constraints });
        assert(added.ok, `accepted (${drawn.constraints.map((constraint) => constraint.kind).join(",")}): ${added.ok ? "" : added.message}`);
      }
      assert(snapped >= 3, `the pointer snapped to a crossing (${snapped})`);
    }
  }
];

const FOUR_SIDED: readonly { readonly texts: { readonly length?: string; readonly angle?: string; readonly x?: string; readonly y?: string } }[] = [
  { texts: { x: "0", y: "0" } },
  { texts: { length: "80", angle: "0" } },
  { texts: { length: "50", angle: "90" } },
  { texts: { length: "80", angle: "180" } },
  { texts: { length: "50", angle: "270" } }
];

export const sketchTypedEntry3Tests: readonly TestCase[] = [
  {
    name: "UX flow R2-2: a typed outline back to its start is joined: the closing line is Coincident with the first line, and a length edit keeps the loop closed",
    run: () => {
      const { project, ids } = typedLineChain(emptyProject3(), FOUR_SIDED);
      equal(ids.length, 4, "four lines");
      const joints = project.sketch.constraints.filter((constraint) => constraint.kind === "coincident");
      // Lines 2, 3 and 4 join the end of the line before; the closing line also ends on the start of the first (or the origin).
      assert(joints.length >= 5, `every junction and the closing one are joined (found ${joints.length}: ${project.sketch.constraints.map((constraint) => constraint.kind).join(",")})`);
      equal(wholeProblem(project), undefined, "closed as typed");
      // All four lengths were typed, so they are driving dimensions: widening one side alone contradicts the opposite side and is refused,
      // where the unjoined outline used to accept it and tear into a notched shape.
      const refused = dimension(project, { entityId: ids[0]!, dimension: "length", valueMm: 100 });
      assert(!refused.ok, "a contradiction with the typed opposite side is refused");
      // Typing only the directions leaves the sizes free: the loop then follows an edit of one side.
      const free = typedLineChain(emptyProject3(), [
        { texts: { x: "0", y: "0" } },
        { texts: { angle: "0" }, cursor: [80, 0] },
        { texts: { angle: "90" }, cursor: [80, 50] },
        { texts: { angle: "180" }, cursor: [0, 50] },
        { texts: { angle: "270" }, cursor: [0, 0] }
      ]);
      equal(wholeProblem(free.project), undefined, "closed as typed");
      const edited = dimension(free.project, { entityId: free.ids[0]!, dimension: "length", valueMm: 100 });
      assert(edited.ok, `the first side can be resized: ${edited.ok ? "" : edited.message}`);
      equal(wholeProblem(edited.project), undefined, "still one closed profile after the first side is 100");
      const sides = edited.project.sketch.entities.filter((entity) => entity.kind === "line");
      const bottom = sides[0]!;
      const left = sides[3]!;
      near(left.kind === "line" ? left.end[0] : NaN, 0, 1e-6, "the closing side still ends at the origin");
      near(bottom.kind === "line" ? bottom.end[0] : NaN, 100, 1e-6, "the first side is 100 long");
    }
  },
  {
    name: "UX flow R2-2: a typed start on an existing line end is joined to it, and a typed start at the origin is Coincident with the origin",
    run: () => {
      const project = addShape(emptyProject3(), { entities: [line("entity:seed", [10, 0], [30, 20])], constraints: [] });
      const onEnd = typedLineChain(project, [{ texts: { x: "30", y: "20" } }, { texts: { length: "15", angle: "0" } }]);
      const lines = onEnd.project.sketch.constraints.filter((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes("entity:seed"));
      equal(lines.length, 1, "the typed start is Coincident with the seed line's end");
      const atOrigin = typedLineChain(emptyProject3(), [{ texts: { x: "0", y: "0" } }, { texts: { length: "15", angle: "30" } }]);
      assert(atOrigin.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin"), "the typed origin joins the sketch origin");
    }
  },
  {
    name: "UX flow R2-2: a typed point that is not on anything gets no join, and is placed exactly where it was typed",
    run: () => {
      const { project } = typedLineChain(emptyProject3(), [{ texts: { x: "5", y: "5" } }, { texts: { length: "10", angle: "0" } }]);
      equal(project.sketch.constraints.filter((constraint) => constraint.kind === "coincident").length, 0, "nothing to join");
      const only = project.sketch.entities[0]!;
      assert(only.kind === "line" && only.end[0] === 15 && only.end[1] === 5, "exactly (15, 5)");
    }
  },
  {
    name: "Curve creation F7: the sticky ortho lock does not turn a rectangle into a square; Shift still does, and a line is still locked",
    run: () => {
      for (const tool of ["rectangle", "rectangle-center", "rectangle-rounded"] as const) {
        const ortho = assistedInference({ tool, pointer: [30, 12], sketch: emptyProject3().sketch, toleranceMm: 0.5, gridMm: undefined, anchor: [0, 0], placedCount: 1, settings: { ...DEFAULT_SNAP_ASSIST, ortho: true, snap: false } });
        equal(ortho.point[1], 12, `${tool}: ortho keeps the height the pointer gave`);
        const shift = assistedInference({ tool, pointer: [30, 12], sketch: emptyProject3().sketch, toleranceMm: 0.5, gridMm: undefined, anchor: [0, 0], placedCount: 1, settings: { ...DEFAULT_SNAP_ASSIST, snap: false }, modifiers: { ctrl: false, shift: true } });
        equal(shift.point[1], 30, `${tool}: Shift still draws a square`);
      }
      const lineOrtho = assistedInference({ tool: "line", pointer: [30, 12], sketch: emptyProject3().sketch, toleranceMm: 0.5, gridMm: undefined, anchor: [0, 0], placedCount: 1, settings: { ...DEFAULT_SNAP_ASSIST, ortho: true, snap: false } });
      equal(lineOrtho.point[1], 0, "a line is still locked level by ortho");
    }
  },
  {
    name: "Curve creation F8: the polygon field is labelled for what the number means in each mode, and the number means that",
    run: () => {
      equal(dynamicFieldsFor("polygon", 1, "inscribed")[0]!.label, "Circumradius", "inscribed");
      equal(dynamicFieldsFor("polygon", 1, "circumscribed")[0]!.label, "Apothem", "circumscribed");
      equal(dynamicFieldsFor("polygon", 1, "edge")[0]!.label, "Side length", "edge");
      equal(dynamicFieldsFor("polygon", 1)[0]!.label, "Circumradius", "the default is unchanged");
      const apothem = resolveDynamicEntry({ tool: "polygon", placed: [[0, 0]], cursor: [5, 0], fields: dynamicFieldsFor("polygon", 1, "circumscribed"), texts: { radius: "10" } });
      assert(apothem.ok, "typed apothem");
      const circumscribed = buildPolygon([0, 0], apothem.point, 6, shapeIds(), "circumscribed");
      assert(circumscribed.ok, "builds");
      near(circumscribed.value.sizeDimension.valueMm, 10, 1e-9, "the typed number is the apothem");
      const side = resolveDynamicEntry({ tool: "polygon", placed: [[0, 0]], cursor: [5, 0], fields: dynamicFieldsFor("polygon", 1, "edge"), texts: { radius: "10" } });
      assert(side.ok, "typed side");
      const edge = buildEdgePolygon([0, 0], side.point, 6, shapeIds());
      assert(edge.ok, "builds");
      near(edge.value.sizeDimension.valueMm, 10, 1e-9, "the typed number is the side length");
    }
  },
  {
    name: "Curve creation F12: inch values typed as expressions carry no unit-conversion dust",
    run: () => {
      const length = dynamicFieldsFor("line", 1)[0]!;
      const parsed = parseFieldEntry("3*2", length, plainEvaluator, "in");
      assert(parsed.ok, "parses");
      equal(parsed.value, 152.4, "6 in is exactly 152.4 mm");
      const entry = resolveDynamicEntry({ tool: "line", placed: [[0, 0]], cursor: [1, 0], fields: dynamicFieldsFor("line", 1), texts: { length: "3*2", angle: "0" }, unit: "in" });
      assert(entry.ok, "resolves");
      equal(entry.typed.length, 152.4, "the stored dimension is exact");
      const three = parseFieldEntry("3", length, plainEvaluator, "in");
      assert(three.ok, "3 in parses");
      equal(three.value, 76.2, "3 in");
    }
  },
  {
    name: "Curve creation F13: a number with both a comma and a point is told what to write instead of being told to write what it was",
    run: () => {
      const field = dynamicFieldsFor("line", 1)[0]!;
      for (const text of ["1,5.5", "1.000,5", "1,000.5", "-2,5.25 mm"]) {
        const parsed = parseFieldEntry(text, field);
        assert(!parsed.ok, `${text} is refused`);
        assert(!parsed.message.startsWith(`Write ${text} `), `the message does not just repeat the input: ${parsed.message}`);
        assert(/decimal/iu.test(parsed.message), `it names the problem: ${parsed.message}`);
      }
      const grouped = parseFieldEntry("1,000.5", field);
      assert(!grouped.ok && grouped.message.includes("1000.5"), "1,000.5 is offered as 1000.5");
      const european = parseFieldEntry("1.000,5", field);
      assert(!european.ok && european.message.includes("1000.5"), "1.000,5 is offered as 1000.5");
    }
  }
];

const originCoincident = (project: WorkbenchProject, entityId: string, ref: string): boolean => project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin" && constraint.entityIds[1] === entityId && constraint.points?.[1] === ref);

export const sketchShapeSnaps3Tests: readonly TestCase[] = [
  {
    name: "Curve creation F9: a slot whose centres snap to the origin and to a line end is joined there",
    run: () => {
      const seed = addShape(emptyProject3(), { entities: [line("entity:seed", [30, 0], [50, 10])], constraints: [] });
      const drawn = drawShape("slot", seed, [[0.2, 0.1], [30.1, 0.1], [15, 5]]);
      const arcs = drawn.project.sketch.entities.filter((entity) => entity.kind === "arc");
      assert(drawn.extra.length >= 2, `relations for both snapped centres (${drawn.extra.map((relation) => relation.kind).join(",")})`);
      assert(originCoincident(drawn.project, arcs[1]!.id, "center") || originCoincident(drawn.project, arcs[0]!.id, "center"), "a cap's centre is Coincident with the origin");
      assert(drawn.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes("entity:seed") && constraint.points?.includes("center") === true), "the other cap's centre is Coincident with the line start");
      equal(wholeProblem(drawn.project), undefined, "the slot is whole");
    }
  },
  ...(["slot-straight", "slot"] as const).map((tool): TestCase => ({
    name: `Curve creation F9: a ${tool} started on the origin is Coincident with the sketch origin and stays whole through every edit and drag`,
    run: () => {
      const drawn = drawShape(tool, emptyProject3(), tool === "slot" ? [[0.2, 0.1], [30, 0], [15, 5]] : [[0.1, 0.1], [40, 0], [20, 6]]);
      const arcs = drawn.project.sketch.entities.filter((entity) => entity.kind === "arc");
      assert(arcs.some((arc) => originCoincident(drawn.project, arc.id, tool === "slot" ? "center" : "mid")), `joined to the origin (${drawn.extra.map((relation) => `${relation.kind}:${relation.points?.join("/")}`).join(", ")})`);
      // A cap pinned to the origin can only be dragged by its radius; the solver may then turn that arc over (a cusp), so a drag is held to closed joints, not to tangency.
      equal(stressProblem(drawn.project, 1, null, false), undefined, "the slot through every edit and drag");
    }
  })),
  ...(["inscribed", "circumscribed", "edge"] as const).map((mode): TestCase => ({
    name: `Curve creation F9: a polygon (${mode}) whose snapped points land on other geometry is joined to it`,
    run: () => {
      const seed = addShape(emptyProject3(), { entities: [line("entity:seed", [20, 0], [20, 30])], constraints: [] });
      // Inscribed: the corner click on the seed's start; circumscribed has no corner click to join; edge: both side ends on seed ends.
      const pointers: readonly Vec2[] = mode === "edge" ? [[20.1, 0.1], [20.1, 30.05]] : mode === "inscribed" ? [[0.2, 0.1], [20.1, 0.1]] : [[0.2, 0.1], [10, 0]];
      const drawn = drawShape("polygon", seed, pointers, { polygonMode: mode });
      const joined = drawn.project.sketch.constraints.filter((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes("entity:seed")).length;
      if (mode === "circumscribed") equal(joined, 0, "no corner is clicked in circumscribed mode");
      else equal(joined, mode === "edge" ? 2 : 1, "the clicked corner(s) are joined to the seed line");
      assert(mode === "edge" || drawn.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin"), "the centre is on the origin");
      equal(wholeProblem(drawn.project), undefined, "the polygon is whole");
    }
  })),
  {
    name: "Curve creation F9: a midpoint line, a centerline, a parallelogram and an arc slot are joined to the points their clicks were snapped to",
    run: () => {
      const seed = addShape(emptyProject3(), { entities: [line("entity:seed", [30, 0], [50, 10])], constraints: [] });
      const midLine = drawShape("line-midpoint", seed, [[0.2, 0.1], [20, 10]]);
      assert(midLine.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin"), "the midpoint line's centre point is on the origin");
      const center = drawShape("centerline", seed, [[30.1, 0.1], [60, 20]]);
      assert(center.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes("entity:seed") && constraint.points?.includes("curve") === true), "the centerline passes through the seed's start");
      const para = drawShape("parallelogram", seed, [[50.1, 10.1], [70, 10], [78, 25]]);
      assert(para.project.sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.entityIds.includes("entity:seed")), "the parallelogram's first corner is joined to the seed's end");
      equal(stressProblem(para.project), undefined, "the parallelogram through every edit and drag");
      const arcSlot = drawShape("slot-arc-three-point", emptyProject3(), [[0.2, 0.1], [10, 6], [20, 0], [10, 9]]);
      assert(arcSlot.extra.some((relation) => relation.kind === "coincident"), "the arc slot's start is on the origin");
      equal(stressProblem(arcSlot.project, 1, null, false), undefined, "the arc slot through every edit and drag");
    }
  },
  {
    name: "Curve creation F9: a Profile segment whose start and end were snapped to other geometry is joined to it",
    run: () => {
      const seed = addShape(emptyProject3(), { entities: [line("entity:seed", [0, 0], [0, 20]), line("entity:seed2", [30, 0], [30, 20])], constraints: [] });
      const first = inferPlaced("profile", seed, [[0.1, 0.1], [30.1, 0.1]]);
      const step = extendProfileChain(startProfileChain(first.points[0]!), first.points[1]!, "line", 0.5, shapeIds());
      assert(step.ok, "builds");
      const relations = profileSnapRelations({ entity: step.value.entity, placed: [first.placed[0]!, first.placed[1]!], own: step.value.constraints, sketch: seed.sketch, newId: autoId });
      equal(relations.filter((relation) => relation.kind === "coincident").length, 2, "both ends joined");
      const added = tryAdd(seed, { entities: [step.value.entity], constraints: [...step.value.constraints, ...relations] });
      assert(added.ok, `accepted: ${added.ok ? "" : added.message}`);
    }
  },
  ...([
    ["polygon (inscribed)", "polygon", [[0, 0], [10, 0]], { radius: 10 }, "inscribed", 1],
    ["polygon (circumscribed)", "polygon", [[0, 0], [10, 0]], { radius: 10 }, "circumscribed", 1],
    ["polygon (edge)", "polygon", [[0, 0], [10, 0]], { radius: 10 }, "edge", 1],
    ["slot", "slot", [[0, 0], [30, 0], [15, 4]], { length: 30, width: 8 }, "inscribed", 2],
    ["overall slot", "slot-straight", [[-4, 0], [34, 0], [15, 4]], { length: 38, width: 8 }, "inscribed", 2],
    ["midpoint line", "line-midpoint", [[0, 0], [10, 0]], { length: 10 }, "inscribed", 1]
  ] as const).map(([name, tool, pointers, typed, mode, expected]): TestCase => ({
    name: `Curve creation T17: typed ${name} sizes are recorded as driving dimensions`,
    run: () => {
      const drawn = drawShape(tool, emptyProject3(), pointers as unknown as Vec2[], { typed, polygonMode: mode });
      const dims = drawn.project.sketch.constraints.filter((constraint) => (constraint.kind === "distance" || constraint.kind === "radius") && constraint.valueMm !== undefined);
      equal(dims.length, expected, `${expected} dimension(s) (found ${dims.map((constraint) => `${constraint.kind}:${constraint.dimension}=${constraint.valueMm}`).join(", ")})`);
      if (tool !== "line-midpoint") equal(wholeProblem(drawn.project), undefined, "whole");
    }
  })),
  {
    name: "Curve creation T17: a typed arc radius and sweep, and typed ellipse axes, are recorded as dimensions",
    run: () => {
      const arc = buildSketchEntity("arc-center", [[0, 0], [10, 0], [0, 10]], "entity:t17-arc");
      assert(arc.ok, "arc builds");
      const arcDims = typedIntentConstraints({ tool: "arc-center", entity: arc.value, typed: { radius: 10, sweep: 90 }, newId: autoId });
      equal(arcDims.map((dimension) => dimension.kind).join(","), "radius,arc-length", "radius and arc length");
      near(arcDims[1]!.valueMm ?? NaN, (10 * Math.PI) / 2, 1e-6, "the arc length of a 90 degree sweep of radius 10");
      const withDims = addShape(emptyProject3(), { entities: [arc.value], constraints: arcDims });
      assert(withDims.sketch.constraints.length === 2, "accepted by the project");
      const ellipseBuilt = buildSketchEntity("ellipse", [[0, 0], [10, 0], [0, 4]], "entity:t17-ellipse");
      assert(ellipseBuilt.ok, "ellipse builds");
      const axes = typedIntentConstraints({ tool: "ellipse", entity: ellipseBuilt.value, typed: { major: 10, minor: 4 }, newId: autoId });
      equal(axes.map((dimension) => `${dimension.dimension}=${dimension.valueMm}`).join(","), "major-radius=10,minor-radius=4", "both axes");
      const withAxes = addShape(emptyProject3(), { entities: [ellipseBuilt.value], constraints: axes });
      assert(withAxes.sketch.constraints.length === 2, "accepted by the project");
      const resized = dimension(withAxes, { entityId: "entity:t17-ellipse", dimension: "major-radius", valueMm: 14 });
      assert(resized.ok, `the major axis can be edited: ${resized.ok ? "" : resized.message}`);
    }
  }
];

export const sketchBuilderGuards3Tests: readonly TestCase[] = [
  {
    name: "Curve creation T18: every shape and curve builder refuses NaN and Infinity with a message instead of returning ok",
    run: () => {
      const O = DEFAULT_CURVE_TOOL_OPTIONS;
      const ids = shapeIds();
      const cases: readonly (readonly [string, () => { readonly ok: boolean }])[] = [
        ["slot", () => buildSlot([0, 0], [Infinity, 0], [10, 3], ids)],
        ["overall slot", () => buildSlotOverall([0, 0], [20, NaN], [10, 3], ids)],
        ["polygon", () => buildPolygon([0, 0], [NaN, 1], 6, ids)],
        ["edge polygon", () => buildEdgePolygon([0, 0], [Infinity, 1], 6, ids)],
        ["polygon sides", () => buildPolygon([0, 0], [10, 0], NaN, ids)],
        ["centerline", () => buildCurveTool("centerline", [[0, 0], [NaN, 1]], O, ids)],
        ["midpoint line", () => buildCurveTool("line-midpoint", [[NaN, 0], [5, 5]], O, ids)],
        ["parallelogram", () => buildCurveTool("parallelogram", [[0, 0], [10, 0], [NaN, 5]], O, ids)],
        ["rounded rectangle", () => buildCurveTool("rectangle-rounded", [[0, 0], [NaN, 10]], O, ids)],
        ["rounded rectangle radius", () => buildCurveTool("rectangle-rounded", [[0, 0], [40, 20]], { ...O, cornerRadiusMm: NaN }, ids)],
        ["parabola", () => buildCurveTool("parabola", [[0, 0], [20, 0], [NaN, 12]], O, ids)],
        ["conic rho", () => buildCurveTool("conic", [[0, 0], [20, 0], [10, 12]], { ...O, rho: NaN }, ids)],
        ["arc slot", () => buildCurveTool("slot-arc-three-point", [[0, 0], [10, 6], [20, 0], [10, Infinity]], O, ids)],
        ["text", () => buildCurveTool("text", [[NaN, 0]], { ...O, text: "A" }, ids)],
        ["text height", () => buildCurveTool("text", [[0, 0]], { ...O, text: "A", textHeightMm: NaN }, ids)]
      ];
      for (const [name, build] of cases) {
        const result = build();
        assert(!result.ok, `${name} refuses a non-finite input`);
        const refused = result as { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] };
        assert(refused.diagnostics[0] !== undefined && refused.diagnostics[0].message.length > 10, `${name} says why`);
      }
      assert(buildSlot([0, 0], [20, 0], [10, 3], ids).ok, "a finite slot is still built");
    }
  },
  {
    name: "Curve creation T28: gridSteps with a scale or base that is not a finite number still returns finite steps",
    run: () => {
      for (const [base, perPixel] of [[1, NaN], [1, Infinity], [1, 0], [1, -5], [NaN, 1], [Infinity, 1], [-3, 1], [1, 1e-300], [1, 1e300]] as const) {
        const steps = gridSteps(base, perPixel);
        assert(Number.isFinite(steps.minorMm) && Number.isFinite(steps.majorMm) && steps.minorMm > 0 && steps.majorMm >= steps.minorMm, `gridSteps(${base}, ${perPixel}) is ${JSON.stringify(steps)}`);
      }
      const normal = gridSteps(1, 0.5);
      assert(normal.minorMm === 10 || normal.minorMm === 5 || normal.minorMm === 2 || normal.minorMm === 1, `a normal zoom keeps its steps (${normal.minorMm})`);
    }
  },
  {
    name: "Curve creation F11: wide-letter text beyond the old 200-curve edit limit is accepted and applies",
    run: () => {
      const text = buildCurveTool("text", [[0, 0]], { ...DEFAULT_CURVE_TOOL_OPTIONS, text: "B".repeat(40) }, shapeIds());
      assert(text.ok, `40 B characters build (${text.ok ? "" : text.diagnostics[0]?.message})`);
      assert(text.value.entities.length > 200, `with more than 200 curves (${text.value.entities.length})`);
      const added = tryAdd(emptyProject3(), text.value);
      assert(added.ok, `and the project takes them: ${added.ok ? "" : added.message}`);
    }
  }
];

const direction = (from: Vec2, to: Vec2): number => (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
const wrap180 = (degrees: number): number => ((((degrees + 180) % 360) + 360) % 360) - 180;

export const sketchSpline3Tests: readonly TestCase[] = [
  {
    name: "Curve creation T26: two points make a straight spline that the project accepts and that lies on the chord",
    run: () => {
      for (const mode of ["uniform", "chord-length", "centripetal"] as const) {
        const built = buildFitSpline([[0, 0], [30, 10]], mode, "entity:two-point");
        assert(built.ok, `${mode}: two points build (${built.ok ? "" : built.diagnostics[0]?.message})`);
        assert(built.value.kind === "spline", "a spline");
        const samples = sampleSpline(built.value.fitPoints, 8);
        for (const point of samples) near(Math.abs(point[0] * 10 - point[1] * 30) / Math.hypot(10, 30), 0, 1e-9, `${mode}: every sample lies on the chord`);
        near(samples[0]![0], 0, 1e-12, "starts at the first point");
        near(samples.at(-1)![0], 30, 1e-12, "ends at the second point");
        const added = tryAdd(emptyProject3(), { entities: [built.value], constraints: [] });
        assert(added.ok, `${mode}: the project takes it: ${added.ok ? "" : added.message}`);
      }
      assert(!buildFitSpline([[0, 0], [0.001, 0]], "uniform", "entity:tiny").ok, "two points on top of each other are refused");
      assert(!buildFitSpline([[0, 0]], "uniform", "entity:one").ok, "one point is not a spline");
    }
  },
  ...([[30, 0, 30, 0], [90, undefined, 90, undefined], [undefined, -45, undefined, -45], [60, 120, 60, 120]] as const).map(([start, end]): TestCase => ({
    name: `Curve creation T26: a two-point spline with end directions ${start ?? "free"} / ${end ?? "free"} degrees leaves and arrives along them`,
    run: () => {
      const built = buildFitSpline([[0, 0], [40, 10]], "uniform", "entity:tangent", { start: tangentFromDegrees(start), end: tangentFromDegrees(end) });
      assert(built.ok, `builds: ${built.ok ? "" : built.diagnostics[0]?.message}`);
      assert(built.value.kind === "spline", "a spline");
      const fit = built.value.fitPoints;
      const samples = sampleSpline(fit, 400);
      near(samples[0]![0], 0, 1e-12, "starts at the first point");
      near(samples.at(-1)![0], 40, 1e-12, "ends at the second point");
      if (start !== undefined) near(Math.abs(wrap180(direction(samples[0]!, samples[1]!) - start)), 0, 0.2, "leaves along the start direction");
      if (end !== undefined) near(Math.abs(wrap180(direction(samples.at(-2)!, samples.at(-1)!) - end)), 0, 0.2, "arrives along the end direction");
      const added = tryAdd(emptyProject3(), { entities: [built.value], constraints: [] });
      assert(added.ok, `the project takes it: ${added.ok ? "" : added.message}`);
    }
  })),
  {
    name: "Curve creation T26: end directions on a longer fit-point spline keep every clicked point and the direction at both ends",
    run: () => {
      const clicks: readonly Vec2[] = [[0, 0], [20, 15], [45, 5], [70, 20]];
      const built = buildFitSpline(clicks, "uniform", "entity:long", { start: tangentFromDegrees(0), end: tangentFromDegrees(90) });
      assert(built.ok && built.value.kind === "spline", "builds");
      for (const click of clicks) assert(built.value.fitPoints.some((point) => Math.hypot(point[0] - click[0], point[1] - click[1]) < 1e-9), `the clicked point ${click.join(",")} is kept`);
      const samples = sampleSpline(built.value.fitPoints, 400);
      near(Math.abs(wrap180(direction(samples[0]!, samples[1]!) - 0)), 0, 0.2, "start direction");
      near(Math.abs(wrap180(direction(samples.at(-2)!, samples.at(-1)!) - 90)), 0, 0.2, "end direction");
      assert(!buildFitSpline(clicks, "uniform", "entity:bad", { start: [0, 0] }).ok, "a zero direction is refused with a message");
    }
  }
];

export const sketchHotkeys3Tests: readonly TestCase[] = [
  {
    name: "Curve creation N9: the elliptical-arc and both tangent-circle tools have default keys, no key is shared, and each key starts its tool",
    run: () => {
      const wanted: readonly (readonly [string, string])[] = [["tool:ellipse-arc", "Shift+E"], ["tool:circle-tangent-3", "H"], ["tool:circle-tangent-2", "Shift+H"]];
      const claimed = new Map<string, string>();
      for (const command of SKETCH_KEYMAP_COMMANDS) {
        if (command.defaultKey === undefined) continue;
        assert(!claimed.has(command.defaultKey), `${command.defaultKey} is claimed twice: ${claimed.get(command.defaultKey)} and ${command.id}`);
        claimed.set(command.defaultKey, command.id);
      }
      const idle = { tool: "select" as const, pendingPoints: 0, dynamicFieldCount: 0, curveSelectionCount: 0 };
      for (const [id, key] of wanted) {
        equal(DEFAULT_SKETCH_KEYMAP.keys[id as "tool:ellipse-arc"], key, `${id} defaults to ${key}`);
        const tool = id.slice(5);
        const shift = key.startsWith("Shift+");
        const action = resolveSketchHotkey({ key: key.replace("Shift+", "").toLowerCase(), shift, ctrl: false, alt: false, meta: false } as never, idle as never, DEFAULT_SKETCH_KEYMAP);
        assert(action?.kind === "tool" && action.tool === tool, `${key} starts ${tool}`);
        assert(sketchToolHotkeyChip(tool as "ellipse-arc", DEFAULT_SKETCH_KEYMAP) !== undefined, `${tool} shows a key chip`);
      }
    }
  }
];

export const sketchFit3Tests: readonly TestCase[] = [
  {
    name: "Curve creation T13: conics of every rho stay within 0.02 mm of the exact curve (measured to the curve, not to its sample points)",
    run: () => {
      const ids = shapeIds();
      for (const rho of [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 0.98]) {
        for (const [start, end, apex] of [[[0, 0], [60, 0], [30, 25]], [[0, 0], [60, 0], [30, 200]], [[0, 0], [10, 0], [5, 40]], [[0, 0], [60, 0], [5, 25]], [[0, 0], [250, 0], [125, 90]]] as const) {
          const built = buildConicByRho(start, end, apex, rho, ids);
          assert(built.ok, `rho ${rho} builds`);
          const fit = (built.value.entities[0] as { fitPoints: readonly Vec2[] }).fitPoints;
          const reference = Array.from({ length: 12001 }, (_, index): Vec2 => conicArcPoint(start, apex, end, rho, index / 12000));
          const deviation = splineDeviationMm(fit, reference);
          assert(deviation <= 0.02, `rho ${rho} over ${JSON.stringify([start, end, apex])}: ${deviation.toFixed(4)} mm`);
        }
      }
    }
  },
  {
    name: "Curve creation T13: hyperbola branches and open control-point splines stay within 0.02 mm of the exact curve",
    run: () => {
      const ids = shapeIds();
      for (const [center, vertex, branch] of [[[0, 0], [10, 0], [20, 15]], [[0, 0], [10, 0], [100, 15]], [[0, 0], [10, 0], [12, 80]], [[0, 0], [30, 0], [40, 100]]] as const) {
        const built = buildHyperbola(center, vertex, branch, ids);
        assert(built.ok, "hyperbola builds");
        const fit = (built.value.entities[0] as { fitPoints: readonly Vec2[] }).fitPoints;
        const a = Math.hypot(vertex[0] - center[0], vertex[1] - center[1]);
        const b = Math.abs(branch[1]) / Math.sqrt((branch[0] * branch[0]) / (a * a) - 1);
        const tEnd = Math.asinh(Math.abs(branch[1]) / b);
        const reference = Array.from({ length: 12001 }, (_, index): Vec2 => { const t = -tEnd + (2 * tEnd * index) / 12000; return [center[0] + a * Math.cosh(t), center[1] + b * Math.sinh(t)]; });
        const deviation = splineDeviationMm(fit, reference);
        assert(deviation <= 0.02, `hyperbola ${JSON.stringify([center, vertex, branch])}: ${deviation.toFixed(4)} mm`);
      }
      for (const controls of [[[0, 0], [10, 30], [30, 35], [50, 10], [60, 0]], [[0, 0], [20, 40], [40, -40], [60, 0]], [[0, 0], [5, 8], [12, -3], [20, 5]], [[0, 0], [100, 100], [200, -100], [300, 100], [400, 0]], [[0, 0], [50, 0], [50, 50], [0, 50], [0, 10]]] as readonly (readonly Vec2[])[]) {
        const built = buildControlPointSpline(controls, false, false, ids);
        assert(built.ok, "control spline builds");
        const fit = (built.value.entities[0] as { fitPoints: readonly Vec2[] }).fitPoints;
        const deviation = splineDeviationMm(fit, controlPointCurve(controls, false, 12000));
        assert(deviation <= 0.02, `control-point spline ${JSON.stringify(controls)}: ${deviation.toFixed(4)} mm (the audit saw 0.104)`);
      }
    }
  },
  {
    name: "Curve creation T13: the tool prompts of the conic and control-point tools state the tolerance they hold",
    run: () => {
      for (const tool of ["conic", "parabola", "hyperbola", "conic-five", "spline-control"] as const) {
        assert(/0\.01 mm/u.test(CURVE_TOOL_PROMPTS[tool].join(" ")), `${tool}'s prompt states its tolerance`);
      }
    }
  }
];

const EVERY_SHAPE: readonly { readonly name: string; readonly tool: SketchTool; readonly pointers: readonly Vec2[]; readonly mode?: PolygonMode; readonly pinned: boolean }[] = [
  { name: "slot", tool: "slot", pointers: [[5.3, 3.1], [35, 3], [20, 8]], pinned: false },
  { name: "slot on the origin", tool: "slot", pointers: [[0.2, 0.1], [30, 0], [15, 5]], pinned: true },
  { name: "overall slot", tool: "slot-straight", pointers: [[-3, 2.5], [37, 2.5], [17, 8]], pinned: false },
  { name: "rounded rectangle", tool: "rectangle-rounded", pointers: [[3.2, 4.1], [63, 44]], pinned: false },
  { name: "parallelogram", tool: "parallelogram", pointers: [[0, 0], [30, 0], [40, 15]], pinned: false },
  { name: "parallelogram on the origin", tool: "parallelogram", pointers: [[0.2, 0.1], [30, 0], [40, 15]], pinned: true },
  { name: "3-point arc slot", tool: "slot-arc-three-point", pointers: [[5, 5], [15, 11], [25, 5], [15, 14]], pinned: false },
  { name: "centerpoint arc slot", tool: "slot-arc-center", pointers: [[5, 5], [15, 5], [5, 15], [13, 7]], pinned: false },
  { name: "hexagon on the origin", tool: "polygon", pointers: [[0.1, 0.1], [10, 0]], mode: "inscribed", pinned: true },
  { name: "pentagon (circumscribed)", tool: "polygon", pointers: [[5, 5], [5, 13]], mode: "circumscribed", pinned: false },
  { name: "heptagon (edge)", tool: "polygon", pointers: [[0, 0], [12, 0]], mode: "edge", pinned: false }
];

export const sketchEveryShape3Tests: readonly TestCase[] = EVERY_SHAPE.map((shape): TestCase => ({
  name: `Curve creation F1/F4/F9: the ${shape.name} (drawn with its snap relations) stays closed with zero joint gaps through every dimension edit and handle drag`,
  run: () => {
    const drawn = drawShape(shape.tool, emptyProject3(), shape.pointers, shape.mode === undefined ? {} : { polygonMode: shape.mode });
    assert(detectSketchProfiles(drawn.project.sketch).length === 1, "one profile as drawn");
    equal(worstJointGap(drawn.project.sketch) < 1e-9, true, "no joint gap as drawn");
    // Drags: a cap pinned to the origin can be turned over by the solver (a cusp), so those are held to closed joints only.
    equal(stressProblem(drawn.project, 1, shape.pinned ? null : 1, !shape.pinned), undefined, `${shape.name}`);
  }
}));
