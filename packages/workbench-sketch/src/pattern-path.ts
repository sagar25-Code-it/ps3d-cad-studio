import {
  failure,
  generateSketchPatternEntities,
  sketchPathPolyline,
  sketchPatternInstanceCount,
  sketchPatternInstanceOf,
  SKETCH_PATTERN_MAX_INSTANCES,
  validSketchPatternObject,
  type SketchPatternObject,
  type SketchPatternSpec,
  type WorkbenchResult,
  type WorkbenchSketch
} from "../../workbench-core/src/index.js";
import type { SketchEditContext, SketchEditPlan } from "./edit-tools.js";
import { formatLengthField, parseLengthField, parseNumberField } from "./edit-fields.js";
import type { SketchLengthUnit } from "./sketch-units.js";

/**
 * Associative sketch patterns. A pattern object keeps its source curves and its layout (rectangular grid at any angle,
 * circular, or along a picked line, arc, circle, ellipse, rectangle or spline); the instance curves are made by the
 * operation layer and re-made whenever the source or the layout changes, so editing the source curve, the count or the
 * spacing updates every copy. Single instances can be suppressed. The planners here return ordinary `apply-sketch-edit` plans.
 */

const MAX_ENTITIES = 500;

const reject = (message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the values and try again."): WorkbenchResult<never> => failure("INVALID_OPERATION", message, ids, recovery);

/** The pattern a curve belongs to: as a source (instance 0) or as a copy. */
export function findPatternOf(sketch: WorkbenchSketch, entityId: string): { readonly pattern: SketchPatternObject; readonly instance: number } | undefined {
  for (const pattern of sketch.patterns ?? []) {
    if (pattern.sourceIds.includes(entityId)) return { pattern, instance: 0 };
    const instance = sketchPatternInstanceOf(pattern.id, entityId);
    if (instance !== undefined) return { pattern, instance };
  }
  return undefined;
}

/** A short description of a layout for lists and the status line. */
export function describePatternSpec(spec: SketchPatternSpec): string {
  if (spec.kind === "rectangular") {
    const step = spec.extent ? "over" : "every";
    const angle = Math.abs(spec.angleDeg) > 1e-9 ? ` at ${format(spec.angleDeg)}°` : "";
    return `Rectangular ${spec.countX} × ${spec.countY}, ${step} ${format(spec.dxMm)} × ${format(spec.dyMm)} mm${angle}`;
  }
  if (spec.kind === "circular") return `Circular ${spec.count} over ${format(spec.angleDeg)}° about (${format(spec.center[0])}, ${format(spec.center[1])})${spec.rotate ? "" : ", not rotated"}`;
  return `Path ${spec.count}, ${spec.fit ? "fitted to the path" : `every ${format(spec.spacingMm)} mm`}${spec.follow ? ", following the path" : ""}`;
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The IDs of the copies of a pattern that exist in the sketch, grouped by instance number. */
export function patternInstances(sketch: WorkbenchSketch, pattern: SketchPatternObject): ReadonlyMap<number, readonly string[]> {
  const groups = new Map<number, string[]>();
  for (const entity of sketch.entities) {
    const instance = sketchPatternInstanceOf(pattern.id, entity.id);
    if (instance === undefined) continue;
    groups.set(instance, [...(groups.get(instance) ?? []), entity.id]);
  }
  return groups;
}

function checkSpec(sketch: WorkbenchSketch, pattern: SketchPatternObject): WorkbenchResult<number> {
  const generated = generateSketchPatternEntities(pattern, sketch.entities);
  if (!generated.ok) return reject(generated.message, pattern.sourceIds);
  const existing = sketch.entities.filter((entity) => sketchPatternInstanceOf(pattern.id, entity.id) !== undefined).length;
  const total = sketch.entities.length - existing + generated.entities.length;
  if (total > MAX_ENTITIES) return reject(`This pattern would make the sketch ${total} curves (${generated.entities.length} copies); the limit is ${MAX_ENTITIES}. Use fewer instances or fewer source curves.`, pattern.sourceIds, "Reduce the count, or pattern fewer curves.");
  if (!validSketchPatternObject(pattern as unknown)) return reject("A pattern value is out of range (counts are whole numbers, spacings and angles stay within +-100000 mm / +-360 degrees, centres within +-10000 mm).", pattern.sourceIds);
  return { ok: true, value: generated.entities.length };
}

/** A new associative pattern of `sourceIds`. The sources stay where they are as the first instance. */
export function planPattern(context: SketchEditContext, sourceIds: readonly string[], spec: SketchPatternSpec): WorkbenchResult<SketchEditPlan> {
  const sketch = context.sketch;
  if (sourceIds.length === 0) return reject("Select the curves to pattern.");
  if (sourceIds.length > 100) return reject("A pattern repeats at most 100 curves.");
  const sources = sourceIds.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (sources.some((entity) => entity === undefined)) return reject("A selected curve no longer exists.");
  const owner = sourceIds.map((id) => findPatternOf(sketch, id)).find((found) => found !== undefined);
  if (owner !== undefined) return reject(owner.instance === 0 ? "A curve that is already the source of a pattern cannot be patterned again." : "A pattern copy cannot be patterned; pattern the source curves instead.", sourceIds, "Select the original curves.");
  if (spec.kind === "path" && sourceIds.includes(spec.pathEntityId)) return reject("The path of a path pattern cannot also be one of the curves it repeats.", [spec.pathEntityId], "Pick a different path curve.");
  const idText = context.newId("entity").slice("entity:".length);
  const pattern: SketchPatternObject = { id: `pattern:${idText}`, spec, sourceIds, suppressed: [] };
  const checked = checkSpec(sketch, pattern);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      label: `${describePatternSpec(spec)} pattern of ${sourceIds.length} curve${sourceIds.length === 1 ? "" : "s"} (${checked.value} copies)`.slice(0, 80),
      removeEntityIds: [],
      updateEntities: [],
      addEntities: [],
      addConstraints: [],
      objects: { patterns: [pattern] }
    }
  };
}

