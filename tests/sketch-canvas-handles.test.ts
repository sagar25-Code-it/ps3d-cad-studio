import type { SketchEntity, Vec2, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { constraintKindsPresent, constraintRows, constraintsToDraw, DEFAULT_CONSTRAINT_DISPLAY, describeConstraint, entityOrdinalLabels, glyphAt, layoutConstraintGlyphs, parseConstraintDisplay, redundantConstraintIds, relatedEntityIds, toggleHiddenKind, type ConstraintDisplaySettings, type GlyphFocus, type PlacedGlyph } from "../packages/workbench-sketch/src/constraint-glyph-layout.js";
import { MAX_DIMENSION_OFFSET_PX, MIN_DIMENSION_OFFSET_PX, clampPrecision, dimensionEditText, dimensionForClick, dragDimensionOffset, formatAngleLabel, formatLengthLabel, isRepositionable, parseDimensionDisplay, parseDimensionInput, parseDimensionOffsets, sameDimensionValue, serializeDimensionOffsets, stackDimensionLabels } from "../packages/workbench-sketch/src/dimension-display.js";
import { dimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { MAX_SPLINE_FIT_POINTS } from "../packages/workbench-core/src/spline-limits.js";
import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { dragSketchHandle, grabHandlesOf, splineTangentGrabHandle } from "../packages/workbench-sketch/src/drag.js";
import { insertSplineFitPoint, nearestPointOnSpline, removeSplineFitPoint, type SplineEntity } from "../packages/workbench-sketch/src/spline-edit.js";
import { splineTangentHandles } from "../packages/workbench-sketch/src/spline-helpers.js";
import { canvasHitSizes, describeEntityForAccessibility, focusAfter, resolveCanvasKey } from "../packages/workbench-sketch/src/canvas-keyboard.js";
import { fitCameraToViewport } from "../packages/workbench-sketch/src/camera.js";
import { cameraForExtents, selectionExtents, zoomWindowExtents } from "../packages/workbench-sketch/src/camera-zoom.js";
import { EMPTY_MEASURE, addMeasurePick, describeMeasurement, measurePoints, pickMeasureTarget } from "../packages/workbench-sketch/src/sketch-measure-tool.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function tryRun(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-canvas-handles-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = tryRun(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function emptyProject(): WorkbenchProject {
  const project = createWorkbenchProject("project:test-canvas-handles");
  return { ...project, sketch: { ...project.sketch, entities: [], constraints: [] } };
}

function add(project: WorkbenchProject, entities: readonly SketchEntity[]): WorkbenchProject {
  return run(project, { kind: "apply-sketch-edit", label: "test add", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [] });
}

const rel = (id: string, kind: WorkbenchSketchConstraint["kind"], entityIds: readonly string[], extra: Partial<WorkbenchSketchConstraint> = {}): WorkbenchSketchConstraint => ({ id, kind, entityIds, ...extra });

function overlapping(glyphs: readonly PlacedGlyph[], mmPerPx: number): number {
  let count = 0;
  for (let i = 0; i < glyphs.length; i += 1) {
    for (let j = i + 1; j < glyphs.length; j += 1) {
      const a = glyphs[i]!;
      const b = glyphs[j]!;
      if (Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) < (a.radiusPx + b.radiusPx) * mmPerPx - 1e-9) count += 1;
    }
  }
  return count;
}

