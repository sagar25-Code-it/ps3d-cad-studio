export const CAD_ENTITY_KINDS = [
  "project",
  "component",
  "origin",
  "sketch",
  "body",
  "feature",
  "occurrence",
  "joint",
  "drawing"
] as const;

export type CadEntityKind = (typeof CAD_ENTITY_KINDS)[number];

declare const CAD_ID_BRAND: unique symbol;

/** A stable document ID whose prefix and TypeScript brand agree on entity kind. */
export type CadId<Kind extends CadEntityKind> = `${Kind}:${string}` & {
  readonly [CAD_ID_BRAND]: Kind;
};

export type ProjectId = CadId<"project">;
export type ComponentId = CadId<"component">;
export type OriginId = CadId<"origin">;
export type SketchId = CadId<"sketch">;
export type BodyId = CadId<"body">;
export type FeatureId = CadId<"feature">;
export type OccurrenceId = CadId<"occurrence">;
export type JointId = CadId<"joint">;
export type DrawingId = CadId<"drawing">;

export type AnyCadId = {
  readonly [Kind in CadEntityKind]: CadId<Kind>;
}[CadEntityKind];

export interface CadReference<Kind extends CadEntityKind = CadEntityKind> {
  readonly kind: Kind;
  readonly id: CadId<Kind>;
}

export type AnyCadReference = {
  readonly [Kind in CadEntityKind]: CadReference<Kind>;
}[CadEntityKind];

export const CAD_SCOPED_ID_KINDS = [
  "sketch-entity",
  "sketch-constraint",
  "sketch-dimension",
  "drawing-view",
  "drawing-annotation"
] as const;

export type CadScopedIdKind = (typeof CAD_SCOPED_ID_KINDS)[number];

declare const CAD_SCOPED_ID_BRAND: unique symbol;

/** A stable ID for an element owned by one canonical document node. */
export type CadScopedId<Kind extends CadScopedIdKind> = `${Kind}:${string}` & {
  readonly [CAD_SCOPED_ID_BRAND]: Kind;
};

export type SketchEntityId = CadScopedId<"sketch-entity">;
export type SketchConstraintId = CadScopedId<"sketch-constraint">;
export type SketchDimensionId = CadScopedId<"sketch-dimension">;
export type DrawingViewId = CadScopedId<"drawing-view">;
export type DrawingAnnotationId = CadScopedId<"drawing-annotation">;

const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,95})$/u;

export function createCadId<Kind extends CadEntityKind>(kind: Kind, localId: string): CadId<Kind> {
  if (!LOCAL_ID_PATTERN.test(localId)) {
    throw new TypeError("A CAD ID local part must be 1-96 lowercase ASCII letters, digits, dots, underscores, or hyphens.");
  }
  return `${kind}:${localId}` as CadId<Kind>;
}

export function createCadScopedId<Kind extends CadScopedIdKind>(kind: Kind, localId: string): CadScopedId<Kind> {
  if (!LOCAL_ID_PATTERN.test(localId)) throw new TypeError("A scoped CAD ID has an invalid local part.");
  return `${kind}:${localId}` as CadScopedId<Kind>;
}

export function isCadEntityKind(value: unknown): value is CadEntityKind {
  return typeof value === "string" && (CAD_ENTITY_KINDS as readonly string[]).includes(value);
}

export function isCadId<Kind extends CadEntityKind>(value: unknown, expectedKind: Kind): value is CadId<Kind>;
export function isCadId(value: unknown): value is AnyCadId;
export function isCadId(value: unknown, expectedKind?: CadEntityKind): value is AnyCadId {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const kind = value.slice(0, separator);
  const localId = value.slice(separator + 1);
  return isCadEntityKind(kind) && (expectedKind === undefined || kind === expectedKind) && LOCAL_ID_PATTERN.test(localId);
}

export function cadIdKind(id: AnyCadId): CadEntityKind {
  return id.slice(0, id.indexOf(":")) as CadEntityKind;
}

export function isCadScopedId<Kind extends CadScopedIdKind>(value: unknown, expectedKind: Kind): value is CadScopedId<Kind> {
  return typeof value === "string" && value.startsWith(`${expectedKind}:`)
    && LOCAL_ID_PATTERN.test(value.slice(expectedKind.length + 1));
}

export function cadReference<Kind extends CadEntityKind>(kind: Kind, id: CadId<Kind>): CadReference<Kind> {
  if (!isCadId(id, kind)) throw new TypeError(`Expected a stable ${kind} ID.`);
  return { kind, id };
}
