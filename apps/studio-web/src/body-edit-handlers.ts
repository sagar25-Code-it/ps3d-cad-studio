import type { BodyEditSpec, DesignSolidFeature, FaceRef, GeneralSolidBody, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { baseFeatureOf, describeBodyEdit, designOf } from "../../../packages/workbench-core/src/index.js";
import { analyzeFaces, faceOutlineSegments, resolveFace, shellBody } from "../../../packages/workbench-geometry/src/index.js";
import type { ViewportGuideSegment, ViewportMeasurePoint } from "../../../packages/viewport-three/src/index.js";

/** The face-driven edits the ribbon offers; each records a replayable timeline step. */
export type BodyEditMode = "shell" | "draft" | "offset-region" | "replace-face";

/** What the handlers need from the app: the live project, viewport picking, the timeline commit and a status line. */
export interface BodyEditDeps {
  readonly project: () => WorkbenchProject;
  readonly selectedBodyId: () => string | null;
  readonly pick: (instruction: string, guides?: readonly ViewportGuideSegment[]) => Promise<ViewportMeasurePoint | null>;
  readonly commit: (intent: { readonly kind: "add-design-solid"; readonly feature: DesignSolidFeature; readonly body: GeneralSolidBody }, mustApply?: string) => Promise<boolean>;
  readonly say: (state: "ready" | "error", text: string) => void;
  readonly ask: (label: string, defaultValue: string) => string | null;
  readonly select: (bodyId: string) => void;
  readonly showGuides: (guides: readonly ViewportGuideSegment[]) => void;
  /** Applies a mesh result to a body that is not in the timeline (shell only), as an ordinary modify-general-body. */
  readonly replaceMesh?: (body: GeneralSolidBody, label: string, positionsMm: readonly number[], indices: readonly number[]) => boolean;
}

const round = (value: number): number => Number(value.toFixed(3));

const faceRefOf = (picked: ViewportMeasurePoint): FaceRef | undefined => picked.normalMm === undefined
  ? undefined
  : { pointMm: [round(picked.pointMm[0]), round(picked.pointMm[1]), round(picked.pointMm[2])], normalMm: [round(picked.normalMm[0]), round(picked.normalMm[1]), round(picked.normalMm[2])] };

const numbers = (text: string): number[] => text.split(/[,\s]+/u).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));

/** Builds the timeline step for a body edit. `valueMm` is the size the timeline shows (thickness, angle or distance). */
export function bodyEditFeature(kind: DesignSolidFeature["kind"], bodyEdit: BodyEditSpec, base: DesignSolidFeature, bodyId: string, valueMm: number): DesignSolidFeature {
  return {
    id: `feature:${kind}-${crypto.randomUUID()}`, name: `${kind === "shell" ? "Shell" : kind === "draft" ? "Draft" : kind === "offset-region" ? "Offset region" : kind === "replace-face" ? "Replace face" : kind} · ${describeBodyEdit(bodyEdit)}`.slice(0, 120),
    kind, suppressed: false, sketchFeatureId: base.sketchFeatureId, profileIds: [], valueMm: Math.max(0.01, Math.abs(valueMm)), bodyId, operation: "direct-edit", bodyEdit
  };
}

