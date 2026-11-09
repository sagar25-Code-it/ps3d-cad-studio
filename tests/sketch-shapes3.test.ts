import { type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildArcSlot, buildCenterpointArcSlot, buildThreePointArcSlot } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { assistedInference, DEFAULT_SNAP_ASSIST } from "../packages/workbench-sketch/src/snap-assist.js";
import { dynamicFieldsFor } from "../packages/workbench-sketch/src/dynamic-input.js";
import { parseFieldEntry, plainEvaluator, resolveDynamicEntry } from "../packages/workbench-sketch/src/dynamic-entry.js";
import { buildEdgePolygon, buildPolygon } from "../packages/workbench-sketch/src/shapes.js";
import { PROFILE_CHAINS, typedLineChain, arcSlotProblem, addShape, drawEntity, emptyProject3, tryAdd, profileProject, stressProblem, wholeProblem } from "./sketch-shapes3-kit.js";
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
