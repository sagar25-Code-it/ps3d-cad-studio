import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { baseFeatureOf, designOf, isFeatureActive, flangeEdgesOf, validSolidFeaturePayload } from "../../../packages/workbench-core/src/index.js";
import type { SheetBendTable } from "../../../packages/workbench-core/src/index.js";
import {
  bendReportCsv, jogProfile, miterChainBetween, miterChainOf, nearestFrameEdge, sharedFlangeEnds, sheetFrameOf,
  type SheetFrame
} from "../../../packages/workbench-geometry/src/index.js";
import { flatPatternForBody, rebuildSolidFeature, sketchNormal } from "./design-regeneration.js";
import { exportFileName } from "./file-names.js";

type Vec3 = readonly [number, number, number];
type Guide = readonly [Vec3, Vec3];

export type SheetMetalCommand = "miter-flange" | "jog" | "lofted-bend" | "bend-table" | "bend-table-csv";

/** What the sheet-metal commands need from the app: asking, picking on the model, committing a step, and reporting. */
export interface SheetCommandContext {
  readonly project: WorkbenchProject;
  readonly selectedId: string | null;
  readonly ask: (label: string, defaultValue: string) => string | null;
  readonly pick: (instruction: string, guides: readonly Guide[]) => Promise<{ readonly pointMm: Vec3 } | null>;
  readonly highlight: (guides: readonly Guide[], active: number | null) => void;
  /** Adds the step and replays the timeline; resolves true when it applied. */
  readonly commit: (feature: DesignSolidFeature, body: GeneralSolidBody) => Promise<boolean>;
  readonly say: (text: string, tone?: "ready" | "error") => void;
  readonly download: (text: string, fileName: string, mime: string) => void;
  readonly openBendTable: (bodyId: string) => void;
}

interface SheetTarget {
  readonly body: GeneralSolidBody;
  readonly base: DesignSolidFeature;
  readonly sketch: DesignSketchFeature;
}

function targetOf(project: WorkbenchProject, selectedId: string | null): SheetTarget | string {
  const bodies = project.part.generalBodies ?? [];
  const body = bodies.find((candidate) => candidate.id === selectedId) ?? bodies[0];
  if (body === undefined) return "create or select a plate first (a Sheet metal base plate or any extruded profile).";
  const history = designOf(project);
  const base = baseFeatureOf(history, body.id);
  const sketch = base === undefined ? undefined : history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === base.sketchFeatureId && candidate.kind === "sketch");
  if (base === undefined || sketch === undefined) return "this body is not in the timeline, so a sheet-metal step cannot be recorded.";
  return { body, base, sketch };
}

async function frameOf(target: SheetTarget): Promise<{ readonly frame: SheetFrame } | string> {
  const rebuilt = await rebuildSolidFeature(target.base, target.sketch, target.body.color);
  if (!rebuilt.ok) return rebuilt.message;
  const frame = sheetFrameOf(rebuilt.body, sketchNormal(target.sketch));
  if (frame === undefined || frame.edges.length === 0) return "this body has no flat top face with straight edges to work from.";
  return { frame };
}

const liveFlangeEdges = (project: WorkbenchProject, bodyId: string): readonly number[] => {
  const history = designOf(project);
  return history.features.filter((candidate): candidate is DesignSolidFeature => candidate.kind === "sheet-edge-flange" && candidate.bodyId === bodyId && isFeatureActive(history, candidate.id)).flatMap((candidate) => flangeEdgesOf(candidate));
};

export type StepBuild = { readonly ok: true; readonly feature: DesignSolidFeature } | { readonly ok: false; readonly message: string };

export interface MiterRequest {
  readonly base: DesignSolidFeature;
  readonly bodyId: string;
  readonly frame: SheetFrame;
  readonly firstEdge: number;
  readonly lastEdge: number;
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  readonly reliefMm: number;
  readonly id: string;
}

