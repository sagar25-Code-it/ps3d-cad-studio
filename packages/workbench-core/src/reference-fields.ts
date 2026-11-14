import type { BindableDimension, BindableField } from "./feature-bindings.js";
import type { ReferenceSpec } from "./reference-feature.js";
import type { DesignSolidFeature, Vec3 } from "./types.js";

/**
 * The numbers of a construction plane, axis, point or primitive step that an expression can drive (`Offset1.offset`, `Box1.height`).
 * They are the same fields the Edit dialog shows, so one name means one thing in the dialog, in an expression and in a saved project.
 * Each field reads and writes the step's recorded definition; which fields a step has depends on how it was defined.
 */

const LIMIT = 100_000;
const SIZE_LIMIT = 10_000;

type Limits = Pick<BindableField, "min" | "max" | "exclusiveMin" | "integer" | "nonZero">;

function field(id: string, label: string, dimension: BindableDimension, limits: Limits, applies: (spec: ReferenceSpec) => boolean, read: (spec: ReferenceSpec) => number | undefined, write: (spec: ReferenceSpec, value: number) => ReferenceSpec): BindableField {
  return {
    id, label, dimension, ...limits,
    applies: (feature: DesignSolidFeature) => feature.reference !== undefined && applies(feature.reference),
    read: (feature: DesignSolidFeature) => feature.reference === undefined ? undefined : read(feature.reference),
    write: (feature: DesignSolidFeature, value: number) => feature.reference === undefined ? feature : { ...feature, reference: write(feature.reference, value) }
  };
}

type PlaneSpec = Extract<ReferenceSpec, { readonly kind: "plane" }>;
type AxisSpec = Extract<ReferenceSpec, { readonly kind: "axis" }>;
type PointSpec = Extract<ReferenceSpec, { readonly kind: "point" }>;
type PrimitiveSpecRecord = Extract<ReferenceSpec, { readonly kind: "primitive" }>;

const isPlane = (kind: string) => (spec: ReferenceSpec): spec is PlaneSpec => spec.kind === "plane" && spec.definition.kind === kind;
const isAxis = (kind: string) => (spec: ReferenceSpec): spec is AxisSpec => spec.kind === "axis" && spec.definition.kind === kind;
const isPoint = (kind: string) => (spec: ReferenceSpec): spec is PointSpec => spec.kind === "point" && spec.definition.kind === kind;

const AXES = ["X", "Y", "Z"] as const;

/** Three fields (x, y, z) for one point of a definition. */
function pointFields(prefix: string, label: string, applies: (spec: ReferenceSpec) => boolean, get: (spec: ReferenceSpec) => Vec3 | undefined, set: (spec: ReferenceSpec, value: Vec3) => ReferenceSpec): readonly BindableField[] {
  return AXES.map((axis, index) => field(`${prefix}${axis.toLowerCase()}`, `${label} ${axis}`, "length", { min: -LIMIT, max: LIMIT }, applies,
    (spec) => get(spec)?.[index],
    (spec, value) => {
      const current = get(spec);
      if (current === undefined) return spec;
      const next: [number, number, number] = [current[0], current[1], current[2]];
      next[index] = value;
      return set(spec, next);
    }));
}

const planeOf = (spec: ReferenceSpec): PlaneSpec["definition"] | undefined => spec.kind === "plane" ? spec.definition : undefined;
const axisOf = (spec: ReferenceSpec): AxisSpec["definition"] | undefined => spec.kind === "axis" ? spec.definition : undefined;
const pointOf = (spec: ReferenceSpec): PointSpec["definition"] | undefined => spec.kind === "point" ? spec.definition : undefined;

function threePoints(spec: ReferenceSpec): readonly [Vec3, Vec3, Vec3] | undefined {
  const definition = planeOf(spec);
  return definition?.kind === "three-points" ? definition.points : undefined;
}

