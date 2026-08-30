import type { PartIntent, PartPreviewBody, Vec3 } from "../../workbench-core/src/index.js";
import { boundsFromPoints } from "./assembly.js";
import type { PreviewPrimitive, PreviewScene } from "./types.js";

const RADIAL_SEGMENTS = 64;
const BLEND_CORNER_SEGMENTS = 8;

interface TriangleMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

/**
 * Builds PS3D's deterministic analytic feature layer beside the separately
 * qualified centered-bore body. Supported feature records become closed
 * triangle meshes; unsupported combinations are rejected by workbench-core
 * before they can reach this renderer.
 */
export function buildPartPreview(part: PartIntent): PreviewScene {
  const bodies = (part.previewBodies ?? []).filter((body) => body.visible);
  const primitives = bodies.map(partPreviewPrimitive);
  const halfWidth = part.widthMm / 2;
  const halfHeight = part.heightMm / 2;
  const halfThickness = part.thicknessMm / 2;
  const points: Vec3[] = [
    [-halfWidth, -halfHeight, -halfThickness],
    [halfWidth, halfHeight, halfThickness]
  ];
  for (const body of bodies) points.push(...previewBodyBounds(body));
  return {
    id: "part-scene:native-with-analytic-bodies",
    kind: "part",
    primitives,
    boundsMm: boundsFromPoints(points)
  };
}

function partPreviewPrimitive(body: PartPreviewBody): PreviewPrimitive {
  const base = {
    id: body.id,
    name: `${body.name} · bounded analytic body`,
    color: body.color,
    opacity: 1,
    selectable: true
  } as const;
  const localMesh = analyticBodyMesh(body);
  if (localMesh !== undefined) {
    return {
      ...base,
      kind: "mesh",
      positionsMm: transformPositions(localMesh.positions, body.translationMm, body.rotationDeg),
      indices: localMesh.indices,
      wireframe: false,
      doubleSided: false
    };
  }
  const transformed = { ...base, positionMm: body.translationMm, rotationDeg: body.rotationDeg } as const;
  if (body.shape === "block") return { ...transformed, kind: "box", sizeMm: body.sizeMm };
  if (body.shape === "cylinder") return { ...transformed, kind: "cylinder", radiusMm: body.sizeMm[0] / 2, heightMm: body.sizeMm[2], radialSegments: RADIAL_SEGMENTS };
  if (body.shape === "cone") return { ...transformed, kind: "cone", baseRadiusMm: body.sizeMm[0] / 2, topRadiusMm: body.sizeMm[1] / 2, heightMm: body.sizeMm[2], radialSegments: RADIAL_SEGMENTS };
  return { ...transformed, kind: "sphere", radiusMm: body.sizeMm[0] / 2, widthSegments: RADIAL_SEGMENTS, heightSegments: 36 };
}

function analyticBodyMesh(body: PartPreviewBody): TriangleMesh | undefined {
  if (body.shape === "revolved") return annularSectorMesh(body.sizeMm[0], body.sizeMm[1], body.sizeMm[2], body.revolveAngleDeg ?? 360);
  if (body.boreDiameterMm !== undefined && body.shape === "block") return boredBlockMesh(body.sizeMm[0], body.sizeMm[1], body.sizeMm[2], body.boreDiameterMm);
  if (body.boreDiameterMm !== undefined && body.shape === "cylinder") return annularSectorMesh(body.sizeMm[0], body.boreDiameterMm, body.sizeMm[2], 360);
  if (body.shellThicknessMm !== undefined && body.shape === "block") return blockCupMesh(body.sizeMm[0], body.sizeMm[1], body.sizeMm[2], body.shellThicknessMm);
  if (body.shellThicknessMm !== undefined && body.shape === "cylinder") return cylinderCupMesh(body.sizeMm[0], body.sizeMm[2], body.shellThicknessMm);
  if (body.draftAngleDeg !== undefined && body.shape === "block") {
    const shrink = 2 * body.sizeMm[2] * Math.tan(body.draftAngleDeg * Math.PI / 180);
    return extrudedContourMesh(rectangleContour(body.sizeMm[0] - shrink, body.sizeMm[1] - shrink), rectangleContour(body.sizeMm[0], body.sizeMm[1]), -body.sizeMm[2] / 2, body.sizeMm[2] / 2);
  }
  if (body.draftAngleDeg !== undefined && body.shape === "cylinder") {
    const lowerDiameter = body.sizeMm[0] - 2 * body.sizeMm[2] * Math.tan(body.draftAngleDeg * Math.PI / 180);
    return frustumMesh(lowerDiameter, body.sizeMm[0], body.sizeMm[2]);
  }
  if (body.edgeTreatment !== undefined && body.shape === "block") {
    const contour = body.edgeTreatment.kind === "chamfer"
      ? chamferedRectangleContour(body.sizeMm[0], body.sizeMm[1], body.edgeTreatment.sizeMm)
      : roundedRectangleContour(body.sizeMm[0], body.sizeMm[1], body.edgeTreatment.sizeMm);
    return extrudedContourMesh(contour, contour, -body.sizeMm[2] / 2, body.sizeMm[2] / 2);
  }
  return undefined;
}

