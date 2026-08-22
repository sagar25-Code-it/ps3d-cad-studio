import type {
  Vec3,
  VehicleAnalysis,
  VehicleGeometryCheck,
  VehicleGeometryMember,
  VehicleGeometryModel,
  VehicleHardPoint,
  VehicleIntent,
  VehicleLayerId,
  VehicleParameterKey,
  VehicleParameters,
  VehicleSide,
  VehicleTemplateId,
  VehicleTopology,
  VehicleWheelPose
} from "./types.js";

const G = 9.80665;
const GEOMETRY_TOLERANCE_M = 1e-6;

const DEFAULT_LAYERS: Readonly<Record<VehicleLayerId, boolean>> = {
  skeleton: true,
  hardpoints: true,
  envelopes: true,
  wheels: true,
  chassis: true,
  suspension: true,
  steering: true,
  brakes: true,
  powertrain: true,
  "cg-loads": true
};

export const VEHICLE_PARAMETER_RANGES: Readonly<Record<VehicleParameterKey, readonly [number, number]>> = {
  wheelbaseM: [0.7, 4], frontLoadedRadiusM: [0.15, 0.6], rearLoadedRadiusM: [0.15, 0.6],
  frontRollingRadiusM: [0.15, 0.65], rearRollingRadiusM: [0.15, 0.65], frontTireWidthM: [0.04, 0.4],
  rearTireWidthM: [0.04, 0.5], trackM: [0, 2.5], rakeRad: [0.087, 0.785], forkNormalOffsetM: [0, 0.15],
  casterRad: [0, 0.436], kingpinInclinationRad: [0, 0.436], scrubRadiusM: [-0.15, 0.15], toeRad: [-0.087, 0.087],
  ackermannPercent: [0, 1.5], steeringAngleRad: [0, 1.047],
  rearSwingarmPivotFromRearM: [0.1, 1.5], rearSwingarmPivotHeightM: [0.15, 1.2],
  rearShockUpperFromRearM: [0.05, 2], rearShockUpperHeightM: [0.2, 1.5], rearShockArmRatio: [0.1, 0.95],
  frontSuspensionInboardHalfTrackM: [0.05, 1], frontLowerArmHeightM: [0.1, 0.8], frontUpperArmHeightM: [0.2, 1.2],
  frontTravelM: [0, 0.4], rearTravelM: [0, 0.4], frontSagM: [0, 0.2], rearSagM: [0, 0.2],
  frontSpringRateNPerM: [1_000, 500_000], rearSpringRateNPerM: [1_000, 1_000_000], frontMotionRatio: [0.05, 2], rearMotionRatio: [0.05, 2],
  curbMassKg: [20, 1_500], riderMassKg: [0, 250], payloadKg: [0, 2_000], cgFromRearM: [0.05, 3.95], cgHeightM: [0.05, 2.5],
  targetDecelerationMps2: [0, 15], lateralAccelerationMps2: [-15, 15], tireFrictionCoefficient: [0.05, 2],
  frontBrakeInputForceN: [0, 1_500], rearBrakeInputForceN: [0, 2_500], frontBrakeLeverRatio: [0.1, 12], rearBrakeLeverRatio: [0.1, 12],
  frontMasterCylinderDiameterM: [0.004, 0.08], rearMasterCylinderDiameterM: [0.004, 0.08],
  frontEquivalentClampAreaM2: [0.00001, 0.03], rearEquivalentClampAreaM2: [0.00001, 0.03], frontDiscCount: [1, 2], rearDiscCount: [1, 2],
  frontDiscEffectiveRadiusM: [0.03, 0.3], rearDiscEffectiveRadiusM: [0.03, 0.3], frontPadFrictionCoefficient: [0.05, 0.8], rearPadFrictionCoefficient: [0.05, 0.8],
  frontBrakeEfficiency: [0.1, 1], rearBrakeEfficiency: [0.1, 1], frontRatedPressurePa: [100_000, 50_000_000], rearRatedPressurePa: [100_000, 50_000_000],
  speedMps: [0, 80], reactionTimeS: [0, 5], gradeRad: [-0.5, 0.5], driveTorqueNm: [0, 1_500], finalDriveRatio: [0.1, 30], drivelineEfficiency: [0.1, 1],
  rollingResistanceCoefficient: [0, 0.2], dragCoefficient: [0.05, 2], frontalAreaSquareM: [0.1, 6], airDensityKgPerCubicM: [0.5, 1.6],
  batteryEnergyCapacityJ: [0, 720_000_000], usableBatteryFraction: [0.05, 1], energyConsumptionJPerM: [36, 3_600]
};

export function createVehicleTemplate(template: VehicleTemplateId = "ice-road-motorcycle"): VehicleIntent {
  const common = commonParameters();
  if (template === "step-through-scooter") return vehicle(
    "Step-through scooter kinematic package", template, "scooter", "ice", "single-track",
    { ...common, wheelbaseM: 1.30, frontLoadedRadiusM: 0.245, rearLoadedRadiusM: 0.235, frontRollingRadiusM: 0.249, rearRollingRadiusM: 0.239,
      frontTireWidthM: 0.09, rearTireWidthM: 0.11, rakeRad: degrees(27), forkNormalOffsetM: 0.038, frontTravelM: 0.09, rearTravelM: 0.085,
      frontSagM: 0.025, rearSagM: 0.025, curbMassKg: 115, riderMassKg: 75, cgFromRearM: 0.67, cgHeightM: 0.52,
      rearSwingarmPivotFromRearM: 0.46, rearSwingarmPivotHeightM: 0.36, rearShockUpperFromRearM: 0.31, rearShockUpperHeightM: 0.67,
      rearShockArmRatio: 0.62, rearSpringRateNPerM: 70_000, rearMotionRatio: 0.78, driveTorqueNm: 10, finalDriveRatio: 10,
      dragCoefficient: 0.72, frontalAreaSquareM: 0.62 }
  );
  if (template === "ev-street-motorcycle") return vehicle(
    "EV street motorcycle kinematic package", template, "motorcycle", "electric", "single-track",
    { ...common, wheelbaseM: 1.42, frontLoadedRadiusM: 0.30, rearLoadedRadiusM: 0.305, frontRollingRadiusM: 0.304, rearRollingRadiusM: 0.309,
      rakeRad: degrees(25.5), forkNormalOffsetM: 0.044, frontTravelM: 0.11, rearTravelM: 0.105, frontSagM: 0.032, rearSagM: 0.032,
      curbMassKg: 185, riderMassKg: 75, cgFromRearM: 0.76, cgHeightM: 0.56, rearSwingarmPivotFromRearM: 0.49,
      rearSwingarmPivotHeightM: 0.49, rearShockUpperFromRearM: 0.70, rearShockUpperHeightM: 0.78, driveTorqueNm: 42, finalDriveRatio: 4.2,
      batteryEnergyCapacityJ: 28_800_000, energyConsumptionJPerM: 252, dragCoefficient: 0.62, frontalAreaSquareM: 0.58 }
  );
  if (template === "delta-cargo-three-wheeler") return vehicle(
    "Delta cargo three-wheeler kinematic package", template, "three-wheeler", "electric", "delta-1f2r",
    { ...common, wheelbaseM: 2.05, frontLoadedRadiusM: 0.28, rearLoadedRadiusM: 0.30, frontRollingRadiusM: 0.284, rearRollingRadiusM: 0.304,
      frontTireWidthM: 0.11, rearTireWidthM: 0.145, trackM: 1.25, rakeRad: degrees(24), forkNormalOffsetM: 0.042, steeringAngleRad: degrees(38),
      frontTravelM: 0.08, rearTravelM: 0.10, frontSagM: 0.024, rearSagM: 0.03, frontSpringRateNPerM: 25_000, rearSpringRateNPerM: 95_000,
      rearSwingarmPivotFromRearM: 0.52, rearSwingarmPivotHeightM: 0.47, rearShockUpperFromRearM: 0.34, rearShockUpperHeightM: 0.72,
      rearShockArmRatio: 0.60, curbMassKg: 430, riderMassKg: 75, payloadKg: 250, cgFromRearM: 0.92, cgHeightM: 0.63,
      targetDecelerationMps2: 5, lateralAccelerationMps2: 3, driveTorqueNm: 65, finalDriveRatio: 6,
      batteryEnergyCapacityJ: 50_400_000, energyConsumptionJPerM: 522, frontalAreaSquareM: 1.9, dragCoefficient: 0.78,
      frontDiscCount: 1, rearDiscCount: 2, rearBrakeInputForceN: 220, rearBrakeLeverRatio: 4 }
  );
  if (template === "tadpole-geometry-three-wheeler") return vehicle(
    "Tadpole double-wishbone geometry package", template, "three-wheeler", "electric", "tadpole-2f1r",
    { ...common, wheelbaseM: 2.0, frontLoadedRadiusM: 0.29, rearLoadedRadiusM: 0.31, frontRollingRadiusM: 0.294, rearRollingRadiusM: 0.314,
      frontTireWidthM: 0.12, rearTireWidthM: 0.15, trackM: 1.20, casterRad: degrees(7), kingpinInclinationRad: degrees(10),
      scrubRadiusM: 0.025, toeRad: degrees(0.1), ackermannPercent: 0.95, steeringAngleRad: degrees(24),
      frontSuspensionInboardHalfTrackM: 0.28, frontLowerArmHeightM: 0.22, frontUpperArmHeightM: 0.49,
      frontTravelM: 0.09, rearTravelM: 0.10, frontSagM: 0.027, rearSagM: 0.03, frontSpringRateNPerM: 55_000, rearSpringRateNPerM: 85_000,
      rearSwingarmPivotFromRearM: 0.50, rearSwingarmPivotHeightM: 0.49, rearShockUpperFromRearM: 0.68, rearShockUpperHeightM: 0.78,
      curbMassKg: 360, riderMassKg: 75, payloadKg: 80, cgFromRearM: 0.82, cgHeightM: 0.56, lateralAccelerationMps2: 3.5,
      driveTorqueNm: 58, finalDriveRatio: 5.5, batteryEnergyCapacityJ: 43_200_000, energyConsumptionJPerM: 432,
      frontalAreaSquareM: 1.25, dragCoefficient: 0.68, frontDiscCount: 2, rearDiscCount: 1 }
  );
  return vehicle("ICE road motorcycle kinematic package", template, "motorcycle", "ice", "single-track", common);
}