function patternById(sketch: WorkbenchSketch, patternId: string): SketchPatternObject | undefined {
  return (sketch.patterns ?? []).find((pattern) => pattern.id === patternId);
}

/** Changes the layout of an existing pattern; the copies are re-made, the ones that still exist keep their IDs. */
export function planPatternEdit(sketch: WorkbenchSketch, patternId: string, spec: SketchPatternSpec): WorkbenchResult<SketchEditPlan> {
  const pattern = patternById(sketch, patternId);
  if (pattern === undefined) return reject("That pattern no longer exists.", [patternId]);
  if (spec.kind === "path" && pattern.sourceIds.includes(spec.pathEntityId)) return reject("The path of a path pattern cannot also be one of the curves it repeats.", [spec.pathEntityId], "Pick a different path curve.");
  const count = sketchPatternInstanceCount(spec);
  // Keep switches that still make sense for the new count.
  const suppressed = pattern.suppressed.filter((instance) => instance < count);
  const next: SketchPatternObject = { ...pattern, spec, suppressed };
  const checked = checkSpec(sketch, next);
  if (!checked.ok) return checked;
  return { ok: true, value: { label: `Changed pattern: ${describePatternSpec(spec)}`.slice(0, 80), removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects: { patterns: [next] } } };
}

/** Switches single instances (1 and up; 0 is the source) of a pattern off or on. */
export function planPatternSuppress(sketch: WorkbenchSketch, patternId: string, instances: readonly number[], suppress: boolean): WorkbenchResult<SketchEditPlan> {
  const pattern = patternById(sketch, patternId);
  if (pattern === undefined) return reject("That pattern no longer exists.", [patternId]);
  const count = sketchPatternInstanceCount(pattern.spec);
  if (instances.length === 0 || instances.some((instance) => !Number.isInteger(instance) || instance < 1 || instance >= count)) return reject(`Pick instances from 1 to ${count - 1}. The source (instance 0) cannot be suppressed.`, [patternId]);
  const set = new Set(pattern.suppressed);
  for (const instance of instances) { if (suppress) set.add(instance); else set.delete(instance); }
  const next: SketchPatternObject = { ...pattern, suppressed: [...set].sort((a, b) => a - b) };
  const checked = checkSpec(sketch, next);
  if (!checked.ok) return checked;
  return { ok: true, value: { label: `${suppress ? "Suppressed" : "Restored"} pattern instance${instances.length === 1 ? "" : "s"} ${instances.join(", ")}`.slice(0, 80), removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects: { patterns: [next] } } };
}

/** Lets the pattern go: the copies that exist stay as ordinary curves. */
export function planPatternDissolve(sketch: WorkbenchSketch, patternId: string): WorkbenchResult<SketchEditPlan> {
  const pattern = patternById(sketch, patternId);
  if (pattern === undefined) return reject("That pattern no longer exists.", [patternId]);
  return { ok: true, value: { label: "Made the pattern copies plain curves", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects: { removeObjectIds: [patternId] } } };
}

/** Deletes a pattern together with all its copies (the sources stay). */
export function planPatternRemoveCopies(sketch: WorkbenchSketch, patternId: string): WorkbenchResult<SketchEditPlan> {
  const pattern = patternById(sketch, patternId);
  if (pattern === undefined) return reject("That pattern no longer exists.", [patternId]);
  const copies = [...patternInstances(sketch, pattern).values()].flat();
  return { ok: true, value: { label: "Removed the pattern and its copies", removeEntityIds: copies, updateEntities: [], addEntities: [], addConstraints: [], objects: { removeObjectIds: [patternId] } } };
}

/** The length of a path curve in millimetres, for the palette's hints (undefined when the curve cannot be a path). */
export function patternPathLengthMm(sketch: WorkbenchSketch, pathEntityId: string): number | undefined {
  const entity = sketch.entities.find((candidate) => candidate.id === pathEntityId);
  return entity === undefined ? undefined : sketchPathPolyline(entity)?.totalMm;
}

