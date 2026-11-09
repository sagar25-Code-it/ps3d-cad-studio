import type { DesignFeature, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchDatumPlane, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { dependentsOf, designOf, HEALTH_NOTE_PREFIX, isHealthNote, isBodyEditFeature, isDirectEditFeature, isFeatureActive, modifiesBody, planeWorldCoordinate, splitPieceId, splitPieceName } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles, lostProfileRefs, profileOutlineMm, resolveProfileRegion, sampleArc, sampleArcToBound, sampleSpline, sampleSplineToBound } from "../../../packages/workbench-sketch/src/index.js";
import { attachEdgeFlange, attachMiterFlange, booleanMeshes, cutReliefNotch, developBend, flangeReliefs, holeCutter, jogSheetMesh, reliefCorners, snapToAxis, splitMeshPieces, threadBoreWall, isPlaced, placeDirection, placePositions, flatPatternOf, flatPatternOfPlate, layoutOfFlatPattern, sheetFrameOf, type BendRecord, type BentStripSpec, type FlatLayout, type HoleSpec } from "../../../packages/workbench-geometry/src/index.js";
import { flangeEdgesOf } from "../../../packages/workbench-core/src/index.js";
import { bendResolverOfStep, loftedBendBody, loftedBendFlat, plateFlangesOf, plateJogsOf } from "./sheet-metal-features.js";
import { combineGeneralBodies, createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";
import { applyPatternStep } from "./pattern-replay.js";
import { isToExtent, resolveExtent, trimToFace } from "./extent-resolve.js";
import { createThinRevolveBody, startRevolveAt } from "./revolve-thin.js";
import { blendBodyEdges } from "./edge-blend-step.js";
import { applyBodyEdit } from "./body-edit-replay.js";
import { revolveAboutChosenAxis } from "./revolve-feature.js";
import { followSketchFace } from "./sketch-face-follow.js";
import { buildLoftFeature, buildSweepFeature, needsSweepLoftBuilder, type SketchLookup } from "./sweep-loft-feature.js";

/**
 * Rebuilds the solids of the parametric timeline. The kernel is asynchronous, so the work happens here and its results
 * are applied to the project afterwards with the synchronous `regenerate-design` operation.
 */
export type SolidRebuild =
  | { readonly ok: true; readonly body: GeneralSolidBody; /** Something the builder noticed that does not stop the build (a lost reference, a changed fallback): shown on the feature as its health. */ readonly warning?: string; /** The same notes as separate lines, from the region detector (a gap closed within tolerance, an island dropped). */ readonly warnings?: readonly string[] }
  | { readonly ok: false; readonly message: string };

export interface RebuildResult {
  readonly featureId: string;
  readonly body?: GeneralSolidBody;
  /** Bodies a cut or hole severed from `body`; they are named after it (see splitPieceId) and travel with it. */
  readonly pieces?: readonly GeneralSolidBody[];
  readonly message?: string;
  /** Set when the sketch this feature is built on lies on a face that moved: the offset the sketch now has, to be stored with it. */
  readonly sketchPlaneOffsetMm?: number;
}

export const NORMALS: Readonly<Record<SketchPlane, readonly [number, number, number]>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

export function planeKeyOf(plane: SketchDatumPlane): SketchPlane {
  return plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
}

/** How far from the sketch plane an extrusion starts, along the plane's normal: symmetric straddles it, flipped goes the other way. */
export function extrudeStartOffsetMm(feature: Pick<DesignSolidFeature, "kind" | "valueMm" | "direction" | "secondValueMm">): number {
  if (feature.kind !== "extrude") return 0;
  if (feature.direction === "two-side") return -(feature.secondValueMm ?? 0);
  const height = Math.abs(feature.valueMm);
  return feature.direction === "symmetric" ? -height / 2 : feature.direction === "flipped" ? -height : 0;
}

/** How far a revolve turns in all, and where on the sweep it starts (0 at the sketch plane; negative starts before it). */
export function revolveSpan(feature: Pick<DesignSolidFeature, "valueMm" | "direction" | "secondValueMm">): { readonly totalDeg: number; readonly startDeg: number } {
  const angle = Math.abs(feature.valueMm);
  if (feature.direction === "two-side") return { totalDeg: angle + (feature.secondValueMm ?? 0), startDeg: -(feature.secondValueMm ?? 0) };
  if (feature.direction === "symmetric") return { totalDeg: angle, startDeg: -angle / 2 };
  if (feature.direction === "flipped") return { totalDeg: angle, startDeg: -angle };
  return { totalDeg: angle, startDeg: 0 };
}

function shifted(body: GeneralSolidBody, normal: readonly [number, number, number], offsetMm: number): GeneralSolidBody {
  if (offsetMm === 0) return body;
  const positionsMm = body.positionsMm.map((value, index) => value + normal[index % 3]! * offsetMm);
  return { ...body, positionsMm };
}

/** Builds the solid a feature describes from the sketch snapshot it is based on. For a join or cut this is the tool solid. */
export async function rebuildSolidFeature(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, color = "#b9c2c8", sketchLookup?: SketchLookup): Promise<SolidRebuild> {
  if (feature.kind === "move-body" || feature.kind === "scale-body" || feature.kind === "move-face" || feature.kind === "offset-face" || feature.kind === "emboss" || feature.kind === "indent" || feature.kind === "sheet-edge-flange" || feature.kind === "hole" || feature.kind === "pattern" || feature.kind === "edge-blend" || feature.kind === "offset-region" || feature.kind === "replace-face" || feature.kind === "web" || feature.kind === "wrap" || feature.kind === "flex" || feature.kind === "sheet-jog" || feature.bodyEdit !== undefined) {
    return { ok: false, message: "A direct-edit / indent step is applied during timeline replay, not through the sketch-driven builder." };
  }
  const sketch = sketchFeature.sketch;
  const profiles = detectSketchProfiles(sketch);
  const lost = lostProfileRefs(profiles, feature.profileIds);
  if (lost.length > 0) return { ok: false, message: `${feature.name}: a profile this feature was built on no longer exists in its sketch (${lost.join("; ")}). Edit the sketch to close it again, or delete the feature.` };
  // The holes of a region are holes in every solid built from it (a thin-wall revolve follows the outline alone, and the other kinds take the outline only).
  const region = resolveProfileRegion(profiles, feature.profileIds, { includeIslands: feature.kind === "extrude" || feature.kind === "sweep" || feature.kind === "loft" || (feature.kind === "revolve" && feature.thinWallMm === undefined) });
  if (!region.ok) return { ok: false, message: `${feature.name}: ${region.diagnostics[0]?.message ?? "The sketch has no closed profile for this feature."}` };
  const groups = region.value.groups;
  if (groups.length > 1 && feature.kind !== "extrude" && feature.kind !== "revolve") {
    return { ok: false, message: `${feature.name}: a ${feature.kind} is built from one region, but ${groups.length} separate regions are selected. Select a single region, or use an extrude or revolve for several.` };
  }
  if (groups.length > 1 && feature.kind === "revolve" && feature.thinWallMm !== undefined) return { ok: false, message: `${feature.name}: a thin revolve follows one outline. Select a single region.` };
  const warnings = [...region.value.warnings, ...(feature.edge !== undefined && groups.some((group) => group.holes.length > 0) ? ["The chamfer or fillet is applied to the outline; the holes keep their sharp edges."] : [])];
  const plane = planeKeyOf(sketch.plane);
  if (feature.kind === "sheet-lofted-bend") {
    const lofted = loftedBendBody(feature, profiles, region.value.outer, plane, color);
    if (!lofted.ok) return lofted;
    const loftedPlaced = shifted(lofted.body, NORMALS[plane], sketch.planeOffsetMm ?? 0);
    return { ok: true, body: isPlaced(sketch) ? { ...loftedPlaced, positionsMm: placePositions(loftedPlaced.positionsMm, sketch) } : loftedPlaced };
  }
  const sweep = feature.kind === "revolve" ? revolveSpan(feature) : undefined;
  if (sweep !== undefined && sweep.totalDeg > 360 + 1e-9) return { ok: false, message: "A revolve cannot turn more than 360 degrees in all. Use a smaller angle." };
  const reach = feature.kind === "extrude" && feature.direction === "two-side" ? Math.abs(feature.valueMm) + (feature.secondValueMm ?? 0) : sweep?.totalDeg ?? Math.abs(feature.valueMm);
  // A revolve about a chosen axis, or a profile on the negative side of the Y axis, is built in a frame where the axis is Y.
  if (feature.kind === "revolve") {
    const chosen = await revolveAboutChosenAxis(feature, sketchFeature, region.value, plane, sweep!, color);
    if (chosen !== undefined) {
      if (!chosen.ok) return chosen;
      const chosenPlaced = shifted(chosen.body, NORMALS[plane], sketch.planeOffsetMm ?? 0);
      return { ok: true, body: isPlaced(sketch) ? { ...chosenPlaced, positionsMm: placePositions(chosenPlaced.positionsMm, sketch) } : chosenPlaced, ...(chosen.warning === undefined ? {} : { warning: chosen.warning }) };
    }
  }
  if (feature.kind === "revolve" && feature.thinWallMm !== undefined) {
    if (region.value.holes.length > 0) return { ok: false, message: "A thin revolve follows one outline. Select the outer profile alone." };
    const thin = await createThinRevolveBody({ outlineMm: profileOutlineMm(region.value.outer.boundary), plane, angleDeg: reach, wallMm: feature.thinWallMm, side: feature.thinSide ?? "inside", bodyId: feature.bodyId, name: feature.name, color });
    if (!thin.ok) return { ok: false, message: thin.message };
    const started = sweep === undefined || sweep.startDeg === 0 ? thin.body : { ...thin.body, positionsMm: startRevolveAt(thin.body.positionsMm, plane, sweep.startDeg) };
    const thinPlaced = shifted(started, NORMALS[plane], sketch.planeOffsetMm ?? 0);
    return { ok: true, body: isPlaced(sketch) ? { ...thinPlaced, positionsMm: placePositions(thinPlaced.positionsMm, sketch) } : thinPlaced };
  }
  // A sweep along a chain of curves (possibly from another sketch), a loft between planes, and sweeps or lofts of profiles with holes.
  if ((feature.kind === "sweep" || feature.kind === "loft") && needsSweepLoftBuilder(feature, region.value.holes.length)) {
    const special = feature.kind === "sweep" ? await buildSweepFeature(feature, sketchFeature, region.value, color, sketchLookup) : await buildLoftFeature(feature, sketchFeature, region.value, color, sketchLookup);
    if (!special.ok) return special;
    return { ok: true, body: special.body, ...(special.warning === undefined ? {} : { warning: special.warning }) };
  }
  const built = await createGeneralSolidBody({
    profile: region.value.outer,
    plane,
    operation: feature.kind,
    valueMm: reach,
    ...(region.value.holes.length === 0 ? {} : { holes: region.value.holes }),
    ...(groups.length > 1 ? { extraGroups: groups.slice(1).map((group) => ({ profile: group.outer, holes: group.holes })) } : {}),
    bodyId: feature.bodyId,
    name: feature.name,
    color,
    ...(feature.edge === undefined ? {} : { edge: feature.edge }),
    ...(feature.kind === "sweep" && feature.sweepDirectionMm !== undefined ? { sweepDirectionMm: feature.sweepDirectionMm } : {}),
    ...(feature.kind === "sweep" && feature.sweepPathEntityId !== undefined ? (() => {
      const pathEntity = sketch.entities.find((entity) => entity.id === feature.sweepPathEntityId);
      if (pathEntity === undefined) return {};
      let samples: readonly (readonly [number, number])[] = [];
      if (pathEntity.kind === "line") samples = [pathEntity.start, pathEntity.end];
      else if (pathEntity.kind === "arc") samples = sampleArcToBound(pathEntity.start, pathEntity.mid, pathEntity.end);
      else if (pathEntity.kind === "spline") samples = sampleSplineToBound(pathEntity.fitPoints);
      return samples.length >= 2 ? { sweepPathSamplesMm: samples } : {};
    })() : {}),
    ...(feature.kind === "loft" && feature.loftTopScale !== undefined ? { loftTopScale: feature.loftTopScale } : {}),
    ...(feature.kind === "loft" && feature.loftSecondaryProfileIds !== undefined && feature.loftSecondaryProfileIds.length > 0 ? (() => {
      const secondary = resolveProfileRegion(profiles, feature.loftSecondaryProfileIds!, { includeIslands: false });
      return secondary.ok ? { loftSecondaryProfile: secondary.value.outer } : {};
    })() : {}),
    ...(feature.kind === "loft" && feature.loftContinuity !== undefined ? { loftContinuity: feature.loftContinuity } : {}),
    ...(feature.kind === "loft" && feature.loftRailEntityId !== undefined ? (() => {
      const railEntity = sketch.entities.find((entity) => entity.id === feature.loftRailEntityId);
      if (railEntity === undefined) return {};
      let samples: readonly (readonly [number, number])[] = [];
      if (railEntity.kind === "line") samples = [railEntity.start, railEntity.end];
      else if (railEntity.kind === "arc") samples = sampleArcToBound(railEntity.start, railEntity.mid, railEntity.end);
      else if (railEntity.kind === "spline") samples = sampleSplineToBound(railEntity.fitPoints);
      return samples.length >= 2 ? { loftRailSamplesMm: samples } : {};
    })() : {}),
    ...(feature.kind === "sweep" && feature.sweepTwistDeg !== undefined ? { sweepTwistDeg: feature.sweepTwistDeg } : {}),
    ...(feature.kind === "sweep" && feature.sweepFrameTransport !== undefined ? { sweepFrameTransport: feature.sweepFrameTransport } : {}),
    ...(feature.kind === "loft" && feature.loftTangencyWeight !== undefined ? { loftTangencyWeight: feature.loftTangencyWeight } : {}),
    ...(feature.kind === "helix" && feature.helixRadiusMm !== undefined ? { helixRadiusMm: feature.helixRadiusMm } : {}),
    ...(feature.kind === "helix" && feature.helixPitchMm !== undefined ? { helixPitchMm: feature.helixPitchMm } : {}),
    ...(feature.kind === "helix" && feature.helixTurns !== undefined ? { helixTurns: feature.helixTurns } : {}),
    ...(feature.kind === "helix" && feature.helixHandedness !== undefined ? { helixHandedness: feature.helixHandedness } : {}),
    ...(feature.kind === "thread" && feature.threadPitchMm !== undefined ? { threadPitchMm: feature.threadPitchMm } : {}),
    ...(feature.kind === "thread" && feature.threadTurns !== undefined ? { threadTurns: feature.threadTurns } : {}),
    ...(feature.kind === "thread" && feature.threadDepthMm !== undefined ? { threadDepthMm: feature.threadDepthMm } : {}),
    ...(feature.kind === "thread" && feature.threadHandedness !== undefined ? { threadHandedness: feature.threadHandedness } : {}),
    ...(feature.kind === "rib" && feature.ribThicknessMm !== undefined ? { ribThicknessMm: feature.ribThicknessMm } : {}),
    ...(feature.kind === "rib" && feature.ribDirection !== undefined ? { ribDirection: feature.ribDirection } : {}),
    ...(feature.kind === "dome" && feature.domeHeightMm !== undefined ? { domeHeightMm: feature.domeHeightMm } : {}),
    ...((feature.kind === "sheet-base" || feature.kind === "sheet-flange" || feature.kind === "sheet-hem") && feature.sheetThicknessMm !== undefined ? { sheetThicknessMm: feature.sheetThicknessMm } : {}),
    ...((feature.kind === "sheet-flange" || feature.kind === "sheet-hem") && feature.sheetBendRadiusMm !== undefined ? { sheetBendRadiusMm: feature.sheetBendRadiusMm } : {}),
    ...((feature.kind === "sheet-flange" || feature.kind === "sheet-hem") && feature.flangeLengthMm !== undefined ? { flangeLengthMm: feature.flangeLengthMm } : {}),
    ...(feature.kind === "sheet-flange" && feature.flangeAngleDeg !== undefined ? { flangeAngleDeg: feature.flangeAngleDeg } : {}),
    ...(feature.kind === "sheet-hem" && feature.hemStyle !== undefined ? { hemStyle: feature.hemStyle } : {}),
    ...(feature.kind === "edge-fillet" && feature.edgeEndSizeMm !== undefined ? { edgeEndSizeMm: feature.edgeEndSizeMm } : {}),
    ...(feature.kind === "shell" && feature.shellThicknessMm !== undefined ? { shellThicknessMm: feature.shellThicknessMm } : {}),
    ...(feature.kind === "shell" && feature.shellOpenFace !== undefined ? { shellOpenFace: feature.shellOpenFace } : {}),
    ...(feature.kind === "draft" && feature.draftAngleDeg !== undefined ? { draftAngleDeg: feature.draftAngleDeg } : {}),
    ...(feature.kind === "draft" && feature.draftNeutralFace !== undefined ? { draftNeutralFace: feature.draftNeutralFace } : {})
  });
  if (!built.ok) return { ok: false, message: warnings.length === 0 ? built.message : `${built.message} ${warnings.join(" ")}` };
  const started = sweep === undefined || sweep.startDeg === 0 ? built.body : { ...built.body, positionsMm: startRevolveAt(built.body.positionsMm, plane, sweep.startDeg) };
  const placed = shifted(started, NORMALS[plane], extrudeStartOffsetMm(feature) + (sketch.planeOffsetMm ?? 0));
  // A sketch on an angle or three-point plane is built on its datum plane and then moved onto that plane, which keeps the face names.
  const allWarnings = built.note === undefined ? warnings : [...warnings, built.note];
  return { ok: true, body: isPlaced(sketch) ? { ...placed, positionsMm: placePositions(placed.positionsMm, sketch) } : placed, ...(allWarnings.length === 0 ? {} : { warnings: allWarnings }) };
}

/**
 * Begins a rebuild message that is a note about a step that WAS applied (a hole of the region was left out, a circle crossing its outline
 * did not become a hole), as opposed to the reason a step could not be rebuilt. Both are stored as the feature's health message.
 */
export const REBUILD_NOTE_PREFIX = HEALTH_NOTE_PREFIX;

export function isRebuildNote(message: string | undefined): boolean {
  return isHealthNote(message);
}

/** Whether a rebuild result says its step could not be applied (a note alone does not). */
export function isRebuildFailure(result: { readonly message?: string | undefined }): boolean {
  return result.message !== undefined && !isRebuildNote(result.message);
}

/** A rebuild message the `regenerate-design` operation accepts (at most 400 characters). */
function clipMessage(text: string): string {
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

/** Finds a sketch feature of the timeline by ID, for the sweeps and lofts that take curves or profiles from a sketch other than their own. */
export function sketchLookupOf(history: ReturnType<typeof designOf>): SketchLookup {
  return (featureId) => history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === featureId && candidate.kind === "sketch");
}

/** The direction a sketch's solids rise in: its datum plane's normal, moved onto the sketch's tilt or three-point plane. */
export function sketchNormal(sketch: DesignSketchFeature): readonly [number, number, number] {
  return placeDirection(NORMALS[planeKeyOf(sketch.sketch.plane)], sketch.sketch);
}

const PLANE_AXIS: Readonly<Record<SketchPlane, 0 | 1 | 2>> = { xy: 2, xz: 1, yz: 0 };

/**
 * Turns a through-all cut into the distance that reaches across the whole body right now: a symmetric extrusion
 * about the sketch plane, long enough to pass the body's furthest point on the plane's axis with 1 mm to spare.
 */
export function throughAllOverride(step: DesignSolidFeature, sketchFeature: DesignSketchFeature, targetBody: GeneralSolidBody): DesignSolidFeature {
  const sketch = sketchFeature;
  // On a tilted or three-point sketch plane, measure in the plane's own frame by moving the body back first.
  const target = isPlaced(sketch.sketch) ? { ...targetBody, positionsMm: placePositions(targetBody.positionsMm, sketch.sketch, true) } : targetBody;
  const axis = PLANE_AXIS[planeKeyOf(sketch.sketch.plane)];
  const planeCoordinate = planeWorldCoordinate(sketch.sketch.plane, sketch.sketch.planeOffsetMm ?? 0).valueMm;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = axis; index < target.positionsMm.length; index += 3) {
    const value = target.positionsMm[index]!;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return step;
  const halfSpanMm = Math.max(Math.abs(minimum - planeCoordinate), Math.abs(maximum - planeCoordinate)) + 1;
  return { ...step, valueMm: halfSpanMm * 2, direction: "symmetric" };
}

/** The steps that shape a body, in timeline order: the step that made it, then its joins and cuts. */
function stepsOfBody(history: ReturnType<typeof designOf>, bodyId: string): readonly DesignSolidFeature[] {
  return history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch" && feature.bodyId === bodyId);
}

/**
 * Replays one body: builds it from the step that made it, then applies each live join and cut in order. A step that
 * cannot be applied is reported and skipped, so the body shows what the other steps make. Steps that are suppressed, rolled
 * back or built on a suppressed sketch are left out, which is what makes suppress and rollback change the shape.
 *
 * A body with no joins or cuts is always rebuilt, even while it is off, so its stored shape never goes stale; a body with
 * joins or cuts is only replayed while its own step is live.
 */
export async function replayBody(project: WorkbenchProject, bodyId: string, fresh?: ReadonlyMap<string, GeneralSolidBody>): Promise<readonly RebuildResult[]> {
  return (await replayBodyState(project, bodyId, Infinity, 0, fresh)).results;
}

/** The finished shapes of bodies replayed up to a timeline position, shared by the copies of one pattern so the source is only replayed once. */
const SNAPSHOTS = new WeakMap<WorkbenchProject, Map<string, Promise<GeneralSolidBody | undefined>>>();
const MAX_PATTERN_DEPTH = 8;

/** The shape of a body just before a timeline position (a pattern copies it as it was at that step, not as later steps leave it). */
function bodyBefore(project: WorkbenchProject, bodyId: string, limitIndex: number, depth: number): Promise<GeneralSolidBody | undefined> {
  let cache = SNAPSHOTS.get(project);
  if (cache === undefined) { cache = new Map(); SNAPSHOTS.set(project, cache); }
  const key = `${bodyId}@${limitIndex}`;
  let found = cache.get(key);
  if (found === undefined) {
    found = depth > MAX_PATTERN_DEPTH ? Promise.resolve(undefined) : replayBodyState(project, bodyId, limitIndex, depth + 1).then((state) => state.current);
    cache.set(key, found);
  }
  return found;
}

/** Replays one body and also returns its finished shape. With `limitIndex`, the replay stops before the timeline step at that position. */
export async function replayBodyState(project: WorkbenchProject, bodyId: string, limitIndex = Infinity, depth = 0, fresh?: ReadonlyMap<string, GeneralSolidBody>): Promise<{ readonly results: readonly RebuildResult[]; readonly current?: GeneralSolidBody }> {
  const history = designOf(project);
  const steps = stepsOfBody(history, bodyId);
  const base = steps.find((step) => !modifiesBody(step));
  if (base === undefined) return { results: [] };
  const chained = steps.some(modifiesBody);
  if (chained && !isFeatureActive(history, base.id)) return { results: [] };
  const existing = project.part.generalBodies?.find((body) => body.id === bodyId);
  const outcomes = new Map<string, RebuildResult>();
  let current: GeneralSolidBody | undefined;
  let baseBody: GeneralSolidBody | undefined;
  let lastJog: { readonly edgeIndex: number; readonly endMm: number } | undefined;
  // A cut or hole that severs the body leaves several closed pieces: the largest carries on as the body, the rest are kept here.
  const pieces: GeneralSolidBody[] = [];
  // Edge flanges already on the body, and the corners whose relief notch has been cut.
  const attachedFlanges = new Set<number>();
  const notchedCorners = new Set<string>();
  const keepPiece = (piece: GeneralSolidBody): void => { pieces.push({ ...piece, color: current?.color ?? piece.color }); };
  for (const step of steps) {
    // A lone body is rebuilt whatever its state; the steps of a chain only while they are live.
    if (chained && !isFeatureActive(history, step.id)) continue;
    if (history.features.indexOf(step) >= limitIndex) break;
    // Pattern: copy this body (or repeat some of its features) at the positions the pattern lays out.
    if (step.kind === "pattern") {
      const pattern = step.pattern;
      const groupStart = pattern === undefined ? -1 : history.features.findIndex((other) => other.kind !== "sketch" && other.pattern?.groupId === pattern.groupId);
      const applied = await applyPatternStep(step, current, {
        project,
        existing,
        sourceSnapshot: (sourceId) => bodyBefore(project, sourceId, groupStart < 0 ? history.features.indexOf(step) : groupStart, depth),
        stepOf: (id) => { const found = history.features.find((candidate): candidate is DesignSolidFeature => candidate.id === id && candidate.kind !== "sketch"); return found !== undefined && isFeatureActive(history, id) ? found : undefined; },
        sketchOf: (id) => history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === id && candidate.kind === "sketch"),
        rebuildTool: rebuildSolidFeature,
        sizeThroughAll: throughAllOverride,
        holeTool
      });
      if (!applied.ok) { outcomes.set(step.id, { featureId: step.id, message: applied.message }); continue; }
      current = applied.body;
      outcomes.set(step.id, { featureId: step.id, ...(applied.note === undefined ? {} : { message: applied.note }) });
      continue;
    }
    // Edge flanges and jogs bend a flat plate; a lofted bend (or a standalone flange or hem) has no flat top face to bend them from.
    if ((step.kind === "sheet-edge-flange" || step.kind === "sheet-jog") && base.kind === "sheet-lofted-bend") { outcomes.set(step.id, { featureId: step.id, message: "A lofted bend has no flat plate to bend flanges or jogs from; use a Sheet base or an extruded plate." }); continue; }
    if (step.kind === "sheet-jog" && (base.kind === "sheet-flange" || base.kind === "sheet-hem")) { outcomes.set(step.id, { featureId: step.id, message: "A jog bends a flat plate; use a Sheet base or an extruded plate." }); continue; }
    // Edge flange: bend a flange up from a named top-face edge of the sheet this body started as.
    if (step.kind === "sheet-edge-flange") {
      if (current === undefined || baseBody === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The sheet this flange bends from could not be built." }); continue; }
      const plateSketch = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === base.sketchFeatureId && candidate.kind === "sketch")?.sketch;
      const flatNormal = NORMALS[baseBody.feature?.plane ?? "xy"];
      const plateNormal = plateSketch === undefined ? flatNormal : placeDirection(flatNormal, plateSketch);
      const plateFrame = sheetFrameOf(baseBody, plateNormal);
      // Every edge a live flange step bends counts as flanged for corner relief; a miter flange's own corners are mitred, not relieved, so it carries no notch shape.
      const liveFlanges = steps.filter((other) => other.kind === "sheet-edge-flange" && isFeatureActive(history, other.id)).flatMap((other) => flangeEdgesOf(other).map((edgeIndex) => ({ edgeIndex, reliefMm: other.flangeReliefMm ?? 0, ...(other.flangeMiterEdges !== undefined || other.flangeReliefShape === undefined ? {} : { shape: other.flangeReliefShape }) })));
      const relief = plateFrame === undefined ? { startMm: 0, endMm: 0 } : flangeReliefs(plateFrame, step.flangeEdgeIndex ?? 0, liveFlanges);
      const chain = flangeEdgesOf(step);
      const attached = step.flangeMiterEdges !== undefined
        ? attachMiterFlange(current, baseBody, plateNormal, {
          edgeIndices: chain, innerRadiusMm: step.sheetBendRadiusMm ?? 0, flangeLengthMm: step.flangeLengthMm ?? 0, angleDeg: step.flangeAngleDeg ?? 0,
          freeEndReliefs: chain.map((edgeIndex) => plateFrame === undefined ? { startMm: 0, endMm: 0 } : flangeReliefs(plateFrame, edgeIndex, [{ edgeIndex, reliefMm: step.flangeReliefMm ?? 0 }, ...liveFlanges.filter((other) => !chain.includes(other.edgeIndex))]))
        })
        : attachEdgeFlange(current, baseBody, plateNormal, { edgeIndex: step.flangeEdgeIndex ?? 0, innerRadiusMm: step.sheetBendRadiusMm ?? 0, flangeLengthMm: step.flangeLengthMm ?? 0, angleDeg: step.flangeAngleDeg ?? 0, reliefStartMm: relief.startMm, reliefEndMm: relief.endMm });
      if (!attached.ok) { outcomes.set(step.id, { featureId: step.id, message: attached.message }); continue; }
      const { brep: _faceNames, ...withoutFaces } = current;
      void _faceNames;
      current = { ...withoutFaces, positionsMm: [...attached.positionsMm], indices: [...attached.indices] };
      for (const edgeIndex of chain) attachedFlanges.add(edgeIndex);
      // A corner relief cut as a notch is taken out of the plate once both flanges of the corner are on.
      let notchProblem: string | undefined;
      if (plateFrame !== undefined) {
        for (const corner of reliefCorners(plateFrame, liveFlanges.filter((flange) => attachedFlanges.has(flange.edgeIndex)))) {
          const key = `${corner.endEdge}>${corner.startEdge}`;
          if (notchedCorners.has(key)) continue;
          const notched = cutReliefNotch(current, plateFrame, corner);
          if (!notched.ok) { notchProblem = notched.message; continue; }
          notchedCorners.add(key);
          current = { ...current, positionsMm: [...notched.positionsMm], indices: [...notched.indices] };
        }
      }
      outcomes.set(step.id, notchProblem === undefined ? { featureId: step.id } : { featureId: step.id, message: notchProblem });
      continue;
    }
    // Jog: step the far side of the sheet up or down with two opposite bends.
    if (step.kind === "sheet-jog") {
      if (current === undefined || baseBody === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The sheet this jog bends could not be built." }); continue; }
      if (lastJog !== undefined && lastJog.edgeIndex !== (step.jogEdgeIndex ?? 0)) { outcomes.set(step.id, { featureId: step.id, message: "All jogs of one sheet must run parallel to the same edge, so they can be unfolded together." }); continue; }
      if (lastJog !== undefined && (step.jogPositionMm ?? 0) < lastJog.endMm - 1e-6) { outcomes.set(step.id, { featureId: step.id, message: `This jog starts ${(step.jogPositionMm ?? 0).toFixed(2)} mm from the edge, inside the previous jog (which ends ${lastJog.endMm.toFixed(2)} mm out). Put it further from the edge.` }); continue; }
      const jogSketch = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === base.sketchFeatureId && candidate.kind === "sketch")?.sketch;
      const jogFlatNormal = NORMALS[baseBody.feature?.plane ?? "xy"];
      const jogNormal = jogSketch === undefined ? jogFlatNormal : placeDirection(jogFlatNormal, jogSketch);
      const jogged = jogSheetMesh(current, baseBody, jogNormal, { edgeIndex: step.jogEdgeIndex ?? 0, positionMm: step.jogPositionMm ?? 0, offsetMm: step.jogOffsetMm ?? 0, angleDeg: step.jogAngleDeg ?? 0, innerRadiusMm: step.sheetBendRadiusMm ?? 0 });
      if (!jogged.ok) { outcomes.set(step.id, { featureId: step.id, message: jogged.message }); continue; }
      const { brep: _jogFaces, ...withoutJogFaces } = current;
      void _jogFaces;
      current = { ...withoutJogFaces, positionsMm: [...jogged.positionsMm], indices: [...jogged.indices] };
      lastJog = { edgeIndex: step.jogEdgeIndex ?? 0, endMm: (step.jogPositionMm ?? 0) + jogged.profile.runMm };
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    // Hole: drill at a recorded point on a face, straight into the material.
    if (step.kind === "hole") {
      if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this hole is drilled in could not be built." }); continue; }
      const drilled = drillHole(step, current);
      if (!drilled.ok) { outcomes.set(step.id, { featureId: step.id, message: drilled.message }); continue; }
      const { brep: _faceNames, ...withoutFaces } = current;
      void _faceNames;
      current = { ...withoutFaces, positionsMm: [...drilled.positionsMm], indices: [...drilled.indices] };
      for (const part of drilled.pieces ?? []) {
        const ordinal = pieces.length + 2;
        keepPiece({ id: splitPieceId(bodyId, ordinal), name: splitPieceName(current.name, ordinal), visible: true, color: current.color, positionsMm: [...part.positionsMm], indices: [...part.indices] });
      }
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    // Edge blend: fillet or chamfer the picked edges, found again on the body as it stands after the earlier steps.
    if (step.kind === "edge-blend") {
      if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this blend rounds could not be built." }); continue; }
      const blended = await blendBodyEdges(step, current);
      if (!blended.ok) { outcomes.set(step.id, { featureId: step.id, message: blended.message }); continue; }
      current = blended.body;
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    // Body edits (general shell, draft, offset region, replace face, web, wrap, flex) reshape the current body from picked faces or a transform.
    if (isBodyEditFeature(step)) {
      if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this step changes could not be built, so there is nothing to modify." }); continue; }
      const edited = await applyBodyEdit(step, current, { history });
      if (!edited.ok) { outcomes.set(step.id, { featureId: step.id, message: edited.message }); continue; }
      current = edited.body;
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    // Direct-edit steps (move-body / scale-body / move-face / offset-face / emboss) transform the current body in place.
    if (isDirectEditFeature(step)) {
      if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this step changes could not be built, so there is nothing to modify." }); continue; }
      current = applyDirectEdit(step, current);
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    // Indent: boolean-cut the referenced tool body out of the current body.
    if (step.kind === "indent") {
      if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "Indent needs an existing body to carve out of." }); continue; }
      const toolBody = project.part.generalBodies?.find((candidate) => candidate.id === step.indentToolBodyId);
      if (toolBody === undefined) { outcomes.set(step.id, { featureId: step.id, message: `Indent tool body '${step.indentToolBodyId}' is not in the part.` }); continue; }
      const combined = await combineGeneralBodies({ target: current, tool: toolBody, mode: "cut", bodyId, name: current.name, allowSplit: true });
      if (!combined.ok) { outcomes.set(step.id, { featureId: step.id, message: combined.message }); continue; }
      const parent = current;
      current = { ...combined.body, color: parent.color };
      for (const part of combined.pieces ?? []) keepPiece(renumberedPiece(part, bodyId, parent.name, pieces.length + 2));
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    const storedSketch = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === step.sketchFeatureId && candidate.kind === "sketch");
    if (storedSketch === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The sketch this feature was built on is no longer in the timeline." }); continue; }
    // A sketch drawn on a face follows that face as the solid is now (the body being replayed, one rebuilt earlier in this pass, or the stored one).
    const followed = followSketchFace(storedSketch, (id) => id === bodyId ? current : fresh?.get(id) ?? project.part.generalBodies?.find((candidate) => candidate.id === id));
    const sketchFeature = followed.sketchFeature;
    const modifies = modifiesBody(step);
    let sized = modifies && step.extent === "through-all" && current !== undefined ? throughAllOverride(step, sketchFeature, current) : step;
    // A "to" extent is measured from the target's shape as it is at this point of the replay.
    let trim: Extract<Awaited<ReturnType<typeof resolveExtent>>, { readonly ok: true }>["trim"];
    let warning: string | undefined;
    if (isToExtent(step.extent)) {
      const resolved = await resolveExtent(step, sketchFeature, { bodyOf: (id) => id === bodyId ? current : fresh?.get(id) ?? project.part.generalBodies?.find((candidate) => candidate.id === id) }, (probe) => rebuildSolidFeature(probe, sketchFeature, existing?.color));
      if (!resolved.ok) { outcomes.set(step.id, { featureId: step.id, message: resolved.message }); continue; }
      sized = resolved.step;
      trim = resolved.trim;
      warning = resolved.warning;
    }
    let built = await rebuildSolidFeature(modifies ? { ...sized, bodyId: `${step.id}:tool` } : sized, sketchFeature, existing?.color, sketchLookupOf(history));
    if (!built.ok) { outcomes.set(step.id, { featureId: step.id, message: built.message }); continue; }
    const notes = [followed.warning, warning, built.warning].filter((note): note is string => note !== undefined);
    // What the region detector said (a hole left out, a curve that crosses the outline) changes the solid, so it is kept on the feature too.
    const regionNotes = built.warnings ?? [];
    const noteText = regionNotes.length === 0 ? notes.join(" ") : `${REBUILD_NOTE_PREFIX}${[...notes, ...regionNotes].join(" ")}`;
    const applied: RebuildResult = { featureId: step.id, ...(noteText === "" ? {} : { message: clipMessage(noteText) }), ...(followed.movedToOffsetMm === undefined ? {} : { sketchPlaneOffsetMm: followed.movedToOffsetMm }) };
    if (trim !== undefined) {
      const trimmedTool = await trimToFace(built.body, trim);
      if (!trimmedTool.ok) { outcomes.set(step.id, { featureId: step.id, message: trimmedTool.message }); continue; }
      built = trimmedTool;
    }
    if (!modifies) { current = built.body; baseBody = built.body; outcomes.set(step.id, applied); continue; }
    if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this step changes could not be built, so there is nothing to modify." }); continue; }
    if (step.operation !== "join" && step.operation !== "cut") { outcomes.set(step.id, { featureId: step.id, message: "The modifier step has no boolean operation set." }); continue; }
    const combined = await combineGeneralBodies({ target: current, tool: built.body, mode: step.operation, bodyId, name: current.name, ...(step.operation === "cut" ? { allowSplit: true } : {}) });
    if (!combined.ok) { outcomes.set(step.id, { featureId: step.id, message: combined.message }); continue; }
    const parent = current;
    current = { ...combined.body, color: parent.color };
    for (const part of combined.pieces ?? []) keepPiece(renumberedPiece(part, bodyId, parent.name, pieces.length + 2));
    outcomes.set(step.id, applied);
  }
  // The final shape travels on the step that made the body; the other steps only report whether they applied. Pieces a cut severed ride with it.
  if (current !== undefined) outcomes.set(base.id, { ...(outcomes.get(base.id) ?? { featureId: base.id }), body: current, ...(pieces.length === 0 ? {} : { pieces }) });
  const results = steps.flatMap((step) => { const outcome = outcomes.get(step.id); return outcome === undefined ? [] : [outcome]; });
  return current === undefined ? { results } : { results, current };
}

/** A piece the Boolean named for a single cut, renamed so its number continues after the pieces already split off this body. */
function renumberedPiece(piece: GeneralSolidBody, bodyId: string, name: string, ordinal: number): GeneralSolidBody {
  return { ...piece, id: splitPieceId(bodyId, ordinal), name: splitPieceName(name, ordinal) };
}

/** Replays every body of the timeline. */
export async function replayAllBodies(project: WorkbenchProject): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const bodyIds = [...new Set(history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId))];
  return replayBodies(project, bodyIds);
}

/** The bodies in an order where each comes after the bodies its steps reach for (a "to" extent), otherwise in the order given. */
function targetsFirst(history: ReturnType<typeof designOf>, bodyIds: readonly string[]): readonly string[] {
  const wanted = new Set(bodyIds);
  const reaches = new Map<string, Set<string>>();
  for (const feature of history.features) {
    if (feature.kind === "sketch") continue;
    // A body reaches the body its extent ends at, and the body whose face its sketch lies on.
    const sketchFace = history.features.find((candidate) => candidate.id === feature.sketchFeatureId && candidate.kind === "sketch");
    const faceBody = sketchFace !== undefined && sketchFace.kind === "sketch" ? sketchFace.sketch.planeFace?.bodyId : undefined;
    for (const reached of [feature.extentTarget?.bodyId, faceBody]) {
      if (reached === undefined || reached === feature.bodyId) continue;
      const set = reaches.get(feature.bodyId) ?? new Set<string>();
      set.add(reached);
      reaches.set(feature.bodyId, set);
    }
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (bodyId: string): void => {
    if (seen.has(bodyId)) return;
    seen.add(bodyId);
    for (const target of reaches.get(bodyId) ?? []) if (wanted.has(target)) visit(target);
    ordered.push(bodyId);
  };
  for (const bodyId of bodyIds) visit(bodyId);
  return ordered;
}

/**
 * Replays the given bodies in timeline order. A body that reaches another one (an extrusion up to its face, say) sees that body as
 * just rebuilt in this same pass, not the older shape stored in the project.
 */
async function replayBodies(project: WorkbenchProject, bodyIds: readonly string[]): Promise<readonly RebuildResult[]> {
  const results: RebuildResult[] = [];
  const fresh = new Map<string, GeneralSolidBody>();
  for (const bodyId of targetsFirst(designOf(project), bodyIds)) {
    const replayed = await replayBody(project, bodyId, fresh);
    for (const result of replayed) if (result.body !== undefined) fresh.set(bodyId, result.body);
    results.push(...replayed);
  }
  return results;
}

/** Rebuilds the bodies that depend on a sketch feature, with their joins and cuts, in timeline order. */
export async function rebuildDependents(project: WorkbenchProject, sketchFeatureId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  if (!history.features.some((feature) => feature.id === sketchFeatureId && feature.kind === "sketch")) return [];
  const affected = new Set(dependentsOf(history, sketchFeatureId).filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId));
  // A body that reaches one of these (up to its face, vertex or itself) changes with it.
  for (let grew = true; grew;) {
    grew = false;
    for (const feature of history.features) {
      if (feature.kind === "sketch" || affected.has(feature.bodyId)) continue;
      const sketchFace = history.features.find((candidate) => candidate.id === feature.sketchFeatureId && candidate.kind === "sketch");
      const faceBody = sketchFace !== undefined && sketchFace.kind === "sketch" ? sketchFace.sketch.planeFace?.bodyId : undefined;
      // A body that reaches one of these (up to its face, or sketched on its face) changes with it.
      if (!((feature.extentTarget !== undefined && affected.has(feature.extentTarget.bodyId)) || (faceBody !== undefined && affected.has(faceBody)))) continue;
      affected.add(feature.bodyId);
      grew = true;
    }
  }
  const order = [...new Set(history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId))].filter((bodyId) => affected.has(bodyId));
  return replayBodies(project, order);
}

