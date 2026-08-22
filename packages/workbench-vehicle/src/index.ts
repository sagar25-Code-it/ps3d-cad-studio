import {
  analyzeVehicle,
  solveVehicleGeometry,
  type Vec3,
  type VehicleAnalysis,
  type VehicleGeometryModel,
  type VehicleHardPoint,
  type VehicleIntent,
  type VehicleLayerId,
  type VehicleWheelPose
} from "../../workbench-core/src/index.js";
import type { PreviewPrimitive, PreviewScene } from "../../workbench-geometry/src/index.js";

export interface VehiclePreview {
  readonly scene: PreviewScene;
  readonly analysis: VehicleAnalysis;
  readonly geometry: VehicleGeometryModel;
  readonly primitiveCountByLayer: Readonly<Record<string, number>>;
}

const LAYER_COLORS: Readonly<Record<VehicleLayerId, string>> = {
  skeleton: "#60a5fa",
  hardpoints: "#e2e8f0",
  envelopes: "#c084fc",
  wheels: "#1e293b",
  chassis: "#14b8a6",
  suspension: "#38bdf8",
  steering: "#f472b6",
  brakes: "#f59e0b",
  powertrain: "#22d3ee",
  "cg-loads": "#facc15"
};

export function buildVehiclePreview(intent: VehicleIntent): VehiclePreview {
  const geometry = solveVehicleGeometry(intent);
  const analysis = analyzeVehicle(intent);
  const byId = new Map(geometry.hardpoints.map((point) => [point.id, point]));
  const primitives: PreviewPrimitive[] = [];
  const counts: Record<string, number> = {};
  const add = (layer: VehicleLayerId, primitive: PreviewPrimitive): void => {
    if (!intent.layers[layer]) return;
    primitives.push(primitive);
    counts[layer] = (counts[layer] ?? 0) + 1;
  };
  const p = intent.parameters;

  add("skeleton", guide("vehicle-guide:design-ground", "Design-ride reference plane", "#64748b", [-0.45, 0, 0], [p.wheelbaseM + 0.45, 0, 0]));
  add("skeleton", guide("vehicle-guide:design-wheelbase", "Design wheelbase input", "#7dd3fc", [0, 0, 0.025], [p.wheelbaseM, 0, 0.025]));
  add("skeleton", guide("vehicle-guide:centerline", "Vehicle longitudinal center plane", "#8b5cf6", [-0.3, 0, 0.018], [p.wheelbaseM + 0.35, 0, 0.018]));

  for (const member of geometry.members) {
    const from = requirePoint(byId, member.fromHardpointId);
    const to = requirePoint(byId, member.toHardpointId);
    const color = LAYER_COLORS[member.layer];
    add(member.layer, member.style === "construction"
      ? guide(member.id, member.label, color, from.positionM, to.positionM)
      : tube(member.id, member.label, color, from.positionM, to.positionM, member.radiusM));
  }

  const frontWheels = geometry.wheels.filter((wheel) => wheel.axle === "front");
  const rearWheels = geometry.wheels.filter((wheel) => wheel.axle === "rear");
  const frontDiscsPerWheel = discsPerWheel(frontWheels.length, p.frontDiscCount);
  const rearDiscsPerWheel = discsPerWheel(rearWheels.length, p.rearDiscCount);
  for (const wheel of geometry.wheels) {
    const count = wheel.axle === "front" ? frontDiscsPerWheel : rearDiscsPerWheel;
    addWheelAssembly(add, wheel, requirePoint(byId, wheel.centerHardpointId).positionM, p, count);
  }

  const alternateStates = (["full-droop", "design-ride", "full-bump"] as const).filter((state) => state !== intent.state);
  for (const state of alternateStates) {
    const alternate = solveVehicleGeometry({ ...intent, state });
    if (alternate.errors.length > 0) continue;
    for (const wheel of alternate.wheels) {
      const point = alternate.hardpoints.find((candidate) => candidate.id === wheel.centerHardpointId);
      if (point === undefined) continue;
      add("envelopes", cylinder(`vehicle-envelope:${state}:${wheel.id}`, `${wheel.label} ${state} swept-state ghost`, state === "full-droop" ? "#818cf8" : "#fb7185", point.positionM, wheel.radiusM, wheel.widthM * 0.92, 0.10, false, wheelCylinderRotation(wheel)));
    }
  }

  const seat = requirePoint(byId, "vehicle-hp:seat");
  const powertrain = requirePoint(byId, "vehicle-hp:powertrain");
  const cg = requirePoint(byId, "vehicle-hp:cg");
  add("chassis", box("vehicle-frame:seat", "Seat planning surface", "#7c3aed", [seat.positionM[0] - 0.06, seat.positionM[1], seat.positionM[2] + 0.035], intent.kind === "three-wheeler" ? [0.46, 0.54, 0.09] : [0.40, 0.27, 0.075], 0.90, true));

  if (intent.powertrain === "electric") {
    add("powertrain", box("vehicle-powertrain:battery", "Battery package envelope - unvalidated", "#8b5cf6", [powertrain.positionM[0] + 0.10, 0, intent.layout === "single-track" ? 0.44 : 0.40], intent.layout === "single-track" ? [0.50, 0.31, 0.40] : [0.76, Math.max(0.58, p.trackM * 0.52), 0.34], 0.72, true));
    add("powertrain", cylinder("vehicle-powertrain:motor", "Electric machine envelope - unvalidated", "#22d3ee", [powertrain.positionM[0] - 0.18, powertrain.positionM[1], powertrain.positionM[2] - 0.08], 0.115, intent.layout === "single-track" ? 0.24 : 0.32, 1, true));
  } else if (intent.kind === "scooter") {
    const pivot = requirePoint(byId, "vehicle-hp:swing-pivot").positionM;
    const rear = requirePoint(byId, "vehicle-hp:rear-axle").positionM;
    const pitchDeg = -Math.atan2(rear[2] - pivot[2], rear[0] - pivot[0]) * 180 / Math.PI;
    add("powertrain", box("vehicle-powertrain:unit-engine", "Unit-swing engine / CVT envelope - unvalidated", "#fb923c", powertrain.positionM, [0.48, 0.28, 0.22], 0.82, true, [0, pitchDeg, 0]));
  } else {
    add("powertrain", box("vehicle-powertrain:engine", "ICE / gearbox envelope - unvalidated", "#fb923c", powertrain.positionM, [0.46, 0.34, 0.39], 0.82, true));
    add("powertrain", box("vehicle-powertrain:fuel", "Fuel-system package boundary - unvalidated", "#ef4444", [powertrain.positionM[0] + 0.12, 0, 0.67], [0.42, 0.30, 0.20], 0.30, false));
  }

  const riderHeight = intent.kind === "three-wheeler" ? 1.12 : 0.78;
  add("envelopes", box("vehicle-envelope:rider", "Rider / operator package boundary", "#c084fc", [seat.positionM[0], 0, seat.positionM[2] + riderHeight * 0.42], [0.42, intent.kind === "three-wheeler" ? 0.60 : 0.38, riderHeight], 0.13, false));
  if (intent.layout === "delta-1f2r") add("envelopes", box("vehicle-envelope:cargo", "Delta cargo payload boundary", "#34d399", [0.42, 0, 0.84], [1.02, Math.max(0.78, p.trackM * 0.82), 0.84], 0.15, false));

  for (const point of geometry.hardpoints) add("hardpoints", cylinder(point.id, `${point.label} - ${point.source}${point.stateDependent ? ", state" : ""}`, hardpointColor(point), point.positionM, 0.009, 0.020, 1, true, [90, 0, 0]));
  add("cg-loads", cylinder("vehicle-load:cg", "Combined CG input", analysis.status === "blocked" ? "#ef4444" : "#facc15", cg.positionM, 0.030, 0.060, 1, true, [90, 0, 0]));
  add("cg-loads", guide("vehicle-load:cg-projection", "Combined CG projection to design plane", "#facc15", cg.positionM, [cg.positionM[0], cg.positionM[1], 0]));
  const supportPoints = designSupportPolygon(intent);
  if (supportPoints.length > 0) add("cg-loads", {
    id: "vehicle-load:support-polygon", name: "Design-ride rigid support polygon", color: analysis.status === "blocked" ? "#ef4444" : "#22c55e",
    opacity: 0.95, selectable: false, kind: "line", pointsMm: [...supportPoints, supportPoints[0]!].flatMap(toMm), dashed: false, radiusMm: 5
  });

  const bounds = geometryBounds(intent, geometry, primitives);
  const scene: PreviewScene = { id: `vehicle-scene:${intent.template}:${intent.state}:v2`, kind: "assembly", primitives, boundsMm: bounds };
  return { scene, analysis, geometry, primitiveCountByLayer: counts };
}

