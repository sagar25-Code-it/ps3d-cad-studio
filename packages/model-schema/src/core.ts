export const NATIVE_FORMAT = "ps3d-native" as const;
export const SCHEMA_VERSION = 1 as const;
export const APPLICATION_VERSION = "0.0.1-phase.0" as const;
export const ENGINE_PROFILE = "phase0-ps3d-bracket-mesh-1-serial-f64" as const;
export const SKETCH_SOLVER_PROFILE = "ps3d-bounded-bracket-sketch/0.0.1-phase.0" as const;
export const MAX_NATIVE_BYTES = 1_000_000;
export const MAX_SCHEMA_NODES = 5_000;

export type DisplayUnit = "mm" | "in";
export type ParameterKey = "width" | "height" | "thickness" | "holeDiameter";

export const DIAGNOSTIC_CODES = [
  "INVALID_NUMBER",
  "UNIT_MISMATCH",
  "OUTSIDE_SUPPORTED_ENVELOPE",
  "RESOURCE_LIMIT",
  "INVALID_GRAPH",
  "UNDERCONSTRAINED",
  "CONSTRAINT_CONFLICT",
  "DEGENERATE_GEOMETRY",
  "OPEN_PROFILE",
  "SELF_INTERSECTING_PROFILE",
  "AMBIGUOUS_PROFILE",
  "UNSUPPORTED_GEOMETRIC_CASE",
  "INVALID_SOLID_INPUT",
  "INVALID_SOLID_OUTPUT",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_CONFLICT",
  "WORKER_FAILURE",
  "PERSISTENCE_FAILURE",
  "UNSUPPORTED_OR_CORRUPT_FILE"
] as const;

export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface UnitExpression {
  readonly decimal: string;
  readonly unit: DisplayUnit;
}

export interface LengthParameter {
  readonly id: string;
  readonly key: ParameterKey;
  readonly label: string;
  readonly dimension: "length";
  readonly expression: UnitExpression;
  readonly valueMeters: number;
}

export interface SketchConstraint {
  readonly id: string;
  readonly kind: "axis-aligned" | "centered-at-origin" | "driving-dimension";
  readonly entityIds: readonly string[];
  readonly parameterId?: string;
}

export interface RectangleProfileEntity {
  readonly id: string;
  readonly kind: "rectangle-profile";
  readonly centerMeters: readonly [number, number];
  readonly widthParameterId: string;
  readonly heightParameterId: string;
  readonly closed: boolean;
  readonly construction: false;
}

export interface CircleProfileEntity {
  readonly id: string;
  readonly kind: "circle-profile";
  readonly centerMeters: readonly [number, number];
  readonly diameterParameterId: string;
  readonly construction: false;
}

export interface SemanticSketch {
  readonly id: string;
  readonly name: string;
  readonly planeId: "datum:xy";
  readonly entities: readonly [RectangleProfileEntity, CircleProfileEntity];
  readonly constraints: readonly SketchConstraint[];
  readonly acceptedConstraintState: {
    readonly classification: "fully-constrained";
    readonly degreesOfFreedom: 0;
  };
}

export interface SemanticFeature {
  readonly id: string;
  readonly name: string;
  readonly kind: "plate-extrusion" | "centered-through-hole";
  readonly order: number;
  readonly inputIds: readonly string[];
  readonly outputBodyId: string;
}

export type CommandJournalEntry =
  | {
      readonly revision: number;
      readonly parentRevision: null;
      readonly commandId: string;
      readonly kind: "create-document";
      readonly displayUnit: DisplayUnit;
    }
  | {
      readonly revision: number;
      readonly parentRevision: number;
      readonly commandId: string;
      readonly kind: "set-parameter";
      readonly parameterKey: ParameterKey;
      readonly expression: UnitExpression;
    }
  | {
      readonly revision: number;
      readonly parentRevision: number;
      readonly commandId: string;
      readonly kind: "set-display-unit";
      readonly displayUnit: DisplayUnit;
    }
  | {
      readonly revision: number;
      readonly parentRevision: number;
      readonly commandId: string;
      readonly kind: "undo" | "redo";
      readonly targetRevision: number;
    };

export interface CadDocument {
  readonly format: typeof NATIVE_FORMAT;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly applicationVersion: string;
  readonly engineProfile: string;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly commandId: string;
  readonly commandJournal: readonly CommandJournalEntry[];
  readonly displayUnit: DisplayUnit;
  readonly parameters: readonly LengthParameter[];
  readonly sketches: readonly [SemanticSketch];
  readonly features: readonly [SemanticFeature, SemanticFeature];
  readonly bodies: readonly [{ readonly id: string; readonly name: string; readonly visible: boolean }];
}

export const PARAMETER_IDS: Readonly<Record<ParameterKey, string>> = {
  width: "parameter:plate-width",
  height: "parameter:plate-height",
  thickness: "parameter:plate-thickness",
  holeDiameter: "parameter:hole-diameter"
};

export const PARAMETER_ENVELOPE_METERS: Readonly<Record<ParameterKey, readonly [number, number]>> = {
  width: [0.005, 0.5],
  height: [0.005, 0.5],
  thickness: [0.001, 0.1],
  holeDiameter: [0.001, 0.25]
};

export const PARAMETER_LABELS: Readonly<Record<ParameterKey, string>> = {
  width: "Plate width",
  height: "Plate height",
  thickness: "Plate thickness",
  holeDiameter: "Bore diameter"
};

const UNIT_TO_METERS: Readonly<Record<DisplayUnit, number>> = { mm: 0.001, in: 0.0254 };
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

