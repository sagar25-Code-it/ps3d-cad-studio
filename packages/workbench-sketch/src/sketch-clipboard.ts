import {
  SPLINE_MAX_FIT_POINTS,
  SPLINE_MIN_FIT_POINTS,
  failure,
  MODEL_ENVELOPE,
  WORKBENCH_LIMITS,
  type SketchConstraintKind,
  type SketchEntity,
  type SketchPointRef,
  type Vec2,
  type WorkbenchResult,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../../workbench-core/src/index.js";
import { entityExtents } from "./index.js";
import { editPlan, type SketchEditContext, type SketchEditPlan, type SketchEditResult } from "./edit-tools.js";
import { cloneWithRelations, internalRelations } from "./sketch-clone.js";
import { alignParallelDirections, finishPlan } from "./edit-relations.js";

/**
 * The sketch clipboard (Ctrl+C / Ctrl+X / Ctrl+V). Copy takes the selected entities with the relations that only involve them, in plain
 * data that does not depend on the sketch it came from; paste adds fresh copies with new IDs and re-creates those relations, shifted by a
 * visible offset so the copy does not land exactly on the original. Because the data is plain JSON it works within a sketch and from one
 * sketch to another (even on a different plane), and can travel through the system clipboard as text.
 */

export const SKETCH_CLIPBOARD_FORMAT = "ps3d-sketch-clipboard/1";

export interface SketchClipboard {
  readonly format: typeof SKETCH_CLIPBOARD_FORMAT;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
  /** Where it was copied from, for the status line only. */
  readonly from: string;
  /** How many relations to entities outside the selection were left behind. */
  readonly leftBehind: number;
}

function reject<T>(message: string, recovery = "Select curves first."): WorkbenchResult<T> {
  return failure("INVALID_OPERATION", message, [], recovery);
}

/** Copies the selected entities and their internal relations. `fixed` is not carried (a pasted copy is free to move). */
export function copySketchSelection(sketch: WorkbenchSketch, ids: readonly string[], from = "the sketch"): WorkbenchResult<SketchClipboard> {
  const picked = [...new Set(ids)].map((id) => sketch.entities.find((entity) => entity.id === id));
  if (picked.length === 0 || picked.some((entity) => entity === undefined)) return reject("Select the curves to copy first.");
  const entities = picked as SketchEntity[];
  if (entities.length > 200) return reject("The clipboard holds at most 200 curves at a time.", "Copy fewer curves.");
  const selectedIds = entities.map((entity) => entity.id);
  const carried = internalRelations(sketch.constraints, selectedIds).filter((constraint) => constraint.kind !== "fixed");
  const touching = sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => selectedIds.includes(id)) && constraint.kind !== "fixed");
  return { ok: true, value: { format: SKETCH_CLIPBOARD_FORMAT, entities, constraints: carried, from, leftBehind: touching.length - carried.length } };
}

/** Copy, then delete the originals in one edit. */
export function cutSketchSelection(context: SketchEditContext, ids: readonly string[], from?: string): WorkbenchResult<{ readonly clipboard: SketchClipboard; readonly plan: SketchEditPlan }> {
  const copied = copySketchSelection(context.sketch, ids, from);
  if (!copied.ok) return copied;
  const plan = editPlan(`Cut ${copied.value.entities.length} curve${copied.value.entities.length === 1 ? "" : "s"}`, { removeEntityIds: copied.value.entities.map((entity) => entity.id) });
  return { ok: true, value: { clipboard: copied.value, plan: unwrap(plan) } };
}

function unwrap(result: SketchEditResult): SketchEditPlan {
  if (!result.ok) throw new Error("unreachable: a removal plan always succeeds");
  return result.value;
}

