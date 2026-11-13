import { DATUM_PLANE_AXES } from "./sketch-world.js";
import { describeYzConvention, type SketchPlaneConventionRequest } from "../../../packages/workbench-core/src/index.js";
import type { SketchDatumPlane, SketchPlaneFrame, SketchPlaneTilt, WorkbenchSketch, WorkspaceId } from "../../../packages/workbench-core/src/index.js";

/**
 * Pure model behind the sketch-plane chrome: the plane chip in the Sketch ribbon and on the canvas, the status wording after a plane is
 * chosen, the "existing sketch planes" list of the plane dialog, and the rule for when entering the Sketch workspace offers the plane choice.
 * It has no React in it so the wording and the rules are tested directly.
 */

/** The three datum planes with the names the dialog, the chip and the canvas header all use. */
export const DATUM_PLANE_NAMES: Readonly<Record<SketchDatumPlane, { readonly name: string; readonly view: string; readonly hint: string }>> = {
  "datum:xy": { name: "Top (XY)", view: "Top view", hint: "Floor plane · Z up" },
  "datum:xz": { name: "Front (XZ)", view: "Front view", hint: "Looking along −Y" },
  "datum:yz": { name: "Right (YZ)", view: "Right view", hint: "Looking along +X" }
};

/**
 * The sketch X and Y axes of a datum plane in world terms. The world is Z up, so a sketch started on the Right (YZ) plane now runs its
 * vertical along world +Z and its horizontal along world +Y ("z-up", the default here). A sketch saved before that keeps the old mapping
 * (vertical along world +Y, horizontal along -Z: "legacy"), and says so wherever a plane is chosen or described (the plane dialog, the
 * status line, the revolve axis choice).
 */
export function sketchAxesInWorld(plane: SketchDatumPlane, convention: SketchPlaneConventionRequest = "z-up"): { readonly x: string; readonly y: string; readonly sentence: string } {
  const key = plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
  const axes = key === "yz" ? describeYzConvention(convention === "z-up") : DATUM_PLANE_AXES[key];
  return { x: axes.sketchX, y: axes.sketchY, sentence: `Sketch X runs along ${axes.sketchX}, sketch Y along ${axes.sketchY}` };
}

/** The line of small print under a plane in the plane dialog: the view direction and where the sketch axes point in the world. */
export function datumPlaneHint(plane: SketchDatumPlane): string {
  return `${DATUM_PLANE_NAMES[plane].hint} · ${sketchAxesInWorld(plane).sentence}`;
}

export type SketchPlaneShape = Pick<WorkbenchSketch, "plane" | "planeOffsetMm" | "planeTilt" | "planeFrame"> & { readonly planeConvention?: WorkbenchSketch["planeConvention"] | undefined };

/** The convention a sketch has, as an operation asks for it. */
export function conventionOf(sketch: { readonly planeConvention?: WorkbenchSketch["planeConvention"] | undefined }): SketchPlaneConventionRequest {
  return sketch.planeConvention === "z-up" ? "z-up" : "legacy";
}

