import type { DesignSolidFeature, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf } from "../../../packages/workbench-core/src/index.js";
import { valueFromDrag } from "../../../packages/viewport-three/src/handle-drag.js";
import type { Mm3 } from "../../../packages/viewport-three/src/handle-drag.js";
import { rebuildSolidFeature, sketchNormal } from "./design-regeneration.js";
import { parameterFieldsOf } from "./feature-parameters.js";
import { panelEdgeGroups, type CommandPanelState } from "./command-panel.js";

/**
 * Where the drag arrow of a command stands and what dragging it means. The arrow changes the command's main value (a fillet's radius,
 * a shell's wall, a hole's diameter, an extrusion's distance): it stands on the picked face or edge, points the way the value grows,
 * and its length is the value. Dragging it writes the number into the panel field live; the panel's own OK commits one history step.
 *
 * `previewHandleSpec` is for a command panel, `extrudeHandleSpec` for an Extrude step (the Edit Feature dock now; the Extrude command
 * after the merge). Both return undefined when there is nothing sensible to stand the arrow on, and the field stays the only control.
 */

export interface PreviewHandleSpec {
  /** The panel / dock field the arrow writes. */
  readonly fieldId: string;
  readonly anchorMm: Mm3;
  readonly directionMm: Mm3;
  /** Millimetres of arrow per unit of the field: 1 for a distance, 0.5 where the arrow shows the radius of a diameter field. */
  readonly tipPerValueMm: number;
  /** Limits of the field, as its own validator states them. */
  readonly min: number;
  readonly exclusiveMin: boolean;
  readonly max?: number;
  /** The rounding of a drag (0.1 mm); Shift divides it by ten. */
  readonly step: number;
  /** The field's number now. */
  readonly value: number;
}

const DRAG_STEP_MM = 0.1;
/** A fillet or chamfer on a right-angle edge reaches the bisector at this many times its size. */
const BLEND_REACH = Math.SQRT2;

/** The length of the arrow for the field's current number. */
export function handleTipDistanceMm(spec: PreviewHandleSpec): number {
  return Math.max(spec.value * spec.tipPerValueMm, 0);
}

/** The field's new number for a drag of `deltaMm` from a press at `startValue`: scaled, rounded to the step and held inside the field's limits. */
export function handleDragValue(spec: PreviewHandleSpec, startValue: number, deltaMm: number, fine: boolean): number {
  return valueFromDrag({
    startValue, valuePerMm: 1 / spec.tipPerValueMm,
    min: spec.min, exclusiveMin: spec.exclusiveMin, ...(spec.max === undefined ? {} : { max: spec.max }),
    step: fine ? spec.step / 10 : spec.step
  }, deltaMm);
}

/** The number as the field's text, without float noise. */
export function handleValueText(value: number): string {
  return String(Number(value.toFixed(4)));
}

const sub = (a: Mm3, b: Mm3): Mm3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Mm3, b: Mm3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Mm3, b: Mm3): Mm3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Mm3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Mm3): Mm3 | undefined => { const length = norm(a); return length < 1e-9 ? undefined : [a[0] / length, a[1] / length, a[2] / length]; };

/** The outward normals of the (usually two) faces that meet along the segment a-b, found from the mesh triangles that have an edge on it. */
export function normalsAlongEdge(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }, a: Mm3, b: Mm3, toleranceMm = 0.05): readonly Mm3[] {
  const axis = sub(b, a);
  const length = norm(axis);
  if (length < 1e-9) return [];
  const along = unit(axis)!;
  const onSegment = (p: Mm3): boolean => {
    const offset = sub(p, a);
    const t = dot(offset, along);
    if (t < -toleranceMm || t > length + toleranceMm) return false;
    const foot: Mm3 = [along[0] * t, along[1] * t, along[2] * t];
    return norm(sub(offset, foot)) <= toleranceMm;
  };
  const point = (index: number): Mm3 => [mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!];
  const found: Mm3[] = [];
  for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
    const corners = [point(mesh.indices[at]!), point(mesh.indices[at + 1]!), point(mesh.indices[at + 2]!)];
    if (corners.filter(onSegment).length < 2) continue;
    const normal = unit(cross(sub(corners[1]!, corners[0]!), sub(corners[2]!, corners[0]!)));
    if (normal !== undefined && !found.some((other) => dot(other, normal) > 0.999)) found.push(normal);
  }
  return found;
}

/**
 * The direction a fillet or chamfer arrow points: along the bisector of the two faces, into the solid for an outside edge (where the
 * blend removes material) and out into the open for an inside corner (where it adds). Undefined when the edge does not have two
 * distinct faces (a flat run, a seam).
 */
export function edgeBlendDirection(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }, a: Mm3, b: Mm3, concave: boolean): Mm3 | undefined {
  const normals = normalsAlongEdge(mesh, a, b);
  if (normals.length < 2) return undefined;
  const sum = unit([normals[0]![0] + normals[1]![0], normals[0]![1] + normals[1]![1], normals[0]![2] + normals[1]![2]]);
  if (sum === undefined) return undefined;
  return concave ? sum : [-sum[0], -sum[1], -sum[2]];
}

function limitsOf(feature: DesignSolidFeature, fieldId: string): { readonly min: number; readonly exclusiveMin: boolean; readonly max?: number } {
  const field = parameterFieldsOf(feature)?.find((candidate) => candidate.id === fieldId);
  return { min: field?.min ?? 0, exclusiveMin: field?.exclusiveMin ?? true, ...(field?.max === undefined ? {} : { max: field.max }) };
}

