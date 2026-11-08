import type { DesignSketchFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, isFormBody, isSurfaceBody } from "../../../packages/workbench-core/src/index.js";
import {
  boundaryPatch, deleteCageFaces, extendSurface, extrudeCageFaces, finishForm, insertEdgeLoop, isPlaced, loftSurface, moveCageVertices, placePositions, ruledSurface,
  stitchSurfaces, subdBox, subdCylinder, subdPlane, subdivideCage, surfaceArea, trimSurfaceByLoop, trimSurfaceByPlane, type Curve3, type ExtendOptions, type LoftOptions, type SubdCage, type SurfaceMesh
} from "../../../packages/workbench-geometry/src/index.js";
import { detectSketchProfiles, profileOutlineMm, sampleArc, sampleSpline } from "../../../packages/workbench-sketch/src/index.js";
import { NORMALS, planeKeyOf } from "./design-regeneration.js";

/**
 * The surface workspace and the SubD form, as plans of ordinary workbench operations. Each planner reads the project, builds the
 * mesh with the geometry layer and returns the `add-general-body` / `modify-general-body` / `delete-general-body` operations that
 * put it in the part, so a surface or form goes through exactly the validation, undo and file round trip every other body does.
 */
export type Intent<K extends WorkbenchOperation["kind"]> = Omit<Extract<WorkbenchOperation, { readonly kind: K }>, "operationId" | "expectedRevision">;
export type SurfaceIntent = Intent<"add-general-body"> | Intent<"modify-general-body"> | Intent<"delete-general-body">;

export type Planned =
  | { readonly ok: true; readonly operations: readonly SurfaceIntent[]; readonly summary: string; readonly bodyId: string }
  | { readonly ok: false; readonly message: string };

const SURFACE_COLOR = "#5aa6d6";
const FORM_COLOR = "#d6a05a";
const SOLID_COLOR = "#b9c2c8";
const MAX_BODIES = 64;

// ---------------------------------------------------------------------------------------------
// Curves from the timeline's sketches
// ---------------------------------------------------------------------------------------------

export interface SketchCurve {
  readonly id: string;
  readonly label: string;
  readonly sketchFeatureId: string;
  readonly closed: boolean;
  /** The curve in world space, millimetres. */
  readonly pointsMm: Curve3;
}

/** Lifts a point list drawn in a sketch's plane into world space, through its plane offset and any tilt or three-point frame. */
export function sketchPointsToWorld(sketchFeature: DesignSketchFeature, points: readonly (readonly [number, number])[]): Curve3 {
  const sketch = sketchFeature.sketch;
  const plane = planeKeyOf(sketch.plane);
  const normal = NORMALS[plane];
  const offset = sketch.planeOffsetMm ?? 0;
  const flat: number[] = [];
  for (const [u, v] of points) {
    const base: readonly [number, number, number] = plane === "xz" ? [u, 0, v] : plane === "yz" ? [0, v, -u] : [u, v, 0];
    flat.push(base[0] + normal[0] * offset, base[1] + normal[1] * offset, base[2] + normal[2] * offset);
  }
  const placed = isPlaced(sketch) ? placePositions(flat, sketch) : flat;
  return points.map((_, i) => [placed[i * 3]!, placed[i * 3 + 1]!, placed[i * 3 + 2]!] as const);
}

/**
 * Every curve the timeline's sketches hold that a surface can be built from: lines, arcs, splines, and the closed circles,
 * ellipses and rectangles, placed in 3D on their sketch planes. Construction and hidden geometry is left out.
 */
