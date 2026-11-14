import { planeDependencies } from "./construction-refs.js";
import type {
  ConstructionAxis,
  ConstructionAxisDefinition,
  ConstructionPlane,
  ConstructionPlaneDefinition,
  ConstructionPoint,
  ConstructionPointDefinition,
  DesignFeature,
  DesignHistory,
  DesignSolidFeature,
  PartPreviewBody,
  WorkbenchProject
} from "./types.js";

/**
 * Construction planes, axes, points and primitives as timeline steps.
 *
 * Each of them is a step of its own (kinds "construction-plane", "construction-axis", "construction-point" and "primitive") that owns
 * what it is built from (`feature.reference`). The plane, axis, point or preview body in the part that has the step's `bodyId` is
 * derived from that definition, so the browser, the viewport, the sketch plane dialog and everything else that reads the part's lists
 * keep working unchanged, and rolling back, suppressing, reordering, renaming or editing the step changes the item. A primitive is a
 * placed feature: its mesh is a pure function of the recorded shape, size, position and rotation.
 *
 * This file only holds the pure facts about such a step (what it is, what it needs, how it reads, whether it is well formed). The
 * reducers that keep the part's lists and the timeline in step are in reference-history.ts.
 */

export const REFERENCE_KINDS = ["construction-plane", "construction-axis", "construction-point", "primitive"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** What a primitive step records: everything of a preview body except its identity, its name and whether it is shown. */
export type PrimitiveSpec = Omit<PartPreviewBody, "id" | "name" | "visible">;

export type ReferenceSpec =
  | { readonly kind: "plane"; readonly definition: ConstructionPlaneDefinition }
  | { readonly kind: "axis"; readonly definition: ConstructionAxisDefinition }
  | { readonly kind: "point"; readonly definition: ConstructionPointDefinition }
  | { readonly kind: "primitive"; readonly body: PrimitiveSpec };

export type ReferenceItem = ConstructionPlane | ConstructionAxis | ConstructionPoint | PartPreviewBody;

/** A step of one of the four reference kinds. */
export type ReferenceFeature = DesignSolidFeature & { readonly kind: ReferenceKind; readonly reference: ReferenceSpec };

const KIND_OF_SPEC: Readonly<Record<ReferenceSpec["kind"], ReferenceKind>> = {
  plane: "construction-plane", axis: "construction-axis", point: "construction-point", primitive: "primitive"
};

export function isReferenceKind(kind: string): kind is ReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(kind);
}

export function isReferenceFeature(feature: DesignFeature): feature is ReferenceFeature {
  return feature.kind !== "sketch" && isReferenceKind(feature.kind) && feature.reference !== undefined;
}

export function referenceKindOf(spec: ReferenceSpec): ReferenceKind {
  return KIND_OF_SPEC[spec.kind];
}

// ---------------------------------------------------------------------------------------------
// Items: the plane, axis, point or preview body a step describes
// ---------------------------------------------------------------------------------------------

/** The step's item as it is in the part, or undefined when the part has none with the step's id. */
export function itemOfStep(project: WorkbenchProject, feature: ReferenceFeature): ReferenceItem | undefined {
  return listFor(project, feature.reference.kind).find((item) => item.id === feature.bodyId);
}

export function listFor(project: WorkbenchProject, kind: ReferenceSpec["kind"]): readonly ReferenceItem[] {
  const part = project.part;
  return kind === "plane" ? part.construction ?? [] : kind === "axis" ? part.constructionAxes ?? [] : kind === "point" ? part.constructionPoints ?? [] : part.previewBodies ?? [];
}

/** The item a step derives, with the given visibility. */
export function materializeReference(feature: ReferenceFeature, visible: boolean): ReferenceItem {
  const spec = feature.reference;
  const base = { id: feature.bodyId, name: feature.name, visible };
  if (spec.kind === "primitive") return { ...spec.body, ...base };
  return { ...base, definition: spec.definition } as ReferenceItem;
}

/** The step's record of an item (its definition without the name and visibility). */
export function specOfItem(kind: ReferenceSpec["kind"], item: ReferenceItem): ReferenceSpec {
  if (kind === "primitive") {
    const { id: _id, name: _name, visible: _visible, ...body } = item as PartPreviewBody;
    void _id; void _name; void _visible;
    return { kind, body };
  }
  return { kind, definition: (item as ConstructionPlane | ConstructionAxis | ConstructionPoint).definition } as ReferenceSpec;
}

/** Deep equality for plain JSON values (key order does not matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const others = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === others.length && keys.every((key) => sameValue(left[key], right[key]));
}

/** The reason a project's reference steps and its lists disagree, or undefined when each step has exactly the item it describes. */
export function referenceConsistencyProblem(project: WorkbenchProject): string | undefined {
  for (const feature of project.design?.features ?? []) {
    if (!isReferenceFeature(feature)) continue;
    const item = itemOfStep(project, feature);
    if (item === undefined) return `The timeline step ${feature.name} has no ${noun(feature.reference.kind)} in the part.`;
    if (item.name !== feature.name || !sameValue(specOfItem(feature.reference.kind, item), feature.reference)) return `The ${noun(feature.reference.kind)} ${item.name} does not match its timeline step ${feature.name}.`;
  }
  return undefined;
}