function numberOf(feature: DesignSolidFeature, fieldId: string): number | undefined {
  const text = parameterFieldsOf(feature)?.find((candidate) => candidate.id === fieldId)?.read(feature);
  const value = text === undefined ? NaN : Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** A direction in the plane of a face, for the arrow that shows a hole's radius. */
function tangentOf(normal: Mm3): Mm3 | undefined {
  const helper: Mm3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return unit(cross(normal, helper));
}

/**
 * The arrow for a command panel, given the step the panel would commit with its current values (`feature`, from panelCandidate).
 * Fillet and chamfer: on the first picked edge run, along the bisector, size = reach / √2. Shell: on the first open face, into the wall.
 * Hole: at the start point, along the face, showing the radius of the diameter field.
 */
export function previewHandleSpec(project: WorkbenchProject, state: CommandPanelState, feature: DesignSolidFeature): PreviewHandleSpec | undefined {
  const body = (project.part.generalBodies ?? []).find((candidate) => candidate.id === state.bodyId);
  if (body === undefined) return undefined;
  if (state.command === "fillet" || state.command === "chamfer") {
    const group = panelEdgeGroups(state)[0];
    const segment = group?.segments.reduce<readonly [Mm3, Mm3] | undefined>((best, candidate) => best === undefined || norm(sub(candidate[1], candidate[0])) > norm(sub(best[1], best[0])) ? candidate : best, undefined);
    const value = numberOf(feature, "size");
    if (group === undefined || segment === undefined || value === undefined) return undefined;
    const direction = edgeBlendDirection(body, segment[0], segment[1], group.concave === true);
    if (direction === undefined) return undefined;
    return {
      fieldId: "size", anchorMm: [(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2, (segment[0][2] + segment[1][2]) / 2], directionMm: direction,
      tipPerValueMm: BLEND_REACH, ...limitsOf(feature, "size"), step: DRAG_STEP_MM, value
    };
  }
  if (state.command === "shell") {
    const face = state.faces[0]?.ref;
    const value = numberOf(feature, "wall");
    const normal = face === undefined ? undefined : unit(face.normalMm as Mm3);
    if (face === undefined || normal === undefined || value === undefined) return undefined;
    // Outward walls grow along the face's normal; inward and two-sided walls grow into the solid.
    const sign = state.values["side"] === "outside" ? 1 : -1;
    return { fieldId: "wall", anchorMm: face.pointMm as Mm3, directionMm: [normal[0] * sign, normal[1] * sign, normal[2] * sign], tipPerValueMm: 1, ...limitsOf(feature, "wall"), step: DRAG_STEP_MM, value };
  }
  const point = state.holePoint;
  const value = numberOf(feature, "diameter");
  const tangent = point === undefined ? undefined : tangentOf(point.normal as Mm3);
  if (point === undefined || tangent === undefined || value === undefined) return undefined;
  return { fieldId: "diameter", anchorMm: point.pointMm as Mm3, directionMm: tangent, tipPerValueMm: 0.5, ...limitsOf(feature, "diameter"), step: DRAG_STEP_MM, value };
}

/**
 * The arrow for an Extrude step: on the profile's start plane, along the extrusion, as long as the distance. Offered for the one-side and
 * flipped directions with a plain distance; symmetric, two-sided and reach-to extents have no single end to drag, so those keep the field.
 */
export async function extrudeHandleSpec(project: WorkbenchProject, feature: DesignSolidFeature, distanceMm: number): Promise<PreviewHandleSpec | undefined> {
  if (feature.kind !== "extrude" || !(distanceMm > 0)) return undefined;
  const direction = feature.direction ?? "one-side";
  if ((direction !== "one-side" && direction !== "flipped") || (feature.extent !== undefined && feature.extent !== "distance")) return undefined;
  const sketch = designOf(project).features.find((candidate) => candidate.id === feature.sketchFeatureId);
  if (sketch === undefined || sketch.kind !== "sketch") return undefined;
  const built = await rebuildSolidFeature({ ...feature, valueMm: distanceMm }, sketch);
  if (!built.ok) return undefined;
  const normal = sketchNormal(sketch) as Mm3;
  const heights: number[] = [];
  for (let index = 0; index + 2 < built.body.positionsMm.length; index += 3) heights.push(dot([built.body.positionsMm[index]!, built.body.positionsMm[index + 1]!, built.body.positionsMm[index + 2]!], normal));
  if (heights.length === 0) return undefined;
  const flipped = direction === "flipped";
  const extreme = flipped ? Math.max(...heights) : Math.min(...heights);
  let sum: Mm3 = [0, 0, 0];
  let count = 0;
  heights.forEach((height, vertex) => {
    if (Math.abs(height - extreme) > 1e-3) return;
    sum = [sum[0] + built.body.positionsMm[vertex * 3]!, sum[1] + built.body.positionsMm[vertex * 3 + 1]!, sum[2] + built.body.positionsMm[vertex * 3 + 2]!];
    count += 1;
  });
  if (count === 0) return undefined;
  return {
    fieldId: "distance", anchorMm: [sum[0] / count, sum[1] / count, sum[2] / count],
    directionMm: flipped ? [-normal[0], -normal[1], -normal[2]] : normal,
    tipPerValueMm: 1, min: 0, exclusiveMin: true, step: DRAG_STEP_MM, value: distanceMm
  };
}
