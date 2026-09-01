import {
  ELECTROMECHANICAL_CATALOG,
  WORKBENCH_LIMITS,
  electromechanicalTerminalWorldPoint,
  type AssemblyIntent,
  type ComponentInstance,
  type Vec3
} from "../../workbench-core/src/index.js";
import type { InterferenceCandidate, PreviewBounds, PreviewPrimitive, PreviewScene } from "./types.js";

export function buildAssemblyPreview(assembly: AssemblyIntent): PreviewScene {
  const componentPrimitives = assembly.components.filter((component) => component.visible).map((component) => componentPrimitive(component, assembly.explodeMm));
  const routesStale = assembly.electromechanicalSource?.status === "stale";
  const routePrimitives = (assembly.explodeMm > 0 ? [] : assembly.electricalRoutes ?? []).map((route): PreviewPrimitive => {
    const primitive = {
      id: route.id,
      name: `${route.name} · unsized conductor visualization`,
      color: routesStale ? "#d39a4f" : routeColor(route.class),
      opacity: routesStale ? 0.48 : 0.92,
      selectable: false,
      kind: "line" as const,
      pointsMm: route.pointsMm.flatMap((point) => point),
      segmentsMm: uniqueRouteSegments(route.pointsMm),
      dashed: routesStale
    };
    return routesStale ? primitive : { ...primitive, radiusMm: conductorRadius(route.class) };
  });
  const detailPrimitives = assembly.explodeMm > 0 ? [] : panelDetailPrimitives(assembly);
  const primitives = [...componentPrimitives, ...detailPrimitives, ...routePrimitives];
  const bounds = primitives.flatMap((primitive) => primitiveBounds(primitive));
  return { id: assembly.id, kind: "assembly", primitives, boundsMm: boundsFromPoints(bounds) };
}

/**
 * Returns the shared maximum per-component explosion travel. It is based on
 * the assembled scene so all direct-manipulation inputs remain proportional
 * to the current model instead of using a fixed demo distance.
 */
export function assemblyExplodeLimitMm(assembly: AssemblyIntent, fraction = 0.5): number {
  const assembledScene = buildAssemblyPreview({ ...assembly, explodeMm: 0 });
  const largestDimensionMm = Math.max(0, ...assembledScene.boundsMm.size.filter(Number.isFinite));
  const boundedFraction = Number.isFinite(fraction) ? Math.min(1, Math.max(0.05, fraction)) : 0.5;
  const limitMm = largestDimensionMm * boundedFraction;
  return Math.round(Math.min(WORKBENCH_LIMITS.maxCoordinateMm, Math.max(1, limitMm)) * 10) / 10;
}

