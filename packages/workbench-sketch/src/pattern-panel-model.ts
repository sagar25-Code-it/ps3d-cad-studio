import { generateSketchPatternEntities, type SketchEntity, type SketchPatternObject, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import { patternEntities, type SketchEditPlan } from "./edit-tools.js";
import { describePatternSpec, patternSpecFromFields, planPattern, planPatternEdit, type PatternFields } from "./pattern-path.js";
import type { SketchLengthUnit } from "./sketch-units.js";

/**
 * What the one Pattern panel does for the values typed in it: the plan Apply would send, the ghost of the copies it would make (drawn on
 * the canvas while the values are typed), and a one-line summary. The panel previews and applies through this same function, so the
 * ghost is exactly what Apply creates. Rectangular, circular and path layouts, associative or static copies, and the re-editing of an
 * existing pattern all go through here.
 */

/** The most ghost curves drawn at once; a pattern of hundreds of copies would only slow the canvas down. */
export const PATTERN_GHOST_LIMIT = 200;

export interface PatternPanelInput {
  readonly sketch: WorkbenchSketch;
  /** The selected curves. For a path pattern the last one is the path and the ones before it are repeated. */
  readonly selectionIds: readonly string[];
  readonly fields: PatternFields;
  /** Associative patterns keep their source and layout; static copies are ordinary curves. */
  readonly associative: boolean;
  /** The unit the length fields are typed in. */
  readonly unit: SketchLengthUnit;
  /** The pattern being re-edited (a curve of an existing pattern is selected). */
  readonly existing?: SketchPatternObject | undefined;
}

export type PatternPanelPlan =
  | { readonly ok: true; readonly plan: SketchEditPlan; readonly ghost: readonly SketchEntity[]; readonly summary: string }
  | { readonly ok: false; readonly message: string };

/** The curves a path pattern repeats and the curve it follows, from the selection and the fields. */
export function patternSelection(input: Pick<PatternPanelInput, "selectionIds" | "fields" | "existing">): { readonly sources: readonly string[]; readonly pathId: string } {
  const pathMode = input.fields.kind === "path";
  if (!pathMode) return { sources: input.selectionIds, pathId: "" };
  const pathId = input.existing !== undefined && input.selectionIds.length === 0 ? input.fields.pathEntityId : input.selectionIds.at(-1) ?? input.fields.pathEntityId;
  return { sources: input.selectionIds.slice(0, -1), pathId };
}

function ghostOf(pattern: SketchPatternObject, sketch: WorkbenchSketch): readonly SketchEntity[] {
  const generated = generateSketchPatternEntities(pattern, sketch.entities);
  return generated.ok ? generated.entities.slice(0, PATTERN_GHOST_LIMIT) : [];
}

/** undefined while there is nothing to preview (no curves selected and no pattern being edited). */
export function planPatternPanel(input: PatternPanelInput, newId: (prefix: "entity" | "constraint") => string): PatternPanelPlan | undefined {
  const { sketch, fields, unit, existing } = input;
  if (existing === undefined && input.selectionIds.length === 0) return undefined;
  const { sources, pathId } = patternSelection(input);
  const specResult = patternSpecFromFields(existing !== undefined && fields.kind === "path" ? fields : fields.kind === "path" ? { ...fields, pathEntityId: pathId } : fields, unit);
  if (!specResult.ok) return { ok: false, message: specResult.diagnostics[0]?.message ?? "Check the pattern values." };
  const spec = specResult.value;
  if (existing !== undefined) {
    const plan = planPatternEdit(sketch, existing.id, spec);
    if (!plan.ok) return { ok: false, message: plan.diagnostics[0]?.message ?? "The pattern change was refused." };
    const next = plan.value.objects?.patterns?.[0];
    return { ok: true, plan: plan.value, ghost: next === undefined ? [] : ghostOf(next, sketch), summary: `Update: ${describePatternSpec(spec)}.` };
  }
  if (!input.associative) {
    if (spec.kind === "path") return { ok: false, message: "A path pattern is always associative: tick Associative, or choose a rectangular or circular layout for static copies." };
    const result = spec.kind === "rectangular"
      ? patternEntities({ sketch, newId }, input.selectionIds, { kind: "rectangular", countX: spec.countX, countY: spec.countY, dxMm: spec.dxMm, dyMm: spec.dyMm })
      : patternEntities({ sketch, newId }, input.selectionIds, { kind: "circular", count: spec.count, angleDeg: spec.angleDeg, center: spec.center });
    if (!result.ok) return { ok: false, message: result.diagnostics[0]?.message ?? "The pattern was refused." };
    return { ok: true, plan: result.value, ghost: result.value.addEntities.slice(0, PATTERN_GHOST_LIMIT), summary: `${describePatternSpec(spec)}: adds ${result.value.addEntities.length} static curves.` };
  }
  const plan = planPattern({ sketch, newId }, sources, spec);
  if (!plan.ok) return { ok: false, message: plan.diagnostics[0]?.message ?? "The pattern was refused." };
  const pattern = plan.value.objects?.patterns?.[0];
  const ghost = pattern === undefined ? [] : ghostOf(pattern, sketch);
  return { ok: true, plan: plan.value, ghost, summary: `${describePatternSpec(spec)}: ${ghost.length >= PATTERN_GHOST_LIMIT ? `${PATTERN_GHOST_LIMIT}+` : String(ghost.length)} associative copies.` };
}

/** What a key pressed in a field of the Pattern panel does: Enter applies, Escape closes the panel. */
export function patternPanelKey(key: string): "apply" | "close" | undefined {
  return key === "Enter" ? "apply" : key === "Escape" ? "close" : undefined;
}
