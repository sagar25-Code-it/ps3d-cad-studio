import { MAX_EXPRESSION_LENGTH, parseExpression } from "./expressions.js";
import type { DesignSolidFeature, HolePlacement } from "./types.js";
import { REFERENCE_FIELDS } from "./reference-fields.js";

/**
 * The numbers of a timeline step that an expression can drive. Each one has an id (the key in `feature.expressions` and the part
 * after the dot in `Extrude1.distance`), the kind of quantity it is, the limits the step accepts, and how to read and write it.
 *
 * The ids match the fields of the Edit feature dialog (`apps/studio-web/src/feature-parameters.ts`) so one name means one thing
 * in the dialog, in an expression and in a saved project. A step kind that is not listed here simply has no bindable numbers; its
 * fields stay plain values.
 */

export type BindableDimension = "length" | "angle" | "none";

export interface BindableField {
  readonly id: string;
  readonly label: string;
  readonly dimension: BindableDimension;
  readonly min?: number;
  readonly max?: number;
  /** When true the value must be above `min`, not just at least `min`. */
  readonly exclusiveMin?: boolean;
  readonly integer?: boolean;
  /** Zero is refused even when `min` allows it (a dome of zero height changes nothing). */
  readonly nonZero?: boolean;
  /** The field only exists for some steps of the kind (a counterbore's pocket, a loft's tangency weight). */
  readonly applies?: (feature: DesignSolidFeature) => boolean;
  readonly read: (feature: DesignSolidFeature) => number | undefined;
  readonly write: (feature: DesignSolidFeature, value: number) => DesignSolidFeature;
}

type Limits = Pick<BindableField, "min" | "max" | "exclusiveMin" | "integer" | "nonZero" | "applies">;

const positive: Limits = { min: 0, exclusiveMin: true };

/** A field stored in one property of the feature. `also` lists properties that must follow it (a sheet's thickness is also its extent). */
function property(id: string, label: string, dimension: BindableDimension, key: keyof DesignSolidFeature, limits: Limits = {}, also: (value: number) => Partial<DesignSolidFeature> = () => ({})): BindableField {
  return {
    id, label, dimension, ...limits,
    read: (feature) => { const value = feature[key]; return typeof value === "number" ? value : undefined; },
    write: (feature, value) => ({ ...feature, [key]: value, ...also(value) })
  };
}

/** The step's own size (`valueMm`): shown as a positive number whatever its sign. */
function size(id: string, label: string, dimension: BindableDimension, limits: Limits = positive): BindableField {
  return {
    id, label, dimension, ...limits,
    read: (feature) => Math.abs(feature.valueMm),
    write: (feature, value) => ({ ...feature, valueMm: value })
  };
}

/** One of the two distances a hole is placed by (HS-15); it only exists for a hole that was placed from faces. */
function placementDistance(id: string, label: string, index: 0 | 1): BindableField {
  return {
    id, label, dimension: "length", ...positive, max: 100_000,
    applies: (feature) => feature.holePlacement !== undefined,
    read: (feature) => feature.holePlacement?.from[index].distanceMm,
    write: (feature, value) => {
      const placement = feature.holePlacement;
      if (placement === undefined) return feature;
      const from: HolePlacement["from"] = index === 0 ? [{ ...placement.from[0], distanceMm: value }, placement.from[1]] : [placement.from[0], { ...placement.from[1], distanceMm: value }];
      return { ...feature, holePlacement: { ...placement, from } };
    }
  };
}

const floorValue = (value: number): number => Math.max(0.01, Math.abs(value));

