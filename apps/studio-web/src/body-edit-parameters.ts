import type { BodyEditSpec, DesignSolidFeature } from "../../../packages/workbench-core/src/index.js";
import { describeBodyEdit } from "../../../packages/workbench-core/src/index.js";
import type { ParameterField } from "./feature-parameters.js";

/**
 * The editable numbers of the face-driven steps (general shell, draft, offset region, rib / web, wrap, flex). The faces
 * themselves are not edited here: they were picked in the viewport, so changing which faces a step uses means redoing the step.
 */
const trim = (value: number): string => String(Number(value.toFixed(4)));

type Spec<K extends BodyEditSpec["kind"]> = Extract<BodyEditSpec, { readonly kind: K }>;

function withSpec(feature: DesignSolidFeature, spec: BodyEditSpec, valueMm: number): DesignSolidFeature {
  return { ...feature, bodyEdit: spec, valueMm: Math.max(0.01, Math.abs(valueMm)) };
}

function numberField<K extends BodyEditSpec["kind"]>(kind: K, id: string, label: string, unit: string, read: (spec: Spec<K>) => number, write: (spec: Spec<K>, value: number) => BodyEditSpec, valueOf: (spec: BodyEditSpec) => number, limits: Pick<ParameterField, "min" | "max" | "exclusiveMin" | "hint"> = {}): ParameterField {
  return {
    id, label, unit, input: "number", ...limits,
    read: (feature) => (feature.bodyEdit?.kind === kind ? trim(read(feature.bodyEdit as Spec<K>)) : ""),
    write: (feature, value) => {
      if (feature.bodyEdit?.kind !== kind) return feature;
      const next = write(feature.bodyEdit as Spec<K>, value as number);
      return withSpec(feature, next, valueOf(next));
    }
  };
}

function selectField<K extends BodyEditSpec["kind"]>(kind: K, id: string, label: string, options: readonly { readonly value: string; readonly label: string }[], read: (spec: Spec<K>) => string, write: (spec: Spec<K>, value: string) => BodyEditSpec): ParameterField {
  return {
    id, label, unit: "", input: "select", options,
    read: (feature) => (feature.bodyEdit?.kind === kind ? read(feature.bodyEdit as Spec<K>) : ""),
    write: (feature, value) => {
      if (feature.bodyEdit?.kind !== kind) return feature;
      return { ...feature, bodyEdit: write(feature.bodyEdit as Spec<K>, String(value)) };
    }
  };
}

function vectorField<K extends BodyEditSpec["kind"]>(kind: K, id: string, label: string, unit: string, read: (spec: Spec<K>) => readonly number[], write: (spec: Spec<K>, value: readonly [number, number, number]) => BodyEditSpec): ParameterField {
  return {
    id, label, unit, input: "vector", hint: "three numbers: x, y, z",
    read: (feature) => (feature.bodyEdit?.kind === kind ? read(feature.bodyEdit as Spec<K>).map(trim).join(", ") : ""),
    write: (feature, value) => {
      if (feature.bodyEdit?.kind !== kind) return feature;
      return { ...feature, bodyEdit: write(feature.bodyEdit as Spec<K>, value as readonly [number, number, number]) };
    }
  };
}

const positive = { min: 0, exclusiveMin: true } as const;

