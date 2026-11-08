import type { SketchEntity, SketchPatternSpec, Vec2, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, sketchPatternInstanceEntityId, sketchPatternInstanceOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import type { SketchEditPlan } from "../packages/workbench-sketch/src/edit-tools.js";
import { DEFAULT_PATTERN_FIELDS, describePatternSpec, findPatternOf, patternInstances, patternSpecFromFields, planPattern, planPatternDissolve, planPatternEdit, planPatternRemoveCopies, planPatternSuppress } from "../packages/workbench-sketch/src/pattern-path.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const nextId = (prefix: "entity" | "constraint"): string => `${prefix}:user-p${(counter += 1)}`;

function projectWith(entities: readonly SketchEntity[]): WorkbenchProject {
  const base = createWorkbenchProject("project:test-sketch-pattern");
  return { ...base, sketch: { ...base.sketch, entities, constraints: [] } };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

type PlainOperation<T> = T extends unknown ? Omit<T, "operationId" | "expectedRevision"> : never;

function run(project: WorkbenchProject, operation: PlainOperation<WorkbenchOperation>) {
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:pattern-${(counter += 1)}`, expectedRevision: project.revision } as WorkbenchOperation);
}

/** Applies a plan through the real operation and checks the project still validates after a JSON round trip. */
function applyPlan(project: WorkbenchProject, plan: SketchEditPlan): WorkbenchProject {
  const applied = run(project, { kind: "apply-sketch-edit", ...plan });
  if (!applied.ok) throw new Error(`the sketch edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
  const again = validateWorkbenchProject(JSON.parse(JSON.stringify(applied.value.project)) as unknown);
  if (!again.ok) throw new Error(`the project no longer validates: ${again.diagnostics[0]?.message ?? "no reason"}`);
  return again.value;
}

const circle = (id: string, center: Vec2, radiusMm = 2): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });
const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });

function centerOf(project: WorkbenchProject, id: string): Vec2 {
  const entity = project.sketch.entities.find((candidate) => candidate.id === id);
  if (entity === undefined || entity.kind !== "circle") throw new Error(`no circle ${id}`);
  return entity.center;
}

const GRID: SketchPatternSpec = { kind: "rectangular", countX: 3, countY: 2, dxMm: 10, dyMm: 8, angleDeg: 0, extent: false };

function patternProject(spec: SketchPatternSpec = GRID): WorkbenchProject {
  const base = projectWith([circle("entity:hole", [5, 5])]);
  return applyPlan(base, must(planPattern({ sketch: base.sketch, newId: nextId }, ["entity:hole"], spec)));
}

