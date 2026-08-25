import type { PartIntent, PartPreviewBody, Vec3 } from "../../workbench-core/src/index.js";
import { boundsFromPoints } from "./assembly.js";
import type { PreviewPrimitive, PreviewScene } from "./types.js";

/**
 * Builds the independent editable preview-body layer that is rendered beside
 * the qualified centered-bore body. No Boolean or face-level relationship is
 * implied by this scene; every primitive remains a separately selectable body.
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
    id: "part-scene:native-with-preview-bodies",
    kind: "part",
    primitives,
    boundsMm: boundsFromPoints(points)
  };
}

function partPreviewPrimitive(body: PartPreviewBody): PreviewPrimitive {
  const base = {
    id: body.id,
    name: `${body.name} · independent preview body`,
    color: body.color,
    opacity: 1,
    selectable: true,
    positionMm: body.translationMm,
    rotationDeg: body.rotationDeg
  } as const;
  if (body.shape === "block") return { ...base, kind: "box", sizeMm: body.sizeMm };
  if (body.shape === "cylinder") return {
    ...base,
    kind: "cylinder",
    radiusMm: body.sizeMm[0] / 2,
    heightMm: body.sizeMm[2],
    radialSegments: 64
  };
  if (body.shape === "cone") return {
    ...base,
    kind: "cone",
    baseRadiusMm: body.sizeMm[0] / 2,
    topRadiusMm: body.sizeMm[1] / 2,
    heightMm: body.sizeMm[2],
    radialSegments: 64
  };
  return {
    ...base,
    kind: "sphere",
    radiusMm: body.sizeMm[0] / 2,
    widthSegments: 64,
    heightSegments: 36
  };
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
