import * as THREE from "three";
import type { ExchangeBounds, ExchangeMetrics } from "./types.js";

const ZERO_BOUNDS: ExchangeBounds = {
  minMeters: [0, 0, 0],
  maxMeters: [0, 0, 0],
  sizeMeters: [0, 0, 0],
  centerMeters: [0, 0, 0]
};

export function inspectExchangeObject(object: THREE.Object3D): ExchangeMetrics {
  let objectCount = 0;
  let meshCount = 0;
  let pointCount = 0;
  let lineCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  const materials = new Set<THREE.Material>();

  object.updateMatrixWorld(true);
  object.traverse((entry) => {
    objectCount += 1;
    if (entry instanceof THREE.Mesh) {
      meshCount += 1;
      const position = entry.geometry.getAttribute("position");
      vertexCount += position?.count ?? 0;
      triangleCount += entry.geometry.index === null
        ? Math.floor((position?.count ?? 0) / 3)
        : Math.floor(entry.geometry.index.count / 3);
      collectMaterials(entry.material, materials);
    } else if (entry instanceof THREE.Points) {
      pointCount += entry.geometry.getAttribute("position")?.count ?? 0;
      collectMaterials(entry.material, materials);
    } else if (entry instanceof THREE.Line) {
      lineCount += 1;
      vertexCount += entry.geometry.getAttribute("position")?.count ?? 0;
      collectMaterials(entry.material, materials);
    }
  });

  const box = new THREE.Box3().setFromObject(object);
  const bounds = box.isEmpty() ? ZERO_BOUNDS : boxToBounds(box);
  return { objectCount, meshCount, pointCount, lineCount, vertexCount, triangleCount, materialCount: materials.size, bounds };
}

export function cloneExchangeObject(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  clone.traverse((entry) => {
    if (entry instanceof THREE.Mesh || entry instanceof THREE.Line || entry instanceof THREE.Points) {
      entry.geometry = entry.geometry.clone();
      entry.material = Array.isArray(entry.material)
        ? entry.material.map((material) => material.clone())
        : entry.material.clone();
    }
  });
  return clone;
}

export function disposeExchangeObject(object: THREE.Object3D): void {
  object.traverse((entry) => {
    if (entry instanceof THREE.Mesh || entry instanceof THREE.Line || entry instanceof THREE.Points) {
      entry.geometry.dispose();
      const materials = Array.isArray(entry.material) ? entry.material : [entry.material];
      for (const material of materials) material.dispose();
    }
  });
}

function boxToBounds(box: THREE.Box3): ExchangeBounds {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    minMeters: [box.min.x, box.min.y, box.min.z],
    maxMeters: [box.max.x, box.max.y, box.max.z],
    sizeMeters: [size.x, size.y, size.z],
    centerMeters: [center.x, center.y, center.z]
  };
}

function collectMaterials(material: THREE.Material | THREE.Material[], target: Set<THREE.Material>): void {
  if (Array.isArray(material)) material.forEach((entry) => target.add(entry));
  else target.add(material);
}