/** Whether any step of the design joins or cuts, which is when a change to the timeline has to be replayed rather than just shown or hidden. */
export function hasModifiers(project: WorkbenchProject): boolean {
  return designOf(project).features.some((feature: DesignFeature) => modifiesBody(feature) || feature.kind === "pattern" || (feature.kind !== "sketch" && isToExtent(feature.extent)));
}

/**
 * Apply a direct-edit step (move-body or scale-body) to the current body of a timeline replay. The operation runs in
 * place on the mesh positions: move translates every vertex by a world-space delta, scale shrinks or grows every vertex
 * about the body's current centroid. Both operations leave the index buffer and face names untouched, so the step is
 * reversible: deleting the step rolls the body back to its previous shape.
 */
export function applyDirectEdit(feature: DesignSolidFeature & { readonly kind: "move-body" | "scale-body" | "move-face" | "offset-face" | "emboss" }, body: GeneralSolidBody): GeneralSolidBody {
  if (feature.kind === "move-body") {
    const delta = feature.moveDeltaMm ?? [0, 0, 0];
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return body;
    const positionsMm = body.positionsMm.map((value, index) => value + delta[index % 3]!);
    return { ...body, positionsMm };
  }
  if (feature.kind === "scale-body") {
    const scale = feature.scaleFactor ?? 1;
    if (scale === 1) return body;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const count = body.positionsMm.length / 3;
    if (count === 0) return body;
    for (let index = 0; index < body.positionsMm.length; index += 3) {
      cx += body.positionsMm[index]!;
      cy += body.positionsMm[index + 1]!;
      cz += body.positionsMm[index + 2]!;
    }
    cx /= count; cy /= count; cz /= count;
    const positionsMm = body.positionsMm.map((value, index) => {
      const axis = index % 3;
      const center = axis === 0 ? cx : axis === 1 ? cy : cz;
      return center + (value - center) * scale;
    });
    return { ...body, positionsMm };
  }
  // move-face / offset-face / emboss: translate the vertices of one brep face.
  const role = feature.targetFaceRole;
  const brep = body.brep;
  if (role === undefined || brep === undefined) return body;
  const faceIndex = brep.faces.findIndex((face) => face.role === role);
  if (faceIndex < 0) return body;
  const faceTriangles = brep.faceTriangles ?? [];
  const faceVertexIndices = new Set<number>();
  for (let triangle = 0; triangle < faceTriangles.length; triangle += 1) {
    if (faceTriangles[triangle] !== faceIndex) continue;
    faceVertexIndices.add(body.indices[triangle * 3]!);
    faceVertexIndices.add(body.indices[triangle * 3 + 1]!);
    faceVertexIndices.add(body.indices[triangle * 3 + 2]!);
  }
  if (faceVertexIndices.size === 0) return body;
  let delta: readonly [number, number, number];
  let embossVertexShifts: Map<number, readonly [number, number, number]> | undefined;
  if (feature.kind === "move-face") {
    delta = feature.moveFaceDeltaMm ?? [0, 0, 0];
  } else if (feature.kind === "emboss") {
    // Compute face centroid in world space, then shift each vertex by embossHeightMm along the face normal attenuated by a
    // cosine falloff from the centroid (1.0 at centroid, 0.0 at the face's farthest vertex). Produces a soft raised pad.
    let nx = 0; let ny = 0; let nz = 0;
    let cx = 0; let cy = 0; let cz = 0;
    for (let triangle = 0; triangle < faceTriangles.length; triangle += 1) {
      if (faceTriangles[triangle] !== faceIndex) continue;
      const a = body.indices[triangle * 3]! * 3;
      const b = body.indices[triangle * 3 + 1]! * 3;
      const c = body.indices[triangle * 3 + 2]! * 3;
      const ux = body.positionsMm[b]! - body.positionsMm[a]!;
      const uy = body.positionsMm[b + 1]! - body.positionsMm[a + 1]!;
      const uz = body.positionsMm[b + 2]! - body.positionsMm[a + 2]!;
      const vx = body.positionsMm[c]! - body.positionsMm[a]!;
      const vy = body.positionsMm[c + 1]! - body.positionsMm[a + 1]!;
      const vz = body.positionsMm[c + 2]! - body.positionsMm[a + 2]!;
      nx += uy * vz - uz * vy;
      ny += uz * vx - ux * vz;
      nz += ux * vy - uy * vx;
    }
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) return body;
    const normal: readonly [number, number, number] = [nx / length, ny / length, nz / length];
    for (const vertex of faceVertexIndices) {
      cx += body.positionsMm[vertex * 3]!;
      cy += body.positionsMm[vertex * 3 + 1]!;
      cz += body.positionsMm[vertex * 3 + 2]!;
    }
    cx /= faceVertexIndices.size; cy /= faceVertexIndices.size; cz /= faceVertexIndices.size;
    // Farthest-vertex distance (for falloff normalization).
    let maxDist = 0;
    for (const vertex of faceVertexIndices) {
      const d = Math.hypot(body.positionsMm[vertex * 3]! - cx, body.positionsMm[vertex * 3 + 1]! - cy, body.positionsMm[vertex * 3 + 2]! - cz);
      if (d > maxDist) maxDist = d;
    }
    if (maxDist < 1e-9) return body;
    const height = feature.embossHeightMm ?? 0;
    embossVertexShifts = new Map<number, readonly [number, number, number]>();
    for (const vertex of faceVertexIndices) {
      const d = Math.hypot(body.positionsMm[vertex * 3]! - cx, body.positionsMm[vertex * 3 + 1]! - cy, body.positionsMm[vertex * 3 + 2]! - cz);
      const falloff = Math.max(0, 1 - d / maxDist);
      // Cosine-shaped falloff (smoother than linear): 0.5 * (1 + cos(π * (1 - falloff))).
      const shaped = 0.5 * (1 + Math.cos(Math.PI * (1 - falloff)));
      embossVertexShifts.set(vertex, [normal[0] * height * shaped, normal[1] * height * shaped, normal[2] * height * shaped]);
    }
    delta = [0, 0, 0];
  } else {
    // Offset along the face's average triangle normal.
    let nx = 0; let ny = 0; let nz = 0;
    for (let triangle = 0; triangle < faceTriangles.length; triangle += 1) {
      if (faceTriangles[triangle] !== faceIndex) continue;
      const a = body.indices[triangle * 3]! * 3;
      const b = body.indices[triangle * 3 + 1]! * 3;
      const c = body.indices[triangle * 3 + 2]! * 3;
      const ux = body.positionsMm[b]! - body.positionsMm[a]!;
      const uy = body.positionsMm[b + 1]! - body.positionsMm[a + 1]!;
      const uz = body.positionsMm[b + 2]! - body.positionsMm[a + 2]!;
      const vx = body.positionsMm[c]! - body.positionsMm[a]!;
      const vy = body.positionsMm[c + 1]! - body.positionsMm[a + 1]!;
      const vz = body.positionsMm[c + 2]! - body.positionsMm[a + 2]!;
      nx += uy * vz - uz * vy;
      ny += uz * vx - ux * vz;
      nz += ux * vy - uy * vx;
    }
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) return body;
    const offset = feature.offsetFaceMm ?? 0;
    delta = [(nx / length) * offset, (ny / length) * offset, (nz / length) * offset];
  }
  if (embossVertexShifts === undefined && delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return body;
  const positionsMm = [...body.positionsMm];
  for (const vertex of faceVertexIndices) {
    const shift = embossVertexShifts?.get(vertex) ?? delta;
    positionsMm[vertex * 3] = positionsMm[vertex * 3]! + shift[0];
    positionsMm[vertex * 3 + 1] = positionsMm[vertex * 3 + 1]! + shift[1];
    positionsMm[vertex * 3 + 2] = positionsMm[vertex * 3 + 2]! + shift[2];
  }
  return { ...body, positionsMm };
}

