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
