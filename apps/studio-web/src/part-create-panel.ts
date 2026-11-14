import type { DesignHistory, DesignSolidFeature, GeneralSolidBody, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, previewFieldExpression } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../../../packages/workbench-sketch/src/index.js";
import { rebuildSolidFeature, sketchLookupOf } from "./design-regeneration.js";
import { matchingSketches } from "./explicit-pick.js";
import { defaultCreateOperation, touchingBodies } from "./operation-default.js";
import { answerOnViewText, onViewLimitMessage, type OnViewParse } from "./ui/on-view-input.js";

/**
 * The Part-environment Extrude and Revolve command panel (PT-05 / PT-06): the pure state and decisions behind
 * ui/PartCreatePanel.tsx. It replaces the three browser prompts (which sketch, which profiles, new / join / cut) and the
 * on-view distance field with one modeless panel on the shared command-panel frame: a profile row, the distance or angle,
 * the direction and the operation, OK and Cancel. Everything the panel decides is a function here, so it is tested without
 * a window; the stored step is the same feature record, built by the same code, as the sketch palette's.
 */

export type PartCreateKind = "extrude" | "revolve";
export type PartCreateOperation = "new" | "join" | "cut" | "intersect";
export type PartCreateDirection = "one-side" | "flipped" | "symmetric" | "two-side";

export interface CreateProfileChoice {
  readonly id: string;
  /** "Profile 2 · 1200 mm²": what the check list shows. */
  readonly label: string;
  readonly areaMm2: number;
}

export interface CreateSketchChoice {
  readonly id: string;
  readonly name: string;
  readonly profiles: readonly CreateProfileChoice[];
}

export interface CreateBodyChoice {
  readonly id: string;
  readonly name: string;
}

export interface PartCreateState {
  readonly kind: PartCreateKind;
  readonly sketchId: string;
  /** The ticked profiles, in the detector's order. */
  readonly profileIds: readonly string[];
  /** The size as typed: a number, units, arithmetic or a parameter name. */
  readonly value: string;
  /** Two sides: the size of the second side, as typed. */
  readonly second: string;
  readonly direction: PartCreateDirection;
  /** The operation the user chose; undefined follows the default (Join when the result touches a body that could take it). */
  readonly operation: PartCreateOperation | undefined;
  /** The solid a Join, Cut or Intersect works on, when the user chose one; undefined follows the default. */
  readonly targetId: string | undefined;
  /** The visible solids the result would touch (worked out in the background; a proposal, never a silent choice). */
  readonly touchingIds: readonly string[];
  readonly error?: string;
}

const LEAD: Readonly<Record<PartCreateKind, string>> = { extrude: "Extrude", revolve: "Revolve" };
const DEFAULT_TEXT: Readonly<Record<PartCreateKind, string>> = { extrude: "10", revolve: "360" };

export const partCreateTitle = (kind: PartCreateKind): string => LEAD[kind];

/** The finished, unsuppressed sketches with at least one closed profile, newest first, each with its profiles named and measured. */
export function createSketchChoices(history: DesignHistory): readonly CreateSketchChoice[] {
  return matchingSketches(history, (candidate) => detectSketchProfiles(candidate.sketch).length > 0).map((sketch) => ({
    id: sketch.id,
    name: sketch.name,
    profiles: detectSketchProfiles(sketch.sketch).map((profile, index) => ({ id: profile.id, label: `Profile ${index + 1} · ${formatArea(profile.areaMm2)}`, areaMm2: profile.areaMm2 }))
  }));
}

export const formatArea = (areaMm2: number): string => `${Number(areaMm2.toFixed(areaMm2 < 100 ? 2 : 0)).toLocaleString("en-US")} mm²`;

export type PartCreateOpening =
  | { readonly ok: true; readonly state: PartCreateState; readonly choices: readonly CreateSketchChoice[] }
  | { readonly ok: false; readonly message: string };

/**
 * Opens the panel. The sketch is the one asked for (right-click on a sketch row), else the selected timeline sketch, else
 * the newest finished sketch with a closed profile; the panel names it and lets the user pick another, so no sketch is
 * chosen out of sight. A sketch that has profiles but cannot be used yet (suppressed, or after the rollback marker) is
 * refused by name instead of being quietly replaced by another.
 */