export type FlatPatternOutcome =
  | { readonly ok: true; readonly layout: FlatLayout; readonly summary: string; readonly notes: readonly string[]; readonly bends: readonly BendRecord[] }
  | { readonly ok: false; readonly message: string };

/**
 * Unfolds the sheet-metal body `bodyId` of the timeline into its flat pattern. A sheet base or extruded plate with edge flanges unfolds
 * to the blank with every live flange added (multi-bend); a standalone flange or hem unfolds to its single-bend strip.
 */
export async function flatPatternForBody(project: WorkbenchProject, bodyId: string): Promise<FlatPatternOutcome> {
  const history = designOf(project);
  const steps = stepsOfBody(history, bodyId);
  const base = steps.find((step) => !modifiesBody(step));
  if (base === undefined) return { ok: false, message: "This body is not in the timeline, so it has no sheet-metal steps to unfold." };
  const sketchFeature = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === base.sketchFeatureId && candidate.kind === "sketch");
  if (sketchFeature === undefined) return { ok: false, message: "The sketch this body was made from is no longer in the timeline." };
  // The body's bend table (kept on the step that made it) decides each bend's K-factor; without one every bend uses the default.
  const resolve = bendResolverOfStep(base);
  if (base.kind === "sheet-lofted-bend") {
    const loftProfiles = detectSketchProfiles(sketchFeature.sketch);
    const loftRegion = resolveProfileRegion(loftProfiles, base.profileIds, { includeIslands: false });
    if (!loftRegion.ok) return { ok: false, message: loftRegion.diagnostics[0]?.message ?? "The sketch has no closed profile for this lofted bend." };
    return loftedBendFlat(base, loftProfiles, loftRegion.value.outer, resolve);
  }
  if (base.kind === "sheet-flange" || base.kind === "sheet-hem") {
    const profiles = detectSketchProfiles(sketchFeature.sketch);
    const region = resolveProfileRegion(profiles, base.profileIds, { includeIslands: false });
    if (!region.ok) return { ok: false, message: region.diagnostics[0]?.message ?? "The sketch has no closed profile for this flange." };
    const xs = profileOutlineMm(region.value.outer.boundary).map((point) => point[0]);
    const hem = base.kind === "sheet-hem";
    const spec: BentStripSpec = {
      legMm: Math.max(...xs) - Math.min(...xs),
      flangeLengthMm: base.flangeLengthMm ?? 0,
      angleDeg: hem ? 180 : base.flangeAngleDeg ?? 0,
      innerRadiusMm: hem && (base.hemStyle ?? "closed") === "closed" ? 0.05 : base.sheetBendRadiusMm ?? 0,
      thicknessMm: base.sheetThicknessMm ?? 0,
      widthMm: Math.abs(base.valueMm)
    };
    if (!(spec.legMm > 0 && spec.flangeLengthMm > 0 && spec.thicknessMm > 0 && spec.widthMm > 0)) return { ok: false, message: "The flange has a zero dimension, so it cannot be unfolded." };
    const bend = developBend(resolve, spec.thicknessMm, spec.innerRadiusMm, spec.angleDeg);
    const pattern = flatPatternOf(spec, bend.kFactor);
    return { ok: true, layout: layoutOfFlatPattern(pattern), summary: `${pattern.flatLengthMm.toFixed(2)} x ${pattern.widthMm.toFixed(2)} mm blank, 1 bend, bend allowance ${pattern.bendAllowanceMm.toFixed(2)} mm (K ${bend.kFactor.toFixed(3)}, ${bend.source === "default" ? "default" : "bend table"})`, notes: [], bends: [bend] };
  }
  if (base.kind !== "sheet-base" && base.kind !== "extrude") return { ok: false, message: "Flat pattern needs a sheet-metal body: a Sheet base (or an extruded plate), optionally with edge flanges, or a Flange / Hem." };
  const rebuilt = await rebuildSolidFeature(base, sketchFeature);
  if (!rebuilt.ok) return { ok: false, message: rebuilt.message };
  const plane = rebuilt.body.feature?.plane ?? planeKeyOf(sketchFeature.sketch.plane);
  // A plate on a tilted or three-point sketch plane is moved back flat first, so its top face lies in the sketch's own plane.
  const flatBody = isPlaced(sketchFeature.sketch) ? { ...rebuilt.body, positionsMm: placePositions(rebuilt.body.positionsMm, sketchFeature.sketch, true) } : rebuilt.body;
  const frame = sheetFrameOf(flatBody, NORMALS[plane]);
  if (frame === undefined) return { ok: false, message: "This body has no flat top face with a thickness to unfold." };
  const live = (step: DesignSolidFeature): boolean => isFeatureActive(history, step.id);
  const plateFlanges = plateFlangesOf(frame, steps, live);
  if ("error" in plateFlanges) return { ok: false, message: plateFlanges.error };
  const pattern = flatPatternOfPlate(frame, plane, plateFlanges.flanges, resolve, plateJogsOf(steps, live));
  if ("error" in pattern) return { ok: false, message: pattern.error };
  const fromTable = pattern.bends.filter((bend) => bend.source !== "default").length;
  const tableNote = base.sheetBendTable === undefined ? [] : [`${fromTable} of ${pattern.bends.length} bends developed from the bend table${pattern.bends.length - fromTable === 0 ? "" : `, ${pattern.bends.length - fromTable} with its default K-factor ${base.sheetBendTable.defaultKFactor}`}.`];
  const width = pattern.boundsMm.maxX - pattern.boundsMm.minX;
  const height = pattern.boundsMm.maxY - pattern.boundsMm.minY;
  return { ok: true, layout: pattern, summary: `${width.toFixed(2)} x ${height.toFixed(2)} mm blank, ${pattern.bendCount} bend${pattern.bendCount === 1 ? "" : "s"}, ${frame.thicknessMm.toFixed(2)} mm thick`, notes: [...pattern.notes, ...tableNote], bends: pattern.bends };
}