const noun = (kind: ReferenceSpec["kind"]): string => kind === "plane" ? "construction plane" : kind === "axis" ? "construction axis" : kind === "point" ? "construction point" : "primitive body";

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const SHAPE_LABEL: Readonly<Record<string, string>> = {
  block: "Box", cylinder: "Cylinder", cone: "Cone", sphere: "Sphere", torus: "Torus", ellipsoid: "Ellipsoid", prism: "Prism", wedge: "Wedge", spiral: "Spiral", tube: "Tube", revolved: "Ring"
};

export function primitiveShapeLabel(shape: string): string {
  return SHAPE_LABEL[shape] ?? "Primitive";
}

const num = (value: number): string => String(Number(value.toFixed(3)));
const plane = (datum: string): string => datum.replace("datum:", "").toUpperCase();
const triple = (value: readonly number[]): string => value.map(num).join(", ");

/** One line saying what a reference step is made of, for the browser and the timeline tooltip. */
export function describeReference(spec: ReferenceSpec): string {
  if (spec.kind === "primitive") {
    const body = spec.body;
    return `${primitiveShapeLabel(body.shape)} ${body.sizeMm.map(num).join(" × ")} mm at (${triple(body.translationMm)}) mm`;
  }
  const d = spec.definition;
  if (spec.kind === "plane") {
    const p = spec.definition;
    switch (p.kind) {
      case "offset": return `${num(p.offsetMm)} mm from the ${plane(p.basePlane)} plane`;
      case "angle": return `${plane(p.basePlane)} plane turned ${num(p.angleDeg)}° about ${p.axis.toUpperCase()}`;
      case "three-points": return "Plane through three points";
      case "midplane": return `Midway between ${num(p.fromMm)} and ${num(p.toMm)} mm of the ${plane(p.basePlane)} plane`;
      case "tangent-to-cylinder": return `Tangent to a cylinder at ${num(p.angleDeg)}°`;
      case "perpendicular-to-axis": return "Perpendicular to an axis";
      case "through-two-edges": return "Plane through two edges";
      case "along-path": return `${num(p.t * 100)}% along a path`;
    }
  }
  if (spec.kind === "axis") {
    const a = spec.definition;
    switch (a.kind) {
      case "two-points": return `Through (${triple(a.a)}) and (${triple(a.b)}) mm`;
      case "point-and-direction": return `From (${triple(a.origin)}) mm along (${triple(a.direction)})`;
      case "plane-intersection": return `${plane(a.planeA)} plane meets ${plane(a.planeB)} plane`;
      case "perpendicular-to-plane": return `Perpendicular to the ${plane(a.plane)} plane through (${triple(a.point)}) mm`;
      case "cylinder-axis": return "Axis of a cylindrical body";
    }
  }
  const q = d as ConstructionPointDefinition;
  switch (q.kind) {
    case "xyz": return `(${triple(q.position)}) mm`;
    case "midpoint": return `Midway between (${triple(q.a)}) and (${triple(q.b)}) mm`;
    case "axis-plane-intersection": return `An axis meets the ${plane(q.plane)} plane`;
  }
}

// ---------------------------------------------------------------------------------------------
// What a step needs
// ---------------------------------------------------------------------------------------------

export interface ReferenceNeed {
  readonly id: string;
  /** How the step uses it, as a verb phrase that reads after "it": "is built on". */
  readonly verb: string;
}

/** The ids of the axes and bodies a definition is built on. */
export function referenceDependencies(spec: ReferenceSpec): { readonly axisIds: readonly string[]; readonly bodyIds: readonly string[] } {
  if (spec.kind === "primitive") return { axisIds: [], bodyIds: [] };
  if (spec.kind === "plane") {
    const found = planeDependencies(spec.definition);
    const extra = spec.definition.kind === "tangent-to-cylinder" ? [spec.definition.bodyId] : [];
    return { axisIds: found.axisIds, bodyIds: [...found.bodyIds, ...extra] };
  }
  if (spec.kind === "axis") return { axisIds: [], bodyIds: spec.definition.kind === "cylinder-axis" ? [spec.definition.bodyId] : [] };
  return { axisIds: spec.definition.kind === "axis-plane-intersection" ? [spec.definition.axisId] : [], bodyIds: [] };
}

/** The step that makes the construction item with this id (a plane, axis, point or primitive), if one does. */
export function referenceStepOf(history: DesignHistory, itemId: string): ReferenceFeature | undefined {
  for (const feature of history.features) if (isReferenceFeature(feature) && feature.bodyId === itemId) return feature;
  return undefined;
}