const glyphTests: readonly TestCase[] = [
  {
    name: "Walkthrough item 5: ten relations on one small circle get ten separate glyphs that do not overlap, and none sits on the circle's centre",
    run: () => {
      const entities: SketchEntity[] = [circle("entity:small", [0, 0], 1), ...[1, 2, 3, 4, 5].map((n) => circle(`entity:twin-${n}`, [n * 3, 0], 1))];
      const constraints = [
        rel("c:1", "fixed", ["entity:small"]), rel("c:2", "equal", ["entity:small", "entity:twin-1"]), rel("c:3", "concentric", ["entity:small", "entity:twin-2"]),
        rel("c:4", "tangent", ["entity:small", "entity:twin-3"]), rel("c:5", "equal", ["entity:small", "entity:twin-4"]), rel("c:6", "equal", ["entity:small", "entity:twin-5"]),
        rel("c:7", "coincident", ["entity:small", "entity:twin-1"], { points: ["center", "center"] }), rel("c:8", "tangent", ["entity:small", "entity:twin-2"]),
        rel("c:9", "equal", ["entity:small", "entity:twin-3"]), rel("c:10", "tangent", ["entity:small", "entity:twin-4"])
      ];
      const mmPerPx = 0.05;
      const placed = layoutConstraintGlyphs(constraints, entities, { mmPerPx });
      equal(placed.length, 10, "every relation has a glyph");
      equal(overlapping(placed, mmPerPx), 0, "no two glyphs overlap");
      const noncoincident = placed.filter((glyph) => glyph.kind !== "coincident");
      assert(noncoincident.every((glyph) => Math.hypot(glyph.at[0], glyph.at[1]) > 4 * mmPerPx), "none of the curve relations sits on the circle's centre");
      const again = layoutConstraintGlyphs(constraints, entities, { mmPerPx });
      equal(JSON.stringify(again.map((glyph) => glyph.at)), JSON.stringify(placed.map((glyph) => glyph.at)), "the layout is deterministic");
      for (const zoom of [0.01, 0.2, 2]) equal(overlapping(layoutConstraintGlyphs(constraints, entities, { mmPerPx: zoom }), zoom), 0, `no overlap at ${zoom} mm per pixel`);
    }
  },
  {
    name: "Walkthrough item 5: the Constraints level shows all, only the relations of the selection or hover, or none; hidden kinds stay hidden until selected",
    run: () => {
      const constraints = [rel("c:h", "horizontal", ["entity:a"]), rel("c:v", "vertical", ["entity:b"]), rel("c:p", "parallel", ["entity:a", "entity:b"]), rel("c:dim", "distance", ["entity:a"], { dimension: "length", valueMm: 5 })];
      const none: GlyphFocus = { selectedEntityIds: [], hoveredEntityId: null, selectedConstraintIds: [], hoveredConstraintId: null };
      const ids = (settings: ConstraintDisplaySettings, focus: GlyphFocus): string => constraintsToDraw(constraints, settings, focus).map((constraint) => constraint.id).join(",");
      equal(ids(DEFAULT_CONSTRAINT_DISPLAY, none), "c:h,c:v,c:p", "all: every relation, but a dimension is drawn as a dimension, not a glyph");
      equal(ids({ level: "selected", hiddenKinds: [] }, none), "", "selected with nothing selected: no glyphs");
      equal(ids({ level: "selected", hiddenKinds: [] }, { ...none, selectedEntityIds: ["entity:b"] }), "c:v,c:p", "selected: the relations that touch the selected curve");
      equal(ids({ level: "selected", hiddenKinds: [] }, { ...none, hoveredEntityId: "entity:a" }), "c:h,c:p", "hovering a curve shows its relations");
      equal(ids({ level: "none", hiddenKinds: [] }, none), "", "none: no glyphs");
      equal(ids({ level: "none", hiddenKinds: [] }, { ...none, selectedConstraintIds: ["c:p"] }), "c:p", "but a selected relation is still shown so the person can see what was picked");
      equal(ids({ level: "all", hiddenKinds: ["parallel"] }, none), "c:h,c:v", "per-type hide removes one kind");
      equal(ids({ level: "all", hiddenKinds: ["parallel"] }, { ...none, hoveredConstraintId: "c:p" }), "c:h,c:v,c:p", "a hovered relation shows even when its kind is hidden");
      equal(JSON.stringify(constraintKindsPresent(constraints)), JSON.stringify(["horizontal", "vertical", "parallel"]), "the legend lists only the geometric kinds present");
      equal(JSON.stringify(toggleHiddenKind(DEFAULT_CONSTRAINT_DISPLAY, "parallel").hiddenKinds), JSON.stringify(["parallel"]), "toggling hides a kind");
      equal(toggleHiddenKind(toggleHiddenKind(DEFAULT_CONSTRAINT_DISPLAY, "parallel"), "parallel").hiddenKinds.length, 0, "and toggling again shows it");
      equal(parseConstraintDisplay("not json").level, "all", "garbage settings fall back to the defaults");
      equal(parseConstraintDisplay(JSON.stringify({ level: "selected", hiddenKinds: ["parallel", "bogus"] })).hiddenKinds.join(","), "parallel", "unknown kinds are ignored");
    }
  },
  {
    name: "Sketch edit E09: every relation can be hit-tested on the canvas and is reachable in the list (not just the last 10), with names instead of IDs",
    run: () => {
      const entities: SketchEntity[] = Array.from({ length: 30 }, (_, n) => line(`entity:user-${n}-4f2c9e1a-77aa-4b1c`, [0, n * 5], [10, n * 5]));
      const constraints = entities.map((entity, n) => rel(`constraint:r-${n}`, "horizontal", [entity.id]));
      const labels = entityOrdinalLabels(entities);
      const rows = constraintRows(constraints, labels);
      equal(rows.length, 30, "all thirty relations are listed (the old list stopped at ten)");
      assert(rows.every((row) => !/entity:|user-|4f2c9e1a/.test(row.text)), "no raw stable ID reaches the list");
      equal(rows[29]!.text, "Horizontal: Line 1", "the row names the relation and the curve (newest first, so the oldest is last)");
      equal(describeConstraint(rel("c:d", "distance", ["entity:user-3-4f2c9e1a-77aa-4b1c"], { dimension: "length", valueMm: 25.4 }), labels), "Length: Line 4 = 25.4 mm", "a dimension shows its value");
      const placed = layoutConstraintGlyphs(constraints, entities, { mmPerPx: 0.1 });
      for (const glyph of placed) equal(glyphAt(placed, glyph.at, 0.1)?.id, glyph.id, `${glyph.id} is hit where it is drawn`);
      equal(glyphAt(placed, [500, 500], 0.1), undefined, "empty canvas hits no glyph");
      equal(JSON.stringify(relatedEntityIds(constraints[3]!)), JSON.stringify([entities[3]!.id]), "hovering a glyph names the curve to highlight");
      assert(relatedEntityIds(rel("c:pair", "parallel", ["entity:a", "entity:b"])).length === 2, "a pair relation highlights both curves");
    }
  },
  {
    name: "Missing capability: duplicate relations are flagged redundant, and the analysis' own redundancy list is used when it exists",
    run: () => {
      const constraints = [rel("c:1", "horizontal", ["entity:a"]), rel("c:2", "horizontal", ["entity:a"]), rel("c:3", "parallel", ["entity:a", "entity:b"]), rel("c:4", "parallel", ["entity:b", "entity:a"]), rel("c:5", "vertical", ["entity:b"]), rel("c:6", "horizontal", ["entity:c"], { suppressed: true }), rel("c:7", "horizontal", ["entity:c"])];
      equal([...redundantConstraintIds(constraints)].join(","), "c:2,c:4", "the second copy of an identical relation is redundant, in either order for a pair");
      equal([...redundantConstraintIds(constraints, undefined)].length, 2, "an absent analysis is tolerated");
      equal([...redundantConstraintIds(constraints, { classification: "underconstrained" })].length, 2, "and so is one without the field");
      equal([...redundantConstraintIds(constraints, { redundantConstraintIds: ["c:5"] })].sort().join(","), "c:2,c:4,c:5", "constraints the analysis names are added");
    }
  },
  {
    name: "Performance: 1000 relations on 500 entities lay out without overlap in well under a second",
    run: () => {
      const entities: SketchEntity[] = Array.from({ length: 500 }, (_, n) => circle(`entity:p-${n}`, [(n % 25) * 6, Math.floor(n / 25) * 6], 1.2));
      const constraints = Array.from({ length: 1000 }, (_, n) => rel(`constraint:p-${n}`, n % 2 === 0 ? "equal" : "tangent", [`entity:p-${n % 500}`, `entity:p-${(n + 1) % 500}`]));
      const started = performance.now();
      const placed = layoutConstraintGlyphs(constraints, entities, { mmPerPx: 0.2 });
      const elapsed = performance.now() - started;
      equal(placed.length, 1000, "all placed");
      assert(elapsed < 400, `laid out in ${elapsed.toFixed(0)} ms`);
      equal(overlapping(placed, 0.2), 0, "without overlap");
    }
  }
];

