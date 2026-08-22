import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cloneExchangeObject, disposeExchangeObject, inspectExchangeObject, type ExchangeBounds, type ViewportJpeg } from "../../exchange-3d/src/index.js";
import type { ModelSuccessResponse } from "../../worker-protocol/src/index.js";
import type { PreviewBounds, PreviewPrimitive, PreviewScene } from "../../workbench-geometry/src/index.js";

export interface ViewportOptions {
  readonly onSelectBody: (bodyId: string | null) => void;
  readonly onViewChange?: (state: ViewportViewState) => void;
  readonly onMeasurePoint?: (point: ViewportMeasurePoint) => void;
}

export type ViewOrientation = "custom" | "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric";
export type ViewProjection = "perspective" | "orthographic";
export type NavigationMode = "select" | "orbit" | "pan" | "measure";
export type SelectionFilter = "auto" | "body" | "component";

export interface ViewportViewState {
  readonly orientation: ViewOrientation;
  readonly projection: ViewProjection;
  readonly navigationMode: NavigationMode;
  readonly selectionFilter: SelectionFilter;
  readonly gridVisible: boolean;
  readonly axesVisible: boolean;
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
}

export interface ViewportMeasurePoint {
  readonly pointMm: readonly [number, number, number];
  readonly semanticId: string | null;
}

export class ThreeViewportAdapter {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(38, 1, 0.001, 100);
  readonly #orthographicCamera = new THREE.OrthographicCamera(-0.1, 0.1, 0.1, -0.1, 0.001, 100);
  readonly #bodyGroup = new THREE.Group();
  readonly #measurementGroup = new THREE.Group();
  readonly #grid = new THREE.GridHelper(0.24, 24, "#2a73ad", "#18365b");
  readonly #axes = new THREE.AxesHelper(0.035);
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #target = new THREE.Vector3();
  readonly #resizeObserver: ResizeObserver;
  readonly #options: ViewportOptions;
  readonly #objects: THREE.Object3D[] = [];
  readonly #pickable: THREE.Object3D[] = [];
  #bodyId: string | undefined;
  #selectedId: string | undefined;
  #azimuth = Math.PI / 4;
  #elevation = Math.PI / 5;
  #radius = 0.16;
  #orientation: ViewOrientation = "isometric";
  #projection: ViewProjection = "perspective";
  #navigationMode: NavigationMode = "select";
  #selectionFilter: SelectionFilter = "auto";
  #drag: { x: number; y: number; startX: number; startY: number; moved: boolean; mode: NavigationMode } | undefined;
  #frame = 0;

  constructor(canvas: HTMLCanvasElement, options: ViewportOptions) {
    this.#canvas = canvas;
    this.#options = options;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.05;
    this.#scene.background = new THREE.Color("#091426");
    this.#scene.fog = new THREE.Fog("#091426", 0.28, 0.75);

    this.#grid.rotation.x = Math.PI / 2;
    this.#grid.position.z = -0.0052;
    this.#scene.add(this.#grid);
    this.#scene.add(this.#axes);
    this.#scene.add(this.#bodyGroup);
    this.#scene.add(this.#measurementGroup);
    this.#scene.add(new THREE.HemisphereLight("#d9efff", "#0b1930", 2.1));
    const key = new THREE.DirectionalLight("#eef8ff", 4.4);
    key.position.set(0.12, -0.08, 0.2);
    this.#scene.add(key);
    const rim = new THREE.DirectionalLight("#35d8f5", 2.2);
    rim.position.set(-0.1, 0.12, 0.08);
    this.#scene.add(rim);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("pointercancel", this.#onPointerUp);
    canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.#preventContext);
    this.fit();
    this.#animate();
  }

