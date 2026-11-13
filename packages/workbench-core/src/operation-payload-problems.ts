import { CONSTRAINT_KINDS } from "./validation.js";
import { isSketchDatumEntityId, SKETCH_POINT_REFS } from "./types.js";
import { SKETCH_PATTERN_MAX_INSTANCES, SKETCH_TEXT_FONTS, SKETCH_TEXT_MAX_CHARACTERS, SKETCH_TEXT_MAX_ENTITIES } from "./sketch-objects.js";
import { ENVELOPE_LIMITS } from "./envelope-limits.js";

/**
 * Names the field that is wrong in a payload that failed its shape check. The validators answer yes or no; these answer "which object,
 * which field, what was expected", so a person or an agent can correct the call. They only run after a payload has been refused (or,
 * for a relation, before anything is read from it), never on the success path of a valid payload.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStableId = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
const isFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hasControlCharacter = (text: string): boolean => /[\u0000-\u001f\u007f]/u.test(text);

/** A short, safe rendering of a wrong value for a message: `"abc"`, `12`, `null`, `a list`, `an object`. */
export function describeGivenValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "a number that is not finite";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `a list of ${value.length}`;
  return "an object";
}

type FieldRule = readonly [field: string, test: (value: unknown) => boolean, expected: string];

const range = (minimum: number, maximum: number) => (value: unknown): boolean => isFinite(value) && value >= minimum && value <= maximum;
const wholeRange = (minimum: number, maximum: number) => (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const point = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every((part) => range(-ENVELOPE_LIMITS.maxSketchCoordinateMm, ENVELOPE_LIMITS.maxSketchCoordinateMm)(part));
const idList = (minimum: number, maximum: number) => (value: unknown): boolean => Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every(isStableId) && new Set(value).size === value.length;

function checkRules(label: string, value: Record<string, unknown>, rules: readonly FieldRule[]): string | undefined {
  for (const [field, test, expected] of rules) {
    if (!Object.hasOwn(value, field)) return `${label} is missing its ${field} (${expected}).`;
    if (!test(value[field])) return `${label}: ${field} must be ${expected}, but it is ${describeGivenValue(value[field])}.`;
  }
  const known = new Set(rules.map(([field]) => field));
  const extra = Object.keys(value).find((key) => !known.has(key));
  if (extra !== undefined) return `${label} has a field "${extra}" that it does not take (it takes ${[...known].join(", ")}).`;
  return undefined;
}

const nameOf = (what: string, value: unknown, index: number): string => (isRecord(value) && typeof value.id === "string" && value.id !== "" ? `${what} "${value.id.slice(0, 60)}"` : `${what} number ${index + 1}`);

const TEXT_RULES: readonly FieldRule[] = [
  ["id", (value) => isStableId(value) && value.startsWith("text:"), 'an id that starts with "text:", like "text:label-1"'],
  ["text", (value) => typeof value === "string" && value.trim().length >= 1 && value.length <= SKETCH_TEXT_MAX_CHARACTERS && !hasControlCharacter(value), `1 to ${SKETCH_TEXT_MAX_CHARACTERS} characters of text without control characters`],
  ["font", (value) => (SKETCH_TEXT_FONTS as readonly unknown[]).includes(value), `one of ${SKETCH_TEXT_FONTS.map((font) => `"${font}"`).join(", ")}`],
  ["heightMm", range(0.5, 1000), "a number from 0.5 to 1000 mm"],
  ["widthFactor", range(0.2, 5), "a number from 0.2 to 5"],
  ["spacing", range(0, 10), "a number from 0 to 10"],
  ["align", (value) => value === "left" || value === "center" || value === "right", '"left", "center" or "right"'],
  ["rotationDeg", range(-360, 360), "a number from -360 to 360 degrees"],
  ["originMm", point, "a point [x, y] within the sketch limits"],
  ["construction", isBoolean, "true or false"],
  ["entityIds", idList(1, SKETCH_TEXT_MAX_ENTITIES), `a list of 1 to ${SKETCH_TEXT_MAX_ENTITIES} different curve ids`]
];

const PATTERN_RULES: readonly FieldRule[] = [
  ["id", (value) => isStableId(value) && value.startsWith("pattern:"), 'an id that starts with "pattern:", like "pattern:holes"'],
  ["spec", isRecord, "an object with the pattern's kind and layout"],
  ["sourceIds", idList(1, 100), "a list of 1 to 100 different curve ids to repeat"],
  ["suppressed", (value) => Array.isArray(value) && value.length <= SKETCH_PATTERN_MAX_INSTANCES && value.every(wholeRange(1, SKETCH_PATTERN_MAX_INSTANCES)) && new Set(value).size === value.length, `a list of different instance numbers from 1 to ${SKETCH_PATTERN_MAX_INSTANCES}`]
];

const SPEC_RULES: Readonly<Record<string, readonly FieldRule[]>> = {
  rectangular: [
    ["kind", (value) => value === "rectangular", '"rectangular"'],
    ["countX", wholeRange(1, SKETCH_PATTERN_MAX_INSTANCES), `a whole number from 1 to ${SKETCH_PATTERN_MAX_INSTANCES}`],
    ["countY", wholeRange(1, SKETCH_PATTERN_MAX_INSTANCES), `a whole number from 1 to ${SKETCH_PATTERN_MAX_INSTANCES}`],
    ["dxMm", range(-100_000, 100_000), "a number from -100000 to 100000 mm"],
    ["dyMm", range(-100_000, 100_000), "a number from -100000 to 100000 mm"],
    ["angleDeg", range(-360, 360), "a number from -360 to 360 degrees"],
    ["extent", isBoolean, "true or false"]
  ],
  circular: [
    ["kind", (value) => value === "circular", '"circular"'],
    ["count", wholeRange(2, SKETCH_PATTERN_MAX_INSTANCES), `a whole number from 2 to ${SKETCH_PATTERN_MAX_INSTANCES}`],
    ["angleDeg", range(-360, 360), "a number from -360 to 360 degrees"],
    ["center", point, "a point [x, y] within the sketch limits"],
    ["rotate", isBoolean, "true or false"]
  ],
  path: [
    ["kind", (value) => value === "path", '"path"'],
    ["pathEntityId", isStableId, "the id of the curve the instances follow"],
    ["count", wholeRange(2, SKETCH_PATTERN_MAX_INSTANCES), `a whole number from 2 to ${SKETCH_PATTERN_MAX_INSTANCES}`],
    ["spacingMm", range(0, 100_000), "a number from 0 to 100000 mm"],
    ["fit", isBoolean, "true or false"],
    ["startMm", range(0, 100_000), "a number from 0 to 100000 mm"],
    ["follow", isBoolean, "true or false"]
  ]
};

const UNDERLAY_RULES: readonly FieldRule[] = [
  ["name", (value) => typeof value === "string" && value.length >= 1 && value.length <= 120 && !hasControlCharacter(value), "1 to 120 characters of text"],
  ["imageId", (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{3,63}$/u.test(value), "4 to 64 lowercase letters, digits or hyphens"],
  ["widthPx", wholeRange(1, 16_384), "a whole number of pixels from 1 to 16384"],
  ["heightPx", wholeRange(1, 16_384), "a whole number of pixels from 1 to 16384"],
  ["originMm", (value) => Array.isArray(value) && value.length === 2 && value.every(range(-100_000, 100_000)), "a point [x, y] within 100000 mm"],
  ["mmPerPixel", range(1e-4, 1_000), "a number from 0.0001 to 1000"],
  ["rotationDeg", range(-360, 360), "a number from -360 to 360 degrees"],
  ["opacity", range(0.05, 1), "a number from 0.05 to 1"],
  ["locked", isBoolean, "true or false"],
  ["visible", isBoolean, "true or false"]
];

/** What is wrong in the `objects` part of an `apply-sketch-edit` (text, pattern and underlay records), or undefined when nothing is. */
export function sketchObjectsProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return `The sketch edit's objects must be an object with texts, patterns, removeObjectIds and underlay, but it is ${describeGivenValue(value)}.`;
  const unknown = Object.keys(value).find((key) => !["texts", "patterns", "removeObjectIds", "underlay"].includes(key));
  if (unknown !== undefined) return `The sketch edit's objects have a field "${unknown}" that is not one of texts, patterns, removeObjectIds and underlay.`;
  if (Object.hasOwn(value, "texts")) {
    const texts = value.texts;
    if (!Array.isArray(texts)) return `The sketch edit's texts must be a list of text objects, but it is ${describeGivenValue(texts)}.`;
    if (texts.length > 50) return `One sketch edit can carry at most 50 text objects; this one has ${texts.length}.`;
    for (let index = 0; index < texts.length; index += 1) {
      const entry: unknown = texts[index];
      const label = nameOf("Text object", entry, index);
      if (!isRecord(entry)) return `${label} must be an object, but it is ${describeGivenValue(entry)}.`;
      const problem = checkRules(label, entry, TEXT_RULES);
      if (problem !== undefined) return problem;
    }
  }
  if (Object.hasOwn(value, "patterns")) {
    const patterns = value.patterns;
    if (!Array.isArray(patterns)) return `The sketch edit's patterns must be a list of pattern objects, but it is ${describeGivenValue(patterns)}.`;
    if (patterns.length > 50) return `One sketch edit can carry at most 50 pattern objects; this one has ${patterns.length}.`;
    for (let index = 0; index < patterns.length; index += 1) {
      const entry: unknown = patterns[index];
      const label = nameOf("Pattern object", entry, index);
      if (!isRecord(entry)) return `${label} must be an object, but it is ${describeGivenValue(entry)}.`;
      const problem = checkRules(label, entry, PATTERN_RULES);
      if (problem !== undefined) return problem;
      const spec = entry.spec as Record<string, unknown>;
      const rules = typeof spec.kind === "string" && Object.hasOwn(SPEC_RULES, spec.kind) ? SPEC_RULES[spec.kind] : undefined;
      if (rules === undefined) return `${label}: spec.kind must be "rectangular", "circular" or "path", but it is ${describeGivenValue(spec.kind)}.`;
      const specProblem = checkRules(`${label}, ${spec.kind} layout`, spec, rules);
      if (specProblem !== undefined) return specProblem;
      if (spec.kind === "rectangular" && (spec.countX as number) * (spec.countY as number) < 2) return `${label}, rectangular layout: countX times countY must make at least 2 instances.`;
      if (spec.kind === "rectangular" && (spec.countX as number) * (spec.countY as number) > SKETCH_PATTERN_MAX_INSTANCES) return `${label}, rectangular layout: countX times countY is ${(spec.countX as number) * (spec.countY as number)}, and a pattern holds at most ${SKETCH_PATTERN_MAX_INSTANCES} instances.`;
    }
  }
  if (Object.hasOwn(value, "removeObjectIds")) {
    const ids = value.removeObjectIds;
    if (!Array.isArray(ids) || ids.length > 100) return `The sketch edit's removeObjectIds must be a list of at most 100 object ids, but it is ${describeGivenValue(ids)}.`;
    const bad = ids.findIndex((id) => !isStableId(id));
    if (bad >= 0) return `removeObjectIds entry ${bad + 1} must be an object id like "text:label-1" or "pattern:holes", but it is ${describeGivenValue(ids[bad])}.`;
  }
  if (Object.hasOwn(value, "underlay") && value.underlay !== null) {
    const underlay = value.underlay;
    if (!isRecord(underlay)) return `The sketch edit's underlay must be an underlay object or null, but it is ${describeGivenValue(underlay)}.`;
    const problem = checkRules(`Underlay${typeof underlay.name === "string" && underlay.name !== "" ? ` "${underlay.name.slice(0, 60)}"` : ""}`, underlay, UNDERLAY_RULES);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

const DIMENSION_NAMES = ["length", "width", "height", "radius", "diameter", "aligned", "horizontal", "vertical", "point-line", "line-line", "offset", "major-radius", "minor-radius"];

/**
 * What is wrong in the shape of one sketch relation or dimension, or undefined when it is well formed. It looks only at the record
 * (types, lists, names); whether the ids exist in the sketch and whether the relation makes sense for them is decided later, with the sketch.
 */
export function constraintPayloadProblem(value: unknown, index?: number): string | undefined {
  const label = index === undefined ? "The relation" : `Relation number ${index + 1}`;
  if (!isRecord(value)) return `${label} must be an object with an id, a kind and entityIds, but it is ${describeGivenValue(value)}.`;
  const named = typeof value.id === "string" && value.id !== "" ? `${label} "${value.id.slice(0, 60)}"` : label;
  if (!Object.hasOwn(value, "id") || value.id === undefined) return `${label} has no id (give it a stable id like "constraint:k1").`;
  if (!isStableId(value.id)) return `${label}: id must be a stable id like "constraint:k1", but it is ${describeGivenValue(value.id)}.`;
  if (!Object.hasOwn(value, "kind") || value.kind === undefined) return `${named} has no kind (one of ${CONSTRAINT_KINDS.join(", ")}).`;
  if (typeof value.kind !== "string" || !CONSTRAINT_KINDS.includes(value.kind)) return `${named}: kind must be one of ${CONSTRAINT_KINDS.join(", ")}, but it is ${describeGivenValue(value.kind)}.`;
  const maximum = value.kind === "perimeter" ? 64 : value.kind === "symmetry" || value.kind === "refraction" ? 3 : 2;
  if (!Object.hasOwn(value, "entityIds") || value.entityIds === undefined) return `${named} has no entityIds (a list of 1 to ${maximum} curve ids it relates).`;
  if (!Array.isArray(value.entityIds)) return `${named}: entityIds must be a list of 1 to ${maximum} curve ids, but it is ${describeGivenValue(value.entityIds)}.`;
  if (value.entityIds.length < 1 || value.entityIds.length > maximum) return `${named}: a ${value.kind} relation takes 1 to ${maximum} curve ids, but entityIds lists ${value.entityIds.length}.`;
  const badId = value.entityIds.findIndex((id) => typeof id !== "string" || !(isStableId(id) || isSketchDatumEntityId(id)));
  if (badId >= 0) return `${named}: entityIds entry ${badId + 1} must be a curve id like "entity:l1", but it is ${describeGivenValue(value.entityIds[badId])}.`;
  if (Object.hasOwn(value, "points")) {
    const points = value.points;
    if (!Array.isArray(points)) return `${named}: points must be a list of point names (${SKETCH_POINT_REFS.join(", ")}), but it is ${describeGivenValue(points)}.`;
    if (points.length < 1 || points.length > value.entityIds.length) return `${named}: points must name one point for each of its ${value.entityIds.length} curves at most, but it lists ${points.length}.`;
    const badPoint = points.findIndex((entry) => !(SKETCH_POINT_REFS as readonly unknown[]).includes(entry));
    if (badPoint >= 0) return `${named}: points entry ${badPoint + 1} must be one of ${SKETCH_POINT_REFS.join(", ")}, but it is ${describeGivenValue(points[badPoint])}.`;
  }
  for (const field of ["valueMm", "valueDeg", "ratio", "labelOffsetPx"] as const) {
    if (Object.hasOwn(value, field) && !isFinite(value[field])) return `${named}: ${field} must be a finite number, but it is ${describeGivenValue(value[field])}.`;
  }
  if (Object.hasOwn(value, "dimension") && !(typeof value.dimension === "string" && DIMENSION_NAMES.includes(value.dimension))) return `${named}: dimension must be one of ${DIMENSION_NAMES.join(", ")}, but it is ${describeGivenValue(value.dimension)}.`;
  for (const field of ["driven", "suppressed", "doubled", "inside"] as const) {
    if (Object.hasOwn(value, field) && typeof value[field] !== "boolean") return `${named}: ${field} must be true or false, but it is ${describeGivenValue(value[field])}.`;
  }
  if (Object.hasOwn(value, "expression") && typeof value.expression !== "string") return `${named}: expression must be text, but it is ${describeGivenValue(value.expression)}.`;
  if (Object.hasOwn(value, "offsetGroup") && typeof value.offsetGroup !== "string") return `${named}: offsetGroup must be an id like "offset:a1", but it is ${describeGivenValue(value.offsetGroup)}.`;
  if (Object.hasOwn(value, "pierce") && !isRecord(value.pierce)) return `${named}: pierce must be an object, but it is ${describeGivenValue(value.pierce)}.`;
  return undefined;
}

/** What is wrong in a `set-design-parameters` payload: names the parameter and the field. */
export function parameterTableProblem(input: Record<string, unknown>): string | undefined {
  const parameters = input.parameters;
  if (!Array.isArray(parameters)) return `The parameter table must be a list of parameters, but it is ${describeGivenValue(parameters)}.`;
  if (parameters.length > 200) return `The parameter table holds at most 200 parameters; this one has ${parameters.length}.`;
  for (let index = 0; index < parameters.length; index += 1) {
    const entry: unknown = parameters[index];
    const label = nameOf("Parameter", isRecord(entry) && typeof entry.name === "string" ? { id: entry.name } : entry, index);
    if (!isRecord(entry)) return `${label} must be an object with a name, an expression, a unit and a comment, but it is ${describeGivenValue(entry)}.`;
    const problem = checkRules(label, entry, [
      ["name", (name) => typeof name === "string", "text"],
      ["expression", (expression) => typeof expression === "string", "text, like \"25 mm\""],
      ["unit", (unit) => unit === "mm" || unit === "deg" || unit === "", 'one of "mm", "deg" or "" (no unit)'],
      ["comment", (comment) => typeof comment === "string", 'text (use "" for no comment)']
    ]);
    if (problem !== undefined) return problem;
  }
  if (Object.hasOwn(input, "renames")) {
    const renames = input.renames;
    if (!Array.isArray(renames)) return `The parameter renames must be a list of { from, to } pairs, but it is ${describeGivenValue(renames)}.`;
    if (renames.length > 200) return `At most 200 parameters can be renamed at once; this call renames ${renames.length}.`;
    for (let index = 0; index < renames.length; index += 1) {
      const entry: unknown = renames[index];
      if (!isRecord(entry)) return `Rename number ${index + 1} must be an object with from and to, but it is ${describeGivenValue(entry)}.`;
      const problem = checkRules(`Rename number ${index + 1}`, entry, [["from", (name) => typeof name === "string", "text"], ["to", (name) => typeof name === "string", "text"]]);
      if (problem !== undefined) return problem;
    }
  }
  const extra = Object.keys(input).find((key) => !["operationId", "expectedRevision", "kind", "parameters", "renames"].includes(key));
  if (extra !== undefined) return `The parameter table call has a field "${extra}" that it does not take (it takes parameters and renames).`;
  return undefined;
}
