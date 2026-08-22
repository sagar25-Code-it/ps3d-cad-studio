import {
  ELECTROMECHANICAL_CATALOG,
  electromechanicalTerminalWorldPoint,
  type AssemblyIntent,
  type ComponentInstance,
  type Vec3
} from "../../workbench-core/src/index.js";
import type { InterferenceCandidate, PreviewBounds, PreviewPrimitive, PreviewScene } from "./types.js";

export function buildAssemblyPreview(assembly: AssemblyIntent): PreviewScene {
  const componentPrimitives = assembly.components.filter((component) => component.visible).map((component) => componentPrimitive(component, assembly.explodeMm));
  const routesStale = assembly.electromechanicalSource?.status === "stale";
  const routePrimitives = (assembly.explodeMm > 0 ? [] : assembly.electricalRoutes ?? []).map((route) => ({
    id: route.id,
    name: `${route.name} · unsized conductor visualization`,
    color: routesStale ? "#d39a4f" : routeColor(route.class),
    opacity: routesStale ? 0.48 : 0.92,
    selectable: false,
    kind: "line" as const,
    pointsMm: route.pointsMm.flatMap((point) => point),
    segmentsMm: uniqueRouteSegments(route.pointsMm),
    dashed: routesStale,
    radiusMm: routesStale ? undefined : conductorRadius(route.class)
  }));
  const detailPrimitives = assembly.explodeMm > 0 ? [] : panelDetailPrimitives(assembly);
  const primitives = [...componentPrimitives, ...detailPrimitives, ...routePrimitives];
  const bounds = primitives.flatMap((primitive) => primitiveBounds(primitive));
  return { id: assembly.id, kind: "assembly", primitives, boundsMm: boundsFromPoints(bounds) };
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
  return {
    ...base,
    kind: "cylinder",
    positionMm,
    rotationDeg: component.rotationDeg,
    radiusMm: component.sizeMm[0] / 2,
    heightMm: component.sizeMm[2],
    radialSegments: component.shape === "pin" ? 40 : 32
  };
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
  const values = primitive.kind === "mesh" ? primitive.positionsMm : primitive.pointsMm;
  const points: Vec3[] = [];
  for (let index = 0; index < values.length; index += 3) points.push([values[index]!, values[index + 1]!, values[index + 2]!]);
  return points;
}

function componentHalfExtents(component: ComponentInstance): Vec3 {
  if (component.shape === "plate" || component.shape === "box") {
    return rotatedHalfExtents([component.sizeMm[0] / 2, component.sizeMm[1] / 2, component.sizeMm[2] / 2], component.rotationDeg);
  }
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
