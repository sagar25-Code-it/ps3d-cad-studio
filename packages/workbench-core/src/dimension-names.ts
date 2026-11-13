import type { DesignHistory, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * Every driving dimension of a sketch has a short name (d1, d2, d3 ...) that an expression can use: type `d1 / 2` into another
 * dimension and it follows d1 from then on. The name is stored on the dimension, is unique across the sketches of a design, and
 * never changes once given, so an expression that uses it keeps working when other dimensions come and go.
 *
 * Names are given by the project, not by the caller: after an edit of the working sketch every driving dimension that has no name
 * gets the next free one. A dimension drawn before names existed is named the first time its sketch is edited; until then it works
 * exactly as it did.
 */
export const DIMENSION_NAME_PATTERN = /^d[1-9][0-9]{0,5}$/u;

const DIMENSION_KINDS: ReadonlySet<string> = new Set(["distance", "radius", "angle", "arc-length", "perimeter"]);

/** True for a dimension that holds a value (a reference dimension only measures and has no name). */
export function isDrivingDimension(constraint: WorkbenchSketchConstraint): boolean {
  return DIMENSION_KINDS.has(constraint.kind) && constraint.driven !== true && (constraint.kind === "angle" ? constraint.valueDeg !== undefined : constraint.valueMm !== undefined);
}

function numberOf(name: string | undefined): number {
  return name !== undefined && DIMENSION_NAME_PATTERN.test(name) ? Number(name.slice(1)) : 0;
}

const NAME_IN_TEXT = /(?<![A-Za-z0-9_.])d([1-9][0-9]{0,5})(?![A-Za-z0-9_])/gu;

/** The highest dimension number an expression mentions, so the name of a deleted dimension that is still referred to is never given to a new one. */
function highestMentioned(text: string | undefined): number {
  let highest = 0;
  if (text !== undefined) for (const match of text.matchAll(NAME_IN_TEXT)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** The highest dimension number in use in the design: given to a dimension, or mentioned in an expression, in the timeline or the working sketch. */
export function highestDimensionNumber(history: DesignHistory | undefined, working: WorkbenchSketch | undefined): number {
  let highest = 0;
  const read = (constraint: WorkbenchSketchConstraint): void => { highest = Math.max(highest, numberOf(constraint.name), highestMentioned(constraint.expression)); };
  for (const feature of history?.features ?? []) {
    if (feature.kind === "sketch") feature.sketch.constraints.forEach(read);
    else for (const text of Object.values(feature.expressions ?? {})) highest = Math.max(highest, highestMentioned(text));
  }
  for (const parameter of history?.parameters ?? []) highest = Math.max(highest, highestMentioned(parameter.expression));
  working?.constraints.forEach(read);
  return highest;
}

/**
 * The working sketch after an edit, with its dimension names put right: a dimension that had a name before the edit keeps it, a
 * driving dimension without one gets the next free name, and anything that is not a driving dimension carries none. Returns the same
 * object when nothing had to change.
 */
export function nameSketchDimensions(before: WorkbenchSketch, after: WorkbenchSketch, history: DesignHistory | undefined): WorkbenchSketch {
  const earlier = new Map(before.constraints.flatMap((constraint) => (constraint.name === undefined ? [] : [[constraint.id, constraint.name] as const])));
  let next = Math.max(highestDimensionNumber(history, before), highestDimensionNumber(undefined, after)) + 1;
  let changed = false;
  const taken = new Set<string>();
  const constraints = after.constraints.map((constraint): WorkbenchSketchConstraint => {
    if (!isDrivingDimension(constraint)) {
      if (constraint.name === undefined) return constraint;
      changed = true;
      const { name: _dropped, ...rest } = constraint;
      return rest;
    }
    // The name the dimension already had wins; a copy that arrives carrying another dimension's name is given its own.
    const wanted = earlier.get(constraint.id);
    let name = wanted !== undefined && !taken.has(wanted) ? wanted : undefined;
    if (name === undefined) { name = `d${next}`; next += 1; }
    taken.add(name);
    if (constraint.name === name) return constraint;
    changed = true;
    return { ...constraint, name };
  });
  return changed ? { ...after, constraints } : after;
}

/**
 * When a named dimension is deleted (or made a reference), the dimensions of the working sketch whose expression used its name
 * would be left pointing at nothing, and every later edit of the sketch would be refused for it. They are unbound instead: each
 * keeps the value it has and becomes a plain number. A name that is a user parameter is left alone (parameters come first).
 */
export function unbindLostDimensionNames(history: DesignHistory | undefined, working: WorkbenchSketch): { readonly sketch: WorkbenchSketch; readonly unbound: readonly string[] } {
  if (!working.constraints.some((constraint) => constraint.expression !== undefined)) return { sketch: working, unbound: [] };
  const known = new Set<string>((history?.parameters ?? []).map((parameter) => parameter.name));
  const collect = (constraint: WorkbenchSketchConstraint): void => { if (constraint.name !== undefined && isDrivingDimension(constraint)) known.add(constraint.name); };
  for (const feature of history?.features ?? []) if (feature.kind === "sketch") feature.sketch.constraints.forEach(collect);
  working.constraints.forEach(collect);
  const unbound: string[] = [];
  const constraints = working.constraints.map((constraint): WorkbenchSketchConstraint => {
    if (constraint.expression === undefined) return constraint;
    const lost = [...constraint.expression.matchAll(NAME_IN_TEXT)].some((match) => !known.has(`d${match[1]}`));
    if (!lost) return constraint;
    unbound.push(constraint.name ?? constraint.id);
    const { expression: _expression, ...rest } = constraint;
    return rest;
  });
  return unbound.length === 0 ? { sketch: working, unbound } : { sketch: { ...working, constraints }, unbound };
}

/** The dimension a name stands for: the working sketch's first, then the timeline's sketches from the newest back. */
export function dimensionNamed(history: DesignHistory | undefined, working: WorkbenchSketch | undefined, name: string): WorkbenchSketchConstraint | undefined {
  const inWorking = working?.constraints.find((constraint) => constraint.name === name && isDrivingDimension(constraint));
  if (inWorking !== undefined) return inWorking;
  const features = history?.features ?? [];
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]!;
    if (feature.kind !== "sketch") continue;
    const found = feature.sketch.constraints.find((constraint) => constraint.name === name && isDrivingDimension(constraint));
    if (found !== undefined) return found;
  }
  return undefined;
}