export function vehicleTopology(intent: VehicleIntent): VehicleTopology {
  if (intent.template === "step-through-scooter") return {
    frontSuspension: "telescopic-fork", rearSuspension: "unit-swing", steering: "steered-fork", frame: "step-through-underbone",
    frontWheelCount: 1, rearWheelCount: 1, drivenAxle: "rear"
  };
  if (intent.layout === "delta-1f2r") return {
    frontSuspension: "telescopic-fork", rearSuspension: "trailing-arm-beam", steering: "steered-fork", frame: "cargo-twin-rail",
    frontWheelCount: 1, rearWheelCount: 2, drivenAxle: "rear"
  };
  if (intent.layout === "tadpole-2f1r") return {
    frontSuspension: "double-wishbone", rearSuspension: "swingarm", steering: "rack-and-tie-rod", frame: "reverse-trike-spaceframe",
    frontWheelCount: 2, rearWheelCount: 1, drivenAxle: "rear"
  };
  return {
    frontSuspension: "telescopic-fork", rearSuspension: "swingarm", steering: "steered-fork", frame: "diamond-cradle",
    frontWheelCount: 1, rearWheelCount: 1, drivenAxle: "rear"
  };
}

export function solveVehicleGeometry(intent: VehicleIntent): VehicleGeometryModel {
  const topology = vehicleTopology(intent);
  const context = createGeometryContext();
  const frontDeltaM = suspensionDelta(intent.state, intent.parameters.frontTravelM, intent.parameters.frontSagM);
  const rearDeltaM = suspensionDelta(intent.state, intent.parameters.rearTravelM, intent.parameters.rearSagM);
  const rear = buildRearGeometry(context, intent, topology, rearDeltaM);
  const front = topology.frontSuspension === "telescopic-fork"
    ? buildForkGeometry(context, intent, frontDeltaM)
    : buildTadpoleFrontGeometry(context, intent, frontDeltaM);
  buildChassisGeometry(context, intent, topology, rear.powertrainPointM);

  const frontCenters = context.wheels.filter((wheel) => wheel.axle === "front").map((wheel) => requirePoint(context, wheel.centerHardpointId).positionM);
  const rearCenters = context.wheels.filter((wheel) => wheel.axle === "rear").map((wheel) => requirePoint(context, wheel.centerHardpointId).positionM);
  const frontCenter = averagePoints(frontCenters);
  const rearCenter = averagePoints(rearCenters);
  const stateWheelbaseM = frontCenter[0] - rearCenter[0];
  const frontTrackM = trackOf(frontCenters);
  const rearTrackM = trackOf(rearCenters);

  const allFinite = context.hardpoints.every((point) => point.positionM.every(Number.isFinite));
  addCheck(context, "finite", "Finite solved coordinates", allFinite ? "pass" : "fail", allFinite ? "all finite" : "non-finite value", "all hardpoints finite");
  if (intent.state === "design-ride") {
    addCheck(context, "wheelbase", "Design wheelbase", nearStatus(stateWheelbaseM, intent.parameters.wheelbaseM, GEOMETRY_TOLERANCE_M), millimeters(stateWheelbaseM), `${millimeters(intent.parameters.wheelbaseM)} input`);
    if (topology.frontWheelCount === 2) addCheck(context, "front-track", "Front design track", nearStatus(frontTrackM, intent.parameters.trackM, GEOMETRY_TOLERANCE_M), millimeters(frontTrackM), `${millimeters(intent.parameters.trackM)} input`);
    if (topology.rearWheelCount === 2) addCheck(context, "rear-track", "Rear design track", nearStatus(rearTrackM, intent.parameters.trackM, GEOMETRY_TOLERANCE_M), millimeters(rearTrackM), `${millimeters(intent.parameters.trackM)} input`);
    const contacts = context.hardpoints.filter((point) => point.category === "contact");
    const maxContactError = Math.max(...contacts.map((point) => Math.abs(point.positionM[2])), 0);
    addCheck(context, "design-ground", "Design contact plane", maxContactError <= GEOMETRY_TOLERANCE_M ? "pass" : "fail", millimeters(maxContactError), "all contacts Z = 0 mm");
  } else {
    addCheck(context, "state-frame", "Chassis-fixed suspension state", "review", `${intent.state}; WB ${millimeters(stateWheelbaseM)}`, "design ground is a reference plane, not a moved road surface");
  }

  const uniqueIds = new Set(context.hardpoints.map((point) => point.id));
  const idsUnique = uniqueIds.size === context.hardpoints.length;
  addCheck(context, "stable-ids", "Unique stable hardpoint IDs", idsUnique ? "pass" : "fail", `${uniqueIds.size}/${context.hardpoints.length}`, "one unique ID per hardpoint");
  if (!allFinite) context.errors.push("Vehicle kinematics produced a non-finite coordinate.");
  if (!idsUnique) context.errors.push("Vehicle hardpoint IDs are not unique.");

  return {
    schema: "ps3d-vehicle-geometry/2",
    coordinateSystem: "+X forward / +Y left / +Z up; chassis-fixed from design ride",
    topology,
    hardpoints: context.hardpoints,
    members: context.members,
    wheels: context.wheels,
    designWheelbaseM: intent.parameters.wheelbaseM,
    stateWheelbaseM,
    frontTrackM,
    rearTrackM,
    rearSwingarmLengthM: rear.swingarmLengthM,
    rearShockLengthM: rear.shockLengthM,
    frontCamberChangeRad: front.camberChangeRad,
    idealInnerSteerRad: front.idealInnerSteerRad,
    idealOuterSteerRad: front.idealOuterSteerRad,
    modeledInnerSteerRad: front.modeledInnerSteerRad,
    modeledOuterSteerRad: front.modeledOuterSteerRad,
    ackermannErrorRad: front.ackermannErrorRad,
    checks: context.checks,
    errors: context.errors
  };
}

