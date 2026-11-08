import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import {
  boundsTouch, concatMeshes, invertAffine, meshBounds, patternTransforms, transformDirection, transformMesh, transformPoint, transformPositions,
  type Affine, type PatternContext
} from "../../../packages/workbench-geometry/src/index.js";
import { stableFaceKey } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import { combineGeneralBodies } from "./general-modeling.js";
import type { HoleDrilling, SolidRebuild } from "./design-regeneration.js";

/** What a pattern step needs from the timeline replay. They are passed in so this module does not depend on the replay (which calls it). */
export interface PatternStepContext {
  readonly project: WorkbenchProject;
  /** The body this step's `bodyId` already has in the part, if any: its name and colour are kept when it is rebuilt. */
  readonly existing: GeneralSolidBody | undefined;
  /** The finished shape of a body as it was just before the first step of this pattern. */
  readonly sourceSnapshot: (bodyId: string) => Promise<GeneralSolidBody | undefined>;
  /** A solid step by ID, only while it is live (not suppressed, not rolled back). */
  readonly stepOf: (id: string) => DesignSolidFeature | undefined;
  readonly sketchOf: (id: string) => DesignSketchFeature | undefined;
  readonly rebuildTool: (feature: DesignSolidFeature, sketch: DesignSketchFeature, color?: string) => Promise<SolidRebuild>;
  readonly sizeThroughAll: (step: DesignSolidFeature, sketch: DesignSketchFeature, target: GeneralSolidBody) => DesignSolidFeature;
  readonly holeTool: (step: DesignSolidFeature, body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }) => HoleDrilling;
}

export type PatternApplied =
  | { readonly ok: true; readonly body: GeneralSolidBody; /** Something was skipped; the rest of the pattern still applied. */ readonly note?: string }
  | { readonly ok: false; readonly message: string };

/** The construction geometry a pattern may point at. */
export function patternContextOf(project: WorkbenchProject): PatternContext {
  return {
    ...(project.part.constructionAxes === undefined ? {} : { axes: project.part.constructionAxes }),
    ...(project.part.construction === undefined ? {} : { planes: project.part.construction }),
    ...(project.part.generalBodies === undefined ? {} : { bodies: project.part.generalBodies })
  };
}

/** A copy of a body moved by `transform` (a mirror also has its triangle winding reversed), with face names re-keyed to the copy. */
export async function copyGeneralBody(source: GeneralSolidBody, transform: Affine, id: string, name: string): Promise<GeneralSolidBody> {
  const moved = transformMesh(source, transform);
  const { brep, ...rest } = source;
  const copy: GeneralSolidBody = { ...rest, id, name, visible: true, positionsMm: moved.positionsMm, indices: moved.indices };
  if (brep === undefined) return copy;
  const faces = await Promise.all(brep.faces.map(async (face) => ({ ...face, key: await stableFaceKey(id, face.role) })));
  return { ...copy, brep: { ...brep, faces } };
}

/** The body's own shape as a plain mesh, without face names (they would no longer describe the result of a hole or a union). */
function withoutFaceNames(body: GeneralSolidBody, positionsMm: readonly number[], indices: readonly number[]): GeneralSolidBody {
  const { brep: _faceNames, ...rest } = body;
  void _faceNames;
  return { ...rest, positionsMm: [...positionsMm], indices: [...indices] };
}

/** Builds what a pattern step contributes to its body during replay. `current` is the body as the steps before this one left it. */
export async function applyPatternStep(step: DesignSolidFeature, current: GeneralSolidBody | undefined, context: PatternStepContext): Promise<PatternApplied> {
  const pattern = step.pattern;
  if (pattern === undefined) return { ok: false, message: "This pattern step has no layout recorded." };
  const layout = patternTransforms(pattern, patternContextOf(context.project));
  if (!layout.ok) return { ok: false, message: layout.message };
  if (pattern.result === "new-bodies") {
    const source = await context.sourceSnapshot(pattern.sourceBodyId);
    if (source === undefined) return { ok: false, message: "The body this pattern copies could not be built, so there is nothing to copy." };
    const transform = layout.transforms[(pattern.copyIndex ?? 1) - 1];
    if (transform === undefined) return { ok: false, message: `The pattern has no copy number ${pattern.copyIndex ?? 1}.` };
    const copy = await copyGeneralBody(source, transform, step.bodyId, context.existing?.name ?? `${source.name} copy ${pattern.copyIndex ?? 1}`);
    return { ok: true, body: { ...copy, color: context.existing?.color ?? source.color } };
  }
  if (current === undefined) return { ok: false, message: "The body this pattern changes could not be built, so there is nothing to pattern." };
  if (pattern.featureIds === undefined) return joinCopies(current, layout.transforms);
  return repeatFeatures(step, current, layout.transforms, context);
}

