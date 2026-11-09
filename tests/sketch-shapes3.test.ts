import { type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildArcSlot, buildCenterpointArcSlot, buildThreePointArcSlot } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { PROFILE_CHAINS, arcSlotProblem, addShape, drawEntity, emptyProject3, tryAdd, profileProject, stressProblem, wholeProblem } from "./sketch-shapes3-kit.js";
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