/** The fields of a body-edit step, or undefined when it has no editable numbers (a replace face). */
export function bodyEditFields(feature: DesignSolidFeature): readonly ParameterField[] | undefined {
  const spec = feature.bodyEdit;
  if (spec === undefined) return undefined;
  switch (spec.kind) {
    case "shell": return [
      numberField("shell", "wall", "Wall thickness", "mm", (s) => s.thicknessMm, (s, v) => ({ ...s, thicknessMm: v }), (s) => (s.kind === "shell" ? s.thicknessMm : 1), { ...positive, max: 10_000 }),
      selectField("shell", "side", "Wall grows", [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }, { value: "both", label: "Both directions" }], (s) => s.side, (s, v) => ({ ...s, side: v === "outside" ? "outside" as const : v === "both" ? "both" as const : "inside" as const }))
    ];
    case "draft": return [
      numberField("draft", "angle", "Draft angle", "°", (s) => s.angleDeg, (s, v) => ({ ...s, angleDeg: v }), (s) => (s.kind === "draft" ? s.angleDeg : 1), { min: -45, max: 45, hint: "negative leans the faces the other way; zero is not allowed" }),
      vectorField("draft", "pull", "Pull direction", "", (s) => s.pullDirection, (s, v) => ({ ...s, pullDirection: v }))
    ];
    case "offset-region": return [
      numberField("offset-region", "distance", "Offset distance", "mm", (s) => s.distanceMm, (s, v) => ({ ...s, distanceMm: v }), (s) => (s.kind === "offset-region" ? s.distanceMm : 1), { min: -100_000, max: 100_000, hint: "positive moves the faces out; zero is not allowed" })
    ];
    case "replace-face": return undefined;
    case "web": return [
      numberField("web", "thickness", "Thickness", "mm", (s) => s.thicknessMm, (s, v) => ({ ...s, thicknessMm: v }), (s) => (s.kind === "web" ? s.thicknessMm : 1), { ...positive, max: 10_000 }),
      selectField("web", "direction", "Thickness grows", [{ value: "symmetric", label: "Both sides of the profile" }, { value: "one-side", label: "One side" }], (s) => s.direction, (s, v) => ({ ...s, direction: v === "one-side" ? "one-side" as const : "symmetric" as const })),
      selectField("web", "extend", "Ends", [{ value: "to-body", label: "Extend until they meet the body" }, { value: "as-drawn", label: "As drawn" }], (s) => (s.extendToBody ? "to-body" : "as-drawn"), (s, v) => ({ ...s, extendToBody: v !== "as-drawn" }))
    ];
    case "wrap": return [
      numberField("wrap", "height", "Height", "mm", (s) => s.heightMm, (s, v) => ({ ...s, heightMm: v }), (s) => (s.kind === "wrap" ? s.heightMm : 1), { ...positive, max: 10_000 }),
      selectField("wrap", "mode", "Mode", [{ value: "emboss", label: "Emboss (raise)" }, { value: "deboss", label: "Deboss (cut in)" }], (s) => s.mode, (s, v) => ({ ...s, mode: v === "deboss" ? "deboss" as const : "emboss" as const }))
    ];
    case "flex": return [
      numberField("flex", "angle", spec.mode === "bend" ? "Bend angle" : "Twist angle", "°", (s) => s.angleDeg, (s, v) => ({ ...s, angleDeg: v }), (s) => (s.kind === "flex" ? s.angleDeg : 1), { min: -360, max: 360, hint: "zero is not allowed; a bend is limited to 180°" }),
      vectorField("flex", "axis", "Axis direction", "", (s) => s.axisDirectionMm, (s, v) => ({ ...s, axisDirectionMm: v })),
      vectorField("flex", "axisPoint", "Point on the axis", "mm", (s) => s.axisPointMm, (s, v) => ({ ...s, axisPointMm: v }))
    ];
  }
}

const LABELS: Readonly<Record<BodyEditSpec["kind"], string>> = { shell: "Shell", draft: "Draft", "offset-region": "Offset region", "replace-face": "Replace face", web: "Rib / Web", wrap: "Wrap", flex: "Flex" };

/** The name an app-made body-edit step carries ("Shell · 2 mm wall inside · 1 face open"), brought up to date with its numbers; a renamed step is left alone. */
export function bodyEditName(feature: DesignSolidFeature): string {
  const spec = feature.bodyEdit;
  if (spec === undefined) return feature.name;
  const label = LABELS[spec.kind];
  return feature.name.startsWith(`${label} · `) ? `${label} · ${describeBodyEdit(spec)}`.slice(0, 120) : feature.name;
}
