import { datumPointOf } from "../../../packages/workbench-core/src/index.js";
import type { ConstructionAxis, ConstructionBinder, ConstructionPlaneDefinition, ConstructionBinderTarget, ConstructionEdgeRef, ConstructionPathRef, DesignHistory, GeneralSolidBody, SketchEntity, Vec3, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { faceTargetOf, nearestBodyFace, nearestPickableEdge, pickableEdges, placePoint } from "../../../packages/workbench-geometry/src/index.js";
import { sampleArc, sampleSpline } from "../../../packages/workbench-sketch/src/index.js";
import { NORMALS, planeKeyOf } from "./design-regeneration.js";

/**
 * The pure parts of the construction-plane and binder dialogs: turning clicks and sketch curves into stored references, so the
 * App only has to ask for a click. Everything here is testable without a browser.
 */

/** A sketch curve that can serve as the path of a "plane along path". */
export interface SketchPathOption {
  readonly id: string;
  readonly label: string;
  readonly path: Extract<ConstructionPathRef, { readonly kind: "polyline" }>;
}

const CIRCLE_SAMPLES = 96;

/** Where a point of a sketch lies in the world: on its datum plane, moved along the normal by the offset, then onto its tilt or frame. */
export function sketchPointToWorld(sketch: WorkbenchSketch, point: readonly [number, number]): Vec3 {
  const plane = planeKeyOf(sketch.plane);
  // The datum planes place sketch (x, y) the way the solid builders do: XY as is, XZ with y up Z, YZ with y along Y and x down Z.
  const onDatum: Vec3 = datumPointOf(sketch, point[0], point[1]);
  const normal = NORMALS[plane];
  const offset = sketch.planeOffsetMm ?? 0;
  const lifted: Vec3 = [onDatum[0] + normal[0] * offset, onDatum[1] + normal[1] * offset, onDatum[2] + normal[2] * offset];
  return placePoint(lifted, sketch);
}

function samplesOf(entity: SketchEntity): readonly (readonly [number, number])[] {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "arc") return sampleArc(entity.start, entity.mid, entity.end);
  if (entity.kind === "spline") return sampleSpline(entity.fitPoints);
  if (entity.kind === "circle") {
    return Array.from({ length: CIRCLE_SAMPLES + 1 }, (_, index): readonly [number, number] => [
      entity.center[0] + entity.radiusMm * Math.cos(Math.PI * 2 * index / CIRCLE_SAMPLES),
      entity.center[1] + entity.radiusMm * Math.sin(Math.PI * 2 * index / CIRCLE_SAMPLES)
    ]);
  }
  return [];
}

const KIND_LABEL: Readonly<Record<string, string>> = { line: "Line", arc: "Arc", spline: "Spline", circle: "Circle" };

/** The lines, arcs, splines and circles of the working sketch and of every sketch in the timeline, as world-space paths. */
export function sketchPathOptions(working: WorkbenchSketch, history: DesignHistory): readonly SketchPathOption[] {
  const options: SketchPathOption[] = [];
  const add = (sketchFeatureId: string, sketchName: string, sketch: WorkbenchSketch): void => {
    sketch.entities.forEach((entity, index) => {
      const samples = samplesOf(entity);
      if (samples.length < 2) return;
      options.push({
        id: `${sketchFeatureId}/${entity.id}`,
        label: `${sketchName} · ${KIND_LABEL[entity.kind] ?? entity.kind} ${index + 1}`,
        path: { kind: "polyline", pointsMm: samples.map((sample) => sketchPointToWorld(sketch, sample)), sketchFeatureId, entityId: entity.id }
      });
    });
  };
  for (const feature of history.features) if (feature.kind === "sketch") add(feature.id, feature.name, feature.sketch);
  add(working.id, `${working.name} (working)`, working);
  return options;
}

/** The longest straight run of collinear pieces, so a picked edge that was split into several segments is recorded whole. */
function straightRun(pieces: readonly { readonly a: Vec3; readonly b: Vec3 }[]): { readonly a: Vec3; readonly b: Vec3 } | undefined {
  const first = pieces[0];
  if (first === undefined) return undefined;
  const direction = unit(sub(first.b, first.a));
  const points = pieces.flatMap((piece) => [piece.a, piece.b]);
  let lo = Infinity; let hi = -Infinity; let low = points[0]!; let high = points[0]!;
  for (const point of points) {
    const along = dot(sub(point, first.a), direction);
    const off = length(sub(sub(point, first.a), scale(direction, along)));
    if (off > 1e-3) return undefined; // a bent run (a round rim) is not a straight edge
    if (along < lo) { lo = along; low = point; }
    if (along > hi) { hi = along; high = point; }
  }
  return { a: low, b: high };
}

export type PickResult<T> = { readonly ok: true; readonly value: T; readonly message: string } | { readonly ok: false; readonly message: string };