export function convertLength(value: number, from: DisplayUnit, to: DisplayUnit): number {
  if (!Number.isFinite(value)) throw new TypeError("Length conversion requires a finite value.");
  return value * UNIT_TO_METERS[from] / UNIT_TO_METERS[to];
}

export function expressionToMeters(expression: UnitExpression): Result<number> {
  if (!DECIMAL_PATTERN.test(expression.decimal)) {
    return fail("INVALID_NUMBER", "Enter a positive decimal without an exponent.", [], "Use a value such as 60 or 0.375.");
  }
  const numeric = Number(expression.decimal);
  const valueMeters = numeric * UNIT_TO_METERS[expression.unit];
  if (!Number.isFinite(valueMeters) || valueMeters <= 0) {
    return fail("INVALID_NUMBER", "The dimension must be greater than zero.", [], "Enter a finite positive length.");
  }
  return { ok: true, value: valueMeters };
}

export function validateParameterEnvelope(key: ParameterKey, valueMeters: number): Result<number> {
  const [minimum, maximum] = PARAMETER_ENVELOPE_METERS[key];
  if (valueMeters < minimum || valueMeters > maximum) {
    return fail(
      "OUTSIDE_SUPPORTED_ENVELOPE",
      `${key} is outside the bounded Phase 0 envelope.`,
      [PARAMETER_IDS[key]],
      `Use a value from ${minimum * 1000} mm through ${maximum * 1000} mm.`
    );
  }
  return { ok: true, value: valueMeters };
}

export function formatMeters(valueMeters: number, unit: DisplayUnit): string {
  const converted = valueMeters / UNIT_TO_METERS[unit];
  const digits = unit === "mm" ? 6 : 8;
  return converted.toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/u, "$1");
}

export function parameterByKey(document: CadDocument, key: ParameterKey): LengthParameter {
  const parameter = document.parameters.find((candidate) => candidate.key === key);
  if (parameter === undefined) throw new Error(`Canonical parameter is missing: ${key}`);
  return parameter;
}

export function createBracketDocument(documentId: string, displayUnit: DisplayUnit = "mm"): CadDocument {
  const define = (key: ParameterKey, millimeters: string): LengthParameter => ({
    id: PARAMETER_IDS[key], key, label: PARAMETER_LABELS[key], dimension: "length",
    expression: { decimal: millimeters, unit: "mm" }, valueMeters: Number(millimeters) * UNIT_TO_METERS.mm
  });
  return {
    format: NATIVE_FORMAT, schemaVersion: SCHEMA_VERSION, applicationVersion: APPLICATION_VERSION,
    engineProfile: ENGINE_PROFILE, id: documentId, name: "Centered Bore Bracket", revision: 0,
    parentRevision: null, commandId: "command:document-created",
    commandJournal: [{ revision: 0, parentRevision: null, commandId: "command:document-created", kind: "create-document", displayUnit }],
    displayUnit,
    parameters: [define("width", "60"), define("height", "40"), define("thickness", "10"), define("holeDiameter", "10")],
    sketches: [{
      id: "sketch:bracket-profile", name: "Bounded bracket profile", planeId: "datum:xy",
      entities: [
        { id: "entity:plate-rectangle", kind: "rectangle-profile", centerMeters: [0, 0], widthParameterId: PARAMETER_IDS.width, heightParameterId: PARAMETER_IDS.height, closed: true, construction: false },
        { id: "entity:center-bore", kind: "circle-profile", centerMeters: [0, 0], diameterParameterId: PARAMETER_IDS.holeDiameter, construction: false }
      ],
      constraints: [
        { id: "constraint:rectangle-axis-aligned", kind: "axis-aligned", entityIds: ["entity:plate-rectangle"] },
        { id: "constraint:rectangle-centered", kind: "centered-at-origin", entityIds: ["entity:plate-rectangle"] },
        { id: "constraint:bore-centered", kind: "centered-at-origin", entityIds: ["entity:center-bore"] },
        { id: "constraint:width", kind: "driving-dimension", entityIds: ["entity:plate-rectangle"], parameterId: PARAMETER_IDS.width },
        { id: "constraint:height", kind: "driving-dimension", entityIds: ["entity:plate-rectangle"], parameterId: PARAMETER_IDS.height },
        { id: "constraint:bore-diameter", kind: "driving-dimension", entityIds: ["entity:center-bore"], parameterId: PARAMETER_IDS.holeDiameter }
      ],
      acceptedConstraintState: { classification: "fully-constrained", degreesOfFreedom: 0 }
    }],
    features: [
      { id: "feature:plate-extrusion", name: "Plate rise", kind: "plate-extrusion", order: 10, inputIds: ["sketch:bracket-profile", PARAMETER_IDS.thickness], outputBodyId: "body:bracket" },
      { id: "feature:centered-through-hole", name: "Centered passage", kind: "centered-through-hole", order: 20, inputIds: ["feature:plate-extrusion", "entity:center-bore"], outputBodyId: "body:bracket" }
    ],
    bodies: [{ id: "body:bracket", name: "Bracket body", visible: true }]
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
}

export function isDisplayUnit(value: unknown): value is DisplayUnit {
  return value === "mm" || value === "in";
}

export function isParameterKey(value: unknown): value is ParameterKey {
  return value === "width" || value === "height" || value === "thickness" || value === "holeDiameter";
}

export function isUnitExpression(value: unknown): value is UnitExpression {
  return isRecord(value) && hasExactKeys(value, ["decimal", "unit"])
    && typeof value.decimal === "string" && value.decimal.length <= 64 && isDisplayUnit(value.unit);
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && (DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

export function fail(code: DiagnosticCode, message: string, relatedIds: readonly string[], recovery: string): Result<never> {
  return { ok: false, diagnostics: [{ code, severity: "error", message, relatedIds, recovery }] };
}