export function analyzeVehicle(intent: VehicleIntent): VehicleAnalysis {
  const p = intent.parameters;
  const topology = vehicleTopology(intent);
  const geometry = solveVehicleGeometry(intent);
  const errors: string[] = [...geometry.errors];
  for (const state of ["full-droop", "design-ride", "full-bump"] as const) {
    if (state === intent.state) continue;
    const alternate = solveVehicleGeometry({ ...intent, state });
    for (const error of alternate.errors) errors.push(`${state.replaceAll("-", " ")} envelope: ${error}`);
  }
  const warnings: string[] = [];
  const totalMassKg = p.curbMassKg + p.riderMassKg + p.payloadKg;
  if (p.cgFromRearM <= 0 || p.cgFromRearM >= p.wheelbaseM) errors.push("CG longitudinal position must remain strictly between the rear and front contact stations.");
  if (intent.layout !== "single-track" && p.trackM <= 0) errors.push("A rigid three-wheel layout requires a positive paired-wheel track.");
  if ((intent.layout === "delta-1f2r" && p.trackM <= p.rearTireWidthM)
    || (intent.layout === "tadpole-2f1r" && p.trackM <= p.frontTireWidthM)) errors.push("Paired-wheel track must exceed tire width; overlapping wheel envelopes are not analyzed.");
  const frontWheelCount = intent.layout === "tadpole-2f1r" ? 2 : 1;
  const rearWheelCount = intent.layout === "delta-1f2r" ? 2 : 1;
  if (!Number.isInteger(p.frontDiscCount) || !Number.isInteger(p.rearDiscCount)
    || p.frontDiscCount % frontWheelCount !== 0 || p.rearDiscCount % rearWheelCount !== 0) errors.push("Brake disc counts must resolve to an equal whole-disc count at every modeled wheel.");
  if (p.frontDiscEffectiveRadiusM >= p.frontLoadedRadiusM || p.rearDiscEffectiveRadiusM >= p.rearLoadedRadiusM) errors.push("Brake effective radius must remain strictly inside the corresponding loaded tire radius.");
  if (p.frontRollingRadiusM <= p.frontLoadedRadiusM || p.rearRollingRadiusM <= p.rearLoadedRadiusM) errors.push("Effective rolling radius must exceed static loaded radius in this bounded free-rolling input convention.");
  if (intent.powertrain === "electric" && p.batteryEnergyCapacityJ <= 0) errors.push("An electric template requires a positive user-entered battery energy capacity.");

  const requestedLoads = axleLoads(p, totalMassKg, p.targetDecelerationMps2);
  if (requestedLoads.frontN <= 0 || requestedLoads.rearN <= 0) errors.push("The requested braking state predicts axle lift; no valid two-axle equilibrium exists.");
  const trailM = topology.steering === "steered-fork"
    ? (p.frontLoadedRadiusM * Math.sin(p.rakeRad) - p.forkNormalOffsetM) / Math.cos(p.rakeRad)
    : null;
  const turningRadiusM = p.steeringAngleRad > 1e-9 ? geometry.stateWheelbaseM / Math.tan(p.steeringAngleRad) : null;

  const frontWheelRateNPerM = p.frontSpringRateNPerM * p.frontMotionRatio ** 2;
  const rearWheelRateNPerM = p.rearSpringRateNPerM * p.rearMotionRatio ** 2;
  const frontAxleWheelRateNPerM = frontWheelRateNPerM * topology.frontWheelCount;
  const rearAxleWheelRateNPerM = rearWheelRateNPerM * topology.rearWheelCount;
  const frontSupportedMass = Math.max(1, requestedLoads.staticFrontN / G);
  const rearSupportedMass = Math.max(1, requestedLoads.staticRearN / G);
  const frontNaturalFrequencyHz = Math.sqrt(frontAxleWheelRateNPerM / frontSupportedMass) / (2 * Math.PI);
  const rearNaturalFrequencyHz = Math.sqrt(rearAxleWheelRateNPerM / rearSupportedMass) / (2 * Math.PI);

  const frontHydraulicPressurePa = hydraulicPressure(p.frontBrakeInputForceN, p.frontBrakeLeverRatio, p.frontMasterCylinderDiameterM);
  const rearHydraulicPressurePa = hydraulicPressure(p.rearBrakeInputForceN, p.rearBrakeLeverRatio, p.rearMasterCylinderDiameterM);
  const availableFrontBrakeTorqueNm = frontHydraulicPressurePa * p.frontEquivalentClampAreaM2 * p.frontPadFrictionCoefficient * p.frontDiscEffectiveRadiusM * p.frontBrakeEfficiency * p.frontDiscCount;
  const availableRearBrakeTorqueNm = rearHydraulicPressurePa * p.rearEquivalentClampAreaM2 * p.rearPadFrictionCoefficient * p.rearDiscEffectiveRadiusM * p.rearBrakeEfficiency * p.rearDiscCount;
  const pressureExceeded = frontHydraulicPressurePa > p.frontRatedPressurePa || rearHydraulicPressurePa > p.rearRatedPressurePa;
  if (pressureExceeded) errors.push("Calculated hydraulic pressure exceeds a user-entered circuit rating.");
  const frontHardwareForce = availableFrontBrakeTorqueNm / p.frontLoadedRadiusM;
  const rearHardwareForce = availableRearBrakeTorqueNm / p.rearLoadedRadiusM;
  const hardwareTotal = frontHardwareForce + rearHardwareForce;
  const hardwareFrontBrakePercent = hardwareTotal > 0 ? 100 * frontHardwareForce / hardwareTotal : 0;
  const idealFrontBrakePercent = requestedLoads.normalTotalN > 0 ? 100 * requestedLoads.frontN / requestedLoads.normalTotalN : 0;
  const brakeSolve = solveBrakeState(p, totalMassKg, frontHardwareForce, rearHardwareForce);
  const frontLockMarginN = brakeSolve.frontLongitudinalCapacityN - frontHardwareForce;
  const rearLockMarginN = brakeSolve.rearLongitudinalCapacityN - rearHardwareForce;
  const predictedBrakeDecelerationMps2 = brakeSolve.decelerationMps2;
  const speed = p.speedMps;
  const brakingDistanceM = speed <= 1e-9 ? 0 : predictedBrakeDecelerationMps2 > 1e-6 ? speed ** 2 / (2 * predictedBrakeDecelerationMps2) : null;
  const totalStoppingDistanceM = brakingDistanceM === null ? null : brakingDistanceM + speed * p.reactionTimeS;
  const brakeDemandUnmet = predictedBrakeDecelerationMps2 + 1e-6 < p.targetDecelerationMps2;
  const firstBrakeLimit = pressureExceeded ? "pressure-rating"
    : brakeSolve.loads.frontN <= 0 || brakeSolve.loads.rearN <= 0 ? "wheel-lift"
    : brakeDemandUnmet && brakeSolve.availableFrontForceN + 1e-6 < frontHardwareForce ? "front-adhesion"
    : brakeDemandUnmet && brakeSolve.availableRearForceN + 1e-6 < rearHardwareForce ? "rear-adhesion"
    : brakeDemandUnmet ? "hydraulic-capacity" : "none";

  const gradeCos = Math.cos(p.gradeRad);
  const gradeSin = Math.sin(p.gradeRad);
  const rollingLoadN = speed > 1e-3 ? p.rollingResistanceCoefficient * totalMassKg * G * gradeCos : 0;
  const roadLoadN = rollingLoadN + totalMassKg * G * gradeSin
    + 0.5 * p.airDensityKgPerCubicM * p.dragCoefficient * p.frontalAreaSquareM * speed * Math.abs(speed);
  const rollingRadiusM = topology.drivenAxle === "rear" ? p.rearRollingRadiusM : p.frontRollingRadiusM;
  const rawTractiveForceN = p.driveTorqueNm * p.finalDriveRatio * p.drivelineEfficiency / rollingRadiusM;
  const driveSolve = solveTractionState(p, totalMassKg, topology, rawTractiveForceN, roadLoadN);
  const scenarioLongitudinalAccelerationMps2 = (driveSolve.usedForceN - roadLoadN) / totalMassKg;
  const wheelSpeedRpm = speed / rollingRadiusM * 60 / (2 * Math.PI);
  const sourceSpeedRpm = wheelSpeedRpm * p.finalDriveRatio;
  const sourcePowerW = p.driveTorqueNm * sourceSpeedRpm * 2 * Math.PI / 60;
  const assumptionEvRangeKm = intent.powertrain === "electric"
    ? p.batteryEnergyCapacityJ * p.usableBatteryFraction / p.energyConsumptionJPerM / 1_000
    : null;
  const steadyLeanAngleRad = intent.layout === "single-track" ? Math.atan2(p.lateralAccelerationMps2, G * gradeCos) : null;
  const support = intent.layout === "single-track" ? null : threeWheelSupport(intent, p.targetDecelerationMps2, p.lateralAccelerationMps2, requestedLoads.normalTotalN);
  if (support !== null && support.minimumLoadN <= 0) errors.push("The quasi-static resultant leaves the triangular support polygon; theoretical wheel lift is predicted.");

  if (intent.inputStatus !== "user-reviewed") warnings.push("Template dimensions and masses are illustrative, unvalidated inputs.");
  if (intent.tireDataStatus !== "supplier-reviewed") warnings.push("Tire loaded radius, rolling radius, approved rim, pressure, load index, speed capability, and evidence source require supplier verification.");
  if (intent.brakeDataStatus !== "supplier-reviewed") warnings.push("Brake pressure, equivalent clamp area, pad friction, effective radius, efficiency, and ratings require supplier or test evidence.");
  if (p.tireFrictionCoefficient > 1.5) warnings.push("The tire friction coefficient is unusually high and requires documented test evidence.");
  if (p.frontTravelM > 0 && (p.frontSagM / p.frontTravelM < 0.15 || p.frontSagM / p.frontTravelM > 0.5)) warnings.push("Front sag is outside the illustrative screening band; use the selected suspension supplier procedure and declared load case.");
  if (p.rearTravelM > 0 && (p.rearSagM / p.rearTravelM < 0.15 || p.rearSagM / p.rearTravelM > 0.5)) warnings.push("Rear sag is outside the illustrative screening band; use the selected suspension supplier procedure and declared load case.");
  if (Math.abs(hardwareFrontBrakePercent - idealFrontBrakePercent) > 15) warnings.push("Hardware brake-force distribution differs from the requested equal-utilization split by more than 15 percentage points.");
  if (predictedBrakeDecelerationMps2 + 0.05 < p.targetDecelerationMps2) warnings.push("Entered brake hardware and the combined tire screen do not reach the requested deceleration.");
  if ((brakeSolve.frontUtilization !== null && brakeSolve.frontUtilization > 1)
    || (brakeSolve.rearUtilization !== null && brakeSolve.rearUtilization > 1)) warnings.push("The simplified combined longitudinal/lateral tire utilization exceeds 1.0; tire sliding is predicted before any certification inference.");
  if (driveSolve.usedForceN + 1e-6 < rawTractiveForceN) warnings.push(`Drive force is capped by the ${driveSolve.firstLimit.replaceAll("-", " ")} screen; transient tire and control response are not modeled.`);
  if (topology.steering === "steered-fork") warnings.push("The steering angle drives the low-speed turning-radius screen only; fork-yaw CAD kinematics are not applied to the chassis-fixed suspension graph.");
  if (topology.steering === "rack-and-tie-rod") warnings.push("Tadpole double-wishbone hardpoints and ideal Ackermann targets are solved; rack travel, constant tie-rod length under steer, compliance, and bump-steer optimization remain unavailable.");
  if (intent.kind === "three-wheeler") warnings.push("Parking brake, split-circuit fault, bank/cross-slope, transient rollover, and regulatory stopping procedures are not analyzed.");
  warnings.push("Drive torque and total reduction are one user-entered operating point; ICE gear/CVT maps, motor torque-speed limits, continuous power, thermal limits, and sustained top speed or gradeability are unavailable.");
  warnings.push("Ride-frequency values use supported total axle mass, not measured sprung/unsprung mass, preload, damping, or a correlated quarter-vehicle model.");
  warnings.push("A single combined CG is used; separate vehicle, rider, passenger, fuel/battery, payload, and asymmetric cargo load cases are unavailable.");
  if (intent.state !== "design-ride") warnings.push("The selected droop/bump state changes chassis-fixed CAD kinematics only; load, brake, road-load, and stability calculations remain referenced to the entered design scenario.");
  if (intent.powertrain === "electric") warnings.push("EV range is a user-assumption energy envelope, not a predicted or certified range; SOC, temperature, voltage, auxiliaries, duty cycle, degradation, boundary losses, and regen are not modeled.");

  return {
    schema: "ps3d-vehicle-analysis/2", status: errors.length === 0 ? "review" : "blocked", topology,
    trailM, turningRadiusM, stateWheelbaseM: geometry.stateWheelbaseM, frontTrackM: geometry.frontTrackM, rearTrackM: geometry.rearTrackM,
    rearSwingarmLengthM: geometry.rearSwingarmLengthM, rearShockLengthM: geometry.rearShockLengthM,
    frontCamberChangeRad: geometry.frontCamberChangeRad, idealInnerSteerRad: geometry.idealInnerSteerRad, idealOuterSteerRad: geometry.idealOuterSteerRad,
    modeledInnerSteerRad: geometry.modeledInnerSteerRad, modeledOuterSteerRad: geometry.modeledOuterSteerRad, ackermannErrorRad: geometry.ackermannErrorRad,
    totalMassKg, staticFrontLoadN: requestedLoads.staticFrontN, staticRearLoadN: requestedLoads.staticRearN,
    brakingFrontLoadN: requestedLoads.frontN, brakingRearLoadN: requestedLoads.rearN,
    predictedBrakingFrontLoadN: brakeSolve.loads.frontN, predictedBrakingRearLoadN: brakeSolve.loads.rearN,
    idealFrontBrakePercent, hardwareFrontBrakePercent, frontLockMarginN, rearLockMarginN,
    frontWheelRateNPerM, rearWheelRateNPerM, frontAxleWheelRateNPerM, rearAxleWheelRateNPerM,
    frontNaturalFrequencyHz, rearNaturalFrequencyHz, frontHydraulicPressurePa, rearHydraulicPressurePa,
    availableFrontBrakeTorqueNm, availableRearBrakeTorqueNm, predictedBrakeDecelerationMps2,
    frontCombinedTireUtilization: brakeSolve.frontUtilization, rearCombinedTireUtilization: brakeSolve.rearUtilization, firstBrakeLimit,
    brakingDistanceM, totalStoppingDistanceM, roadLoadN, rawTractiveForceN, tractiveForceN: driveSolve.usedForceN,
    adhesionLimitedTractiveForceN: driveSolve.adhesionLimitN, wheelLiftAccelerationLimitMps2: driveSolve.wheelLiftLimitMps2,
    wheelSpeedRpm, sourceSpeedRpm, sourcePowerW, firstDriveLimit: driveSolve.firstLimit,
    scenarioLongitudinalAccelerationMps2, assumptionEvRangeKm, steadyLeanAngleRad,
    supportWheelLoadsN: support?.loads ?? null, minimumSupportLoadN: support?.minimumLoadN ?? null,
    approximateTipThresholdMps2: support?.tipThresholdMps2 ?? null, hardpoints: geometry.hardpoints, geometryChecks: geometry.checks,
    errors, warnings,
    assumptions: [
      "Coordinates are chassis-fixed: +X forward, +Y left, +Z up, with the rear design contact station as X = 0.",
      "Rigid links, a design reference plane, constant user-entered coefficients, and quasi-static load transfer are assumed.",
      "Motion ratio is shock travel per vertical wheel travel; user-entered wheel rate uses spring rate multiplied by motion-ratio squared.",
      "Equivalent clamp area is entered per caliper/disc and already represents caliper construction; one overall brake efficiency is applied once.",
      "Combined tire utilization uses a simplified friction ellipse with one coefficient; no tire model, ABS, relaxation, temperature, or road transient is included.",
      "Three-wheel lift is a rigid support-polygon screen; suspension roll, compliance, bumps, tire transients, and tripped rollover are excluded.",
      "No result is a structural, brake, tire, roadworthiness, homologation, or functional-safety certification."
    ]
  };
}

