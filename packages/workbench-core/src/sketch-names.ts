import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * Friendly names for sketch geometry. Entity and constraint IDs are machine strings ("entity:user-3f9a...-..."); an engineer
 * works with "Line 3", "Circle 2" and "Arc 1". The names are derived, not stored: every kind is numbered in the order its curves
 * appear in the sketch, so the model browser, the status line, tooltips and conflict messages all agree and a saved project
 * needs no extra field. Deleting an earlier curve of the same kind renumbers the later ones, the same way a list renumbers.
 */

const ENTITY_KIND_LABEL: Readonly<Record<SketchEntity["kind"], string>> = {
  line: "Line",
  rectangle: "Rectangle",
  circle: "Circle",
  ellipse: "Ellipse",
  arc: "Arc",
  point: "Point",
  spline: "Spline"
};

type NamedEntity = Pick<SketchEntity, "id" | "kind">;
type NamedConstraint = Pick<WorkbenchSketchConstraint, "id" | "kind">;

/** Id → "Line 3" for every curve, numbered per kind in sketch order. */
export function sketchEntityNames(entities: readonly NamedEntity[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const entity of entities) {
    const next = (counts.get(entity.kind) ?? 0) + 1;
    counts.set(entity.kind, next);
    names.set(entity.id, `${ENTITY_KIND_LABEL[entity.kind] ?? entity.kind} ${next}`);
  }
  return names;
}

/** Id → "Horizontal 2" for every relation or dimension, numbered per kind in sketch order. */
export function sketchConstraintNames(constraints: readonly NamedConstraint[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const constraint of constraints) {
    const next = (counts.get(constraint.kind) ?? 0) + 1;
    counts.set(constraint.kind, next);
    const words = constraint.kind.replaceAll("-", " ");
    names.set(constraint.id, `${words[0]!.toUpperCase()}${words.slice(1)} ${next}`);
  }
  return names;
}

/** "Line 3" for one curve, or a neutral "a sketch curve" when the id is not in the sketch. */
export function sketchEntityName(sketch: Pick<WorkbenchSketch, "entities">, entityId: string): string {
  return sketchEntityNames(sketch.entities).get(entityId) ?? "a sketch curve";
}

/** Ids the app generates carry a UUID ("entity:user-8e1c...-..."). Short hand-written ids (tests, MCP recipes) are left alone. */
const GENERATED_ID = /(?:\b(line|rectangle|circle|ellipse|arc|point|spline) )?(?:(?:entity|constraint):)?[a-z][a-z0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[a-z][a-z-]*)?/gu;

function stripKindPrefix(id: string): string {
  return id.replace(/^(?:entity|constraint):/u, "");
}

/**
 * Rewrites generated ids inside a message to friendly names. `sketches` is searched in order, so pass the sketch after an
 * operation first and the one before it second (a deleted curve is still named by the earlier sketch). An id no sketch knows
 * becomes "a sketch curve" or "a relation" rather than leaking the UUID.
 */
export function friendlySketchText(text: string, sketches: readonly Pick<WorkbenchSketch, "entities" | "constraints">[]): string {
  if (!new RegExp(GENERATED_ID.source, "u").test(text)) return text;
  const lookup = new Map<string, string>();
  const remember = (id: string, name: string): void => {
    if (!lookup.has(id)) lookup.set(id, name);
    const bare = stripKindPrefix(id);
    if (!lookup.has(bare)) lookup.set(bare, name);
  };
  for (const sketch of sketches) {
    for (const [id, name] of sketchEntityNames(sketch.entities)) remember(id, name);
    for (const [id, name] of sketchConstraintNames(sketch.constraints)) remember(id, name);
  }
  // "Moved line user-8e1c..." names the curve once: "Moved Line 3", not "Moved line Line 3".
  return text.replace(GENERATED_ID, (match: string, kindWord: string | undefined) => {
    const token = kindWord === undefined ? match : match.slice(kindWord.length + 1);
    const known = lookup.get(token) ?? lookup.get(stripKindPrefix(token));
    if (known !== undefined) return kindWord !== undefined && !known.toLowerCase().startsWith(kindWord) ? `${kindWord} ${known}` : known;
    // `<entity id>:mirror` style derived ids: name the base curve.
    const base = token.replace(/:[a-z][a-z-]*$/u, "");
    const baseName = base === token ? undefined : lookup.get(base) ?? lookup.get(stripKindPrefix(base));
    if (baseName !== undefined) return baseName;
    return token.startsWith("constraint:") ? "a relation" : "a sketch curve";
  });
}
