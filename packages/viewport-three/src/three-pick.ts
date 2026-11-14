/**
 * The three.js side of screen-space picking: the camera as a plain matrix, the triangles of a mesh in world millimetres (so
 * edges can be found on any drawn body), and the hidden-edge test that casts a ray at a candidate point.
 */

import * as THREE from "three";
import { creaseEdges, type CreaseResult } from "../../workbench-geometry/src/crease-edges.js";
import type { PickCamera } from "./edge-pick.js";

/** The matrix that takes millimetre world points to clip space, for the active camera. */
export function pickCameraOf(camera: THREE.Camera, widthPx: number, heightPx: number): PickCamera {
  camera.updateMatrixWorld();
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(new THREE.Matrix4().makeScale(0.001, 0.001, 0.001));
  return { viewProjection: Array.from(matrix.elements), widthPx, heightPx };
}

/** A mesh's triangles in world millimetres; undefined for anything that is not an indexed or plain triangle mesh. */
export function meshTrianglesMm(mesh: THREE.Mesh): { readonly positionsMm: number[]; readonly indices: number[] } | undefined {
  const geometry = mesh.geometry;
  if (!(geometry instanceof THREE.BufferGeometry)) return undefined;
  const position = geometry.getAttribute("position");
  if (position === undefined || position.itemSize < 3) return undefined;
  mesh.updateMatrixWorld(true);
  const vector = new THREE.Vector3();
  const positionsMm: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    vector.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(mesh.matrixWorld);
    positionsMm.push(vector.x * 1000, vector.y * 1000, vector.z * 1000);
  }
  const index = geometry.getIndex();
  const indices: number[] = [];
  if (index === null) for (let i = 0; i < position.count; i += 1) indices.push(i);
  else for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i));
  return { positionsMm, indices };
}

/** Creased and boundary edges of every mesh of one body, with chain numbers that stay distinct between its meshes. */
export function creaseEdgesOfMeshes(meshes: readonly THREE.Mesh[], creaseAngleDeg: number): CreaseResult {
  const edges: CreaseResult["edges"][number][] = [];
  let truncated = false;
  let angle = creaseAngleDeg;
  let chainBase = 0;
  let tangentBase = 0;
  for (const mesh of meshes) {
    const triangles = meshTrianglesMm(mesh);
    if (triangles === undefined) continue;
    const found = creaseEdges(triangles, { creaseAngleDeg });
    angle = found.creaseAngleDeg;
    truncated = truncated || found.truncated;
    let maxChain = -1;
    let maxTangent = -1;
    for (const edge of found.edges) {
      edges.push({ ...edge, chain: edge.chain + chainBase, tangentChain: edge.tangentChain + tangentBase });
      maxChain = Math.max(maxChain, edge.chain);
      maxTangent = Math.max(maxTangent, edge.tangentChain);
    }
    chainBase += maxChain + 1;
    tangentBase += maxTangent + 1;
  }
  return { edges, truncated, creaseAngleDeg: angle };
}

/**
 * A test of whether a point on a body can be seen from the camera: a ray through the point's pixel must not meet a surface
 * clearly nearer than the point. Edges lie on the surface, so the allowance is a small share of the distance to the camera.
 */
export function makeVisibilityTest(raycaster: THREE.Raycaster, camera: THREE.Camera, pickable: readonly THREE.Object3D[]): (pointMm: readonly [number, number, number], bodyId: string) => boolean {
  const ndc = new THREE.Vector3();
  const world = new THREE.Vector3();
  const ndc2 = new THREE.Vector2();
  return (pointMm) => {
    if (pickable.length === 0) return true;
    world.set(pointMm[0] / 1000, pointMm[1] / 1000, pointMm[2] / 1000);
    ndc.copy(world).project(camera);
    ndc2.set(ndc.x, ndc.y);
    raycaster.setFromCamera(ndc2, camera);
    const along = world.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
    const first = raycaster.intersectObjects(pickable as THREE.Object3D[], false)[0];
    if (first === undefined) return true;
    return first.distance >= along - Math.max(2e-5, along * 0.002);
  };
}