export type HoleDrilling =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly pieces?: readonly { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }[] }
  | { readonly ok: false; readonly message: string };

/** The HoleSpec a hole step describes for a body: the through-all depth is measured against the body as it is now. */
export function holeSpecOf(step: DesignSolidFeature, body: { readonly positionsMm: readonly number[] }): HoleSpec | undefined {
  if (step.holePositionMm === undefined || step.holeNormal === undefined || step.holeDiameterMm === undefined || step.holeStyle === undefined) return undefined;
  const normal = snapToAxis(step.holeNormal);
  const origin = step.holePositionMm;
  let depth = step.holeDepthMm ?? 0;
  if (!(depth > 0)) {
    // Through all: far enough to leave the far side of the body along the hole's axis, plus a margin.
    let reach = 0;
    for (let i = 0; i + 2 < body.positionsMm.length; i += 3) {
      reach = Math.max(reach, -((body.positionsMm[i]! - origin[0]) * normal[0] + (body.positionsMm[i + 1]! - origin[1]) * normal[1] + (body.positionsMm[i + 2]! - origin[2]) * normal[2]));
    }
    depth = reach + 1;
  }
  return {
    style: step.holeStyle, originMm: origin, normal, diameterMm: step.holeDiameterMm, depthMm: depth,
    ...(step.holeCounterDiameterMm === undefined ? {} : { counterDiameterMm: step.holeCounterDiameterMm }),
    ...(step.holeCounterDepthMm === undefined ? {} : { counterDepthMm: step.holeCounterDepthMm }),
    ...(step.holeSinkDiameterMm === undefined ? {} : { sinkDiameterMm: step.holeSinkDiameterMm }),
    ...(step.holeSinkAngleDeg === undefined ? {} : { sinkAngleDeg: step.holeSinkAngleDeg }),
    ...(step.holeThread === undefined ? {} : { thread: { mode: step.holeThread.mode, pitchMm: step.holeThread.pitchMm, majorDiameterMm: step.holeThread.majorDiameterMm, handedness: step.holeThread.handedness, ...(step.holeThread.lengthMm === undefined ? {} : { lengthMm: step.holeThread.lengthMm }) } })
  };
}

