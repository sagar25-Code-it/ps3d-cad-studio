import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { buildEdgePolygon, buildPolygon, POLYGON_MAX_SIDES, POLYGON_MIN_SIDES } from "../packages/workbench-sketch/src/shapes.js";
import { buildPolygonByMode, parsePolygonMode, polygonCentreRelations } from "../packages/workbench-sketch/src/polygon-modes.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { dimension, dragAndCommit, projectWith, shapeIds, shapeProblem } from "./sketch-shape-kit.js";

/** T03 / T01 / N3: the Polygon tool builds a regular polygon (centre, guide circle, equal sides on it) that stays regular. */

function build(sides: number, mode: "inscribed" | "circumscribed" = "inscribed", center: [number, number] = [0, 0], point: [number, number] = [10, 0]) {
  const built = buildPolygon(center, point, sides, shapeIds(), mode);
  assert(built.ok, "the polygon builds");
  return built.value;
}

export const sketchRegularPolygonTests: readonly TestCase[] = [
  {
    name: "Curve tools T03: a regular n-gon has 4 degrees of freedom (centre, size, turn) and 3 once its one size dimension is set, for every n",
    run: () => {
      for (const sides of [POLYGON_MIN_SIDES, 4, 5, 6, 8, 12, POLYGON_MAX_SIDES]) {
        for (const mode of ["inscribed", "circumscribed"] as const) {
          const shape = build(sides, mode);
          const project = projectWith(shape);
          const before = analyzeWorkbenchSketch(project.sketch);
          equal(before.degreesOfFreedom, 4, `n=${sides} ${mode}: centre 2 + size 1 + turn 1`);
          equal(before.redundant.length, 0, `n=${sides} ${mode}: no relation is redundant`);
          const size = shape.sizeDimension;
          const sized = dimension(project, { entityId: size.entityId, dimension: size.dimension, valueMm: size.valueMm, ...(size.secondEntityId === undefined ? {} : { secondEntityId: size.secondEntityId }), ...(size.points === undefined ? {} : { points: size.points }) });
          assert(sized.ok, `n=${sides} ${mode}: the size dimension applies: ${sized.ok ? "" : sized.message}`);
          equal(analyzeWorkbenchSketch(sized.project.sketch).degreesOfFreedom, 3, `n=${sides} ${mode}: one dimension leaves position and turn`);
        }
      }
    }
  },
  {
    name: "Curve tools T03: inscribed puts the corners on the clicked circle, circumscribed puts the sides' middles on it, edge makes the clicks one side",
    run: () => {
      const inscribed = build(6, "inscribed", [3, 4], [13, 4]);
      const guide = inscribed.entities.find((entity) => entity.kind === "circle");
      assert(guide?.kind === "circle" && guide.construction, "a construction guide circle");
      near(guide.radiusMm, 10, 1e-9, "inscribed: the circle radius is the clicked radius");
      near(inscribed.sizeDimension.valueMm, 10, 1e-9, "inscribed: its size dimension is that radius");
      equal(inscribed.sizeDimension.dimension, "radius", "inscribed: a radius dimension");
      const corner = inscribed.entities[0]!;
      assert(corner.kind === "line", "side");
      near(corner.start[0], 13, 1e-9, "inscribed: the first corner is the click");

      const circumscribed = build(6, "circumscribed", [3, 4], [13, 4]);
      equal(circumscribed.sizeDimension.dimension, "point-line", "circumscribed: sized by the apothem (centre to side)");
      near(circumscribed.sizeDimension.valueMm, 10, 1e-9, "circumscribed: the apothem is the clicked distance");
      const sides = circumscribed.entities.filter((entity) => entity.kind === "line");
      const first = sides[0]!;
      assert(first.kind === "line", "side");
      const middle: [number, number] = [(first.start[0] + first.end[0]) / 2, (first.start[1] + first.end[1]) / 2];
      near(middle[0], 13, 1e-9, "circumscribed: the clicked point is the middle of a side (x)");
      near(middle[1], 4, 1e-9, "circumscribed: the clicked point is the middle of a side (y)");

      const edge = buildEdgePolygon([0, 0], [12, 0], 6, shapeIds());
      assert(edge.ok, "edge polygon builds");
      equal(edge.value.sizeDimension.dimension, "length", "edge: sized by the side length");
      near(edge.value.sizeDimension.valueMm, 12, 1e-9, "edge: the side is the clicked edge");
      const edgeFirst = edge.value.entities[0]!;
      assert(edgeFirst.kind === "line", "side");
      near(edgeFirst.start[0], 0, 1e-12, "edge: starts at the first click");
      near(edgeFirst.end[0], 12, 1e-12, "edge: ends at the second click");
      const edgeGuide = edge.value.entities.find((entity) => entity.kind === "circle");
      assert(edgeGuide?.kind === "circle" && edgeGuide.center[1] > 0, "edge: the polygon grows on the left of the way the edge points");
    }
  },
  {
    name: "Curve tools T03/N3: 15 alternating side edits of a hexagon (14 / 10 mm) leave it regular with the centre where it was",
    run: () => {
      const shape = build(6);
      let project = projectWith(shape);
      const side = shape.entities[0]!.id;
      for (let index = 0; index < 15; index += 1) {
        const value = index % 2 === 0 ? 14 : 10;
        const result = dimension(project, { entityId: side, dimension: "length", valueMm: value });
        assert(result.ok, `edit ${index + 1} is accepted: ${result.ok ? "" : result.message}`);
        project = result.project;
        equal(shapeProblem(project.sketch, "polygon"), undefined, `after edit ${index + 1}`);
        for (const line of project.sketch.entities.filter((entity) => entity.kind === "line")) {
          assert(line.kind === "line", "line");
          near(Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]), value, 1e-5, `every side is ${value} mm after edit ${index + 1}`);
          near(Math.hypot(line.start[0], line.start[1]), value, 1e-5, `every corner is ${value} mm from the centre after edit ${index + 1} (a hexagon's side equals its circumradius)`);
        }
      }
    }
  },
  {
    name: "Curve tools T03/N3: dimensioning a side resizes the whole polygon about its centre, whichever side and whichever n",
    run: () => {
      for (const sides of [3, 4, 5, 7, 8]) {
        const shape = build(sides, "inscribed", [20, -5], [30, -5]);
        const lines = shape.entities.filter((entity) => entity.kind === "line");
        const project = projectWith(shape);
        for (const target of [lines[0]!, lines[sides - 1]!]) {
          const result = dimension(project, { entityId: target.id, dimension: "length", valueMm: 12 });
          assert(result.ok, `n=${sides}: ${result.ok ? "" : result.message}`);
          equal(shapeProblem(result.project.sketch, "polygon"), undefined, `n=${sides}: still regular`);
          const guide = result.project.sketch.entities.find((entity) => entity.kind === "circle");
          assert(guide?.kind === "circle", "the guide circle remains");
          near(guide.center[0], 20, 1e-6, `n=${sides}: the centre stays (x)`);
          near(guide.center[1], -5, 1e-6, `n=${sides}: the centre stays (y)`);
          near(guide.radiusMm, 12 / (2 * Math.sin(Math.PI / sides)), 1e-5, `n=${sides}: the guide circle follows the new size`);
        }
      }
    }
  },
  {
    name: "Curve tools T03/T01: a vertex drag of a hexagon keeps it regular and the dragged corner follows the pointer",
    run: () => {
      const shape = build(6);
      const project = projectWith(shape);
      const second = shape.entities[1]!;
      assert(second.kind === "line", "side");
      const dragged = dragAndCommit(project, second.id, { kind: "point", ref: "start" }, second.start, [second.start[0] + 3, second.start[1] + 4]);
      assert(dragged.ok, `the vertex drag is accepted: ${dragged.ok ? "" : dragged.message}`);
      equal(shapeProblem(dragged.project.sketch, "polygon"), undefined, "still regular after a vertex drag");
      const moved = dragged.project.sketch.entities.find((entity) => entity.id === second.id);
      assert(moved?.kind === "line", "the side is still there");
      assert(Math.hypot(moved.start[0] - second.start[0], moved.start[1] - second.start[1]) > 0.5, "the corner moved");
    }
  },
  {
    name: "Curve tools T03/T11: a polygon whose centre is snapped to the origin is located there, and keeps 2 degrees of freedom (size and turn)",
    run: () => {
      const shape = build(6, "inscribed", [0, 0], [10, 0]);
      const base = projectWith({ entities: [], constraints: [] });
      const snapped = inferSketchPoint([0.2, 0.1], base.sketch, { toleranceMm: 1 });
      equal(snapped.primary?.kind, "origin", "the centre click snaps to the origin");
      const relations = polygonCentreRelations(shape, "inscribed", [{ point: snapped.point, ...(snapped.primary === undefined ? {} : { primary: snapped.primary }), guides: snapped.guides }], base.sketch, (() => { let n = 0; return () => `constraint:centre-${(n += 1)}`; })());
      equal(relations.map((relation) => `${relation.kind}:${relation.entityIds[0]}:${relation.points?.join("/")}`).join(","), `coincident:sketch:origin:self/center`, "the guide circle's centre is on the origin");
      const added = applyWorkbenchOperation(base, { kind: "apply-sketch-edit", operationId: "operation:poly-centre", expectedRevision: base.revision, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: [...shape.constraints, ...relations], label: "Polygon" });
      assert(added.ok, `the polygon and its centre relation apply: ${added.ok ? "" : added.diagnostics[0]?.message}`);
      equal(analyzeWorkbenchSketch(added.value.project.sketch).degreesOfFreedom, 2, "size and turn are left");
      equal(polygonCentreRelations(shape, "edge", [{ point: [0, 0], primary: { kind: "origin", point: [0, 0], distanceMm: 0 } }], base.sketch, () => "constraint:x").length, 0, "edge mode has no centre click");
    }
  },
  {
    name: "Curve tools T03: polygon limits, mode parsing and the palette builder",
    run: () => {
      assert(!buildPolygon([0, 0], [10, 0], 2, shapeIds()).ok, "two sides is refused");
      assert(!buildPolygon([0, 0], [10, 0], 65, shapeIds()).ok, "65 sides is refused");
      assert(!buildPolygon([0, 0], [0.05, 0], 6, shapeIds(), "circumscribed").ok, "a tiny apothem is refused");
      assert(!buildEdgePolygon([0, 0], [0.001, 0], 6, shapeIds()).ok, "a tiny edge is refused");
      equal(parsePolygonMode("circumscribed"), "circumscribed", "known mode");
      equal(parsePolygonMode("nonsense"), "inscribed", "unknown mode falls back to inscribed");
      const viaPalette = buildPolygonByMode([0, 0], [12, 0], 5, "edge", shapeIds());
      assert(viaPalette.ok && viaPalette.value.entities.length === 6, "the palette builder reaches the edge polygon");
      // A polygon at 90 degrees keeps clean coordinates (no 6e-16 dust).
      const clean = build(4, "inscribed", [0, 0], [0, 10]);
      for (const entity of clean.entities) if (entity.kind === "line") for (const value of [...entity.start, ...entity.end]) assert(value === 0 || Math.abs(value) > 1e-6, `no trigonometric dust in ${value}`);
    }
  }
];