export function vehicleHardPoints(intent: VehicleIntent): readonly VehicleHardPoint[] {
  return solveVehicleGeometry(intent).hardpoints;
}

function buildForkGeometry(context: GeometryContext, intent: VehicleIntent, frontDeltaM: number): FrontGeometryResult {
  const p = intent.parameters;
  const trailM = (p.frontLoadedRadiusM * Math.sin(p.rakeRad) - p.forkNormalOffsetM) / Math.cos(p.rakeRad);
  const axisGroundX = p.wheelbaseM + trailM;
  const slideDirection: Vec3 = [-Math.sin(p.rakeRad), 0, Math.cos(p.rakeRad)];
  const normalDirection: Vec3 = [Math.cos(p.rakeRad), 0, Math.sin(p.rakeRad)];
  const frontCenter: Vec3 = [p.wheelbaseM + slideDirection[0] * frontDeltaM, 0, p.frontLoadedRadiusM + slideDirection[2] * frontDeltaM];
  const headLowerZ = intent.kind === "scooter" ? 0.54 : intent.layout === "delta-1f2r" ? 0.58 : 0.63;
  const headUpperZ = headLowerZ + (intent.kind === "scooter" ? 0.17 : 0.22);
  const axisAt = (z: number): Vec3 => [axisGroundX - z * Math.tan(p.rakeRad), 0, z];
  const headLower = axisAt(headLowerZ);
  const headUpper = axisAt(headUpperZ);
  const forkLowerCenter = add3(headLower, scale3(normalDirection, p.forkNormalOffsetM));
  const forkUpperCenter = add3(headUpper, scale3(normalDirection, p.forkNormalOffsetM));
  const forkHalfSpacing = Math.max(0.055, p.frontTireWidthM * 0.58);

  addPoint(context, "vehicle-hp:front-axle", "Front axle center", "axle", frontCenter, "center", "derived", true);
  addPoint(context, "vehicle-hp:front-contact", "Front tire contact reference", "contact", [frontCenter[0], 0, frontCenter[2] - p.frontLoadedRadiusM], "center", "derived", true);
  addPoint(context, "vehicle-hp:steering-axis-ground", "Steering-axis design-ground intercept", "steering", [axisGroundX, 0, 0], "center", "derived", false);
  addPoint(context, "vehicle-hp:head-lower", "Steering axis lower", "steering", headLower, "center", "derived", false);
  addPoint(context, "vehicle-hp:head-upper", "Steering axis upper", "steering", headUpper, "center", "derived", false);
  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    const mate = side === "left" ? "right" : "left";
    addPoint(context, `vehicle-hp:fork-lower-${side}`, `Fork lower clamp ${side}`, "suspension", offsetY(forkLowerCenter, sign * forkHalfSpacing), side, "derived", false, `vehicle-hp:fork-lower-${mate}`);
    addPoint(context, `vehicle-hp:fork-upper-${side}`, `Fork upper clamp ${side}`, "suspension", offsetY(forkUpperCenter, sign * forkHalfSpacing), side, "derived", false, `vehicle-hp:fork-upper-${mate}`);
    addPoint(context, `vehicle-hp:front-axle-${side}`, `Front axle ${side} end`, "axle", offsetY(frontCenter, sign * forkHalfSpacing), side, "derived", true, `vehicle-hp:front-axle-${mate}`);
    addMember(context, `vehicle-member:fork-${side}`, `Telescopic fork leg ${side}`, "suspension", `vehicle-hp:fork-lower-${side}`, `vehicle-hp:front-axle-${side}`, 0.016);
  }
  addMember(context, "vehicle-member:head", "Steering head axis", "steering", "vehicle-hp:head-lower", "vehicle-hp:head-upper", 0.022);
  addMember(context, "vehicle-member:steering-axis", "Steering axis construction", "steering", "vehicle-hp:steering-axis-ground", "vehicle-hp:head-upper", 0.004, "construction");
  addMember(context, "vehicle-member:triple-lower", "Lower triple clamp", "steering", "vehicle-hp:fork-lower-left", "vehicle-hp:fork-lower-right", 0.018);
  addMember(context, "vehicle-member:triple-upper", "Upper triple clamp", "steering", "vehicle-hp:fork-upper-left", "vehicle-hp:fork-upper-right", 0.018);
  addPoint(context, "vehicle-hp:handlebar-left", "Handlebar left grip", "steering", offsetY(headUpper, 0.36), "left", "authored", false, "vehicle-hp:handlebar-right");
  addPoint(context, "vehicle-hp:handlebar-right", "Handlebar right grip", "steering", offsetY(headUpper, -0.36), "right", "authored", false, "vehicle-hp:handlebar-left");
  addMember(context, "vehicle-member:handlebar", "Handlebar planning axis", "steering", "vehicle-hp:handlebar-left", "vehicle-hp:handlebar-right", 0.012);
  context.wheels.push({ id: "front", label: "Front", axle: "front", side: "center", centerHardpointId: "vehicle-hp:front-axle", radiusM: p.frontLoadedRadiusM, widthM: p.frontTireWidthM, steerRad: 0, camberRad: 0 });

  const closestOnAxis = add3(frontCenter, scale3(normalDirection, -p.forkNormalOffsetM));
  const offsetResidual = pointLineDistance(frontCenter, [axisGroundX, 0, 0], slideDirection) - p.forkNormalOffsetM;
  addCheck(context, "fork-offset", "Fork normal offset invariant", Math.abs(offsetResidual) <= GEOMETRY_TOLERANCE_M ? "pass" : "fail", millimeters(pointLineDistance(frontCenter, [axisGroundX, 0, 0], slideDirection)), `${millimeters(p.forkNormalOffsetM)} input`);
  const collinearResidual = pointLineDistance(closestOnAxis, [axisGroundX, 0, 0], slideDirection);
  if (Math.abs(offsetResidual) > GEOMETRY_TOLERANCE_M || collinearResidual > GEOMETRY_TOLERANCE_M) context.errors.push("Front axle no longer satisfies the telescopic fork axis and normal-offset constraints.");
  if (trailM <= 0) context.errors.push("The entered rake, loaded radius, and fork offset produce non-positive mechanical trail.");
  return { camberChangeRad: null, idealInnerSteerRad: null, idealOuterSteerRad: null, modeledInnerSteerRad: null, modeledOuterSteerRad: null, ackermannErrorRad: null };
}