/** Corner-to-corner size of the clipboard's geometry. */
export function clipboardSize(clipboard: SketchClipboard): Vec2 {
  const boxes = clipboard.entities.map(entityExtents);
  const xs = boxes.flatMap((box) => [box.min[0], box.max[0]]);
  const ys = boxes.flatMap((box) => [box.min[1], box.max[1]]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** The shift for the Nth paste (1 for the first): a tenth of the copied geometry's size, between 3 and 25 mm, down and to the right. */
export function pasteOffset(clipboard: SketchClipboard, pasteNumber: number): Vec2 {
  const [width, height] = clipboardSize(clipboard);
  const step = Math.min(25, Math.max(3, Math.max(width, height) * 0.1));
  return [step * pasteNumber, -step * pasteNumber];
}

export interface PasteOptions {
  /** 1 for the first paste of this clipboard, 2 for the next, and so on; each one steps further so copies do not stack. */
  readonly pasteNumber?: number;
  /** An explicit shift, replacing the automatic one. */
  readonly offsetMm?: Vec2;
}

/** Adds copies of the clipboard's entities (new IDs) and their internal relations, shifted by the paste offset. */
export function pasteSketchClipboard(context: SketchEditContext, clipboard: SketchClipboard, options: PasteOptions = {}): SketchEditResult {
  if (clipboard.entities.length === 0) return failure("INVALID_OPERATION", "The sketch clipboard is empty.", [], "Copy or cut some curves first (Ctrl+C / Ctrl+X).");
  if (context.sketch.entities.length + clipboard.entities.length > WORKBENCH_LIMITS.maxEntities) return failure("RESOURCE_LIMIT", "Pasting would exceed the sketch's entity limit.", [], "Delete some curves first.");
  const [dx, dy] = options.offsetMm ?? pasteOffset(clipboard, options.pasteNumber ?? 1);
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  const cloned = cloneWithRelations(context, clipboard.entities, clipboard.constraints, { point: shift, rotation: (degrees) => degrees });
  const full = alignParallelDirections(cloned.entities, cloned.constraints);
  const planned = finishPlan(context, { label: `Pasted ${full.entities.length} curve${full.entities.length === 1 ? "" : "s"}`, removeEntityIds: [], updateEntities: [], addEntities: full.entities, addConstraints: full.constraints });
  if (!planned.ok) return planned;
  // Relations the solver could not hold on the copy were left out by the plan; say how many travelled.
  const kept = planned.value.addConstraints.length;
  const lost = full.constraints.length - kept;
  return editPlan(`Pasted ${full.entities.length} curve${full.entities.length === 1 ? "" : "s"}${kept === 0 ? "" : ` with ${kept} relation${kept === 1 ? "" : "s"}`}${lost > 0 ? ` (${lost} could not be carried over)` : ""}`, planned.value);
}

// ---------------------------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------------------------

export function serializeClipboard(clipboard: SketchClipboard): string {
  return JSON.stringify(clipboard);
}

const CONSTRAINT_KINDS: readonly SketchConstraintKind[] = [
  "horizontal", "vertical", "parallel", "perpendicular", "tangent", "collinear", "midpoint", "symmetry", "coincident", "concentric", "equal", "radius", "distance", "fixed",
  "angle", "arc-length", "perimeter", "smooth", "pierce", "refraction"
];
const POINT_REFS: readonly SketchPointRef[] = ["start", "end", "mid", "center", "self"];
/** The project's own coordinate limit: nothing the sketch would refuse can travel through the clipboard. */
const MAX_COORDINATE = MODEL_ENVELOPE.maxSketchCoordinateMm;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown, limit: number = MAX_COORDINATE): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const isPoint = (value: unknown): value is Vec2 => Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** A clean copy of a valid entity (known keys only), or undefined when the data is not a sketch entity. */
function cleanEntity(value: unknown): SketchEntity | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128 || typeof value.construction !== "boolean") return undefined;
  if (value.visible !== undefined && typeof value.visible !== "boolean") return undefined;
  const base = { id: value.id, construction: value.construction, ...(value.visible === undefined ? {} : { visible: value.visible as boolean }) };
  const known = (extra: readonly string[]): boolean => onlyKeys(value, ["id", "kind", "construction", "visible", ...extra]);
  switch (value.kind) {
    case "line": return known(["start", "end"]) && isPoint(value.start) && isPoint(value.end) ? { ...base, kind: "line", start: value.start, end: value.end } : undefined;
    case "arc": return known(["start", "mid", "end"]) && isPoint(value.start) && isPoint(value.mid) && isPoint(value.end) ? { ...base, kind: "arc", start: value.start, mid: value.mid, end: value.end } : undefined;
    case "circle": return known(["center", "radiusMm"]) && isPoint(value.center) && finite(value.radiusMm, MODEL_ENVELOPE.maxSketchRadiusMm) && value.radiusMm > 0 ? { ...base, kind: "circle", center: value.center, radiusMm: value.radiusMm } : undefined;
    case "point": return known(["point"]) && isPoint(value.point) ? { ...base, kind: "point", point: value.point } : undefined;
    case "rectangle":
      return known(["center", "widthMm", "heightMm", "rotationDeg"]) && isPoint(value.center) && finite(value.widthMm, MODEL_ENVELOPE.maxSketchSizeMm) && finite(value.heightMm, MODEL_ENVELOPE.maxSketchSizeMm) && value.widthMm > 0 && value.heightMm > 0 && finite(value.rotationDeg, 360)
        ? { ...base, kind: "rectangle", center: value.center, widthMm: value.widthMm, heightMm: value.heightMm, rotationDeg: value.rotationDeg } : undefined;
    case "ellipse":
      return known(["center", "majorRadiusMm", "minorRadiusMm", "rotationDeg"]) && isPoint(value.center) && finite(value.majorRadiusMm, MODEL_ENVELOPE.maxSketchRadiusMm) && finite(value.minorRadiusMm, MODEL_ENVELOPE.maxSketchRadiusMm) && value.majorRadiusMm > 0 && value.minorRadiusMm > 0 && finite(value.rotationDeg, 360)
        ? { ...base, kind: "ellipse", center: value.center, majorRadiusMm: value.majorRadiusMm, minorRadiusMm: value.minorRadiusMm, rotationDeg: value.rotationDeg } : undefined;
    case "spline":
      return known(["fitPoints"]) && Array.isArray(value.fitPoints) && value.fitPoints.length >= SPLINE_MIN_FIT_POINTS && value.fitPoints.length <= SPLINE_MAX_FIT_POINTS && value.fitPoints.every(isPoint) ? { ...base, kind: "spline", fitPoints: value.fitPoints as Vec2[] } : undefined;
    default: return undefined;
  }
}

