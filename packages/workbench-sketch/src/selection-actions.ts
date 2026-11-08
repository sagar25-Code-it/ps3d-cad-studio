import { constraintFit, solveLiveSketch, type SketchConstraintKind, type SketchEntity, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * What the inspector buttons, the ribbon and the hotkeys do to the selection. They all build the same atomic edit plan from the
 * whole selection, so a button can never act on one curve while the Delete key acts on five (audit Sketch edit E23), and every
 * action is one undo step.
 */
export type SelectionActionResult =
  | { readonly ok: true; readonly plan: SketchEditPlan }
  | { readonly ok: false; readonly message: string };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The status-bar text for the number of things selected in the sketch (curves, profiles and relations together). */
export function selectionCountLabel(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${safe} selected`;
}

/** Counts curves, shaded profiles and relations picked on the canvas as one number for the status bar. */
export function sketchSelectionTotal(counts: { readonly curves: number; readonly profiles: number; readonly constraints: number }): number {
  return Math.max(0, counts.curves) + Math.max(0, counts.profiles) + Math.max(0, counts.constraints);
}

const empty = { removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [] } as const;

export function deleteSelectionPlan(sketch: Pick<WorkbenchSketch, "entities">, ids: readonly string[]): SelectionActionResult {
  const present = new Set(sketch.entities.map((entity) => entity.id));
  const targets = [...new Set(ids)].filter((id) => present.has(id));
  if (targets.length === 0) return { ok: false, message: "Select one or more curves first." };
  return { ok: true, plan: { ...empty, label: `Deleted ${plural(targets.length, "curve")}`, removeEntityIds: targets } };
}

/** Selected curves all become construction geometry, or, when they all already are, all become profile geometry again. */
export function constructionSelectionPlan(entities: readonly SketchEntity[]): SelectionActionResult {
  if (entities.length === 0) return { ok: false, message: "Select curves first, then turn them into construction geometry (or back)." };
  const toConstruction = entities.some((entity) => !entity.construction);
  const changed = entities.filter((entity) => entity.construction !== toConstruction);
  return { ok: true, plan: { ...empty, label: `${toConstruction ? "Made" : "Turned"} ${plural(entities.length, "curve")} ${toConstruction ? "construction geometry" : "back into profile geometry"}`, updateEntities: changed.map((entity) => ({ ...entity, construction: toConstruction })) } };
}

/** Selected curves are all hidden, or, when they are all hidden already, all shown. */
export function visibilitySelectionPlan(entities: readonly SketchEntity[]): SelectionActionResult {
  if (entities.length === 0) return { ok: false, message: "Select curves first." };
  const hide = entities.some((entity) => entity.visible !== false);
  const changed = entities.filter((entity) => hide ? entity.visible !== false : entity.visible === false);
  return { ok: true, plan: { ...empty, label: `${hide ? "Hid" : "Showed"} ${plural(entities.length, "curve")}`, updateEntities: changed.map((entity) => hide ? { ...entity, visible: false } : stripVisible(entity)) } };
}

function stripVisible(entity: SketchEntity): SketchEntity {
  const { visible: _visible, ...rest } = entity as SketchEntity & { visible?: boolean };
  return rest as SketchEntity;
}

/** A Fixed relation on every selected curve that does not carry one yet. */
export function fixSelectionPlan(sketch: Pick<WorkbenchSketch, "constraints">, entities: readonly SketchEntity[], newId: () => string): SelectionActionResult {
  if (entities.length === 0) return { ok: false, message: "Select one or more curves first." };
  const already = new Set(sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true).flatMap((constraint) => constraint.entityIds));
  const targets = entities.filter((entity) => !already.has(entity.id));
  if (targets.length === 0) return { ok: false, message: "The selected curves are already fixed." };
  return { ok: true, plan: { ...empty, label: `Fixed ${plural(targets.length, "curve")}`, addConstraints: targets.map((entity) => ({ id: newId(), kind: "fixed" as const, entityIds: [entity.id] })) } };
}

/** Removes the Fixed relation from every selected curve that has one. */
export function unfixSelectionPlan(sketch: Pick<WorkbenchSketch, "constraints">, ids: readonly string[]): SelectionActionResult {
  const selected = new Set(ids);
  const fixed = sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.entityIds.some((id) => selected.has(id)));
  if (fixed.length === 0) return { ok: false, message: "None of the selected curves is fixed." };
  return { ok: true, plan: { ...empty, label: `Unfixed ${plural(new Set(fixed.flatMap((constraint) => constraint.entityIds.filter((id) => selected.has(id)))).size, "curve")}`, removeConstraintIds: fixed.map((constraint) => constraint.id) } };
}

/** True when every selected curve already carries an active Fixed relation. */
export function selectionIsFixed(sketch: Pick<WorkbenchSketch, "constraints">, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const fixed = new Set(sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true).flatMap((constraint) => constraint.entityIds));
  return ids.every((id) => fixed.has(id));
}

/** A one-curve relation (Horizontal, Vertical) on each selected curve it fits and that does not already have it. */
export function constrainEachPlan(sketch: WorkbenchSketch, kind: Extract<SketchConstraintKind, "horizontal" | "vertical">, entities: readonly SketchEntity[], newId: () => string): SelectionActionResult {
  if (entities.length === 0) return { ok: false, message: "Select one or more curves first." };
  const fits = entities.filter((entity) => constraintFit(kind, [entity.kind]).ok);
  if (fits.length === 0) return { ok: false, message: `${kind === "horizontal" ? "Horizontal" : "Vertical"} needs lines; none of the selected curves is a line.` };
  const have = new Set(sketch.constraints.filter((constraint) => constraint.kind === kind && constraint.suppressed !== true).flatMap((constraint) => constraint.entityIds));
  const targets = fits.filter((entity) => !have.has(entity.id));
  if (targets.length === 0) return { ok: false, message: `The selected lines are already ${kind}.` };
  const skipped = entities.length - fits.length;
  const addConstraints = targets.map((entity) => ({ id: newId(), kind, entityIds: [entity.id] }));
  // The solver brings each line to the relation, exactly as adding the relation to one line does; the edit carries the moved lines
  // so the project sees a sketch that already satisfies every relation.
  const solved = solveLiveSketch({ ...sketch, constraints: [...sketch.constraints, ...addConstraints] }, targets.map((entity) => entity.id));
  if (!solved.ok) return { ok: false, message: solved.message };
  const before = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  const moved = solved.entities.filter((entity) => before.get(entity.id) !== entity);
  return { ok: true, plan: { ...empty, label: `Made ${plural(targets.length, "line")} ${kind}${skipped > 0 ? ` (${plural(skipped, "other curve")} skipped)` : ""}`, updateEntities: moved, addConstraints } };
}