function buildTadpoleFrontGeometry(context: GeometryContext, intent: VehicleIntent, frontDeltaM: number): FrontGeometryResult {
  const p = intent.parameters;
  const halfTrack = p.trackM / 2;
  const inboard = p.frontSuspensionInboardHalfTrackM;
  if (inboard >= halfTrack - 0.06) context.errors.push("Front suspension inboard half-track must remain inside both front wheel centers with packaging clearance.");
  if (p.frontUpperArmHeightM <= p.frontLowerArmHeightM + 0.05) context.errors.push("Front upper-arm axis must remain above the lower-arm axis.");

  const centerRadius = p.wheelbaseM / Math.tan(p.steeringAngleRad);
  if (centerRadius <= halfTrack + 0.05) context.errors.push("The entered tadpole steering angle and track place the turn center inside the inner wheel clearance boundary.");
  const idealInner = Math.atan2(p.wheelbaseM, centerRadius - halfTrack);
  const idealOuter = Math.atan2(p.wheelbaseM, centerRadius + halfTrack);
  const modeledInner = p.steeringAngleRad + p.ackermannPercent * (idealInner - p.steeringAngleRad);
  const modeledOuter = p.steeringAngleRad + p.ackermannPercent * (idealOuter - p.steeringAngleRad);
  const ackermannError = (Math.abs(modeledInner - idealInner) + Math.abs(modeledOuter - idealOuter)) / 2;
  const camberChanges: number[] = [];
  const wheelCenters: Record<"left" | "right", Vec3> = { left: [0, 0, 0], right: [0, 0, 0] };

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    const mate = side === "left" ? "right" : "left";
    const designWheel: Vec3 = [p.wheelbaseM, sign * halfTrack, p.frontLoadedRadiusM];
    const axisGround: Vec3 = [p.wheelbaseM + p.frontLoadedRadiusM * Math.tan(p.casterRad), sign * (halfTrack - p.scrubRadiusM), 0];
    const lowerZ = p.frontLoadedRadiusM - 0.085;
    const upperZ = p.frontLoadedRadiusM + 0.185;
    const designLower: Vec3 = [axisGround[0] - lowerZ * Math.tan(p.casterRad), axisGround[1] - sign * lowerZ * Math.tan(p.kingpinInclinationRad), lowerZ];
    const designUpper: Vec3 = [axisGround[0] - upperZ * Math.tan(p.casterRad), axisGround[1] - sign * upperZ * Math.tan(p.kingpinInclinationRad), upperZ];
    const lowerInnerCenter: Vec3 = [designLower[0], sign * inboard, p.frontLowerArmHeightM];
    const upperInnerCenter: Vec3 = [designUpper[0], sign * inboard * 0.92, p.frontUpperArmHeightM];
    const lowerArmRadius = distanceYZ(lowerInnerCenter, designLower);
    const upperArmRadius = distanceYZ(upperInnerCenter, designUpper);
    const uprightRadiusYZ = distanceYZ(designLower, designUpper);
    const targetLowerZ = designLower[2] + frontDeltaM;
    const lowerRadicand = lowerArmRadius ** 2 - (targetLowerZ - lowerInnerCenter[2]) ** 2;
    if (lowerRadicand < -1e-10) context.errors.push(`Front ${side} lower arm cannot reach the selected suspension state.`);
    const currentLower: Vec3 = [designLower[0], lowerInnerCenter[1] + sign * Math.sqrt(Math.max(0, lowerRadicand)), targetLowerZ];
    const upperSolutions = circleIntersectionsYZ(upperInnerCenter, upperArmRadius, currentLower, uprightRadiusYZ);
    if (upperSolutions.length === 0) context.errors.push(`Front ${side} wishbone/upright chain has no solution at the selected state.`);
    const chosenUpperYZ = closestYZ(upperSolutions, designUpper) ?? [designUpper[1], designUpper[2]];
    const currentUpper: Vec3 = [designUpper[0], chosenUpperYZ[0], chosenUpperYZ[1]];
    const currentWheelYZ = rigidPointYZ(designLower, designUpper, designWheel, currentLower, currentUpper);
    const currentWheel: Vec3 = [p.wheelbaseM, currentWheelYZ[0], currentWheelYZ[1]];
    wheelCenters[side] = currentWheel;
    const designAngle = Math.atan2(designUpper[1] - designLower[1], designUpper[2] - designLower[2]);
    const currentAngle = Math.atan2(currentUpper[1] - currentLower[1], currentUpper[2] - currentLower[2]);
    const camberChange = sign * (currentAngle - designAngle);
    camberChanges.push(camberChange);

    addPoint(context, `vehicle-hp:front-${side}-wheel-center`, `Front ${side} wheel center`, "axle", currentWheel, side, "derived", true, `vehicle-hp:front-${mate}-wheel-center`);
    addPoint(context, `vehicle-hp:front-${side}-contact`, `Front ${side} tire contact reference`, "contact", [currentWheel[0], currentWheel[1], currentWheel[2] - p.frontLoadedRadiusM], side, "derived", true, `vehicle-hp:front-${mate}-contact`);
    addPoint(context, `vehicle-hp:front-${side}-kingpin-ground`, `Front ${side} kingpin ground intercept`, "steering", axisGround, side, "derived", false, `vehicle-hp:front-${mate}-kingpin-ground`);
    addPoint(context, `vehicle-hp:front-${side}-lbj`, `Front ${side} lower ball joint`, "suspension", currentLower, side, "derived", true, `vehicle-hp:front-${mate}-lbj`);
    addPoint(context, `vehicle-hp:front-${side}-ubj`, `Front ${side} upper ball joint`, "suspension", currentUpper, side, "derived", true, `vehicle-hp:front-${mate}-ubj`);
    for (const end of ["front", "rear"] as const) {
      const xOffset = end === "front" ? 0.12 : -0.12;
      addPoint(context, `vehicle-hp:front-${side}-lca-${end}`, `Front ${side} LCA chassis ${end}`, "suspension", [lowerInnerCenter[0] + xOffset, lowerInnerCenter[1], lowerInnerCenter[2]], side, "authored", false, `vehicle-hp:front-${mate}-lca-${end}`);
      addPoint(context, `vehicle-hp:front-${side}-uca-${end}`, `Front ${side} UCA chassis ${end}`, "suspension", [upperInnerCenter[0] + xOffset * 0.82, upperInnerCenter[1], upperInnerCenter[2]], side, "authored", false, `vehicle-hp:front-${mate}-uca-${end}`);
      addMember(context, `vehicle-member:front-${side}-lca-${end}`, `Front ${side} lower control arm ${end}`, "suspension", `vehicle-hp:front-${side}-lca-${end}`, `vehicle-hp:front-${side}-lbj`, 0.016);
      addMember(context, `vehicle-member:front-${side}-uca-${end}`, `Front ${side} upper control arm ${end}`, "suspension", `vehicle-hp:front-${side}-uca-${end}`, `vehicle-hp:front-${side}-ubj`, 0.014);
    }
    addMember(context, `vehicle-member:front-${side}-upright`, `Front ${side} upright / kingpin axis`, "suspension", `vehicle-hp:front-${side}-lbj`, `vehicle-hp:front-${side}-ubj`, 0.020);
    addMember(context, `vehicle-member:front-${side}-kingpin-axis`, `Front ${side} kingpin construction`, "steering", `vehicle-hp:front-${side}-kingpin-ground`, `vehicle-hp:front-${side}-ubj`, 0.004, "construction");

    const shockArm = lerp3(lowerInnerCenter, currentLower, 0.62);
    const shockChassis: Vec3 = [currentLower[0] - 0.10, sign * inboard * 0.78, p.frontUpperArmHeightM + 0.24];
    addPoint(context, `vehicle-hp:front-${side}-shock-arm`, `Front ${side} shock lower eye`, "suspension", shockArm, side, "derived", true, `vehicle-hp:front-${mate}-shock-arm`);
    addPoint(context, `vehicle-hp:front-${side}-shock-chassis`, `Front ${side} shock chassis eye`, "suspension", shockChassis, side, "authored", false, `vehicle-hp:front-${mate}-shock-chassis`);
    addMember(context, `vehicle-member:front-${side}-shock`, `Front ${side} spring-damper axis`, "suspension", `vehicle-hp:front-${side}-shock-arm`, `vehicle-hp:front-${side}-shock-chassis`, 0.014);

    const steerAngle = side === "left" ? modeledInner : modeledOuter;
    const steerArmOffset: readonly [number, number] = [-0.12, -sign * 0.045];
    const steerArm: Vec3 = [
      currentWheel[0] + steerArmOffset[0] * Math.cos(steerAngle) - steerArmOffset[1] * Math.sin(steerAngle),
      currentWheel[1] + steerArmOffset[0] * Math.sin(steerAngle) + steerArmOffset[1] * Math.cos(steerAngle),
      currentWheel[2] + 0.015
    ];
    const rackPoint: Vec3 = [p.wheelbaseM - 0.37, sign * inboard * 0.76, p.frontLowerArmHeightM + 0.08];
    addPoint(context, `vehicle-hp:front-${side}-steer-arm`, `Front ${side} steering-arm pickup`, "steering", steerArm, side, "derived", true, `vehicle-hp:front-${mate}-steer-arm`);
    addPoint(context, `vehicle-hp:rack-${side}`, `Rack inner joint ${side}`, "steering", rackPoint, side, "authored", false, `vehicle-hp:rack-${mate}`);
    addMember(context, `vehicle-member:tie-rod-${side}`, `Front ${side} tie-rod packaging line`, "steering", `vehicle-hp:rack-${side}`, `vehicle-hp:front-${side}-steer-arm`, 0.010);
    context.wheels.push({
      id: `front-${side}`, label: `Front ${side}`, axle: "front", side, centerHardpointId: `vehicle-hp:front-${side}-wheel-center`,
      radiusM: p.frontLoadedRadiusM, widthM: p.frontTireWidthM, steerRad: steerAngle + (side === "left" ? p.toeRad : -p.toeRad), camberRad: sign * camberChange
    });

    const lowerResidual = Math.abs(distanceYZ(lowerInnerCenter, currentLower) - lowerArmRadius);
    const upperResidual = Math.abs(distanceYZ(upperInnerCenter, currentUpper) - upperArmRadius);
    const uprightResidual = Math.abs(distanceYZ(currentLower, currentUpper) - uprightRadiusYZ);
    const maximumResidual = Math.max(lowerResidual, upperResidual, uprightResidual);
    addCheck(context, `front-${side}-closed-chain`, `Front ${side} wishbone closed chain`, maximumResidual <= GEOMETRY_TOLERANCE_M ? "pass" : "fail", millimeters(maximumResidual), `residual <= ${millimeters(GEOMETRY_TOLERANCE_M)}`);
    if (maximumResidual > GEOMETRY_TOLERANCE_M) context.errors.push(`Front ${side} wishbone closed-chain residual exceeds tolerance.`);
  }

  addPoint(context, "vehicle-hp:front-axle", "Front axle midpoint", "axle", averagePoints([wheelCenters.left, wheelCenters.right]), "center", "derived", true);
  addMember(context, "vehicle-member:steering-rack", "Steering rack planning axis", "steering", "vehicle-hp:rack-left", "vehicle-hp:rack-right", 0.014);
  addPoint(context, "vehicle-hp:steering-column-upper", "Steering column upper datum", "steering", [p.wheelbaseM * 0.64, 0, 0.86], "center", "authored", false);
  addPoint(context, "vehicle-hp:steering-rack-center", "Steering rack center", "steering", averagePoints([requirePoint(context, "vehicle-hp:rack-left").positionM, requirePoint(context, "vehicle-hp:rack-right").positionM]), "center", "derived", false);
  addMember(context, "vehicle-member:steering-column", "Steering column packaging axis", "steering", "vehicle-hp:steering-column-upper", "vehicle-hp:steering-rack-center", 0.014);
  const camberChange = camberChanges.reduce((sum, value) => sum + value, 0) / Math.max(1, camberChanges.length);
  addCheck(context, "ackermann-target", "Ideal Ackermann target blend", ackermannError <= degrees(0.5) ? "pass" : "review", `${formatDegrees(modeledInner)} inner / ${formatDegrees(modeledOuter)} outer`, `${formatDegrees(idealInner)} / ${formatDegrees(idealOuter)} ideal`);
  return { camberChangeRad: camberChange, idealInnerSteerRad: idealInner, idealOuterSteerRad: idealOuter, modeledInnerSteerRad: modeledInner, modeledOuterSteerRad: modeledOuter, ackermannErrorRad: ackermannError };
}