function addWheelAssembly(add: (layer: VehicleLayerId, primitive: PreviewPrimitive) => void, wheel: VehicleWheelPose, center: Vec3, p: VehicleIntent["parameters"], discCount: number): void {
  const cylinderRotation = wheelCylinderRotation(wheel);
  const poseRotation = wheelPoseRotation(wheel);
  add("wheels", cylinder(`vehicle-wheel:tire:${wheel.id}`, `${wheel.label} loaded tire envelope`, "#111827", center, wheel.radiusM, wheel.widthM, 0.98, true, cylinderRotation));
  add("wheels", cylinder(`vehicle-wheel:rim:${wheel.id}`, `${wheel.label} rim planning envelope`, "#38bdf8", center, wheel.radiusM * 0.62, wheel.widthM * 0.74, 1, true, cylinderRotation));
  add("wheels", cylinder(`vehicle-wheel:hub:${wheel.id}`, `${wheel.label} hub`, "#cbd5e1", center, wheel.radiusM * 0.13, wheel.widthM * 0.92, 1, true, cylinderRotation));
  const isFront = wheel.axle === "front";
  const discRadius = isFront ? p.frontDiscEffectiveRadiusM : p.rearDiscEffectiveRadiusM;
  const inboardSign = wheel.side === "left" ? -1 : wheel.side === "right" ? 1 : 1;
  for (let index = 0; index < discCount; index += 1) {
    const sideSign = wheel.side === "center" && discCount > 1 ? (index % 2 === 0 ? 1 : -1) : inboardSign;
    const radialTier = Math.floor(index / 2);
    const lateral = sideSign * wheel.widthM * (0.34 + radialTier * 0.06);
    const discPosition = addOffset(center, transformWheelOffset(wheel, [0, lateral, 0]));
    add("brakes", cylinder(`vehicle-brake:disc:${wheel.id}:${index + 1}`, `${wheel.label} brake disc ${index + 1} effective-radius guide`, "#f59e0b", discPosition, discRadius, 0.006, 0.96, true, cylinderRotation));
    const caliperPosition = addOffset(center, transformWheelOffset(wheel, [-discRadius * 0.55, lateral + sideSign * 0.008, discRadius * 0.34]));
    add("brakes", box(`vehicle-brake:caliper:${wheel.id}:${index + 1}`, `${wheel.label} caliper ${index + 1} package envelope`, "#ef4444", caliperPosition, [0.055, 0.040, 0.078], 1, false, poseRotation));
  }
}