export function openPartCreate(kind: PartCreateKind, history: DesignHistory, input: { readonly preferredSketchId?: string | undefined; readonly selectedSketchId?: string | undefined }): PartCreateOpening {
  const lead = LEAD[kind];
  const choices = createSketchChoices(history);
  for (const asked of [input.preferredSketchId, input.selectedSketchId]) {
    if (asked === undefined) continue;
    const index = history.features.findIndex((feature) => feature.id === asked);
    const feature = history.features[index];
    if (feature?.kind !== "sketch" || detectSketchProfiles(feature.sketch).length === 0) continue;
    if (choices.some((choice) => choice.id === asked)) return { ok: true, choices, state: initialPartCreateState(kind, choices.find((choice) => choice.id === asked)!) };
    const why = feature.suppressed ? "is suppressed" : index >= history.rollbackIndex ? "is after the rollback marker" : "cannot be used";
    return { ok: false, message: `${lead}: ${feature.name} ${why}, so a new step cannot be built from it. Choose another sketch, or move the rollback marker forward.` };
  }
  const newest = choices[0];
  if (newest === undefined) return { ok: false, message: `${lead}: finish a sketch with a closed profile first (Create Sketch, draw, Finish Sketch).` };
  return { ok: true, choices, state: initialPartCreateState(kind, newest) };
}

export function initialPartCreateState(kind: PartCreateKind, sketch: CreateSketchChoice): PartCreateState {
  return {
    kind, sketchId: sketch.id, profileIds: sketch.profiles.map((profile) => profile.id),
    value: DEFAULT_TEXT[kind], second: kind === "extrude" ? "10" : "90",
    direction: "one-side", operation: undefined, targetId: undefined, touchingIds: []
  };
}

export type PartCreateAction =
  | { readonly type: "sketch"; readonly id: string }
  | { readonly type: "toggle-profile"; readonly id: string }
  | { readonly type: "all-profiles" }
  | { readonly type: "no-profiles" }
  | { readonly type: "value"; readonly text: string }
  | { readonly type: "second"; readonly text: string }
  | { readonly type: "direction"; readonly direction: PartCreateDirection }
  | { readonly type: "operation"; readonly operation: PartCreateOperation }
  | { readonly type: "target"; readonly id: string };

const withoutError = (state: PartCreateState): PartCreateState => {
  const { error: _drop, ...rest } = state;
  void _drop;
  return rest;
};

/** One user change to the panel. Any change clears the last error. */
export function partCreateReduce(current: PartCreateState, action: PartCreateAction, sketches: readonly CreateSketchChoice[]): PartCreateState {
  const state = withoutError(current);
  const sketch = sketches.find((candidate) => candidate.id === state.sketchId);
  switch (action.type) {
    case "sketch": {
      const next = sketches.find((candidate) => candidate.id === action.id);
      return next === undefined ? state : { ...state, sketchId: next.id, profileIds: next.profiles.map((profile) => profile.id), touchingIds: [] };
    }
    case "toggle-profile": {
      if (sketch === undefined) return state;
      const ticked = new Set(state.profileIds);
      if (ticked.has(action.id)) ticked.delete(action.id); else ticked.add(action.id);
      return { ...state, profileIds: sketch.profiles.filter((profile) => ticked.has(profile.id)).map((profile) => profile.id) };
    }
    case "all-profiles": return sketch === undefined ? state : { ...state, profileIds: sketch.profiles.map((profile) => profile.id) };
    case "no-profiles": return { ...state, profileIds: [] };
    case "value": return { ...state, value: action.text };
    case "second": return { ...state, second: action.text };
    case "direction": {
      // A full turn leaves no room for a second side: the untouched 360 default becomes two quarter turns.
      const split = action.direction === "two-side" && state.kind === "revolve" && state.value.trim() === "360";
      return { ...state, direction: action.direction, ...(split ? { value: "90", second: "90" } : {}) };
    }
    case "operation": return { ...state, operation: action.operation };
    case "target": return { ...state, targetId: action.id };
  }
}