function buildRearGeometry(context: GeometryContext, intent: VehicleIntent, topology: VehicleTopology, rearDeltaM: number): RearGeometryResult {
  const p = intent.parameters;
  const pivot: Vec3 = [p.rearSwingarmPivotFromRearM, 0, p.rearSwingarmPivotHeightM];
  const designRear: Vec3 = [0, 0, p.rearLoadedRadiusM];
  const swingarmLengthM = distance3(pivot, designRear);
  const rearZ = p.rearLoadedRadiusM + rearDeltaM;
  const radicand = swingarmLengthM ** 2 - (rearZ - pivot[2]) ** 2;
  if (radicand < -1e-10) context.errors.push("Rear suspension cannot reach the selected state with the entered pivot and travel.");
  const rearCenter: Vec3 = [pivot[0] - Math.sqrt(Math.max(0, radicand)), 0, rearZ];
  const shockLowerCenter = armAttachedPoint(pivot, rearCenter, p.rearShockArmRatio, 0.035);
  const shockUpperCenter: Vec3 = [p.rearShockUpperFromRearM, 0, p.rearShockUpperHeightM];
  const shockLengthM = distance3(shockLowerCenter, shockUpperCenter);
  addPoint(context, "vehicle-hp:rear-axle", "Rear axle center", "axle", rearCenter, "center", "derived", true);
  addPoint(context, "vehicle-hp:swing-pivot", topology.rearSuspension === "unit-swing" ? "Unit-swing pivot" : topology.rearSuspension === "trailing-arm-beam" ? "Rear beam pivot center" : "Rear swingarm pivot", "suspension", pivot, "center", "authored", false);

  let powertrainPointM: Vec3 | null = null;
  if (topology.rearWheelCount === 2) {
    const pivotHalfTrack = p.trackM * 0.34;
    const shockHalfTrack = p.trackM * 0.36;
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const mate = side === "left" ? "right" : "left";
      const wheelCenter = offsetY(rearCenter, sign * p.trackM / 2);
      addPoint(context, `vehicle-hp:rear-${side}-wheel-center`, `Rear ${side} wheel center`, "axle", wheelCenter, side, "derived", true, `vehicle-hp:rear-${mate}-wheel-center`);
      addPoint(context, `vehicle-hp:rear-${side}-contact`, `Rear ${side} tire contact reference`, "contact", [wheelCenter[0], wheelCenter[1], wheelCenter[2] - p.rearLoadedRadiusM], side, "derived", true, `vehicle-hp:rear-${mate}-contact`);
      addPoint(context, `vehicle-hp:rear-${side}-pivot`, `Rear ${side} trailing-arm pivot`, "suspension", offsetY(pivot, sign * pivotHalfTrack), side, "authored", false, `vehicle-hp:rear-${mate}-pivot`);
      addPoint(context, `vehicle-hp:rear-${side}-shock-arm`, `Rear ${side} shock lower eye`, "suspension", offsetY(shockLowerCenter, sign * shockHalfTrack), side, "derived", true, `vehicle-hp:rear-${mate}-shock-arm`);
      addPoint(context, `vehicle-hp:rear-${side}-shock-frame`, `Rear ${side} shock upper eye`, "suspension", offsetY(shockUpperCenter, sign * shockHalfTrack), side, "authored", false, `vehicle-hp:rear-${mate}-shock-frame`);
      addMember(context, `vehicle-member:rear-trailing-arm-${side}`, `Rear ${side} trailing arm`, "suspension", `vehicle-hp:rear-${side}-pivot`, `vehicle-hp:rear-${side}-wheel-center`, 0.024);
      addMember(context, `vehicle-member:rear-shock-${side}`, `Rear ${side} spring-damper axis`, "suspension", `vehicle-hp:rear-${side}-shock-arm`, `vehicle-hp:rear-${side}-shock-frame`, 0.014);
      context.wheels.push({ id: `rear-${side}`, label: `Rear ${side}`, axle: "rear", side, centerHardpointId: `vehicle-hp:rear-${side}-wheel-center`, radiusM: p.rearLoadedRadiusM, widthM: p.rearTireWidthM, steerRad: 0, camberRad: 0 });
    }
    addMember(context, "vehicle-member:rear-beam", "Rigid rear axle beam", "suspension", "vehicle-hp:rear-left-wheel-center", "vehicle-hp:rear-right-wheel-center", 0.027);
  } else {
    const swingHalfWidth = Math.max(0.07, p.rearTireWidthM * 0.52);
    addPoint(context, "vehicle-hp:rear-contact", "Rear tire contact reference", "contact", [rearCenter[0], 0, rearCenter[2] - p.rearLoadedRadiusM], "center", "derived", true);
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const mate = side === "left" ? "right" : "left";
      addPoint(context, `vehicle-hp:swing-pivot-${side}`, `Rear swingarm pivot ${side}`, "suspension", offsetY(pivot, sign * swingHalfWidth), side, "authored", false, `vehicle-hp:swing-pivot-${mate}`);
      addPoint(context, `vehicle-hp:rear-axle-${side}`, `Rear axle ${side} end`, "axle", offsetY(rearCenter, sign * swingHalfWidth), side, "derived", true, `vehicle-hp:rear-axle-${mate}`);
      addMember(context, `vehicle-member:rear-swing-${side}`, `Rear swingarm ${side}`, "suspension", `vehicle-hp:swing-pivot-${side}`, `vehicle-hp:rear-axle-${side}`, 0.022);
    }
    addPoint(context, "vehicle-hp:rear-shock-arm", "Rear shock lower eye", "suspension", shockLowerCenter, "center", "derived", true);
    addPoint(context, "vehicle-hp:rear-shock-frame", "Rear shock upper eye", "suspension", shockUpperCenter, "center", "authored", false);
    addMember(context, "vehicle-member:rear-shock", "Rear spring-damper axis", "suspension", "vehicle-hp:rear-shock-arm", "vehicle-hp:rear-shock-frame", 0.014);
    context.wheels.push({ id: "rear", label: "Rear", axle: "rear", side: "center", centerHardpointId: "vehicle-hp:rear-axle", radiusM: p.rearLoadedRadiusM, widthM: p.rearTireWidthM, steerRad: 0, camberRad: 0 });
    if (topology.rearSuspension === "unit-swing") {
      const unitFront = armAttachedPoint(pivot, rearCenter, 0.30, -0.055);
      const unitRear = armAttachedPoint(pivot, rearCenter, 0.72, -0.055);
      powertrainPointM = averagePoints([unitFront, unitRear]);
      addPoint(context, "vehicle-hp:unit-case-front", "Unit-swing powertrain front datum", "powertrain", unitFront, "center", "derived", true);
      addPoint(context, "vehicle-hp:unit-case-rear", "Unit-swing powertrain rear datum", "powertrain", unitRear, "center", "derived", true);
      addMember(context, "vehicle-member:unit-swing-case", "Unit-swing engine / CVT axis", "powertrain", "vehicle-hp:unit-case-front", "vehicle-hp:unit-case-rear", 0.045);
    }
  }
  const swingResidual = Math.abs(distance3(pivot, rearCenter) - swingarmLengthM);
  addCheck(context, "rear-swing-length", "Rigid rear arm length", swingResidual <= GEOMETRY_TOLERANCE_M ? "pass" : "fail", `${millimeters(distance3(pivot, rearCenter))}; residual ${millimeters(swingResidual)}`, `${millimeters(swingarmLengthM)} design`);
  if (swingResidual > GEOMETRY_TOLERANCE_M) context.errors.push("Rear swingarm length is not invariant across the selected state.");
  return { swingarmLengthM, shockLengthM, powertrainPointM };
}

function buildChassisGeometry(context: GeometryContext, intent: VehicleIntent, topology: VehicleTopology, movingPowertrainPointM: Vec3 | null): void {
  const p = intent.parameters;
  const seat: Vec3 = [p.wheelbaseM * (intent.kind === "three-wheeler" ? 0.43 : 0.37), 0, intent.kind === "scooter" ? 0.72 : intent.kind === "three-wheeler" ? 0.78 : 0.80];
  addPoint(context, "vehicle-hp:seat", "Rider / operator reference", "frame", seat, "center", "authored", false);
  addPoint(context, "vehicle-hp:cg", "Combined CG input", "cg", [p.cgFromRearM, 0, p.cgHeightM], "center", "authored", false);
  const powertrain: Vec3 = movingPowertrainPointM ?? [p.wheelbaseM * 0.42, 0, intent.kind === "three-wheeler" ? 0.40 : 0.38];
  addPoint(context, "vehicle-hp:powertrain", intent.powertrain === "electric" ? "Motor / battery package datum" : intent.kind === "scooter" ? "Unit-swing engine / CVT datum" : "Engine / gearbox datum", "powertrain", powertrain, "center", movingPowertrainPointM === null ? "authored" : "derived", movingPowertrainPointM !== null);

  if (topology.frame === "diamond-cradle") {
    addPoint(context, "vehicle-hp:frame-upper-rear", "Frame upper rear node", "frame", [p.wheelbaseM * 0.31, 0, 0.70], "center", "authored", false);
    addPoint(context, "vehicle-hp:frame-lower-rear", "Frame lower rear node", "frame", [p.rearSwingarmPivotFromRearM, 0, 0.36], "center", "authored", false);
    addMember(context, "vehicle-member:frame-top", "Frame top member", "chassis", "vehicle-hp:frame-upper-rear", "vehicle-hp:head-upper", 0.022);
    addMember(context, "vehicle-member:frame-front", "Frame front member", "chassis", "vehicle-hp:head-lower", "vehicle-hp:powertrain", 0.022);
    addMember(context, "vehicle-member:frame-lower", "Frame lower cradle", "chassis", "vehicle-hp:powertrain", "vehicle-hp:frame-lower-rear", 0.022);
    addMember(context, "vehicle-member:frame-rear", "Frame rear member", "chassis", "vehicle-hp:frame-lower-rear", "vehicle-hp:frame-upper-rear", 0.022);
    addMember(context, "vehicle-member:seat-stay", "Seat support", "chassis", "vehicle-hp:seat", "vehicle-hp:frame-lower-rear", 0.018);
  } else if (topology.frame === "step-through-underbone") {
    addPoint(context, "vehicle-hp:underbone-rear", "Underbone rear node", "frame", [p.wheelbaseM * 0.39, 0, 0.38], "center", "authored", false);
    addPoint(context, "vehicle-hp:underbone-front", "Underbone front node", "frame", [p.wheelbaseM * 0.71, 0, 0.40], "center", "authored", false);
    addPoint(context, "vehicle-hp:seat-base", "Seat base node", "frame", [p.wheelbaseM * 0.36, 0, 0.66], "center", "authored", false);
    addMember(context, "vehicle-member:underbone-low", "Step-through underbone", "chassis", "vehicle-hp:underbone-rear", "vehicle-hp:underbone-front", 0.027);
    addMember(context, "vehicle-member:underbone-head", "Underbone head rise", "chassis", "vehicle-hp:underbone-front", "vehicle-hp:head-lower", 0.024);
    addMember(context, "vehicle-member:underbone-seat", "Seat tower", "chassis", "vehicle-hp:underbone-rear", "vehicle-hp:seat-base", 0.024);
    addMember(context, "vehicle-member:seat-base", "Seat planning axis", "chassis", "vehicle-hp:seat-base", "vehicle-hp:seat", 0.018);
  } else {
    const railHalf = Math.max(0.24, p.trackM * 0.27);
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const mate = side === "left" ? "right" : "left";
      addPoint(context, `vehicle-hp:rail-rear-${side}`, `Frame rail rear ${side}`, "frame", [0.12, sign * railHalf, 0.35], side, "authored", false, `vehicle-hp:rail-rear-${mate}`);
      addPoint(context, `vehicle-hp:rail-front-${side}`, `Frame rail front ${side}`, "frame", [p.wheelbaseM * 0.78, sign * railHalf, 0.43], side, "authored", false, `vehicle-hp:rail-front-${mate}`);
      addMember(context, `vehicle-member:rail-${side}`, `Longitudinal frame rail ${side}`, "chassis", `vehicle-hp:rail-rear-${side}`, `vehicle-hp:rail-front-${side}`, 0.025);
    }
    addMember(context, "vehicle-member:cross-rear", "Rear frame crossmember", "chassis", "vehicle-hp:rail-rear-left", "vehicle-hp:rail-rear-right", 0.025);
    addMember(context, "vehicle-member:cross-front", "Front frame crossmember", "chassis", "vehicle-hp:rail-front-left", "vehicle-hp:rail-front-right", 0.025);
    addPoint(context, "vehicle-hp:seat-base", "Operator seat base", "frame", [seat[0], 0, seat[2] - 0.12], "center", "authored", false);
    addMember(context, "vehicle-member:seat-support", "Operator seat support", "chassis", "vehicle-hp:seat-base", "vehicle-hp:seat", 0.022);
  }
}