/** The timeline step for a miter flange from `firstEdge` forward to `lastEdge` around the plate's outline. */
export function buildMiterFlangeStep(request: MiterRequest): StepBuild {
  const { frame, firstEdge, lastEdge } = request;
  const chain = miterChainBetween(frame, firstEdge, lastEdge);
  if (chain === undefined) return { ok: false, message: `No run of connected edges leads from edge ${firstEdge} to edge ${lastEdge}; pick the last edge further along the outline in the direction the edges run.` };
  if (chain.length < 2) return { ok: false, message: "A miter flange joins at least two connected edges. Use Edge Flange for a single edge." };
  const joined = miterChainOf(frame, chain);
  if (!joined.ok) return joined;
  if (![request.innerRadiusMm, request.flangeLengthMm, request.angleDeg, request.reliefMm].every(Number.isFinite) || request.innerRadiusMm < 0 || request.flangeLengthMm <= 0 || request.angleDeg <= 0 || request.angleDeg > 180 || request.reliefMm < 0) {
    return { ok: false, message: "Enter a bend radius of 0 or more, a flange length above 0, an angle up to 180° and a relief of 0 or more." };
  }
  const feature: DesignSolidFeature = {
    id: request.id,
    name: `Edge flange ${firstEdge} miter ×${chain.length} (${request.angleDeg.toFixed(0)}°, ${request.flangeLengthMm.toFixed(0)} mm)`,
    kind: "sheet-edge-flange", suppressed: false,
    sketchFeatureId: request.base.sketchFeatureId, profileIds: [],
    valueMm: Math.max(0.01, request.flangeLengthMm), bodyId: request.bodyId, operation: "direct-edit",
    flangeEdgeIndex: firstEdge, flangeMiterEdges: chain.slice(1),
    sheetBendRadiusMm: request.innerRadiusMm, flangeLengthMm: request.flangeLengthMm, flangeAngleDeg: request.angleDeg,
    ...(request.reliefMm > 0 ? { flangeReliefMm: request.reliefMm } : {})
  };
  return validSolidFeaturePayload(feature) ? { ok: true, feature } : { ok: false, message: "Those values are outside what a miter flange supports." };
}

export interface JogRequest {
  readonly base: DesignSolidFeature;
  readonly bodyId: string;
  readonly frame: SheetFrame;
  readonly edgeIndex: number;
  readonly positionMm: number;
  readonly offsetMm: number;
  readonly angleDeg: number;
  readonly innerRadiusMm: number;
  readonly id: string;
}

/** The timeline step for a jog, checked against the sheet's thickness so impossible numbers are refused up front. */
export function buildJogStep(request: JogRequest): StepBuild {
  if (request.frame.edges[request.edgeIndex] === undefined) return { ok: false, message: `There is no edge ${request.edgeIndex}.` };
  if (![request.positionMm, request.offsetMm, request.angleDeg, request.innerRadiusMm].every(Number.isFinite) || request.positionMm < 0) return { ok: false, message: "Enter a distance of 0 or more, a step height, an angle from 1° to 89° and a bend radius of 0 or more." };
  const profile = jogProfile({ offsetMm: request.offsetMm, angleDeg: request.angleDeg, innerRadiusMm: request.innerRadiusMm }, request.frame.thicknessMm);
  if (!profile.ok) return profile;
  const feature: DesignSolidFeature = {
    id: request.id,
    name: `Jog ${request.edgeIndex} (${request.offsetMm.toFixed(0)} mm, ${request.angleDeg.toFixed(0)}°)`,
    kind: "sheet-jog", suppressed: false,
    sketchFeatureId: request.base.sketchFeatureId, profileIds: [],
    valueMm: Math.max(0.01, Math.abs(request.offsetMm)), bodyId: request.bodyId, operation: "direct-edit",
    jogEdgeIndex: request.edgeIndex, jogPositionMm: request.positionMm, jogOffsetMm: request.offsetMm, jogAngleDeg: request.angleDeg, sheetBendRadiusMm: request.innerRadiusMm
  };
  return validSolidFeaturePayload(feature) ? { ok: true, feature } : { ok: false, message: "Those values are outside what a jog supports." };
}

/**
 * A lofted bend from a Loft: the same sketch, profiles, height and top (scale or second profile), made as sheet of the given
 * thickness. It is a new body next to the loft, which the user can hide.
 */
