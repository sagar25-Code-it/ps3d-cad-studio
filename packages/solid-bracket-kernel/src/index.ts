import { ENGINE_PROFILE, fail, type Result } from "../../model-schema/src/index.js";
import {
  validateClosedMesh,
  type BracketSolidRequest,
  type EvaluatedSolid,
  type ModelMesh,
  type SolidKernel
} from "../../solid-kernel-api/src/index.js";

const RING_SEGMENTS = 96;

/**
 * Original, deliberately bounded f64 evaluator for the single Phase 0
 * rectangle-with-centered-passage feature graph. It is not a general Boolean
 * engine and must not be routed any other feature shape.
 */
export class BracketSolidKernel implements SolidKernel {
  readonly profile = {
    adapter: "ps3d-solid-bracket-kernel",
    adapterVersion: "0.0.1-phase.0",
    dependency: "project-owned",
    dependencyVersion: "0.0.1-phase.0",
    representation: "closed-oriented-manifold-triangle-mesh"
  } as const;

  async buildBracket(request: BracketSolidRequest): Promise<Result<EvaluatedSolid>> {
    const inputValidation = validateRequest(request);
    if (!inputValidation.ok) return inputValidation;
    const mesh = buildMesh(request);
    const independent = validateClosedMesh(mesh);
    if (!independent.ok) return independent;
    if (independent.value.topology.components !== 1 || independent.value.topology.genus !== 1) {
      return fail("INVALID_SOLID_OUTPUT", "The bounded bracket evaluator produced unexpected topology.", [request.bodyId], "Restore the last valid dimensions and report the engine profile.");
    }
    return {
      ok: true,
      value: {
        bodyId: request.bodyId,
        engineProfile: ENGINE_PROFILE,
        kernelIdentity: this.profile,
        mesh,
        measurements: independent.value.measurements,
        topology: independent.value.topology,
        toleranceMeters: 1e-12
      }
    };
  }
}

function validateRequest(request: BracketSolidRequest): Result<BracketSolidRequest> {
  const dimensions = [request.widthMeters, request.heightMeters, request.thicknessMeters, request.holeDiameterMeters];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    return fail("INVALID_SOLID_INPUT", "The bracket solid request contains an invalid dimension.", [request.bodyId], "Enter finite positive dimensions.");
  }
  if (request.circularSegments !== RING_SEGMENTS) {
    return fail("INVALID_SOLID_INPUT", "Phase 0 evidence requires the fixed 96-segment passage profile.", [request.bodyId], "Regenerate with the fixed Phase 0 engine profile.");
  }
  if ((Math.min(request.widthMeters, request.heightMeters) - request.holeDiameterMeters) / 2 < 0.001) {
    return fail("DEGENERATE_GEOMETRY", "The solid request violates the 1 mm minimum wall allowance.", [request.bodyId], "Reduce the passage or enlarge the plate.");
  }
  return { ok: true, value: request };
}