/** The solid a hole step removes from a body, before it is cut: the cutter placed at the step's point and direction, sized to reach through if asked. A pattern of holes repeats this plain bore. */
export function holeTool(step: DesignSolidFeature, body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): HoleDrilling {
  const spec = holeSpecOf(step, body);
  if (spec === undefined) return { ok: false, message: "This hole has no position, direction or diameter recorded." };
  const cutter = holeCutter(spec);
  if (!cutter.ok) return { ok: false, message: cutter.message };
  return { ok: true, positionsMm: cutter.positionsMm, indices: cutter.indices };
}

/**
 * Cuts a hole step out of a body. The hole starts at `holePositionMm` on the face looking along `holeNormal` and goes the
 * other way; a depth of 0 (or none) drills through everything the axis meets.
 */
export function drillHole(step: DesignSolidFeature, body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): HoleDrilling {
  const spec = holeSpecOf(step, body);
  if (spec === undefined) return { ok: false, message: "This hole has no position, direction or diameter recorded." };
  const cutter = holeCutter(spec);
  if (!cutter.ok) return { ok: false, message: cutter.message };
  const cut = booleanMeshes({ positionsMm: body.positionsMm, indices: body.indices }, { positionsMm: cutter.positionsMm, indices: cutter.indices }, "cut", { allowSplit: true });
  if (!cut.ok) return { ok: false, message: `The hole could not be cut: ${cut.message}` };
  if (spec.thread?.mode === "modelled") {
    // The plain tap-drill bore is cut first, then its wall is reshaped into the helical groove.
    if (cut.value.pieceCount > 1) return { ok: false, message: "A modelled thread cannot be cut in a hole that severs the body; use a cosmetic thread or a smaller hole." };
    const threaded = threadBoreWall({ positionsMm: cut.value.positionsMm, indices: cut.value.indices }, spec, spec.thread);
    if (!threaded.ok) return { ok: false, message: threaded.message };
    return { ok: true, positionsMm: threaded.positionsMm, indices: threaded.indices };
  }
  if (cut.value.pieceCount <= 1) return { ok: true, positionsMm: cut.value.positionsMm, indices: cut.value.indices };
  // A hole wider than what it passes through severs the body: the largest piece stays the body, the others are returned beside it.
  const parts = splitMeshPieces(cut.value.positionsMm, cut.value.indices);
  return { ok: true, positionsMm: parts[0]!.positionsMm, indices: parts[0]!.indices, pieces: parts.slice(1).map((part) => ({ positionsMm: part.positionsMm, indices: part.indices })) };
}
