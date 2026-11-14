import type { DesignSolidFeature, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { bindFeatureExpressions, edgeBlendTitle, findBindableField, validSolidFeaturePayload } from "../../../packages/workbench-core/src/index.js";
import { bodyEditFields, bodyEditName } from "./body-edit-parameters.js";

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
  /** A field a caller may leave out: its value is then left as it is (the thread fields of a hole). */
  readonly optional?: boolean;
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

const optionalField = (field: ParameterField): ParameterField => ({ ...field, optional: true });

type HoleThreadValue = NonNullable<DesignSolidFeature["holeThread"]>;
const withThread = (feature: DesignSolidFeature, change: Partial<HoleThreadValue>): DesignSolidFeature => feature.holeThread === undefined ? feature : { ...feature, holeThread: { ...feature.holeThread, ...change } };

/** A tapped hole's thread: none, a cosmetic annotation, or a modelled helical groove. The numbers only apply once a thread is chosen. */
function holeThreadFields(feature: DesignSolidFeature): readonly ParameterField[] {
  const pitch = feature.holeThread?.pitchMm ?? 1;
  return [
    { id: "thread", label: "Thread", unit: "", optional: true, input: "select", options: [{ value: "none", label: "No thread (plain hole)" }, { value: "cosmetic", label: "Cosmetic thread" }, { value: "modelled", label: "Modelled thread" }],
      read: (f) => f.holeThread?.mode ?? "none",
      write: (f, v) => {
        if (v !== "none" && v !== "cosmetic" && v !== "modelled") return f;
        if (v === "none") { const { holeThread: _drop, ...rest } = f; void _drop; return rest; }
        const mode = v === "modelled" ? "modelled" as const : "cosmetic" as const;
        return f.holeThread === undefined ? { ...f, holeThread: { mode, pitchMm: pitch, majorDiameterMm: Number(((f.holeDiameterMm ?? 5) + 1.0825 * pitch).toFixed(3)), handedness: "right" } } : withThread(f, { mode });
      } },
    optionalField(number("threadPitch", "Thread pitch", "mm", (f) => f.holeThread?.pitchMm ?? pitch, (f, v) => withThread(f, { pitchMm: v }), { ...positive, max: 50 })),
    optionalField(number("threadMajor", "Thread major diameter", "mm", (f) => f.holeThread?.majorDiameterMm ?? Number(((f.holeDiameterMm ?? 5) + 1.0825 * pitch).toFixed(3)), (f, v) => withThread(f, { majorDiameterMm: v }), { ...positive, max: 10_000, hint: "the hole's own diameter is the tap-drill (minor) diameter" })),
    optionalField(number("threadLength", "Thread length", "mm", (f) => f.holeThread?.lengthMm ?? 0, (f, v) => {
      if (f.holeThread === undefined) return f;
      const { lengthMm: _drop, ...rest } = f.holeThread; void _drop;
      return { ...f, holeThread: v > 0 ? { ...rest, lengthMm: v } : rest };
    }, { min: 0, max: 100_000, hint: "0 threads the hole's full depth" })),
    optionalField(handedness("threadHand", (f) => f.holeThread?.handedness, (f, v) => withThread(f, { handedness: v })))
  ];
}

/** The fields to show for a step, or undefined when the step has none (extrude and revolve use their own dialog; an indent has no number to edit). */
export function parameterFieldsOf(feature: DesignSolidFeature): readonly ParameterField[] | undefined {
  if (feature.bodyEdit !== undefined) return bodyEditFields(feature);
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
      number("angle", "Bend angle", "°", (f) => f.flangeAngleDeg, (f, v) => ({ ...f, flangeAngleDeg: v }), { ...positive, max: 180 }),
      number("relief", "Corner relief", "mm", (f) => f.flangeReliefMm ?? 0, (f, v) => ({ ...f, flangeReliefMm: v }), { min: 0, max: 1000, hint: "size of the relief where this flange meets a neighbouring flange; 0 for none" }),
      { id: "reliefShape", label: "Relief shape", unit: "", input: "select", options: [{ value: "straight", label: "Straight gap" }, { value: "square", label: "Square notch" }, { value: "round", label: "Round notch" }],
        read: (f) => f.flangeReliefShape ?? "straight", write: (f, v) => {
          const { flangeReliefShape: _drop, ...rest } = f; void _drop;
          return v === "square" ? { ...rest, flangeReliefShape: "square" as const } : v === "round" ? { ...rest, flangeReliefShape: "round" as const } : rest;
        } }
    ];
    case "sheet-jog": return [
      { id: "edge", label: "Edge number", unit: "", input: "integer", min: 0, max: 1000, hint: "the plate edge the jog line runs parallel to",
        read: (f) => String(f.jogEdgeIndex ?? 0), write: (f, v) => ({ ...f, jogEdgeIndex: v as number }) },
      number("position", "Distance from the edge", "mm", (f) => f.jogPositionMm, (f, v) => ({ ...f, jogPositionMm: v }), { min: 0, max: 100_000, hint: "to where the first bend starts" }),
      number("offset", "Step height", "mm", (f) => f.jogOffsetMm, (f, v) => ({ ...f, jogOffsetMm: v, valueMm: Math.max(0.01, Math.abs(v)) }), { min: -10_000, max: 10_000, hint: "positive steps up, negative down; zero is not allowed" }),
      number("angle", "Jog angle", "°", (f) => f.jogAngleDeg, (f, v) => ({ ...f, jogAngleDeg: v }), { min: 1, max: 89 }),
      number("radius", "Inner bend radius", "mm", (f) => f.sheetBendRadiusMm, (f, v) => ({ ...f, sheetBendRadiusMm: v }), { min: 0, max: 1000 })
    ];
    case "sheet-lofted-bend": return [
      number("valueMm", "Height", "mm", (f) => Math.abs(f.valueMm), (f, v) => ({ ...f, valueMm: v }), positive),
      number("thickness", "Sheet thickness", "mm", (f) => f.sheetThicknessMm, (f, v) => ({ ...f, sheetThicknessMm: v }), { ...positive, max: 1000 }),
      ...(feature.loftTopScale !== undefined ? [number("scale", "Top scale", "×", (f) => f.loftTopScale, (f, v) => ({ ...f, loftTopScale: v }), { ...positive, max: 100 })] : [])
    ];
    case "hole": return [
      vector("position", "Position on the face", (f) => f.holePositionMm, (f, v) => ({ ...f, holePositionMm: v })),
      number("diameter", "Hole diameter", "mm", (f) => f.holeDiameterMm, (f, v) => ({ ...f, holeDiameterMm: v }), { ...positive, max: 10_000 }),
      number("depth", "Depth", "mm", (f) => f.holeDepthMm ?? 0, (f, v) => ({ ...f, holeDepthMm: v }), { min: 0, max: 100_000, hint: "0 drills through everything" }),
      ...(feature.holeStyle === "counterbore" ? [
        number("counterDiameter", "Pocket diameter", "mm", (f) => f.holeCounterDiameterMm, (f, v) => ({ ...f, holeCounterDiameterMm: v }), { ...positive, max: 10_000 }),
        number("counterDepth", "Pocket depth", "mm", (f) => f.holeCounterDepthMm, (f, v) => ({ ...f, holeCounterDepthMm: v }), { ...positive, max: 100_000 })
      ] : []),
      ...(feature.holeStyle === "countersink" ? [
        number("sinkDiameter", "Countersink diameter", "mm", (f) => f.holeSinkDiameterMm, (f, v) => ({ ...f, holeSinkDiameterMm: v }), { ...positive, max: 10_000 }),
        number("sinkAngle", "Countersink angle", "°", (f) => f.holeSinkAngleDeg, (f, v) => ({ ...f, holeSinkAngleDeg: v }), { min: 10, max: 170 })
      ] : []),
      ...(feature.holeStyle === "simple" ? holeThreadFields(feature) : [])
    ];
    case "edge-blend": return feature.blendType === "chamfer" ? [
      number("size", "First distance", "mm", (f) => f.valueMm, (f, v) => ({ ...f, valueMm: v }), { ...positive, max: 10_000 }),
      number("second", "Second distance", "mm", (f) => f.blendSecondSizeMm ?? 0, (f, v) => {
        const { blendSecondSizeMm: _drop, ...rest } = f; void _drop;
        return v === 0 || v === f.valueMm ? rest : { ...rest, blendSecondSizeMm: v };
      }, { min: 0, max: 10_000, hint: "0 or the same as the first for an even chamfer; ignored when an angle is set" }),
      number("angle", "Angle with the first face", "°", (f) => f.blendAngleDeg ?? 0, (f, v) => {
        const { blendAngleDeg: _drop, ...rest } = f; void _drop;
        if (v === 0) return rest;
        const { blendSecondSizeMm: _second, ...withoutSecond } = rest; void _second;
        return { ...withoutSecond, blendAngleDeg: v };
      }, { min: 0, max: 179, hint: "0 uses the distances; otherwise the first distance and this angle define the bevel" }),
      { id: "side", label: "Sides", unit: "", input: "select", options: [{ value: "normal", label: "First distance on the upper face" }, { value: "flipped", label: "First distance on the other face" }],
        read: (f) => f.blendFlip === true ? "flipped" : "normal", write: (f, v) => { const { blendFlip: _drop, ...rest } = f; void _drop; return v === "flipped" ? { ...rest, blendFlip: true } : rest; } }
    ] : [
      number("size", "Radius", "mm", (f) => f.valueMm, (f, v) => ({ ...f, valueMm: v }), { ...positive, max: 10_000 }),
      number("endSize", "End radius", "mm", (f) => f.blendEndSizeMm ?? 0, (f, v) => {
        const { blendEndSizeMm: _drop, ...rest } = f; void _drop;
        return v === 0 || v === f.valueMm ? rest : { ...rest, blendEndSizeMm: v };
      }, { min: 0, max: 10_000, hint: "0 or the same as the radius for a constant fillet; otherwise the radius changes evenly along each picked edge" })
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
    case "combine": return [
      { id: "mode", label: "Operation", unit: "", input: "select",
        options: [{ value: "join", label: "Join" }, { value: "cut", label: "Cut" }, { value: "intersect", label: "Intersect" }],
        read: (f) => f.combineMode ?? "join",
        write: (f, v) => ({ ...f, combineMode: v === "cut" ? "cut" as const : v === "intersect" ? "intersect" as const : "join" as const }) }
    ];
    default: return undefined;
  }
}