function buildMesh(request: BracketSolidRequest): ModelMesh {
  const halfWidth = request.widthMeters / 2;
  const halfHeight = request.heightMeters / 2;
  const events = angularEvents(halfWidth, halfHeight);
  const ringVertices = events.length;
  const positions = new Float64Array(ringVertices * 4 * 3);
  const triangles: number[] = [];
  const halfThickness = request.thicknessMeters / 2;
  const radius = request.holeDiameterMeters / 2;
  const outerBottom = 0;
  const outerTop = ringVertices;
  const innerBottom = ringVertices * 2;
  const innerTop = ringVertices * 3;

  for (let index = 0; index < ringVertices; index += 1) {
    const event = events[index]!;
    const angle = event.angle;
    const cosine = cleanTrig(Math.cos(angle));
    const sine = cleanTrig(Math.sin(angle));
    const outer = event.corner ?? rectangleRayPoint(cosine, sine, halfWidth, halfHeight);
    const inner = event.uniformIndex === undefined
      ? polygonChordRayPoint(angle, radius)
      : [cosine * radius, sine * radius] as const;
    writePoint(positions, outerBottom + index, outer[0], outer[1], -halfThickness);
    writePoint(positions, outerTop + index, outer[0], outer[1], halfThickness);
    writePoint(positions, innerBottom + index, inner[0], inner[1], -halfThickness);
    writePoint(positions, innerTop + index, inner[0], inner[1], halfThickness);
  }

  for (let index = 0; index < ringVertices; index += 1) {
    const next = (index + 1) % ringVertices;
    // Top annulus (+Z).
    addTriangle(triangles, outerTop + index, outerTop + next, innerTop + next);
    addTriangle(triangles, outerTop + index, innerTop + next, innerTop + index);
    // Bottom annulus (-Z).
    addTriangle(triangles, outerBottom + index, innerBottom + next, outerBottom + next);
    addTriangle(triangles, outerBottom + index, innerBottom + index, innerBottom + next);
    // Outer wall (away from the origin).
    addTriangle(triangles, outerBottom + index, outerBottom + next, outerTop + next);
    addTriangle(triangles, outerBottom + index, outerTop + next, outerTop + index);
    // Passage wall (toward the origin).
    addTriangle(triangles, innerBottom + index, innerTop + next, innerBottom + next);
    addTriangle(triangles, innerBottom + index, innerTop + index, innerTop + next);
  }

  return { positions, indices: Uint32Array.from(triangles) };
}

interface AngularEvent {
  angle: number;
  uniformIndex?: number;
  corner?: readonly [number, number];
}

function angularEvents(halfWidth: number, halfHeight: number): readonly AngularEvent[] {
  const step = 2 * Math.PI / RING_SEGMENTS;
  const events: AngularEvent[] = Array.from({ length: RING_SEGMENTS }, (_, uniformIndex) => ({ angle: uniformIndex * step, uniformIndex }));
  const corners: readonly (readonly [number, number])[] = [
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight]
  ];
  for (const corner of corners) {
    const angle = normalizeAngle(Math.atan2(corner[1], corner[0]));
    const existing = events.find((event) => angularDistance(event.angle, angle) < 1e-13);
    if (existing === undefined) events.push({ angle, corner });
    else existing.corner = corner;
  }
  events.sort((left, right) => left.angle - right.angle);
  return events;
}

function rectangleRayPoint(cosine: number, sine: number, halfWidth: number, halfHeight: number): readonly [number, number] {
  const scaleX = cosine === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(cosine);
  const scaleY = sine === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(sine);
  const scale = Math.min(scaleX, scaleY);
  return [cleanTrig(cosine * scale), cleanTrig(sine * scale)];
}

function polygonChordRayPoint(angle: number, radius: number): readonly [number, number] {
  const step = 2 * Math.PI / RING_SEGMENTS;
  const previous = Math.floor(angle / step);
  const next = (previous + 1) % RING_SEGMENTS;
  const start: readonly [number, number] = [radius * Math.cos(previous * step), radius * Math.sin(previous * step)];
  const end: readonly [number, number] = [radius * Math.cos(next * step), radius * Math.sin(next * step)];
  const edge: readonly [number, number] = [end[0] - start[0], end[1] - start[1]];
  const ray: readonly [number, number] = [Math.cos(angle), Math.sin(angle)];
  const distance = cross2(start, edge) / cross2(ray, edge);
  return [cleanTrig(ray[0] * distance), cleanTrig(ray[1] * distance)];
}

function cross2(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] * right[1] - left[1] * right[0];
}

function normalizeAngle(angle: number): number {
  return angle < 0 ? angle + 2 * Math.PI : angle;
}

function angularDistance(left: number, right: number): number {
  const raw = Math.abs(left - right);
  return Math.min(raw, 2 * Math.PI - raw);
}

function writePoint(positions: Float64Array, vertex: number, x: number, y: number, z: number): void {
  const offset = vertex * 3;
  positions[offset] = x;
  positions[offset + 1] = y;
  positions[offset + 2] = z;
}

function addTriangle(triangles: number[], a: number, b: number, c: number): void {
  triangles.push(a, b, c);
}

function cleanTrig(value: number): number {
  return Math.abs(value) < 1e-15 ? 0 : value;
}
