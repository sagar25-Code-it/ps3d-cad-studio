import type { DesignSolidFeature } from "../../../packages/workbench-core/src/index.js";
import { validSolidFeaturePayload } from "../../../packages/workbench-core/src/index.js";

/**
 * The editable parameters of every solid step in the timeline. The edit dialog renders `parameterFieldsOf(feature)` and
 * `applyParameterValues` turns the typed text back into a feature that has passed the same validator the saved project uses.
 * Extrude and revolve keep their own dialog (direction, cut extent), so they are not described here.
 */
export interface ParameterField {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly input: "number" | "integer" | "vector" | "select";
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Smallest allowed value (inclusive unless `exclusiveMin`). */
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: boolean;
  readonly hint?: string;
  readonly read: (feature: DesignSolidFeature) => string;
  readonly write: (feature: DesignSolidFeature, value: number | readonly number[] | string) => DesignSolidFeature;
}

const trim = (value: number): string => String(Number(value.toFixed(4)));

function number(id: string, label: string, unit: string, read: (feature: DesignSolidFeature) => number | undefined, write: (feature: DesignSolidFeature, value: number) => DesignSolidFeature, limits: { readonly min?: number; readonly max?: number; readonly exclusiveMin?: boolean; readonly hint?: string } = {}): ParameterField {
  return { id, label, unit, input: "number", ...limits, read: (feature) => { const value = read(feature); return value === undefined ? "" : trim(value); }, write: (feature, value) => write(feature, value as number) };
}

const positive = { min: 0, exclusiveMin: true } as const;

const handedness = (id: string, read: (feature: DesignSolidFeature) => string | undefined, write: (feature: DesignSolidFeature, value: "right" | "left") => DesignSolidFeature): ParameterField => ({
  id, label: "Handedness", unit: "", input: "select", options: [{ value: "right", label: "Right-handed" }, { value: "left", label: "Left-handed" }],
  read: (feature) => read(feature) ?? "right", write: (feature, value) => write(feature, value === "left" ? "left" : "right")
});

const vector = (id: string, label: string, read: (feature: DesignSolidFeature) => readonly number[] | undefined, write: (feature: DesignSolidFeature, value: readonly [number, number, number]) => DesignSolidFeature): ParameterField => ({
  id, label, unit: "mm", input: "vector", hint: "three numbers: x, y, z",
  read: (feature) => (read(feature) ?? [0, 0, 0]).map(trim).join(", "),
  write: (feature, value) => write(feature, value as readonly [number, number, number])
});