export function sketchCurvesOf(project: WorkbenchProject): readonly SketchCurve[] {
  const curves: SketchCurve[] = [];
  for (const feature of designOf(project).features) {
    if (feature.kind !== "sketch") continue;
    for (const entity of feature.sketch.entities) {
      if (entity.construction || entity.visible === false) continue;
      let flat: readonly (readonly [number, number])[] | undefined;
      let closed = false;
      if (entity.kind === "line") flat = [entity.start, entity.end];
      else if (entity.kind === "arc") flat = sampleArc(entity.start, entity.mid, entity.end);
      else if (entity.kind === "spline") flat = sampleSpline(entity.fitPoints);
      else if (entity.kind === "circle") {
        closed = true;
        flat = Array.from({ length: 73 }, (_, i) => [entity.center[0] + entity.radiusMm * Math.cos((i / 72) * Math.PI * 2), entity.center[1] + entity.radiusMm * Math.sin((i / 72) * Math.PI * 2)] as const);
      } else if (entity.kind === "ellipse") {
        closed = true;
        const turn = (entity.rotationDeg * Math.PI) / 180;
        flat = Array.from({ length: 73 }, (_, i) => {
          const t = (i / 72) * Math.PI * 2;
          const x = entity.majorRadiusMm * Math.cos(t);
          const y = entity.minorRadiusMm * Math.sin(t);
          return [entity.center[0] + x * Math.cos(turn) - y * Math.sin(turn), entity.center[1] + x * Math.sin(turn) + y * Math.cos(turn)] as const;
        });
      } else if (entity.kind === "rectangle") {
        closed = true;
        const turn = (entity.rotationDeg * Math.PI) / 180;
        const corners: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
        flat = corners.map(([x, y]) => {
          const px = (x * entity.widthMm) / 2;
          const py = (y * entity.heightMm) / 2;
          return [entity.center[0] + px * Math.cos(turn) - py * Math.sin(turn), entity.center[1] + px * Math.sin(turn) + py * Math.cos(turn)] as const;
        });
      }
      if (flat === undefined || flat.length < 2) continue;
      curves.push({ id: `${feature.id}/${entity.id}`, label: `${feature.name} · ${entity.kind} ${entity.id.split(":").at(-1) ?? entity.id}`, sketchFeatureId: feature.id, closed, pointsMm: sketchPointsToWorld(feature, flat) });
    }
    // Closed profiles made of several entities (a rounded outline, say) are also offered as one curve.
    for (const profile of detectSketchProfiles(feature.sketch)) {
      if (profile.boundary.kind !== "curve-loop") continue;
      const outline = profileOutlineMm(profile.boundary);
      const loop = [...outline, outline[0]!];
      curves.push({ id: `${feature.id}/${profile.id}`, label: `${feature.name} · closed profile`, sketchFeatureId: feature.id, closed: true, pointsMm: sketchPointsToWorld(feature, loop) });
    }
  }
  return curves;
}

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

function nextBodyId(project: WorkbenchProject, prefix: string): { readonly id: string; readonly ordinal: number } {
  const taken = new Set((project.part.generalBodies ?? []).map((body) => body.id));
  for (let ordinal = 1; ordinal < 1000; ordinal += 1) if (!taken.has(`general-body:${prefix}-${ordinal}`)) return { id: `general-body:${prefix}-${ordinal}`, ordinal };
  return { id: `general-body:${prefix}-x`, ordinal: 0 };
}

/** A surface body: an open triangle mesh with area and edges but no volume. */
export function surfaceBodyOf(id: string, name: string, mesh: SurfaceMesh, color = SURFACE_COLOR): GeneralSolidBody {
  return { id, name, visible: true, color, positionsMm: [...mesh.positionsMm], indices: [...mesh.indices], feature: { operation: "surface", plane: "xy", valueMm: Number(surfaceArea(mesh).toFixed(3)) } };
}

/** A SubD form body: the cage, subdivided to the given level and shown tessellated. */
export function formBodyOf(id: string, name: string, cage: SubdCage, levels: number, color = FORM_COLOR): { readonly ok: true; readonly body: GeneralSolidBody } | { readonly ok: false; readonly message: string } {
  const surface = subdivideCage(cage, levels);
  if (!surface.ok) return surface;
  return {
    ok: true,
    body: {
      id, name, visible: true, color, positionsMm: surface.mesh.positionsMm, indices: surface.mesh.indices,
      feature: { operation: "subd-form", plane: "xy", valueMm: levels },
      subd: { verticesMm: [...cage.verticesMm], faces: cage.faces.map((face) => [...face]), levels }
    }
  };
}

const canAdd = (project: WorkbenchProject): boolean => (project.part.generalBodies ?? []).length < MAX_BODIES;
const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody | undefined => (project.part.generalBodies ?? []).find((body) => body.id === id);