/** The text of the selection row: what is picked, and how much of the sketch it covers. */
export function profileSelectionRow(state: PartCreateState, sketch: CreateSketchChoice | undefined): { readonly label: string; readonly status: string; readonly count: number; readonly clearable: boolean } {
  if (sketch === undefined) return { label: "Profile", status: "The sketch is not available", count: 0, clearable: false };
  const ticked = sketch.profiles.filter((profile) => state.profileIds.includes(profile.id));
  const area = ticked.reduce((sum, profile) => sum + profile.areaMm2, 0);
  const count = ticked.length;
  const status = count === 0
    ? `${sketch.name} · tick at least one profile`
    : count === sketch.profiles.length
      ? `${sketch.name} · ${count === 1 ? "1 profile" : `all ${count} profiles`} · ${formatArea(area)}`
      : `${sketch.name} · ${count} of ${sketch.profiles.length} profiles · ${formatArea(area)}`;
  return { label: "Profile", status, count, clearable: count > 0 };
}

/** The profiles a step stores: every profile is the empty list (the old "all" meaning), a subset is its ids, and none is refused. */
export function profileIdsToStore(ticked: readonly string[], sketch: CreateSketchChoice): readonly string[] | undefined {
  const known = sketch.profiles.filter((profile) => ticked.includes(profile.id)).map((profile) => profile.id);
  if (known.length === 0) return undefined;
  return known.length === sketch.profiles.length ? [] : known;
}

export interface PartCreateFieldSpec {
  readonly id: "value" | "second";
  readonly label: string;
  readonly unit: string;
  readonly hint: string;
}

/** The typed rows: the size, and the second side when the direction has one. */
export function partCreateFields(state: PartCreateState): readonly PartCreateFieldSpec[] {
  const extrude = state.kind === "extrude";
  return [
    { id: "value", label: extrude ? "Distance" : "Angle", unit: extrude ? "mm" : "°", hint: "a number, a unit (1/2 in), arithmetic, or a parameter name" },
    ...(state.direction === "two-side" ? [{ id: "second" as const, label: extrude ? "Second distance" : "Second angle", unit: extrude ? "mm" : "°", hint: "how far the second side goes" }] : [])
  ];
}

export interface PartCreateOption<T extends string> { readonly value: T; readonly label: string }

export function directionOptions(kind: PartCreateKind): readonly PartCreateOption<PartCreateDirection>[] {
  return [
    { value: "one-side", label: kind === "extrude" ? "One side (along the plane normal)" : "One side" },
    { value: "symmetric", label: "Symmetric (half each way)" },
    { value: "two-side", label: "Two sides (a different amount each way)" },
    { value: "flipped", label: kind === "extrude" ? "One side, flipped (against the normal)" : "One side, flipped" }
  ];
}

/** New body is always offered; Join, Cut and Intersect only when there is a solid to work on. */
export function operationOptions(bodyCount: number): readonly PartCreateOption<PartCreateOperation>[] {
  return [
    { value: "new", label: "New body" },
    ...(bodyCount === 0 ? [] : [
      { value: "join" as const, label: "Join (add to a solid)" },
      { value: "cut" as const, label: "Cut (remove from a solid)" },
      { value: "intersect" as const, label: "Intersect (keep only the overlap)" }
    ])
  ];
}

/** The solid a Join, Cut or Intersect acts on: the one chosen in the panel, else the selected solid, else the one solid the result touches. Never a silent first-in-the-list. */
export function resolveTargetId(state: PartCreateState, bodies: readonly CreateBodyChoice[], selectedId: string | null): string | undefined {
  if (state.targetId !== undefined && bodies.some((body) => body.id === state.targetId)) return state.targetId;
  const selected = bodies.find((body) => body.id === selectedId);
  if (selected !== undefined) return selected.id;
  const touched = state.touchingIds.filter((id) => bodies.some((body) => body.id === id));
  return touched.length === 1 ? touched[0] : undefined;
}

/** The operation the commit will use: the chosen one, else Fusion's default (Join when the result touches a solid it could join, New body otherwise). */
export function effectiveOperation(state: PartCreateState, bodies: readonly CreateBodyChoice[], selectedId: string | null): PartCreateOperation {
  if (bodies.length === 0) return "new";
  if (state.operation !== undefined) return state.operation;
  return defaultCreateOperation(state.touchingIds.length, resolveTargetId(state, bodies, selectedId) !== undefined);
}