  getViewState(): ViewportViewState {
    return {
      orientation: this.#orientation,
      projection: this.#projection,
      navigationMode: this.#navigationMode,
      selectionFilter: this.#selectionFilter,
      gridVisible: this.#grid.visible,
      axesVisible: this.#axes.visible,
      azimuthDeg: Math.round(THREE.MathUtils.radToDeg(this.#azimuth) * 10) / 10,
      elevationDeg: Math.round(THREE.MathUtils.radToDeg(this.#elevation) * 10) / 10
    };
  }

  setOrientation(orientation: Exclude<ViewOrientation, "custom">): void {
    const orientations: Record<Exclude<ViewOrientation, "custom">, readonly [number, number]> = {
      front: [-Math.PI / 2, 0],
      back: [Math.PI / 2, 0],
      left: [Math.PI, 0],
      right: [0, 0],
      top: [-Math.PI / 2, Math.PI / 2 - 0.0001],
      bottom: [-Math.PI / 2, -Math.PI / 2 + 0.0001],
      isometric: [Math.PI / 4, Math.asin(1 / Math.sqrt(3))]
    };
    [this.#azimuth, this.#elevation] = orientations[orientation];
    this.#orientation = orientation;
    this.#updateCamera();
  }

  setProjection(projection: ViewProjection): void {
    this.#projection = projection;
    this.#updateCamera();
  }

  setNavigationMode(mode: NavigationMode): void {
    this.#navigationMode = mode;
    this.#canvas.style.cursor = mode === "orbit" ? "grab" : mode === "pan" ? "move" : mode === "measure" ? "crosshair" : "default";
    this.#emitViewState();
  }

  setSelectionFilter(filter: SelectionFilter): void {
    this.#selectionFilter = filter;
    this.#emitViewState();
  }

  setGridVisible(visible: boolean): void {
    this.#grid.visible = visible;
    this.#emitViewState();
  }

  setAxesVisible(visible: boolean): void {
    this.#axes.visible = visible;
    this.#emitViewState();
  }

  setMeasurePoints(pointsMm: readonly (readonly [number, number, number])[]): void {
    this.#clearMeasurements();
    const markerRadius = THREE.MathUtils.clamp(this.#radius * 0.018, 0.001, 0.004);
    for (const point of pointsMm) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 18, 12),
        new THREE.MeshBasicMaterial({ color: "#ffd166", depthTest: false })
      );
      marker.position.set(point[0] / 1000, point[1] / 1000, point[2] / 1000);
      marker.renderOrder = 20;
      this.#measurementGroup.add(marker);
    }
    if (pointsMm.length === 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(pointsMm.map((point) => new THREE.Vector3(point[0] / 1000, point[1] / 1000, point[2] / 1000)));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: "#ffd166", dashSize: 0.004, gapSize: 0.002, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 19;
      this.#measurementGroup.add(line);
    }
  }

  setArtifact(render: ModelSuccessResponse["render"]): void {
    this.#clearBody();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(render.positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(render.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: "#238fd4",
      roughness: 0.58,
      metalness: 0.08,
      emissive: "#06182d",
      side: THREE.FrontSide
    });
    const body = new THREE.Mesh(geometry, material);
    body.userData["semanticId"] = render.bodyId;
    body.userData["selectionKind"] = "body";
    body.userData["baseColor"] = "#238fd4";
    this.#addObject(body, true);
    const edgeGeometry = new THREE.EdgesGeometry(geometry, 28);
    const edgeDisplay = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: "#bfeaff", transparent: true, opacity: 0.55 }));
    edgeDisplay.userData["ps3dExchangeHelper"] = true;
    this.#addObject(edgeDisplay, false);
    this.#bodyId = render.bodyId;
  }

  setScene(scene: PreviewScene): void {
    this.#clearBody();
    for (const primitive of scene.primitives) this.#addPrimitive(primitive);
    this.#bodyId = undefined;
    this.fitPreview(scene.boundsMm);
  }

  setExternalObject(source: THREE.Object3D): void {
    this.#clearBody();
    const root = cloneExchangeObject(source);
    let ordinal = 0;
    root.traverse((entry) => {
      if (entry instanceof THREE.Camera || entry instanceof THREE.Light) entry.visible = false;
      if (!(entry instanceof THREE.Mesh || entry instanceof THREE.Points || entry instanceof THREE.Line)) return;
      const id = typeof entry.userData["semanticId"] === "string" ? entry.userData["semanticId"] as string : `import:object-${ordinal}`;
      entry.userData["semanticId"] = id;
      entry.userData["selectionKind"] = "body";
      if (entry instanceof THREE.Mesh && entry.material instanceof THREE.MeshStandardMaterial) entry.userData["baseColor"] = `#${entry.material.color.getHexString()}`;
      this.#pickable.push(entry);
      ordinal += 1;
    });
    this.#bodyGroup.add(root);
    this.#objects.push(root);
    this.#bodyId = undefined;
    this.fitExchange(inspectExchangeObject(root).bounds);
  }

  snapshotExchangeObject(): THREE.Object3D {
    const snapshot = cloneExchangeObject(this.#bodyGroup);
    const helpers: THREE.Object3D[] = [];
    snapshot.traverse((entry) => { if (entry.userData["ps3dExchangeHelper"] === true) helpers.push(entry); });
    for (const helper of helpers) { helper.parent?.remove(helper); disposeExchangeObject(helper); }
    return snapshot;
  }

  async capturePreviewJpeg(quality = 0.9): Promise<ViewportJpeg> {
    this.#renderer.render(this.#scene, this.#activeCamera());
    const dataUrl = this.#canvas.toDataURL("image/jpeg", THREE.MathUtils.clamp(quality, 0.5, 1));
    const encoded = dataUrl.split(",", 2)[1];
    if (encoded === undefined) throw new Error("The viewport preview could not be encoded as JPEG.");
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, width: this.#canvas.width, height: this.#canvas.height };
  }

  fit(bounds?: ModelSuccessResponse["render"]["measurements"]["boundsMeters"]): void {
    if (bounds !== undefined) {
      this.#target.set(
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2
      );
      this.#radius = Math.max(...bounds.size) * 2.8;
    }
    this.#updateCamera();
  }

  fitPreview(bounds: PreviewBounds): void {
    this.#target.set(
      (bounds.min[0] + bounds.max[0]) / 2 / 1000,
      (bounds.min[1] + bounds.max[1]) / 2 / 1000,
      (bounds.min[2] + bounds.max[2]) / 2 / 1000
    );
    this.#radius = Math.max(...bounds.size) / 1000 * 2.8;
    this.#updateCamera();
  }

  fitExchange(bounds: ExchangeBounds): void {
    this.#target.set(...bounds.centerMeters);
    this.#radius = Math.max(Math.max(...bounds.sizeMeters) * 2.8, 0.015);
    this.#updateCamera();
  }

  fitCurrent(): void {
    this.fitExchange(inspectExchangeObject(this.#bodyGroup).bounds);
  }

  setSelected(selected: boolean): void {
    this.setSelectedId(selected ? this.#bodyId ?? null : null);
  }

  setSelectedId(id: string | null): void {
    this.#selectedId = id ?? undefined;
    for (const object of this.#pickable) {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) continue;
      const selected = object.userData["semanticId"] === id;
      const baseColor = object.userData["baseColor"] as string | undefined;
      object.material.color.set(selected ? "#55e2f1" : baseColor ?? "#238fd4");
      object.material.emissive.set(selected ? "#173f5c" : "#06182d");
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#resizeObserver.disconnect();
    this.#canvas.removeEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.removeEventListener("pointermove", this.#onPointerMove);
    this.#canvas.removeEventListener("pointerup", this.#onPointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#onPointerUp);
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas.removeEventListener("contextmenu", this.#preventContext);
    this.#clearBody();
    this.#clearMeasurements();
    this.#grid.geometry.dispose();
    if (Array.isArray(this.#grid.material)) this.#grid.material.forEach((material) => material.dispose());
    else this.#grid.material.dispose();
    this.#axes.geometry.dispose();
    if (Array.isArray(this.#axes.material)) this.#axes.material.forEach((material) => material.dispose());
    else this.#axes.material.dispose();
    this.#renderer.dispose();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#canvas.setPointerCapture(event.pointerId);
    const mode: NavigationMode = event.button === 1
      ? event.shiftKey ? "orbit" : "pan"
      : event.button === 2 ? "orbit" : this.#navigationMode;
    this.#drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, mode };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#drag === undefined) return;
    const dx = event.clientX - this.#drag.x;
    const dy = event.clientY - this.#drag.y;
    if (Math.hypot(event.clientX - this.#drag.startX, event.clientY - this.#drag.startY) > 3) this.#drag.moved = true;
    this.#drag.x = event.clientX;
    this.#drag.y = event.clientY;
    if (this.#drag.mode === "orbit") {
      this.#azimuth -= dx * 0.008;
      this.#elevation = THREE.MathUtils.clamp(this.#elevation + dy * 0.008, -1.52, 1.52);
      this.#orientation = "custom";
    } else if (this.#drag.mode === "pan") {
      const scale = this.#radius / Math.max(this.#canvas.clientHeight, 1);
      const activeCamera = this.#activeCamera();
      const right = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 1);
      this.#target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    }
    if (this.#drag.mode === "orbit" || this.#drag.mode === "pan") this.#updateCamera();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (this.#drag !== undefined && !this.#drag.moved) {
      if (this.#drag.mode === "select") this.#pick(event);
      if (this.#drag.mode === "measure") this.#measurePick(event);
    }
    this.#drag = undefined;
    if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#radius = THREE.MathUtils.clamp(this.#radius * Math.exp(event.deltaY * 0.001), 0.0001, 10_000);
    this.#updateCamera();
  };

  readonly #preventContext = (event: Event): void => event.preventDefault();

  #pick(event: PointerEvent): void {
    if (this.#pickable.length === 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#activeCamera());
    const hit = this.#raycaster.intersectObjects(this.#pickable, false).find((entry) => this.#selectionAllows(entry.object))?.object;
    const id = typeof hit?.userData["semanticId"] === "string" ? hit.userData["semanticId"] as string : null;
    const next = id === this.#selectedId ? null : id;
    this.setSelectedId(next);
    this.#options.onSelectBody(next);
  }

  #measurePick(event: PointerEvent): void {
    if (this.#pickable.length === 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#activeCamera());
    const hit = this.#raycaster.intersectObjects(this.#pickable, false).find((entry) => this.#selectionAllows(entry.object));
    if (hit === undefined) return;
    const semanticId = typeof hit.object.userData["semanticId"] === "string" ? hit.object.userData["semanticId"] as string : null;
    this.#options.onMeasurePoint?.({ pointMm: [hit.point.x * 1000, hit.point.y * 1000, hit.point.z * 1000], semanticId });
  }

  #selectionAllows(object: THREE.Object3D): boolean {
    if (this.#selectionFilter === "auto") return true;
    return object.userData["selectionKind"] === this.#selectionFilter;
  }

  #updateCamera(): void {
    const horizontal = this.#radius * Math.cos(this.#elevation);
    const position = new THREE.Vector3(
      this.#target.x + horizontal * Math.cos(this.#azimuth),
      this.#target.y + horizontal * Math.sin(this.#azimuth),
      this.#target.z + this.#radius * Math.sin(this.#elevation)
    );
    const verticalView = Math.abs(Math.cos(this.#elevation)) < 0.01;
    for (const camera of [this.#camera, this.#orthographicCamera]) {
      camera.position.copy(position);
      camera.up.set(0, verticalView ? 1 : 0, verticalView ? 0 : 1);
      camera.lookAt(this.#target);
    }
    if (this.#scene.fog instanceof THREE.Fog) {
      this.#scene.fog.near = Math.max(this.#radius * 0.72, 0.002);
      this.#scene.fog.far = Math.max(this.#radius * 5, 0.75);
    }
    this.#updateProjection();
    this.#emitViewState();
  }

  #resize(): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#updateProjection();
  }

  #animate = (): void => {
    this.#renderer.render(this.#scene, this.#activeCamera());
    this.#frame = requestAnimationFrame(this.#animate);
  };

  #clearBody(): void {
    for (const object of this.#objects) {
      this.#bodyGroup.remove(object);
      disposeExchangeObject(object);
    }
    this.#objects.length = 0;
    this.#pickable.length = 0;
    this.#selectedId = undefined;
  }

  #clearMeasurements(): void {
    for (const object of [...this.#measurementGroup.children]) {
      this.#measurementGroup.remove(object);
      if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) object.geometry.dispose();
      if ("material" in object) {
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      }
    }
  }

  #activeCamera(): THREE.Camera {
    return this.#projection === "orthographic" ? this.#orthographicCamera : this.#camera;
  }

  #updateProjection(): void {
    const aspect = Math.max(this.#canvas.clientWidth, 1) / Math.max(this.#canvas.clientHeight, 1);
    const halfHeight = Math.max(this.#radius * Math.tan(THREE.MathUtils.degToRad(this.#camera.fov / 2)), 0.004);
    this.#orthographicCamera.left = -halfHeight * aspect;
    this.#orthographicCamera.right = halfHeight * aspect;
    this.#orthographicCamera.top = halfHeight;
    this.#orthographicCamera.bottom = -halfHeight;
    const near = Math.max(this.#radius / 10_000, 0.00001);
    const far = Math.max(this.#radius * 25, 10);
    this.#camera.near = near;
    this.#camera.far = far;
    this.#orthographicCamera.near = near;
    this.#orthographicCamera.far = far;
    this.#camera.updateProjectionMatrix();
    this.#orthographicCamera.updateProjectionMatrix();
  }

  #emitViewState(): void {
    this.#options.onViewChange?.(this.getViewState());
  }

  #addObject(object: THREE.Object3D, pickable: boolean): void {
    this.#bodyGroup.add(object);
    this.#objects.push(object);
    if (pickable) this.#pickable.push(object);
  }

  #addPrimitive(primitive: PreviewPrimitive): void {
    if (primitive.kind === "line") {
      const points: THREE.Vector3[] = [];
      for (let index = 0; index < primitive.pointsMm.length; index += 3) {
        points.push(new THREE.Vector3(primitive.pointsMm[index]! / 1000, primitive.pointsMm[index + 1]! / 1000, primitive.pointsMm[index + 2]! / 1000));
      }
      if (!primitive.dashed && primitive.radiusMm !== undefined && points.length > 1) {
        const segmentValues: number[] = primitive.segmentsMm === undefined ? [] : [...primitive.segmentsMm];
        if (primitive.segmentsMm === undefined) {
          for (let index = 3; index < primitive.pointsMm.length; index += 3) {
            segmentValues.push(
              primitive.pointsMm[index - 3]!, primitive.pointsMm[index - 2]!, primitive.pointsMm[index - 1]!,
              primitive.pointsMm[index]!, primitive.pointsMm[index + 1]!, primitive.pointsMm[index + 2]!
            );
          }
        }
        const segmentGeometries: THREE.BufferGeometry[] = [];
        const up = new THREE.Vector3(0, 1, 0);
        for (let index = 0; index < segmentValues.length; index += 6) {
          const from = new THREE.Vector3(segmentValues[index]! / 1000, segmentValues[index + 1]! / 1000, segmentValues[index + 2]! / 1000);
          const to = new THREE.Vector3(segmentValues[index + 3]! / 1000, segmentValues[index + 4]! / 1000, segmentValues[index + 5]! / 1000);
          const direction = new THREE.Vector3().subVectors(to, from);
          const length = direction.length();
          if (length <= 1e-8) continue;
          const segmentGeometry = new THREE.CylinderGeometry(primitive.radiusMm / 1000, primitive.radiusMm / 1000, length, 8, 1, false);
          segmentGeometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
          const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
          segmentGeometry.translate(midpoint.x, midpoint.y, midpoint.z);
          segmentGeometries.push(segmentGeometry);
        }
        const geometry = segmentGeometries.length > 0 ? mergeGeometries(segmentGeometries, false) : null;
        for (const segmentGeometry of segmentGeometries) segmentGeometry.dispose();
        if (geometry !== null) {
          const material = new THREE.MeshStandardMaterial({
            color: primitive.color,
            roughness: 0.5,
            metalness: 0,
            transparent: primitive.opacity < 1,
            opacity: primitive.opacity
          });
          const tube = new THREE.Mesh(geometry, material);
          tube.userData["ps3dConductorVisualization"] = true;
          this.#addObject(tube, false);
          return;
        }
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = primitive.dashed
        ? new THREE.LineDashedMaterial({ color: primitive.color, transparent: true, opacity: primitive.opacity, dashSize: 0.004, gapSize: 0.002 })
        : new THREE.LineBasicMaterial({ color: primitive.color, transparent: true, opacity: primitive.opacity });
      const line = new THREE.Line(geometry, material);
      if (material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
      this.#addObject(line, false);
      return;
    }
    let geometry: THREE.BufferGeometry;
    if (primitive.kind === "box") {
      geometry = new THREE.BoxGeometry(primitive.sizeMm[0] / 1000, primitive.sizeMm[1] / 1000, primitive.sizeMm[2] / 1000);
    } else if (primitive.kind === "cylinder") {
      geometry = new THREE.CylinderGeometry(primitive.radiusMm / 1000, primitive.radiusMm / 1000, primitive.heightMm / 1000, primitive.radialSegments);
      geometry.rotateX(Math.PI / 2);
    } else {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(primitive.positionsMm, (value) => value / 1000), 3));
      geometry.setIndex(Array.from(primitive.indices));
      geometry.computeVertexNormals();
    }
    const material = new THREE.MeshStandardMaterial({
      color: primitive.color,
      roughness: 0.52,
      metalness: 0.08,
      emissive: "#06182d",
      transparent: primitive.opacity < 1,
      opacity: primitive.opacity,
      side: primitive.kind === "mesh" && primitive.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wireframe: primitive.kind === "mesh" && primitive.wireframe
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData["semanticId"] = primitive.id;
    mesh.userData["selectionKind"] = primitive.id.startsWith("component:") ? "component" : "body";
    mesh.userData["baseColor"] = primitive.color;
    if (primitive.kind === "box" || primitive.kind === "cylinder") {
      mesh.position.set(primitive.positionMm[0] / 1000, primitive.positionMm[1] / 1000, primitive.positionMm[2] / 1000);
      const [x, y, z] = primitive.rotationDeg.map((value) => value * Math.PI / 180) as [number, number, number];
      mesh.rotation.set(x, y, z, primitive.rotationOrder ?? "XYZ");
    }
    this.#addObject(mesh, primitive.selectable);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: "#c7eff5", transparent: true, opacity: 0.42 }));
    edges.userData["ps3dExchangeHelper"] = true;
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    this.#addObject(edges, false);
  }
}