function addSurface(project: WorkbenchProject, label: string, prefix: string, mesh: SurfaceMesh): Planned {
  if (!canAdd(project)) return { ok: false, message: "The part reached its body limit; delete a body before adding a surface." };
  if (mesh.positionsMm.length > 290_000 || mesh.indices.length > 290_000) return { ok: false, message: "That surface has too many triangles to store; use fewer samples." };
  const { id, ordinal } = nextBodyId(project, prefix);
  const body = surfaceBodyOf(id, `${label} ${ordinal}`, mesh);
  return { ok: true, operations: [{ kind: "add-general-body", body }], summary: `Added ${body.name}: ${(body.feature?.valueMm ?? 0).toFixed(1)} mm² of surface, ${mesh.indices.length / 3} triangles.`, bodyId: id };
}

// ---------------------------------------------------------------------------------------------
// Surface planners
// ---------------------------------------------------------------------------------------------

export function planRuledSurface(project: WorkbenchProject, first: Curve3, second: Curve3, options: { readonly samples?: number; readonly rows?: number } = {}): Planned {
  const built = ruledSurface(first, second, options);
  return built.ok ? addSurface(project, "Ruled surface", "ruled", built.mesh) : built;
}

export function planLoftSurface(project: WorkbenchProject, sections: readonly Curve3[], options: LoftOptions = {}): Planned {
  const built = loftSurface(sections, options);
  return built.ok ? addSurface(project, "Loft surface", "loft", built.mesh) : built;
}

export function planBoundaryPatch(project: WorkbenchProject, edges: readonly Curve3[], options: { readonly samplesPerEdge?: number; readonly targetEdgeMm?: number } = {}): Planned {
  const built = boundaryPatch(edges, options);
  return built.ok ? addSurface(project, "Patch", "patch", built.mesh) : built;
}

function surfaceTarget(project: WorkbenchProject, bodyId: string): GeneralSolidBody | string {
  const body = bodyOf(project, bodyId);
  if (body === undefined) return "That body does not exist.";
  if (!isSurfaceBody(body)) return `${body.name} is not a surface; Extend and Trim work on surfaces.`;
  return body;
}

export function planExtendSurface(project: WorkbenchProject, bodyId: string, options: ExtendOptions): Planned {
  const target = surfaceTarget(project, bodyId);
  if (typeof target === "string") return { ok: false, message: target };
  const built = extendSurface({ positionsMm: target.positionsMm, indices: target.indices }, options);
  if (!built.ok) return built;
  const body = { ...surfaceBodyOf(target.id, target.name, built.mesh, target.color), visible: target.visible };
  return { ok: true, operations: [{ kind: "modify-general-body", targetBodyId: target.id, modifier: "surface-edit", label: `Extend by ${options.distanceMm} mm`, body }], summary: `Extended ${target.name} by ${options.distanceMm} mm.`, bodyId: target.id };
}

export type TrimRequest =
  | { readonly kind: "plane"; readonly pointMm: readonly [number, number, number]; readonly normalMm: readonly [number, number, number]; readonly keep: "positive" | "negative" }
  | { readonly kind: "loop"; readonly loopMm: Curve3; readonly directionMm: readonly [number, number, number]; readonly keep: "inside" | "outside" };

export function planTrimSurface(project: WorkbenchProject, bodyId: string, request: TrimRequest): Planned {
  const target = surfaceTarget(project, bodyId);
  if (typeof target === "string") return { ok: false, message: target };
  const mesh = { positionsMm: target.positionsMm, indices: target.indices };
  const built = request.kind === "plane" ? trimSurfaceByPlane(mesh, request.pointMm, request.normalMm, request.keep) : trimSurfaceByLoop(mesh, request.loopMm, request.directionMm, request.keep);
  if (!built.ok) return built;
  const body = { ...surfaceBodyOf(target.id, target.name, built.mesh, target.color), visible: target.visible };
  return { ok: true, operations: [{ kind: "modify-general-body", targetBodyId: target.id, modifier: "surface-edit", label: "Trim", body }], summary: `Trimmed ${target.name}: ${(body.feature?.valueMm ?? 0).toFixed(1)} mm² left.`, bodyId: target.id };
}