function uniqueRouteSegments(points: readonly Vec3[]): readonly number[] {
  const seen = new Set<string>();
  const segments: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!;
    const right = points[index]!;
    if (left[0] === right[0] && left[1] === right[1] && left[2] === right[2]) continue;
    const leftKey = left.join(",");
    const rightKey = right.join(",");
    const start = leftKey.localeCompare(rightKey) <= 0 ? left : right;
    const end = start === left ? right : left;
    const key = `${start.join(",")}|${end.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(...start, ...end);
  }
  return segments;
}

function conductorRadius(netClass: NonNullable<AssemblyIntent["electricalRoutes"]>[number]["class"]): number {
  if (netClass === "power-dc" || netClass === "power-ac") return 6;
  if (netClass === "ground") return 5;
  return 3.5;
}

function panelDetailPrimitives(assembly: AssemblyIntent): readonly PreviewPrimitive[] {
  if (assembly.template !== "electrical-panel" || assembly.electromechanicalSource?.status !== "current") return [];
  const byComponent = new Map(assembly.components.map((component) => [component.id, component]));
  const byCatalog = new Map(ELECTROMECHANICAL_CATALOG.map((item) => [item.id, item]));
  const terminalDetails: PreviewPrimitive[] = [];
  const deviceDetails: PreviewPrimitive[] = [];
  const decorationDetails: PreviewPrimitive[] = [];
  const push = (primitive: PreviewPrimitive): void => {
    if (primitive.id.startsWith("detail:panel-terminal:")) terminalDetails.push(primitive);
    else if (primitive.id.startsWith("detail:panel-face:")
      || primitive.id.startsWith("detail:panel-control:")
      || primitive.id.startsWith("detail:panel-window:")) deviceDetails.push(primitive);
    else decorationDetails.push(primitive);
  };
  for (const body of [...assembly.components].sort((left, right) => left.id.localeCompare(right.id))) {
    const topZ = body.translationMm[2] + body.sizeMm[2] / 2;
    if (body.id.includes("wire-duct-h-")) {
      for (let index = 0; index < 9; index += 1) {
        push({
          id: `detail:duct-slot:${body.id}:${index + 1}`,
          name: `${body.name} slot ${index + 1}`,
          color: "#6f7f8b",
          opacity: 0.72,
          selectable: false,
          kind: "box",
          positionMm: [body.translationMm[0] + (index - 4) * body.sizeMm[0] / 10, body.translationMm[1], topZ + 1],
          rotationDeg: body.rotationDeg,
          sizeMm: [6, body.sizeMm[1] - 12, 2]
        });
      }
    } else if (body.id.includes("wire-duct-v-")) {
      for (let index = 0; index < 7; index += 1) {
        push({
          id: `detail:duct-slot:${body.id}:${index + 1}`,
          name: `${body.name} slot ${index + 1}`,
          color: "#6f7f8b",
          opacity: 0.72,
          selectable: false,
          kind: "box",
          positionMm: [body.translationMm[0], body.translationMm[1] + (index - 3) * body.sizeMm[1] / 8, topZ + 1],
          rotationDeg: body.rotationDeg,
          sizeMm: [body.sizeMm[0] - 12, 6, 2]
        });
      }
    } else if (body.id.includes("din-rail-")) {
      for (const side of [-1, 1] as const) {
        push({
          id: `detail:rail-flange:${body.id}:${side < 0 ? "a" : "b"}`,
          name: `${body.name} formed flange`,
          color: "#5f6c75",
          opacity: 0.9,
          selectable: false,
          kind: "box",
          positionMm: [body.translationMm[0], body.translationMm[1] + side * 8, topZ + 1.5],
          rotationDeg: body.rotationDeg,
          sizeMm: [body.sizeMm[0], 4, 3]
        });
      }
    } else if (body.id === "component:em-protective-earth-bar") {
      for (let index = 0; index < 8; index += 1) {
        push({
          id: `detail:pe-screw:${index + 1}`,
          name: `Protective-earth bar screw ${index + 1}`,
          color: "#e9edf0",
          opacity: 1,
          selectable: false,
          kind: "cylinder",
          positionMm: [body.translationMm[0] + (index - 3.5) * 100, body.translationMm[1], topZ + 3],
          rotationDeg: body.rotationDeg,
          radiusMm: 5,
          heightMm: 5,
          radialSegments: 20
        });
      }
    }
  }
  for (const link of [...(assembly.electricalLinks ?? [])].sort((left, right) => left.assemblyComponentId.localeCompare(right.assemblyComponentId))) {
    const body = byComponent.get(link.assemblyComponentId);
    const catalog = byCatalog.get(link.catalogPartId);
    if (body === undefined || catalog === undefined || !body.visible) continue;
    const topZ = body.translationMm[2] + body.sizeMm[2] / 2;
    push({
      id: `detail:panel-face:${body.id}`,
      name: `${link.electricalReference} molded face`,
      color: "#162331",
      opacity: 0.82,
      selectable: false,
      kind: "box",
      positionMm: [body.translationMm[0], body.translationMm[1], topZ + 1.5],
      rotationDeg: body.rotationDeg,
      sizeMm: [Math.max(12, body.sizeMm[0] - 8), Math.max(12, body.sizeMm[1] - 8), 3]
    });
    const controlKind = catalog.kind === "breaker" || catalog.kind === "disconnect" || catalog.kind === "contactor" || catalog.kind === "fuse";
    if (controlKind) {
      push({
        id: `detail:panel-control:${body.id}`,
        name: `${link.electricalReference} operator`,
        color: catalog.kind === "disconnect" ? "#f3a33c" : catalog.kind === "breaker" ? "#e9eef2" : "#52bfd4",
        opacity: 1,
        selectable: false,
        kind: "cylinder",
        positionMm: [body.translationMm[0], body.translationMm[1], topZ + 6],
        rotationDeg: body.rotationDeg,
        radiusMm: Math.min(14, body.sizeMm[0] * 0.18),
        heightMm: 9,
        radialSegments: 24
      });
    } else if (catalog.kind !== "ground" && catalog.kind !== "terminal") {
      push({
        id: `detail:panel-window:${body.id}`,
        name: `${link.electricalReference} status window`,
        color: "#5ee0d2",
        opacity: 0.9,
        selectable: false,
        kind: "box",
        positionMm: [body.translationMm[0], body.translationMm[1], topZ + 4],
        rotationDeg: body.rotationDeg,
        sizeMm: [Math.min(42, body.sizeMm[0] * 0.42), Math.min(20, body.sizeMm[1] * 0.28), 6]
      });
    }
    for (const terminal of catalog.terminals) {
      const world = electromechanicalTerminalWorldPoint(body, catalog, terminal.name);
      if (world === undefined) continue;
      push({
        id: `detail:panel-terminal:${body.id}:${terminal.name}`,
        name: `${link.electricalReference}.${terminal.name} terminal stud`,
        color: terminal.role === "protective-earth" ? "#58cf83" : "#d8b466",
        opacity: 1,
        selectable: false,
        kind: "cylinder",
        positionMm: world,
        rotationDeg: body.rotationDeg,
        radiusMm: 4.5,
        heightMm: 8,
        radialSegments: 20
      });
    }
  }
  return [...terminalDetails, ...deviceDetails, ...decorationDetails].slice(0, 96);
}

function routeColor(netClass: NonNullable<AssemblyIntent["electricalRoutes"]>[number]["class"]): string {
  if (netClass === "power-dc") return "#f26363";
  if (netClass === "power-ac") return "#55a7ef";
  if (netClass === "ground") return "#4fd28f";
  return "#b58cff";
}

export function findAssemblyInterference(assembly: AssemblyIntent): readonly InterferenceCandidate[] {
  const boxes = assembly.components.filter((component) => component.visible).map((component) => {
    const center = explodedPosition(component, assembly.explodeMm);
    const half = componentHalfExtents(component);
    return {
      id: component.id,
      masterCartInstanceId: component.masterCart?.instanceId,
      min: half.map((size, axis) => center[axis]! - size) as unknown as Vec3,
      max: half.map((size, axis) => center[axis]! + size) as unknown as Vec3
    };
  });
  const candidates: InterferenceCandidate[] = [];
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      if (isPlanningFrameComponent(a.id) && isPlanningFrameComponent(b.id)) continue;
      if (a.masterCartInstanceId !== undefined && a.masterCartInstanceId === b.masterCartInstanceId) continue;
      const overlap: Vec3 = [
        Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0])),
        Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1])),
        Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]))
      ];
      const volume = overlap[0] * overlap[1] * overlap[2];
      if (volume > 1e-6) candidates.push({ componentIds: [a.id, b.id], overlapMm: overlap, volumeCubicMm: volume, conservative: true });
    }
  }
  return candidates.sort((left, right) => left.componentIds.join(":").localeCompare(right.componentIds.join(":")));
}

function isPlanningFrameComponent(id: string): boolean {
  return id.startsWith("component:cargo-20ft-") || id.startsWith("component:cargo-40ft-hc-") || id.startsWith("component:bess-20ft-hc-");
}

export function explodedPosition(component: ComponentInstance, explodeMm: number): Vec3 {
  return [
    component.translationMm[0] + component.explosionDirection[0] * explodeMm,
    component.translationMm[1] + component.explosionDirection[1] * explodeMm,
    component.translationMm[2] + component.explosionDirection[2] * explodeMm
  ];
}

function componentPrimitive(component: ComponentInstance, explodeMm: number): PreviewPrimitive {
  const base = { id: component.id, name: component.name, color: component.color, opacity: 1, selectable: true } as const;
  const positionMm = explodedPosition(component, explodeMm);
  if (component.shape === "plate" || component.shape === "box") return { ...base, kind: "box", positionMm, rotationDeg: component.rotationDeg, sizeMm: component.sizeMm };
  if (component.shape === "cone") return { ...base, kind: "cone", positionMm, rotationDeg: component.rotationDeg, baseRadiusMm: component.sizeMm[0] / 2, topRadiusMm: component.sizeMm[1] / 2, heightMm: component.sizeMm[2], radialSegments: 48 };
  if (component.shape === "sphere") return { ...base, kind: "sphere", positionMm, rotationDeg: component.rotationDeg, radiusMm: component.sizeMm[0] / 2, widthSegments: 32, heightSegments: 20 };
  if (component.shape === "ring") return annularPrimitive(component, positionMm, base, 64);
  if (component.shape === "gear") return annularPrimitive(component, positionMm, base, Math.max(12, (component.featureCount ?? 24) * 4), component.featureCount ?? 24);
  if (component.shape === "torus") return torusPrimitive(component, positionMm, base);
  return {
    ...base,
    kind: "cylinder",
    positionMm,
    rotationDeg: component.rotationDeg,
    radiusMm: component.sizeMm[0] / 2,
    heightMm: component.sizeMm[2],
    radialSegments: component.shape === "hex-prism" ? 6 : component.shape === "pin" ? 40 : 32
  };
}

function annularPrimitive(
  component: ComponentInstance,
  positionMm: Vec3,
  base: { readonly id: string; readonly name: string; readonly color: string; readonly opacity: number; readonly selectable: boolean },
  segments: number,
  teeth?: number
): PreviewPrimitive {
  const outerRadius = component.sizeMm[0] / 2;
  const innerRadius = component.sizeMm[1] / 2;
  const half = component.sizeMm[2] / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    const toothPhase = teeth === undefined ? 1 : [0.82, 1, 1, 0.82][index % 4]!;
    const radius = Math.max(innerRadius * 1.06, outerRadius * toothPhase);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (const local of [
      [cosine * radius, sine * radius, half],
      [cosine * innerRadius, sine * innerRadius, half],
      [cosine * radius, sine * radius, -half],
      [cosine * innerRadius, sine * innerRadius, -half]
    ] as const) positions.push(...transformPoint(local, component.rotationDeg, positionMm));
  }
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const a = index * 4;
    const b = next * 4;
    indices.push(
      a, b, a + 1, b, b + 1, a + 1,
      a + 2, a + 3, b + 2, b + 2, a + 3, b + 3,
      a, a + 2, b, b, a + 2, b + 2,
      a + 1, b + 1, a + 3, b + 1, b + 3, a + 3
    );
  }
  return { ...base, kind: "mesh", positionsMm: positions, indices, wireframe: false, doubleSided: true };
}

function torusPrimitive(
  component: ComponentInstance,
  positionMm: Vec3,
  base: { readonly id: string; readonly name: string; readonly color: string; readonly opacity: number; readonly selectable: boolean }
): PreviewPrimitive {
  const tubeRadius = component.sizeMm[1] / 2;
  const majorRadius = Math.max(tubeRadius * 1.1, (component.sizeMm[0] - component.sizeMm[1]) / 2);
  const radialSegments = 48;
  const tubeSegments = 14;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const u = radial / radialSegments * Math.PI * 2;
    for (let tube = 0; tube < tubeSegments; tube += 1) {
      const v = tube / tubeSegments * Math.PI * 2;
      const ringRadius = majorRadius + Math.cos(v) * tubeRadius;
      positions.push(...transformPoint([Math.cos(u) * ringRadius, Math.sin(u) * ringRadius, Math.sin(v) * tubeRadius], component.rotationDeg, positionMm));
    }
  }
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const nextRadial = (radial + 1) % radialSegments;
    for (let tube = 0; tube < tubeSegments; tube += 1) {
      const nextTube = (tube + 1) % tubeSegments;
      const a = radial * tubeSegments + tube;
      const b = nextRadial * tubeSegments + tube;
      const c = nextRadial * tubeSegments + nextTube;
      const d = radial * tubeSegments + nextTube;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { ...base, kind: "mesh", positionsMm: positions, indices, wireframe: false, doubleSided: true };
}

function transformPoint(point: Vec3, rotationDeg: Vec3, translationMm: Vec3): Vec3 {
  const matrix = rotationMatrix(rotationDeg);
  return [
    matrix[0]![0] * point[0] + matrix[0]![1] * point[1] + matrix[0]![2] * point[2] + translationMm[0],
    matrix[1]![0] * point[0] + matrix[1]![1] * point[1] + matrix[1]![2] * point[2] + translationMm[1],
    matrix[2]![0] * point[0] + matrix[2]![1] * point[1] + matrix[2]![2] * point[2] + translationMm[2]
  ];
}

function primitiveBounds(primitive: PreviewPrimitive): readonly Vec3[] {
  if (primitive.kind === "box") {
    const half = rotatedHalfExtents([primitive.sizeMm[0] / 2, primitive.sizeMm[1] / 2, primitive.sizeMm[2] / 2], primitive.rotationDeg);
    return [
      [primitive.positionMm[0] - half[0], primitive.positionMm[1] - half[1], primitive.positionMm[2] - half[2]],
      [primitive.positionMm[0] + half[0], primitive.positionMm[1] + half[1], primitive.positionMm[2] + half[2]]
    ];
  }
  if (primitive.kind === "cylinder") {
    const half = cylinderHalfExtents(primitive.radiusMm, primitive.heightMm / 2, primitive.rotationDeg);
    return [
      [primitive.positionMm[0] - half[0], primitive.positionMm[1] - half[1], primitive.positionMm[2] - half[2]],
      [primitive.positionMm[0] + half[0], primitive.positionMm[1] + half[1], primitive.positionMm[2] + half[2]]
    ];
  }
  if (primitive.kind === "cone") {
    const half = cylinderHalfExtents(Math.max(primitive.baseRadiusMm, primitive.topRadiusMm), primitive.heightMm / 2, primitive.rotationDeg);
    return [
      [primitive.positionMm[0] - half[0], primitive.positionMm[1] - half[1], primitive.positionMm[2] - half[2]],
      [primitive.positionMm[0] + half[0], primitive.positionMm[1] + half[1], primitive.positionMm[2] + half[2]]
    ];
  }
  if (primitive.kind === "sphere") {
    const radius = primitive.radiusMm;
    return [
      [primitive.positionMm[0] - radius, primitive.positionMm[1] - radius, primitive.positionMm[2] - radius],
      [primitive.positionMm[0] + radius, primitive.positionMm[1] + radius, primitive.positionMm[2] + radius]
    ];
  }
  const values = primitive.kind === "mesh" ? primitive.positionsMm : primitive.pointsMm;
  const points: Vec3[] = [];
  for (let index = 0; index < values.length; index += 3) points.push([values[index]!, values[index + 1]!, values[index + 2]!]);
  return points;
}

function componentHalfExtents(component: ComponentInstance): Vec3 {
  if (component.shape === "plate" || component.shape === "box") {
    return rotatedHalfExtents([component.sizeMm[0] / 2, component.sizeMm[1] / 2, component.sizeMm[2] / 2], component.rotationDeg);
  }
  if (component.shape === "sphere") return [component.sizeMm[0] / 2, component.sizeMm[0] / 2, component.sizeMm[0] / 2];
  return cylinderHalfExtents(component.sizeMm[0] / 2, component.sizeMm[2] / 2, component.rotationDeg);
}

function rotatedHalfExtents(localHalf: Vec3, rotationDeg: Vec3): Vec3 {
  const matrix = rotationMatrix(rotationDeg);
  return matrix.map((row) => row.reduce((sum, value, axis) => sum + Math.abs(value) * localHalf[axis]!, 0)) as unknown as Vec3;
}

function cylinderHalfExtents(radius: number, halfHeight: number, rotationDeg: Vec3): Vec3 {
  const matrix = rotationMatrix(rotationDeg);
  return matrix.map((row) => radius * Math.hypot(row[0], row[1]) + halfHeight * Math.abs(row[2])) as unknown as Vec3;
}

/** Three.js-compatible intrinsic XYZ Euler rotation matrix used by the preview renderer. */
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

export function boundsFromPoints(points: readonly Vec3[]): PreviewBounds {
  if (points.length === 0) return { min: [-50, -50, -10], max: [50, 50, 50], size: [100, 100, 60] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