const dimensionTests: readonly TestCase[] = [
  {
    name: "Sketch edit E24: labels carry units and a chosen precision, and a tiny value never prints as 0",
    run: () => {
      equal(formatLengthLabel(25.4), "25.40 mm", "two decimals and a unit by default");
      equal(formatLengthLabel(25.4, { unit: "mm", precision: 3, showUnit: false }), "25.400", "three decimals without a unit");
      equal(formatLengthLabel(25.4, { unit: "in", precision: 3, showUnit: true }), "1.000 in", "inches");
      equal(formatLengthLabel(0.0004), "0.0004 mm", "0.0004 no longer shows as 0");
      equal(formatLengthLabel(0), "0.00 mm", "a true zero stays zero");
      equal(formatLengthLabel(-1e-13, { unit: "mm", precision: 2, showUnit: false }), "0.00", "floating-point dust does not print -0");
      equal(formatLengthLabel(0.001, { unit: "mm", precision: 2, showUnit: false }), "0.001", "but a real 0.001 mm is shown, not rounded away");
      equal(formatAngleLabel(90, { unit: "mm", precision: 1, showUnit: true }), "90.0°", "angles use the precision too");
      equal(clampPrecision(99), 6, "precision is bounded");
      equal(clampPrecision(-3), 0, "at both ends");
      equal(parseDimensionDisplay("{broken").precision, 2, "bad stored settings fall back");
    }
  },
  {
    name: "Sketch edit E24: the value editor starts from the exact stored value, so Enter without typing re-drives nothing",
    run: () => {
      const stored = 12.3456789012345;
      const text = dimensionEditText(stored);
      equal(Number(text), Number(stored.toPrecision(12)), "the editor shows the number to 12 significant digits, not 3 decimals");
      assert(text.length > String(Number(stored.toFixed(3))).length, "which is more than the rounded text the old editor used");
      const typed = parseDimensionInput(text);
      assert(typed !== undefined && Math.abs(typed - stored) < 1e-10, "the value typed back from that text is within 1e-10 of the stored one");
      assert(sameDimensionValue(stored, stored), "the unchanged value is recognised as unchanged");
      equal(dimensionEditText(25.4, { unit: "in", precision: 2, showUnit: true }), "1", "in inches the editor starts in inches");
      equal(parseDimensionInput("25.4"), 25.4, "a bare number is in the display unit (mm)");
      equal(parseDimensionInput("1", { unit: "in", precision: 2, showUnit: true }), 25.4, "or inches when that is the display unit");
      equal(parseDimensionInput("1 in"), 25.4, "an explicit inch suffix wins");
      equal(parseDimensionInput("12,5 mm"), 12.5, "a decimal comma is accepted");
      equal(parseDimensionInput("plate_w / 2"), undefined, "an expression is left to the expression path");
    }
  },
  {
    name: "Sketch edit E24: stacked dimensions on one curve do not overlap, and a dragged stand-off is kept",
    run: () => {
      const bar = line("entity:bar", [0, 0], [100, 0]);
      const px = 0.5;
      const requests = [
        { id: "d1", layoutAt: (offsetPx: number) => dimensionLayout(bar, "length", 100, px, { offsetPx }) },
        { id: "d2", layoutAt: (offsetPx: number) => dimensionLayout(bar, "length", 100.5, px, { offsetPx }) },
        { id: "d3", layoutAt: (offsetPx: number) => dimensionLayout(bar, "length", 99, px, { offsetPx }) }
      ];
      const naive = requests.map((request) => request.layoutAt(30)!);
      equal(new Set(naive.map((layout) => layout.textAt.join(","))).size, 1, "at the fixed 30 px offset all three labels sit on the same spot (the old behaviour)");
      const stacked = stackDimensionLabels(requests, px);
      equal(stacked.length, 3, "all three are placed");
      equal(new Set(stacked.map((entry) => Math.round(entry.layout.textAt[1] * 1000))).size, 3, "on three different rows");
      assert(stacked[0]!.offsetPx === 30 && stacked[1]!.offsetPx > 30 && stacked[2]!.offsetPx > stacked[1]!.offsetPx, "each further out than the last");
      const kept = stackDimensionLabels([{ ...requests[0]!, userOffsetPx: 90 }, requests[1]!], px);
      equal(kept.find((entry) => entry.id === "d1")!.offsetPx, 90, "a stand-off the person dragged to is kept");
      assert(kept.find((entry) => entry.id === "d2")!.offsetPx === 30, "the other dimension does not collide with it, so it keeps the default");
      const layout = requests[0]!.layoutAt(30)!;
      assert(isRepositionable(layout), "a linear dimension can be dragged");
      const moved = dragDimensionOffset(layout, 30, [50, 15], [50, 40], px);
      near(moved, 30 + 25 / px, 1e-6, "dragging the label 25 mm up (away from the line) adds that distance in pixels");
      near(dragDimensionOffset(layout, 30, [50, 15], [50, -500], px), MIN_DIMENSION_OFFSET_PX, 1e-9, "dragging through the geometry stops at the minimum stand-off");
      near(dragDimensionOffset(layout, 30, [50, 15], [50, 9000], px), MAX_DIMENSION_OFFSET_PX, 1e-9, "and far away at the maximum");
      const circleLayout = dimensionLayout(circle("entity:c", [0, 0], 5), "radius", 5, px)!;
      assert(!isRepositionable(circleLayout), "a diameter has no stand-off to drag");
      assert(dimensionLayout(bar, "length", 100, px, { offsetPx: 60 })!.dimensionLine.from[1] > layout.dimensionLine.from[1], "a larger stand-off moves the dimension line away");
      equal(dimensionLayout(bar, "length", 100, px, { format: (value) => `~${value}` })!.label, "~100", "the label writer is used");
      equal(dimensionLayout(circle("entity:c2", [0, 0], 5), "radius", 5, px, { format: (value) => `d=${value}` })!.label, "Ød=10", "the diameter is passed to the writer for a circle");
      const roundTrip = parseDimensionOffsets(serializeDimensionOffsets({ "constraint:a": 55.04, "constraint:b": 9999 }));
      near(roundTrip["constraint:a"]!, 55, 1e-9, "offsets survive a save and load");
      equal(roundTrip["constraint:b"], MAX_DIMENSION_OFFSET_PX, "and are clamped");
      equal(Object.keys(parseDimensionOffsets("[1,2]")).length, 0, "nonsense stored offsets are ignored");
      const box: SketchEntity = { id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 20, rotationDeg: 0, construction: false };
      equal(dimensionForClick(box, [0, 11]), "width", "a click near the top edge dimensions the width");
      equal(dimensionForClick(box, [21, 0]), "height", "and near the side edge, the height");
    }
  }
];

