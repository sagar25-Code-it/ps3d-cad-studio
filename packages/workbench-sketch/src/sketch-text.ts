import { failure, type SketchTextObject, type Vec2, type WorkbenchResult, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";
import type { ShapeIds } from "./curve-math.js";
import { buildSketchText, DEFAULT_TEXT_LAYOUT, TEXT_MAX_CHARACTERS, textOptionProblem } from "./stroke-text.js";

/**
 * Editable sketch text. Placing text draws ordinary line and arc curves and records a text object beside them (string, font,
 * size, width, spacing, alignment, angle, anchor), so the text can be reopened later: editing it replaces the curves it
 * drew with the curves of the new settings, in one undoable step. If the curves are reshaped by hand, or some are deleted,
 * the text object is let go and the curves stay as plain geometry. Moving all the curves together keeps the text editable.
 */
export interface SketchTextSpec {
  readonly text: string;
  readonly heightMm: number;
  readonly widthFactor: number;
  readonly spacing: number;
  readonly align: "left" | "center" | "right";
  readonly rotationDeg: number;
  readonly construction: boolean;
}

export const DEFAULT_SKETCH_TEXT_SPEC: SketchTextSpec = { text: "TEXT", heightMm: 10, ...DEFAULT_TEXT_LAYOUT, construction: false };

export interface SketchTextContext {
  /** Fresh stable IDs such as `entity:user-<uuid>`. */
  readonly newId: (prefix: "entity" | "constraint") => string;
}

const reject = (message: string, ids: readonly string[] = [], recovery = "Change the text or its settings and try again."): WorkbenchResult<never> => failure("INVALID_OPERATION", message, ids, recovery);

/** The settings that drew a text object, ready to show in the palette. */
export function textSpecOf(object: SketchTextObject): SketchTextSpec {
  return { text: object.text, heightMm: object.heightMm, widthFactor: object.widthFactor, spacing: object.spacing, align: object.align, rotationDeg: object.rotationDeg, construction: object.construction };
}

/** The text object that owns a curve, if any. */
export function findTextObject(sketch: WorkbenchSketch, entityId: string): SketchTextObject | undefined {
  return (sketch.texts ?? []).find((text) => text.entityIds.includes(entityId));
}

/** Where the text of an object sits, for a quick label on the canvas. */
export function describeTextObject(object: SketchTextObject): string {
  return `"${object.text}" ${object.heightMm} mm`;
}

function shapeIds(context: SketchTextContext): ShapeIds {
  return { entity: () => context.newId("entity"), constraint: () => context.newId("constraint") };
}

function textObjectId(context: SketchTextContext): string {
  return `text:${context.newId("entity").slice("entity:".length)}`;
}

function build(context: SketchTextContext, origin: Vec2, spec: SketchTextSpec, id: string): WorkbenchResult<{ readonly object: SketchTextObject; readonly entities: SketchEditPlan["addEntities"] }> {
  if (typeof spec.text !== "string") return reject("The text must be a string.");
  const options = { heightMm: spec.heightMm, widthFactor: spec.widthFactor, spacing: spec.spacing, align: spec.align, rotationDeg: spec.rotationDeg, construction: spec.construction };
  const problem = textOptionProblem(options);
  if (problem !== undefined) return reject(problem);
  const trimmed = spec.text.replace(/\s+$/u, "");
  const built = buildSketchText(origin, trimmed, options, shapeIds(context));
  if (!built.ok) return built;
  const object: SketchTextObject = {
    id,
    text: trimmed,
    font: "stroke-1",
    heightMm: spec.heightMm,
    widthFactor: spec.widthFactor,
    spacing: spec.spacing,
    align: spec.align,
    rotationDeg: spec.rotationDeg,
    originMm: origin,
    construction: spec.construction,
    entityIds: built.value.entities.map((entity) => entity.id)
  };
  return { ok: true, value: { object, entities: built.value.entities } };
}

/** Places new editable text with its anchor at `origin`. */
export function planSketchText(context: SketchTextContext, origin: Vec2, spec: SketchTextSpec): WorkbenchResult<SketchEditPlan> {
  const made = build(context, origin, spec, textObjectId(context));
  if (!made.ok) return made;
  return {
    ok: true,
    value: {
      label: `Added text "${made.value.object.text.length > 24 ? `${made.value.object.text.slice(0, 24)}...` : made.value.object.text}"`,
      removeEntityIds: [],
      updateEntities: [],
      addEntities: made.value.entities,
      addConstraints: [],
      objects: { texts: [made.value.object] }
    }
  };
}

/** Re-draws an existing text object with new settings (and optionally a new anchor). */
export function planSketchTextEdit(context: SketchTextContext, sketch: WorkbenchSketch, textId: string, spec: SketchTextSpec, origin?: Vec2): WorkbenchResult<SketchEditPlan> {
  const existing = (sketch.texts ?? []).find((text) => text.id === textId);
  if (existing === undefined) return reject("That text is no longer editable: its curves were changed by hand.", [textId], "Place the text again.");
  const made = build(context, origin ?? existing.originMm, spec, existing.id);
  if (!made.ok) return made;
  return {
    ok: true,
    value: {
      label: `Edited text "${made.value.object.text.length > 24 ? `${made.value.object.text.slice(0, 24)}...` : made.value.object.text}"`,
      removeEntityIds: existing.entityIds.filter((id) => sketch.entities.some((entity) => entity.id === id)),
      updateEntities: [],
      addEntities: made.value.entities,
      addConstraints: [],
      objects: { texts: [made.value.object] }
    }
  };
}

/** Deletes a text object together with its curves. */
export function planSketchTextDelete(sketch: WorkbenchSketch, textId: string): WorkbenchResult<SketchEditPlan> {
  const existing = (sketch.texts ?? []).find((text) => text.id === textId);
  if (existing === undefined) return reject("There is no such text.", [textId]);
  return {
    ok: true,
    value: { label: `Deleted text "${existing.text}"`, removeEntityIds: existing.entityIds.filter((id) => sketch.entities.some((entity) => entity.id === id)), updateEntities: [], addEntities: [], addConstraints: [], objects: { removeObjectIds: [textId] } }
  };
}

/** Lets a text object go and keeps its curves as ordinary geometry (Explode). */
export function planSketchTextExplode(sketch: WorkbenchSketch, textId: string): WorkbenchResult<SketchEditPlan> {
  const existing = (sketch.texts ?? []).find((text) => text.id === textId);
  if (existing === undefined) return reject("There is no such text.", [textId]);
  return { ok: true, value: { label: `Exploded text "${existing.text}" into plain curves`, removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects: { removeObjectIds: [textId] } } };
}

/** Parses the palette's number fields into a spec; a blank or unreadable field falls back to the default, a bad number is reported. */
export function textSpecFromFields(fields: { readonly text: string; readonly height: string; readonly widthFactor: string; readonly spacing: string; readonly align: string; readonly rotation: string; readonly construction: boolean }): WorkbenchResult<SketchTextSpec> {
  const number = (label: string, text: string, fallback: number): number | string => {
    if (text.trim() === "") return fallback;
    const value = Number(text.trim().replace(",", "."));
    return Number.isFinite(value) ? value : `${label} must be a number.`;
  };
  const height = number("Text height", fields.height, DEFAULT_SKETCH_TEXT_SPEC.heightMm);
  const stretch = number("Text width", fields.widthFactor, 1);
  const spacing = number("Letter spacing", fields.spacing, 1);
  const rotation = number("Text angle", fields.rotation, 0);
  for (const value of [height, stretch, spacing, rotation]) if (typeof value === "string") return reject(value);
  const align = fields.align === "center" || fields.align === "right" ? fields.align : "left";
  if ([...fields.text].length > TEXT_MAX_CHARACTERS) return reject(`Sketch text takes at most ${TEXT_MAX_CHARACTERS} characters.`);
  return { ok: true, value: { text: fields.text, heightMm: height as number, widthFactor: stretch as number, spacing: spacing as number, align, rotationDeg: rotation as number, construction: fields.construction } };
}
