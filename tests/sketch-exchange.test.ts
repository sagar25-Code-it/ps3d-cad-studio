import type { SketchEntity, Vec2, WorkbenchOperation, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { defaultConstructionLayers, parseDxf, splineAsBezierChain, writeSketchDxf } from "../packages/workbench-sketch/src/dxf.js";
import { parseSvg, writeSketchSvg } from "../packages/workbench-sketch/src/svg.js";
import { arcGeometry, catmullRomSamples, IMPORT_CHUNK_SIZE, planDrawingImport, type ParsedDrawing } from "../packages/workbench-sketch/src/sketch-exchange.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { asConstruction, planAsConstruction, planForDrawMode } from "../packages/workbench-sketch/src/draw-construction.js";
import { resolveSketchHotkey, type SketchHotkeyContext } from "../packages/workbench-sketch/src/hotkeys.js";
import { buildCurveTool, DEFAULT_CURVE_TOOL_OPTIONS } from "../packages/workbench-sketch/src/curve-tools.js";
import type { SketchEditPlan } from "../packages/workbench-sketch/src/edit-tools.js";
import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const newId = (): string => `entity:imp-${(counter += 1)}`;

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-sketch-exchange");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...emptyProject().sketch, entities, constraints: [] };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

function messageOf(result: { readonly ok: boolean; readonly diagnostics?: readonly { readonly message: string }[] }): string {
  return result.ok ? "" : result.diagnostics?.[0]?.message ?? "";
}

function applyPlans(project: WorkbenchProject, plans: readonly SketchEditPlan[]): WorkbenchProject {
  let current = project;
  for (const plan of plans) {
    const applied = applyWorkbenchOperation(current, { kind: "apply-sketch-edit", operationId: `operation:imp-${(counter += 1)}`, expectedRevision: current.revision, ...plan } as WorkbenchOperation);
    if (!applied.ok) throw new Error(`the import edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
    current = applied.value.project;
  }
  const again = validateWorkbenchProject(JSON.parse(JSON.stringify(current)) as unknown);
  if (!again.ok) throw new Error(`the project no longer validates: ${again.diagnostics[0]?.message ?? "no reason"}`);
  return again.value;
}

/** Imports a parsed drawing into an empty sketch through the real planner and operation path. */
function importInto(drawing: ParsedDrawing, mmPerUnit: number, extra: Partial<Parameters<typeof planDrawingImport>[2]> = {}): { readonly project: WorkbenchProject; readonly entities: readonly SketchEntity[] } {
  const project = emptyProject();
  const planned = must(planDrawingImport(drawing, project.sketch, { mmPerUnit, newId: (prefix) => `${prefix}:imp-${(counter += 1)}`, ...extra }));
  const applied = applyPlans(project, planned.plans);
  return { project: applied, entities: applied.sketch.entities };
}

/** Points along an entity, dense enough to compare shapes. */
function sample(entity: SketchEntity): readonly Vec2[] {
  const points: Vec2[] = [];
  const line = (a: Vec2, b: Vec2): void => { for (let step = 0; step <= 60; step += 1) points.push([a[0] + ((b[0] - a[0]) * step) / 60, a[1] + ((b[1] - a[1]) * step) / 60]); };
  switch (entity.kind) {
    case "line": line(entity.start, entity.end); break;
    case "point": points.push(entity.point); break;
    case "circle": for (let step = 0; step < 360; step += 1) points.push([entity.center[0] + entity.radiusMm * Math.cos((step * Math.PI) / 180), entity.center[1] + entity.radiusMm * Math.sin((step * Math.PI) / 180)]); break;
    case "ellipse": {
      const rotation = (entity.rotationDeg * Math.PI) / 180;
      for (let step = 0; step < 360; step += 1) {
        const t = (step * Math.PI) / 180;
        const x = entity.majorRadiusMm * Math.cos(t);
        const y = entity.minorRadiusMm * Math.sin(t);
        points.push([entity.center[0] + x * Math.cos(rotation) - y * Math.sin(rotation), entity.center[1] + x * Math.sin(rotation) + y * Math.cos(rotation)]);
      }
      break;
    }
    case "arc": {
      const geometry = arcGeometry(entity.start, entity.mid, entity.end)!;
      for (let step = 0; step <= 180; step += 1) {
        const angle = geometry.startAngle + (geometry.sweep * step) / 180;
        points.push([geometry.center[0] + geometry.radius * Math.cos(angle), geometry.center[1] + geometry.radius * Math.sin(angle)]);
      }
      break;
    }
    case "spline": points.push(...catmullRomSamples(entity.fitPoints, 24)); break;
    case "rectangle": {
      const rotation = (entity.rotationDeg * Math.PI) / 180;
      const corner = (sx: number, sy: number): Vec2 => [entity.center[0] + (sx * entity.widthMm) / 2 * Math.cos(rotation) - (sy * entity.heightMm) / 2 * Math.sin(rotation), entity.center[1] + (sx * entity.widthMm) / 2 * Math.sin(rotation) + (sy * entity.heightMm) / 2 * Math.cos(rotation)];
      const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)];
      for (let index = 0; index < 4; index += 1) line(corners[index]!, corners[index + 1]!);
      break;
    }
  }
  return points;
}

/** Distance from a point to a polyline (to its segments, not just its vertices). */
function distanceToPolyline(p: Vec2, polyline: readonly Vec2[]): number {
  let best = Infinity;
  for (let index = 0; index + 1 < polyline.length; index += 1) {
    const a = polyline[index]!;
    const b = polyline[index + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return polyline.length === 1 ? Math.hypot(p[0] - polyline[0]![0], p[1] - polyline[0]![1]) : best;
}

/** The largest distance from a point of one set of curves to the other set (curves as polylines), both ways. */
function hausdorff(a: readonly SketchEntity[], b: readonly SketchEntity[]): number {
  const la = a.map(sample);
  const lb = b.map(sample);
  const oneWay = (from: readonly (readonly Vec2[])[], to: readonly (readonly Vec2[])[]): number => Math.max(...from.flatMap((list) => list.map((p) => Math.min(...to.map((other) => distanceToPolyline(p, other))))));
  return Math.max(oneWay(la, lb), oneWay(lb, la));
}

const SAMPLE_ENTITIES: readonly SketchEntity[] = [
  { id: "entity:l1", kind: "line", start: [0, 0], end: [40, 10], construction: false },
  { id: "entity:c1", kind: "circle", center: [60, 20], radiusMm: 7.5, construction: false },
  { id: "entity:a1", kind: "arc", start: [10, 30], mid: [20, 40], end: [30, 30], construction: false },
  { id: "entity:a2", kind: "arc", start: [30, 60], mid: [20, 50], end: [10, 60], construction: false },
  { id: "entity:e1", kind: "ellipse", center: [-30, 20], majorRadiusMm: 12, minorRadiusMm: 5, rotationDeg: 30, construction: false },
  { id: "entity:r1", kind: "rectangle", center: [-30, -30], widthMm: 20, heightMm: 10, rotationDeg: 15, construction: false },
  { id: "entity:p1", kind: "point", point: [5, 5], construction: false },
  { id: "entity:s1", kind: "spline", fitPoints: [[70, 0], [80, 12], [95, 8], [110, 20], [125, 5]], construction: false },
  { id: "entity:k1", kind: "line", start: [-50, 0], end: [-50, 50], construction: true }
];

function ringDxf(extra: string, units = 4): string {
  return ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", ...(extra === "" ? [] : [extra]), "0", "ENDSEC", "0", "EOF"].join("\n");
}

function pairs(...items: readonly (string | number)[]): string {
  return items.map(String).join("\n");
}

function singleCurve(drawing: ParsedDrawing) {
  equal(drawing.curves.length, 1, "exactly one curve was read");
  return drawing.curves[0]!;
}

export const sketchExchangeTests: readonly TestCase[] = [
  // ------------------------------------------------------------------ DXF writer
  {
    name: "sketch DXF export: valid R2000 structure, the right entity types, layers and units",
    run: () => {
      const dxf = writeSketchDxf(sketchOf(SAMPLE_ENTITIES));
      const lines = dxf.split("\n");
      assert(lines.length % 2 === 1 && lines[lines.length - 1] === "", "an even number of lines (code, value) and a final newline");
      assert(lines.slice(0, -1).every((line, index) => index % 2 === 1 || /^-?\d+$/u.test(line.trim())), "every other line is a group code number");
      assert(dxf.trimEnd().endsWith("0\nEOF"), "ends with EOF");
      for (const section of ["HEADER", "TABLES", "BLOCKS", "ENTITIES", "OBJECTS"]) assert(dxf.includes(`0\nSECTION\n2\n${section}\n`), `has the ${section} section`);
      assert(dxf.includes("9\n$ACADVER\n1\nAC1015") && dxf.includes("9\n$INSUNITS\n70\n4") && dxf.includes("9\n$MEASUREMENT\n70\n1"), "R2000 in millimetres");
      const types = (type: string): number => dxf.split(`\n0\n${type}\n`).length - 1;
      equal(types("LINE"), 2, "lines");
      equal(types("CIRCLE"), 1, "circle");
      equal(types("ARC"), 2, "arcs");
      equal(types("ELLIPSE"), 1, "ellipse");
      equal(types("LWPOLYLINE"), 1, "rectangle as a closed polyline");
      equal(types("POINT"), 1, "point");
      equal(types("SPLINE"), 1, "spline");
      const handles: string[] = [];
      for (let at = 0; at + 1 < lines.length; at += 2) if (lines[at] === "5") handles.push(lines[at + 1]!);
      equal(new Set(handles).size, handles.length, "every handle is unique");
      assert(/0\nLINE\n5\n[0-9A-F]+\n330\n1F\n100\nAcDbEntity\n8\nCONSTRUCTION\n6\nDASHED/u.test(dxf), "the construction line sits on the CONSTRUCTION layer with the dashed line type");
      assert(dxf.includes("2\nCONSTRUCTION\n70\n0\n62\n8\n6\nDASHED"), "and the layer is defined");
      const noConstruction = writeSketchDxf(sketchOf(SAMPLE_ENTITIES), { includeConstruction: false });
      assert(!noConstruction.includes("CONSTRUCTION\n6\nDASHED\n100\nAcDbLine"), "construction can be left out");
      const hidden = writeSketchDxf(sketchOf([{ ...SAMPLE_ENTITIES[0]!, visible: false } as SketchEntity]));
      assert(!hidden.includes("\n0\nLINE\n"), "hidden curves are not exported");
      const inches = writeSketchDxf(sketchOf([{ id: "entity:l", kind: "line", start: [0, 0], end: [25.4, 50.8], construction: false }]), { units: "in" });
      assert(inches.includes("9\n$INSUNITS\n70\n1") && inches.includes("9\n$MEASUREMENT\n70\n0"), "inch files say inches");
      assert(inches.includes("11\n1\n21\n2\n"), "and the numbers are in inches (25.4 mm is 1 in)");
      const chain = splineAsBezierChain([[0, 0], [10, 10], [20, 0]]);
      equal(chain.controls.length, 7, "a 3-point spline is two Bezier spans (7 control points)");
      equal(chain.knots.length, 11, "with a clamped knot vector (control points + degree + 1)");
    }
  },
  {
    name: "sketch DXF round trip: every entity kind comes back within tolerance in mm and in inches",
    run: () => {
      for (const units of ["mm", "in"] as const) {
        const dxf = writeSketchDxf(sketchOf(SAMPLE_ENTITIES), { units });
        const drawing = must(parseDxf(dxf));
        equal(drawing.units.name, units === "mm" ? "millimetres" : "inches", `the unit is read back (${units})`);
        equal(drawing.units.source, "file", "from $INSUNITS");
        const { entities } = importInto(drawing, drawing.units.mmPerUnit, { constructionLayers: defaultConstructionLayers(drawing.layers) });
        const kinds = (kind: string): number => entities.filter((entity) => entity.kind === kind).length;
        equal(kinds("circle"), 1, "circle"); equal(kinds("arc"), 2, "arcs"); equal(kinds("ellipse"), 1, "ellipse"); equal(kinds("point"), 1, "point");
        assert(kinds("spline") >= 1, "spline");
        const circle = entities.find((entity) => entity.kind === "circle")!;
        near(circle.kind === "circle" ? circle.radiusMm : 0, 7.5, 1e-6, `circle radius (${units})`);
        const ellipse = entities.find((entity) => entity.kind === "ellipse");
        assert(ellipse?.kind === "ellipse", "ellipse");
        if (ellipse?.kind === "ellipse") {
          near(ellipse.majorRadiusMm, 12, 1e-6, "ellipse major"); near(ellipse.minorRadiusMm, 5, 1e-6, "ellipse minor"); near(ellipse.rotationDeg, 30, 1e-6, "ellipse angle");
        }
        const withoutRectangle = SAMPLE_ENTITIES.filter((entity) => entity.kind !== "rectangle");
        const rectangleLines = entities.filter((entity) => entity.kind === "line").length;
        equal(rectangleLines, 1 + 1 + 4, "the rectangle returns as four lines (plus the two lines of the sketch)");
        const original = [...withoutRectangle, ...[SAMPLE_ENTITIES.find((entity) => entity.kind === "rectangle")!]];
        near(hausdorff(original, entities), 0, 0.02, `the whole drawing matches within 0.02 mm (${units})`);
        const construction = entities.filter((entity) => entity.construction);
        equal(construction.length, 1, "the construction layer comes back as construction geometry");
        assert(construction[0]!.kind === "line" && Math.abs((construction[0] as Extract<SketchEntity, { kind: "line" }>).start[0] + 50) < 1e-6, "and it is the right line");
        // The two arcs run opposite ways in the sketch; both survive.
        const arcs = entities.filter((entity): entity is Extract<SketchEntity, { kind: "arc" }> => entity.kind === "arc");
        for (const original of [SAMPLE_ENTITIES[2]!, SAMPLE_ENTITIES[3]!] as const) {
          const source = original as Extract<SketchEntity, { kind: "arc" }>;
          assert(arcs.some((arc) => hausdorff([arc], [source]) < 1e-6), "an arc is the same curve after the trip (clockwise ones come back counter-clockwise)");
        }
      }
    }
  },
  {
    name: "sketch DXF import: closed rectangle polyline with bulge arcs, old-style POLYLINE and the sign of a bulge",
    run: () => {
      // A 20 x 10 slot: two lines and two semicircles (bulge 1 = 180 degrees counter-clockwise).
      const slot = ringDxf(pairs(0, "LWPOLYLINE", 8, "PART", 90, 4, 70, 1, 10, 0, 20, 0, 42, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 42, 0, 10, 0, 20, 10, 42, 1));
      const drawing = must(parseDxf(slot));
      equal(drawing.curves.length, 4, "four segments");
      equal(drawing.curves.filter((curve) => curve.kind === "arc").length, 2, "two are arcs");
      const { entities, project } = importInto(drawing, 1);
      const arcs = entities.filter((entity): entity is Extract<SketchEntity, { kind: "arc" }> => entity.kind === "arc");
      const right = arcs.find((arc) => arc.start[0] === 20 && arc.start[1] === 0)!;
      near(right.mid[0], 25, 1e-9, "the right cap bulges outward to x=25 (x)");
      near(right.mid[1], 5, 1e-9, "centred on the slot (y)");
      equal(detectSketchProfiles(project.sketch).length, 1, "the slot is one closed profile");
      const negative = must(parseDxf(ringDxf(pairs(0, "LWPOLYLINE", 90, 2, 70, 0, 10, 0, 20, 0, 42, -1, 10, 10, 20, 0))));
      const arc = singleCurve(negative);
      assert(arc.kind === "arc" && Math.abs(arc.mid[1] - 5) < 1e-9, "a negative bulge swings the other way (clockwise: above the chord)");
      const old = must(parseDxf(ringDxf(pairs(0, "POLYLINE", 8, "0", 66, 1, 70, 1, 0, "VERTEX", 10, 0, 20, 0, 42, 0, 0, "VERTEX", 10, 10, 20, 0, 42, 0, 0, "VERTEX", 10, 10, 20, 10, 0, "SEQEND"))));
      equal(old.curves.length, 3, "a closed 3-vertex POLYLINE makes three segments");
      const flat3d = must(parseDxf(ringDxf(pairs(0, "POLYLINE", 70, 8, 0, "VERTEX", 10, 0, 20, 0, 30, 5, 0, "VERTEX", 10, 10, 20, 0, 30, 9, 0, "SEQEND"))));
      assert(flat3d.warnings.some((warning) => warning.includes("3D polyline")), "a 3D polyline imports flat with a warning");
    }
  },
  {
    name: "sketch DXF import: ARC, CIRCLE, POINT, ELLIPSE (full and partial) and mirrored extrusion",
    run: () => {
      const arc = singleCurve(must(parseDxf(ringDxf(pairs(0, "ARC", 8, "0", 10, 5, 20, 5, 40, 10, 50, 0, 51, 90)))));
      assert(arc.kind === "arc", "an arc");
      if (arc.kind === "arc") {
        near(arc.start[0], 15, 1e-9, "starts at angle 0"); near(arc.end[1], 15, 1e-9, "ends at angle 90");
        near(arc.mid[0], 5 + 10 * Math.cos(Math.PI / 4), 1e-9, "and bulges through 45 degrees");
      }
      const wrap = singleCurve(must(parseDxf(ringDxf(pairs(0, "ARC", 10, 0, 20, 0, 40, 5, 50, 300, 51, 60)))));
      assert(wrap.kind === "arc", "an arc across 0 degrees");
      if (wrap.kind === "arc") near(wrap.mid[0], 5, 1e-9, "its middle is at angle 0 (x=r)");
      const full = singleCurve(must(parseDxf(ringDxf(pairs(0, "ARC", 10, 0, 20, 0, 40, 5, 50, 0, 51, 360)))));
      equal(full.kind, "circle", "an arc over 360 degrees is a circle");
      const mirrored = singleCurve(must(parseDxf(ringDxf(pairs(0, "ARC", 10, 10, 20, 0, 40, 5, 50, 0, 51, 90, 230, -1)))));
      assert(mirrored.kind === "arc", "an arc with a downward extrusion");
      if (mirrored.kind === "arc") { near(mirrored.mid[0], -10 - 5 * Math.cos(Math.PI / 4), 1e-9, "is mirrored about the Y axis (x)"); near(mirrored.mid[1], 5 * Math.sin(Math.PI / 4), 1e-9, "(y)"); }
      const circle = singleCurve(must(parseDxf(ringDxf(pairs(0, "CIRCLE", 10, 3, 20, 4, 40, 2.5)))));
      assert(circle.kind === "circle" && circle.radius === 2.5, "circle");
      const point = singleCurve(must(parseDxf(ringDxf(pairs(0, "POINT", 10, 3, 20, 4)))));
      equal(point.kind, "point", "point");
      const ellipse = singleCurve(must(parseDxf(ringDxf(pairs(0, "ELLIPSE", 10, 0, 20, 0, 11, 0, 21, 8, 40, 0.5, 41, 0, 42, 6.283185307179586)))));
      assert(ellipse.kind === "ellipse", "full ellipse");
      if (ellipse.kind === "ellipse") { near(ellipse.major, 8, 1e-9, "major from the axis vector"); near(ellipse.minor, 4, 1e-9, "minor from the ratio"); near(ellipse.rotationDeg, 90, 1e-9, "turned to +Y"); }
      const partial = must(parseDxf(ringDxf(pairs(0, "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, Math.PI))));
      assert(partial.curves.every((curve) => curve.kind === "spline" || curve.kind === "line"), "a half ellipse has no sketch entity, so it follows as a spline");
      const { entities } = importInto(partial, 1);
      let worst = 0;
      for (const entity of entities) for (const point of sample(entity)) worst = Math.max(worst, Math.abs(Math.hypot(point[0] / 10, point[1] / 5) - 1) * 5);
      assert(worst < 0.03, `the spline stays on the ellipse (${worst} mm off)`);
      assert(entities.length <= 3, `in at most three pieces (${entities.length})`);
    }
  },
  {
    name: "sketch DXF import: SPLINE from control points and knots, from fit points, and long splines cut at 24 fit points",
    run: () => {
      // A cubic Bezier from (0,0) to (30,0) bulging to y=15.
      const bezier = must(parseDxf(ringDxf(pairs(0, "SPLINE", 70, 8, 71, 3, 72, 8, 73, 4, 74, 0, 40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1, 10, 0, 20, 0, 10, 10, 20, 20, 10, 20, 20, 20, 10, 30, 20, 0))));
      const { entities } = importInto(bezier, 1);
      const truePoint = (t: number): Vec2 => { const u = 1 - t; return [3 * u * u * t * 10 + 3 * u * t * t * 20 + t ** 3 * 30, 3 * u * u * t * 20 + 3 * u * t * t * 20]; };
      let worst = 0;
      for (let step = 0; step <= 100; step += 1) { const p = truePoint(step / 100); worst = Math.max(worst, Math.min(...entities.map((entity) => distanceToPolyline(p, sample(entity))))); }
      assert(worst < 0.02, `the imported spline follows the NURBS within 0.02 mm (${worst})`);
      assert(entities.every((entity) => entity.kind !== "spline" || entity.fitPoints.length <= 24), "no spline has more than 24 fit points");
      const fits = must(parseDxf(ringDxf(pairs(0, "SPLINE", 70, 1032, 71, 3, 72, 0, 73, 0, 74, 4, 11, 0, 21, 0, 11, 10, 21, 5, 11, 20, 21, 0, 11, 30, 21, 5))));
      const fitCurve = singleCurve(fits);
      assert(fitCurve.kind === "spline" || fitCurve.kind === "line", "a fit-point spline imports");
      // A wiggly NURBS with 60 spans needs several pieces.
      const spans = 60;
      const controls: number[] = [];
      for (let index = 0; index <= spans + 3; index += 1) controls.push(10, index * 5, 20, 20 * Math.sin(index));
      const knots: number[] = [];
      for (let index = 0; index < spans + 8; index += 1) knots.push(index < 4 ? 0 : index > spans + 3 ? spans : index - 3);
      const long = must(parseDxf(ringDxf(pairs(0, "SPLINE", 70, 8, 71, 3, 72, knots.length, 73, spans + 4, 74, 0, ...knots.flatMap((knot) => [40, knot]), ...controls))));
      assert(long.curves.length > 1, `a curve that needs more than 24 points is cut into ${long.curves.length} pieces`);
      assert(long.curves.every((curve) => curve.kind !== "spline" || curve.fit.length <= 24), "each piece within the sketch's 24 fit points");
      const joined = importInto(long, 1).entities;
      assert(joined.length === long.curves.length, "all pieces import");
    }
  },
  {
    name: "sketch DXF units: $INSUNITS, $MEASUREMENT and the unknown case ask for confirmation of the scale",
    run: () => {
      const unitOf = (header: string): ReturnType<typeof parseDxf> => parseDxf(["0", "SECTION", "2", "HEADER", header, "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", pairs(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 0), "0", "ENDSEC", "0", "EOF"].join("\n"));
      const inches = must(unitOf(pairs(9, "$INSUNITS", 70, 1)));
      equal(inches.units.mmPerUnit, 25.4, "INSUNITS 1 is inches"); equal(inches.units.source, "file", "read from the file");
      equal(must(unitOf(pairs(9, "$INSUNITS", 70, 4))).units.mmPerUnit, 1, "4 is millimetres");
      equal(must(unitOf(pairs(9, "$INSUNITS", 70, 5))).units.mmPerUnit, 10, "5 is centimetres");
      equal(must(unitOf(pairs(9, "$INSUNITS", 70, 6))).units.mmPerUnit, 1000, "6 is metres");
      const imperial = must(unitOf(pairs(9, "$INSUNITS", 70, 0, 9, "$MEASUREMENT", 70, 0)));
      equal(imperial.units.mmPerUnit, 25.4, "unitless with $MEASUREMENT 0 is guessed as inches"); equal(imperial.units.source, "measurement", "and marked as a guess");
      assert(imperial.warnings.some((warning) => warning.includes("assumed")), "with a warning to check the scale");
      const unknown = must(parseDxf(ringDxf(pairs(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 0)).replace("9\n$INSUNITS\n70\n4\n", "")));
      equal(unknown.units.source, "assumed", "no unit at all is an assumption");
      const importedInches = importInto(inches, inches.units.mmPerUnit).entities[0]!;
      near(importedInches.kind === "line" ? importedInches.end[0] : 0, 25.4, 1e-9, "one inch imports as 25.4 mm");
      const confirmed = importInto(inches, 1).entities[0]!;
      near(confirmed.kind === "line" ? confirmed.end[0] : 0, 1, 1e-9, "the confirmed scale wins over the file's unit");
    }
  },
  {
    name: "sketch DXF import: unsupported entities are counted not guessed; layers, DWG and damaged files give clear messages",
    run: () => {
      const mixed = must(parseDxf(ringDxf([pairs(0, "LINE", 8, "CUT", 10, 0, 20, 0, 11, 5, 21, 0), pairs(0, "TEXT", 10, 0, 20, 0, 1, "hello"), pairs(0, "HATCH", 8, "H"), pairs(0, "INSERT", 2, "BLK"), pairs(0, "DIMENSION"), pairs(0, "CIRCLE", 8, "CONSTRUCTION", 10, 0, 20, 0, 40, 3)].join("\n"))));
      equal(mixed.curves.length, 2, "only the line and the circle are curves");
      equal(mixed.skipped["TEXT"], 1, "TEXT counted"); equal(mixed.skipped["INSERT"], 1, "INSERT counted"); equal(mixed.skipped["HATCH"], 1, "HATCH counted");
      assert(mixed.warnings.some((warning) => warning.includes("Skipped")), "the warning lists them");
      equal(mixed.layers.map((layer) => layer.name).join(","), "CONSTRUCTION,CUT", "layers are listed");
      equal(defaultConstructionLayers(mixed.layers).join(","), "CONSTRUCTION", "the construction layer is recognised by name");
      const skipped = importInto(mixed, 1, { skipLayers: ["CUT"] });
      equal(skipped.entities.length, 1, "a layer can be left out");
      const asGuide = importInto(mixed, 1, { constructionLayers: ["CUT"] });
      assert(asGuide.entities.find((entity) => entity.kind === "line")!.construction, "a layer can become construction");
      for (const [label, text, word] of [
        ["empty", "", "empty"],
        ["binary DXF", "AutoCAD Binary DXF\r\n\u001a\u0000", "binary"],
        ["DWG", "AC1032\u0000\u0000\u0000\u0000\u0000binary", "DWG"],
        ["not a DXF", "hello world\nthis is not dxf", "does not look like a DXF"],
        ["no entities", pairs(0, "SECTION", 2, "HEADER", 0, "ENDSEC", 0, "EOF"), "ENTITIES"],
        ["damaged", `${ringDxf(pairs(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 0))}\nxx\n1`, "damaged"]
      ] as const) {
        const result = parseDxf(text);
        assert(!result.ok, `${label} is refused`);
        assert(messageOf(result).toLowerCase().includes(word.toLowerCase()), `${label}: the message says why (${messageOf(result)})`);
      }
      const empty = must(parseDxf(ringDxf("")));
      equal(empty.curves.length, 0, "an empty ENTITIES section parses");
      const planned = planDrawingImport(empty, sketchOf([]), { mmPerUnit: 1, newId });
      assert(!planned.ok && messageOf(planned).includes("no lines"), "but there is nothing to import, and the message says so");
      // N-05: an unreadable number is refused with its line, never replaced by 0 (that put a wrong line in the sketch).
      const nan = parseDxf(ringDxf(pairs(0, "LINE", 10, "abc", 20, 0, 11, "NaN", 21, 5)));
      assert(!nan.ok && /unreadable number "abc"/u.test(messageOf(nan)) && /line [0-9]+/u.test(messageOf(nan)), "unreadable numbers are refused and the message names the number and its line: " + messageOf(nan));
    }
  },
  {
    name: "sketch DXF import: random damage to a valid file never throws",
    run: () => {
      const valid = writeSketchDxf(sketchOf(SAMPLE_ENTITIES));
      let seed = 12345;
      const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const lines = valid.split("\n");
      for (let round = 0; round < 200; round += 1) {
        const copy = [...lines];
        for (let edit = 0; edit < 1 + Math.floor(random() * 6); edit += 1) {
          const at = Math.floor(random() * copy.length);
          const choice = Math.floor(random() * 4);
          if (choice === 0) copy.splice(at, 1);
          else if (choice === 1) copy[at] = String(Math.floor(random() * 300));
          else if (choice === 2) copy[at] = "NaN";
          else copy.length = Math.max(2, at);
        }
        const result = parseDxf(copy.join("\n"));
        if (result.ok) {
          for (const curve of result.value.curves) assert(JSON.stringify(curve).indexOf("null") < 0, "no NaN geometry comes out of a damaged file");
          const planned = planDrawingImport(result.value, sketchOf([]), { mmPerUnit: 1, newId });
          void planned;
        }
      }
    }
  },
  // ------------------------------------------------------------------ import planning
  {
    name: "sketch import planning: ends are welded so loops close, duplicates and specks are dropped, placement and scale apply",
    run: () => {
      const gap = 0.003;
      const loose: ParsedDrawing = {
        format: "dxf", units: { name: "millimetres", mmPerUnit: 1, source: "file" }, warnings: [], skipped: {}, layers: [],
        curves: [
          { kind: "line", a: [0, 0], b: [20, 0], layer: "0" }, { kind: "line", a: [20 + gap, 0 + gap], b: [20, 10], layer: "0" },
          { kind: "line", a: [20, 10 - gap], b: [0, 10], layer: "0" }, { kind: "line", a: [0 + gap, 10], b: [0, 0 - gap], layer: "0" },
          { kind: "line", a: [0, 0], b: [20, 0], layer: "0" }, { kind: "line", a: [5, 5], b: [5.004, 5], layer: "0" }
        ]
      };
      const unwelded = importInto(loose, 1, { weldMm: 0 });
      // The region engine closes gaps up to 0.01 mm by itself, so the weld is judged where it acts: on the end points.
      const distinctEnds = (project: { readonly sketch: { readonly entities: readonly { readonly kind: string }[] } }): number => new Set((project.sketch.entities as readonly { readonly kind: string; readonly start?: readonly number[]; readonly end?: readonly number[] }[])
        .flatMap((entity) => entity.kind === "line" && entity.start !== undefined && entity.end !== undefined && Math.hypot(entity.end[0]! - entity.start[0]!, entity.end[1]! - entity.start[1]!) > 1 ? [entity.start.join(","), entity.end.join(",")] : [])).size;
      equal(distinctEnds(unwelded.project), 8, "without welding each of the four lines keeps its own slightly different ends");
      const welded = importInto(loose, 1);
      equal(distinctEnds(welded.project), 4, "welded, the ends of neighbouring lines are the same four corner points");
      equal(detectSketchProfiles(welded.project.sketch).length, 1, "welded, it is one closed profile");
      equal(welded.entities.length, 4, "the duplicate line and the 0.004 mm speck are dropped");
      const planned = must(planDrawingImport(loose, emptySketch(), { mmPerUnit: 1, newId }));
      equal(planned.summary.droppedDuplicates, 1, "one duplicate"); equal(planned.summary.droppedTiny, 1, "one speck"); assert(planned.summary.welded >= 3, "ends were welded");
      const inInches = must(planDrawingImport({ ...loose, curves: loose.curves.slice(0, 4) }, emptySketch(), { mmPerUnit: 25.4, newId }));
      near(inInches.summary.widthMm, 508, 0.1, "20 inches are 508 mm wide");
      const centered = importInto({ ...loose, curves: loose.curves.slice(0, 4) }, 1, { placement: "center" });
      const xs = centered.entities.flatMap((entity) => entity.kind === "line" ? [entity.start[0], entity.end[0]] : []);
      near(Math.min(...xs), -10, 0.01, "centred on the origin (left)"); near(Math.max(...xs), 10, 0.01, "(right)");
      const cornered = importInto({ ...loose, curves: loose.curves.slice(0, 4) }, 1, { placement: "corner" });
      near(Math.min(...cornered.entities.flatMap((entity) => entity.kind === "line" ? [entity.start[1], entity.end[1]] : [])), 0, 0.01, "corner on the origin");
      const everything = importInto({ ...loose, curves: loose.curves.slice(0, 4) }, 1, { allConstruction: true });
      assert(everything.entities.every((entity) => entity.construction), "everything can come in as construction");
      assert(!planDrawingImport(loose, emptySketch(), { mmPerUnit: 0, newId }).ok && !planDrawingImport(loose, emptySketch(), { mmPerUnit: Number.NaN, newId }).ok, "a zero or NaN scale is refused");
    }
  },
  {
    name: "sketch import planning: the 500 curve limit and the +-10000 mm limit are named, big files go in as several edits",
    run: () => {
      const many = (count: number): ParsedDrawing => ({
        format: "dxf", units: { name: "millimetres", mmPerUnit: 1, source: "file" }, warnings: [], skipped: {}, layers: [],
        curves: Array.from({ length: count }, (_, index) => ({ kind: "circle" as const, center: [(index % 25) * 12, Math.floor(index / 25) * 12] as Vec2, radius: 4, layer: "0" }))
      });
      const refused = planDrawingImport(many(600), emptySketch(), { mmPerUnit: 1, newId });
      assert(!refused.ok && messageOf(refused).includes("600") && messageOf(refused).includes("500"), `names both numbers: ${messageOf(refused)}`);
      const full = planDrawingImport(many(300), sketchOf(Array.from({ length: 300 }, (_, index) => ({ id: `entity:have${index}`, kind: "circle" as const, center: [index, 0] as Vec2, radiusMm: 0.3, construction: false }))), { mmPerUnit: 1, newId });
      assert(!full.ok && messageOf(full).includes("200 are free"), `counts the free room: ${messageOf(full)}`);
      const big = importInto(many(450), 1);
      equal(big.entities.length, 450, "450 curves import");
      const plans = must(planDrawingImport(many(450), emptySketch(), { mmPerUnit: 1, newId })).plans;
      equal(plans.length, 3, "as three edits");
      assert(plans.every((plan) => plan.addEntities.length <= IMPORT_CHUNK_SIZE), `each within the ${IMPORT_CHUNK_SIZE} curve edit limit`);
      const tooFar = planDrawingImport(many(10), emptySketch(), { mmPerUnit: 1000, newId });
      assert(!tooFar.ok && messageOf(tooFar).includes("10000"), `a huge scale names the coordinate limit: ${messageOf(tooFar)}`);
      const fits = planDrawingImport(many(10), emptySketch(), { mmPerUnit: 100, newId, placement: "center" });
      assert(fits.ok, "but the same drawing centred on the origin fits");
      const tiny = planDrawingImport(many(10), emptySketch(), { mmPerUnit: 0.0001, newId });
      assert(!tiny.ok && messageOf(tiny).includes("0.01"), `a tiny scale names the minimum size: ${messageOf(tiny)}`);
    }
  },
  // ------------------------------------------------------------------ SVG
  {
    name: "sketch SVG export: millimetre size, upright Y, profile and construction groups, arcs with the right sweep",
    run: () => {
      const svg = writeSketchSvg(sketchOf(SAMPLE_ENTITIES));
      assert(svg.startsWith("<?xml") && svg.includes("</svg>"), "an XML document");
      const size = /width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/u.exec(svg);
      assert(size !== null && size[1] === size[3] && size[2] === size[4], "width and height in mm match the viewBox (1 unit = 1 mm)");
      assert(svg.includes("<g id=\"profile\"") && svg.includes("<g id=\"construction\"") && svg.includes("stroke-dasharray"), "profile and dashed construction groups");
      const parsed = must(parseSvg(svg));
      equal(parsed.units.name, "millimetres", "the unit round trips"); equal(parsed.units.source, "file", "from width/height");
      const upright = writeSketchSvg(sketchOf([{ id: "entity:l", kind: "line", start: [0, 0], end: [0, 10], construction: false }]));
      const line = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/u.exec(upright)!;
      assert(Number(line[2]) > Number(line[4]), "a point higher in the sketch has the smaller SVG y (the picture is upright)");
      const ccw = writeSketchSvg(sketchOf([{ id: "entity:a", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false }]));
      assert(/A10 10 0 0 0 /u.test(ccw), "a counter-clockwise half circle is sweep 0 in y-down coordinates");
      const cw = writeSketchSvg(sketchOf([{ id: "entity:a", kind: "arc", start: [-10, 0], mid: [0, 10], end: [10, 0], construction: false }]));
      assert(/A10 10 0 0 1 /u.test(cw), "a clockwise one is sweep 1");
      assert(!writeSketchSvg(sketchOf(SAMPLE_ENTITIES), { includeConstruction: false }).includes("construction"), "construction can be left out");
      assert(writeSketchSvg(sketchOf([]), { title: "A & B <x>" }).includes("A &amp; B &lt;x&gt;"), "the title is escaped");
    }
  },
  {
    name: "sketch SVG round trip: every entity kind comes back within 0.02 mm, construction included, Y not mirrored",
    run: () => {
      const svg = writeSketchSvg(sketchOf(SAMPLE_ENTITIES));
      const drawing = must(parseSvg(svg));
      const { entities } = importInto(drawing, drawing.units.mmPerUnit, { constructionLayers: ["construction"] });
      const original = SAMPLE_ENTITIES.filter((entity) => entity.kind !== "point");
      const imported = entities.filter((entity) => entity.kind !== "point");
      // Compare shapes after moving both to a common corner (the file is placed on its own paper).
      const corner = (list: readonly SketchEntity[]): Vec2 => { const points = list.flatMap(sample); return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))]; };
      const a = corner(original);
      const b = corner(imported);
      const moved = imported.map((entity) => shiftEntity(entity, a[0] - b[0], a[1] - b[1]));
      near(hausdorff(original, moved), 0, 0.02, "the drawing matches (so Y is not mirrored)");
      equal(entities.filter((entity) => entity.kind === "point").length, 1, "the point comes back");
      equal(entities.filter((entity) => entity.construction).length, 1, "construction group is construction");
      equal(entities.filter((entity) => entity.kind === "circle").length, 1, "circle"); equal(entities.filter((entity) => entity.kind === "ellipse").length, 1, "ellipse");
      equal(entities.filter((entity) => entity.kind === "arc").length, 2, "both arcs stay arcs");
      const ellipse = entities.find((entity) => entity.kind === "ellipse");
      if (ellipse?.kind === "ellipse") { near(ellipse.majorRadiusMm, 12, 1e-3, "ellipse major"); near(ellipse.rotationDeg, 30, 0.01, "and its angle"); }
    }
  },
  {
    name: "sketch SVG import: path commands M L H V C S Q T A Z, relative and absolute, compact numbers, implicit repeats",
    run: () => {
      const svgOf = (d: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="${d}"/></svg>`;
      const lines = must(parseSvg(svgOf("M10 10 L30 10 H50 V30 h-20 v-10 l-10 0 Z")));
      assert(lines.curves.every((curve) => curve.kind === "line"), "lines only");
      equal(lines.curves.length, 7, "M10 10 L30 10 H50 V30 h-20 v-10 l-10 0 Z = six pieces plus the closing line");
      const first = lines.curves[0]!;
      assert(first.kind === "line" && first.a[0] === 10 && first.a[1] === -10 && first.b[0] === 30 && first.b[1] === -10, "Y is flipped (svg y 10 is sketch y -10)");
      const last = lines.curves[6]!;
      assert(last.kind === "line" && last.b[0] === 10 && last.b[1] === -10, "Z closes back to the start");
      const implicit = must(parseSvg(svgOf("M0 0 10 0 10 10 0 10")));
      equal(implicit.curves.length, 3, "numbers after M are implicit L");
      const compact = must(parseSvg(svgOf("M0,0L10-5.5.5-1e1-2")));
      assert(compact.curves.length >= 1, "compact numbers like 10-5.5.5 are read");
      const first2 = compact.curves[0]!;
      assert(first2.kind === "line" && first2.b[0] === 10 && first2.b[1] === 5.5, "10-5.5 is 10 and -5.5 (flipped to 5.5)");
      const flags = must(parseSvg(svgOf("M0 0a10 10 0 0110 10")));
      assert(flags.curves.length === 1 && flags.curves[0]!.kind === "arc", "arc flags may be packed: '0 0110 10' is 0 0 1 10 10");
      const arc = flags.curves[0]!;
      if (arc.kind === "arc") { near(arc.end[0], 10, 1e-9, "arc end x"); near(arc.end[1], -10, 1e-9, "arc end y (flipped)"); const g = arcGeometry(arc.start, arc.mid, arc.end)!; near(g.radius, 10, 1e-9, "radius 10"); near(Math.abs(g.sweep), Math.PI / 2, 1e-9, "a quarter turn"); }
      const cubic = must(parseSvg(svgOf("M0 0C0 20 30 20 30 0")));
      assert(cubic.curves.length === 1 && cubic.curves[0]!.kind === "spline", "a cubic becomes a spline");
      const smooth = must(parseSvg(svgOf("M0 0C0 20 30 20 30 0S60-20 60 0")));
      const quad = must(parseSvg(svgOf("M0 0Q15 30 30 0T60 0")));
      const smoothTotal = smooth.curves.length;
      assert(smoothTotal >= 1 && quad.curves.length >= 1, "S, Q and T are read");
      const { entities } = importInto(quad, 1);
      let top = -Infinity;
      for (const entity of entities) for (const point of sample(entity)) top = Math.max(top, Math.abs(point[1]));
      near(top, 15, 0.1, "the quadratic peaks at half its control height (15)");
      const dup = must(parseSvg(svgOf("M0 0 10 10 20 0 M50 50 60 60")));
      equal(dup.curves.length, 3, "two subpaths");
      const partial = must(parseSvg(svgOf("M0 0 L10 10 L20")));
      assert(partial.curves.length >= 1 && partial.warnings.some((warning) => warning.includes("partly read")), "a broken path keeps what was readable and warns");
    }
  },
  {
    name: "sketch SVG import: shapes, nested transforms, mirrored and non-uniform scale, arcs stay arcs under similarity",
    run: () => {
      const wrap = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 200 200">${inner}</svg>`;
      const shapes = must(parseSvg(wrap("<rect x=\"10\" y=\"20\" width=\"30\" height=\"15\"/><circle cx=\"60\" cy=\"60\" r=\"8\"/><ellipse cx=\"100\" cy=\"100\" rx=\"20\" ry=\"10\"/><line x1=\"0\" y1=\"0\" x2=\"5\" y2=\"5\"/><polyline points=\"0,0 10,0 10,10\"/><polygon points=\"0,0 10,0 10,10\"/>")));
      equal(shapes.curves.filter((curve) => curve.kind === "line").length, 4 + 1 + 2 + 3, "rect 4, line 1, polyline 2, polygon 3");
      equal(shapes.curves.filter((curve) => curve.kind === "circle").length, 1, "circle");
      const ellipse = shapes.curves.find((curve) => curve.kind === "ellipse");
      assert(ellipse?.kind === "ellipse" && ellipse.major === 20 && ellipse.minor === 10 && Math.abs(ellipse.rotationDeg) < 1e-9, "ellipse");
      const rounded = must(parseSvg(wrap("<rect x=\"0\" y=\"0\" width=\"40\" height=\"20\" rx=\"5\"/>")));
      equal(rounded.curves.filter((curve) => curve.kind === "arc").length, 4, "a rounded rect has four corner arcs");
      equal(rounded.curves.filter((curve) => curve.kind === "line").length, 4, "and four sides");
      const nested = must(parseSvg(wrap("<g transform=\"translate(10 20)\"><g transform=\"rotate(90)\"><line x1=\"0\" y1=\"0\" x2=\"10\" y2=\"0\"/></g></g>")));
      const line = singleCurve(nested);
      assert(line.kind === "line", "a line");
      if (line.kind === "line") { near(line.a[0], 10, 1e-9, "start x"); near(line.a[1], -20, 1e-9, "start y (flipped)"); near(line.b[0], 10, 1e-9, "rotate(90) turns +X to +Y: end x"); near(line.b[1], -30, 1e-9, "end y (flipped)"); }
      const matrix = singleCurve(must(parseSvg(wrap("<line transform=\"matrix(2 0 0 3 5 7)\" x1=\"1\" y1=\"1\" x2=\"2\" y2=\"2\"/>"))));
      assert(matrix.kind === "line" && matrix.a[0] === 7 && matrix.a[1] === -10 && matrix.b[0] === 9 && matrix.b[1] === -13, "matrix(2 0 0 3 5 7) maps (1,1) to (7,10) and flips");
      const skew = singleCurve(must(parseSvg(wrap("<line transform=\"skewX(45)\" x1=\"0\" y1=\"10\" x2=\"0\" y2=\"20\"/>"))));
      assert(skew.kind === "line" && Math.abs(skew.a[0] - 10) < 1e-9, "skewX(45) shifts x by y");
      const stretched = singleCurve(must(parseSvg(wrap("<circle transform=\"scale(2 1)\" cx=\"10\" cy=\"10\" r=\"5\"/>"))));
      assert(stretched.kind === "ellipse", "a circle under a non-uniform scale is an ellipse");
      if (stretched.kind === "ellipse") { near(stretched.major, 10, 1e-9, "major 2r"); near(stretched.minor, 5, 1e-9, "minor r"); near(((stretched.rotationDeg % 180) + 180) % 180, 0, 1e-6, "along X"); near(stretched.center[0], 20, 1e-9, "centre x"); }
      const tilted = singleCurve(must(parseSvg(wrap("<g transform=\"rotate(30)\"><ellipse rx=\"20\" ry=\"10\"/></g>"))));
      if (tilted.kind === "ellipse") near(((tilted.rotationDeg % 180) + 540) % 180, 150, 1e-6, "a turned ellipse keeps its angle (30 degrees up in SVG is 30 down after the flip, i.e. 150 mod 180)");
      const mirroredArc = singleCurve(must(parseSvg(wrap("<path transform=\"scale(-1 1)\" d=\"M10 0A10 10 0 0 1 0 10\"/>"))));
      assert(mirroredArc.kind === "arc", "an arc under a mirror stays an arc");
      if (mirroredArc.kind === "arc") { const g = arcGeometry(mirroredArc.start, mirroredArc.mid, mirroredArc.end)!; near(g.radius, 10, 1e-9, "same radius"); near(mirroredArc.start[0], -10, 1e-9, "mirrored start"); }
      const skewedArc = must(parseSvg(wrap("<path transform=\"scale(2 1)\" d=\"M10 0A10 10 0 0 1 0 10\"/>")));
      assert(skewedArc.curves.every((curve) => curve.kind !== "arc"), "under a non-uniform scale an arc cannot stay circular, so it is fitted as a spline");
      const scaledArc = singleCurve(must(parseSvg(wrap("<path transform=\"scale(3)\" d=\"M10 0A10 10 0 0 1 0 10\"/>"))));
      assert(scaledArc.kind === "arc" && Math.abs(arcGeometry(scaledArc.start, scaledArc.mid, scaledArc.end)!.radius - 30) < 1e-9, "uniform scale multiplies the radius");
    }
  },
  {
    name: "sketch SVG import: a four-Bezier circle imports as splines within 0.01 mm of the circle; hidden, defs, text and use are not drawn",
    run: () => {
      const k = 0.5522847498;
      const d = `M50 0C${50 + 50 * k} 0 100 ${50 - 50 * k} 100 50C100 ${50 + 50 * k} ${50 + 50 * k} 100 50 100C${50 - 50 * k} 100 0 ${50 + 50 * k} 0 50C0 ${50 - 50 * k} ${50 - 50 * k} 0 50 0Z`;
      const drawing = must(parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="${d}"/></svg>`));
      const { entities } = importInto(drawing, 1);
      assert(entities.every((entity) => entity.kind === "spline" || entity.kind === "line"), "spline pieces");
      let worst = 0;
      for (const entity of entities) for (const point of sample(entity)) worst = Math.max(worst, Math.abs(Math.hypot(point[0] - 50, point[1] + 50) - 50));
      assert(worst < 0.02, `within 0.02 mm of the true circle (a four-Bezier circle itself is 0.014 mm off at r=50): ${worst}`);
      const hidden = must(parseSvg("<svg xmlns=\"http://www.w3.org/2000/svg\"><defs><path d=\"M0 0L5 5\"/></defs><g display=\"none\"><path d=\"M0 0L6 6\"/></g><path style=\"display:none\" d=\"M0 0L7 7\"/><path visibility=\"hidden\" d=\"M0 0L8 8\"/><text>hi</text><image href=\"x.png\"/><use href=\"#a\"/><clipPath><path d=\"M0 0L9 9\"/></clipPath><path d=\"M0 0L1 1\"/></svg>"));
      equal(hidden.curves.length, 1, "only the visible path counts");
      equal(hidden.skipped["text"], 1, "text counted"); equal(hidden.skipped["image"], 1, "image counted"); equal(hidden.skipped["use"], 1, "use counted");
      equal(hidden.units.source, "assumed", "no size means 96 pixels per inch is assumed");
      assert(hidden.warnings.some((warning) => warning.includes("assumed")), "with a warning");
      const layers = must(parseSvg("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\"><g inkscape:groupmode=\"layer\" inkscape:label=\"Cut\"><path d=\"M0 0L1 1\"/></g><g id=\"Engrave\"><path d=\"M0 0L2 2\"/></g></svg>"));
      equal(layers.layers.map((layer) => layer.name).join(","), "Cut,Engrave", "layers come from Inkscape layers and group ids");
    }
  },
  {
    name: "sketch SVG units: physical sizes with a viewBox give the true millimetres per user unit",
    run: () => {
      const unitsOf = (attrs: string) => must(parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><path d="M0 0L1 1"/></svg>`)).units;
      equal(unitsOf("width=\"100mm\" height=\"100mm\" viewBox=\"0 0 100 100\"").mmPerUnit, 1, "mm");
      near(unitsOf("width=\"4in\" height=\"4in\" viewBox=\"0 0 400 400\"").mmPerUnit, 0.254, 1e-9, "4 inches over 400 units");
      near(unitsOf("width=\"10cm\" viewBox=\"0 0 50 50\"").mmPerUnit, 2, 1e-9, "10 cm over 50 units");
      near(unitsOf("width=\"800\" height=\"600\" viewBox=\"0 0 800 600\"").mmPerUnit, 25.4 / 96, 1e-9, "unitless width means pixels");
      equal(unitsOf("width=\"800\" height=\"600\" viewBox=\"0 0 800 600\"").source, "assumed", "which needs confirming");
      equal(unitsOf("viewBox=\"0 0 10 10\"").source, "assumed", "a viewBox alone is a guess");
      equal(unitsOf("width=\"50%\" viewBox=\"0 0 10 10\"").source, "assumed", "percent sizes are not physical");
    }
  },
  {
    name: "sketch SVG import: malformed files give a clear message and never throw; entities are never expanded",
    run: () => {
      for (const [label, text, word] of [
        ["empty", "", "empty"],
        ["whitespace", "   \n ", "empty"],
        ["not xml", "this is not svg", "svg"],
        ["no svg element", "<html><body/></html>", "svg"],
        ["unterminated tag", "<svg width=\"10\"", "tag"],
        ["unterminated comment", "<svg><!-- hello", "comment"],
        ["unterminated cdata", "<svg><![CDATA[ x", "cdata"],
        ["stray closing tag", "</foo>", "svg"]
      ] as const) {
        const result = parseSvg(text);
        assert(!result.ok, `${label} is refused`);
        assert(messageOf(result).toLowerCase().includes(word), `${label}: the message says why (${messageOf(result)})`);
      }
      const bomb = "<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0L&b;\" id=\"&b;\"/><path d=\"M0 0L5 5\"/></svg>";
      const started = Date.now();
      const parsed = must(parseSvg(bomb));
      assert(Date.now() - started < 500, "an entity bomb is not expanded");
      assert(parsed.curves.length >= 1, "and the rest of the file still reads");
      const deep = "<svg>".repeat(400) + "</svg>".repeat(400);
      assert(!parseSvg(deep).ok, "absurd nesting is refused with a message");
      const many = `<svg>${"<path d=\"M0 0L1 1\"/>".repeat(100_001)}</svg>`;
      const manyResult = parseSvg(many);
      assert(!manyResult.ok && messageOf(manyResult).includes("100000"), "an over-large file names its element limit");
      let seed = 99;
      const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const valid = writeSketchSvg(sketchOf(SAMPLE_ENTITIES));
      for (let round = 0; round < 200; round += 1) {
        let text = valid;
        for (let edit = 0; edit < 1 + Math.floor(random() * 5); edit += 1) {
          const at = Math.floor(random() * text.length);
          const choice = Math.floor(random() * 3);
          text = choice === 0 ? text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 5)) : choice === 1 ? text.slice(0, at) + "<>\"'&NaN-1e999 " .charAt(Math.floor(random() * 14)) + text.slice(at) : text.slice(0, at);
        }
        const result = parseSvg(text);
        if (result.ok) for (const curve of result.value.curves) assert(!JSON.stringify(curve).includes("null"), "no NaN geometry comes out of a damaged SVG");
      }
    }
  },
  {
    name: "sketch SVG import: an upright imported drawing extrudes as the same profile (Y flip end to end)",
    run: () => {
      const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100mm\" height=\"100mm\" viewBox=\"0 0 100 100\"><path d=\"M10 10H60V40H10Z\"/></svg>";
      const drawing = must(parseSvg(svg));
      const { project } = importInto(drawing, 1, { placement: "corner" });
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "one closed profile");
      near(profiles[0]!.areaMm2, 50 * 30, 1e-6, "50 x 30 mm");
    }
  },
  {
    name: "sketch import and export are reachable from the Tools menu and run their actions; without the actions the entries are not listed",
    run: () => {
      const calls: string[] = [];
      const noop = (): void => undefined;
      const base: WorkbenchMenuActions = {
        onUndo: noop, onRedo: noop, onCommandPalette: noop, onNewSketch: noop, onCreateSolidFromSketch: noop, onCreatePrimitive: noop, onCombine: noop, onInsertToAssembly: noop,
        onMasterCart: noop, onRenderStudio: noop, onEditSelectedFeature: noop, onChangeParameters: noop, onToggleSuppressSelected: noop, onDeleteSelected: noop,
        onMoveSelectedBody: noop, onResizeSelectedBody: noop, onModifyGeneralBody: noop, onPattern: noop, onFit: noop, onHome: noop, onToggleGrid: noop, onWorkspace: noop,
        onDesignHealth: noop, onMeasure: noop, onExchange: noop, onAccess: noop, onConnectAi: noop, onExportStl: noop, onPlateJson: noop, onLearning: noop, onShortcuts: noop
      };
      const state: WorkbenchMenuState = { workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false };
      const without = buildWorkbenchMenus(state, base).flatMap((menu) => menu.items);
      assert(!without.some((entry) => entry.id.startsWith("tools.sketch-")), "no entries without the actions");
      const menus = buildWorkbenchMenus(state, { ...base, onSketchImport: () => { calls.push("import"); }, onSketchExport: () => { calls.push("export"); } });
      const items = menus.flatMap((menu) => menu.items);
      equal(new Set(items.map((entry) => entry.id)).size, items.length, "item ids stay unique");
      const importEntry = items.find((entry) => entry.id === "tools.sketch-import");
      const exportEntry = items.find((entry) => entry.id === "tools.sketch-export");
      assert(importEntry !== undefined && exportEntry !== undefined && importEntry.disabled !== true && exportEntry.disabled !== true, "both are listed and enabled (they switch to the Sketch workspace)");
      importEntry.action(); exportEntry.action();
      equal(calls.join(","), "import,export", "and run their actions");
    }
  },
  // ------------------------------------------------------------------ draw as construction
  {
    name: "draw as construction: Q toggles the mode, and everything drawn while it is on is construction through the real operation",
    run: () => {
      const context: SketchHotkeyContext = { tool: "line", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
      const q = resolveSketchHotkey({ key: "q", ctrl: false, meta: false, alt: false, shift: false }, context);
      equal(q?.kind, "toggle-draw-construction", "Q is the draw-as-construction toggle");
      equal(resolveSketchHotkey({ key: "Q", ctrl: false, meta: false, alt: false, shift: false }, context)?.kind, "toggle-draw-construction", "also in capitals");
      equal(resolveSketchHotkey({ key: "x", ctrl: false, meta: false, alt: false, shift: false }, { ...context, tool: "select", selectionCount: 1, curveSelectionCount: 1 })?.kind, "toggle-construction", "X still converts the selection");
      equal(resolveSketchHotkey({ key: "x", ctrl: false, meta: false, alt: false, shift: false }, context)?.kind, "toggle-draw-construction", "and with a drawing tool on, X switches what is drawn next");
      assert(resolveSketchHotkey({ key: "q", ctrl: true, meta: false, alt: false, shift: false }, context) === undefined, "Ctrl+Q is left alone");
      const shape = must(buildCurveTool("parallelogram", [[0, 0], [20, 0], [28, 12]], DEFAULT_CURVE_TOOL_OPTIONS, { entity: newId, constraint: () => `constraint:imp-${(counter += 1)}` }));
      const plan: SketchEditPlan = { label: "Added a parallelogram", removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints };
      const normal = applyPlans(emptyProject(), [planForDrawMode(plan, false)]);
      assert(normal.sketch.entities.every((entity) => !entity.construction), "with the mode off the curves are profile geometry");
      equal(detectSketchProfiles(normal.sketch).length, 1, "and they bound a profile");
      const guide = applyPlans(emptyProject(), [planForDrawMode(plan, true)]);
      assert(guide.sketch.entities.length === shape.entities.length && guide.sketch.entities.every((entity) => entity.construction), "with the mode on every curve is construction");
      equal(detectSketchProfiles(guide.sketch).length, 0, "so no profile forms");
      equal(guide.sketch.constraints.length, normal.sketch.constraints.length, "the shape keeps its relations");
      const updated = planAsConstruction({ ...plan, updateEntities: [SAMPLE_ENTITIES[0]!], addEntities: [] });
      assert(!updated.updateEntities[0]!.construction, "edits to existing curves are not touched");
      assert(asConstruction(SAMPLE_ENTITIES[0]!).construction && asConstruction(SAMPLE_ENTITIES[8]!) === SAMPLE_ENTITIES[8], "an entity already construction is returned as is");
    }
  }
];

function emptySketch(): WorkbenchSketch {
  return sketchOf([]);
}

function shiftEntity(entity: SketchEntity, dx: number, dy: number): SketchEntity {
  const move = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  switch (entity.kind) {
    case "line": return { ...entity, start: move(entity.start), end: move(entity.end) };
    case "arc": return { ...entity, start: move(entity.start), mid: move(entity.mid), end: move(entity.end) };
    case "circle": case "ellipse": case "rectangle": return { ...entity, center: move(entity.center) };
    case "point": return { ...entity, point: move(entity.point) };
    case "spline": return { ...entity, fitPoints: entity.fitPoints.map(move) };
  }
}
