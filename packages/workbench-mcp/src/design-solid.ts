import {
  applyWorkbenchOperation,
  designOf,
  type DesignSketchFeature,
  type DesignSolidFeature,
  type GeneralSolidBody,
  type WorkbenchOperation,
  type WorkbenchProject
} from "../../workbench-core/src/index.js";
import { rebuildSolidFeature, replayBody, sketchLookupOf } from "../../../apps/studio-web/src/design-regeneration.js";

/**
 * Builds a solid from a finished sketch of the supplied project, for a client that has no browser: the sketch-driving half of the MCP
 * surface. The sketch itself is made with the ordinary operations (new-design-sketch with its plane, apply-sketch-edit for curves and
 * relations, commit-design-sketch); this turns a sketch feature into an `add-design-solid` operation with the solid already built, which
 * then goes through the usual preview, confirmation and apply steps.
 */

const SOLID_KINDS = ["extrude", "revolve", "sweep", "loft"] as const;
type SolidKind = (typeof SOLID_KINDS)[number];

const SPEC_KEYS = [
  "kind", "sketchFeatureId", "valueMm", "profileIds", "name", "operation", "targetBodyId", "direction", "secondValueMm", "thinWallMm", "thinSide", "revolveAxis", "sweepPath",
  "sweepDirectionMm", "sweepTwistDeg", "loftSecondaryProfileIds", "loftSecondarySketchFeatureId", "loftTopScale", "loftContinuity", "edge", "operationId"
] as const;

export interface DesignSolidSpec extends Readonly<Record<string, unknown>> {
  readonly kind: SolidKind;
  readonly sketchFeatureId: string;
  readonly valueMm: number;
}