function discsPerWheel(wheelCount: number, enteredCount: number): number {
  if (wheelCount < 1) return 0;
  const total = Math.max(0, Math.round(enteredCount));
  return total % wheelCount === 0 ? total / wheelCount : 0;
}

function geometryBounds(intent: VehicleIntent, geometry: VehicleGeometryModel, primitives: readonly PreviewPrimitive[]): PreviewScene["boundsMm"] {
  const points: Vec3[] = geometry.hardpoints.map((point) => point.positionM);
  for (const wheel of geometry.wheels) {
    const center = geometry.hardpoints.find((point) => point.id === wheel.centerHardpointId)!.positionM;
    const extent = Math.hypot(wheel.radiusM, wheel.widthM / 2);
    points.push([center[0] - extent, center[1] - extent, center[2] - extent]);
    points.push([center[0] + extent, center[1] + extent, center[2] + extent]);
  }
  for (const primitive of primitives) {
    if (primitive.kind === "box") {
      const extentMm = Math.hypot(...primitive.sizeMm) / 2;
      points.push([(primitive.positionMm[0] - extentMm) / 1_000, (primitive.positionMm[1] - extentMm) / 1_000, (primitive.positionMm[2] - extentMm) / 1_000]);
      points.push([(primitive.positionMm[0] + extentMm) / 1_000, (primitive.positionMm[1] + extentMm) / 1_000, (primitive.positionMm[2] + extentMm) / 1_000]);
    } else if (primitive.kind === "cylinder") {
      const extentMm = Math.hypot(primitive.radiusMm, primitive.heightMm / 2);
      points.push([(primitive.positionMm[0] - extentMm) / 1_000, (primitive.positionMm[1] - extentMm) / 1_000, (primitive.positionMm[2] - extentMm) / 1_000]);
      points.push([(primitive.positionMm[0] + extentMm) / 1_000, (primitive.positionMm[1] + extentMm) / 1_000, (primitive.positionMm[2] + extentMm) / 1_000]);
    } else {
      const values = primitive.kind === "mesh" ? primitive.positionsMm : primitive.segmentsMm ?? primitive.pointsMm;
      const radiusM = primitive.kind === "line" ? (primitive.radiusMm ?? 0) / 1_000 : 0;
      for (let index = 0; index + 2 < values.length; index += 3) {
        const point: Vec3 = [values[index]! / 1_000, values[index + 1]! / 1_000, values[index + 2]! / 1_000];
        points.push([point[0] - radiusM, point[1] - radiusM, point[2] - radiusM]);
        points.push([point[0] + radiusM, point[1] + radiusM, point[2] + radiusM]);
      }
    }
  }
  points.push([-0.5, 0, -0.08], [intent.parameters.wheelbaseM + 0.55, 0, intent.kind === "three-wheeler" ? 1.78 : 1.55]);
  const min: Vec3 = [Math.min(...points.map((point) => point[0])) - 0.08, Math.min(...points.map((point) => point[1])) - 0.08, Math.min(...points.map((point) => point[2])) - 0.05];
  const max: Vec3 = [Math.max(...points.map((point) => point[0])) + 0.08, Math.max(...points.map((point) => point[1])) + 0.08, Math.max(...points.map((point) => point[2])) + 0.08];
  return { min: toMm(min), max: toMm(max), size: toMm([max[0] - min[0], max[1] - min[1], max[2] - min[2]]) };
}

