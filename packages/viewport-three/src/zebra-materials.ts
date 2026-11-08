import * as THREE from "three";
import { ZEBRA_FRAGMENT_SOURCE, ZEBRA_UNIFORMS_SOURCE, axisVector, clampZebraFrequency, type ZebraOptions } from "./zebra.js";

/**
 * Applies the zebra-stripe shading to every mesh under an object, whatever its material: standard / physical, Phong,
 * Lambert and Toon materials get the stripe shader patched in; any other material (basic, matcap, normal, a material
 * array entry of any kind) is swapped for a lit stand-in for as long as the stripes are on, and swapped back when they
 * are turned off. Meshes without normals get them computed. Helper meshes (edge overlays) are left alone.
 *
 * No DOM or renderer is needed, so the behaviour is testable in Node.
 */

const originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
const substitutes = new WeakSet<THREE.Material>();

function takesPatch(material: THREE.Material): boolean {
  return material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial || material instanceof THREE.MeshLambertMaterial || material instanceof THREE.MeshToonMaterial;
}

function patchMaterial(material: THREE.Material, options: ZebraOptions | null): void {
  material.customProgramCacheKey = () => (options === null ? "" : `zebra:${options.axis}:${options.frequency}`);
  material.onBeforeCompile = options === null
    ? () => undefined
    : (shader) => {
      const axis = axisVector(options.axis);
      shader.uniforms["uZebraAxis"] = { value: new THREE.Vector3(axis[0], axis[1], axis[2]) };
      shader.uniforms["uZebraFrequency"] = { value: options.frequency };
      shader.fragmentShader = shader.fragmentShader
        .replace("void main() {", `${ZEBRA_UNIFORMS_SOURCE}void main() {`)
        .replace("#include <opaque_fragment>", `#include <opaque_fragment>${ZEBRA_FRAGMENT_SOURCE}`);
    };
  material.needsUpdate = true;
}

function litStandIn(source: THREE.Material): THREE.MeshStandardMaterial {
  const stand = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 });
  const colored = source as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; vertexColors?: boolean };
  if (colored.color instanceof THREE.Color) stand.color.copy(colored.color);
  if (colored.map instanceof THREE.Texture) stand.map = colored.map;
  stand.vertexColors = colored.vertexColors === true;
  stand.side = source.side;
  stand.transparent = source.transparent;
  stand.opacity = source.opacity;
  substitutes.add(stand);
  return stand;
}

/** Turns zebra stripes on (options) or off (null) for every mesh under `root`; returns how many meshes were striped. */
export function applyZebraToObject(root: THREE.Object3D, options: ZebraOptions | null): number {
  const clean = options === null ? null : { axis: options.axis, frequency: clampZebraFrequency(options.frequency) };
  let striped = 0;
  root.traverse((entry) => {
    if (!(entry instanceof THREE.Mesh)) return;
    if (entry.userData["ps3dExchangeHelper"] === true) return;
    if (clean === null) {
      restoreMesh(entry);
      return;
    }
    if (!entry.geometry.getAttribute("position")) return;
    if (!entry.geometry.getAttribute("normal")) entry.geometry.computeVertexNormals();
    const current = entry.material;
    const list = Array.isArray(current) ? current : [current];
    if (!originals.has(entry) && list.some((material) => !takesPatch(material))) {
      originals.set(entry, current);
      const replaced = list.map((material) => (takesPatch(material) ? material : litStandIn(material)));
      entry.material = Array.isArray(current) ? replaced : replaced[0]!;
    }
    for (const material of Array.isArray(entry.material) ? entry.material : [entry.material]) patchMaterial(material, clean);
    striped += 1;
  });
  return striped;
}

function restoreMesh(mesh: THREE.Mesh): void {
  const original = originals.get(mesh);
  if (original !== undefined) {
    const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const kept = new Set(Array.isArray(original) ? original : [original]);
    for (const material of current) if (!kept.has(material) && substitutes.has(material)) material.dispose();
    mesh.material = original;
    originals.delete(mesh);
  }
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    if (takesPatch(material)) patchMaterial(material, null);
  }
}

/** Disposes the original materials of meshes that are being thrown away while zebra stand-ins are on them. */
export function disposeZebraOriginals(root: THREE.Object3D): void {
  root.traverse((entry) => {
    if (!(entry instanceof THREE.Mesh)) return;
    const original = originals.get(entry);
    if (original === undefined) return;
    for (const material of Array.isArray(original) ? original : [original]) material.dispose();
    originals.delete(entry);
  });
}