/**
 * A clean copy of a valid relation, or undefined. Every relation kind round-trips, with its value, angle, ratio, driven flag and pierce
 * reference; a parameter expression is dropped (its parameters belong to the project it came from), keeping the number it last gave.
 */
function cleanConstraint(value: unknown, entityIds: ReadonlySet<string>): WorkbenchSketchConstraint | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return undefined;
  if (!CONSTRAINT_KINDS.includes(value.kind as SketchConstraintKind)) return undefined;
  if (!onlyKeys(value, ["id", "kind", "entityIds", "points", "valueMm", "dimension", "valueDeg", "driven", "pierce", "ratio", "expression", "suppressed"])) return undefined;
  const maxEntities = value.kind === "perimeter" ? 64 : value.kind === "symmetry" || value.kind === "refraction" ? 3 : 2;
  if (!Array.isArray(value.entityIds) || value.entityIds.length === 0 || value.entityIds.length > maxEntities || !value.entityIds.every((id) => typeof id === "string" && entityIds.has(id))) return undefined;
  if (value.points !== undefined && !(Array.isArray(value.points) && value.points.length <= 4 && value.points.every((ref) => POINT_REFS.includes(ref as SketchPointRef)))) return undefined;
  if (value.valueMm !== undefined && !finite(value.valueMm, 40_000)) return undefined;
  if (value.valueDeg !== undefined && !(finite(value.valueDeg, 360) && value.valueDeg >= 0 && value.valueDeg < 360)) return undefined;
  if (value.ratio !== undefined && !(finite(value.ratio, 20) && value.ratio >= 0.05)) return undefined;
  if (value.dimension !== undefined && !["length", "width", "height", "radius"].includes(value.dimension as string)) return undefined;
  if (value.driven !== undefined && typeof value.driven !== "boolean") return undefined;
  if (value.suppressed !== undefined && typeof value.suppressed !== "boolean") return undefined;
  if (value.expression !== undefined && typeof value.expression !== "string") return undefined;
  if (value.pierce !== undefined) {
    const pierce = value.pierce;
    const ok = isRecord(pierce) && ((pierce.kind === "axis" && typeof pierce.axisId === "string" && onlyKeys(pierce, ["kind", "axisId"])) || (pierce.kind === "body-edge" && typeof pierce.bodyId === "string" && Number.isInteger(pierce.chain) && onlyKeys(pierce, ["kind", "bodyId", "chain"])));
    if (!ok) return undefined;
  }
  const { expression: _expression, ...rest } = value;
  return rest as unknown as WorkbenchSketchConstraint;
}