export interface PatternFields {
  readonly kind: "rectangular" | "circular" | "path";
  readonly countX: string;
  readonly countY: string;
  readonly dx: string;
  readonly dy: string;
  readonly angle: string;
  readonly extent: boolean;
  readonly count: string;
  readonly totalAngle: string;
  readonly centerX: string;
  readonly centerY: string;
  readonly rotate: boolean;
  readonly pathEntityId: string;
  readonly spacing: string;
  readonly fit: boolean;
  readonly start: string;
  readonly follow: boolean;
}

export const DEFAULT_PATTERN_FIELDS: PatternFields = {
  kind: "rectangular", countX: "3", countY: "1", dx: "10", dy: "10", angle: "0", extent: false,
  count: "6", totalAngle: "360", centerX: "0", centerY: "0", rotate: true,
  pathEntityId: "", spacing: "10", fit: false, start: "0", follow: true
};

/**
 * Turns the palette's text fields into a pattern layout; the first unreadable number is named. Lengths (spacings, the centre, the start
 * distance) are typed in `unit` (default millimetres): a bare number is in it, `10mm` or `0.5 in` says its own, and `12,5` and `1,000.5` read.
 */
export function patternSpecFromFields(fields: PatternFields, unit: SketchLengthUnit = "mm"): WorkbenchResult<SketchPatternSpec> {
  type Entry = readonly [label: string, text: string, kind?: "length"];
  const read = ([label, text, kind]: Entry): number | string => {
    const value = kind === "length" ? parseLengthField(text, unit) : parseNumberField(text);
    return Number.isFinite(value) ? value : `${label} must be a ${kind === "length" ? "length" : "number"}.`;
  };
  const numbers = (entries: readonly Entry[]): readonly number[] | string => {
    const values: number[] = [];
    for (const entry of entries) {
      const value = read(entry);
      if (typeof value === "string") return value;
      values.push(value);
    }
    return values;
  };
  if (fields.kind === "rectangular") {
    const values = numbers([["Count along the first direction", fields.countX], ["Count along the second direction", fields.countY], ["Spacing in the first direction", fields.dx, "length"], ["Spacing in the second direction", fields.dy, "length"], ["Angle", fields.angle]]);
    if (typeof values === "string") return reject(values);
    return { ok: true, value: { kind: "rectangular", countX: Math.round(values[0]!), countY: Math.round(values[1]!), dxMm: values[2]!, dyMm: values[3]!, angleDeg: values[4]!, extent: fields.extent } };
  }
  if (fields.kind === "circular") {
    const values = numbers([["Count", fields.count], ["Total angle", fields.totalAngle], ["Centre X", fields.centerX, "length"], ["Centre Y", fields.centerY, "length"]]);
    if (typeof values === "string") return reject(values);
    return { ok: true, value: { kind: "circular", count: Math.round(values[0]!), angleDeg: values[1]!, center: [values[2]!, values[3]!], rotate: fields.rotate } };
  }
  const values = numbers([["Count", fields.count], ["Spacing", fields.spacing, "length"], ["Start distance", fields.start, "length"]]);
  if (typeof values === "string") return reject(values);
  if (fields.pathEntityId === "") return reject("Pick the path curve first.", [], "Select the curves to repeat, then the path curve last, and press Apply.");
  return { ok: true, value: { kind: "path", pathEntityId: fields.pathEntityId, count: Math.round(values[0]!), spacingMm: values[1]!, fit: fields.fit, startMm: values[2]!, follow: fields.follow } };
}

/** The default palette fields with their lengths written in `unit` (the millimetre defaults of an inch document are fractions of an inch). */
export function defaultPatternFields(unit: SketchLengthUnit = "mm"): PatternFields {
  if (unit === "mm") return DEFAULT_PATTERN_FIELDS;
  const length = (text: string): string => formatLengthField(Number(text), unit);
  const d = DEFAULT_PATTERN_FIELDS;
  return { ...d, dx: length(d.dx), dy: length(d.dy), centerX: length(d.centerX), centerY: length(d.centerY), spacing: length(d.spacing), start: length(d.start) };
}

/** Fills the palette fields from a stored layout so it can be edited; lengths are written in `unit`. */
export function patternFieldsFromSpec(spec: SketchPatternSpec, unit: SketchLengthUnit = "mm"): PatternFields {
  const text = (value: number): string => String(Math.round(value * 1e6) / 1e6);
  const length = (valueMm: number): string => (unit === "mm" ? text(valueMm) : formatLengthField(valueMm, unit));
  const base = defaultPatternFields(unit);
  if (spec.kind === "rectangular") return { ...base, kind: "rectangular", countX: String(spec.countX), countY: String(spec.countY), dx: length(spec.dxMm), dy: length(spec.dyMm), angle: text(spec.angleDeg), extent: spec.extent };
  if (spec.kind === "circular") return { ...base, kind: "circular", count: String(spec.count), totalAngle: text(spec.angleDeg), centerX: length(spec.center[0]), centerY: length(spec.center[1]), rotate: spec.rotate };
  return { ...base, kind: "path", pathEntityId: spec.pathEntityId, count: String(spec.count), spacing: length(spec.spacingMm), fit: spec.fit, start: length(spec.startMm), follow: spec.follow };
}

export { SKETCH_PATTERN_MAX_INSTANCES };