const PLANE_FIELDS: readonly BindableField[] = [
  field("offset", "Offset distance", "length", { min: -LIMIT, max: LIMIT }, isPlane("offset"),
    (spec) => { const d = planeOf(spec); return d?.kind === "offset" ? d.offsetMm : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "offset" ? { kind: "plane", definition: { ...d, offsetMm: value } } : spec; }),
  field("angle", "Angle", "angle", { min: -360, max: 360 }, (spec) => isPlane("angle")(spec) || isPlane("tangent-to-cylinder")(spec),
    (spec) => { const d = planeOf(spec); return d?.kind === "angle" || d?.kind === "tangent-to-cylinder" ? d.angleDeg : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "angle" || d?.kind === "tangent-to-cylinder" ? { kind: "plane", definition: { ...d, angleDeg: value } } : spec; }),
  field("from", "Start offset", "length", { min: -LIMIT, max: LIMIT }, isPlane("midplane"),
    (spec) => { const d = planeOf(spec); return d?.kind === "midplane" ? d.fromMm : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "midplane" ? { kind: "plane", definition: { ...d, fromMm: value } } : spec; }),
  field("to", "End offset", "length", { min: -LIMIT, max: LIMIT }, isPlane("midplane"),
    (spec) => { const d = planeOf(spec); return d?.kind === "midplane" ? d.toMm : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "midplane" ? { kind: "plane", definition: { ...d, toMm: value } } : spec; }),
  field("t", "Position along the path (0 to 1)", "none", { min: 0, max: 1 }, isPlane("along-path"),
    (spec) => { const d = planeOf(spec); return d?.kind === "along-path" ? d.t : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "along-path" ? { kind: "plane", definition: { ...d, t: value } } : spec; }),
  ...pointFields("through", "Point", isPlane("perpendicular-to-axis"),
    (spec) => { const d = planeOf(spec); return d?.kind === "perpendicular-to-axis" ? d.point : undefined; },
    (spec, value) => { const d = planeOf(spec); return d?.kind === "perpendicular-to-axis" ? { kind: "plane", definition: { ...d, point: value } } : spec; }),
  ...([0, 1, 2] as const).flatMap((index) => pointFields(`p${index + 1}`, `Point ${index + 1}`, isPlane("three-points"),
    (spec) => threePoints(spec)?.[index],
    (spec, value) => {
      const points = threePoints(spec);
      if (points === undefined) return spec;
      const next: [Vec3, Vec3, Vec3] = [points[0], points[1], points[2]];
      next[index] = value;
      return { kind: "plane", definition: { kind: "three-points", points: next } };
    }))
];

const AXIS_FIELDS: readonly BindableField[] = [
  ...pointFields("a", "Start point", isAxis("two-points"),
    (spec) => { const d = axisOf(spec); return d?.kind === "two-points" ? d.a : undefined; },
    (spec, value) => { const d = axisOf(spec); return d?.kind === "two-points" ? { kind: "axis", definition: { ...d, a: value } } : spec; }),
  ...pointFields("b", "End point", isAxis("two-points"),
    (spec) => { const d = axisOf(spec); return d?.kind === "two-points" ? d.b : undefined; },
    (spec, value) => { const d = axisOf(spec); return d?.kind === "two-points" ? { kind: "axis", definition: { ...d, b: value } } : spec; }),
  ...pointFields("o", "Origin", isAxis("point-and-direction"),
    (spec) => { const d = axisOf(spec); return d?.kind === "point-and-direction" ? d.origin : undefined; },
    (spec, value) => { const d = axisOf(spec); return d?.kind === "point-and-direction" ? { kind: "axis", definition: { ...d, origin: value } } : spec; }),
  ...pointFields("d", "Direction", isAxis("point-and-direction"),
    (spec) => { const d = axisOf(spec); return d?.kind === "point-and-direction" ? d.direction : undefined; },
    (spec, value) => { const d = axisOf(spec); return d?.kind === "point-and-direction" ? { kind: "axis", definition: { ...d, direction: value } } : spec; }),
  ...pointFields("through", "Point", isAxis("perpendicular-to-plane"),
    (spec) => { const d = axisOf(spec); return d?.kind === "perpendicular-to-plane" ? d.point : undefined; },
    (spec, value) => { const d = axisOf(spec); return d?.kind === "perpendicular-to-plane" ? { kind: "axis", definition: { ...d, point: value } } : spec; })
];

const POINT_FIELDS: readonly BindableField[] = [
  ...pointFields("", "Position", isPoint("xyz"),
    (spec) => { const d = pointOf(spec); return d?.kind === "xyz" ? d.position : undefined; },
    (spec, value) => { const d = pointOf(spec); return d?.kind === "xyz" ? { kind: "point", definition: { ...d, position: value } } : spec; }),
  ...pointFields("a", "First point", isPoint("midpoint"),
    (spec) => { const d = pointOf(spec); return d?.kind === "midpoint" ? d.a : undefined; },
    (spec, value) => { const d = pointOf(spec); return d?.kind === "midpoint" ? { kind: "point", definition: { ...d, a: value } } : spec; }),
  ...pointFields("b", "Second point", isPoint("midpoint"),
    (spec) => { const d = pointOf(spec); return d?.kind === "midpoint" ? d.b : undefined; },
    (spec, value) => { const d = pointOf(spec); return d?.kind === "midpoint" ? { kind: "point", definition: { ...d, b: value } } : spec; })
];

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const prim = (spec: ReferenceSpec): PrimitiveSpecRecord["body"] | undefined => spec.kind === "primitive" ? spec.body : undefined;