export type DesignSolidBuild =
  | { readonly ok: true; readonly operation: WorkbenchOperation; readonly solid: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stats(body: GeneralSolidBody): Readonly<Record<string, unknown>> {
  const p = body.positionsMm;
  let volume = 0;
  for (let index = 0; index < body.indices.length; index += 3) {
    const a = body.indices[index]! * 3; const b = body.indices[index + 1]! * 3; const c = body.indices[index + 2]! * 3;
    volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < p.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { lo[axis] = Math.min(lo[axis]!, p[index + axis]!); hi[axis] = Math.max(hi[axis]!, p[index + axis]!); }
  const round = (value: number): number => Number(value.toFixed(3));
  return { bodyId: body.id, volumeMm3: round(volume), boundsMm: { min: lo.map(round), max: hi.map(round) }, triangles: body.indices.length / 3 };
}

/** Builds the `add-design-solid` operation for a solid described by `spec`, or says what is wrong with the request. */
export async function buildDesignSolidOperation(project: WorkbenchProject, specInput: unknown): Promise<DesignSolidBuild> {
  if (!isRecord(specInput)) return { ok: false, code: "INVALID_PARAMS", message: "solid must be an object with kind, sketchFeatureId and valueMm." };
  const unknown = Object.keys(specInput).filter((key) => !(SPEC_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) return { ok: false, code: "INVALID_PARAMS", message: `solid has unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Supported: ${SPEC_KEYS.join(", ")}.` };
  const spec = specInput as DesignSolidSpec;
  if (!(SOLID_KINDS as readonly unknown[]).includes(spec.kind)) return { ok: false, code: "INVALID_PARAMS", message: `solid.kind must be one of ${SOLID_KINDS.join(", ")}.` };
  if (typeof spec.valueMm !== "number" || !Number.isFinite(spec.valueMm) || spec.valueMm === 0) return { ok: false, code: "INVALID_PARAMS", message: "solid.valueMm must be a non-zero number: the distance in mm, or the angle in degrees for a revolve." };
  const history = designOf(project);
  const sketches = history.features.filter((feature): feature is DesignSketchFeature => feature.kind === "sketch");
  const sketchFeature = sketches.find((feature) => feature.id === spec.sketchFeatureId);
  if (sketchFeature === undefined) {
    return { ok: false, code: "BROKEN_REFERENCE", message: `No finished sketch has the ID ${String(spec.sketchFeatureId)}. Finished sketches: ${sketches.map((feature) => `${feature.id} (${feature.name})`).join(", ") || "none; finish one with commit-design-sketch first"}.` };
  }
  const operationMode = spec.operation === undefined ? "new-body" : spec.operation;
  if (operationMode !== "new-body" && operationMode !== "join" && operationMode !== "cut") return { ok: false, code: "INVALID_PARAMS", message: "solid.operation must be new-body, join or cut." };
  const serial = project.revision + 1;
  const bodies = project.part.generalBodies ?? [];
  const target = operationMode === "new-body" ? undefined : bodies.find((body) => body.id === spec.targetBodyId);
  if (operationMode !== "new-body" && target === undefined) {
    return { ok: false, code: "BROKEN_REFERENCE", message: `A ${operationMode} needs targetBodyId of an existing solid. Solids: ${bodies.map((body) => body.id).join(", ") || "none"}.` };
  }
  const kindName = spec.kind[0]!.toUpperCase() + spec.kind.slice(1);
  const { kind: _kind, sketchFeatureId: _sketch, valueMm: _value, name: _name, operation: _operation, targetBodyId: _target, operationId: _operationId, profileIds: _profiles, ...rest } = spec as Record<string, unknown>;
  void _kind; void _sketch; void _value; void _name; void _operation; void _target; void _operationId; void _profiles;
  const feature = {
    id: `feature:mcp-${spec.kind}-${serial}`,
    name: typeof spec.name === "string" && spec.name.trim() !== "" ? spec.name.trim() : `${kindName} ${serial}`,
    kind: spec.kind,
    suppressed: false,
    sketchFeatureId: sketchFeature.id,
    profileIds: Array.isArray(spec.profileIds) ? spec.profileIds as string[] : [],
    valueMm: spec.valueMm,
    bodyId: target?.id ?? `general-body:mcp-${spec.kind}-${serial}`,
    ...(operationMode === "new-body" ? {} : { operation: operationMode }),
    ...rest
  } as DesignSolidFeature;
  const lookup = sketchLookupOf(history);
  let body: GeneralSolidBody;
  if (target === undefined) {
    const built = await rebuildSolidFeature(feature, sketchFeature, "#b9c2c8", lookup);
    if (!built.ok) return { ok: false, code: "SOLID_NOT_BUILT", message: built.message };
    body = built.body;
  } else {
    // A join or cut changes the solid it targets: add the step with the target as it is, replay that solid, and take the result.
    const staged = applyWorkbenchOperation(project, { operationId: "operation:mcp-stage", expectedRevision: project.revision, kind: "add-design-solid", feature, body: target });
    if (!staged.ok) return { ok: false, code: staged.diagnostics[0]?.code ?? "INVALID_OPERATION", message: staged.diagnostics[0]?.message ?? "The step could not be added." };
    const replayed = await replayBody(staged.value.project, target.id);
    const mine = replayed.find((result) => result.featureId === feature.id);
    if (mine?.message !== undefined) return { ok: false, code: "SOLID_NOT_BUILT", message: mine.message };
    const final = replayed.find((result) => result.body !== undefined)?.body;
    if (final === undefined) return { ok: false, code: "SOLID_NOT_BUILT", message: "The target solid could not be rebuilt with this step." };
    body = final;
  }
  const operation: WorkbenchOperation = {
    operationId: typeof spec.operationId === "string" ? spec.operationId : `operation:mcp-solid-r${project.revision}`,
    expectedRevision: project.revision,
    kind: "add-design-solid",
    feature,
    body
  };
  return { ok: true, operation, solid: { ...stats(body), featureId: feature.id, kind: spec.kind, operation: operationMode } };
}