/** The fields to show for a step, or undefined when the step has none (extrude and revolve use their own dialog; an indent has no number to edit). */
export function parameterFieldsOf(feature: DesignSolidFeature): readonly ParameterField[] | undefined {
  switch (feature.kind) {
    case "sweep": return [
      number("valueMm", "Distance", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("twist", "Twist", "°", (f) => f.sweepTwistDeg ?? 0, (f, v) => {
        const { sweepTwistDeg: _drop, ...rest } = f; void _drop;
        return v === 0 ? rest : { ...rest, sweepTwistDeg: v };
      }, { min: -3600, max: 3600 }),
      ...(feature.sweepDirectionMm !== undefined ? [vector("direction", "Direction", (f) => f.sweepDirectionMm, (f, v) => ({ ...f, sweepDirectionMm: v }))] : [])
    ];
    case "loft": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      ...(feature.loftTopScale !== undefined ? [number("scale", "Top scale", "×", (f) => f.loftTopScale, (f, v) => ({ ...f, loftTopScale: v }), { ...positive, max: 100 })] : []),
      ...(feature.loftSecondaryProfileIds !== undefined ? [{
        id: "continuity", label: "Continuity", unit: "", input: "select" as const,
        options: [{ value: "position", label: "G0 · position" }, { value: "tangent", label: "G1 · tangent" }, { value: "curvature", label: "G2 · curvature" }],
        read: (f: DesignSolidFeature) => f.loftContinuity ?? "position",
        write: (f: DesignSolidFeature, v: number | readonly number[] | string) => ({ ...f, loftContinuity: v === "tangent" ? "tangent" as const : v === "curvature" ? "curvature" as const : "position" as const })
      }, number("weight", "Tangency weight", "", (f) => f.loftTangencyWeight ?? 1, (f, v) => ({ ...f, loftTangencyWeight: v }), { min: 0, max: 2 })] : [])
    ];
    case "edge-fillet":
    case "edge-chamfer": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("size", feature.kind === "edge-fillet" ? "Radius" : "Distance", "mm", (f) => f.edge?.sizeMm, (f, v) => ({ ...f, edge: { kind: f.kind === "edge-fillet" ? "fillet" as const : "chamfer" as const, sizeMm: v } }), { ...positive, max: 10_000 })
    ];
    case "shell": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("wall", "Wall thickness", "mm", (f) => f.shellThicknessMm, (f, v) => ({ ...f, shellThicknessMm: v }), { ...positive, max: 10_000 }),
      { id: "open", label: "Open face", unit: "", input: "select", options: [{ value: "top", label: "Open top" }, { value: "bottom", label: "Open bottom" }, { value: "none", label: "Fully closed" }],
        read: (f) => f.shellOpenFace ?? "top", write: (f, v) => ({ ...f, shellOpenFace: v === "bottom" ? "bottom" : v === "none" ? "none" : "top" }) }
    ];
    case "draft": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("angle", "Draft angle", "°", (f) => f.draftAngleDeg, (f, v) => ({ ...f, draftAngleDeg: v }), { ...positive, max: 79.9 }),
      { id: "neutral", label: "Neutral face", unit: "", input: "select", options: [{ value: "bottom", label: "Bottom neutral" }, { value: "top", label: "Top neutral" }],
        read: (f) => f.draftNeutralFace ?? "bottom", write: (f, v) => ({ ...f, draftNeutralFace: v === "top" ? "top" : "bottom" }) }
    ];
    case "helix": return [
      number("radius", "Coil radius", "mm", (f) => f.helixRadiusMm, (f, v) => ({ ...f, helixRadiusMm: v }), { ...positive, max: 10_000 }),
      number("pitch", "Pitch", "mm", (f) => f.helixPitchMm, (f, v) => ({ ...f, helixPitchMm: v }), { ...positive, max: 10_000 }),
      number("turns", "Turns", "", (f) => f.helixTurns, (f, v) => ({ ...f, helixTurns: v }), { ...positive, max: 100 }),
      handedness("hand", (f) => f.helixHandedness, (f, v) => ({ ...f, helixHandedness: v }))
    ];
    case "thread": return [
      number("pitch", "Pitch", "mm", (f) => f.threadPitchMm, (f, v) => ({ ...f, threadPitchMm: v }), { ...positive, max: 10_000 }),
      number("turns", "Turns", "", (f) => f.threadTurns, (f, v) => ({ ...f, threadTurns: v }), { ...positive, max: 100 }),
      number("depth", "Depth (coil radius)", "mm", (f) => f.threadDepthMm, (f, v) => ({ ...f, threadDepthMm: v }), { ...positive, max: 10_000 }),
      handedness("hand", (f) => f.threadHandedness, (f, v) => ({ ...f, threadHandedness: v }))
    ];
    case "rib": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("thickness", "Thickness", "mm", (f) => f.ribThicknessMm, (f, v) => ({ ...f, ribThicknessMm: v }), { ...positive, max: 10_000 })
    ];
    case "dome": return [
      number("height", "Dome height", "mm", (f) => f.domeHeightMm, (f, v) => ({ ...f, domeHeightMm: v }), { min: -10_000, max: 10_000, hint: "negative builds the dome below the sketch plane" })
    ];
    case "sheet-base": return [
      number("thickness", "Sheet thickness", "mm", (f) => f.sheetThicknessMm, (f, v) => ({ ...f, sheetThicknessMm: v, valueMm: v }), { ...positive, max: 1000 })
    ];
    case "sheet-flange": return [
      number("valueMm", "Strip width", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("thickness", "Sheet thickness", "mm", (f) => f.sheetThicknessMm, (f, v) => ({ ...f, sheetThicknessMm: v }), { ...positive, max: 1000 }),
      number("radius", "Inner bend radius", "mm", (f) => f.sheetBendRadiusMm, (f, v) => ({ ...f, sheetBendRadiusMm: v }), { min: 0, max: 1000 }),
      number("length", "Flange length", "mm", (f) => f.flangeLengthMm, (f, v) => ({ ...f, flangeLengthMm: v }), { ...positive, max: 10_000 }),
      number("angle", "Bend angle", "°", (f) => f.flangeAngleDeg, (f, v) => ({ ...f, flangeAngleDeg: v }), { ...positive, max: 180 })
    ];
    case "sheet-hem": return [
      number("valueMm", "Strip width", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("thickness", "Sheet thickness", "mm", (f) => f.sheetThicknessMm, (f, v) => ({ ...f, sheetThicknessMm: v }), { ...positive, max: 1000 }),
      number("radius", "Inner bend radius", "mm", (f) => f.sheetBendRadiusMm, (f, v) => ({ ...f, sheetBendRadiusMm: v }), { min: 0, max: 1000 }),
      number("length", "Hem length", "mm", (f) => f.flangeLengthMm, (f, v) => ({ ...f, flangeLengthMm: v }), { ...positive, max: 10_000 }),
      { id: "style", label: "Hem style", unit: "", input: "select", options: [{ value: "closed", label: "Closed hem" }, { value: "open", label: "Open hem" }],
        read: (f) => f.hemStyle ?? "closed", write: (f, v) => ({ ...f, hemStyle: v === "open" ? "open" : "closed" }) }
    ];
    case "sheet-edge-flange": return [
      { id: "edge", label: "Edge number", unit: "", input: "integer", min: 0, max: 1000, hint: "which edge of the original plate, as listed when the flange was made",
        read: (f) => String(f.flangeEdgeIndex ?? 0), write: (f, v) => ({ ...f, flangeEdgeIndex: v as number }) },
      number("radius", "Inner bend radius", "mm", (f) => f.sheetBendRadiusMm, (f, v) => ({ ...f, sheetBendRadiusMm: v }), { min: 0, max: 1000 }),
      number("length", "Flange length", "mm", (f) => f.flangeLengthMm, (f, v) => ({ ...f, flangeLengthMm: v, valueMm: v }), { ...positive, max: 10_000 }),
      number("angle", "Bend angle", "°", (f) => f.flangeAngleDeg, (f, v) => ({ ...f, flangeAngleDeg: v }), { ...positive, max: 180 })
    ];
    case "move-body": return [
      vector("delta", "Move by", (f) => f.moveDeltaMm, (f, v) => ({ ...f, moveDeltaMm: v, valueMm: Math.max(0.01, Math.hypot(v[0], v[1], v[2])) }))
    ];
    case "scale-body": return [
      number("factor", "Scale factor", "×", (f) => f.scaleFactor, (f, v) => ({ ...f, scaleFactor: v, valueMm: Math.max(0.01, v) }), { ...positive, max: 100 })
    ];
    case "move-face": return [
      vector("delta", "Move face by", (f) => f.moveFaceDeltaMm, (f, v) => ({ ...f, moveFaceDeltaMm: v, valueMm: Math.max(0.01, Math.hypot(v[0], v[1], v[2])) }))
    ];
    case "offset-face": return [
      number("offset", "Offset along the face normal", "mm", (f) => f.offsetFaceMm, (f, v) => ({ ...f, offsetFaceMm: v, valueMm: Math.max(0.01, Math.abs(v)) }), { min: -100_000, max: 100_000, hint: "positive pushes the face outward; zero is not allowed" })
    ];
    case "emboss": return [
      number("height", "Emboss height", "mm", (f) => f.embossHeightMm, (f, v) => ({ ...f, embossHeightMm: v, valueMm: Math.max(0.01, Math.abs(v)) }), { min: -10_000, max: 10_000, hint: "negative presses the face in; zero is not allowed" })
    ];
    default: return undefined;
  }
}