/** What the three numbers of a primitive's size tuple are called for each shape; undefined means the number is not independent (it follows another). */
const SIZE_LABELS: Readonly<Record<string, readonly [string, string | undefined, string | undefined]>> = {
  block: ["Width", "Depth", "Height"],
  cylinder: ["Diameter", undefined, "Height"],
  cone: ["Base diameter", "Top diameter", "Height"],
  sphere: ["Diameter", undefined, undefined],
  torus: ["Outer diameter", "Tube diameter", "Tube thickness"],
  ellipsoid: ["Diameter X", "Diameter Y", "Diameter Z"],
  prism: ["Circumscribed diameter", undefined, "Height"],
  wedge: ["Width", "Depth", "Height"],
  spiral: ["Outer diameter", undefined, "Thickness"],
  tube: ["Outer diameter", "Inner diameter", "Height"],
  revolved: ["Outer diameter", "Inner diameter", "Height"]
};

/** The size tuple after one number changed, with the shapes that tie numbers together keeping them tied. */
function resized(shape: string, size: readonly [number, number, number], index: 0 | 1 | 2, value: number): readonly [number, number, number] {
  const next: [number, number, number] = [size[0], size[1], size[2]];
  next[index] = value;
  if (shape === "cylinder" || shape === "prism" || shape === "spiral") next[1] = next[0];
  if (shape === "sphere") { next[1] = next[0]; next[2] = next[0]; }
  return next;
}

const sizeField = (index: 0 | 1 | 2): BindableField => field(`size${AXES[index]}`, `Size ${AXES[index]}`, "length", { min: 0, exclusiveMin: true, max: SIZE_LIMIT },
  (spec) => { const body = prim(spec); return body !== undefined && SIZE_LABELS[body.shape]?.[index] !== undefined; },
  (spec) => prim(spec)?.sizeMm[index],
  (spec, value) => { const body = prim(spec); return body === undefined ? spec : { kind: "primitive", body: { ...body, sizeMm: resized(body.shape, body.sizeMm, index, value) } }; });

/** The label a primitive's size field shows ("Diameter", "Height"), which depends on the shape. */
export function primitiveSizeFieldLabel(shape: string, index: 0 | 1 | 2): string | undefined {
  return SIZE_LABELS[shape]?.[index];
}

const PRIMITIVE_FIELDS: readonly BindableField[] = [
  ...([0, 1, 2] as const).map(sizeField),
  ...pointFields("pos", "Position", (spec) => spec.kind === "primitive",
    (spec) => prim(spec)?.translationMm,
    (spec, value) => { const body = prim(spec); return body === undefined ? spec : { kind: "primitive", body: { ...body, translationMm: value } }; }),
  ...AXES.map((axis, index) => field(`rot${axis.toLowerCase()}`, `Rotation about ${axis}`, "angle", { min: -360, max: 360 }, (spec) => spec.kind === "primitive",
    (spec) => prim(spec)?.rotationDeg[index],
    (spec, value) => {
      const body = prim(spec);
      if (body === undefined) return spec;
      const next: [number, number, number] = [body.rotationDeg[0], body.rotationDeg[1], body.rotationDeg[2]];
      next[index] = value;
      return { kind: "primitive", body: { ...body, rotationDeg: next } };
    })),
  field("sides", "Number of sides", "none", { min: 3, max: 64, integer: true }, (spec) => prim(spec)?.shape === "prism",
    (spec) => prim(spec)?.primitiveParams?.sides,
    (spec, value) => { const body = prim(spec); return body === undefined ? spec : { kind: "primitive", body: { ...body, primitiveParams: { ...body.primitiveParams, sides: value } } }; }),
  field("turns", "Number of turns", "none", { min: 0.5, max: 20 }, (spec) => prim(spec)?.shape === "spiral",
    (spec) => prim(spec)?.primitiveParams?.turns,
    (spec, value) => { const body = prim(spec); return body === undefined ? spec : { kind: "primitive", body: { ...body, primitiveParams: { ...body.primitiveParams, turns: value } } }; })
];

/** The bindable fields of each reference step kind (merged into the field table of feature-bindings.ts). */
export const REFERENCE_FIELDS: Readonly<Partial<Record<DesignSolidFeature["kind"], readonly BindableField[]>>> = {
  "construction-plane": PLANE_FIELDS,
  "construction-axis": AXIS_FIELDS,
  "construction-point": POINT_FIELDS,
  primitive: PRIMITIVE_FIELDS
};
