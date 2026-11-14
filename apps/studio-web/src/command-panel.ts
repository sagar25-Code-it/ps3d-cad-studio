import type { DesignSolidFeature, EdgeBlendGroup, FaceRef } from "../../../packages/workbench-core/src/index.js";
import { EDGE_BLEND_MAX_GROUPS } from "../../../packages/workbench-core/src/index.js";
import { COARSE_PITCH_MM, METRIC_FASTENERS, tapDrillDiameterMm } from "../../../packages/workbench-geometry/src/index.js";
import type { ViewportGuideSegment } from "../../../packages/viewport-three/src/index.js";
import { parameterValuesOf } from "./feature-parameters.js";

/**
 * PT-06: one shared modeless command panel. The panel is plain state (this module) plus one component (ui/CommandPanel.tsx):
 * selection rows that show what is picked, value fields, OK and Cancel, Enter and Esc. Fillet, Chamfer, Shell and Hole run
 * through it, for creation and for Edit Feature, so the same dialog opens filled when a step is double-clicked later.
 *
 * The values are kept as typed text; the commit path runs them through `applyParameterValues`, which is the same parser,
 * validator and expression binder the edit dialog uses, so a field accepts whatever an edit would accept (PT-13).
 */

export type PanelCommand = "fillet" | "chamfer" | "shell" | "hole";

/** One picked edge chain: the stored edge-set (segments and the faces beside them) plus what to draw and say. */
export interface PanelEdgeSet {
  readonly bodyId: string;
  readonly chain: number;
  readonly group: EdgeBlendGroup;
  readonly segments: readonly ViewportGuideSegment[];
  readonly summary: string;
}

/** One picked face (shell: a face to leave open; hole: the face the hole starts on). */
export interface PanelFacePick {
  readonly ref: FaceRef;
  readonly summary: string;
}

export interface PanelFieldSpec {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly kind: "text" | "select";
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
}

export interface CommandPanelState {
  readonly command: PanelCommand;
  readonly mode: "create" | "edit";
  /** Edit mode: the id of the step being edited. */
  readonly editFeatureId?: string;
  /** The solid the command works on: fixed by the first pick (create) or the step (edit). */
  readonly bodyId?: string;
  readonly bodyName?: string;
  readonly edges: readonly PanelEdgeSet[];
  readonly faces: readonly PanelFacePick[];
  /** Hole: where it starts and the drilling direction (into the face). */
  readonly holePoint?: { readonly pointMm: readonly [number, number, number]; readonly normal: readonly [number, number, number] };
  /** Field id → typed text (a number, or an expression such as `wall * 2`). */
  readonly values: Readonly<Record<string, string>>;
  /** Edit mode: the stored edge sets, kept when the user does not re-pick. */
  readonly storedGroups?: readonly EdgeBlendGroup[];
  readonly error?: string;
}

const TITLES: Readonly<Record<PanelCommand, string>> = { fillet: "Fillet", chamfer: "Chamfer", shell: "Shell", hole: "Hole" };

const CREATE_DEFAULTS: Readonly<Record<PanelCommand, Readonly<Record<string, string>>>> = {
  fillet: { size: "2", endSize: "0" },
  chamfer: { size: "2", second: "0", angle: "0", side: "normal" },
  shell: { wall: "2", side: "inside" },
  hole: { style: "simple", fastener: "custom", diameter: "6", depth: "0", thread: "none" }
};

/** Opens the panel for creation with the command's default values. */
export function openCommandPanel(command: PanelCommand): CommandPanelState {
  return { command, mode: "create", edges: [], faces: [], values: { ...CREATE_DEFAULTS[command] } };
}

/** Opens the panel filled from an existing step (Edit Feature): same fields, stored selections summarised. */
export function openCommandPanelForEdit(feature: DesignSolidFeature, bodyName: string | undefined): CommandPanelState | undefined {
  const common = { mode: "edit" as const, editFeatureId: feature.id, bodyId: feature.bodyId, ...(bodyName === undefined ? {} : { bodyName }) };
  if (feature.kind === "edge-blend" && (feature.blendType === "fillet" || feature.blendType === "chamfer")) {
    return {
      command: feature.blendType, ...common, edges: [], faces: [],
      storedGroups: feature.blendEdges ?? [],
      values: { ...CREATE_DEFAULTS[feature.blendType], ...parameterValuesOf(feature) }
    };
  }
  if (feature.kind === "shell" && feature.bodyEdit?.kind === "shell") {
    return {
      command: "shell", ...common, edges: [],
      faces: feature.bodyEdit.openFaces.map((ref, index) => ({ ref, summary: `Stored face ${index + 1}` })),
      values: { ...CREATE_DEFAULTS.shell, ...parameterValuesOf(feature) }
    };
  }
  if (feature.kind === "hole") {
    return {
      command: "hole", ...common, edges: [], faces: [],
      ...(feature.holePositionMm === undefined ? {} : { holePoint: { pointMm: feature.holePositionMm as readonly [number, number, number], normal: (feature.holeNormal ?? [0, 0, 1]) as readonly [number, number, number] } }),
      values: { style: feature.holeStyle ?? "simple", fastener: "custom", ...parameterValuesOf(feature) }
    };
  }
  return undefined;
}