function extrudedContourMesh(bottom: readonly Vec2[], top: readonly Vec2[], zBottom: number, zTop: number): TriangleMesh {
  if (bottom.length !== top.length) throw new Error("PS3D analytic contours must have matching vertex counts.");
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [x, y] of bottom) positions.push(x, y, zBottom);
  for (const [x, y] of top) positions.push(x, y, zTop);
  const bottomCenter = positions.length / 3; positions.push(0, 0, zBottom);
  const topCenter = positions.length / 3; positions.push(0, 0, zTop);
  const count = bottom.length;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    addQuad(indices, index, next, count + next, count + index);
    indices.push(bottomCenter, next, index);
    indices.push(topCenter, count + index, count + next);
  }
  return { positions, indices };
}

function blockCupMesh(width: number, depth: number, height: number, wall: number): TriangleMesh {
  return cupMesh(rectangleContour(width, depth), rectangleContour(width - 2 * wall, depth - 2 * wall), height, wall);
}

function cylinderCupMesh(diameter: number, height: number, wall: number): TriangleMesh {
  return cupMesh(circleContour(diameter / 2, RADIAL_SEGMENTS), circleContour(diameter / 2 - wall, RADIAL_SEGMENTS), height, wall);
}

function cupMesh(outer: readonly Vec2[], inner: readonly Vec2[], height: number, wall: number): TriangleMesh {
  if (outer.length !== inner.length) throw new Error("PS3D shell contours must have matching vertex counts.");
  const positions: number[] = [];
  const indices: number[] = [];
  const zBottom = -height / 2; const zTop = height / 2; const zFloor = zBottom + wall;
  const count = outer.length;
  for (const [x, y] of outer) positions.push(x, y, zBottom);
  for (const [x, y] of outer) positions.push(x, y, zTop);
  for (const [x, y] of inner) positions.push(x, y, zFloor);
  for (const [x, y] of inner) positions.push(x, y, zTop);
  const bottomCenter = positions.length / 3; positions.push(0, 0, zBottom);
  const floorCenter = positions.length / 3; positions.push(0, 0, zFloor);
  const outerBottom = 0; const outerTop = count; const innerBottom = count * 2; const innerTop = count * 3;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    addQuad(indices, outerBottom + index, outerBottom + next, outerTop + next, outerTop + index);
    indices.push(innerBottom + index, innerTop + next, innerBottom + next, innerBottom + index, innerTop + index, innerTop + next);
    indices.push(outerTop + index, outerTop + next, innerTop + next, outerTop + index, innerTop + next, innerTop + index);
    indices.push(bottomCenter, outerBottom + next, outerBottom + index);
    indices.push(floorCenter, innerBottom + index, innerBottom + next);
  }
  return { positions, indices };
}

function boredBlockMesh(width: number, depth: number, height: number, boreDiameter: number): TriangleMesh {
  const events = angularRectangleEvents(width / 2, depth / 2);
  const count = events.length;
  const positions: number[] = [];
  const indices: number[] = [];
  const radius = boreDiameter / 2; const zBottom = -height / 2; const zTop = height / 2;
  const outerBottom: Vec2[] = []; const outerTop: Vec2[] = []; const innerBottom: Vec2[] = []; const innerTop: Vec2[] = [];
  for (const event of events) {
    const cosine = clean(Math.cos(event.angle)); const sine = clean(Math.sin(event.angle));
    const outer = event.corner ?? rectangleRayPoint(cosine, sine, width / 2, depth / 2);
    const inner = [cosine * radius, sine * radius] as const;
    outerBottom.push(outer); outerTop.push(outer); innerBottom.push(inner); innerTop.push(inner);
  }
  for (const [x, y] of outerBottom) positions.push(x, y, zBottom);
  for (const [x, y] of outerTop) positions.push(x, y, zTop);
  for (const [x, y] of innerBottom) positions.push(x, y, zBottom);
  for (const [x, y] of innerTop) positions.push(x, y, zTop);
  const ob = 0; const ot = count; const ib = count * 2; const it = count * 3;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(ot + index, ot + next, it + next, ot + index, it + next, it + index);
    indices.push(ob + index, ib + next, ob + next, ob + index, ib + index, ib + next);
    addQuad(indices, ob + index, ob + next, ot + next, ot + index);
    indices.push(ib + index, it + next, ib + next, ib + index, it + index, it + next);
  }
  return { positions, indices };
}