const FIELDS: Partial<Record<DesignSolidFeature["kind"], readonly BindableField[]>> = {
  ...REFERENCE_FIELDS,
  extrude: [size("distance", "Distance", "length", { ...positive, max: 100_000 })],
  revolve: [size("angle", "Angle", "angle", { ...positive, max: 360 })],
  sweep: [
    size("valueMm", "Distance", "length"),
    {
      id: "twist", label: "Twist", dimension: "angle", min: -3600, max: 3600,
      read: (feature) => feature.sweepTwistDeg ?? 0,
      write: (feature, value) => {
        const { sweepTwistDeg: _drop, ...rest } = feature;
        void _drop;
        return value === 0 ? rest : { ...rest, sweepTwistDeg: value };
      }
    }
  ],
  loft: [
    size("valueMm", "Height", "length"),
    property("scale", "Top scale", "none", "loftTopScale", { ...positive, max: 100, applies: (feature) => feature.loftTopScale !== undefined }),
    property("weight", "Tangency weight", "none", "loftTangencyWeight", { min: 0, max: 2, applies: (feature) => feature.loftSecondaryProfileIds !== undefined })
  ],
  "edge-fillet": [
    size("valueMm", "Height", "length"),
    { id: "size", label: "Radius", dimension: "length", ...positive, max: 10_000, read: (feature) => feature.edge?.sizeMm, write: (feature, value) => ({ ...feature, edge: { kind: "fillet" as const, sizeMm: value } }) }
  ],
  "edge-chamfer": [
    size("valueMm", "Height", "length"),
    { id: "size", label: "Distance", dimension: "length", ...positive, max: 10_000, read: (feature) => feature.edge?.sizeMm, write: (feature, value) => ({ ...feature, edge: { kind: "chamfer" as const, sizeMm: value } }) }
  ],
  shell: [
    size("valueMm", "Height", "length"),
    // The sketch-palette shell stores its wall in shellThicknessMm; the face-picked general shell stores it in its bodyEdit spec.
    {
      id: "wall", label: "Wall thickness", dimension: "length", ...positive, max: 10_000,
      read: (feature) => feature.bodyEdit?.kind === "shell" ? feature.bodyEdit.thicknessMm : feature.shellThicknessMm,
      write: (feature, value) => feature.bodyEdit?.kind === "shell"
        ? { ...feature, bodyEdit: { ...feature.bodyEdit, thicknessMm: value }, valueMm: floorValue(value) }
        : { ...feature, shellThicknessMm: value }
    }
  ],
  draft: [
    size("valueMm", "Height", "length", { ...positive, applies: (feature) => feature.bodyEdit === undefined }),
    property("angle", "Draft angle", "angle", "draftAngleDeg", { ...positive, max: 79.9, applies: (feature) => feature.bodyEdit === undefined }),
    {
      id: "angle", label: "Draft angle", dimension: "angle", min: -45, max: 45, nonZero: true,
      applies: (feature) => feature.bodyEdit?.kind === "draft",
      read: (feature) => feature.bodyEdit?.kind === "draft" ? feature.bodyEdit.angleDeg : undefined,
      write: (feature, value) => feature.bodyEdit?.kind === "draft" ? { ...feature, bodyEdit: { ...feature.bodyEdit, angleDeg: value }, valueMm: floorValue(value) } : feature
    }
  ],
  "offset-region": [{
    id: "distance", label: "Offset distance", dimension: "length", min: -100_000, max: 100_000, nonZero: true,
    applies: (feature) => feature.bodyEdit?.kind === "offset-region",
    read: (feature) => feature.bodyEdit?.kind === "offset-region" ? feature.bodyEdit.distanceMm : undefined,
    write: (feature, value) => feature.bodyEdit?.kind === "offset-region" ? { ...feature, bodyEdit: { ...feature.bodyEdit, distanceMm: value }, valueMm: floorValue(value) } : feature
  }],
  web: [{
    id: "thickness", label: "Thickness", dimension: "length", ...positive, max: 10_000,
    applies: (feature) => feature.bodyEdit?.kind === "web",
    read: (feature) => feature.bodyEdit?.kind === "web" ? feature.bodyEdit.thicknessMm : undefined,
    write: (feature, value) => feature.bodyEdit?.kind === "web" ? { ...feature, bodyEdit: { ...feature.bodyEdit, thicknessMm: value }, valueMm: floorValue(value) } : feature
  }],
  wrap: [{
    id: "height", label: "Height", dimension: "length", ...positive, max: 10_000,
    applies: (feature) => feature.bodyEdit?.kind === "wrap",
    read: (feature) => feature.bodyEdit?.kind === "wrap" ? feature.bodyEdit.heightMm : undefined,
    write: (feature, value) => feature.bodyEdit?.kind === "wrap" ? { ...feature, bodyEdit: { ...feature.bodyEdit, heightMm: value }, valueMm: floorValue(value) } : feature
  }],
  "edge-blend": [
    {
      id: "size", label: "Size", dimension: "length", ...positive, max: 10_000,
      read: (feature) => Math.abs(feature.valueMm),
      write: (feature, value) => ({ ...feature, valueMm: value })
    },
    {
      id: "endSize", label: "End radius", dimension: "length", min: 0, max: 10_000,
      applies: (feature) => feature.blendType === "fillet",
      read: (feature) => feature.blendEndSizeMm ?? 0,
      write: (feature, value) => {
        const { blendEndSizeMm: _drop, ...rest } = feature;
        void _drop;
        return value === 0 || value === feature.valueMm ? rest : { ...rest, blendEndSizeMm: value };
      }
    },
    {
      id: "second", label: "Second distance", dimension: "length", min: 0, max: 10_000,
      applies: (feature) => feature.blendType === "chamfer",
      read: (feature) => feature.blendSecondSizeMm ?? 0,
      write: (feature, value) => {
        const { blendSecondSizeMm: _drop, ...rest } = feature;
        void _drop;
        return value === 0 || value === feature.valueMm ? rest : { ...rest, blendSecondSizeMm: value };
      }
    },
    {
      id: "angle", label: "Angle with the first face", dimension: "angle", min: 0, max: 179,
      applies: (feature) => feature.blendType === "chamfer",
      read: (feature) => feature.blendAngleDeg ?? 0,
      write: (feature, value) => {
        const { blendAngleDeg: _dropAngle, ...rest } = feature;
        void _dropAngle;
        if (value === 0) return rest;
        const { blendSecondSizeMm: _dropSecond, ...withoutSecond } = rest;
        void _dropSecond;
        return { ...withoutSecond, blendAngleDeg: value };
      }
    }
  ],
  helix: [
    property("radius", "Coil radius", "length", "helixRadiusMm", { ...positive, max: 10_000 }),
    property("pitch", "Pitch", "length", "helixPitchMm", { ...positive, max: 10_000 }),
    property("turns", "Turns", "none", "helixTurns", { ...positive, max: 100 })
  ],
  thread: [
    property("pitch", "Pitch", "length", "threadPitchMm", { ...positive, max: 10_000 }),
    property("turns", "Turns", "none", "threadTurns", { ...positive, max: 100 }),
    property("depth", "Depth", "length", "threadDepthMm", { ...positive, max: 10_000 })
  ],
  rib: [size("valueMm", "Height", "length"), property("thickness", "Thickness", "length", "ribThicknessMm", { ...positive, max: 10_000 })],
  dome: [property("height", "Dome height", "length", "domeHeightMm", { min: -10_000, max: 10_000, nonZero: true })],
  "sheet-base": [property("thickness", "Sheet thickness", "length", "sheetThicknessMm", { ...positive, max: 1000 }, (value) => ({ valueMm: value }))],
  "sheet-flange": [
    size("valueMm", "Strip width", "length"),
    property("thickness", "Sheet thickness", "length", "sheetThicknessMm", { ...positive, max: 1000 }),
    property("radius", "Inner bend radius", "length", "sheetBendRadiusMm", { min: 0, max: 1000 }),
    property("length", "Flange length", "length", "flangeLengthMm", { ...positive, max: 10_000 }),
    property("angle", "Bend angle", "angle", "flangeAngleDeg", { ...positive, max: 180 })
  ],
  "sheet-hem": [
    size("valueMm", "Strip width", "length"),
    property("thickness", "Sheet thickness", "length", "sheetThicknessMm", { ...positive, max: 1000 }),
    property("radius", "Inner bend radius", "length", "sheetBendRadiusMm", { min: 0, max: 1000 }),
    property("length", "Hem length", "length", "flangeLengthMm", { ...positive, max: 10_000 })
  ],
  "sheet-edge-flange": [
    property("edge", "Edge number", "none", "flangeEdgeIndex", { min: 0, max: 1000, integer: true }),
    property("radius", "Inner bend radius", "length", "sheetBendRadiusMm", { min: 0, max: 1000 }),
    property("length", "Flange length", "length", "flangeLengthMm", { ...positive, max: 10_000 }, (value) => ({ valueMm: value })),
    property("angle", "Bend angle", "angle", "flangeAngleDeg", { ...positive, max: 180 }),
    { id: "relief", label: "Corner relief", dimension: "length", min: 0, max: 1000, read: (feature) => feature.flangeReliefMm ?? 0, write: (feature, value) => ({ ...feature, flangeReliefMm: value }) }
  ],
  hole: [
    property("diameter", "Hole diameter", "length", "holeDiameterMm", { ...positive, max: 10_000 }),
    placementDistance("offsetA", "Distance from the first face", 0),
    placementDistance("offsetB", "Distance from the second face", 1),
    { id: "depth", label: "Depth", dimension: "length", min: 0, max: 100_000, read: (feature) => feature.holeDepthMm ?? 0, write: (feature, value) => ({ ...feature, holeDepthMm: value }) },
    property("counterDiameter", "Pocket diameter", "length", "holeCounterDiameterMm", { ...positive, max: 10_000, applies: (feature) => feature.holeStyle === "counterbore" }),
    property("counterDepth", "Pocket depth", "length", "holeCounterDepthMm", { ...positive, max: 100_000, applies: (feature) => feature.holeStyle === "counterbore" }),
    property("sinkDiameter", "Countersink diameter", "length", "holeSinkDiameterMm", { ...positive, max: 10_000, applies: (feature) => feature.holeStyle === "countersink" }),
    property("sinkAngle", "Countersink angle", "angle", "holeSinkAngleDeg", { min: 10, max: 170, applies: (feature) => feature.holeStyle === "countersink" })
  ],
  "scale-body": [property("factor", "Scale factor", "none", "scaleFactor", { ...positive, max: 100 }, (value) => ({ valueMm: Math.max(0.01, value) }))],
  "offset-face": [property("offset", "Offset along the face normal", "length", "offsetFaceMm", { min: -100_000, max: 100_000, nonZero: true }, (value) => ({ valueMm: floorValue(value) }))],
  emboss: [property("height", "Emboss height", "length", "embossHeightMm", { min: -10_000, max: 10_000, nonZero: true }, (value) => ({ valueMm: floorValue(value) }))]
};