/** A line under the operation row: which solids the result touches, so the default is explained. */
export function touchNote(state: PartCreateState, bodies: readonly CreateBodyChoice[]): string {
  const names = state.touchingIds.map((id) => bodies.find((body) => body.id === id)?.name).filter((name): name is string => name !== undefined);
  return names.length === 0 ? "" : `The result touches ${names.join(", ")}.`;
}

export type CreateValueParse = (OnViewParse & { readonly bound: boolean }) & { readonly text?: string };

/**
 * Reads the size the user typed, with the same rules as the on-view field and Edit Feature: arithmetic and units first, then
 * the design's parameters and `Extrude1.distance` style references (those stay bound to the new step). The size must be above
 * zero, and a revolve at most a full turn. The second side takes the same text but is stored as a plain number.
 */
export function parseCreateValue(project: WorkbenchProject, kind: PartCreateKind, field: "value" | "second", text: string): CreateValueParse {
  const quantity = kind === "extrude" ? "length" : "angle";
  if (text.trim() === "") return { ok: false, message: "Type a value.", bound: false };
  const probe: DesignSolidFeature = { id: `feature:${kind}-size-probe`, name: LEAD[kind], kind, suppressed: false, sketchFeatureId: "feature:size-probe", profileIds: [], valueMm: 1, bodyId: "general-body:size-probe" };
  const resolve = (typed: string): OnViewParse => {
    const preview = previewFieldExpression(project, probe, kind === "extrude" ? "distance" : "angle", typed);
    return preview.ok ? { ok: true, value: preview.value } : { ok: false, message: preview.message };
  };
  const answer = answerOnViewText({ quantity, resolve }, text);
  if (!answer.ok) return answer;
  const limit = onViewLimitMessage({ min: 0, exclusiveMin: true, quantity, ...(kind === "revolve" ? { max: 360 } : {}) }, answer.value);
  if (limit !== undefined) return { ok: false, message: limit, bound: false };
  return { ok: true, value: answer.value, bound: field === "value" && answer.bound, text: text.trim() };
}

/** The number to hand to `onValueChange`: the resolved size when it changed since the last call, nothing while the text does not resolve. */
export function valueToNotify(previous: number | undefined, parsed: CreateValueParse): number | undefined {
  if (!parsed.ok) return undefined;
  return previous !== undefined && Math.abs(previous - parsed.value) < 1e-9 ? undefined : parsed.value;
}

export interface PartCreateRequest {
  readonly kind: PartCreateKind;
  readonly sketchId: string;
  /** What the step stores: empty means every profile. */
  readonly profileIds: readonly string[];
  readonly value: number;
  /** The size text when it is an expression the step stays bound to (`plate_h / 2`). */
  readonly valueExpression?: string;
  readonly direction: PartCreateDirection;
  readonly secondValueMm?: number;
  readonly operation: PartCreateOperation;
  readonly target?: { readonly mode: "join" | "cut" | "intersect"; readonly bodyId: string };
  readonly targetName?: string;
}

export type PartCreatePlan =
  | { readonly ok: true; readonly request: PartCreateRequest }
  | { readonly ok: false; readonly message: string };

/**
 * Turns the panel into the one thing to build, or says what is wrong in a sentence the panel shows under its rows. Every
 * old refusal of the prompt flow is here as a message: no profile, a size that does not read, a revolve past a full turn,
 * a Join / Cut / Intersect with no solid chosen.
 */
