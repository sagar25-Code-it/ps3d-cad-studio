import type { DesignFeature, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchDatumPlane, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { dependentsOf, designOf, isDirectEditFeature, isFeatureActive, modifiesBody, planeWorldCoordinate } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles, resolveProfileRegion, sampleArc, sampleSpline } from "../../../packages/workbench-sketch/src/index.js";
import { combineGeneralBodies, createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";

/**
 * Rebuilds the solids of the parametric timeline. The kernel is asynchronous, so the work happens here and its results
 * are applied to the project afterwards with the synchronous `regenerate-design` operation.
 */
export type SolidRebuild =
  | { readonly ok: true; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

export interface RebuildResult {
  readonly featureId: string;
  readonly body?: GeneralSolidBody;
  readonly message?: string;
}

const NORMALS: Readonly<Record<SketchPlane, readonly [number, number, number]>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

export function planeKeyOf(plane: SketchDatumPlane): SketchPlane {
  return plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
}

/** How far from the sketch plane an extrusion starts, along the plane's normal: symmetric straddles it, flipped goes the other way. */
export function extrudeStartOffsetMm(feature: Pick<DesignSolidFeature, "kind" | "valueMm" | "direction">): number {
  if (feature.kind !== "extrude") return 0;
  const height = Math.abs(feature.valueMm);
  return feature.direction === "symmetric" ? -height / 2 : feature.direction === "flipped" ? -height : 0;
}

function shifted(body: GeneralSolidBody, normal: readonly [number, number, number], offsetMm: number): GeneralSolidBody {
  if (offsetMm === 0) return body;
  const positionsMm = body.positionsMm.map((value, index) => value + normal[index % 3]! * offsetMm);
  return { ...body, positionsMm };
}

/** Builds the solid a feature describes from the sketch snapshot it is based on. For a join or cut this is the tool solid. */
export async function rebuildSolidFeature(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, color = "#b9c2c8"): Promise<SolidRebuild> {
  if (feature.kind === "move-body" || feature.kind === "scale-body" || feature.kind === "move-face" || feature.kind === "offset-face" || feature.kind === "emboss" || feature.kind === "indent") {
    return { ok: false, message: "A direct-edit / indent step is applied during timeline replay, not through the sketch-driven builder." };
  }
  const sketch = sketchFeature.sketch;
  const profiles = detectSketchProfiles(sketch);
  const missing = feature.profileIds.find((id) => !profiles.some((profile) => profile.id === id));
  if (missing !== undefined) return { ok: false, message: "A profile this feature was built on no longer exists in its sketch. Edit the sketch to close it again, or delete the feature." };
  const region = resolveProfileRegion(profiles, feature.profileIds, { includeIslands: feature.kind === "extrude" && feature.edge === undefined });
  if (!region.ok) return { ok: false, message: region.diagnostics[0]?.message ?? "The sketch has no closed profile for this feature." };
  const plane = planeKeyOf(sketch.plane);
  const built = await createGeneralSolidBody({
    profile: region.value.outer,
    plane,
    operation: feature.kind,
    valueMm: Math.abs(feature.valueMm),
    ...(region.value.holes.length === 0 ? {} : { holes: region.value.holes }),
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
      else if (pathEntity.kind === "arc") samples = sampleArc(pathEntity.start, pathEntity.mid, pathEntity.end);
      else if (pathEntity.kind === "spline") samples = sampleSpline(pathEntity.fitPoints);
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
      else if (railEntity.kind === "arc") samples = sampleArc(railEntity.start, railEntity.mid, railEntity.end);
      else if (railEntity.kind === "spline") samples = sampleSpline(railEntity.fitPoints);
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
  if (!built.ok) return { ok: false, message: built.message };
  return { ok: true, body: shifted(built.body, NORMALS[plane], extrudeStartOffsetMm(feature) + (sketch.planeOffsetMm ?? 0)) };
}

const PLANE_AXIS: Readonly<Record<SketchPlane, 0 | 1 | 2>> = { xy: 2, xz: 1, yz: 0 };

/**
 * Turns a through-all cut into the distance that reaches across the whole body right now: a symmetric extrusion
 * about the sketch plane, long enough to pass the body's furthest point on the plane's axis with 1 mm to spare.
 */
export function throughAllOverride(step: DesignSolidFeature, sketch: DesignSketchFeature, target: GeneralSolidBody): DesignSolidFeature {
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
export async function replayBody(project: WorkbenchProject, bodyId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const steps = stepsOfBody(history, bodyId);
  const base = steps.find((step) => !modifiesBody(step));
  if (base === undefined) return [];
  const chained = steps.some(modifiesBody);
  if (chained && !isFeatureActive(history, base.id)) return [];
  const existing = project.part.generalBodies?.find((body) => body.id === bodyId);
  const outcomes = new Map<string, RebuildResult>();
  let current: GeneralSolidBody | undefined;
  for (const step of steps) {
    // A lone body is rebuilt whatever its state; the steps of a chain only while they are live.
    if (chained && !isFeatureActive(history, step.id)) continue;
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
      const combined = await combineGeneralBodies({ target: current, tool: toolBody, mode: "cut", bodyId, name: current.name });
      if (!combined.ok) { outcomes.set(step.id, { featureId: step.id, message: combined.message }); continue; }
      current = { ...combined.body, color: current.color };
      outcomes.set(step.id, { featureId: step.id });
      continue;
    }
    const sketchFeature = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === step.sketchFeatureId && candidate.kind === "sketch");
    if (sketchFeature === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The sketch this feature was built on is no longer in the timeline." }); continue; }
    const modifies = modifiesBody(step);
    const sized = modifies && step.extent === "through-all" && current !== undefined ? throughAllOverride(step, sketchFeature, current) : step;
    const built = await rebuildSolidFeature(modifies ? { ...sized, bodyId: `${step.id}:tool` } : sized, sketchFeature, existing?.color);
    if (!built.ok) { outcomes.set(step.id, { featureId: step.id, message: built.message }); continue; }
    if (!modifies) { current = built.body; outcomes.set(step.id, { featureId: step.id }); continue; }
    if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this step changes could not be built, so there is nothing to modify." }); continue; }
    if (step.operation !== "join" && step.operation !== "cut") { outcomes.set(step.id, { featureId: step.id, message: "The modifier step has no boolean operation set." }); continue; }
    const combined = await combineGeneralBodies({ target: current, tool: built.body, mode: step.operation, bodyId, name: current.name });
    if (!combined.ok) { outcomes.set(step.id, { featureId: step.id, message: combined.message }); continue; }
    current = { ...combined.body, color: current.color };
    outcomes.set(step.id, { featureId: step.id });
  }
  // The final shape travels on the step that made the body; the other steps only report whether they applied.
  if (current !== undefined) outcomes.set(base.id, { ...(outcomes.get(base.id) ?? { featureId: base.id }), body: current });
  return steps.flatMap((step) => { const outcome = outcomes.get(step.id); return outcome === undefined ? [] : [outcome]; });
}

/** Replays every body of the timeline. */
export async function replayAllBodies(project: WorkbenchProject): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const bodyIds = [...new Set(history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId))];
  const results: RebuildResult[] = [];
  for (const bodyId of bodyIds) results.push(...await replayBody(project, bodyId));
  return results;
}

/** Rebuilds the bodies that depend on a sketch feature, with their joins and cuts, in timeline order. */
export async function rebuildDependents(project: WorkbenchProject, sketchFeatureId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  if (!history.features.some((feature) => feature.id === sketchFeatureId && feature.kind === "sketch")) return [];
  const affected = new Set(dependentsOf(history, sketchFeatureId).filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId));
  const results: RebuildResult[] = [];
  for (const bodyId of affected) results.push(...await replayBody(project, bodyId));
  return results;
}

/** Whether any step of the design joins or cuts, which is when a change to the timeline has to be replayed rather than just shown or hidden. */
export function hasModifiers(project: WorkbenchProject): boolean {
  return designOf(project).features.some((feature: DesignFeature) => modifiesBody(feature));
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