function annularSectorMesh(outerDiameter: number, innerDiameter: number, height: number, angleDeg: number): TriangleMesh {
  const full = Math.abs(angleDeg - 360) < 1e-9;
  const segmentCount = Math.max(3, Math.round(RADIAL_SEGMENTS * angleDeg / 360));
  const sampleCount = full ? segmentCount : segmentCount + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const outerRadius = outerDiameter / 2; const innerRadius = innerDiameter / 2;
  const zBottom = -height / 2; const zTop = height / 2; const angle = angleDeg * Math.PI / 180;
  const rings = [
    { radius: outerRadius, z: zBottom }, { radius: outerRadius, z: zTop },
    { radius: innerRadius, z: zBottom }, { radius: innerRadius, z: zTop }
  ];
  for (const ring of rings) {
    for (let index = 0; index < sampleCount; index += 1) {
      const theta = angle * index / segmentCount;
      positions.push(clean(Math.cos(theta) * ring.radius), clean(Math.sin(theta) * ring.radius), ring.z);
    }
  }
  const ob = 0; const ot = sampleCount; const ib = sampleCount * 2; const it = sampleCount * 3;
  for (let index = 0; index < segmentCount; index += 1) {
    const next = full ? (index + 1) % sampleCount : index + 1;
    addQuad(indices, ob + index, ob + next, ot + next, ot + index);
    indices.push(ib + index, it + next, ib + next, ib + index, it + index, it + next);
    indices.push(ot + index, ot + next, it + next, ot + index, it + next, it + index);
    indices.push(ob + index, ib + next, ob + next, ob + index, ib + index, ib + next);
  }
  if (!full) {
    indices.push(ob, ot, it, ob, it, ib);
    const end = sampleCount - 1;
    indices.push(ob + end, ib + end, it + end, ob + end, it + end, ot + end);
  }
  return { positions, indices };
}

function frustumMesh(bottomDiameter: number, topDiameter: number, height: number): TriangleMesh {
  return extrudedContourMesh(circleContour(bottomDiameter / 2, RADIAL_SEGMENTS), circleContour(topDiameter / 2, RADIAL_SEGMENTS), -height / 2, height / 2);
}

type Vec2 = readonly [number, number];

function rectangleContour(width: number, depth: number): readonly Vec2[] {
  const x = width / 2; const y = depth / 2;
  return [[-x, -y], [x, -y], [x, y], [-x, y]];
}

function chamferedRectangleContour(width: number, depth: number, chamfer: number): readonly Vec2[] {
  const x = width / 2; const y = depth / 2;
  return [[-x + chamfer, -y], [x - chamfer, -y], [x, -y + chamfer], [x, y - chamfer], [x - chamfer, y], [-x + chamfer, y], [-x, y - chamfer], [-x, -y + chamfer]];
}

function roundedRectangleContour(width: number, depth: number, radius: number): readonly Vec2[] {
  const x = width / 2; const y = depth / 2;
  const corners = [
    { center: [x - radius, -y + radius] as Vec2, start: -Math.PI / 2 },
    { center: [x - radius, y - radius] as Vec2, start: 0 },
    { center: [-x + radius, y - radius] as Vec2, start: Math.PI / 2 },
    { center: [-x + radius, -y + radius] as Vec2, start: Math.PI }
  ];
  return corners.flatMap((corner) => Array.from({ length: BLEND_CORNER_SEGMENTS }, (_, index): Vec2 => {
    const angle = corner.start + index / (BLEND_CORNER_SEGMENTS - 1) * Math.PI / 2;
    return [corner.center[0] + radius * Math.cos(angle), corner.center[1] + radius * Math.sin(angle)];
  }));
}