/** The plane step a sketch is placed on, if it was placed on one that is still in the timeline. */
export function planeStepOfSketch(history: DesignHistory, feature: DesignFeature): ReferenceFeature | undefined {
  if (feature.kind !== "sketch" || feature.sketch.planeRef === undefined) return undefined;
  const found = referenceStepOf(history, feature.sketch.planeRef);
  return found !== undefined && found.reference.kind === "plane" ? found : undefined;
}

/**
 * The steps a step needs to come before it. `bodyMaker` finds the step that made a body. A reference step is built on the axis steps it
 * names and on the steps that made the bodies it reaches for; a sketch placed on a construction plane is built on that plane's step.
 */
export function referenceNeeds(history: DesignHistory, feature: DesignFeature, bodyMaker: (bodyId: string) => DesignFeature | undefined): readonly ReferenceNeed[] {
  const needs: ReferenceNeed[] = [];
  const add = (id: string | undefined, verb: string): void => {
    if (id !== undefined && id !== feature.id && !needs.some((need) => need.id === id && need.verb === verb)) needs.push({ id, verb });
  };
  if (feature.kind === "sketch") {
    add(planeStepOfSketch(history, feature)?.id, "is placed on");
    return needs;
  }
  // A pattern turns about a construction axis, or reflects across a construction plane, of the timeline.
  if (!isReferenceFeature(feature)) {
    const pattern = feature.pattern;
    if (pattern?.type === "circular" && pattern.axis.kind === "construction") add(referenceStepOf(history, pattern.axis.axisId)?.id, "turns about");
    if (pattern?.type === "mirror" && pattern.plane.kind === "construction") add(referenceStepOf(history, pattern.plane.planeId)?.id, "reflects across");
    return needs;
  }
  const found = referenceDependencies(feature.reference);
  for (const axisId of found.axisIds) add(referenceStepOf(history, axisId)?.id, "is built on");
  for (const bodyId of found.bodyIds) add(bodyMaker(bodyId)?.id, "is built on the body made by");
  return needs;
}

/** Why a step goes when `closure` goes, in a clause ("built on Plane 1"), or undefined when it is not one of these steps. */
export function referenceReason(history: DesignHistory, feature: DesignFeature, closure: ReadonlySet<string>, bodyMaker: (bodyId: string) => DesignFeature | undefined): string | undefined {
  if (feature.kind !== "sketch" && !isReferenceFeature(feature)) return undefined;
  const need = referenceNeeds(history, feature, bodyMaker).find((candidate) => closure.has(candidate.id));
  if (need === undefined) return undefined;
  const name = history.features.find((candidate) => candidate.id === need.id)?.name ?? "a step";
  return `${need.verb.replace(/^is /u, "")} ${name}`;
}

// ---------------------------------------------------------------------------------------------
// Shape of a saved step
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;

/**
 * Whether a saved reference step is well formed: its own fields, a recorded definition of the matching kind, and no stray keys. How good
 * the definition itself is gets checked where the item it derives is checked (the part's lists); referenceConsistencyProblem ties the two.
 */
export function validReferenceFeatureShape(value: Record<string, unknown>): boolean {
  const allowed = ["id", "name", "kind", "suppressed", "sketchFeatureId", "profileIds", "valueMm", "bodyId", "reference", "health", "expressions"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (typeof value.name !== "string" || value.name.trim() === "" || value.name.length > 120 || typeof value.suppressed !== "boolean") return false;
  if (typeof value.kind !== "string" || !isReferenceKind(value.kind)) return false;
  if (value.sketchFeatureId !== "" || !Array.isArray(value.profileIds) || value.profileIds.length !== 0 || value.valueMm !== 0) return false;
  if (typeof value.bodyId !== "string" || value.bodyId.length > 128 || !ID_PATTERN.test(value.bodyId)) return false;
  const spec = value.reference;
  if (!isRecord(spec) || typeof spec.kind !== "string") return false;
  if ((KIND_OF_SPEC as Record<string, string>)[spec.kind] !== value.kind) return false;
  if (spec.kind === "primitive") {
    if (Object.keys(spec).some((key) => key !== "kind" && key !== "body") || !isRecord(spec.body) || typeof spec.body.shape !== "string") return false;
    if (["id", "name", "visible"].some((key) => Object.hasOwn(spec.body as Record<string, unknown>, key))) return false;
  } else if (Object.keys(spec).some((key) => key !== "kind" && key !== "definition") || !isRecord(spec.definition) || typeof spec.definition.kind !== "string") return false;
  if (Object.hasOwn(value, "health") && !(isRecord(value.health) && Object.keys(value.health).length === 1 && typeof value.health.message === "string" && value.health.message.length >= 1 && value.health.message.length <= 400)) return false;
  if (Object.hasOwn(value, "expressions")) {
    const expressions = value.expressions;
    if (!isRecord(expressions) || Object.keys(expressions).length > 32) return false;
    if (Object.entries(expressions).some(([key, text]) => key.length > 40 || typeof text !== "string" || text.length < 1 || text.length > 400)) return false;
  }
  return true;
}