function vehicle(name: string, template: VehicleTemplateId, kind: VehicleIntent["kind"], powertrain: VehicleIntent["powertrain"], layout: VehicleIntent["layout"], parameters: VehicleParameters): VehicleIntent {
  return {
    id: "vehicle:primary", name, template, kind, powertrain, layout, state: "design-ride", parameters,
    layers: { ...DEFAULT_LAYERS }, inputStatus: "illustrative-unvalidated", tireDataStatus: "unverified", brakeDataStatus: "unverified",
    notes: [
      "ORIGINAL GENERIC VEHICLE KINEMATIC PACKAGE - NO OEM GEOMETRY, BRANDING, MATERIAL, SECTION, OR PERFORMANCE CLAIM.",
      "PRELIMINARY ENGINEERING AND LEARNING CALCULATIONS ONLY; USER INPUTS AND SIMPLIFIED MODELS REQUIRE QUALIFIED REVIEW.",
      "DO NOT FABRICATE OR OPERATE A VEHICLE FROM THIS PREVIEW. VERIFY STRUCTURE, TIRES, RIMS, BRAKES, CONTROLS, ELECTRICAL SAFETY, LOADS, TESTS, AND CURRENT JURISDICTION RULES."
    ]
  };
}

function commonParameters(): VehicleParameters {
  return {
    wheelbaseM: 1.40, frontLoadedRadiusM: 0.30, rearLoadedRadiusM: 0.305, frontRollingRadiusM: 0.304, rearRollingRadiusM: 0.309,
    frontTireWidthM: 0.12, rearTireWidthM: 0.16, trackM: 0, rakeRad: degrees(25), forkNormalOffsetM: 0.045,
    casterRad: degrees(7), kingpinInclinationRad: degrees(10), scrubRadiusM: 0.02, toeRad: 0, ackermannPercent: 1,
    steeringAngleRad: degrees(32), rearSwingarmPivotFromRearM: 0.48, rearSwingarmPivotHeightM: 0.49,
    rearShockUpperFromRearM: 0.68, rearShockUpperHeightM: 0.79, rearShockArmRatio: 0.58,
    frontSuspensionInboardHalfTrackM: 0.24, frontLowerArmHeightM: 0.22, frontUpperArmHeightM: 0.48,
    frontTravelM: 0.12, rearTravelM: 0.12, frontSagM: 0.034, rearSagM: 0.035, frontSpringRateNPerM: 10_000, rearSpringRateNPerM: 90_000,
    frontMotionRatio: 1, rearMotionRatio: 0.72, curbMassKg: 180, riderMassKg: 75, payloadKg: 0, cgFromRearM: 0.75, cgHeightM: 0.58,
    targetDecelerationMps2: 6, lateralAccelerationMps2: 3, tireFrictionCoefficient: 0.8,
    frontBrakeInputForceN: 120, rearBrakeInputForceN: 90, frontBrakeLeverRatio: 4, rearBrakeLeverRatio: 3.5,
    frontMasterCylinderDiameterM: 0.0127, rearMasterCylinderDiameterM: 0.0127, frontEquivalentClampAreaM2: 0.00229, rearEquivalentClampAreaM2: 0.0011,
    frontDiscCount: 2, rearDiscCount: 1, frontDiscEffectiveRadiusM: 0.105, rearDiscEffectiveRadiusM: 0.09,
    frontPadFrictionCoefficient: 0.4, rearPadFrictionCoefficient: 0.38, frontBrakeEfficiency: 0.86, rearBrakeEfficiency: 0.82,
    frontRatedPressurePa: 12_000_000, rearRatedPressurePa: 12_000_000, speedMps: 16.6667, reactionTimeS: 0.8, gradeRad: 0,
    driveTorqueNm: 38, finalDriveRatio: 4.5, drivelineEfficiency: 0.9, rollingResistanceCoefficient: 0.015,
    dragCoefficient: 0.62, frontalAreaSquareM: 0.58, airDensityKgPerCubicM: 1.225, batteryEnergyCapacityJ: 0,
    usableBatteryFraction: 0.9, energyConsumptionJPerM: 252
  };
}

interface GeometryContext {
  readonly hardpoints: VehicleHardPoint[];
  readonly members: VehicleGeometryMember[];
  readonly wheels: VehicleWheelPose[];
  readonly checks: VehicleGeometryCheck[];
  readonly errors: string[];
  readonly byId: Map<string, VehicleHardPoint>;
}

interface FrontGeometryResult {
  readonly camberChangeRad: number | null;
  readonly idealInnerSteerRad: number | null;
  readonly idealOuterSteerRad: number | null;
  readonly modeledInnerSteerRad: number | null;
  readonly modeledOuterSteerRad: number | null;
  readonly ackermannErrorRad: number | null;
}

interface RearGeometryResult {
  readonly swingarmLengthM: number;
  readonly shockLengthM: number;
  readonly powertrainPointM: Vec3 | null;
}

function createGeometryContext(): GeometryContext {
  return { hardpoints: [], members: [], wheels: [], checks: [], errors: [], byId: new Map() };
}

function addPoint(context: GeometryContext, id: string, label: string, category: VehicleHardPoint["category"], positionM: Vec3, side: VehicleSide, source: VehicleHardPoint["source"], stateDependent: boolean, symmetryMateId?: string): void {
  if (context.byId.has(id)) {
    context.errors.push(`Duplicate vehicle hardpoint ${id}.`);
    return;
  }
  const point: VehicleHardPoint = { id, label, category, positionM, side, source, stateDependent, ...(symmetryMateId === undefined ? {} : { symmetryMateId }) };
  context.hardpoints.push(point);
  context.byId.set(id, point);
}

function addMember(context: GeometryContext, id: string, label: string, layer: VehicleLayerId, fromHardpointId: string, toHardpointId: string, radiusM: number, style: VehicleGeometryMember["style"] = "solid"): void {
  context.members.push({ id, label, layer, fromHardpointId, toHardpointId, radiusM, style });
}

function addCheck(context: GeometryContext, id: string, label: string, status: VehicleGeometryCheck["status"], measured: string, requirement: string): void {
  context.checks.push({ id, label, status, measured, requirement });
  if (status === "fail" && !context.errors.some((error) => error.includes(label))) context.errors.push(`${label} failed its geometry invariant.`);
}

function requirePoint(context: GeometryContext, id: string): VehicleHardPoint {
  const point = context.byId.get(id);
  if (point === undefined) throw new Error(`Vehicle hardpoint ${id} is missing.`);
  return point;
}

function hydraulicPressure(forceN: number, ratio: number, diameterM: number): number {
  const area = Math.PI * diameterM ** 2 / 4;
  return area > 0 ? forceN * ratio / area : Number.POSITIVE_INFINITY;
}

function suspensionDelta(state: VehicleIntent["state"], travelM: number, sagM: number): number {
  if (state === "full-droop") return -sagM;
  if (state === "full-bump") return travelM - sagM;
  return 0;
}

function axleLoads(p: VehicleParameters, totalMassKg: number, decelerationMps2: number): { normalTotalN: number; staticFrontN: number; staticRearN: number; frontN: number; rearN: number } {
  const normalTotalN = totalMassKg * G * Math.cos(p.gradeRad);
  const staticDemandN = totalMassKg * (0 - G * Math.sin(p.gradeRad));
  const demandN = totalMassKg * (decelerationMps2 - G * Math.sin(p.gradeRad));
  const staticFrontN = (p.cgFromRearM * normalTotalN + p.cgHeightM * staticDemandN) / p.wheelbaseM;
  const staticRearN = normalTotalN - staticFrontN;
  const frontN = (p.cgFromRearM * normalTotalN + p.cgHeightM * demandN) / p.wheelbaseM;
  return { normalTotalN, staticFrontN, staticRearN, frontN, rearN: normalTotalN - frontN };
}

function solveBrakeState(p: VehicleParameters, massKg: number, frontHardwareN: number, rearHardwareN: number): {
  readonly decelerationMps2: number; readonly loads: ReturnType<typeof axleLoads>; readonly frontForceN: number; readonly rearForceN: number;
  readonly availableFrontForceN: number; readonly availableRearForceN: number;
  readonly frontLongitudinalCapacityN: number; readonly rearLongitudinalCapacityN: number; readonly frontUtilization: number | null; readonly rearUtilization: number | null;
} {
  let deceleration = Math.max(0, Math.min(p.targetDecelerationMps2, (frontHardwareN + rearHardwareN) / massKg + G * Math.sin(p.gradeRad)));
  let loads = axleLoads(p, massKg, deceleration);
  let frontForceN = 0;
  let rearForceN = 0;
  let frontLongitudinalCapacityN = 0;
  let rearLongitudinalCapacityN = 0;
  let availableFrontForceN = 0;
  let availableRearForceN = 0;
  let frontLateralN = 0;
  let rearLateralN = 0;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    loads = axleLoads(p, massKg, deceleration);
    const positiveNormal = Math.max(1e-9, loads.frontN) + Math.max(1e-9, loads.rearN);
    frontLateralN = massKg * Math.abs(p.lateralAccelerationMps2) * Math.max(0, loads.frontN) / positiveNormal;
    rearLateralN = massKg * Math.abs(p.lateralAccelerationMps2) * Math.max(0, loads.rearN) / positiveNormal;
    frontLongitudinalCapacityN = frictionEllipseLongitudinalCapacity(p.tireFrictionCoefficient, loads.frontN, frontLateralN);
    rearLongitudinalCapacityN = frictionEllipseLongitudinalCapacity(p.tireFrictionCoefficient, loads.rearN, rearLateralN);
    availableFrontForceN = Math.max(0, Math.min(frontHardwareN, frontLongitudinalCapacityN));
    availableRearForceN = Math.max(0, Math.min(rearHardwareN, rearLongitudinalCapacityN));
    const requestedGroundForceN = Math.max(0, massKg * (p.targetDecelerationMps2 - G * Math.sin(p.gradeRad)));
    const availableGroundForceN = availableFrontForceN + availableRearForceN;
    const demandScale = availableGroundForceN > 0 ? Math.min(1, requestedGroundForceN / availableGroundForceN) : 0;
    frontForceN = availableFrontForceN * demandScale;
    rearForceN = availableRearForceN * demandScale;
    const next = Math.max(0, Math.min(p.targetDecelerationMps2, (frontForceN + rearForceN) / massKg + G * Math.sin(p.gradeRad)));
    if (Math.abs(next - deceleration) < 1e-9) { deceleration = next; break; }
    deceleration = 0.55 * deceleration + 0.45 * next;
  }
  loads = axleLoads(p, massKg, deceleration);
  const frontUtilization = tireUtilization(frontForceN, frontLateralN, p.tireFrictionCoefficient, loads.frontN);
  const rearUtilization = tireUtilization(rearForceN, rearLateralN, p.tireFrictionCoefficient, loads.rearN);
  return {
    decelerationMps2: deceleration,
    loads,
    frontForceN,
    rearForceN,
    availableFrontForceN,
    availableRearForceN,
    frontLongitudinalCapacityN,
    rearLongitudinalCapacityN,
    frontUtilization,
    rearUtilization
  };
}