function designSupportPolygon(intent: VehicleIntent): readonly Vec3[] {
  const p = intent.parameters;
  if (intent.layout === "delta-1f2r") return [[p.wheelbaseM, 0, 0.01], [0, p.trackM / 2, 0.01], [0, -p.trackM / 2, 0.01]];
  if (intent.layout === "tadpole-2f1r") return [[p.wheelbaseM, p.trackM / 2, 0.01], [p.wheelbaseM, -p.trackM / 2, 0.01], [0, 0, 0.01]];
  return [];
}

function requirePoint(points: ReadonlyMap<string, VehicleHardPoint>, id: string): VehicleHardPoint {
  const point = points.get(id);
  if (point === undefined) throw new Error(`Vehicle hardpoint ${id} is missing.`);
  return point;
}

function wheelPoseRotation(wheel: VehicleWheelPose): Vec3 { return [wheel.camberRad * 180 / Math.PI, 0, wheel.steerRad * 180 / Math.PI]; }
/** Viewport cylinders are pre-rotated onto +Z; this base X rotation puts their axis on the wheel's local Y axle. */
function wheelCylinderRotation(wheel: VehicleWheelPose): Vec3 { return [90 + wheel.camberRad * 180 / Math.PI, 0, wheel.steerRad * 180 / Math.PI]; }
function transformWheelOffset(wheel: VehicleWheelPose, offset: Vec3): Vec3 {
  const cosCamber = Math.cos(wheel.camberRad); const sinCamber = Math.sin(wheel.camberRad);
  const cosSteer = Math.cos(wheel.steerRad); const sinSteer = Math.sin(wheel.steerRad);
  const afterCamber: Vec3 = [offset[0], offset[1] * cosCamber - offset[2] * sinCamber, offset[1] * sinCamber + offset[2] * cosCamber];
  return [afterCamber[0] * cosSteer - afterCamber[1] * sinSteer, afterCamber[0] * sinSteer + afterCamber[1] * cosSteer, afterCamber[2]];
}
function addOffset(point: Vec3, offset: Vec3): Vec3 { return [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]]; }
function toMm(point: Vec3): Vec3 { return [point[0] * 1_000, point[1] * 1_000, point[2] * 1_000]; }

function tube(id: string, name: string, color: string, startM: Vec3, endM: Vec3, radiusM: number): PreviewPrimitive {
  return { id, name, color, opacity: 1, selectable: true, kind: "line", pointsMm: [...toMm(startM), ...toMm(endM)], dashed: false, radiusMm: radiusM * 1_000 };
}
function guide(id: string, name: string, color: string, startM: Vec3, endM: Vec3): PreviewPrimitive {
  return { id, name, color, opacity: 0.86, selectable: false, kind: "line", pointsMm: [...toMm(startM), ...toMm(endM)], dashed: true };
}
function box(id: string, name: string, color: string, positionM: Vec3, sizeM: Vec3, opacity: number, selectable: boolean, rotationDeg: Vec3 = [0, 0, 0]): PreviewPrimitive {
  return { id, name, color, opacity, selectable, kind: "box", positionMm: toMm(positionM), rotationDeg, rotationOrder: "ZYX", sizeMm: toMm(sizeM) };
}
function cylinder(id: string, name: string, color: string, positionM: Vec3, radiusM: number, widthM: number, opacity: number, selectable: boolean, rotationDeg: Vec3 = [0, 0, 0]): PreviewPrimitive {
  return { id, name, color, opacity, selectable, kind: "cylinder", positionMm: toMm(positionM), rotationDeg, rotationOrder: "ZYX", radiusMm: radiusM * 1_000, heightMm: widthM * 1_000, radialSegments: 40 };
}
function hardpointColor(point: VehicleHardPoint): string {
  if (point.category === "axle" || point.category === "contact") return "#38bdf8";
  if (point.category === "suspension") return "#f97316";
  if (point.category === "steering") return "#c084fc";
  if (point.category === "powertrain") return "#22d3ee";
  if (point.category === "cg") return "#facc15";
  return "#94a3b8";
}