export function panelTitle(state: CommandPanelState): string {
  return `${TITLES[state.command]}${state.mode === "edit" ? " · Edit Feature" : ""}`;
}

/** The value fields the panel shows. They carry the same ids as the edit dialog, so one name means one thing everywhere. */
export function panelFields(state: CommandPanelState): readonly PanelFieldSpec[] {
  switch (state.command) {
    case "fillet": return [
      { id: "size", label: "Radius", unit: "mm", kind: "text" },
      { id: "endSize", label: "End radius", unit: "mm", kind: "text", hint: "0 keeps the radius constant along each edge" }
    ];
    case "chamfer": return [
      { id: "size", label: "First distance", unit: "mm", kind: "text" },
      { id: "second", label: "Second distance", unit: "mm", kind: "text", hint: "0 or the same for an even chamfer" },
      { id: "angle", label: "Angle with the first face", unit: "°", kind: "text", hint: "0 uses the distances" },
      { id: "side", label: "Sides", unit: "", kind: "select", options: [{ value: "normal", label: "First distance on the upper face" }, { value: "flipped", label: "First distance on the other face" }] }
    ];
    case "shell": return [
      { id: "wall", label: "Wall thickness", unit: "mm", kind: "text" },
      { id: "side", label: "Wall grows", unit: "", kind: "select", options: [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }, { value: "both", label: "Both directions" }] }
    ];
    case "hole": {
      const style = state.values["style"] ?? "simple";
      const thread = state.values["thread"] ?? "none";
      return [
        { id: "style", label: "Hole type", unit: "", kind: "select", options: [{ value: "simple", label: "Simple" }, { value: "counterbore", label: "Counterbore" }, { value: "countersink", label: "Countersink" }] },
        { id: "fastener", label: "Fastener size", unit: "", kind: "select", options: [
          { value: "custom", label: "Custom sizes" },
          ...Object.keys(METRIC_FASTENERS).map((size) => ({ value: size, label: size }))
        ] },
        { id: "diameter", label: "Diameter", unit: "mm", kind: "text" },
        // A hole placed from faces is moved by its two distances (HS-15).
        ...(state.values["offsetA"] === undefined ? [] : [
          { id: "offsetA", label: "Distance from the first face", unit: "mm", kind: "text" as const, hint: "the hole follows the face it is measured from" },
          { id: "offsetB", label: "Distance from the second face", unit: "mm", kind: "text" as const }
        ]),
        { id: "depth", label: "Depth", unit: "mm", kind: "text", hint: "0 drills through everything" },
        ...(style === "counterbore" ? [
          { id: "counterDiameter", label: "Pocket diameter", unit: "mm", kind: "text" as const },
          { id: "counterDepth", label: "Pocket depth", unit: "mm", kind: "text" as const }
        ] : []),
        ...(style === "countersink" ? [
          { id: "sinkDiameter", label: "Countersink diameter", unit: "mm", kind: "text" as const },
          { id: "sinkAngle", label: "Countersink angle", unit: "°", kind: "text" as const }
        ] : []),
        ...(style === "simple" ? [
          { id: "thread", label: "Thread", unit: "", kind: "select" as const, options: [{ value: "none", label: "No thread (plain hole)" }, { value: "cosmetic", label: "Cosmetic thread" }, { value: "modelled", label: "Modelled thread" }] },
          ...(thread === "none" ? [] : [{ id: "threadPitch", label: "Thread pitch", unit: "mm", kind: "text" as const }])
        ] : [])
      ];
    }
  }
}