function solveTractionState(p: VehicleParameters, massKg: number, topology: VehicleTopology, rawForceN: number, roadLoadN: number): {
  readonly usedForceN: number; readonly adhesionLimitN: number; readonly wheelLiftLimitMps2: number; readonly firstLimit: "source-input" | "adhesion" | "wheel-lift";
} {
  const wheelLiftLimitMps2 = Math.max(0, G * p.cgFromRearM / p.cgHeightM);
  let acceleration = 0;
  let adhesionLimitN = 0;
  let usedForceN = 0;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const loads = axleLoads(p, massKg, -acceleration);
    const drivenLoadN = topology.drivenAxle === "rear" ? loads.rearN : loads.frontN;
    const lateralShare = massKg * Math.abs(p.lateralAccelerationMps2) * Math.max(0, drivenLoadN) / Math.max(1e-9, loads.normalTotalN);
    adhesionLimitN = frictionEllipseLongitudinalCapacity(p.tireFrictionCoefficient, drivenLoadN, lateralShare);
    const wheelLiftForceN = roadLoadN + massKg * wheelLiftLimitMps2;
    usedForceN = Math.max(0, Math.min(rawForceN, adhesionLimitN, wheelLiftForceN));
    const next = (usedForceN - roadLoadN) / massKg;
    if (Math.abs(next - acceleration) < 1e-9) { acceleration = next; break; }
    acceleration = 0.55 * acceleration + 0.45 * next;
  }
  const wheelLiftForceN = roadLoadN + massKg * wheelLiftLimitMps2;
  const firstLimit = rawForceN <= adhesionLimitN + 1e-6 && rawForceN <= wheelLiftForceN + 1e-6 ? "source-input"
    : adhesionLimitN <= wheelLiftForceN + 1e-6 ? "adhesion" : "wheel-lift";
  return { usedForceN, adhesionLimitN, wheelLiftLimitMps2, firstLimit };
}

function frictionEllipseLongitudinalCapacity(mu: number, normalN: number, lateralN: number): number {
  const radius = Math.max(0, mu * normalN);
  return Math.sqrt(Math.max(0, radius ** 2 - lateralN ** 2));
}

function tireUtilization(longitudinalN: number, lateralN: number, mu: number, normalN: number): number | null {
  const capacity = mu * normalN;
  if (capacity > 1e-9) return Math.hypot(longitudinalN / capacity, lateralN / capacity);
  return Math.hypot(longitudinalN, lateralN) <= 1e-9 ? 0 : null;
}

function threeWheelSupport(intent: VehicleIntent, decelerationMps2: number, lateralAccelerationMps2: number, normalTotalN: number): { loads: readonly { contactId: string; loadN: number }[]; minimumLoadN: number; tipThresholdMps2: number | null } {
  const p = intent.parameters;
  const contacts = intent.layout === "delta-1f2r"
    ? [["vehicle-hp:front-contact", p.wheelbaseM, 0], ["vehicle-hp:rear-left-contact", 0, p.trackM / 2], ["vehicle-hp:rear-right-contact", 0, -p.trackM / 2]] as const
    : [["vehicle-hp:front-left-contact", p.wheelbaseM, p.trackM / 2], ["vehicle-hp:front-right-contact", p.wheelbaseM, -p.trackM / 2], ["vehicle-hp:rear-contact", 0, 0]] as const;
  const longitudinalDemandN = (p.curbMassKg + p.riderMassKg + p.payloadKg) * (decelerationMps2 - G * Math.sin(p.gradeRad));
  const lateralDemandN = (p.curbMassKg + p.riderMassKg + p.payloadKg) * lateralAccelerationMps2;
  const effectiveX = p.cgFromRearM + p.cgHeightM * longitudinalDemandN / Math.max(1e-9, normalTotalN);
  const effectiveY = -p.cgHeightM * lateralDemandN / Math.max(1e-9, normalTotalN);
  const weights = barycentric([effectiveX, effectiveY], contacts);
  const loads = contacts.map((contact, index) => ({ contactId: contact[0], loadN: weights[index]! * normalTotalN }));
  const direction = Math.sign(lateralAccelerationMps2) || 1;
  let low = 0;
  let high = 3 * G;
  const atHigh = barycentric([effectiveX, -p.cgHeightM * direction * (p.curbMassKg + p.riderMassKg + p.payloadKg) * high / Math.max(1e-9, normalTotalN)], contacts);
  if (Math.min(...atHigh) > 0) return { loads, minimumLoadN: Math.min(...loads.map((load) => load.loadN)), tipThresholdMps2: null };
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = (low + high) / 2;
    const candidate = barycentric([effectiveX, -p.cgHeightM * direction * (p.curbMassKg + p.riderMassKg + p.payloadKg) * mid / Math.max(1e-9, normalTotalN)], contacts);
    if (Math.min(...candidate) > 0) low = mid; else high = mid;
  }
  return { loads, minimumLoadN: Math.min(...loads.map((load) => load.loadN)), tipThresholdMps2: high };
}

function barycentric(point: readonly [number, number], triangle: readonly (readonly [string, number, number])[]): readonly [number, number, number] {
  const [, x1, y1] = triangle[0]!;
  const [, x2, y2] = triangle[1]!;
  const [, x3, y3] = triangle[2]!;
  const denominator = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denominator) < 1e-12) return [0, 0, 0];
  const l1 = ((y2 - y3) * (point[0] - x3) + (x3 - x2) * (point[1] - y3)) / denominator;
  const l2 = ((y3 - y1) * (point[0] - x3) + (x1 - x3) * (point[1] - y3)) / denominator;
  return [l1, l2, 1 - l1 - l2];
}

function armAttachedPoint(pivot: Vec3, axle: Vec3, ratio: number, normalOffsetM: number): Vec3 {
  const dx = axle[0] - pivot[0];
  const dz = axle[2] - pivot[2];
  const length = Math.hypot(dx, dz);
  const ex = length > 0 ? dx / length : 0;
  const ez = length > 0 ? dz / length : 0;
  return [pivot[0] + ratio * dx + normalOffsetM * ez, 0, pivot[2] + ratio * dz - normalOffsetM * ex];
}

function circleIntersectionsYZ(center0: Vec3, radius0: number, center1: Vec3, radius1: number): readonly (readonly [number, number])[] {
  const y0 = center0[1]; const z0 = center0[2]; const y1 = center1[1]; const z1 = center1[2];
  const dy = y1 - y0; const dz = z1 - z0; const distance = Math.hypot(dy, dz);
  if (distance < 1e-12 || distance > radius0 + radius1 + 1e-10 || distance < Math.abs(radius0 - radius1) - 1e-10) return [];
  const a = (radius0 ** 2 - radius1 ** 2 + distance ** 2) / (2 * distance);
  const h = Math.sqrt(Math.max(0, radius0 ** 2 - a ** 2));
  const baseY = y0 + a * dy / distance;
  const baseZ = z0 + a * dz / distance;
  return [[baseY - h * dz / distance, baseZ + h * dy / distance], [baseY + h * dz / distance, baseZ - h * dy / distance]];
}

function closestYZ(points: readonly (readonly [number, number])[], target: Vec3): readonly [number, number] | null {
  return points.reduce<readonly [number, number] | null>((best, point) => best === null || Math.hypot(point[0] - target[1], point[1] - target[2]) < Math.hypot(best[0] - target[1], best[1] - target[2]) ? point : best, null);
}

function rigidPointYZ(designA: Vec3, designB: Vec3, designPoint: Vec3, currentA: Vec3, currentB: Vec3): readonly [number, number] {
  const designDy = designB[1] - designA[1]; const designDz = designB[2] - designA[2];
  const designLength = Math.hypot(designDy, designDz);
  const duY = designDy / designLength; const duZ = designDz / designLength;
  const dnY = -duZ; const dnZ = duY;
  const wy = designPoint[1] - designA[1]; const wz = designPoint[2] - designA[2];
  const along = wy * duY + wz * duZ;
  const normal = wy * dnY + wz * dnZ;
  const currentDy = currentB[1] - currentA[1]; const currentDz = currentB[2] - currentA[2];
  const currentLength = Math.hypot(currentDy, currentDz);
  const cuY = currentDy / currentLength; const cuZ = currentDz / currentLength;
  const cnY = -cuZ; const cnZ = cuY;
  return [currentA[1] + along * cuY + normal * cnY, currentA[2] + along * cuZ + normal * cnZ];
}

function pointLineDistance(point: Vec3, linePoint: Vec3, lineDirection: Vec3): number {
  const relative = subtract3(point, linePoint);
  const projection = dot3(relative, lineDirection) / Math.max(1e-12, dot3(lineDirection, lineDirection));
  return distance3(relative, scale3(lineDirection, projection));
}

function averagePoints(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  const sum = points.reduce<Vec3>((acc, point) => add3(acc, point), [0, 0, 0]);
  return scale3(sum, 1 / points.length);
}

function trackOf(points: readonly Vec3[]): number {
  return points.length < 2 ? 0 : Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]));
}

function nearStatus(actual: number, target: number, tolerance: number): VehicleGeometryCheck["status"] {
  return Math.abs(actual - target) <= tolerance ? "pass" : "fail";
}

function distance3(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function distanceYZ(a: Vec3, b: Vec3): number { return Math.hypot(a[1] - b[1], a[2] - b[2]); }
function add3(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract3(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale3(a: Vec3, scale: number): Vec3 { return [a[0] * scale, a[1] * scale, a[2] * scale]; }
function dot3(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function offsetY(point: Vec3, offset: number): Vec3 { return [point[0], point[1] + offset, point[2]]; }
function lerp3(a: Vec3, b: Vec3, fraction: number): Vec3 { return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction, a[2] + (b[2] - a[2]) * fraction]; }
function millimeters(valueM: number): string { return `${Number((valueM * 1_000).toFixed(2))} mm`; }
function formatDegrees(valueRad: number): string { return `${Number((valueRad * 180 / Math.PI).toFixed(2))} deg`; }
function degrees(value: number): number { return value * Math.PI / 180; }
