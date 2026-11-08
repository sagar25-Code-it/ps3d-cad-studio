import * as THREE from "three";

/**
 * Analysis overlays: colour-mapped copies of body meshes (draft angle, wall thickness, curvature, problem faces) and
 * highlight lines (open edges, interference outlines, curvature combs) that the viewport draws on top of the model.
 * Positions are in millimetres, as everywhere in the workbench; the viewport scene is in metres.
 */

export type OverlayRgb = readonly [number, number, number];

export interface ViewportAnalysisMesh {
  readonly id: string;
  readonly positionsMm: readonly number[];
  /** Triangles to draw (a subset of a body's triangles is fine, for example just the failing faces). */
  readonly indices: readonly number[];
  /** One flat colour per entry of `indices` / 3. */
  readonly triangleColors?: readonly OverlayRgb[];
  /** Or one colour per vertex of `positionsMm`, blended across each triangle. */
  readonly vertexColors?: readonly OverlayRgb[];
  /** Used when neither colour list is given. */
  readonly color?: OverlayRgb;
  readonly opacity?: number;
}

export interface ViewportAnalysisLines {
  readonly id: string;
  /** Flat x1,y1,z1,x2,y2,z2 per segment, in mm. */
  readonly segmentsMm: readonly number[];
  readonly color: string;
  /** Draw through the model (default true), so highlights are never hidden by the surface they mark. */
  readonly onTop?: boolean;
}

export interface ViewportAnalysisOverlay {
  readonly meshes: readonly ViewportAnalysisMesh[];
  readonly lines: readonly ViewportAnalysisLines[];
}

export const EMPTY_ANALYSIS_OVERLAY: ViewportAnalysisOverlay = { meshes: [], lines: [] };

/** Builds the three.js objects for an overlay; the caller owns them and disposes them with `disposeAnalysisGroup`. */
export function buildAnalysisGroup(overlay: ViewportAnalysisOverlay): THREE.Group {
  const group = new THREE.Group();
  group.userData["ps3dAnalysisOverlay"] = true;
  for (const entry of overlay.meshes) {
    const triangleCount = Math.floor(entry.indices.length / 3);
    if (triangleCount === 0) continue;
    const positions = new Float32Array(triangleCount * 9);
    const colors = new Float32Array(triangleCount * 9);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = entry.indices[triangle * 3 + corner]!;
        const target = triangle * 9 + corner * 3;
        positions[target] = entry.positionsMm[vertex * 3]! / 1000;
        positions[target + 1] = entry.positionsMm[vertex * 3 + 1]! / 1000;
        positions[target + 2] = entry.positionsMm[vertex * 3 + 2]! / 1000;
        const color = entry.triangleColors?.[triangle] ?? entry.vertexColors?.[vertex] ?? entry.color ?? [0.8, 0.8, 0.8];
        colors[target] = color[0];
        colors[target + 1] = color[1];
        colors[target + 2] = color[2];
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const opacity = entry.opacity ?? 1;
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData["analysisId"] = entry.id;
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  for (const entry of overlay.lines) {
    const count = Math.floor(entry.segmentsMm.length / 6);
    if (count === 0) continue;
    const positions = new Float32Array(count * 6);
    for (let index = 0; index < count * 6; index += 1) positions[index] = entry.segmentsMm[index]! / 1000;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const onTop = entry.onTop !== false;
    const material = new THREE.LineBasicMaterial({ color: entry.color, depthTest: !onTop, transparent: onTop });
    const lines = new THREE.LineSegments(geometry, material);
    lines.userData["analysisId"] = entry.id;
    lines.renderOrder = onTop ? 20 : 3;
    group.add(lines);
  }
  return group;
}

export function disposeAnalysisGroup(group: THREE.Group): void {
  group.traverse((entry) => {
    if (entry instanceof THREE.Mesh || entry instanceof THREE.LineSegments) {
      entry.geometry.dispose();
      const material = entry.material;
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material.dispose();
    }
  });
  group.clear();
}