export interface SketchPlaneDescription {
  /** "Top (XY)" or "Plane through three points". */
  readonly name: string;
  /** What is set on top of the base plane: "offset 25 mm", "tilted 45° about X", "origin (0, 0, 5)". Empty for a bare datum plane. */
  readonly details: readonly string[];
  /** The text of the persistent chip: "Sketch plane: Top (XY) · offset 25 mm". */
  readonly chip: string;
  /** A sentence for the status line: "Sketch plane: Top (XY), offset 25 mm. Sketch X runs along world +X, sketch Y along world +Y." */
  readonly status: string;
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

export function describeSketchPlane(sketch: SketchPlaneShape): SketchPlaneDescription {
  const details: string[] = [];
  let name: string;
  if (sketch.planeFrame !== undefined) {
    name = "Plane through three points";
    const origin = sketch.planeFrame.originMm;
    details.push(`origin (${origin.map(trimNumber).join(", ")}) mm`);
  } else {
    name = DATUM_PLANE_NAMES[sketch.plane].name;
    const offset = sketch.planeOffsetMm ?? 0;
    if (offset !== 0) details.push(`offset ${trimNumber(offset)} mm`);
    if (sketch.planeTilt !== undefined) details.push(`tilted ${trimNumber(sketch.planeTilt.angleDeg)}° about ${sketch.planeTilt.axis.toUpperCase()}`);
  }
  return {
    name,
    details,
    chip: `Sketch plane: ${[name, ...details].join(" · ")}`,
    // A plane through three points has its own axes (shown by the canvas); a datum plane says where its X and Y point in the world.
    status: `Sketch plane: ${[name, ...details].join(", ")}.${sketch.planeFrame === undefined && sketch.planeTilt === undefined ? ` ${sketchAxesInWorld(sketch.plane, conventionOf(sketch)).sentence}.` : ""}`
  };
}

/** One earlier sketch of the timeline, offered in the plane dialog so a new sketch can start on the same plane. */
export interface ExistingSketchPlane {
  readonly featureId: string;
  /** The timeline name, "Sketch 2". */
  readonly name: string;
  readonly plane: SketchDatumPlane;
  /** The same plane in the short form the plane dialog and the sketch-plane helpers use. */
  readonly sketchPlane: "xy" | "xz" | "yz";
  readonly offsetMm: number;
  readonly tilt?: SketchPlaneTilt;
  readonly frame?: SketchPlaneFrame;
  /** The plane mapping that sketch has, so a new sketch on "the same plane" lines up with it. */
  readonly convention: SketchPlaneConventionRequest;
  /** "Top (XY) · offset 25 mm". */
  readonly description: string;
}

interface TimelineLike {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly sketch?: SketchPlaneShape;
}

function placementKey(sketch: SketchPlaneShape): string {
  return JSON.stringify([sketch.plane, sketch.planeOffsetMm ?? 0, sketch.planeTilt ?? null, sketch.planeFrame ?? null, sketch.plane === "datum:yz" ? conventionOf(sketch) : null]);
}

/**
 * The planes earlier timeline sketches sit on, newest first, one entry per distinct placement. `current` (the plane the working
 * sketch is on) is left out because the dialog already shows it as the current plane.
 */
export function existingSketchPlanes(features: readonly TimelineLike[], current?: SketchPlaneShape, limit = 8): readonly ExistingSketchPlane[] {
  const seen = new Set<string>(current === undefined ? [] : [placementKey(current)]);
  const found: ExistingSketchPlane[] = [];
  for (const feature of [...features].reverse()) {
    if (feature.kind !== "sketch" || feature.sketch === undefined) continue;
    const key = placementKey(feature.sketch);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      featureId: feature.id,
      name: feature.name,
      plane: feature.sketch.plane,
      sketchPlane: feature.sketch.plane === "datum:xz" ? "xz" : feature.sketch.plane === "datum:yz" ? "yz" : "xy",
      offsetMm: feature.sketch.planeOffsetMm ?? 0,
      convention: conventionOf(feature.sketch),
      ...(feature.sketch.planeTilt === undefined ? {} : { tilt: feature.sketch.planeTilt }),
      ...(feature.sketch.planeFrame === undefined ? {} : { frame: feature.sketch.planeFrame }),
      description: [describeSketchPlane(feature.sketch).name, ...describeSketchPlane(feature.sketch).details].join(" · ")
    });
    if (found.length >= limit) break;
  }
  return found;
}

/** What the app remembers about offering the plane choice. */
export interface PlaneOfferState {
  /** The plane choice has been shown at least once this session. */
  readonly offered: boolean;
  /** The sketch was finished after the last offer, so the next entry offers again. */
  readonly finishedSinceOffer: boolean;
}

export const INITIAL_PLANE_OFFER: PlaneOfferState = { offered: false, finishedSinceOffer: false };

export interface PlaneOfferDecision {
  readonly offer: boolean;
  /** "set" moves an empty working sketch to the chosen plane; "new" finishes the working sketch and starts another. */
  readonly mode: "set" | "new";
  readonly next: PlaneOfferState;
}