export function parameterValuesOf(feature: DesignSolidFeature): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of parameterFieldsOf(feature) ?? []) values[field.id] = field.read(feature);
  return values;
}

export type ParameterResult =
  | { readonly ok: true; readonly feature: DesignSolidFeature }
  | { readonly ok: false; readonly message: string; readonly fieldId?: string };

/** Parses the typed values, applies the ones that changed, and checks the result against the saved-project validator. */
export function applyParameterValues(feature: DesignSolidFeature, values: Readonly<Record<string, string>>): ParameterResult {
  const fields = parameterFieldsOf(feature);
  if (fields === undefined) return { ok: false, message: "This step has no editable numbers." };
  let next = feature;
  for (const field of fields) {
    const raw = (values[field.id] ?? "").trim().replace(/,(?=\d)(?!.*,)/u, ".");
    if (field.input === "select") { next = field.write(next, raw); continue; }
    if (field.input === "vector") {
      const parts = (values[field.id] ?? "").split(/[,\s]+/u).filter((part) => part !== "").map((part) => Number(part.replace(",", ".")));
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return { ok: false, fieldId: field.id, message: `${field.label}: enter three numbers separated by commas.` };
      if (Math.hypot(parts[0]!, parts[1]!, parts[2]!) < 1e-6 && feature.kind !== "sweep") return { ok: false, fieldId: field.id, message: `${field.label}: the vector cannot be zero.` };
      next = field.write(next, parts);
      continue;
    }
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed)) return { ok: false, fieldId: field.id, message: `${field.label}: enter a number.` };
    if (field.input === "integer" && !Number.isInteger(parsed)) return { ok: false, fieldId: field.id, message: `${field.label}: enter a whole number.` };
    if (field.min !== undefined && (field.exclusiveMin === true ? parsed <= field.min : parsed < field.min)) return { ok: false, fieldId: field.id, message: `${field.label}: enter a value ${field.exclusiveMin === true ? "above" : "of at least"} ${field.min}${field.unit === "" ? "" : ` ${field.unit}`}.` };
    if (field.max !== undefined && parsed > field.max) return { ok: false, fieldId: field.id, message: `${field.label}: enter a value of at most ${field.max}${field.unit === "" ? "" : ` ${field.unit}`}.` };
    if ((feature.kind === "dome" || feature.kind === "offset-face" || feature.kind === "emboss") && parsed === 0) return { ok: false, fieldId: field.id, message: `${field.label}: zero would change nothing.` };
    next = field.write(next, parsed);
  }
  if (!validSolidFeaturePayload(next)) return { ok: false, message: "Those values are outside what this step supports." };
  return { ok: true, feature: next };
}
