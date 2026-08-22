import type { SurfaceIntent, Vec3 } from "../../workbench-core/src/index.js";
import { boundsFromPoints } from "./assembly.js";
import type { PreviewPrimitive, SurfaceMetrics, SurfacePreview } from "./types.js";

export function buildSurfacePreview(surface: SurfaceIntent): SurfacePreview {
  const controlNet = buildControlNet(surface);
  const positions: number[] = [];
  for (let vIndex = 0; vIndex <= surface.vSegments; vIndex += 1) {
    const v = vIndex / surface.vSegments;
    for (let uIndex = 0; uIndex <= surface.uSegments; uIndex += 1) {
      const u = uIndex / surface.uSegments;
      positions.push(...(surface.mode === "bezier" ? bezierPoint(controlNet, u, v) : loftPoint(surface, u, v)));
    }
  }
  const indices: number[] = [];
  const row = surface.uSegments + 1;
  for (let v = 0; v < surface.vSegments; v += 1) {
    for (let u = 0; u < surface.uSegments; u += 1) {
      const a = v * row + u;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const mesh: PreviewPrimitive = {
    id: surface.id,
    name: surface.name,
    kind: "mesh",
    color: surface.mode === "bezier" ? "#36bfe2" : "#8a7df0",
    opacity: 0.86,
    selectable: true,
    positionsMm: positions,
    indices,
    wireframe: false,
    doubleSided: true
  };
  const controlLines = controlNetLines(controlNet);
  const scene = {
    id: surface.id,
    kind: "surface" as const,
    primitives: [mesh, ...controlLines],
    boundsMm: boundsFromPoints(pointsFromFlat(positions))
  };
  return { scene, metrics: surfaceMetrics(positions, indices, surface), controlNet };
}

export function buildControlNet(surface: SurfaceIntent): readonly Vec3[] {
  const points: Vec3[] = [];
  const twistHeight = Math.tan(surface.twistDeg * Math.PI / 180) * Math.min(surface.widthMm, surface.depthMm) / 8;
  for (let v = 0; v < 4; v += 1) {
    const sy = v / 3 * 2 - 1;
    for (let u = 0; u < 4; u += 1) {
      const sx = u / 3 * 2 - 1;
      const crown = surface.crownMm * Math.max(0, 1 - sx * sx) * Math.max(0, 1 - sy * sy);
      points.push([sx * surface.widthMm / 2, sy * surface.depthMm / 2, crown + twistHeight * sx * sy]);
    }
  }
  return points;
}

export function bezierPoint(controlNet: readonly Vec3[], u: number, v: number): Vec3 {
  if (controlNet.length !== 16) throw new RangeError("A bicubic patch requires 16 control points.");
  const bu = bernstein3(u);
  const bv = bernstein3(v);
  const point: [number, number, number] = [0, 0, 0];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const weight = bu[column]! * bv[row]!;
      const control = controlNet[row * 4 + column]!;
      point[0] += control[0] * weight;
      point[1] += control[1] * weight;
      point[2] += control[2] * weight;
    }
  }
  return point;
}

export function loftPoint(surface: SurfaceIntent, u: number, v: number): Vec3 {
  const xNormalized = u * 2 - 1;
  const halfWidth = surface.widthMm / 2;
  const angle = (v - 0.5) * surface.twistDeg * Math.PI / 180;
  const scale = 0.72 + 0.28 * Math.cos((v - 0.5) * Math.PI);
  const x = xNormalized * halfWidth * scale;
  const z = surface.crownMm * (1 - xNormalized * xNormalized) * (0.65 + 0.35 * Math.sin(v * Math.PI));
  const y = (v - 0.5) * surface.depthMm;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
}

function surfaceMetrics(positions: readonly number[], indices: readonly number[], surface: SurfaceIntent): SurfaceMetrics {
  let area = 0;
  let maximumVariation = 0;
  let priorNormal: Vec3 | undefined;
  for (let index = 0; index < indices.length; index += 3) {
    const a = point(positions, indices[index]!);
    const b = point(positions, indices[index + 1]!);
    const c = point(positions, indices[index + 2]!);
    const cross = cross3(subtract(b, a), subtract(c, a));
    const length = Math.hypot(...cross);
    area += length / 2;
    const normal: Vec3 = length === 0 ? [0, 0, 1] : [cross[0] / length, cross[1] / length, cross[2] / length];
    if (priorNormal !== undefined) {
      const cosine = clamp(dot(priorNormal, normal), -1, 1);
      maximumVariation = Math.max(maximumVariation, Math.acos(cosine) * 180 / Math.PI);
    }
    priorNormal = normal;
  }
  if (!Number.isFinite(area) || positions.some((value) => !Number.isFinite(value))) throw new Error("Surface tessellation produced a non-finite value.");
  return {
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    boundaryEdges: 2 * surface.uSegments + 2 * surface.vSegments,
    approximateAreaSquareMm: area,
    maximumNormalVariationDeg: maximumVariation,
    finite: true
  };
}

function controlNetLines(controlNet: readonly Vec3[]): readonly PreviewPrimitive[] {
  const lines: PreviewPrimitive[] = [];
  for (let row = 0; row < 4; row += 1) {
    lines.push(line(`control-row:${row}`, Array.from({ length: 4 }, (_, column) => controlNet[row * 4 + column]!)));
  }
  for (let column = 0; column < 4; column += 1) {
    lines.push(line(`control-column:${column}`, Array.from({ length: 4 }, (_, row) => controlNet[row * 4 + column]!)));
  }
  return lines;
}

function line(id: string, points: readonly Vec3[]): PreviewPrimitive {
  return { id, name: "Control net", kind: "line", color: "#f0b85c", opacity: 0.7, selectable: false, pointsMm: points.flatMap((point) => [...point]), dashed: false };
}

function bernstein3(value: number): readonly [number, number, number, number] {
  const inverse = 1 - value;
  return [inverse ** 3, 3 * value * inverse ** 2, 3 * value ** 2 * inverse, value ** 3];
}

function pointsFromFlat(values: readonly number[]): readonly Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < values.length; index += 3) points.push([values[index]!, values[index + 1]!, values[index + 2]!]);
  return points;
}

function point(values: readonly number[], index: number): Vec3 {
  const offset = index * 3;
  return [values[offset]!, values[offset + 1]!, values[offset + 2]!];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross3(left: Vec3, right: Vec3): Vec3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