/** Sews surfaces into a solid: the first surface becomes the solid and the others are removed. */
export function planStitch(project: WorkbenchProject, bodyIds: readonly string[], toleranceMm = 0.01): Planned {
  const unique = [...new Set(bodyIds)];
  if (unique.length === 0) return { ok: false, message: "Pick the surfaces to stitch." };
  const bodies: GeneralSolidBody[] = [];
  for (const id of unique) {
    const target = surfaceTarget(project, id);
    if (typeof target === "string") return { ok: false, message: target };
    bodies.push(target);
  }
  const stitched = stitchSurfaces(bodies.map((body) => ({ positionsMm: body.positionsMm, indices: body.indices })), toleranceMm);
  if (!stitched.ok) return { ok: false, message: stitched.message };
  if (stitched.mesh.positionsMm.length > 290_000 || stitched.mesh.indices.length > 290_000) return { ok: false, message: "The stitched solid has too many triangles to store." };
  const first = bodies[0]!;
  const body: GeneralSolidBody = {
    id: first.id, name: first.name.replace(/surface|patch/iu, "Stitched solid"), visible: first.visible, color: SOLID_COLOR,
    positionsMm: [...stitched.mesh.positionsMm], indices: [...stitched.mesh.indices],
    feature: { operation: "stitched-solid", plane: "xy", valueMm: Number(stitched.volumeMm3.toFixed(3)) }
  };
  return {
    ok: true,
    operations: [{ kind: "modify-general-body", targetBodyId: first.id, modifier: "stitch", label: `Stitch ${unique.length} surface${unique.length === 1 ? "" : "s"}`, body }, ...bodies.slice(1).map((other): Intent<"delete-general-body"> => ({ kind: "delete-general-body", bodyId: other.id }))],
    summary: `Stitched ${unique.length} surface${unique.length === 1 ? "" : "s"} into ${body.name}: ${stitched.volumeMm3.toFixed(1)} mm³ solid.`,
    bodyId: first.id
  };
}

// ---------------------------------------------------------------------------------------------
// SubD form planners
// ---------------------------------------------------------------------------------------------

export type FormPrimitive =
  | { readonly kind: "box"; readonly widthMm: number; readonly depthMm: number; readonly heightMm: number }
  | { readonly kind: "plane"; readonly widthMm: number; readonly depthMm: number; readonly columns: number; readonly rows: number }
  | { readonly kind: "cylinder"; readonly radiusMm: number; readonly heightMm: number; readonly sides: number };

export function cageOfPrimitive(primitive: FormPrimitive): SubdCage | string {
  const sizes = primitive.kind === "box" ? [primitive.widthMm, primitive.depthMm, primitive.heightMm] : primitive.kind === "plane" ? [primitive.widthMm, primitive.depthMm] : [primitive.radiusMm, primitive.heightMm];
  if (!sizes.every((size) => Number.isFinite(size) && size > 0 && size <= 100_000)) return "A form primitive needs sizes above zero.";
  if (primitive.kind === "box") return subdBox(primitive.widthMm, primitive.depthMm, primitive.heightMm);
  if (primitive.kind === "plane") return Number.isInteger(primitive.columns) && Number.isInteger(primitive.rows) && primitive.columns >= 1 && primitive.rows >= 1 && primitive.columns * primitive.rows <= 400 ? subdPlane(primitive.widthMm, primitive.depthMm, primitive.columns, primitive.rows) : "A plane form needs 1 to 400 whole quads.";
  return Number.isInteger(primitive.sides) && primitive.sides >= 3 && primitive.sides <= 64 ? subdCylinder(primitive.radiusMm, primitive.heightMm, primitive.sides) : "A cylinder form needs 3 to 64 sides.";
}

export function planCreateForm(project: WorkbenchProject, primitive: FormPrimitive, levels = 3): Planned {
  if (!canAdd(project)) return { ok: false, message: "The part reached its body limit; delete a body before adding a form." };
  const cage = cageOfPrimitive(primitive);
  if (typeof cage === "string") return { ok: false, message: cage };
  const { id, ordinal } = nextBodyId(project, "form");
  const built = formBodyOf(id, `Form ${ordinal}`, cage, levels);
  if (!built.ok) return built;
  return { ok: true, operations: [{ kind: "add-general-body", body: built.body }], summary: `Added ${built.body.name}: a ${primitive.kind} cage of ${cage.faces.length} faces, subdivided ${levels} times.`, bodyId: id };
}