export function createBodyEditHandlers(deps: BodyEditDeps): { readonly run: (mode: BodyEditMode) => Promise<void> } {
  const NAMES: Readonly<Record<BodyEditMode, string>> = { shell: "Shell", draft: "Draft", "offset-region": "Offset region", "replace-face": "Replace face" };

  /** The selected solid and the step that made it, or a reason the edit cannot be recorded. */
  const target = (mode: BodyEditMode): { readonly body: GeneralSolidBody; readonly base: DesignSolidFeature | undefined } | undefined => {
    const project = deps.project();
    const bodies = project.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === deps.selectedBodyId());
    if (body === undefined) { deps.say("ready", `${NAMES[mode]} needs a general solid body selected first.`); return undefined; }
    return { body, base: baseFeatureOf(designOf(project), body.id) };
  };

  /** Click faces of `body` one after another; Esc finishes (or cancels when nothing was picked). */
  const pickFaces = async (body: GeneralSolidBody, instruction: string, single = false): Promise<FaceRef[] | undefined> => {
    const refs: FaceRef[] = [];
    const mesh = { positionsMm: body.positionsMm, indices: body.indices };
    const analysis = analyzeFaces(mesh);
    if (typeof analysis === "string") { deps.say("error", `${analysis}`); return undefined; }
    for (;;) {
      const picked = await deps.pick(refs.length === 0 ? instruction : `${instruction} — ${refs.length} picked${single ? "" : ", click another or press Esc to finish"}`, faceOutlineSegments(mesh, refs));
      if (picked === null) break;
      if (picked.semanticId !== body.id) { deps.say("ready", `Click a face of ${body.name}.`); continue; }
      const ref = faceRefOf(picked);
      if (ref === undefined) { deps.say("ready", "The clicked surface has no direction to work from."); continue; }
      const found = resolveFace(mesh, analysis, ref);
      if (!found.ok) { deps.say("ready", found.message); continue; }
      if (found.region.curved) { deps.say("ready", "That is a curved face (one facet of a cylinder or dome); pick a flat face."); continue; }
      refs.push({ pointMm: ref.pointMm, normalMm: [round(found.region.normal[0]), round(found.region.normal[1]), round(found.region.normal[2])] });
      if (single) break;
    }
    deps.showGuides(faceOutlineSegments(mesh, refs));
    return refs.length === 0 ? undefined : refs;
  };

  const finish = async (feature: DesignSolidFeature, body: GeneralSolidBody, doneText: string): Promise<void> => {
    const ok = await deps.commit({ kind: "add-design-solid", feature, body }, feature.id);
    deps.showGuides([]);
    if (ok) { deps.select(body.id); deps.say("ready", doneText); }
  };

  const shell = async (): Promise<void> => {
    const found = target("shell");
    if (found === undefined) return;
    const { body, base } = found;
    const faces = await pickFaces(body, `Shell: click the face(s) of ${body.name} to leave open`);
    if (faces === undefined) { deps.showGuides([]); return; }
    const thicknessRaw = deps.ask("Wall thickness (mm):", "2");
    if (thicknessRaw === null) { deps.showGuides([]); return; }
    const thickness = Number.parseFloat(thicknessRaw);
    if (!Number.isFinite(thickness) || thickness <= 0) { deps.showGuides([]); deps.say("ready", "Shell: enter a positive wall thickness in millimetres."); return; }
    const sideRaw = (deps.ask("Wall grows (inside, outside or both):", "inside") ?? "").trim().toLowerCase();
    if (sideRaw === "") { deps.showGuides([]); return; }
    if (sideRaw !== "inside" && sideRaw !== "outside" && sideRaw !== "both") { deps.showGuides([]); deps.say("ready", "Shell: enter inside, outside or both."); return; }
    const spec: BodyEditSpec = { kind: "shell", thicknessMm: thickness, side: sideRaw, openFaces: faces };
    if (base === undefined) {
      // A body that is not in the timeline cannot record a step, so the shell is applied to its mesh directly.
      const result = shellBody({ positionsMm: body.positionsMm, indices: body.indices }, { thicknessMm: thickness, side: sideRaw, openFaces: faces });
      deps.showGuides([]);
      if (!result.ok) { deps.say("error", `Shell failed: ${result.message}`); return; }
      if (deps.replaceMesh === undefined || !deps.replaceMesh(body, `Shell ${thickness} mm`, result.positionsMm, result.indices)) deps.say("error", "The project rejected the shell result.");
      else deps.say("ready", `Shelled ${body.name}: ${describeBodyEdit(spec)}.`);
      return;
    }
    await finish(bodyEditFeature("shell", spec, base, body.id, thickness), body, `Shelled ${body.name}: ${describeBodyEdit(spec)}.`);
  };

  const draft = async (): Promise<void> => {
    const found = target("draft");
    if (found === undefined) return;
    const { body, base } = found;
    if (base === undefined) { deps.say("ready", "Draft: this body is not in the timeline, so a draft cannot be recorded."); return; }
    const neutral = await pickFaces(body, `Draft: click the neutral face of ${body.name} (the plane that stays put, usually the parting face)`, true);
    if (neutral === undefined) { deps.showGuides([]); return; }
    const inward = neutral[0]!.normalMm;
    const pullRaw = deps.ask("Pull direction x, y, z (the way the part leaves the mould; walls narrow along it):", `${round(-inward[0])}, ${round(-inward[1])}, ${round(-inward[2])}`);
    if (pullRaw === null) { deps.showGuides([]); return; }
    const pull = numbers(pullRaw);
    if (pull.length !== 3 || pull.every((value) => value === 0)) { deps.showGuides([]); deps.say("ready", "Draft: enter three numbers for the pull direction."); return; }
    const faces = await pickFaces(body, "Draft: click the faces to lean (Esc when done)");
    if (faces === undefined) { deps.showGuides([]); return; }
    const angleRaw = deps.ask("Draft angle (°, negative leans the other way):", "3");
    if (angleRaw === null) { deps.showGuides([]); return; }
    const angle = Number.parseFloat(angleRaw);
    if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 45) { deps.showGuides([]); deps.say("ready", "Draft: enter an angle between -45° and 45°, not zero."); return; }
    const spec: BodyEditSpec = { kind: "draft", angleDeg: angle, pullDirection: [pull[0]!, pull[1]!, pull[2]!], neutralPointMm: neutral[0]!.pointMm, faces };
    await finish(bodyEditFeature("draft", spec, base, body.id, angle), body, `Drafted ${body.name}: ${describeBodyEdit(spec)}.`);
  };

  const offsetRegion = async (): Promise<void> => {
    const found = target("offset-region");
    if (found === undefined) return;
    const { body, base } = found;
    if (base === undefined) { deps.say("ready", "Offset region: this body is not in the timeline, so the edit cannot be recorded."); return; }
    const faces = await pickFaces(body, `Offset region: click the flat face(s) of ${body.name} to move (Esc when done)`);
    if (faces === undefined) { deps.showGuides([]); return; }
    const raw = deps.ask("Offset distance along the face normal (mm, negative moves in):", "2");
    if (raw === null) { deps.showGuides([]); return; }
    const distance = Number.parseFloat(raw);
    if (!Number.isFinite(distance) || distance === 0) { deps.showGuides([]); deps.say("ready", "Offset region: enter a non-zero distance in millimetres."); return; }
    const spec: BodyEditSpec = { kind: "offset-region", distanceMm: distance, faces };
    await finish(bodyEditFeature("offset-region", spec, base, body.id, distance), body, `Offset ${body.name}: ${describeBodyEdit(spec)}.`);
  };

  const replaceFace = async (): Promise<void> => {
    const found = target("replace-face");
    if (found === undefined) return;
    const { body, base } = found;
    if (base === undefined) { deps.say("ready", "Replace face: this body is not in the timeline, so the edit cannot be recorded."); return; }
    const faces = await pickFaces(body, `Replace face: click the face(s) of ${body.name} to replace (Esc when done)`);
    if (faces === undefined) { deps.showGuides([]); return; }
    const how = (deps.ask("Replace with a face (type face) or a plane (type x y z nx ny nz):", "face") ?? "").trim().toLowerCase();
    if (how === "") { deps.showGuides([]); return; }
    let spec: BodyEditSpec;
    if (how === "face") {
      const to = await pickFaces(body, "Replace face: click the face whose plane to use", true);
      if (to === undefined) { deps.showGuides([]); return; }
      spec = { kind: "replace-face", faces, toFace: to[0]! };
    } else {
      const plane = numbers(how);
      if (plane.length !== 6 || plane.slice(3).every((value) => value === 0)) { deps.showGuides([]); deps.say("ready", "Replace face: enter face, or six numbers: a point then a direction."); return; }
      spec = { kind: "replace-face", faces, toPlane: { pointMm: [plane[0]!, plane[1]!, plane[2]!], normalMm: [plane[3]!, plane[4]!, plane[5]!] } };
    }
    await finish(bodyEditFeature("replace-face", spec, base, body.id, 1), body, `Replaced faces of ${body.name}: ${describeBodyEdit(spec)}.`);
  };

  return {
    run: async (mode) => {
      if (mode === "shell") return shell();
      if (mode === "draft") return draft();
      if (mode === "offset-region") return offsetRegion();
      return replaceFace();
    }
  };
}
