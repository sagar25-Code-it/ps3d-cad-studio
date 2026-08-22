import type { ManifoldToplevel, Mesh } from "manifold-3d";
import { fail, type Result } from "../../model-schema/src/index.js";
import {
  validateClosedMesh,
  type BracketSolidRequest,
  type EvaluatedSolid,
  type ModelMesh,
  type SolidKernel
} from "../../solid-kernel-api/src/index.js";

export class ManifoldSolidKernel implements SolidKernel {
  readonly profile = {
    adapter: "ps3d-solid-manifold-adapter",
    adapterVersion: "0.0.1-phase.0",
    dependency: "manifold-3d",
    dependencyVersion: "3.5.1",
    representation: "closed-oriented-manifold-triangle-mesh"
  } as const;

  readonly #module: ManifoldToplevel;

  constructor(module: ManifoldToplevel) {
    this.#module = module;
  }

  async buildBracket(request: BracketSolidRequest): Promise<Result<EvaluatedSolid>> {
    const inputValidation = validateRequest(request);
    if (!inputValidation.ok) return inputValidation;
    const { Manifold } = this.#module;
    let plate: InstanceType<typeof Manifold> | undefined;
    let bore: InstanceType<typeof Manifold> | undefined;
    let solid: InstanceType<typeof Manifold> | undefined;
    let dependencyMesh: ReturnType<InstanceType<typeof Manifold>["getMesh"]> | undefined;
    try {
      plate = Manifold.cube([request.widthMeters, request.heightMeters, request.thicknessMeters], true);
      bore = Manifold.cylinder(
        request.thicknessMeters * 1.5,
        request.holeDiameterMeters / 2,
        request.holeDiameterMeters / 2,
        request.circularSegments,
        true
      );
      solid = plate.subtract(bore);
      const status = solid.status();
      if (status !== "NoError" || solid.isEmpty()) {
        return fail("INVALID_SOLID_OUTPUT", "The evaluation-only mesh-solid candidate rejected the bounded bracket.", [request.bodyId], "Use dimensions inside the published Phase 0 envelope.");
      }
      dependencyMesh = solid.getMesh();
      const lifted = liftBracketMesh(dependencyMesh, request);
      if (!lifted.ok) return lifted;
      const mesh = lifted.value;
      const independent = validateClosedMesh(mesh);
      if (!independent.ok) return independent;
      const dependencyVolume = solid.volume();
      const measuredVolume = independent.value.measurements.volumeCubicMeters;
      const relativeVolumeDifference = Math.abs(dependencyVolume - measuredVolume) / dependencyVolume;
      if (!Number.isFinite(relativeVolumeDifference) || relativeVolumeDifference > 5e-5) {
        return fail("INVALID_SOLID_OUTPUT", "Independent mesh volume does not agree with the kernel measurement.", [request.bodyId], "Restore the last valid dimensions and report the engine profile.");
      }
      if (solid.genus() !== independent.value.topology.genus || independent.value.topology.components !== 1) {
        return fail("INVALID_SOLID_OUTPUT", "Independent topology checks do not agree with the kernel result.", [request.bodyId], "Restore the last valid dimensions and report the engine profile.");
      }
      return {
        ok: true,
        value: {
          bodyId: request.bodyId,
          engineProfile: `${this.profile.adapter}/${this.profile.adapterVersion}+${this.profile.dependency}@${this.profile.dependencyVersion}`,
          kernelIdentity: this.profile,
          mesh,
          measurements: independent.value.measurements,
          topology: independent.value.topology,
          toleranceMeters: solid.tolerance()
        }
      };
    } catch {
      return fail("UNSUPPORTED_GEOMETRIC_CASE", "The evaluation-only mesh-solid candidate could not regenerate this bounded bracket.", [request.bodyId], "Return to the last valid dimensions and retry.");
    } finally {
      solid?.delete();
      bore?.delete();
      plate?.delete();
    }
  }
}

function validateRequest(request: BracketSolidRequest): Result<BracketSolidRequest> {
  const dimensions = [request.widthMeters, request.heightMeters, request.thicknessMeters, request.holeDiameterMeters];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    return fail("INVALID_SOLID_INPUT", "The bracket solid request contains an invalid dimension.", [request.bodyId], "Enter finite positive dimensions.");
  }
  if (request.circularSegments !== 96) {
    return fail("INVALID_SOLID_INPUT", "Phase 0 evidence requires the fixed 96-segment bore profile.", [request.bodyId], "Regenerate with the fixed Phase 0 engine profile.");
  }
  if ((Math.min(request.widthMeters, request.heightMeters) - request.holeDiameterMeters) / 2 < 0.001) {
    return fail("DEGENERATE_GEOMETRY", "The solid request violates the 1 mm minimum wall allowance.", [request.bodyId], "Reduce the bore or enlarge the plate.");
  }
  return { ok: true, value: request };
}

function liftBracketMesh(mesh: Mesh, request: BracketSolidRequest): Result<ModelMesh> {
  // The official JS binding exposes tessellation positions as f32 even though
  // the kernel evaluates in f64. This bounded adapter restores only the known
  // analytic rectangle/circle coordinates; an unfamiliar vertex is rejected
  // instead of being promoted and mislabeled as model precision.
  const positions = new Float64Array(mesh.numVert * 3);
  const halfWidth = request.widthMeters / 2;
  const halfHeight = request.heightMeters / 2;
  const halfThickness = request.thicknessMeters / 2;
  const radius = request.holeDiameterMeters / 2;
  const matchTolerance = Math.max(1e-10, Math.max(request.widthMeters, request.heightMeters, request.thicknessMeters) * 2e-6);
  const angleStep = 2 * Math.PI / request.circularSegments;
  for (let vertex = 0; vertex < mesh.numVert; vertex += 1) {
    const source = vertex * mesh.numProp;
    const target = vertex * 3;
    const x = mesh.vertProperties[source]!;
    const y = mesh.vertProperties[source + 1]!;
    const z = mesh.vertProperties[source + 2]!;
    if (Math.abs(Math.abs(z) - halfThickness) > matchTolerance) {
      return fail("INVALID_SOLID_OUTPUT", "The candidate adapter produced a vertex away from the analytic bracket planes.", [request.bodyId], "Use the project-owned bounded evaluator for the Phase 0 workflow.");
    }
    if (Math.abs(Math.abs(x) - halfWidth) <= matchTolerance && Math.abs(Math.abs(y) - halfHeight) <= matchTolerance) {
      positions[target] = x < 0 ? -halfWidth : halfWidth;
      positions[target + 1] = y < 0 ? -halfHeight : halfHeight;
    } else if (Math.abs(Math.hypot(x, y) - radius) <= matchTolerance) {
      const segment = Math.round(Math.atan2(y, x) / angleStep);
      positions[target] = clean(radius * Math.cos(segment * angleStep));
      positions[target + 1] = clean(radius * Math.sin(segment * angleStep));
    } else {
      return fail("INVALID_SOLID_OUTPUT", "The candidate adapter produced a vertex outside the bounded analytic topology.", [request.bodyId], "Use the project-owned bounded evaluator for the Phase 0 workflow.");
    }
    positions[target + 2] = z < 0 ? -halfThickness : halfThickness;
  }
  return { ok: true, value: { positions, indices: new Uint32Array(mesh.triVerts) } };
}

function clean(value: number): number {
  return Math.abs(value) < 1e-15 ? 0 : value;
}