export type FormEdit =
  | { readonly kind: "move"; readonly vertexIds: readonly number[]; readonly deltaMm: readonly [number, number, number] }
  | { readonly kind: "extrude"; readonly faceIds: readonly number[]; readonly distanceMm: number; readonly insetMm?: number }
  | { readonly kind: "edge-loop"; readonly a: number; readonly b: number; readonly ratio?: number }
  | { readonly kind: "delete-faces"; readonly faceIds: readonly number[] }
  | { readonly kind: "levels"; readonly levels: number };

function formTarget(project: WorkbenchProject, bodyId: string): GeneralSolidBody | string {
  const body = bodyOf(project, bodyId);
  if (body === undefined) return "That body does not exist.";
  if (!isFormBody(body)) return `${body.name} is not an editable form (it may have been finished into a solid).`;
  return body;
}

export function planEditForm(project: WorkbenchProject, bodyId: string, edit: FormEdit): Planned {
  const target = formTarget(project, bodyId);
  if (typeof target === "string") return { ok: false, message: target };
  const cage: SubdCage = { verticesMm: target.subd!.verticesMm, faces: target.subd!.faces };
  let next: { readonly ok: true; readonly cage: SubdCage; readonly note?: string } | { readonly ok: false; readonly message: string };
  let levels = target.subd!.levels;
  let label: string;
  switch (edit.kind) {
    case "move": next = moveCageVertices(cage, edit.vertexIds, edit.deltaMm); label = `Move ${edit.vertexIds.length} vertex${edit.vertexIds.length === 1 ? "" : "es"}`; break;
    case "extrude": next = extrudeCageFaces(cage, edit.faceIds, edit.distanceMm, edit.insetMm ?? 0); label = `Extrude ${edit.faceIds.length} face${edit.faceIds.length === 1 ? "" : "s"}`; break;
    case "edge-loop": next = insertEdgeLoop(cage, edit.a, edit.b, edit.ratio ?? 0.5); label = "Add edge loop"; break;
    case "delete-faces": next = deleteCageFaces(cage, edit.faceIds); label = `Delete ${edit.faceIds.length} face${edit.faceIds.length === 1 ? "" : "s"}`; break;
    case "levels": next = { ok: true, cage }; levels = edit.levels; label = `Subdivide ${edit.levels} levels`; break;
  }
  if (!next.ok) return next;
  const built = formBodyOf(target.id, target.name, next.cage, levels, target.color);
  if (!built.ok) return built;
  return { ok: true, operations: [{ kind: "modify-general-body", targetBodyId: target.id, modifier: "form-edit", label, body: { ...built.body, visible: target.visible } }], summary: `${label} on ${target.name}.${"note" in next && next.note !== undefined ? ` ${next.note}` : ""}`, bodyId: target.id };
}

/** Finish Form: a closed form becomes an ordinary solid body (its cage is dropped); an open one is refused. */
export function planFinishForm(project: WorkbenchProject, bodyId: string): Planned {
  const target = formTarget(project, bodyId);
  if (typeof target === "string") return { ok: false, message: target };
  const finished = finishForm({ verticesMm: target.subd!.verticesMm, faces: target.subd!.faces }, target.subd!.levels);
  if (!finished.ok) return finished;
  const body: GeneralSolidBody = {
    id: target.id, name: target.name, visible: target.visible, color: target.color === FORM_COLOR ? SOLID_COLOR : target.color,
    positionsMm: finished.positionsMm, indices: finished.indices,
    feature: { operation: "subd-solid", plane: "xy", valueMm: Number(finished.volumeMm3.toFixed(3)) }
  };
  return { ok: true, operations: [{ kind: "modify-general-body", targetBodyId: target.id, modifier: "form-finish", label: "Finish Form", body }], summary: `Finished ${target.name} into a solid of ${finished.volumeMm3.toFixed(1)} mm³.`, bodyId: target.id };
}