export const sketchPatternObjectTests: readonly TestCase[] = [
  {
    name: "associative rectangular pattern: copies land on the grid, at an angle, and in extent mode",
    run: () => {
      const project = patternProject();
      const pattern = project.sketch.patterns![0]!;
      equal(project.sketch.entities.length, 6, "the source plus five copies");
      const at = (instance: number): Vec2 => centerOf(project, sketchPatternInstanceEntityId(pattern.id, instance, 0));
      near(at(1)[0], 15, 1e-9, "column 1 x"); near(at(1)[1], 5, 1e-9, "column 1 y");
      near(at(3)[0], 5, 1e-9, "row 1 column 0 x"); near(at(3)[1], 13, 1e-9, "row 1 column 0 y");
      near(at(5)[0], 25, 1e-9, "row 1 column 2 x"); near(at(5)[1], 13, 1e-9, "row 1 column 2 y");
      const turned = patternProject({ kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 90, extent: false });
      const turnedId = turned.sketch.patterns![0]!.id;
      near(centerOf(turned, sketchPatternInstanceEntityId(turnedId, 2, 0))[0], 5, 1e-9, "a 90 degree pattern runs up the sketch (x)");
      near(centerOf(turned, sketchPatternInstanceEntityId(turnedId, 2, 0))[1], 25, 1e-9, "a 90 degree pattern runs up the sketch (y)");
      const diagonal = patternProject({ kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 45, extent: false });
      const dId = diagonal.sketch.patterns![0]!.id;
      near(centerOf(diagonal, sketchPatternInstanceEntityId(dId, 1, 0))[0], 5 + 10 * Math.SQRT1_2, 1e-9, "an angled direction, not just an axis-aligned grid");
      const extent = patternProject({ kind: "rectangular", countX: 5, countY: 1, dxMm: 100, dyMm: 0, angleDeg: 0, extent: true });
      const eId = extent.sketch.patterns![0]!.id;
      near(centerOf(extent, sketchPatternInstanceEntityId(eId, 4, 0))[0], 105, 1e-9, "extent mode spreads the total span (100 mm over 4 gaps)");
      near(centerOf(extent, sketchPatternInstanceEntityId(eId, 1, 0))[0], 30, 1e-9, "so each step is 25 mm");
    }
  },
  {
    name: "associative pattern: re-editing the count and spacing re-generates the copies, keeping the IDs that remain",
    run: () => {
      const project = patternProject();
      const pattern = project.sketch.patterns![0]!;
      const keptId = sketchPatternInstanceEntityId(pattern.id, 1, 0);
      const wider = applyPlan(project, must(planPatternEdit(project.sketch, pattern.id, { ...GRID, countX: 5, countY: 1, dxMm: 7 })));
      equal(wider.sketch.entities.length, 5, "5 x 1 makes the source plus four copies");
      near(centerOf(wider, keptId)[0], 12, 1e-9, "the first copy moved to the new spacing");
      assert(!wider.sketch.entities.some((entity) => sketchPatternInstanceOf(pattern.id, entity.id) === 5), "the old second row is gone");
      equal(wider.sketch.patterns!.length, 1, "still one pattern object");
      const back = applyPlan(wider, must(planPatternEdit(wider.sketch, pattern.id, GRID)));
      equal(back.sketch.entities.length, 6, "and back");
      const circular = applyPlan(back, must(planPatternEdit(back.sketch, pattern.id, { kind: "circular", count: 4, angleDeg: 360, center: [0, 0], rotate: true })));
      equal(circular.sketch.entities.length, 4, "the layout kind can change too");
    }
  },
  {
    name: "associative pattern: editing the source curve updates every copy in the same operation",
    run: () => {
      const project = patternProject();
      const pattern = project.sketch.patterns![0]!;
      const resized = run(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 3.5 });
      assert(resized.ok, "the radius dimension applies");
      if (!resized.ok) return;
      for (let instance = 1; instance < 6; instance += 1) {
        const copy = resized.value.project.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(pattern.id, instance, 0));
        assert(copy?.kind === "circle" && Math.abs(copy.radiusMm - 3.5) < 1e-9, `copy ${instance} follows the new radius`);
      }
      const source = resized.value.project.sketch.entities.find((entity) => entity.id === "entity:hole")!;
      const dragged = applyPlan(project, { label: "Moved the hole", removeEntityIds: [], updateEntities: [{ ...source, kind: "circle", center: [6, 7] } as SketchEntity], addEntities: [], addConstraints: [] });
      const first = dragged.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(pattern.id, 1, 0));
      assert(first?.kind === "circle" && Math.abs(first.center[0] - 16) < 1e-9 && Math.abs(first.center[1] - 7) < 1e-9, "moving the source moves the copies");
    }
  },
  {
    name: "associative pattern: single instances can be suppressed and restored, and stay off when the count changes",
    run: () => {
      const project = patternProject();
      const pattern = project.sketch.patterns![0]!;
      const off = applyPlan(project, must(planPatternSuppress(project.sketch, pattern.id, [2, 4], true)));
      equal(off.sketch.entities.length, 4, "two copies are gone");
      assert(!off.sketch.entities.some((entity) => sketchPatternInstanceOf(pattern.id, entity.id) === 2), "instance 2 is off");
      equal(off.sketch.patterns![0]!.suppressed.join(","), "2,4", "the switches are stored");
      const bigger = applyPlan(off, must(planPatternEdit(off.sketch, pattern.id, { ...GRID, countX: 4 })));
      assert(!bigger.sketch.entities.some((entity) => sketchPatternInstanceOf(pattern.id, entity.id) === 2), "a suppressed instance is not resurrected by a count change");
      const restored = applyPlan(off, must(planPatternSuppress(off.sketch, pattern.id, [2], false)));
      equal(restored.sketch.entities.length, 5, "restoring brings one copy back");
      assert(!planPatternSuppress(project.sketch, pattern.id, [0], true).ok, "the source cannot be suppressed");
      assert(!planPatternSuppress(project.sketch, pattern.id, [99], true).ok, "an instance that does not exist is refused");
      // Deleting every curve of an instance by hand switches it off instead of letting it come back.
      const hand = run(project, { kind: "delete-sketch-entity", entityId: sketchPatternInstanceEntityId(pattern.id, 3, 0) });
      assert(hand.ok, "a copy can be deleted");
      if (hand.ok) {
        equal(hand.value.project.sketch.patterns![0]!.suppressed.join(","), "3", "the deleted instance is recorded as suppressed");
        equal(hand.value.project.sketch.entities.length, 5, "and stays deleted");
      }
    }
  },
  {
    name: "associative pattern: losing the source lets the pattern go but keeps the copies; dissolve and remove-copies work",
    run: () => {
      const project = patternProject();
      const pattern = project.sketch.patterns![0]!;
      const gone = run(project, { kind: "delete-sketch-entity", entityId: "entity:hole" });
      assert(gone.ok, "the source can be deleted");
      if (gone.ok) {
        equal(gone.value.project.sketch.patterns, undefined, "the pattern object is gone");
        equal(gone.value.project.sketch.entities.length, 5, "the copies stay as plain curves");
        assert(gone.value.summary.includes("pattern"), "and the summary says so");
      }
      const plain = applyPlan(project, must(planPatternDissolve(project.sketch, pattern.id)));
      equal(plain.sketch.patterns, undefined, "dissolve ends the pattern");
      equal(plain.sketch.entities.length, 6, "and keeps every curve");
      const trimmed = applyPlan(project, must(planPatternRemoveCopies(project.sketch, pattern.id)));
      equal(trimmed.sketch.entities.length, 1, "remove copies leaves the source only");
      equal(findPatternOf(project.sketch, "entity:hole")?.instance, 0, "the source finds its pattern as instance 0");
      equal(findPatternOf(project.sketch, sketchPatternInstanceEntityId(pattern.id, 4, 0))?.instance, 4, "a copy finds its instance number");
      equal(patternInstances(project.sketch, pattern).size, 5, "five instances exist");
    }
  },
  {
    name: "associative circular pattern: even spacing, partial angle, and instances that turn or keep their orientation",
    run: () => {
      const rect: SketchEntity = { id: "entity:tab", kind: "rectangle", center: [20, 0], widthMm: 6, heightMm: 2, rotationDeg: 0, construction: false };
      const base = projectWith([rect]);
      const full = applyPlan(base, must(planPattern({ sketch: base.sketch, newId: nextId }, ["entity:tab"], { kind: "circular", count: 4, angleDeg: 360, center: [0, 0], rotate: true })));
      const id = full.sketch.patterns![0]!.id;
      const third = full.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(id, 2, 0));
      assert(third?.kind === "rectangle", "a rectangle copy");
      if (third?.kind === "rectangle") {
        near(third.center[0], -20, 1e-9, "180 degrees round the origin (x)");
        near(Math.abs(third.rotationDeg), 180, 1e-9, "and turned with the pattern");
      }
      const fixed = applyPlan(base, must(planPattern({ sketch: base.sketch, newId: nextId }, ["entity:tab"], { kind: "circular", count: 4, angleDeg: 270, center: [0, 0], rotate: false })));
      const fid = fixed.sketch.patterns![0]!.id;
      const last = fixed.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(fid, 3, 0));
      assert(last?.kind === "rectangle", "a rectangle copy");
      if (last?.kind === "rectangle") {
        near(last.center[0], 0, 1e-9, "a partial angle reaches the last instance (270 degrees: x)");
        near(last.center[1], -20, 1e-9, "(y)");
        near(last.rotationDeg, 0, 1e-9, "without turning it when Rotate is off");
      }
    }
  },
  {
    name: "path pattern: copies are placed by spacing along a line, an arc and a spline, with and without following the path",
    run: () => {
      const base = projectWith([circle("entity:bolt", [0, 0], 1), line("entity:rail", [0, 0], [100, 0])]);
      const ctx = { sketch: base.sketch, newId: nextId };
      const spaced = applyPlan(base, must(planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:rail", count: 5, spacingMm: 20, fit: false, startMm: 0, follow: false })));
      const id = spaced.sketch.patterns![0]!.id;
      for (let k = 1; k < 5; k += 1) {
        const c = centerOf(spaced, sketchPatternInstanceEntityId(id, k, 0));
        near(c[0], 20 * k, 1e-9, `copy ${k} sits ${20 * k} mm along the rail`);
        near(c[1], 0, 1e-9, "on the rail");
      }
      const fitted = applyPlan(base, must(planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:rail", count: 6, spacingMm: 1, fit: true, startMm: 0, follow: false })));
      near(centerOf(fitted, sketchPatternInstanceEntityId(fitted.sketch.patterns![0]!.id, 5, 0))[0], 100, 1e-9, "Fit puts the last copy on the end of the path");
      const offset = applyPlan(base, must(planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:rail", count: 3, spacingMm: 10, fit: false, startMm: 30, follow: false })));
      near(centerOf(offset, sketchPatternInstanceEntityId(offset.sketch.patterns![0]!.id, 1, 0))[0], 10, 1e-9, "copies keep the spacing from the source");
      // An arc path with a tab that follows the tangent.
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [0, 0], mid: [10, 10], end: [20, 0], construction: false };
      const tab: SketchEntity = { id: "entity:tab", kind: "rectangle", center: [0, 0], widthMm: 4, heightMm: 1, rotationDeg: 0, construction: false };
      const onArc = projectWith([tab, arc]);
      const followed = applyPlan(onArc, must(planPattern({ sketch: onArc.sketch, newId: nextId }, ["entity:tab"], { kind: "path", pathEntityId: "entity:arc", count: 3, spacingMm: 1, fit: true, startMm: 0, follow: true })));
      const fid = followed.sketch.patterns![0]!.id;
      const middle = followed.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(fid, 1, 0));
      assert(middle?.kind === "rectangle", "a rectangle copy on the arc");
      if (middle?.kind === "rectangle") {
        near(middle.center[0], 10, 0.05, "the middle copy is at the top of the arc (x)");
        near(middle.center[1], 10, 0.05, "(y)");
        near(Math.abs(middle.rotationDeg), 90, 0.5, "and has turned a quarter turn with the tangent (the source was 90 degrees off the path at the start)");
      }
      const end = followed.sketch.entities.find((entity) => entity.id === sketchPatternInstanceEntityId(fid, 2, 0));
      if (end?.kind === "rectangle") near(Math.abs(end.rotationDeg), 180, 0.5, "the last copy has turned a half turn with the arc");
      const spline: SketchEntity = { id: "entity:spline", kind: "spline", fitPoints: [[0, 0], [20, 15], [40, 0], [60, 15]], construction: false };
      const onSpline = projectWith([circle("entity:bolt", [0, 0], 1), spline]);
      const sp = applyPlan(onSpline, must(planPattern({ sketch: onSpline.sketch, newId: nextId }, ["entity:bolt"], { kind: "path", pathEntityId: "entity:spline", count: 4, spacingMm: 1, fit: true, startMm: 0, follow: false })));
      const lastSp = centerOf(sp, sketchPatternInstanceEntityId(sp.sketch.patterns![0]!.id, 3, 0));
      near(lastSp[0], 60, 1e-6, "the last copy reaches the end of the spline (x)");
      near(lastSp[1], 15, 1e-6, "(y)");
      const ring: SketchEntity = { id: "entity:ring", kind: "circle", center: [0, 0], radiusMm: 50, construction: false };
      const onRing = projectWith([circle("entity:bolt", [50, 0], 1), ring]);
      const rp = applyPlan(onRing, must(planPattern({ sketch: onRing.sketch, newId: nextId }, ["entity:bolt"], { kind: "path", pathEntityId: "entity:ring", count: 4, spacingMm: 1, fit: true, startMm: 0, follow: false })));
      const quarter = centerOf(rp, sketchPatternInstanceEntityId(rp.sketch.patterns![0]!.id, 1, 0));
      near(quarter[0], 0, 0.01, "Fit on a circle spaces the copies all the way round (x)");
      near(quarter[1], 50, 0.01, "(y)");
    }
  },
  {
    name: "path pattern: a layout that does not fit the path, or an unusable path, is refused with the numbers",
    run: () => {
      const base = projectWith([circle("entity:bolt", [0, 0], 1), line("entity:rail", [0, 0], [100, 0]), { id: "entity:dot", kind: "point", point: [3, 3], construction: false }]);
      const ctx = { sketch: base.sketch, newId: nextId };
      const tooLong = planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:rail", count: 20, spacingMm: 10, fit: false, startMm: 0, follow: false });
      assert(!tooLong.ok && tooLong.diagnostics[0]!.message.includes("190") && tooLong.diagnostics[0]!.message.includes("100"), "190 mm needed of 100 mm is named");
      const point = planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:dot", count: 3, spacingMm: 5, fit: false, startMm: 0, follow: false });
      assert(!point.ok && point.diagnostics[0]!.message.includes("point"), "a point cannot be a path");
      const self = planPattern(ctx, ["entity:rail"], { kind: "path", pathEntityId: "entity:rail", count: 3, spacingMm: 5, fit: false, startMm: 0, follow: false });
      assert(!self.ok, "the path cannot repeat itself");
      const gone = planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:missing", count: 3, spacingMm: 5, fit: false, startMm: 0, follow: false });
      assert(!gone.ok, "a missing path is refused");
      const zero = planPattern(ctx, ["entity:bolt"], { kind: "path", pathEntityId: "entity:rail", count: 3, spacingMm: 0, fit: false, startMm: 0, follow: false });
      assert(!zero.ok, "a zero spacing is refused");
      const nan = planPattern(ctx, ["entity:bolt"], { kind: "rectangular", countX: 3, countY: 1, dxMm: Number.NaN, dyMm: 0, angleDeg: 0, extent: false });
      assert(!nan.ok, "a NaN spacing is refused before it reaches the operation (no throw)");
      const nothing = planPattern(ctx, [], GRID);
      assert(!nothing.ok, "nothing selected");
    }
  },
  {
    name: "pattern limits E12: a pattern that would exceed the 500 curve limit says how many curves it would make",
    run: () => {
      const crowd: SketchEntity[] = Array.from({ length: 450 }, (_, index) => circle(`entity:c${index}`, [(index % 30) * 5, Math.floor(index / 30) * 5], 1));
      const base = projectWith(crowd);
      const refused = planPattern({ sketch: base.sketch, newId: nextId }, ["entity:c0", "entity:c1"], { kind: "rectangular", countX: 40, countY: 1, dxMm: 200, dyMm: 0, angleDeg: 0, extent: false });
      assert(!refused.ok, "too many copies are refused");
      if (!refused.ok) assert(refused.diagnostics[0]!.message.includes("500") && /\d{3} curves/u.test(refused.diagnostics[0]!.message), `the message names the limit and the size: ${refused.diagnostics[0]!.message}`);
      const viaOperation = run(base, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "forced", objects: { patterns: [{ id: "pattern:forced", sourceIds: ["entity:c0", "entity:c1"], suppressed: [], spec: { kind: "rectangular", countX: 40, countY: 1, dxMm: 200, dyMm: 0, angleDeg: 0, extent: false } }] } });
      assert(!viaOperation.ok && viaOperation.diagnostics[0]!.message.includes("500"), "the operation itself refuses it with the same reason (no payload error)");
    }
  },
  {
    name: "pattern fields: the palette text becomes a layout, bad numbers are named, and a stored layout fills the fields back",
    run: () => {
      const rect = must(patternSpecFromFields({ ...DEFAULT_PATTERN_FIELDS, countX: "4", countY: "2", dx: "12,5", dy: "6", angle: "30", extent: true }));
      equal(rect.kind === "rectangular" && rect.dxMm, 12.5, "a comma decimal is read");
      const bad = patternSpecFromFields({ ...DEFAULT_PATTERN_FIELDS, countX: "four" });
      assert(!bad.ok && bad.diagnostics[0]!.message.includes("Count"), "the unreadable field is named");
      const noPath = patternSpecFromFields({ ...DEFAULT_PATTERN_FIELDS, kind: "path" });
      assert(!noPath.ok && noPath.diagnostics[0]!.message.includes("path"), "a path pattern asks for a path");
      assert(describePatternSpec(rect).includes("Rectangular 4"), "the description reads well");
    }
  },
  {
    name: "pattern performance: a 500-curve sketch with a 100-instance pattern edits in well under a second",
    run: () => {
      const crowd: SketchEntity[] = Array.from({ length: 400 }, (_, index) => circle(`entity:c${index}`, [(index % 25) * 6, Math.floor(index / 25) * 6 - 200], 1));
      const base = projectWith([...crowd, circle("entity:seed", [-100, -100], 1)]);
      const patterned = applyPlan(base, must(planPattern({ sketch: base.sketch, newId: nextId }, ["entity:seed"], { kind: "circular", count: 100, angleDeg: 360, center: [-100, -100 + 30], rotate: true })));
      equal(patterned.sketch.entities.length, 500, "the sketch is full");
      const started = Date.now();
      for (let round = 0; round < 5; round += 1) {
        const changed = run(patterned, { kind: "set-sketch-dimension", entityId: "entity:seed", dimension: "radius", valueMm: 1 + round * 0.1 });
        assert(changed.ok, "the source edit applies");
      }
      assert((Date.now() - started) / 5 < 1000, `each edit takes well under a second (${(Date.now() - started) / 5} ms)`);
    }
  },
  {
    name: "associative pattern: a parameter that drives the source radius updates the copies, in the working sketch and in a committed one",
    run: () => {
      const base = patternProject({ kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 0, extent: false });
      const pattern = base.sketch.patterns![0]!;
      const withParameter = run(base, { kind: "set-design-parameters", parameters: [{ name: "pin_r", expression: "3 mm", unit: "mm", comment: "" }] });
      assert(withParameter.ok, "the parameter is accepted");
      if (!withParameter.ok) return;
      const bound = run(withParameter.value.project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 3, expression: "pin_r" });
      assert(bound.ok, `the radius binds to the parameter: ${bound.ok ? "" : bound.diagnostics[0]?.message}`);
      if (!bound.ok) return;
      const copyRadius = (project: WorkbenchProject): number | undefined => { const entity = project.sketch.entities.find((candidate) => candidate.id === sketchPatternInstanceEntityId(pattern.id, 2, 0)); return entity?.kind === "circle" ? entity.radiusMm : undefined; };
      near(copyRadius(bound.value.project) ?? 0, 3, 1e-9, "the copy has the source radius");
      const committed = run(bound.value.project, { kind: "commit-design-sketch", featureId: "feature:sketch-pins", name: "Pins" });
      assert(committed.ok, "the sketch is finished");
      if (!committed.ok) return;
      const changed = run(committed.value.project, { kind: "set-design-parameters", parameters: [{ name: "pin_r", expression: "6 mm", unit: "mm", comment: "" }] });
      assert(changed.ok, "the parameter changes");
      if (!changed.ok) return;
      near(copyRadius(changed.value.project) ?? 0, 6, 1e-9, "the copy in the working sketch follows the parameter");
      const snapshot = changed.value.project.design!.features.find((feature) => feature.id === "feature:sketch-pins");
      assert(snapshot?.kind === "sketch", "the committed sketch exists");
      if (snapshot?.kind === "sketch") {
        const copy = snapshot.sketch.entities.find((candidate) => candidate.id === sketchPatternInstanceEntityId(pattern.id, 2, 0));
        assert(copy?.kind === "circle" && Math.abs(copy.radiusMm - 6) < 1e-9, "and so does the copy in the committed sketch");
      }
    }
  },
  {
    name: "patterns survive commit, reopen and a fresh sketch starts clean",
    run: () => {
      const project = patternProject();
      const committed = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-pat", name: "Holes" });
      assert(committed.ok, "commits");
      if (!committed.ok) return;
      const fresh = run(committed.value.project, { kind: "new-design-sketch", plane: "datum:xy" });
      assert(fresh.ok && fresh.value.project.sketch.patterns === undefined, "a new sketch has no pattern");
      if (!fresh.ok) return;
      const reopened = run(fresh.value.project, { kind: "edit-design-sketch", featureId: "feature:sketch-pat" });
      assert(reopened.ok && reopened.value.project.sketch.patterns?.length === 1 && reopened.value.project.sketch.entities.length === 6, "reopening restores the pattern and its copies");
    }
  }
];
