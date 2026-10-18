import type { ManifoldToplevel, Mesh } from "manifold-3d";
import { fail, type Result } from "../../model-schema/src/index.js";
import { validateClosedMesh, type EvaluatedSolid, type KernelIdentity, type ModelMesh } from "../../solid-kernel-api/src/index.js";

/**
 * Stage 1 general mesh-solid evaluator. Unlike the bounded Phase 0 bracket adapter, this path
 * extrudes and revolves ARBITRARY closed planar profiles into validated closed-manifold solids
 * through manifold-3d. Every result is independently re-validated (closed, single-component,
 * volume agreeing with the kernel) before it is trusted, so an unsupported case fails explicitly
 * instead of being promoted as model precision.
 */

export type ProfilePoint = readonly [number, number];

const GENERAL_KERNEL_IDENTITY: KernelIdentity = {
  adapter: "ps3d-solid-manifold-adapter",
  adapterVersion: "0.1.0-stage.1",
  dependency: "manifold-3d",
  dependencyVersion: "3.5.1",
  representation: "closed-oriented-manifold-triangle-mesh"
};

const GENERAL_ENGINE_PROFILE = `${GENERAL_KERNEL_IDENTITY.adapter}/${GENERAL_KERNEL_IDENTITY.adapterVersion}+${GENERAL_KERNEL_IDENTITY.dependency}@${GENERAL_KERNEL_IDENTITY.dependencyVersion}`;

