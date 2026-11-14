import * as THREE from "three";
import type { Mm3 } from "./handle-drag.js";

/**
 * The drawing half of live feature preview: a translucent ghost of the result a command would make, and the arrow a user drags to
 * change the command's main value. The adapter owns the pointer logic; this file only builds and lays out the three.js objects.
 * Both are display aids: they are never pickable and never part of an export.
 */

/** The result of a command's current inputs, as the mesh the command would leave behind. */
export interface ViewportGhost {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** When the ghost is the changed solid itself (a fillet, a shell), the body it stands in for: that body is hidden while the ghost shows. */
  readonly replacesBodyId?: string;
  /** True while the ghost shows an older input set (the newest one could not be built); it is drawn greyed so it is not taken for the result. */
  readonly stale?: boolean;
}

/** The arrow: it starts at `anchorMm`, points along `directionMm` and ends in a knob `tipDistanceMm` away. */
export interface ViewportHandle {
  readonly anchorMm: Mm3;
  readonly directionMm: Mm3;
  readonly tipDistanceMm: number;
  readonly onDrag: (event: ViewportHandleDrag) => void;
}

/** What a drag reports: `deltaMm` is how far the knob travelled along the arrow since the press (negative = back towards the anchor). */
export interface ViewportHandleDrag {
  readonly phase: "start" | "move" | "end" | "cancel";
  readonly deltaMm: number;
  readonly shiftKey: boolean;
}

const GHOST_TINT = "#59c3ff";
const GHOST_STALE_TINT = "#a9a28f";
const HANDLE_COLOR = "#ffd166";
const HANDLE_HOT_COLOR = "#ffffff";

/** The ghost: a translucent copy of the result with its sharp edges drawn, in the scene's metre units. */
export function buildGhostGroup(ghost: ViewportGhost): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(ghost.positionsMm, (value) => value / 1000), 3));
  geometry.setIndex(Array.from(ghost.indices));
  geometry.computeVertexNormals();
  const tint = ghost.stale === true ? GHOST_STALE_TINT : GHOST_TINT;
  const surface = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: tint, roughness: 0.55, metalness: 0.05, transparent: true, opacity: ghost.stale === true ? 0.28 : 0.55,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  }));
  surface.renderOrder = 12;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), new THREE.LineBasicMaterial({ color: ghost.stale === true ? "#c9c3b0" : "#d8f2ff", transparent: true, opacity: 0.9, depthTest: false }));
  edges.renderOrder = 13;
  for (const part of [surface, edges]) part.userData["ps3dExchangeHelper"] = true;
  group.add(surface, edges);
  group.userData["ps3dExchangeHelper"] = true;
  return group;
}

/** The arrow's parts in unit space (along +Y, length 1); `layoutHandleGroup` scales and places them. */
export function buildHandleGroup(): THREE.Group {
  const group = new THREE.Group();
  const material = (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, false), material());
  const head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 14, 1, false), material());
  const knob = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), material());
  shaft.name = "shaft"; head.name = "head"; knob.name = "knob";
  for (const part of [shaft, head, knob]) { part.renderOrder = 22; part.userData["ps3dExchangeHelper"] = true; }
  group.add(shaft, head, knob);
  group.userData["ps3dExchangeHelper"] = true;
  return group;
}

/**
 * Places the arrow in the scene. `unitScale` is the size of "one screen-sized step" in scene units (the orbit radius times a small
 * factor), so the arrow keeps about the same picture size at every zoom; `hot` brightens it while it is hovered or dragged.
 */
export function layoutHandleGroup(group: THREE.Group, handle: Pick<ViewportHandle, "anchorMm" | "directionMm" | "tipDistanceMm">, unitScale: number, hot: boolean): void {
  const direction = new THREE.Vector3(handle.directionMm[0], handle.directionMm[1], handle.directionMm[2]);
  if (direction.lengthSq() < 1e-18) { group.visible = false; return; }
  group.visible = true;
  direction.normalize();
  const anchor = new THREE.Vector3(handle.anchorMm[0] / 1000, handle.anchorMm[1] / 1000, handle.anchorMm[2] / 1000);
  const tipLength = Math.max(handle.tipDistanceMm / 1000, 0);
  const headLength = unitScale * 7;
  const shaftLength = Math.max(tipLength - headLength * 0.5, unitScale * 0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const place = (part: THREE.Object3D | undefined, centerAlong: number, scale: readonly [number, number, number]): void => {
    if (part === undefined) return;
    part.quaternion.copy(quaternion);
    part.position.copy(anchor).addScaledVector(direction, centerAlong);
    part.scale.set(scale[0], scale[1], scale[2]);
  };
  place(group.getObjectByName("shaft"), shaftLength / 2, [unitScale * 0.6, shaftLength, unitScale * 0.6]);
  place(group.getObjectByName("head"), Math.max(tipLength - headLength / 2, headLength / 2), [unitScale * 3.4, headLength, unitScale * 3.4]);
  place(group.getObjectByName("knob"), tipLength + unitScale * 3, [unitScale * 3.4, unitScale * 3.4, unitScale * 3.4]);
  for (const part of group.children) {
    const material = (part as THREE.Mesh).material;
    if (material instanceof THREE.MeshBasicMaterial) material.color.set(hot ? HANDLE_HOT_COLOR : HANDLE_COLOR);
  }
}

/** Frees the geometry and materials of a ghost or handle group the adapter is done with. */
export function disposePreviewGroup(group: THREE.Group): void {
  group.traverse((entry) => {
    const holder = entry as THREE.Mesh;
    holder.geometry?.dispose();
    const material = holder.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}
