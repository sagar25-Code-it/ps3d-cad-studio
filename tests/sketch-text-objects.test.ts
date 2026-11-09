import type { SketchEntity, Vec2, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { transformEntities, type SketchEditPlan } from "../packages/workbench-sketch/src/edit-tools.js";
import { buildSketchText, glyphStrokes, glyphWidthUnits, STROKE_FONT_CHARACTERS, TEXT_MAX_ENTITIES, textWidthMm, unsupportedTextCharacters } from "../packages/workbench-sketch/src/stroke-text.js";
import { findTextObject, planSketchText, planSketchTextDelete, planSketchTextEdit, planSketchTextExplode, textSpecFromFields, textSpecOf, DEFAULT_SKETCH_TEXT_SPEC, type SketchTextSpec } from "../packages/workbench-sketch/src/sketch-text.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const nextId = (prefix: "entity" | "constraint"): string => `${prefix}:user-t${(counter += 1)}`;
const ids = { entity: () => nextId("entity"), constraint: () => nextId("constraint") };
const context = { newId: nextId };

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-sketch-text");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

/** Applies a sketch edit plan exactly as the UI does and checks the project still validates after a JSON round trip. */
function applyPlan(project: WorkbenchProject, plan: SketchEditPlan): WorkbenchProject {
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:text-${(counter += 1)}`, expectedRevision: project.revision, ...plan });
  if (!applied.ok) throw new Error(`the sketch edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
  const again = validateWorkbenchProject(JSON.parse(JSON.stringify(applied.value.project)) as unknown);
  if (!again.ok) throw new Error(`the project no longer validates: ${again.diagnostics[0]?.message ?? "no reason"}`);
  return again.value;
}

type PlainOperation<T> = T extends unknown ? Omit<T, "operationId" | "expectedRevision"> : never;

function run(project: WorkbenchProject, operation: PlainOperation<WorkbenchOperation>) {
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:text-${(counter += 1)}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function boundsOf(entities: readonly SketchEntity[]): { readonly min: Vec2; readonly max: Vec2 } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const entity of entities) {
    const points = entity.kind === "line" ? [entity.start, entity.end] : entity.kind === "arc" ? [entity.start, entity.mid, entity.end] : [];
    for (const point of points) { xs.push(point[0]); ys.push(point[1]); }
  }
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

const SPEC: SketchTextSpec = { ...DEFAULT_SKETCH_TEXT_SPEC, text: "Rev B 12.5", heightMm: 8 };

export const sketchTextObjectTests: readonly TestCase[] = [
  {
    name: "sketch text T25: the engineering symbols, full lowercase, digits and Greek letters all draw",
    run: () => {
      const wanted = "Ø°±µ#%&@()[]{}<>⌀μαβγδεθλπρστφωΔΘΛΠΣΦΨΩabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*^~|\\\";²³×≤≥";
      equal(unsupportedTextCharacters(wanted).join(""), "", "the font claims every one of them");
      for (const character of wanted) {
        const shape = must(buildSketchText([0, 0], character, { heightMm: 12 }, ids));
        assert(shape.entities.length >= 1, `"${character}" draws curves`);
        const box = boundsOf(shape.entities);
        assert(box.min[1] >= -2.6 * 2 - 1e-9 && box.max[1] <= 6.7 * 2 + 1e-9, `"${character}" stays inside the descender and ascender room (${box.min[1]} .. ${box.max[1]})`);
        assert(glyphStrokes(character) !== undefined && glyphWidthUnits(character)! > 0, `"${character}" has strokes and a width`);
      }
      const lower = must(buildSketchText([0, 0], "o", { heightMm: 12 }, ids));
      near(boundsOf(lower.entities).max[1], 8, 1e-6, "lowercase o is two thirds of the capital height");
      const g = boundsOf(must(buildSketchText([0, 0], "g", { heightMm: 12 }, ids)).entities);
      near(g.min[1], -4, 1e-6, "a g hangs below the baseline");
      const diameter = must(buildSketchText([0, 0], "Ø12 ± 0.1 90°", { heightMm: 10 }, ids));
      assert(diameter.entities.length > 10, "a callout like Ø12 ± 0.1 90° draws");
      assert(STROKE_FONT_CHARACTERS.includes("Ø") && STROKE_FONT_CHARACTERS.includes("°"), "the character list names the symbols");
    }
  },
  {
    name: "sketch text T25: a NaN or out-of-range angle, width or spacing is named, not reported as text too small",
    run: () => {
      for (const [label, options, word] of [
        ["NaN angle", { heightMm: 10, rotationDeg: Number.NaN }, "angle"],
        ["infinite angle", { heightMm: 10, rotationDeg: Infinity }, "angle"],
        ["NaN height", { heightMm: Number.NaN }, "height"],
        ["width 0", { heightMm: 10, widthFactor: 0 }, "width"],
        ["negative spacing", { heightMm: 10, spacing: -1 }, "spacing"]
      ] as const) {
        const result = buildSketchText([0, 0], "AB", options, ids);
        assert(!result.ok, `${label} is refused`);
        if (!result.ok) {
          const message = result.diagnostics[0]!.message;
          assert(message.toLowerCase().includes(word), `${label}: the message names the ${word} (${message})`);
          assert(!message.includes("too small"), `${label}: no misleading 'too small' message`);
        }
      }
      assert(!buildSketchText([Number.NaN, 0], "A", { heightMm: 10 }, ids).ok, "a NaN anchor point is refused");
      const tooLong = buildSketchText([0, 0], "B".repeat(41), { heightMm: 10 }, ids);
      assert(!tooLong.ok, "an over-long text is refused (41 characters)");
      assert(TEXT_MAX_ENTITIES === 400, "and the curve limit is the one a text object can record");
    }
  },
  {
    name: "sketch text: width, spacing, alignment and rotation options change the layout",
    run: () => {
      const normal = boundsOf(must(buildSketchText([0, 0], "HELLO", { heightMm: 10 }, ids)).entities);
      const wide = boundsOf(must(buildSketchText([0, 0], "HELLO", { heightMm: 10, widthFactor: 2 }, ids)).entities);
      near(wide.max[0] - wide.min[0], 2 * (normal.max[0] - normal.min[0]), 1e-9, "width factor 2 doubles the width");
      near(wide.max[1] - wide.min[1], normal.max[1] - normal.min[1], 1e-9, "and keeps the height");
      const loose = boundsOf(must(buildSketchText([0, 0], "HELLO", { heightMm: 10, spacing: 3 }, ids)).entities);
      assert(loose.max[0] > normal.max[0], "spacing widens");
      const width = textWidthMm("HELLO", { heightMm: 10 });
      const left = boundsOf(must(buildSketchText([50, 20], "HELLO", { heightMm: 10, align: "left" }, ids)).entities);
      const middle = boundsOf(must(buildSketchText([50, 20], "HELLO", { heightMm: 10, align: "center" }, ids)).entities);
      const right = boundsOf(must(buildSketchText([50, 20], "HELLO", { heightMm: 10, align: "right" }, ids)).entities);
      near(left.min[0], 50, 1e-9, "left alignment starts at the anchor");
      near((middle.min[0] + middle.max[0]) / 2, 50, 0.6, "centre alignment centres on the anchor");
      near(right.max[0], 50, 1e-9, "right alignment ends at the anchor");
      near(left.max[0] - left.min[0], width, 1e-9, "the measured width matches the drawn width");
      const turned = boundsOf(must(buildSketchText([0, 0], "HELLO", { heightMm: 10, rotationDeg: 90, align: "right" }, ids)).entities);
      assert(turned.max[1] - turned.min[1] > 3 * (turned.max[0] - turned.min[0]) && turned.max[1] <= 1e-9, "rotated 90 degrees and right aligned the text runs down from the anchor");
    }
  },
  {
    name: "sketch text: placed text keeps its string and settings and survives a JSON round trip",
    run: () => {
      const plan = must(planSketchText(context, [10, 20], { ...SPEC, rotationDeg: 15, widthFactor: 1.5, spacing: 2, align: "center" }));
      const project = applyPlan(emptyProject(), plan);
      const texts = project.sketch.texts ?? [];
      equal(texts.length, 1, "one text object is stored");
      const text = texts[0]!;
      equal(text.text, "Rev B 12.5", "the string");
      equal(text.heightMm, 8, "the size");
      equal(text.align, "center", "the alignment");
      equal(text.rotationDeg, 15, "the angle");
      equal(text.entityIds.length, project.sketch.entities.length, "it names every generated curve");
      assert(text.entityIds.every((id) => project.sketch.entities.some((entity) => entity.id === id)), "and they all exist");
      equal(findTextObject(project.sketch, text.entityIds[3]!)?.id, text.id, "any generated curve finds its text");
      const json = JSON.stringify(project);
      const reread = validateWorkbenchProject(JSON.parse(json) as unknown);
      assert(reread.ok, "the project reopens");
      equal(JSON.stringify(reread.ok ? reread.value : undefined), json, "and is identical after the round trip");
    }
  },
  {
    name: "sketch text: reopening placed text replaces its curves with the new settings in one operation",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], SPEC)));
      const text = placed.sketch.texts![0]!;
      const oldIds = new Set(text.entityIds);
      const edited = applyPlan(placed, must(planSketchTextEdit(context, placed.sketch, text.id, { ...textSpecOf(text), text: "Rev C", heightMm: 12 })));
      equal(edited.sketch.texts!.length, 1, "still one text object");
      const next = edited.sketch.texts![0]!;
      equal(next.id, text.id, "the same object");
      equal(next.text, "Rev C", "with the new string");
      equal(next.heightMm, 12, "and size");
      assert(next.entityIds.every((id) => !oldIds.has(id)), "its curves are the new ones");
      assert(edited.sketch.entities.every((entity) => !oldIds.has(entity.id)), "the old curves are gone");
      equal(edited.sketch.entities.length, next.entityIds.length, "and nothing else was left behind");
      const box = boundsOf(edited.sketch.entities);
      near(box.max[1], 12, 0.3, "the new curves are the new height");
      const missing = planSketchTextEdit(context, placed.sketch, "text:nope", SPEC);
      assert(!missing.ok, "an unknown text is refused");
      const badAngle = planSketchTextEdit(context, placed.sketch, text.id, { ...textSpecOf(text), rotationDeg: Number.NaN });
      assert(!badAngle.ok, "a NaN angle is refused while editing too");
    }
  },
  {
    name: "sketch text: a pure move keeps the text editable at the new place; reshaping or deleting a curve lets it go",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [5, 5], SPEC)));
      const text = placed.sketch.texts![0]!;
      const moved = applyPlan(placed, must(transformEntities({ sketch: placed.sketch, newId: nextId }, text.entityIds, { kind: "move", dxMm: 30, dyMm: -4 }, false)));
      equal(moved.sketch.texts?.length, 1, "moving all the curves keeps the text object");
      near(moved.sketch.texts![0]!.originMm[0], 35, 1e-9, "the anchor moved with it (x)");
      near(moved.sketch.texts![0]!.originMm[1], 1, 1e-9, "the anchor moved with it (y)");
      const edited = applyPlan(moved, must(planSketchTextEdit(context, moved.sketch, text.id, textSpecOf(text))));
      near(boundsOf(edited.sketch.entities).min[0], 35, 0.01, "reopened text appears at the moved place");
      // Reshape one curve by hand.
      const first = moved.sketch.entities[0]!;
      assert(first.kind === "line" || first.kind === "arc", "the first curve is a line or arc");
      const nudged: SketchEntity = first.kind === "line" ? { ...first, end: [first.end[0] + 0.7, first.end[1] + 0.3] } : { ...first, end: [first.end[0] + 0.7, first.end[1] + 0.3] };
      const reshaped = applyPlan(moved, { label: "Reshaped one curve", removeEntityIds: [], updateEntities: [nudged], addEntities: [], addConstraints: [] });
      equal(reshaped.sketch.texts, undefined, "a hand-reshaped curve ends the text object");
      equal(reshaped.sketch.entities.length, moved.sketch.entities.length, "but the curves stay");
      const removedOne = run(moved, { kind: "delete-sketch-entity", entityId: moved.sketch.entities[2]!.id });
      assert(removedOne.ok && removedOne.value.project.sketch.texts === undefined, "deleting one curve lets the text go");
      assert(removedOne.ok && removedOne.value.summary.includes("plain geometry"), "and the summary says why");
    }
  },
  {
    name: "sketch text: turning all of its curves into construction (key X) keeps the text editable and re-draws as construction",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], SPEC)));
      const text = placed.sketch.texts![0]!;
      const toggled = applyPlan(placed, { label: "Toggled construction", removeEntityIds: [], updateEntities: placed.sketch.entities.map((entity) => ({ ...entity, construction: true })), addEntities: [], addConstraints: [] });
      equal(toggled.sketch.texts?.[0]?.construction, true, "the text object follows (construction: true)");
      const edited = applyPlan(toggled, must(planSketchTextEdit(context, toggled.sketch, text.id, textSpecOf(toggled.sketch.texts![0]!))));
      assert(edited.sketch.entities.every((entity) => entity.construction), "and editing it later keeps drawing construction curves");
      const one = applyPlan(placed, { label: "Toggled one", removeEntityIds: [], updateEntities: [{ ...placed.sketch.entities[0]!, construction: true }], addEntities: [], addConstraints: [] });
      equal(one.sketch.texts, undefined, "but toggling a single curve ends the text object");
    }
  },
  {
    name: "sketch text: delete removes the curves and the object; explode keeps the curves as plain geometry",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], SPEC)));
      const text = placed.sketch.texts![0]!;
      const deleted = applyPlan(placed, must(planSketchTextDelete(placed.sketch, text.id)));
      equal(deleted.sketch.entities.length, 0, "no curves left");
      equal(deleted.sketch.texts, undefined, "and no text object");
      const exploded = applyPlan(placed, must(planSketchTextExplode(placed.sketch, text.id)));
      equal(exploded.sketch.entities.length, placed.sketch.entities.length, "explode keeps every curve");
      equal(exploded.sketch.texts, undefined, "but ends the text object");
    }
  },
  {
    name: "sketch text: records that name missing curves, unknown fonts or extra keys are refused by validation",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], SPEC)));
      const text = placed.sketch.texts![0]!;
      const attempt = (patch: Record<string, unknown>) => validateWorkbenchProject({ ...placed, sketch: { ...placed.sketch, texts: [{ ...text, ...patch }] } });
      assert(!attempt({ entityIds: [...text.entityIds, "entity:ghost"] }).ok, "a curve that does not exist");
      assert(!attempt({ font: "comic-sans" }).ok, "an unknown font");
      assert(!attempt({ extra: true }).ok, "an extra key");
      assert(!attempt({ heightMm: 0.01 }).ok, "a height under the minimum");
      assert(!attempt({ align: "justify" }).ok, "an unknown alignment");
      assert(!attempt({ text: "\u0001bad" }).ok, "control characters");
      assert(attempt({}).ok, "the unchanged record is accepted");
      const viaOperation = run(placed, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "bad", objects: { texts: [{ ...text, id: "text:other", entityIds: ["entity:ghost"] }] } });
      assert(!viaOperation.ok, "an operation that sets text on a missing curve is refused");
      const unknownKey = run(placed, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "bad", objects: { mystery: 1 } } as never);
      assert(!unknownKey.ok, "unknown object keys are refused");
    }
  },
  {
    name: "sketch text: committed sketches keep their text, reopening restores it, and a new sketch starts without it",
    run: () => {
      const placed = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], SPEC)));
      const committed = run(placed, { kind: "commit-design-sketch", featureId: "feature:sketch-text", name: "Label sketch" });
      assert(committed.ok, "the sketch commits");
      if (!committed.ok) return;
      const fresh = run(committed.value.project, { kind: "new-design-sketch", plane: "datum:xy" });
      assert(fresh.ok, "a new sketch starts");
      if (!fresh.ok) return;
      equal(fresh.value.project.sketch.texts, undefined, "the new sketch has no text object");
      equal(fresh.value.project.sketch.entities.length, 0, "and no curves");
      const reopened = run(fresh.value.project, { kind: "edit-design-sketch", featureId: "feature:sketch-text" });
      assert(reopened.ok, "the sketch reopens");
      if (!reopened.ok) return;
      equal(reopened.value.project.sketch.texts?.[0]?.text, "Rev B 12.5", "the text object is back, still editable");
    }
  },
  {
    name: "sketch text: the palette fields turn into a spec, with a blank field falling back and a bad number named",
    run: () => {
      const good = must(textSpecFromFields({ text: "Hi", height: "12", widthFactor: "", spacing: "1,5", align: "right", rotation: "30", construction: true }));
      equal(good.heightMm, 12, "height");
      equal(good.widthFactor, 1, "blank width falls back");
      equal(good.spacing, 1.5, "comma decimal");
      equal(good.align, "right", "alignment");
      equal(good.construction, true, "construction flag");
      const bad = textSpecFromFields({ text: "Hi", height: "tall", widthFactor: "1", spacing: "1", align: "left", rotation: "0", construction: false });
      assert(!bad.ok && bad.diagnostics[0]!.message.includes("height"), "an unreadable height is named");
      const construction = applyPlan(emptyProject(), must(planSketchText(context, [0, 0], { ...SPEC, construction: true })));
      assert(construction.sketch.entities.every((entity) => entity.construction), "construction text draws construction curves");
    }
  }
];