/** Reads clipboard text produced by `serializeClipboard`, refusing anything that is not exactly that. */
export function parseClipboard(text: string): WorkbenchResult<SketchClipboard> {
  if (text.length > 1_000_000 || !text.trimStart().startsWith("{")) return reject("The clipboard does not hold sketch curves.", "Copy curves in a sketch first.");
  let data: unknown;
  try { data = JSON.parse(text); } catch { return reject("The clipboard does not hold sketch curves.", "Copy curves in a sketch first."); }
  if (!isRecord(data) || data.format !== SKETCH_CLIPBOARD_FORMAT || !Array.isArray(data.entities) || !Array.isArray(data.constraints)) return reject("The clipboard does not hold sketch curves.", "Copy curves in a sketch first.");
  if (data.entities.length === 0 || data.entities.length > 200 || data.constraints.length > 400) return reject("The clipboard holds too many or no curves.");
  const cleaned = data.entities.map(cleanEntity);
  if (cleaned.some((entity) => entity === undefined)) return reject("The clipboard has a curve that is not valid.");
  const entities = cleaned as SketchEntity[];
  const ids = new Set(entities.map((entity) => entity.id));
  if (ids.size !== entities.length) return reject("The clipboard repeats a curve.");
  const cleanedConstraints = data.constraints.map((constraint) => cleanConstraint(constraint, ids));
  if (cleanedConstraints.some((constraint) => constraint === undefined)) return reject("The clipboard has a relation that is not valid.");
  const from = typeof data.from === "string" ? data.from.slice(0, 80) : "the clipboard";
  const leftBehind = typeof data.leftBehind === "number" && Number.isInteger(data.leftBehind) && data.leftBehind >= 0 ? data.leftBehind : 0;
  return { ok: true, value: { format: SKETCH_CLIPBOARD_FORMAT, entities, constraints: cleanedConstraints as WorkbenchSketchConstraint[], from, leftBehind } };
}

// ---------------------------------------------------------------------------------------------
// In-memory clipboard shared by every sketch in the session
// ---------------------------------------------------------------------------------------------

let current: { readonly clipboard: SketchClipboard; pastes: number } | undefined;

/** Stores a clipboard for the session; a new copy restarts the paste offset. */
export function storeSketchClipboard(clipboard: SketchClipboard): void {
  current = { clipboard, pastes: 0 };
}

export function readSketchClipboard(): SketchClipboard | undefined {
  return current?.clipboard;
}

/** The number to give the next paste of the stored clipboard (1, 2, 3...), counting it as used. */
export function nextPasteNumber(): number {
  if (current === undefined) return 1;
  current.pastes += 1;
  return current.pastes;
}

export function clearSketchClipboard(): void {
  current = undefined;
}