/** Joins a copy of the whole body at every position into the body. Copies that touch or overlap go through the Boolean union; separate ones become extra shells. */
async function joinCopies(current: GeneralSolidBody, transforms: readonly Affine[]): Promise<PatternApplied> {
  let result = current;
  for (const [index, transform] of transforms.entries()) {
    const moved = await copyGeneralBody(current, transform, `${current.id}:pattern-${index + 1}`, current.name);
    const here = meshBounds(result.positionsMm);
    const there = meshBounds(moved.positionsMm);
    if (here === undefined || there === undefined) return { ok: false, message: "The body has no geometry to pattern." };
    if (!boundsTouch(here, there)) {
      const merged = concatMeshes(result, moved);
      result = withoutFaceNames(result, merged.positionsMm, merged.indices);
      continue;
    }
    const combined = await combineGeneralBodies({ target: result, tool: moved, mode: "join", bodyId: current.id, name: current.name });
    if (!combined.ok) return { ok: false, message: `Copy ${index + 1} could not be joined to the body: ${combined.message}` };
    result = { ...combined.body, color: current.color };
  }
  if (result.positionsMm.length > 300_000 || result.indices.length > 300_000) return { ok: false, message: "The joined pattern has too many triangles to store. Use fewer copies or a simpler body." };
  return { ok: true, body: result };
}

/** One cutter or join tool of a repeated feature, already placed at its position. */
interface PlacedTool {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  readonly where: string;
}

/**
 * Repeats holes and extrude cuts or joins of the same body at every position, applying each recorded step where the pattern puts it.
 * The tools of one step are combined and applied in as few Boolean operations as possible: cutting hole after hole fragments the
 * body's faces so fast that the mesh Boolean runs out of triangles after a handful, while tools that do not touch each other can be
 * subtracted in one pass. Tools that overlap each other are applied in separate passes.
 */
async function repeatFeatures(step: DesignSolidFeature, current: GeneralSolidBody, transforms: readonly Affine[], context: PatternStepContext): Promise<PatternApplied> {
  let result = current;
  let placed = 0;
  const problems: string[] = [];
  for (const featureId of step.pattern?.featureIds ?? []) {
    const source = context.stepOf(featureId);
    if (source === undefined) continue;
    const mode: "cut" | "join" | undefined = source.kind === "hole" ? "cut" : source.operation === "cut" || source.operation === "join" ? source.operation : undefined;
    if (mode === undefined || source.kind === "pattern") { problems.push(`${source.name}: only holes, cuts and joins can be repeated.`); continue; }
    const tools: PlacedTool[] = [];
    const bodyBounds = meshBounds(result.positionsMm);
    for (const [index, transform] of transforms.entries()) {
      const where = `${source.name}, copy ${index + 1}`;
      let tool: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] } | undefined;
      if (source.kind === "hole") {
        if (source.holePositionMm === undefined || source.holeNormal === undefined) { problems.push(`${where}: the hole has no position recorded.`); continue; }
        const moved: DesignSolidFeature = { ...source, holePositionMm: transformPoint(transform, source.holePositionMm), holeNormal: transformDirection(transform, source.holeNormal) };
        const cutter = context.holeTool(moved, result);
        if (!cutter.ok) { problems.push(`${where}: ${cutter.message}`); continue; }
        tool = cutter;
      } else {
        const sketch = context.sketchOf(source.sketchFeatureId);
        if (sketch === undefined) { problems.push(`${where}: its sketch is no longer in the timeline.`); continue; }
        // A through-all cut is sized in its own frame, so measure the body as it looks from the original's position.
        const inverse = invertAffine(transform);
        const inFrame = inverse === undefined ? result : { ...result, positionsMm: transformPositions(result.positionsMm, inverse) };
        const sized = source.extent === "through-all" ? context.sizeThroughAll(source, sketch, inFrame) : source;
        const built = await context.rebuildTool({ ...sized, bodyId: `${source.id}:tool` }, sketch, result.color);
        if (!built.ok) { problems.push(`${where}: ${built.message}`); continue; }
        tool = transformMesh(built.body, transform);
      }
      const reach = meshBounds(tool.positionsMm);
      if (bodyBounds === undefined || reach === undefined || !boundsTouch(bodyBounds, reach)) { problems.push(`${where}: lands outside the body, so it changes nothing.`); continue; }
      tools.push({ positionsMm: tool.positionsMm, indices: tool.indices, where });
    }
    // Tools whose boxes touch each other go into different passes, so each pass is a set of separate solids.
    const passes: PlacedTool[][] = [];
    for (const tool of tools) {
      const box = meshBounds(tool.positionsMm)!;
      const pass = passes.find((candidate) => candidate.every((other) => !boundsTouch(box, meshBounds(other.positionsMm)!)));
      if (pass === undefined) passes.push([tool]); else pass.push(tool);
    }
    for (const pass of passes) {
      let merged: { positionsMm: number[]; indices: number[] } = { positionsMm: [], indices: [] };
      for (const tool of pass) merged = concatMeshes(merged, tool);
      const combined = await combineGeneralBodies({
        target: result, tool: { id: `${source.id}:tools`, name: source.name, visible: true, color: result.color, positionsMm: merged.positionsMm, indices: merged.indices },
        mode, bodyId: current.id, name: current.name
      });
      if (!combined.ok) { problems.push(`${pass[0]!.where}${pass.length > 1 ? ` and ${pass.length - 1} more` : ""}: ${combined.message}`); continue; }
      result = { ...combined.body, color: current.color };
      placed += pass.length;
    }
  }
  if (placed === 0) return { ok: false, message: problems[0] ?? "None of the repeated steps is live, so the pattern changes nothing." };
  return problems.length === 0 ? { ok: true, body: result } : { ok: true, body: result, note: `${problems.length} of ${placed + problems.length} positions were skipped: ${problems[0]}` };
}