/** Every bindable field of a step kind, including ones that only apply to some steps of it. */
export function bindableFieldIdsOfKind(kind: DesignSolidFeature["kind"]): readonly string[] {
  return (FIELDS[kind] ?? []).map((field) => field.id);
}

/** The numbers of this step that an expression can drive. */
export function bindableFieldsOf(feature: DesignSolidFeature): readonly BindableField[] {
  return (FIELDS[feature.kind] ?? []).filter((field) => field.applies === undefined || field.applies(feature));
}

const FIELD_ALIASES: Readonly<Record<string, string>> = { distance: "valueMm", height: "valueMm" };

/** Finds the field a name in `Extrude1.name` stands for: its id, or `distance` / `height` for a step's own size. */
export function findBindableField(feature: DesignSolidFeature, name: string): BindableField | undefined {
  const fields = bindableFieldsOf(feature);
  return fields.find((field) => field.id === name) ?? (Object.hasOwn(FIELD_ALIASES, name) ? fields.find((field) => field.id === FIELD_ALIASES[name]) : undefined);
}

/**
 * The name other expressions use for a step: its name with everything but letters, digits and underscores removed
 * ("Extrude 1" is `Extrude1`). A name that would start with a digit gets an underscore in front.
 */
export function featureAlias(feature: Pick<DesignSolidFeature, "name">): string {
  const cleaned = feature.name.replace(/[^A-Za-z0-9_]/gu, "");
  if (cleaned === "") return "_";
  return /^[0-9]/u.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** A message when `value` is not allowed for the field, or undefined when it is fine. */
export function boundValueProblem(field: BindableField, value: number): string | undefined {
  const unit = field.dimension === "length" ? " mm" : field.dimension === "angle" ? "°" : "";
  if (!Number.isFinite(value)) return `${field.label} is not a finite number.`;
  if (field.integer === true && !Number.isInteger(value)) return `${field.label} must be a whole number, but the expression gives ${trim(value)}.`;
  if (field.nonZero === true && value === 0) return `${field.label} cannot be zero.`;
  if (field.min !== undefined && (field.exclusiveMin === true ? value <= field.min : value < field.min)) {
    return `${field.label} must be ${field.exclusiveMin === true ? "above" : "at least"} ${trim(field.min)}${unit}, but the expression gives ${trim(value)}${unit}.`;
  }
  if (field.max !== undefined && value > field.max) return `${field.label} must be at most ${trim(field.max)}${unit}, but the expression gives ${trim(value)}${unit}.`;
  return undefined;
}

const trim = (value: number): string => String(Number(value.toFixed(6)));

/** Whether a step's saved `expressions` are well formed: known fields of this kind only, each a short expression that parses. */
export function validFeatureExpressions(kind: DesignSolidFeature["kind"], expressions: unknown): boolean {
  if (typeof expressions !== "object" || expressions === null || Array.isArray(expressions)) return false;
  const entries = Object.entries(expressions);
  if (entries.length === 0 || entries.length > 16) return false;
  const known = bindableFieldIdsOfKind(kind);
  return entries.every(([key, text]) => known.includes(key) && typeof text === "string" && text.length >= 1 && text.length <= MAX_EXPRESSION_LENGTH && parseExpression(text).ok);
}