function meshToModelMesh(mesh: Mesh): ModelMesh {
  const positions = new Float64Array(mesh.numVert * 3);
  for (let vertex = 0; vertex < mesh.numVert; vertex += 1) {
    const source = vertex * mesh.numProp;
    positions[vertex * 3] = mesh.vertProperties[source]!;
    positions[vertex * 3 + 1] = mesh.vertProperties[source + 1]!;
    positions[vertex * 3 + 2] = mesh.vertProperties[source + 2]!;
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

function finalizeSolid(module: ManifoldToplevel, solid: InstanceType<ManifoldToplevel["Manifold"]>, bodyId: string): Result<EvaluatedSolid> {
  void module;
  if (solid.status() !== "NoError" || solid.isEmpty()) {
    return fail("INVALID_SOLID_OUTPUT", "The general mesh-solid evaluation produced an invalid or empty solid.", [bodyId], "Adjust the profile or operation parameters and retry.");
  }
  const mesh = meshToModelMesh(solid.getMesh());
  const validated = validateClosedMesh(mesh);
  if (!validated.ok) return validated;
  const dependencyVolume = solid.volume();
  const measuredVolume = validated.value.measurements.volumeCubicMeters;
  const relativeVolumeDifference = Math.abs(dependencyVolume - measuredVolume) / Math.abs(dependencyVolume);
  if (!Number.isFinite(relativeVolumeDifference) || relativeVolumeDifference > 5e-5) {
    return fail("INVALID_SOLID_OUTPUT", "The independent mesh volume disagrees with the kernel measurement.", [bodyId], "Restore the last valid parameters and report the engine profile.");
  }
  if (validated.value.topology.components !== 1) {
    return fail("INVALID_SOLID_OUTPUT", "The evaluation produced more than one closed body.", [bodyId], "Use a single closed profile.");
  }
  return {
    ok: true,
    value: {
      bodyId,
      engineProfile: GENERAL_ENGINE_PROFILE,
      kernelIdentity: GENERAL_KERNEL_IDENTITY,
      mesh,
      measurements: validated.value.measurements,
      topology: validated.value.topology,
      toleranceMeters: solid.tolerance()
    }
  };
}

export interface ExtrudeProfileRequest {
  readonly bodyId: string;
  /** Closed, non-self-intersecting planar polygon in metres (XY). */
  readonly profileMeters: readonly ProfilePoint[];
  readonly heightMeters: number;
}

/** Extrude an arbitrary closed planar profile along +Z into a validated closed-manifold solid. */
export function extrudeProfileSolid(module: ManifoldToplevel, request: ExtrudeProfileRequest): Result<EvaluatedSolid> {
  if (request.profileMeters.length < 3) {
    return fail("INVALID_SOLID_INPUT", "An extruded profile needs at least three points.", [request.bodyId], "Supply a closed polygon with three or more vertices.");
  }
  if (!Number.isFinite(request.heightMeters) || request.heightMeters <= 0) {
    return fail("INVALID_SOLID_INPUT", "The extrusion height must be a finite positive distance.", [request.bodyId], "Enter a positive extrusion height.");
  }
  const { CrossSection } = module;
  const contour = request.profileMeters.map((point) => [point[0], point[1]] as [number, number]);
  let section: InstanceType<typeof CrossSection> | undefined;
  let solid: InstanceType<ManifoldToplevel["Manifold"]> | undefined;
  try {
    section = new CrossSection([contour], "Positive");
    solid = section.extrude(request.heightMeters);
    return finalizeSolid(module, solid, request.bodyId);
  } catch {
    return fail("UNSUPPORTED_GEOMETRIC_CASE", "The general mesh-solid evaluator could not extrude this profile.", [request.bodyId], "Use a simple, non-self-intersecting profile with consistent winding.");
  } finally {
    solid?.delete();
    section?.delete();
  }
}

export interface RevolveProfileRequest {
  readonly bodyId: string;
  /** Closed planar polygon in metres (X = radial distance from the axis, Y = axial). X must be >= 0. */
  readonly profileMeters: readonly ProfilePoint[];
  readonly degrees: number;
  readonly circularSegments?: number;
}

/** Revolve an arbitrary closed planar profile about the axis into a validated closed-manifold solid. */
export function revolveProfileSolid(module: ManifoldToplevel, request: RevolveProfileRequest): Result<EvaluatedSolid> {
  if (request.profileMeters.length < 3) {
    return fail("INVALID_SOLID_INPUT", "A revolved profile needs at least three points.", [request.bodyId], "Supply a closed polygon with three or more vertices.");
  }
  if (!Number.isFinite(request.degrees) || request.degrees <= 0 || request.degrees > 360) {
    return fail("INVALID_SOLID_INPUT", "The revolve angle must be between 0 and 360 degrees.", [request.bodyId], "Use a revolve angle in (0, 360].");
  }
  if (request.profileMeters.some((point) => point[0] < 0)) {
    return fail("DEGENERATE_GEOMETRY", "A revolved profile must stay on the positive side of the revolve axis.", [request.bodyId], "Keep every profile point at X >= 0.");
  }
  const { CrossSection } = module;
  const segments = Math.max(3, Math.min(Math.round(request.circularSegments ?? 64), 512));
  const contour = request.profileMeters.map((point) => [point[0], point[1]] as [number, number]);
  let section: InstanceType<typeof CrossSection> | undefined;
  let solid: InstanceType<ManifoldToplevel["Manifold"]> | undefined;
  try {
    section = new CrossSection([contour], "Positive");
    solid = section.revolve(segments, request.degrees);
    return finalizeSolid(module, solid, request.bodyId);
  } catch {
    return fail("UNSUPPORTED_GEOMETRIC_CASE", "The general mesh-solid evaluator could not revolve this profile.", [request.bodyId], "Keep the profile on one side of the axis and non-self-intersecting.");
  } finally {
    solid?.delete();
    section?.delete();
  }
}

// -------------------------------------------------------------------------------------------------
// Stage 1 M2/M3: composable feature evaluator (primitives, plane placement, and booleans)
// -------------------------------------------------------------------------------------------------

/** Datum plane a profile is drawn on; the extrude/revolve axis is that plane's normal. */
export type SketchPlane = "xy" | "xz" | "yz";
export type BooleanMode = "union" | "subtract" | "intersect";
export type Vector3 = readonly [number, number, number];

export type SolidSpec =
  | { readonly kind: "extrude"; readonly profileMeters: readonly ProfilePoint[]; readonly heightMeters: number; readonly plane?: SketchPlane }
  | { readonly kind: "revolve"; readonly profileMeters: readonly ProfilePoint[]; readonly degrees: number; readonly circularSegments?: number; readonly plane?: SketchPlane }
  | { readonly kind: "box"; readonly sizeMeters: Vector3; readonly centerMeters?: Vector3 }
  | { readonly kind: "cylinder"; readonly radiusMeters: number; readonly heightMeters: number; readonly circularSegments?: number; readonly centerMeters?: Vector3 }
  | { readonly kind: "sphere"; readonly radiusMeters: number; readonly circularSegments?: number; readonly centerMeters?: Vector3 };

type Disposable = { delete: () => void };

function planeRotation(plane: SketchPlane | undefined): Vector3 | undefined {
  if (plane === "xz") return [90, 0, 0]; // profile XY -> world XZ, extrude along -Y
  if (plane === "yz") return [0, 90, 0]; // profile XY -> world ZY, extrude along +X
  return undefined; // "xy" / default: extrude along +Z
}

function clampSegments(value: number | undefined, fallback: number): number {
  return Math.max(3, Math.min(Math.round(value ?? fallback), 512));
}

/** Build one live Manifold for a spec. Every intermediate (including CrossSections) is tracked for disposal. */
function buildSpecManifold(module: ManifoldToplevel, spec: SolidSpec, track: <T extends Disposable>(value: T) => T): InstanceType<ManifoldToplevel["Manifold"]> {
  const { Manifold, CrossSection } = module;
  if (spec.kind === "extrude" || spec.kind === "revolve") {
    const contour = spec.profileMeters.map((point) => [point[0], point[1]] as [number, number]);
    const section = track(new CrossSection([contour], "Positive"));
    let solid = track(spec.kind === "extrude"
      ? section.extrude(spec.heightMeters)
      : section.revolve(clampSegments(spec.circularSegments, 64), spec.degrees));
    const rotation = planeRotation(spec.plane);
    if (rotation !== undefined) solid = track(solid.rotate(rotation as [number, number, number]));
    return solid;
  }
  let solid: InstanceType<ManifoldToplevel["Manifold"]>;
  if (spec.kind === "box") solid = track(Manifold.cube(spec.sizeMeters as [number, number, number], true));
  else if (spec.kind === "cylinder") solid = track(Manifold.cylinder(spec.heightMeters, spec.radiusMeters, spec.radiusMeters, clampSegments(spec.circularSegments, 64), true));
  else solid = track(Manifold.sphere(spec.radiusMeters, clampSegments(spec.circularSegments, 64)));
  const center = spec.centerMeters;
  if (center !== undefined && (center[0] !== 0 || center[1] !== 0 || center[2] !== 0)) solid = track(solid.translate(center as [number, number, number]));
  return solid;
}

function validateSpec(spec: SolidSpec, bodyId: string): Result<SolidSpec> {
  if (spec.kind === "extrude") {
    if (spec.profileMeters.length < 3) return fail("INVALID_SOLID_INPUT", "An extruded profile needs at least three points.", [bodyId], "Supply a closed polygon.");
    if (!Number.isFinite(spec.heightMeters) || spec.heightMeters <= 0) return fail("INVALID_SOLID_INPUT", "The extrusion height must be a finite positive distance.", [bodyId], "Enter a positive height.");
  } else if (spec.kind === "revolve") {
    if (spec.profileMeters.length < 3) return fail("INVALID_SOLID_INPUT", "A revolved profile needs at least three points.", [bodyId], "Supply a closed polygon.");
    if (!Number.isFinite(spec.degrees) || spec.degrees <= 0 || spec.degrees > 360) return fail("INVALID_SOLID_INPUT", "The revolve angle must be in (0, 360].", [bodyId], "Use a valid revolve angle.");
    if (spec.profileMeters.some((point) => point[0] < 0)) return fail("DEGENERATE_GEOMETRY", "A revolved profile must stay on the positive side of the axis.", [bodyId], "Keep X >= 0.");
  } else if (spec.kind === "box") {
    if (spec.sizeMeters.some((value) => !Number.isFinite(value) || value <= 0)) return fail("INVALID_SOLID_INPUT", "A box needs three positive dimensions.", [bodyId], "Enter positive sizes.");
  } else if (spec.kind === "cylinder") {
    if (!Number.isFinite(spec.radiusMeters) || spec.radiusMeters <= 0 || !Number.isFinite(spec.heightMeters) || spec.heightMeters <= 0) return fail("INVALID_SOLID_INPUT", "A cylinder needs a positive radius and height.", [bodyId], "Enter positive values.");
  } else if (!Number.isFinite(spec.radiusMeters) || spec.radiusMeters <= 0) {
    return fail("INVALID_SOLID_INPUT", "A sphere needs a positive radius.", [bodyId], "Enter a positive radius.");
  }
  return { ok: true, value: spec };
}

/**
 * Evaluate an ordered feature list into one validated closed solid. With a single spec this is just
 * that primitive/extrude/revolve; with several it reduces them with the boolean mode (subtract =
 * first minus the rest), which is how "plate with a bore", "join two bodies", etc. are modeled.
 */
export function combineSolids(module: ManifoldToplevel, bodyId: string, specs: readonly SolidSpec[], mode: BooleanMode = "union"): Result<EvaluatedSolid> {
  if (specs.length === 0) return fail("INVALID_SOLID_INPUT", "At least one solid feature is required.", [bodyId], "Add a profile or primitive feature.");
  for (const spec of specs) {
    const validated = validateSpec(spec, bodyId);
    if (!validated.ok) return validated;
  }
  const created: Disposable[] = [];
  const track = <T extends Disposable>(value: T): T => { created.push(value); return value; };
  try {
    const built = specs.map((spec) => buildSpecManifold(module, spec, track));
    let accumulator = built[0]!;
    for (let index = 1; index < built.length; index += 1) {
      const operand = built[index]!;
      accumulator = track(mode === "union" ? accumulator.add(operand) : mode === "subtract" ? accumulator.subtract(operand) : accumulator.intersect(operand));
    }
    return finalizeSolid(module, accumulator, bodyId);
  } catch {
    return fail("UNSUPPORTED_GEOMETRIC_CASE", "The feature evaluation could not be completed.", [bodyId], "Check that the features overlap as required and are non-degenerate.");
  } finally {
    for (const disposable of created) {
      try { disposable.delete(); } catch { /* best-effort release */ }
    }
  }
}