/** What the selection row asks for and shows. */
export function panelSelectionRow(state: CommandPanelState): { readonly label: string; readonly status: string; readonly count: number; readonly clearable: boolean } {
  if (state.command === "fillet" || state.command === "chamfer") {
    const stored = state.edges.length === 0 ? (state.storedGroups?.length ?? 0) : 0;
    const count = state.edges.length + stored;
    const status = state.edges.length > 0
      ? `${state.edges.length} edge ${state.edges.length === 1 ? "run" : "runs"} selected`
      : stored > 0 ? `${stored} stored edge ${stored === 1 ? "run" : "runs"} (click edges to re-pick)` : "Select · click edges in the view";
    return { label: "Edges", status, count, clearable: state.edges.length > 0 };
  }
  if (state.command === "shell") {
    const count = state.faces.length;
    return { label: "Faces to leave open", status: count === 0 ? "None · the shell is hollowed closed" : `${count} selected`, count, clearable: count > 0 };
  }
  const placed = state.holePoint !== undefined;
  return { label: "Start point", status: placed ? `On the face at (${state.holePoint!.pointMm.map((value) => value.toFixed(1)).join(", ")}) mm` : "Select · click a face in the view", count: placed ? 1 : 0, clearable: placed };
}

/** The default texts of the fields a hole type brings with it, seeded when the type changes so no field starts empty. */
const HOLE_STYLE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  counterbore: { counterDiameter: "11", counterDepth: "4" },
  countersink: { sinkDiameter: "12", sinkAngle: "90" }
};

/** The hole fields a fastener size fills in; typing into one of them by hand puts the fastener select back to "custom". */
const FASTENER_SEEDED_FIELDS: readonly string[] = ["diameter", "counterDiameter", "counterDepth", "sinkDiameter", "threadPitch"];

/**
 * PT-16: the M-series fastener table, in the panel. Choosing a size (or switching the hole type or thread with one
 * chosen) fills the fields now in play from `METRIC_FASTENERS`: the clearance diameter for a plain hole, the socket-head
 * pocket for a counterbore, the head diameter and 90° for a countersink, and for a threaded hole the ISO coarse pitch
 * with the tap-drill (minor) diameter — so the thread's default major diameter lands on the nominal size. The free typed
 * values stay the primary path; the table only writes when a size is chosen.
 */
function fastenerSeedValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const spec = METRIC_FASTENERS[values["fastener"] ?? ""];
  if (spec === undefined) return {};
  const style = values["style"] ?? "simple";
  const thread = style === "simple" ? values["thread"] ?? "none" : "none";
  const pitchMm = COARSE_PITCH_MM[spec.nominalDiameterMm];
  const seed: Record<string, string> = {};
  if (thread !== "none" && pitchMm !== undefined) {
    seed["diameter"] = String(Number(tapDrillDiameterMm(spec.nominalDiameterMm, pitchMm).toFixed(2)));
    seed["threadPitch"] = String(pitchMm);
    // The edit dialog's hidden-by-default major diameter: seeded so the thread crest lands exactly on the nominal size.
    seed["threadMajor"] = String(spec.nominalDiameterMm);
  } else {
    seed["diameter"] = String(spec.clearanceDiameterMm);
  }
  if (style === "counterbore") {
    seed["counterDiameter"] = String(spec.counterboreDiameterMm);
    seed["counterDepth"] = String(spec.counterboreDepthMm);
  }
  if (style === "countersink") {
    seed["sinkDiameter"] = String(spec.countersinkDiameterMm);
    seed["sinkAngle"] = "90";
  }
  return seed;
}

export function panelWithValue(state: CommandPanelState, fieldId: string, text: string): CommandPanelState {
  const { error: _drop, ...rest } = state;
  void _drop;
  const values: Record<string, string> = { ...state.values, [fieldId]: text };
  if (fieldId === "style") {
    for (const [key, value] of Object.entries(HOLE_STYLE_DEFAULTS[text] ?? {})) if (values[key] === undefined || values[key] === "") values[key] = value;
  }
  if (fieldId === "thread" && text !== "none" && (values["threadPitch"] === undefined || values["threadPitch"] === "")) values["threadPitch"] = "1";
  // PT-16: a size typed by hand means custom sizes again — the select never claims a size the numbers no longer match.
  if (FASTENER_SEEDED_FIELDS.includes(fieldId) && (state.values["fastener"] ?? "custom") !== "custom") values["fastener"] = "custom";
  // Choosing a fastener size — or changing the type or thread with one chosen — fills the fields now in play from the table.
  if (fieldId === "fastener" || fieldId === "style" || fieldId === "thread") Object.assign(values, fastenerSeedValues(values));
  return { ...rest, values };
}