export function planPartCreate(state: PartCreateState, input: { readonly project: WorkbenchProject; readonly selectedId: string | null; readonly touchingIds?: readonly string[] }): PartCreatePlan {
  const lead = LEAD[state.kind];
  const history = designOf(input.project);
  const sketch = createSketchChoices(history).find((candidate) => candidate.id === state.sketchId);
  if (sketch === undefined) return { ok: false, message: `${lead}: that sketch is not available any more. Choose another sketch.` };
  const profileIds = profileIdsToStore(state.profileIds, sketch);
  if (profileIds === undefined) return { ok: false, message: `${lead}: tick at least one profile of ${sketch.name}.` };
  const size = parseCreateValue(input.project, state.kind, "value", state.value);
  if (!size.ok) return { ok: false, message: `${state.kind === "extrude" ? "Distance" : "Angle"}: ${size.message}` };
  let secondValueMm: number | undefined;
  if (state.direction === "two-side") {
    const second = parseCreateValue(input.project, state.kind, "second", state.second);
    if (!second.ok) return { ok: false, message: `${state.kind === "extrude" ? "Second distance" : "Second angle"}: ${second.message}` };
    if (state.kind === "revolve" && size.value + second.value > 360) return { ok: false, message: "Revolve: the two sides together turn more than 360 degrees. Make them add up to 360 or less." };
    secondValueMm = second.value;
  }
  const bodies: readonly CreateBodyChoice[] = (input.project.part.generalBodies ?? []).map((body: GeneralSolidBody) => ({ id: body.id, name: body.name }));
  const withTouch: PartCreateState = input.touchingIds === undefined ? state : { ...state, touchingIds: input.touchingIds };
  const operation = effectiveOperation(withTouch, bodies, input.selectedId);
  let target: PartCreateRequest["target"];
  let targetName: string | undefined;
  if (operation !== "new") {
    const targetId = resolveTargetId(withTouch, bodies, input.selectedId);
    if (targetId === undefined) return { ok: false, message: `${lead}: choose the solid to ${operation}${bodies.length > 1 ? ` (${bodies.map((body) => body.name).join(", ")})` : ""}.` };
    target = { mode: operation, bodyId: targetId };
    targetName = bodies.find((body) => body.id === targetId)?.name;
  }
  return {
    ok: true,
    request: {
      kind: state.kind, sketchId: sketch.id, profileIds, value: size.value,
      ...(size.bound && size.text !== undefined ? { valueExpression: size.text } : {}),
      direction: state.direction, ...(secondValueMm === undefined ? {} : { secondValueMm }),
      operation, ...(target === undefined ? {} : { target }), ...(targetName === undefined ? {} : { targetName })
    }
  };
}

/** What changes the background touch test: the sketch, its profiles, the size and the direction. */
export function touchKey(state: PartCreateState): string {
  return [state.kind, state.sketchId, state.profileIds.join(","), state.value, state.second, state.direction].join("|");
}

/**
 * Builds the result once as a throwaway tool to see which visible solids it meets (a bounding-box touch, the honest cheap
 * stand-in used by the old prompt). It only feeds the proposal for the operation; the user's choice always wins.
 */
export async function probeTouchingIds(state: PartCreateState, project: WorkbenchProject): Promise<readonly string[]> {
  const bodies = project.part.generalBodies ?? [];
  if (!bodies.some((candidate) => candidate.visible)) return [];
  const history = designOf(project);
  const sketchFeature = history.features.find((feature) => feature.id === state.sketchId);
  if (sketchFeature?.kind !== "sketch") return [];
  const sketch = createSketchChoices(history).find((candidate) => candidate.id === state.sketchId);
  if (sketch === undefined) return [];
  const profileIds = profileIdsToStore(state.profileIds, sketch);
  if (profileIds === undefined) return [];
  const size = parseCreateValue(project, state.kind, "value", state.value);
  const second = state.direction === "two-side" ? parseCreateValue(project, state.kind, "second", state.second) : undefined;
  const probe: DesignSolidFeature = {
    id: `feature:${state.kind}-probe`, name: "probe", kind: state.kind, suppressed: false, sketchFeatureId: sketchFeature.id, profileIds,
    valueMm: size.ok ? size.value : Number(DEFAULT_TEXT[state.kind]), bodyId: "general-body:probe",
    ...(state.direction === "one-side" ? {} : { direction: state.direction }),
    ...(second?.ok === true ? { secondValueMm: second.value } : {})
  };
  const built = await rebuildSolidFeature(probe, sketchFeature, undefined, sketchLookupOf(history));
  return built.ok ? touchingBodies(built.body.positionsMm, bodies).map((body) => body.id) : [];
}

export function partCreateWithError(state: PartCreateState, message: string): PartCreateState {
  return { ...state, error: message };
}

/** Starting the same command again keeps the running panel; another one replaces it, saying so. */
export function partCreateReopenPlan(open: PartCreateState | null, kind: PartCreateKind): { readonly kind: "keep"; readonly message: string } | { readonly kind: "replace"; readonly note: string } {
  if (open !== null && open.kind === kind) return { kind: "keep", message: `${LEAD[kind]} is already running: tick the profiles, type the size, Enter commits, Esc cancels.` };
  return { kind: "replace", note: open === null ? "" : `${LEAD[open.kind]} cancelled — nothing changed. ` };
}