const handleTests: readonly TestCase[] = [
  {
    name: "Sketch edit E25: a spline takes up to 64 fit points through the project operations (it stopped at 24), and 65 is refused",
    run: () => {
      const fit = (count: number): Vec2[] => Array.from({ length: count }, (_, n) => [n * 5, Math.sin(n / 3) * 8] as Vec2);
      const project = emptyProject();
      const ok = tryRun(project, { kind: "add-sketch-entity", entity: { id: "entity:long-spline", kind: "spline", fitPoints: fit(40), construction: false } });
      assert(ok.ok, `40 fit points are accepted: ${ok.ok ? "" : ok.diagnostics[0]?.message}`);
      const limit = tryRun(project, { kind: "add-sketch-entity", entity: { id: "entity:limit-spline", kind: "spline", fitPoints: fit(MAX_SPLINE_FIT_POINTS), construction: false } });
      assert(limit.ok, "the maximum is accepted");
      const over = tryRun(project, { kind: "add-sketch-entity", entity: { id: "entity:over-spline", kind: "spline", fitPoints: fit(MAX_SPLINE_FIT_POINTS + 1), construction: false } });
      assert(!over.ok, "one more is refused");
      const built = buildSketchEntity("spline", fit(30), "entity:tool-spline");
      assert(built.ok, "the Spline tool builds 30 points");
      equal(MAX_SPLINE_FIT_POINTS, 64, "the cap is 64");
    }
  },
  {
    name: "Sketch edit E25: a fit point can be inserted on the curve and removed again, and the curve keeps passing through the others",
    run: () => {
      const spline: SplineEntity = { id: "entity:s", kind: "spline", fitPoints: [[0, 0], [10, 8], [20, 0], [30, 8]], construction: false };
      const inserted = insertSplineFitPoint(spline, [14, 7]);
      assert(inserted.ok, "inserting near the middle span works");
      if (!inserted.ok) return;
      equal(inserted.entity.fitPoints.length, 5, "one more fit point");
      equal(inserted.index, 2, "inserted between fit points 2 and 3");
      const onCurve = nearestPointOnSpline(spline, inserted.entity.fitPoints[2]!);
      near(onCurve!.distanceMm, 0, 1e-9, "the new point lies on the original curve");
      equal(JSON.stringify(inserted.entity.fitPoints.filter((_, index) => index !== 2)), JSON.stringify(spline.fitPoints), "the other fit points are untouched");
      const removed = removeSplineFitPoint(inserted.entity, 2);
      assert(removed.ok && removed.entity.fitPoints.length === 4, "removing it gets back to four points");
      assert(!removeSplineFitPoint({ ...spline, fitPoints: spline.fitPoints.slice(0, 3) }, 1).ok, "a three-point spline cannot lose one");
      assert(!insertSplineFitPoint(spline, [10.001, 8]).ok, "a click on top of an existing point is refused");
      const full = { ...spline, fitPoints: Array.from({ length: MAX_SPLINE_FIT_POINTS }, (_, n) => [n * 2, 0] as Vec2) };
      assert(!insertSplineFitPoint(full, [10, 0]).ok, "a full spline takes no more");
      let project = add(emptyProject(), [spline]);
      project = run(project, { kind: "apply-sketch-edit", label: "add fit point", removeEntityIds: [], updateEntities: [inserted.entity], addEntities: [], addConstraints: [] });
      equal((project.sketch.entities[0] as SplineEntity).fitPoints.length, 5, "the project holds the five-point spline");
    }
  },
  {
    name: "Sketch edit E25: dragging a spline's tangent handle turns the tangent at that fit point; the fit points stay where they are",
    run: () => {
      const spline: SplineEntity = { id: "entity:t", kind: "spline", fitPoints: [[0, 0], [10, 0], [20, 0], [30, 0]], construction: false };
      const sketch = { ...emptyProject().sketch, entities: [spline] };
      const handle = splineTangentGrabHandle(spline, 1)!;
      equal(handle.handle.kind, "tangent", "a tangent grab handle exists for fit point 2");
      near(handle.point[1], 0, 1e-9, "on a straight run the tip lies along the curve");
      assert(handle.point[0] > 10, "ahead of the fit point");
      const dragged = dragSketchHandle(sketch, spline.id, handle.handle, handle.point, [10, 4]);
      assert(dragged.ok, `the drag is accepted: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const edited = dragged.entities[0] as SplineEntity;
      equal(JSON.stringify(edited.fitPoints[1]), JSON.stringify([10, 0]), "the fit point itself did not move");
      const after = splineTangentHandles(edited, 1 / 3).find((candidate) => candidate.index === 1)!;
      near(after.tip[0], 10, 0.5, "the tangent tip follows the pointer (x)");
      near(after.tip[1], 4, 0.5, "and (y)");
      assert(edited.fitPoints[0]![1] !== 0 || edited.fitPoints[2]![1] !== 0, "the neighbours moved to carry the new tangent");
      assert(!dragSketchHandle(sketch, spline.id, { kind: "tangent", index: 9 }, [0, 0], [1, 1]).ok, "a tangent handle on a fit point that does not exist is refused");
    }
  },
  {
    name: "Sketch edit E25: an ellipse shows major and minor axis handles, and dragging them resizes and turns it",
    run: () => {
      const ellipse: SketchEntity = { id: "entity:e", kind: "ellipse", center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10, rotationDeg: 0, construction: false };
      const handles = grabHandlesOf(ellipse);
      equal(handles.length, 3, "centre plus two axis handles (it used to be the centre only)");
      const major = handles.find((handle) => handle.handle.kind === "ellipse-axis" && handle.handle.which === "major")!;
      const minor = handles.find((handle) => handle.handle.kind === "ellipse-axis" && handle.handle.which === "minor")!;
      equal(JSON.stringify(major.point), JSON.stringify([20, 0]), "the major handle sits on the major axis end");
      equal(JSON.stringify(minor.point), JSON.stringify([0, 10]), "the minor handle on the minor axis end");
      const sketch = { ...emptyProject().sketch, entities: [ellipse] };
      const ellipseOf = (result: ReturnType<typeof dragSketchHandle>): Extract<SketchEntity, { kind: "ellipse" }> => {
        assert(result.ok, `the drag is accepted: ${result.ok ? "" : result.message}`);
        return result.entities[0] as Extract<SketchEntity, { kind: "ellipse" }>;
      };
      near(ellipseOf(dragSketchHandle(sketch, ellipse.id, major.handle, major.point, [30, 0])).majorRadiusMm, 30, 1e-9, "the major radius follows the pointer");
      const turned = ellipseOf(dragSketchHandle(sketch, ellipse.id, major.handle, major.point, [0, 25]));
      near(turned.rotationDeg, 90, 1e-9, "dragging the major end round turns the ellipse");
      near(turned.majorRadiusMm, 25, 1e-9, "to the new radius");
      near(ellipseOf(dragSketchHandle(sketch, ellipse.id, minor.handle, minor.point, [0, 14])).minorRadiusMm, 14, 1e-9, "the minor radius follows the pointer");
      near(ellipseOf(dragSketchHandle(sketch, ellipse.id, minor.handle, minor.point, [0, 50])).minorRadiusMm, 20, 1e-9, "a minor radius beyond the major one stops at the major radius");
      const shrunk = ellipseOf(dragSketchHandle(sketch, ellipse.id, major.handle, major.point, [6, 0]));
      assert(shrunk.minorRadiusMm <= shrunk.majorRadiusMm, "pulling the major end inside the minor radius brings the minor radius along");
      assert(tryRun(add(emptyProject(), [ellipse]), { kind: "apply-sketch-edit", label: "resize", removeEntityIds: [], updateEntities: [shrunk], addEntities: [], addConstraints: [] }).ok, "and the project accepts the result");
      assert(!dragSketchHandle(sketch, ellipse.id, major.handle, major.point, [0.001, 0]).ok, "a radius under 0.01 mm is refused");
    }
  }
];

const noKeys = { ctrl: false, meta: false, alt: false, shift: false };

const navigationTests: readonly TestCase[] = [
  {
    name: "Sketch edit E28: the canvas can be walked with the keyboard in drawing order, with a spoken description, and touch targets are larger",
    run: () => {
      const entities: SketchEntity[] = [line("entity:k1", [0, 0], [10, 0]), circle("entity:k2", [20, 0], 4), { ...line("entity:hidden", [0, 5], [5, 5]), visible: false }, line("entity:k3", [0, 9], [3, 9])];
      equal(resolveCanvasKey({ key: "ArrowRight", ...noKeys })?.kind, "focus-next", "Right goes to the next curve");
      equal(resolveCanvasKey({ key: "ArrowUp", ...noKeys })?.kind, "focus-previous", "Up goes back");
      equal(JSON.stringify(resolveCanvasKey({ key: "Enter", ...noKeys, shift: true })), JSON.stringify({ kind: "select-focused", additive: true }), "Shift+Enter adds to the selection");
      equal(resolveCanvasKey({ key: " ", ...noKeys })?.kind, "select-focused", "Space selects");
      equal(resolveCanvasKey({ key: "a", ...noKeys, ctrl: true }), undefined, "Ctrl shortcuts are left to the sketch hotkeys");
      equal(focusAfter(entities, null, { kind: "focus-next" }), "entity:k1", "from nothing, next is the first curve");
      equal(focusAfter(entities, null, { kind: "focus-previous" }), "entity:k3", "and previous is the last");
      equal(focusAfter(entities, "entity:k1", { kind: "focus-next" }), "entity:k2", "next walks in drawing order");
      equal(focusAfter(entities, "entity:k2", { kind: "focus-next" }), "entity:k3", "skipping hidden curves");
      equal(focusAfter(entities, "entity:k3", { kind: "focus-next" }), "entity:k1", "and wraps round");
      equal(focusAfter(entities, "entity:k1", { kind: "focus-previous" }), "entity:k3", "backwards too");
      equal(focusAfter([], null, { kind: "focus-next" }), null, "an empty sketch has nothing to focus");
      equal(focusAfter(entities, "entity:k2", { kind: "focus-last" }), "entity:k3", "End goes to the last");
      const spoken = describeEntityForAccessibility(entities[0]!, "Line 1", 1, 3, true);
      assert(spoken.includes("Line 1, 1 of 3") && spoken.includes("length 10 millimetres") && spoken.endsWith("selected"), `announces what it is: ${spoken}`);
      assert(!/entity:/.test(spoken), "without a raw ID");
      const mouse = canvasHitSizes(false);
      const touch = canvasHitSizes(true);
      assert(touch.grabHitPx * 2 >= 44 && touch.glyphPx * 2 >= 24, "touch hit targets reach finger size");
      assert(mouse.grabHitPx * 2 > 10, "and the mouse hit target is bigger than the old 10 px dot");
      assert(mouse.dimensionPointPx * 2 > 12 && touch.dimensionPointPx > mouse.dimensionPointPx, "dimension points are larger than the old 12 px and grow for touch");
    }
  },
  {
    name: "Missing capability: zoom window and zoom to selection frame a small region far tighter than Fit's 10 mm minimum, clear of the palette",
    run: () => {
      const size = { width: 1000, height: 600 };
      const noInsets = { left: 0, top: 0, right: 0, bottom: 0 };
      const camera = cameraForExtents({ min: [10, 10], max: [12, 11] }, size, noInsets);
      assert(camera.widthMm < 5, `a 2 mm feature fills the view (${camera.widthMm.toFixed(2)} mm across)`);
      near(camera.centerMm[0], 11, 1e-9, "centred on the feature (x)");
      near(camera.centerMm[1], 10.5, 1e-9, "and (y)");
      const fitted = fitCameraToViewport({ min: [10, 10], max: [12, 11] }, size, noInsets);
      assert(fitted.widthMm > camera.widthMm * 2, "Fit would have stayed at 10 mm or more");
      const withPalette = cameraForExtents({ min: [0, 0], max: [10, 10] }, size, { left: 0, top: 0, right: 300, bottom: 0 });
      assert(withPalette.centerMm[0] > 5, "the view is shifted so the feature sits left of the palette");
      const wide = cameraForExtents({ min: [0, 0], max: [100, 1] }, size, noInsets);
      assert(wide.widthMm >= 100, "a wide region is fitted by its width");
      assert(zoomWindowExtents([0, 0], [0.1, 0.1], 0.1) === undefined, "a click-sized window is not a zoom");
      equal(JSON.stringify(zoomWindowExtents([20, 5], [-4, 9], 0.1)), JSON.stringify({ min: [-4, 5], max: [20, 9] }), "a dragged window is normalised whichever way it was dragged");
      const entities: SketchEntity[] = [line("entity:z1", [0, 0], [10, 0]), circle("entity:z2", [50, 50], 5), { ...line("entity:z3", [200, 200], [210, 200]), visible: false }];
      equal(JSON.stringify(selectionExtents(entities, ["entity:z2"])), JSON.stringify({ min: [45, 45], max: [55, 55] }), "the selection extents are the circle's");
      equal(selectionExtents(entities, []), undefined, "nothing selected gives no extents");
      equal(selectionExtents(entities, ["entity:z3"]), undefined, "a hidden curve is not zoomed to");
      equal(JSON.stringify(selectionExtents(entities, ["entity:z1", "entity:z2"])), JSON.stringify({ min: [0, 0], max: [55, 55] }), "several curves give their combined extents");
    }
  },
  {
    name: "Missing capability: Measure gives the distance between two points, the angle between two lines and a point-to-line distance, without adding any relation",
    run: () => {
      const entities: SketchEntity[] = [line("entity:m1", [0, 0], [10, 0]), line("entity:m2", [0, 0], [0, 10]), line("entity:m3", [0, 20], [10, 20]), circle("entity:mc", [30, 30], 5)];
      const sketch = { ...emptyProject().sketch, entities };
      const before = JSON.stringify(sketch);
      const endpoint = pickMeasureTarget(sketch, [10.2, 0.1], 0.5, "point")!;
      equal(endpoint.kind, "point", "a click near a line end picks that end");
      equal(JSON.stringify((endpoint as { at: Vec2 }).at), JSON.stringify([10, 0]), "snapped exactly");
      let state = addMeasurePick(EMPTY_MEASURE, endpoint);
      assert(state.result === undefined, "one pick measures nothing yet");
      state = addMeasurePick(state, pickMeasureTarget(sketch, [30, 30], 0.5, "point")!);
      assert(state.result?.kind === "points", "two points measure a distance");
      if (state.result?.kind === "points") {
        near(state.result.distanceMm, Math.hypot(20, 30), 1e-9, "distance");
        near(state.result.dxMm, 20, 1e-9, "ΔX");
        near(state.result.dyMm, 30, 1e-9, "ΔY");
      }
      state = addMeasurePick(state, pickMeasureTarget(sketch, [5, 0], 0.5, "line")!);
      assert(state.result === undefined && state.picks.length === 1, "a third pick starts over");
      state = addMeasurePick(state, pickMeasureTarget(sketch, [0, 5], 0.5, "line")!);
      assert(state.result?.kind === "lines", "two lines measure an angle");
      if (state.result?.kind === "lines") {
        near(state.result.angleDeg, 90, 1e-9, "a right angle");
        near(state.result.acuteDeg, 90, 1e-9, "acute 90");
        assert(!state.result.parallel, "not parallel");
        near(state.result.crossing![0], 0, 1e-9, "they cross at the origin (x)");
        near(state.result.crossing![1], 0, 1e-9, "and (y)");
      }
      const parallel = addMeasurePick(addMeasurePick(EMPTY_MEASURE, pickMeasureTarget(sketch, [5, 0], 0.5, "line")!), pickMeasureTarget(sketch, [5, 20], 0.5, "line")!);
      assert(parallel.result?.kind === "lines" && parallel.result.parallel, "two parallel lines are recognised");
      if (parallel.result?.kind === "lines") near(parallel.result.gapMm ?? -1, 20, 1e-9, "with their gap");
      const mixed = addMeasurePick(addMeasurePick(EMPTY_MEASURE, pickMeasureTarget(sketch, [30, 30], 0.5, "point")!), pickMeasureTarget(sketch, [5, 20], 0.5, "line")!);
      assert(mixed.result?.kind === "point-line", "a point and a line measure the perpendicular distance");
      if (mixed.result?.kind === "point-line") near(mixed.result.distanceMm, 10, 1e-9, "from (30,30) to y = 20");
      assert(pickMeasureTarget(sketch, [100, 100], 0.5, "line") === undefined, "empty canvas picks no line");
      equal(pickMeasureTarget(sketch, [100, 100], 0.5)?.kind, "point", "but the free cursor can still be measured from");
      equal(addMeasurePick(addMeasurePick(EMPTY_MEASURE, pickMeasureTarget(sketch, [5, 0], 0.5, "line")!), pickMeasureTarget(sketch, [6, 0], 0.5, "line")!).result, undefined, "the same line twice measures nothing");
      assert(describeMeasurement(measurePoints([0, 0], [3, 4])).includes("5 mm"), "the readout states the distance");
      equal(JSON.stringify(sketch), before, "measuring never touches the sketch");
      equal(sketch.constraints.length, 0, "and adds no relation");
    }
  }
];

export const sketchCanvasHandleTests: readonly TestCase[] = [...glyphTests, ...dimensionTests, ...handleTests, ...navigationTests];