/** The straight edge nearest a click on a body, as an edge reference for a construction plane. Round rims are refused. */
export function edgeRefFromPick(body: GeneralSolidBody, pointMm: Vec3): PickResult<Extract<ConstructionEdgeRef, { readonly kind: "body-edge" }>> {
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices });
  if (typeof edges === "string") return { ok: false, message: edges };
  const nearest = nearestPickableEdge(edges, pointMm);
  if (nearest === undefined) return { ok: false, message: `${body.name} has no sharp edge to pick.` };
  const run = straightRun(nearest.chain);
  if (run === undefined) return { ok: false, message: "That edge is curved (a round rim), and a plane needs a straight edge. Pick a straight one." };
  return { ok: true, value: { kind: "body-edge", bodyId: body.id, a: run.a, b: run.b }, message: `a ${length(sub(run.b, run.a)).toFixed(1)} mm straight edge of ${body.name}` };
}

/** What a click records for each kind of binder. */
export function binderTargetFromPick(body: GeneralSolidBody, kind: ConstructionBinderTarget["kind"], pointMm: Vec3 | undefined): PickResult<ConstructionBinderTarget> {
  if (kind === "body") return { ok: true, value: { kind: "body", bodyId: body.id }, message: `the whole of ${body.name}` };
  if (pointMm === undefined) return { ok: false, message: "Click the model to say which part to bind." };
  if (kind === "face") {
    const face = nearestBodyFace(body, pointMm);
    if (face === undefined) return { ok: false, message: `${body.name} has no face under that click.` };
    return { ok: true, value: faceTargetOf(body, face), message: `${face.planar ? "a flat" : "a curved"} face of ${body.name} (${Math.round(face.areaMm2).toLocaleString()} mm²)` };
  }
  const edge = edgeRefFromPick(body, pointMm);
  if (!edge.ok) return edge;
  return { ok: true, value: { kind: "edge", bodyId: body.id, a: edge.value.a, b: edge.value.b }, message: edge.message };
}

/** A tree and status line for a binder: what it points at and whether it still finds it. */
export function describeBinderKind(binder: ConstructionBinder): string {
  return binder.target.kind === "body" ? "shape binder" : `${binder.target.kind} sub-shape binder`;
}

/** Reads "x, y, z" as a point in millimetres, or undefined when it is not three numbers. */
export function parseTypedPoint(text: string): Vec3 | undefined {
  const parts = text.trim().split(/[\s,;]+/).filter((part) => part !== "").map((part) => Number(part.replace(",", ".")));
  return parts.length === 3 && parts.every((part) => Number.isFinite(part) && Math.abs(part) <= 100_000) ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = length(a); return l < 1e-12 ? [1, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; };

export type EdgeSource = "axis" | "pick" | "points" | "binder";

/** The state of one "which edge" block of the plane dialog. */
export interface EdgeForm {
  source: EdgeSource;
  axisId: string;
  binderId: string;
  picked: Extract<ConstructionEdgeRef, { readonly kind: "body-edge" }> | undefined;
  pickedText: string;
  from: string;
  to: string;
}

/** A fresh edge block, set to the most useful source the part offers. */
export function emptyEdgeForm(axes: readonly ConstructionAxis[], binders: readonly ConstructionBinder[], bodies: readonly GeneralSolidBody[]): EdgeForm {
  return {
    source: axes.length > 0 ? "axis" : bodies.length > 0 ? "pick" : binders.some((binder) => binder.target.kind === "edge") ? "binder" : "points",
    axisId: axes[0]?.id ?? "",
    binderId: binders.find((binder) => binder.target.kind === "edge")?.id ?? "",
    picked: undefined,
    pickedText: "",
    from: "",
    to: ""
  };
}

/** The edge reference an edge block describes, or undefined while it is incomplete. */
export function edgeRefOfForm(form: EdgeForm): ConstructionEdgeRef | undefined {
  if (form.source === "axis") return form.axisId === "" ? undefined : { kind: "axis", axisId: form.axisId };
  if (form.source === "binder") return form.binderId === "" ? undefined : { kind: "binder", binderId: form.binderId };
  if (form.source === "pick") return form.picked;
  const a = parseTypedPoint(form.from); const b = parseTypedPoint(form.to);
  return a === undefined || b === undefined ? undefined : { kind: "segment", a, b };
}

/** The plane definition the dialog's fields describe, or undefined while they are incomplete or out of range. percentText is 0 to 100. */
export function planeDefinitionOfForm(input:
  | { readonly mode: "through-two-edges"; readonly edgeA: EdgeForm; readonly edgeB: EdgeForm }
  | { readonly mode: "along-path"; readonly path: ConstructionPathRef | undefined; readonly percentText: string; readonly orientation: "perpendicular" | "tangent" }): ConstructionPlaneDefinition | undefined {
  if (input.mode === "through-two-edges") {
    const a = edgeRefOfForm(input.edgeA); const b = edgeRefOfForm(input.edgeB);
    return a === undefined || b === undefined ? undefined : { kind: "through-two-edges", edgeA: a, edgeB: b };
  }
  const percent = Number(input.percentText.trim().replace(",", "."));
  if (input.path === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return { kind: "along-path", path: input.path, t: percent / 100, orientation: input.orientation };
}