export function buildLoftedBendStep(loft: DesignSolidFeature, thicknessMm: number, id: string, bodyId: string): StepBuild {
  if (loft.kind !== "loft") return { ok: false, message: "A lofted bend is made from a Loft: select the lofted solid first." };
  if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return { ok: false, message: "Enter a sheet thickness above 0." };
  const hasTop = loft.loftTopScale !== undefined || (loft.loftSecondaryProfileIds?.length ?? 0) > 0;
  if (!hasTop) return { ok: false, message: "This loft has no top profile or top scale to make a transition to." };
  const feature: DesignSolidFeature = {
    id, name: `Lofted bend (${thicknessMm.toFixed(1)} mm)`, kind: "sheet-lofted-bend", suppressed: false,
    sketchFeatureId: loft.sketchFeatureId, profileIds: loft.profileIds, valueMm: Math.abs(loft.valueMm), bodyId, sheetThicknessMm: thicknessMm,
    ...(loft.loftTopScale === undefined ? {} : { loftTopScale: loft.loftTopScale }),
    ...(loft.loftSecondaryProfileIds === undefined || loft.loftSecondaryProfileIds.length === 0 ? {} : { loftSecondaryProfileIds: loft.loftSecondaryProfileIds })
  };
  return validSolidFeaturePayload(feature) ? { ok: true, feature } : { ok: false, message: "Those values are outside what a lofted bend supports." };
}