export function panelWithError(state: CommandPanelState, error: string): CommandPanelState {
  return { ...state, error };
}

/**
 * PT-14: Enter commits the panel from anywhere, exactly as its footer promises — after picking in the canvas too, when
 * focus has left the panel and sits on the body or the canvas. Focus inside a field or button of the panel is handled by
 * the panel's own key handler (which stops the event), another editable control keeps its own Enter, a modal dialog owns
 * the keyboard, and a commit that is already running is not doubled.
 */
export function panelGlobalKeyCommits(key: string, options: {
  readonly panelOpen: boolean;
  readonly editableTarget: boolean;
  readonly dialogOpen: boolean;
  readonly busy: boolean;
}): boolean {
  return key === "Enter" && options.panelOpen && !options.editableTarget && !options.dialogOpen && !options.busy;
}

/**
 * PT-15: while a command runs, the canvas stays in its picking mode — a navigation-mode switch (Select / Orbit / Pan on
 * the bar, or the V / O / P letters) must never silently disconnect the panel's picks and leave a live-looking panel that
 * clicks cannot reach. The switch answers with this line instead; the camera stays available the whole time through the
 * drag gestures, which work in every mode. Undefined = no panel is open, switch freely.
 */
export function panelNavigationLock(open: CommandPanelState | null): string | undefined {
  if (open === null) return undefined;
  return `${panelTitle(open)} is running: clicks in the view pick for its selection row (pan with the middle button, orbit with Shift + middle, zoom with the wheel). Esc cancels the command first.`;
}

export type PanelReopenPlan =
  | { readonly kind: "keep"; readonly message: string }
  | { readonly kind: "replace"; readonly note: string };

/**
 * PT-15: what starting a panel command does when the panel is already open. The same command keeps running with its picks
 * (Fusion does not restart a command under the user's hands), so pressing F twice never discards the picked edge runs;
 * another command — or a fresh start over an Edit Feature session — cancels the old one out loud and starts clean.
 */
export function panelReopenPlan(open: CommandPanelState | null, command: PanelCommand): PanelReopenPlan {
  if (open !== null && open.command === command && open.mode === "create") {
    return { kind: "keep", message: `${panelTitle(open)} is already running: clicks in the view pick for it, Enter commits, Esc cancels.` };
  }
  return { kind: "replace", note: open === null ? "" : `${panelTitle(open)} cancelled — nothing changed. ` };
}

/** Adds or removes a picked edge chain. The first pick fixes the body; a pick on another body restarts the set. */
export function panelToggleEdge(state: CommandPanelState, pick: PanelEdgeSet, bodyName: string): CommandPanelState {
  const { error: _drop, storedGroups: _stored, ...rest } = state;
  void _drop; void _stored;
  const samePick = (entry: PanelEdgeSet): boolean => entry.bodyId === pick.bodyId && entry.chain === pick.chain;
  if (state.edges.some(samePick)) return { ...rest, edges: state.edges.filter((entry) => !samePick(entry)) };
  const sameBody = state.edges.every((entry) => entry.bodyId === pick.bodyId);
  const edges = sameBody ? [...state.edges, pick] : [pick];
  if (edges.length > EDGE_BLEND_MAX_GROUPS) return { ...state, error: `One ${state.command} holds at most ${EDGE_BLEND_MAX_GROUPS} edge runs.` };
  return { ...rest, edges, bodyId: pick.bodyId, bodyName, ...(sameBody ? {} : { error: "The edges of one solid go in one feature; the set restarted on the newly picked solid." }) };
}

/** Adds a picked face (shell collects several; a second pick of the same place is ignored). */
export function panelAddFace(state: CommandPanelState, pick: PanelFacePick): CommandPanelState {
  const { error: _drop, ...rest } = state;
  void _drop;
  const close = (left: readonly number[], right: readonly number[]): boolean => Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!) < 0.5;
  if (state.faces.some((entry) => close(entry.ref.pointMm, pick.ref.pointMm) && close(entry.ref.normalMm, pick.ref.normalMm))) return state;
  return { ...rest, faces: [...state.faces, pick] };
}

/** Sets the hole's start point and direction (one per hole; a new pick replaces it). */
export function panelSetHolePoint(state: CommandPanelState, pointMm: readonly [number, number, number], normal: readonly [number, number, number], bodyId: string, bodyName: string): CommandPanelState {
  const { error: _drop, ...rest } = state;
  void _drop;
  return { ...rest, holePoint: { pointMm, normal }, bodyId, bodyName, values: { ...state.values, position: pointMm.map((value) => String(value)).join(", ") } };
}

