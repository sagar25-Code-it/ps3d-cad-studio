import { entityNames } from "./sketch-translate.js";
import type { SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * Refraction is solved with every other relation (see buildRefraction in the solver package). Two things stay outside the iteration
 * because they are decisions rather than equations:
 *
 *  - the starting guess: the refracted line begins on the correct side of the interface, at the incident line's end, bent by Snell's
 *    law, so the iteration converges to the physical branch instead of the mirror image;
 *  - the refusals: a ray that runs along the interface has no refraction, and a ray that cannot cross (total internal reflection) has
 *    none either. Both are named, with the lines involved, before and after the solve.
 */

const EPS = 1e-9;
type Line = Extract<SketchEntity, { kind: "line" }>;

export interface RefractionRefusal {
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

const RECOVERY = "Change the refractive-index ratio or the incident line so the ray crosses the interface.";

function unitOf(line: Line): Vec2 | undefined {
  const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
  return length < EPS ? undefined : [(line.end[0] - line.start[0]) / length, (line.end[1] - line.start[1]) / length];
}

interface Parts {
  readonly incident: Line;
  readonly refracted: Line;
  readonly boundary: Line;
}

function partsOf(constraint: WorkbenchSketchConstraint, byId: ReadonlyMap<string, SketchEntity>): Parts | undefined {
  const [incidentId, refractedId, boundaryId] = constraint.entityIds;
  const incident = byId.get(incidentId ?? "");
  const refracted = byId.get(refractedId ?? "");
  const boundary = byId.get(boundaryId ?? "");
  if (incident?.kind !== "line" || refracted?.kind !== "line" || boundary?.kind !== "line") return undefined;
  return { incident, refracted, boundary };
}

/** The refracted direction for an incident direction, or why there is none. */
function bend(parts: Parts, ratio: number, names: ReadonlyMap<string, string>): { readonly outgoing: Vec2 } | { readonly error: string } {
  const tangent = unitOf(parts.boundary);
  const incoming = unitOf(parts.incident);
  if (tangent === undefined || incoming === undefined) return { error: "A line of the refraction is too short to give a direction." };
  const normal: Vec2 = [-tangent[1], tangent[0]];
  const across = incoming[0] * normal[0] + incoming[1] * normal[1];
  const incidentName = names.get(parts.incident.id) ?? "the incident line";
  const boundaryName = names.get(parts.boundary.id) ?? "the interface";
  if (Math.abs(across) < 1e-9) return { error: `${incidentName} runs along ${boundaryName}, so there is no refraction.` };
  const alongOut = (incoming[0] * tangent[0] + incoming[1] * tangent[1]) / ratio;
  if (Math.abs(alongOut) > 1 + 1e-12) return { error: `Total internal reflection: at an index ratio of ${Math.round(ratio * 1000) / 1000} the ray ${incidentName} cannot cross ${boundaryName}.` };
  const crossOut = Math.sign(across) * Math.sqrt(Math.max(0, 1 - alongOut * alongOut));
  return { outgoing: [tangent[0] * alongOut + normal[0] * crossOut, tangent[1] * alongOut + normal[1] * crossOut] };
}

function activeRefractions(sketch: Pick<WorkbenchSketch, "constraints">, component: ReadonlySet<string>, forceActive?: ReadonlySet<string>): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints.filter((constraint) => constraint.kind === "refraction" && (constraint.suppressed !== true || forceActive?.has(constraint.id) === true) && constraint.ratio !== undefined && constraint.ratio > 0 && constraint.entityIds.some((id) => component.has(id)));
}

/**
 * Starts each refraction from the refracted line it implies (leaving the incident line's end, bent by Snell's law, at its own length).
 * Returns the sketch with those lines replaced, or the refusal that applies.
 */
export function seedRefractions(sketch: WorkbenchSketch, component: ReadonlySet<string>, forceActive?: ReadonlySet<string>): { readonly sketch: WorkbenchSketch } | { readonly refusal: RefractionRefusal } {
  const list = activeRefractions(sketch, component, forceActive);
  if (list.length === 0) return { sketch };
  const names = entityNames(sketch);
  const byId = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  const replaced = new Map<string, SketchEntity>();
  for (const constraint of list) {
    const parts = partsOf(constraint, byId);
    if (parts === undefined) continue;
    const bent = bend(parts, constraint.ratio!, names);
    if ("error" in bent) return { refusal: { message: bent.error, relatedIds: [constraint.id, ...constraint.entityIds], recovery: RECOVERY } };
    const length = Math.hypot(parts.refracted.end[0] - parts.refracted.start[0], parts.refracted.end[1] - parts.refracted.start[1]);
    const start = parts.incident.end;
    const end: Vec2 = [start[0] + bent.outgoing[0] * length, start[1] + bent.outgoing[1] * length];
    const seeded: Line = { ...parts.refracted, start, end };
    replaced.set(seeded.id, seeded);
    byId.set(seeded.id, seeded);
  }
  if (replaced.size === 0) return { sketch };
  return { sketch: { ...sketch, entities: sketch.entities.map((entity) => replaced.get(entity.id) ?? entity) } };
}

/** After the solve: a ray that was moved so it can no longer cross (or runs along the interface) is refused by name. */
export function refractionRefusal(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[], component: ReadonlySet<string>): RefractionRefusal | undefined {
  const sketch = { entities, constraints };
  const list = activeRefractions(sketch, component);
  if (list.length === 0) return undefined;
  const names = entityNames(sketch);
  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  for (const constraint of list) {
    const parts = partsOf(constraint, byId);
    if (parts === undefined) continue;
    const bent = bend(parts, constraint.ratio!, names);
    if ("error" in bent) return { message: bent.error, relatedIds: [constraint.id, ...constraint.entityIds], recovery: RECOVERY };
  }
  return undefined;
}

/** The refraction constraints of a sketch whose three lines are all present: used by tests and read-outs. */
export function refractionConstraints(sketch: Pick<WorkbenchSketch, "constraints">): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints.filter((constraint) => constraint.kind === "refraction");
}