function circleContour(radius: number, segments: number): readonly Vec2[] {
  return Array.from({ length: segments }, (_, index): Vec2 => {
    const angle = index / segments * Math.PI * 2;
    return [clean(Math.cos(angle) * radius), clean(Math.sin(angle) * radius)];
  });
}

interface AngularEvent { readonly angle: number; corner?: Vec2 }

function angularRectangleEvents(halfWidth: number, halfDepth: number): readonly AngularEvent[] {
  const events: AngularEvent[] = Array.from({ length: RADIAL_SEGMENTS }, (_, index) => ({ angle: index / RADIAL_SEGMENTS * Math.PI * 2 }));
  const corners: readonly Vec2[] = [[halfWidth, halfDepth], [-halfWidth, halfDepth], [-halfWidth, -halfDepth], [halfWidth, -halfDepth]];
  for (const corner of corners) {
    const angle = normalizeAngle(Math.atan2(corner[1], corner[0]));
    const existing = events.find((event) => angularDistance(event.angle, angle) < 1e-12);
    if (existing === undefined) events.push({ angle, corner }); else existing.corner = corner;
  }
  return events.sort((left, right) => left.angle - right.angle);
}

function rectangleRayPoint(cosine: number, sine: number, halfWidth: number, halfDepth: number): Vec2 {
  const scaleX = cosine === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(cosine);
  const scaleY = sine === 0 ? Number.POSITIVE_INFINITY : halfDepth / Math.abs(sine);
  const scale = Math.min(scaleX, scaleY);
  return [clean(cosine * scale), clean(sine * scale)];
}

function transformPositions(positions: readonly number[], translation: Vec3, rotationDeg: Vec3): readonly number[] {
  const matrix = rotationMatrix(rotationDeg);
  const transformed: number[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    const point = [positions[index]!, positions[index + 1]!, positions[index + 2]!] as Vec3;
    transformed.push(
      translation[0] + dot(matrix[0]!, point),
      translation[1] + dot(matrix[1]!, point),
      translation[2] + dot(matrix[2]!, point)
    );
  }
  return transformed;
}

function previewBodyBounds(body: PartPreviewBody): readonly Vec3[] {
  if (body.shape === "sphere") {
    const radius = body.sizeMm[0] / 2;
    return [
      [body.translationMm[0] - radius, body.translationMm[1] - radius, body.translationMm[2] - radius],
      [body.translationMm[0] + radius, body.translationMm[1] + radius, body.translationMm[2] + radius]
    ];
  }
  const localHalf: Vec3 = body.shape === "block"
    ? [body.sizeMm[0] / 2, body.sizeMm[1] / 2, body.sizeMm[2] / 2]
    : [Math.max(body.sizeMm[0], body.sizeMm[1]) / 2, Math.max(body.sizeMm[0], body.sizeMm[1]) / 2, body.sizeMm[2] / 2];
  const half = rotatedHalfExtents(localHalf, body.rotationDeg);
  return [
    [body.translationMm[0] - half[0], body.translationMm[1] - half[1], body.translationMm[2] - half[2]],
    [body.translationMm[0] + half[0], body.translationMm[1] + half[1], body.translationMm[2] + half[2]]
  ];
}

function rotatedHalfExtents(localHalf: Vec3, rotationDeg: Vec3): Vec3 {
  const matrix = rotationMatrix(rotationDeg);
  return matrix.map((row) => row.reduce((sum, value, axis) => sum + Math.abs(value) * localHalf[axis]!, 0)) as unknown as Vec3;
}

function rotationMatrix(rotationDeg: Vec3): readonly Vec3[] {
  const [x, y, z] = rotationDeg.map((value) => value * Math.PI / 180) as unknown as Vec3;
  const a = Math.cos(x); const b = Math.sin(x);
  const c = Math.cos(y); const d = Math.sin(y);
  const e = Math.cos(z); const f = Math.sin(z);
  return [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c]
  ];
}

function addQuad(indices: number[], a: number, b: number, c: number, d: number): void {
  indices.push(a, b, c, a, c, d);
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalizeAngle(angle: number): number { return angle < 0 ? angle + Math.PI * 2 : angle; }
function angularDistance(left: number, right: number): number { const raw = Math.abs(left - right); return Math.min(raw, Math.PI * 2 - raw); }
function clean(value: number): number { return Math.abs(value) < 1e-12 ? 0 : value; }