/** The text each field shows: the expression when the number is bound to one, the number otherwise. */
export function parameterValuesOf(feature: DesignSolidFeature): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of parameterFieldsOf(feature) ?? []) values[field.id] = feature.expressions?.[field.id] ?? field.read(feature);
  return values;
}

/** Whether a field's number can be driven by an expression (not every field can: a vector or a choice cannot). */
export function fieldAcceptsExpression(feature: DesignSolidFeature, fieldId: string): boolean {
  return findBindableField(feature, fieldId) !== undefined;
}

export type ParameterResult =
  | { readonly ok: true; readonly feature: DesignSolidFeature }
  | { readonly ok: false; readonly message: string; readonly fieldId?: string };

/**
 * Parses the typed values, applies the ones that changed, and checks the result against the saved-project validator.
 *
 * With `project`, a number field may also hold an expression (`2 * pin_r`, `Extrude1.distance / 2`): it is bound to the field, the
 * field takes what it evaluates to, and a field typed as a plain number is unbound. Without `project`, only plain numbers are accepted.
 */
export function applyParameterValues(feature: DesignSolidFeature, values: Readonly<Record<string, string>>, project?: WorkbenchProject): ParameterResult {
  const fields = parameterFieldsOf(feature);
  if (fields === undefined) return { ok: false, message: "This step has no editable numbers." };
  let next = feature;
  const expressionTexts: Record<string, string> = {};
  for (const field of fields) {
    if (field.optional === true && values[field.id] === undefined) continue;
    const typed = (values[field.id] ?? "").trim();
    const raw = typed.replace(/,(?=\d)(?!.*,)/u, ".");
    if (project !== undefined && (field.input === "number" || field.input === "integer") && typed !== "" && !Number.isFinite(Number(raw)) && fieldAcceptsExpression(feature, field.id)) {
      expressionTexts[field.id] = typed;
      continue;
    }
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
  if (project !== undefined && (Object.keys(expressionTexts).length > 0 || feature.expressions !== undefined)) {
    const bound = bindFeatureExpressions(project, next, expressionTexts);
    if (!bound.ok) {
      const label = fields.find((field) => field.id === bound.fieldId)?.label ?? "Value";
      return { ok: false, fieldId: bound.fieldId, message: `${label}: ${bound.message}${bound.position === undefined ? "" : ` (character ${bound.position + 1})`}` };
    }
    next = bound.feature;
  }
  if (!validSolidFeaturePayload(next)) return { ok: false, message: "Those values are outside what this step supports." };
  return { ok: true, feature: { ...next, name: refreshedName(next) } };
}

/**
 * Steps made by the app carry their numbers in their name ("Edge flange 0 (90°, 15 mm)"). After an edit the name is brought up to
 * date, but only the part the app wrote: a name the user has changed to something else is left alone.
 */
export function refreshedName(feature: DesignSolidFeature): string {
  if (feature.bodyEdit !== undefined) return bodyEditName(feature);
  const name = feature.name;
  const vectorText = (v: readonly number[] | undefined): string => (v ?? [0, 0, 0]).map((value) => value.toFixed(1)).join(", ");
  switch (feature.kind) {
    case "sheet-edge-flange":
      return name.replace(/^Edge flange \d+/u, `Edge flange ${feature.flangeEdgeIndex ?? 0}`).replace(/\(\d+(?:\.\d+)?°, \d+(?:\.\d+)? mm\)$/u, `(${(feature.flangeAngleDeg ?? 0).toFixed(0)}°, ${(feature.flangeLengthMm ?? 0).toFixed(0)} mm)`);
    case "sheet-jog":
      return name.replace(/^Jog \d+/u, `Jog ${feature.jogEdgeIndex ?? 0}`).replace(/\(-?\d+(?:\.\d+)? mm, \d+(?:\.\d+)?°\)$/u, `(${(feature.jogOffsetMm ?? 0).toFixed(0)} mm, ${(feature.jogAngleDeg ?? 0).toFixed(0)}°)`);
    case "hole": return name.replace(/Ø\s?\d+(?:\.\d+)?/u, `Ø${(feature.holeDiameterMm ?? 0).toFixed(2)}`);
    case "edge-blend": return name.replace(/^(?:Fillet|Chamfer) [^(]*?(?= \(|$)/u, edgeBlendTitle(feature));
    case "move-body": return name.replace(/\([^()]*mm\)$/u, `(${vectorText(feature.moveDeltaMm)} mm)`);
    case "move-face": return name.replace(/\([^()]*mm\)$/u, `(${vectorText(feature.moveFaceDeltaMm)} mm)`);
    case "scale-body": return name.replace(/×[\d.]+$/u, `×${(feature.scaleFactor ?? 1).toFixed(3)}`);
    case "offset-face": return name.replace(/-?\d+(?:\.\d+)? mm$/u, `${(feature.offsetFaceMm ?? 0).toFixed(2)} mm`);
    case "emboss": return name.replace(/-?\d+(?:\.\d+)? mm$/u, `${(feature.embossHeightMm ?? 0).toFixed(2)} mm`);
    default: return name;
  }
}

/** What the extrude/revolve form holds besides the size: the side, a second side, the "To" reach it keeps, and a revolve's thin wall. */
export interface PlainSizeInput {
  readonly text: string;
  readonly direction: NonNullable<DesignSolidFeature["direction"]>;
  readonly throughAll: boolean;
  /** The step keeps the target recorded when it was made; its size is measured from that target and `text` is ignored. */
  readonly reaching?: boolean;
  /** The second side of a two-side step, as typed (a plain number). */
  readonly secondText?: string;
  /** A revolve's thin wall: the thickness as typed (a plain number) and the side the wall sits on. */
  readonly thin?: { readonly wallText: string; readonly side: NonNullable<DesignSolidFeature["thinSide"]> };
}

/**
 * The size of an extrude (distance) or a revolve (angle), which have their own form instead of a field list. `text` is a plain number
 * or an expression; `direction` is the step's side; `throughAll` keeps a cut's size out of it. A plain number unbinds the size. The
 * second side, the "To" reach and the thin wall travel with it (see `PlainSizeInput`), and the result passes the saved-project validator.
 */
export function applyPlainSize(feature: DesignSolidFeature, input: PlainSizeInput, project: WorkbenchProject): ParameterResult {
  const isExtrude = feature.kind === "extrude";
  const fieldId = isExtrude ? "distance" : "angle";
  const reaching = input.reaching === true;
  const { direction: _direction, extent: _extent, extentTarget: _target, secondValueMm: _second, thinWallMm: _wall, thinSide: _side, ...rest } = feature;
  void _direction; void _extent; void _target; void _second; void _wall; void _side;
  const typed = input.text.trim();
  const parsed = input.throughAll || reaching ? Math.abs(feature.valueMm) : Number(typed.replace(",", "."));
  const isExpression = !input.throughAll && !reaching && typed !== "" && !Number.isFinite(parsed);
  if (!isExpression && (!Number.isFinite(parsed) || parsed <= 0 || (!isExtrude && parsed > 360))) {
    return { ok: false, fieldId, message: isExtrude ? "Enter a distance greater than zero." : "Enter an angle between 0 and 360 degrees." };
  }
  const secondParsed = Number((input.secondText ?? "").trim().replace(",", "."));
  const twoSide = input.direction === "two-side" && !input.throughAll;
  if (twoSide && (!Number.isFinite(secondParsed) || secondParsed <= 0)) return { ok: false, fieldId, message: `Enter a second ${isExtrude ? "distance" : "angle"} greater than zero.` };
  const wallParsed = Number((input.thin?.wallText ?? "").trim().replace(",", "."));
  if (!isExtrude && input.thin !== undefined && (!Number.isFinite(wallParsed) || wallParsed <= 0)) return { ok: false, fieldId, message: "Enter a wall thickness greater than zero." };
  const placement = {
    ...(input.direction !== "one-side" && !input.throughAll ? { direction: input.direction } : {}),
    ...(twoSide ? { secondValueMm: secondParsed } : {}),
    ...(input.throughAll ? { extent: "through-all" as const } : {}),
    ...(reaching && feature.extentTarget !== undefined && feature.extent !== undefined ? { extent: feature.extent, extentTarget: feature.extentTarget } : {}),
    ...(!isExtrude && input.thin !== undefined ? { thinWallMm: wallParsed, thinSide: input.thin.side } : {})
  };
  const checked = (next: DesignSolidFeature): ParameterResult => {
    if (!isExtrude && twoSide && !reaching && next.valueMm + secondParsed > 360) return { ok: false, fieldId, message: "The two angles add up to more than a full turn." };
    if (!validSolidFeaturePayload(next)) return { ok: false, fieldId, message: "Those settings do not go together. A To extent cannot be symmetric or (for a revolve) two-sided." };
    return { ok: true, feature: next };
  };
  // Anything that is not a plain number is an expression (pin_r * 2): it is bound to the size and evaluated now.
  if (isExpression) {
    const bound = bindFeatureExpressions(project, { ...rest, ...placement }, { [fieldId]: typed });
    if (!bound.ok) return { ok: false, fieldId, message: `${bound.message}${bound.position === undefined ? "" : ` (character ${bound.position + 1})`}` };
    return checked(bound.feature);
  }
  const plain = bindFeatureExpressions(project, { ...rest, valueMm: parsed, ...placement }, {});
  return checked(plain.ok ? plain.feature : { ...rest, valueMm: parsed, ...placement });
}

/**
 * HS-07: the size typed when a step is created (the Part Extrude or Revolve field, the Create solid height). A plain number leaves the
 * step as it is. Anything else is an expression (`plate_h / 2`, `Extrude1.distance`): it is bound to the step's own size (`distance`
 * of an extrude, `angle` of a revolve) and the size takes what it evaluates to, so the new step follows its parameters from then on.
 * Refuses, with the evaluator's message, an expression that does not evaluate or a step that cannot take one.
 */
export function bindTypedSize(project: WorkbenchProject, feature: DesignSolidFeature, text: string): ParameterResult {
  const fieldId = feature.kind === "extrude" ? "distance" : feature.kind === "revolve" ? "angle" : undefined;
  const typed = text.trim();
  if (typed === "" || Number.isFinite(Number(typed.replace(",", ".")))) return { ok: true, feature };
  if (fieldId === undefined) return { ok: false, message: `${feature.name} takes a plain number here.` };
  const bound = bindFeatureExpressions(project, feature, { [fieldId]: typed });
  if (!bound.ok) return { ok: false, fieldId, message: `${bound.message}${bound.position === undefined ? "" : ` (character ${bound.position + 1})`}` };
  return { ok: true, feature: bound.feature };
}