export type BendTableUpdate =
  | { readonly ok: true; readonly feature: DesignSolidFeature; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

/** The update that stores (or, with `undefined`, clears) a body's bend table on the step that made the body. */
export function bendTableUpdate(project: WorkbenchProject, bodyId: string, table: SheetBendTable | undefined): BendTableUpdate {
  const body = project.part.generalBodies?.find((candidate) => candidate.id === bodyId);
  const base = baseFeatureOf(designOf(project), bodyId);
  if (body === undefined || base === undefined) return { ok: false, message: "This body is not in the timeline, so it has no step to keep a bend table on." };
  const { sheetBendTable: _previous, ...rest } = base;
  void _previous;
  const feature: DesignSolidFeature = table === undefined ? rest : { ...rest, sheetBendTable: table };
  if (!validSolidFeaturePayload(feature)) return { ok: false, message: "That bend table is not valid here: give a default K-factor between 0 and 1 and rows with a thickness, a radius and exactly one of K-factor, bend allowance or bend deduction, with no two rows for the same thickness, radius and angle." };
  return { ok: true, feature, body };
}

/** Runs one of the Sheet metal ribbon commands. */
export async function runSheetMetalCommand(command: SheetMetalCommand, context: SheetCommandContext): Promise<void> {
  const label = command === "miter-flange" ? "Miter flange" : command === "jog" ? "Jog" : command === "lofted-bend" ? "Lofted bend" : "Bend table";
  const { project } = context;
  if (command === "lofted-bend") {
    const bodies = project.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === context.selectedId);
    const loft = body === undefined ? undefined : baseFeatureOf(designOf(project), body.id);
    if (body === undefined || loft === undefined || loft.kind !== "loft") { context.say("Lofted bend: select a lofted solid (made with Loft) first. The bend is made from its profiles and height.", "ready"); return; }
    const thickness = Number.parseFloat(context.ask("Sheet thickness (mm):", "1.5") ?? "");
    const built = buildLoftedBendStep(loft, thickness, `feature:sheet-lofted-bend-${crypto.randomUUID()}`, `general-body:${crypto.randomUUID()}`);
    if (!built.ok) { context.say(`Lofted bend: ${built.message}`, "ready"); return; }
    const sketch = designOf(project).features.find((candidate): candidate is DesignSketchFeature => candidate.id === loft.sketchFeatureId && candidate.kind === "sketch");
    if (sketch === undefined) { context.say("Lofted bend: the sketch this loft was made from is no longer in the timeline.", "error"); return; }
    const rebuilt = await rebuildSolidFeature(built.feature, sketch, body.color);
    if (!rebuilt.ok) { context.say(`Lofted bend: ${rebuilt.message}`, "error"); return; }
    await context.commit(built.feature, rebuilt.body);
    return;
  }
  const target = targetOf(project, context.selectedId);
  if (typeof target === "string") { context.say(`${label}: ${target}`, "ready"); return; }
  if (command === "bend-table") { context.openBendTable(target.body.id); return; }
  if (command === "bend-table-csv") {
    const outcome = await flatPatternForBody(project, target.body.id);
    if (!outcome.ok) { context.say(`Bend table: ${outcome.message}`, "ready"); return; }
    if (outcome.bends.length === 0) { context.say("Bend table: this part has no bends to list.", "ready"); return; }
    context.download(bendReportCsv(outcome.bends), exportFileName(project.name, `${target.body.name}-bend-table`, "csv"), "text/csv");
    context.say(`Exported the bend table of ${target.body.name}: ${outcome.bends.length} bend${outcome.bends.length === 1 ? "" : "s"} with the K-factor, allowance and deduction each was developed with.`, "ready");
    return;
  }
  const framed = await frameOf(target);
  if (typeof framed === "string") { context.say(`${label}: ${framed}`, "error"); return; }
  const { frame } = framed;
  const guides: Guide[] = frame.edges.map((edge) => [edge.startMm, edge.endMm]);
  const pickEdge = async (instruction: string): Promise<number | undefined> => {
    const picked = await context.pick(instruction, guides);
    if (picked === null) return undefined;
    const nearest = nearestFrameEdge(frame, picked.pointMm);
    if (nearest === undefined) { context.say(`${label}: this plate has no straight edge to pick.`, "ready"); return undefined; }
    context.highlight(guides, nearest.index);
    return nearest.index;
  };
  const number = (question: string, fallback: string): number => Number.parseFloat(context.ask(question, fallback) ?? "");
  if (command === "jog") {
    const edgeIndex = await pickEdge(`Jog: click the plate edge the jog line runs parallel to (${frame.edges.length} edges, ${frame.thicknessMm.toFixed(2)} mm sheet)`);
    if (edgeIndex === undefined) return;
    const positionMm = number("Distance from that edge to where the first bend starts (mm):", String(Math.min(20, Math.round(frame.edges[edgeIndex]!.lengthMm / 2))));
    const offsetMm = number("Step height (mm; negative steps down):", "10");
    const angleDeg = number("Jog angle (degrees, 1 to 89):", "45");
    const innerRadiusMm = number("Inner bend radius (mm):", String(frame.thicknessMm));
    const built = buildJogStep({ base: target.base, bodyId: target.body.id, frame, edgeIndex, positionMm, offsetMm, angleDeg, innerRadiusMm, id: `feature:sheet-jog-${crypto.randomUUID()}` });
    if (!built.ok) { context.say(`Jog: ${built.message}`, "ready"); return; }
    await context.commit(built.feature, target.body);
    return;
  }
  const first = await pickEdge("Miter flange: click the FIRST edge of the chain (the chain runs the way the edges run round the plate)");
  if (first === undefined) return;
  const last = await pickEdge("Miter flange: click the LAST edge of the chain (click the same edge again to stop at one)");
  if (last === undefined) return;
  const chain = miterChainBetween(frame, first, last);
  if (chain === undefined) { context.say(`Miter flange: no run of connected edges leads from edge ${first} to edge ${last}; pick the last edge further along the outline in the direction the edges run.`, "ready"); return; }
  context.highlight(guides, null);
  const innerRadiusMm = number("Inner bend radius (mm):", String(frame.thicknessMm));
  const flangeLengthMm = number("Flange length after the bend (mm):", "20");
  const angleDeg = number("Bend angle (degrees, 1 to 180):", "90");
  const others = liveFlangeEdges(project, target.body.id);
  const meetsOther = [chain[0]!, chain[chain.length - 1]!].some((edgeIndex) => {
    const ends = sharedFlangeEnds(frame, edgeIndex, others);
    return (edgeIndex === chain[0] && ends.start) || (edgeIndex === chain[chain.length - 1] && ends.end);
  });
  const reliefMm = meetsOther ? number("The chain ends where it meets another flange. Corner relief there (mm gap, 0 for none):", frame.thicknessMm.toFixed(2)) : 0;
  const built = buildMiterFlangeStep({ base: target.base, bodyId: target.body.id, frame, firstEdge: first, lastEdge: last, innerRadiusMm, flangeLengthMm, angleDeg, reliefMm, id: `feature:sheet-edge-flange-${crypto.randomUUID()}` });
  if (!built.ok) { context.say(`Miter flange: ${built.message}`, "ready"); return; }
  await context.commit(built.feature, target.body);
}
