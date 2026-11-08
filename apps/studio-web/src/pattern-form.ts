import type { PatternShape } from "../../../packages/workbench-core/src/index.js";
import type { PatternRequest } from "./pattern-commit.js";

/** What the pattern dialog's fields hold, as typed text, and how that text becomes a pattern request. */
export interface PatternForm {
  readonly target: "body" | "features";
  readonly featureIds: readonly string[];
  readonly result: "new-bodies" | "join";
  readonly directionA: string;
  readonly countA: string;
  readonly spacingA: string;
  readonly sizing: "spacing" | "extent";
  readonly directionB: string;
  readonly countB: string;
  readonly spacingB: string;
  readonly count: string;
  readonly angle: string;
  /** "x", "y" or "z" for a world axis through the origin, otherwise a construction axis ID. */
  readonly axis: string;
  /** "xy", "xz" or "yz" for a datum plane, otherwise a construction plane ID. */
  readonly plane: string;
  readonly offset: string;
}

export const PATTERN_DIRECTIONS: readonly { readonly id: string; readonly label: string; readonly vector: readonly [number, number, number] }[] = [
  { id: "x", label: "+X", vector: [1, 0, 0] }, { id: "-x", label: "−X", vector: [-1, 0, 0] },
  { id: "y", label: "+Y", vector: [0, 1, 0] }, { id: "-y", label: "−Y", vector: [0, -1, 0] },
  { id: "z", label: "+Z", vector: [0, 0, 1] }, { id: "-z", label: "−Z", vector: [0, 0, -1] }
];

const directionIdOf = (vector: readonly number[] | undefined, fallback: string): string => {
  if (vector === undefined) return fallback;
  return PATTERN_DIRECTIONS.find((candidate) => candidate.vector.every((component, index) => Math.abs(component - vector[index]!) < 1e-9))?.id ?? fallback;
};

const parse = (value: string): number => Number(value.trim().replace(",", "."));
const show = (value: number | undefined, fallback: string): string => (value === undefined ? fallback : String(Number(value.toFixed(4))));

/** The fields for a request being edited, or the defaults for a new pattern. */
export function formOfRequest(request?: PatternRequest): PatternForm {
  const shape = request?.shape;
  const rectangular = shape?.type === "rectangular" ? shape : undefined;
  const circular = shape?.type === "circular" ? shape : undefined;
  const mirror = shape?.type === "mirror" ? shape : undefined;
  return {
    target: request?.featureIds !== undefined && request.featureIds.length > 0 ? "features" : "body",
    featureIds: request?.featureIds ?? [],
    result: request?.result ?? "new-bodies",
    directionA: directionIdOf(rectangular?.directionA, "x"),
    countA: show(rectangular?.countA, "3"),
    spacingA: show(rectangular?.spacingAMm, "50"),
    sizing: rectangular?.sizing ?? "spacing",
    directionB: directionIdOf(rectangular?.directionB, "y"),
    countB: show(rectangular?.countB, "1"),
    spacingB: show(rectangular?.spacingBMm, "50"),
    count: show(circular?.count, "4"),
    angle: show(circular?.totalAngleDeg, "360"),
    axis: circular === undefined ? "z" : circular.axis.kind === "datum" ? circular.axis.axis : circular.axis.axisId,
    plane: mirror === undefined ? "yz" : mirror.plane.kind === "datum" ? mirror.plane.plane : mirror.plane.planeId,
    offset: show(mirror?.plane.kind === "datum" ? mirror.plane.offsetMm : undefined, "0")
  };
}

/** Reads the typed fields into a request, or says in plain words what is wrong with them. */
export function requestOfForm(kind: PatternShape["type"], form: PatternForm, sourceBodyId: string): { readonly request: PatternRequest } | { readonly message: string } {
  const direction = (id: string): readonly [number, number, number] => PATTERN_DIRECTIONS.find((candidate) => candidate.id === id)?.vector ?? [1, 0, 0];
  let shape: PatternShape;
  if (kind === "rectangular") {
    const a = parse(form.countA);
    const b = parse(form.countB);
    if (!Number.isInteger(a) || a < 1 || a > 100) return { message: "Direction 1 needs a whole number of instances from 1 to 100." };
    if (!Number.isInteger(b) || b < 1 || b > 100) return { message: "Direction 2 needs a whole number of instances from 1 to 100." };
    if (a * b < 2) return { message: "Use at least two instances in total." };
    if (a * b > 100) return { message: "A pattern holds at most 100 instances in total." };
    const sa = parse(form.spacingA);
    const sb = parse(form.spacingB);
    if (a > 1 && !(sa > 0)) return { message: form.sizing === "extent" ? "Direction 1 needs an extent above zero." : "Direction 1 needs a spacing above zero." };
    if (b > 1 && !(sb > 0)) return { message: form.sizing === "extent" ? "Direction 2 needs an extent above zero." : "Direction 2 needs a spacing above zero." };
    shape = { type: "rectangular", countA: a, spacingAMm: a > 1 ? sa : 1, directionA: direction(form.directionA), countB: b, spacingBMm: b > 1 ? sb : 0, directionB: direction(form.directionB), sizing: form.sizing };
  } else if (kind === "circular") {
    const n = parse(form.count);
    const total = parse(form.angle);
    if (!Number.isInteger(n) || n < 2 || n > 100) return { message: "Use a whole number of instances from 2 to 100." };
    if (!Number.isFinite(total) || Math.abs(total) < 0.001 || Math.abs(total) > 360) return { message: "The total angle must be between 0 and 360 degrees (negative turns the other way)." };
    shape = { type: "circular", count: n, totalAngleDeg: total, axis: form.axis === "x" || form.axis === "y" || form.axis === "z" ? { kind: "datum", axis: form.axis } : { kind: "construction", axisId: form.axis } };
  } else {
    const shift = parse(form.offset);
    if (!Number.isFinite(shift)) return { message: "The plane position must be a number." };
    const plane = form.plane;
    shape = { type: "mirror", plane: plane === "xy" || plane === "xz" || plane === "yz" ? { kind: "datum", plane, ...(shift === 0 ? {} : { offsetMm: shift }) } : { kind: "construction", planeId: plane } };
  }
  if (form.target === "features" && form.featureIds.length === 0) return { message: "Tick at least one hole or cut to repeat." };
  return { request: { shape, result: form.target === "features" ? "join" : form.result, sourceBodyId, ...(form.target === "features" ? { featureIds: form.featureIds } : {}) } };
}