export function panelClearSelection(state: CommandPanelState): CommandPanelState {
  const { error: _drop, holePoint: _point, ...rest } = state;
  void _drop; void _point;
  return { ...rest, edges: [], faces: [] };
}

/** The edge sets a commit stores: the freshly picked ones, or (edit without a re-pick) the stored ones. */
export function panelEdgeGroups(state: CommandPanelState): readonly EdgeBlendGroup[] {
  return state.edges.length > 0 ? state.edges.map((entry) => entry.group) : state.storedGroups ?? [];
}

export type PanelDraftResult =
  | { readonly ok: true; readonly feature: DesignSolidFeature }
  | { readonly ok: false; readonly message: string };

/**
 * The structural draft of the step: the selections (and, when editing, everything the existing step already stores), with
 * placeholder numbers where a value is new. The caller then applies the typed values through `applyParameterValues`, which
 * parses, range-checks and expression-binds them (the same path as the edit dialog), and commits the result.
 */
export function panelDraft(state: CommandPanelState, context: { readonly sketchFeatureId: string; readonly existing?: DesignSolidFeature }): PanelDraftResult {
  const bodyId = state.bodyId;
  if (bodyId === undefined) return { ok: false, message: state.command === "hole" ? "Click the face where the hole should start." : "Pick in the 3D view first." };
  const existing = context.existing;
  const id = state.editFeatureId ?? `feature:${state.command === "hole" ? "hole" : state.command === "shell" ? "shell" : "edge-blend"}-${crypto.randomUUID()}`;
  const base = { id, suppressed: false, sketchFeatureId: existing?.sketchFeatureId ?? context.sketchFeatureId, profileIds: [], bodyId, operation: "direct-edit" as const };
  if (state.command === "fillet" || state.command === "chamfer") {
    const groups = panelEdgeGroups(state);
    if (groups.length === 0) return { ok: false, message: "Click at least one edge in the view (Ctrl adds more runs)." };
    const start: DesignSolidFeature = existing ?? { ...base, name: state.command === "fillet" ? "Fillet" : "Chamfer", kind: "edge-blend", valueMm: 1 };
    return { ok: true, feature: { ...start, blendType: state.command, blendEdges: groups } };
  }
  if (state.command === "shell") {
    const openFaces = state.faces.map((entry) => entry.ref);
    const start: DesignSolidFeature = existing ?? { ...base, name: "Shell · pending", kind: "shell", valueMm: 1 };
    const spec = existing?.bodyEdit?.kind === "shell" ? existing.bodyEdit : { kind: "shell" as const, thicknessMm: 1, side: "inside" as const, openFaces };
    return { ok: true, feature: { ...start, bodyEdit: { ...spec, openFaces } } };
  }
  const point = state.holePoint;
  if (point === undefined) return { ok: false, message: "Click the face where the hole should start." };
  const style = state.values["style"] === "counterbore" ? "counterbore" : state.values["style"] === "countersink" ? "countersink" : "simple";
  const start: DesignSolidFeature = existing ?? { ...base, name: "Hole Ø 6.00", kind: "hole", valueMm: 6, holeDiameterMm: 6, holeDepthMm: 0 };
  // A style change drops the other styles' numbers so the stored step only carries what its type uses.
  const { holeCounterDiameterMm: _cbd, holeCounterDepthMm: _cbz, holeSinkDiameterMm: _skd, holeSinkAngleDeg: _ska, ...stripped } = start;
  // HS-15: a hole kept at the point it was placed keeps the faces it was placed from; a new pick drops them (the caller works out the new ones).
  const sameSpot = existing?.holePositionMm !== undefined && existing.holePositionMm.every((value, axis) => Math.abs(value - point.pointMm[axis]!) < 1e-6);
  const { holePlacement: _oldPlacement, ...unplaced } = stripped;
  void _oldPlacement;
  return {
    ok: true,
    feature: {
      ...(sameSpot ? stripped : unplaced), holeStyle: style, holePositionMm: point.pointMm, holeNormal: point.normal,
      ...(style === "counterbore" ? { holeCounterDiameterMm: _cbd ?? 11, holeCounterDepthMm: _cbz ?? 4 } : {}),
      ...(style === "countersink" ? { holeSinkDiameterMm: _skd ?? 12, holeSinkAngleDeg: _ska ?? 90 } : {})
    }
  };
}