/**
 * Decides what entering a workspace does. Only entering Sketch from another workspace can offer: the first time in a session, after
 * Finish Sketch, or whenever the working sketch is empty. The offer is never blocking (the dialog has a Continue button), so a
 * workspace that is not Sketch, or a re-click of the Sketch tab while already in it, never offers.
 */
export function decidePlaneOffer(state: PlaneOfferState, entering: WorkspaceId, from: WorkspaceId, sketchEntityCount: number): PlaneOfferDecision {
  const keep: PlaneOfferDecision = { offer: false, mode: "set", next: state };
  if (entering !== "sketch" || from === "sketch") return keep;
  const empty = sketchEntityCount === 0;
  if (!empty && state.offered && !state.finishedSinceOffer) return keep;
  return { offer: true, mode: empty ? "set" : "new", next: { offered: true, finishedSinceOffer: false } };
}

/** Records that Finish Sketch ran, so the next entry into Sketch offers the plane choice again. */
export function planeOfferAfterFinish(state: PlaneOfferState): PlaneOfferState {
  return { ...state, finishedSinceOffer: true };
}

/** What a "Create Sketch" or "Edit Sketch" entry of a right-click menu does. */
export type ContextSketchAction =
  /** Finish the working sketch into the timeline (if it has unrecorded work) and start a new, empty sketch on this origin plane. */
  | { readonly kind: "new-on-plane"; readonly plane: SketchDatumPlane }
  /** Finish the working sketch into the timeline and start a new, empty sketch on the face that is selected on this solid. */
  | { readonly kind: "new-on-face"; readonly bodyId: string }
  /** Ask which plane or face the new sketch goes on (the plane dialog in its "new sketch" mode). */
  | { readonly kind: "ask-plane" }
  /** Reopen a finished sketch of the timeline for editing. */
  | { readonly kind: "edit-feature"; readonly featureId: string }
  /** Go back into the working sketch as it is. */
  | { readonly kind: "open-working" };

/**
 * Decides what the right-click sketch commands do. Create Sketch always starts a NEW sketch: on the origin plane that was
 * right-clicked, or after asking for a plane when nothing that names one is selected. It never moves the sketch that is already
 * drawn (it used to re-plane the working sketch, which after Finish is still the last finished sketch). Edit Sketch is the only
 * command that reopens existing geometry: the timeline sketch that was right-clicked, or the working sketch.
 */
export function contextSketchAction(commandId: "sketch.create" | "sketch.edit", selectionId: string | null, sketchFeatureIds: readonly string[] = [], selectedFaceBodyId: string | null = null): ContextSketchAction {
  if (commandId === "sketch.edit") {
    return selectionId !== null && sketchFeatureIds.includes(selectionId) ? { kind: "edit-feature", featureId: selectionId } : { kind: "open-working" };
  }
  if (selectionId === "datum:xy" || selectionId === "datum:xz" || selectionId === "datum:yz") return { kind: "new-on-plane", plane: selectionId };
  // A face of the selected solid is picked: the sketch goes on that face, with no list to choose from.
  if (selectionId !== null && selectedFaceBodyId === selectionId) return { kind: "new-on-face", bodyId: selectionId };
  return { kind: "ask-plane" };
}

/** What a double-click on a browser row does. */
export type BrowserOpenAction =
  | { readonly kind: "edit-feature"; readonly featureId: string }
  | { readonly kind: "open-working" }
  | { readonly kind: "none" };

/**
 * Double-click in the browser opens the thing for editing, as the timeline strip does: a timeline step by the ID its row selects
 * (a sketch by its own ID, a solid through its body), or the working sketch's own row. Any other row only selects.
 */
export function browserOpenAction(rowId: string, timeline: readonly { readonly id: string; readonly selectionId: string }[], workingSketchId: string): BrowserOpenAction {
  const feature = timeline.find((candidate) => candidate.id === rowId) ?? timeline.find((candidate) => candidate.selectionId === rowId);
  if (feature !== undefined) return { kind: "edit-feature", featureId: feature.id };
  return rowId === workingSketchId ? { kind: "open-working" } : { kind: "none" };
}
