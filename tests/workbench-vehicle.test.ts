import {
  analyzeVehicle,
  applyWorkbenchOperation,
  createVehicleTemplate,
  createWorkbenchProject,
  solveVehicleGeometry,
  validateWorkbenchProject,
  vehicleHardPoints,
  type Vec3,
  type VehicleGeometryModel,
  type VehicleIntent,
  type VehicleSimulationState,
  type VehicleTemplateId
} from "../packages/workbench-core/src/index.js";
import { buildVehiclePreview, type VehiclePreview } from "../packages/workbench-vehicle/src/index.js";
import { handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const TEMPLATES: readonly VehicleTemplateId[] = [
  "ice-road-motorcycle",
  "step-through-scooter",
  "ev-street-motorcycle",
  "delta-cargo-three-wheeler",
  "tadpole-geometry-three-wheeler"
];

const STATES: readonly VehicleSimulationState[] = ["full-droop", "design-ride", "full-bump"];

export const workbenchVehicleTests: readonly TestCase[] = [
  {
    name: "five original vehicle topology packages validate with a closed geometry gate",
    run: () => {
      const seeded = createWorkbenchProject("project:test-vehicle-templates");
      for (const template of TEMPLATES) {
        const vehicle = createVehicleTemplate(template);
        const valid = validateWorkbenchProject({ ...seeded, vehicle });
        assert(valid.ok, `${template} should satisfy the bounded vehicle schema`);
        const first = buildVehiclePreview(vehicle);
        const second = buildVehiclePreview(vehicle);
        equal(JSON.stringify(first), JSON.stringify(second), `${template} preview must be deterministic`);
        equal(first.geometry.schema, "ps3d-vehicle-geometry/2", `${template} must expose geometry schema 2`);
        equal(first.analysis.schema, "ps3d-vehicle-analysis/2", `${template} must expose analysis schema 2`);
        assert(first.scene.primitives.length >= 30, `${template} should include a substantial layered CAD skeleton`);
        assert(first.analysis.hardpoints.length >= 10, `${template} should expose an auditable hardpoint set`);
        const sceneIds = new Set(first.scene.primitives.map((primitive) => primitive.id));
        assert(first.geometry.hardpoints.every((point) => sceneIds.has(point.id)), `${template} hardpoint IDs must cross-probe the scene without translation`);
        equal(first.scene.primitives.filter((primitive) => primitive.id.startsWith("vehicle-brake:disc:")).length, vehicle.parameters.frontDiscCount + vehicle.parameters.rearDiscCount, `${template} preview must render the declared total axle disc count`);
        assertWheelAndBrakePoses(first, vehicle);
        assert(first.geometry.checks.every((check) => check.status !== "fail"), `${template} design state must pass every geometry invariant`);
        assert(first.geometry.errors.length === 0, `${template} design state must have no geometry errors`);
        assertBoundsContainGeometry(first.geometry, first.scene.boundsMm.min, first.scene.boundsMm.max, `${template} design preview`);
        assertBoundsContainPrimitives(first, `${template} design preview`);

        for (const state of STATES) {
          const stateIntent: VehicleIntent = { ...vehicle, state };
          const geometry = solveVehicleGeometry(stateIntent);
          equal(geometry.errors.length, 0, `${template} ${state} must solve without geometry errors`);
          assert(geometry.checks.every((check) => check.status !== "fail"), `${template} ${state} must not fail a geometry invariant`);
          assert(geometry.hardpoints.every((point) => point.positionM.every(Number.isFinite)), `${template} ${state} coordinates must be finite`);
          equal(new Set(geometry.hardpoints.map((point) => point.id)).size, geometry.hardpoints.length, `${template} ${state} hardpoint IDs must be unique`);
          const ids = new Set(geometry.hardpoints.map((point) => point.id));
          assert(geometry.members.every((member) => ids.has(member.fromHardpointId) && ids.has(member.toHardpointId)), `${template} ${state} members must resolve both endpoints`);
          assert(geometry.wheels.every((wheel) => ids.has(wheel.centerHardpointId)), `${template} ${state} wheel centers must resolve`);
          const statePreview = buildVehiclePreview(stateIntent);
          assertBoundsContainGeometry(geometry, statePreview.scene.boundsMm.min, statePreview.scene.boundsMm.max, `${template} ${state} preview`);
          assertBoundsContainPrimitives(statePreview, `${template} ${state} preview`);
        }

        const designContacts = first.geometry.hardpoints.filter((point) => point.category === "contact");
        assert(designContacts.length > 0, `${template} must define tire contact references`);
        assert(designContacts.every((point) => Math.abs(point.positionM[2]) <= 1e-9), `${template} design contacts must lie on the design ground plane`);
        const serialized = JSON.stringify(vehicle).toLowerCase();
        assert(!serialized.includes("partmode") && !serialized.includes("fusion 360"), "templates must remain independently implemented PS3D content");
        assert(vehicle.notes.some((note) => note.includes("NO OEM GEOMETRY")), "each template must explicitly reject implied OEM geometry");
        assert(vehicle.notes.some((note) => note.includes("DO NOT FABRICATE")), "each template must carry a fabrication boundary");
      }
    }
  },
  {
    name: "vehicle loads, brakes, stopping, spring rates, and powertrain point match independent equations",
    run: () => {
      const vehicle = createVehicleTemplate("ice-road-motorcycle");
      const p = vehicle.parameters;
      const analysis = analyzeVehicle(vehicle);
      assert(analysis.trailM !== null, "single-track topology must report trail");
      near(analysis.trailM, 0.0902402911, 1e-9, "mechanical trail should follow the declared rake/offset convention");
      near(analysis.staticFrontLoadN + analysis.staticRearLoadN, analysis.totalMassKg * 9.80665, 1e-8, "static axle loads should conserve normal load");
      near(analysis.brakingFrontLoadN + analysis.brakingRearLoadN, analysis.totalMassKg * 9.80665, 1e-8, "requested braking axle loads should conserve normal load");
      near(analysis.predictedBrakingFrontLoadN + analysis.predictedBrakingRearLoadN, analysis.totalMassKg * 9.80665, 1e-8, "achieved braking axle loads should conserve normal load");
      near(analysis.frontWheelRateNPerM, p.frontSpringRateNPerM * p.frontMotionRatio ** 2, 1e-9, "front wheel rate should use the declared motion-ratio convention");
      near(analysis.rearWheelRateNPerM, p.rearSpringRateNPerM * p.rearMotionRatio ** 2, 1e-9, "rear wheel rate should use the declared motion-ratio convention");
      near(analysis.frontAxleWheelRateNPerM, analysis.frontWheelRateNPerM, 1e-9, "single front wheel must equal front axle rate");
      const frontPressure = p.frontBrakeInputForceN * p.frontBrakeLeverRatio / (Math.PI * p.frontMasterCylinderDiameterM ** 2 / 4);
      near(analysis.frontHydraulicPressurePa, frontPressure, 1e-6, "hydraulic pressure must not apply mechanical efficiency");
      near(analysis.availableFrontBrakeTorqueNm, frontPressure * p.frontEquivalentClampAreaM2 * p.frontPadFrictionCoefficient * p.frontDiscEffectiveRadiusM * p.frontBrakeEfficiency * p.frontDiscCount, 1e-8, "brake efficiency must be applied exactly once at torque");
      assert(analysis.predictedBrakeDecelerationMps2 <= p.targetDecelerationMps2 + 1e-9, "reported achieved deceleration must never exceed requested demand");
      near(analysis.predictedBrakeDecelerationMps2, p.targetDecelerationMps2, 1e-7, "seed hardware should meet, not exceed, requested braking demand");
      assert(analysis.brakingDistanceM !== null && analysis.totalStoppingDistanceM !== null, "a moving seed case with achieved deceleration must have finite stopping distances");
      near(analysis.brakingDistanceM, p.speedMps ** 2 / (2 * analysis.predictedBrakeDecelerationMps2), 1e-9, "braking distance must use achieved deceleration");
      near(analysis.totalStoppingDistanceM, analysis.brakingDistanceM + p.speedMps * p.reactionTimeS, 1e-9, "total distance must add reaction distance explicitly");
      assert(analysis.frontCombinedTireUtilization !== null && analysis.rearCombinedTireUtilization !== null, "seed tire utilization must be defined");
      assert(analysis.frontCombinedTireUtilization <= 1 + 1e-8 && analysis.rearCombinedTireUtilization <= 1 + 1e-8, "combined tire ellipse utilization must remain bounded");
      equal(analysis.firstBrakeLimit, "none", "seed case should meet the requested brake event without a first limit");
      near(analysis.wheelSpeedRpm, p.speedMps / p.rearRollingRadiusM * 60 / (2 * Math.PI), 1e-9, "wheel RPM must use driven rolling radius");
      near(analysis.sourceSpeedRpm, analysis.wheelSpeedRpm * p.finalDriveRatio, 1e-9, "source RPM must use total reduction");
      near(analysis.sourcePowerW, p.driveTorqueNm * analysis.sourceSpeedRpm * 2 * Math.PI / 60, 1e-8, "source power must match the declared torque operating point");
      assert(p.frontRollingRadiusM > p.frontLoadedRadiusM && p.rearRollingRadiusM > p.rearLoadedRadiusM, "seed rolling radii must exceed static loaded radii");

      const rest = analyzeVehicle({ ...vehicle, parameters: { ...p, speedMps: 0, gradeRad: 0 } });
      near(rest.roadLoadN, 0, 1e-12, "a zero-speed level-road operating point must not invent rolling road load");
      const zeroDemand = analyzeVehicle({ ...vehicle, parameters: { ...p, targetDecelerationMps2: 0, steeringAngleRad: 0 } });
      equal(zeroDemand.turningRadiusM, null, "straight-ahead steering must use an explicit null rather than JSON-unsafe infinity");
      equal(zeroDemand.brakingDistanceM, null, "a moving zero-deceleration case must report no finite braking distance");
      equal(zeroDemand.totalStoppingDistanceM, null, "a moving zero-deceleration case must report no finite total stopping distance");
      assertJsonSafeNumbers(zeroDemand, "zero-demand analysis");
      const stationaryZeroDemand = analyzeVehicle({ ...vehicle, parameters: { ...p, speedMps: 0, targetDecelerationMps2: 0, steeringAngleRad: 0 } });
      equal(stationaryZeroDemand.brakingDistanceM, 0, "a stationary zero-demand case has zero braking distance");
      equal(stationaryZeroDemand.totalStoppingDistanceM, 0, "a stationary zero-demand case has zero total distance");
      assertJsonSafeNumbers(stationaryZeroDemand, "stationary zero-demand analysis");
    }
  },
  {
    name: "suspension state solvers preserve fork, swingarm, wishbone, upright, and unit-swing constraints",
    run: () => {
      for (const template of TEMPLATES) {
        const base = createVehicleTemplate(template);
        const geometries = STATES.map((state) => solveVehicleGeometry({ ...base, state }));
        for (const geometry of geometries) assert(geometry.checks.every((check) => check.status !== "fail"), `${template} state must preserve declared constraints`);
        const designLength = geometries[1]!.rearSwingarmLengthM;
        for (const geometry of geometries) near(geometry.rearSwingarmLengthM, designLength, 1e-12, `${template} rear arm design length must remain invariant`);
        if (base.layout !== "tadpole-2f1r") {
          for (const geometry of geometries) equal(geometry.checks.find((check) => check.id === "fork-offset")?.status, "pass", `${template} fork offset must remain invariant`);
        }
      }

      const tadpole = createVehicleTemplate("tadpole-geometry-three-wheeler");
      const tadpoleGeometries = STATES.map((state) => solveVehicleGeometry({ ...tadpole, state }));
      const constrainedMembers = tadpoleGeometries[1]!.members.filter((member) => /-(?:lca|uca)-|upright/.test(member.id));
      for (const member of constrainedMembers) {
        const baseline = memberLength(tadpoleGeometries[1]!, member.id);
        for (const geometry of tadpoleGeometries) near(memberLength(geometry, member.id), baseline, 1e-8, `${member.id} must remain a rigid closed-chain link`);
      }
      for (const geometry of tadpoleGeometries) {
        equal(geometry.checks.find((check) => check.id === "front-left-closed-chain")?.status, "pass", "left wishbone closed chain must pass");
        equal(geometry.checks.find((check) => check.id === "front-right-closed-chain")?.status, "pass", "right wishbone closed chain must pass");
        assertMirrored(geometry, "vehicle-hp:front-left-wheel-center", "vehicle-hp:front-right-wheel-center");
      }

      const scooter = createVehicleTemplate("step-through-scooter");
      const scooterGeometries = STATES.map((state) => solveVehicleGeometry({ ...scooter, state }));
      const unitLength = memberLength(scooterGeometries[1]!, "vehicle-member:unit-swing-case");
      for (const geometry of scooterGeometries) near(memberLength(geometry, "vehicle-member:unit-swing-case"), unitLength, 1e-9, "scooter engine/CVT package must rotate as a rigid unit-swing member");

      const ride = createVehicleTemplate("ev-street-motorcycle");
      const droop: VehicleIntent = { ...ride, state: "full-droop" };
      const bump: VehicleIntent = { ...ride, state: "full-bump" };
      const rideFront = vehicleHardPoints(ride).find((point) => point.id === "vehicle-hp:front-axle")!;
      const droopFront = vehicleHardPoints(droop).find((point) => point.id === "vehicle-hp:front-axle")!;
      const bumpFront = vehicleHardPoints(bump).find((point) => point.id === "vehicle-hp:front-axle")!;
      assert(droopFront.positionM[2] < rideFront.positionM[2] && bumpFront.positionM[2] > rideFront.positionM[2], "front axle should move along the fork axis across suspension states");

      const project = createWorkbenchProject("project:test-vehicle-operations");
      const template = applyWorkbenchOperation(project, { kind: "apply-vehicle-template", operationId: "operation:test-vehicle-ev", expectedRevision: 0, template: "ev-street-motorcycle" });
      assert(template.ok, "vehicle template operation should apply");
      const state = applyWorkbenchOperation(template.value.project, { kind: "set-vehicle-simulation-state", operationId: "operation:test-vehicle-bump", expectedRevision: 1, state: "full-bump" });
      assert(state.ok, "vehicle suspension state operation should apply");
      const layer = applyWorkbenchOperation(state.value.project, { kind: "toggle-vehicle-layer", operationId: "operation:test-vehicle-hardpoints", expectedRevision: 2, layer: "hardpoints" });
      assert(layer.ok, "vehicle layer operation should apply");
      equal(layer.value.project.revision, 3, "three vehicle edits should create three audit revisions");
      equal(layer.value.project.vehicle.layers.hardpoints, false, "hardpoint layer should persist as hidden");
      const preview = buildVehiclePreview(layer.value.project.vehicle);
      equal(preview.primitiveCountByLayer["hardpoints"], undefined, "hidden hardpoint layer should create no preview primitives");
      assert(preview.scene.primitives.every((primitive) => !primitive.id.startsWith("vehicle-hp:")), "hidden layer must not leak geometry");

      const reviewedVehicle: VehicleIntent = { ...ride, inputStatus: "user-reviewed", tireDataStatus: "supplier-reviewed", brakeDataStatus: "supplier-reviewed" };
      const reviewedProject = { ...createWorkbenchProject("project:test-vehicle-evidence-reset"), vehicle: reviewedVehicle };
      const tireEdit = applyWorkbenchOperation(reviewedProject, { kind: "set-vehicle-parameter", operationId: "operation:test-tire-edit", expectedRevision: 0, parameter: "frontTireWidthM", value: reviewedVehicle.parameters.frontTireWidthM + 0.001 });
      assert(tireEdit.ok, "reviewed tire edit should apply");
      equal(tireEdit.value.project.vehicle.inputStatus, "illustrative-unvalidated", "any vehicle parameter edit must reset general input review");
      equal(tireEdit.value.project.vehicle.tireDataStatus, "unverified", "tire parameter edit must reset supplier tire review");
      equal(tireEdit.value.project.vehicle.brakeDataStatus, "supplier-reviewed", "unrelated tire edit should preserve brake evidence status");
      const brakeEdit = applyWorkbenchOperation(tireEdit.value.project, { kind: "set-vehicle-parameter", operationId: "operation:test-brake-edit", expectedRevision: 1, parameter: "frontBrakeInputForceN", value: reviewedVehicle.parameters.frontBrakeInputForceN + 1 });
      assert(brakeEdit.ok, "reviewed brake edit should apply");
      equal(brakeEdit.value.project.vehicle.brakeDataStatus, "unverified", "brake parameter edit must reset supplier brake review");
    }
  },
  {
    name: "three-wheel steering and support-polygon screens are topology specific",
    run: () => {
      const delta = createVehicleTemplate("delta-cargo-three-wheeler");
      const stable = analyzeVehicle(delta);
      assert(stable.supportWheelLoadsN !== null && stable.minimumSupportLoadN !== null, "delta layout should produce three support loads");
      near(stable.supportWheelLoadsN.reduce((sum, load) => sum + load.loadN, 0), stable.totalMassKg * 9.80665, 1e-7, "support-wheel loads should conserve total normal load");
      assert(stable.minimumSupportLoadN > 0 && stable.approximateTipThresholdMps2 !== null && stable.approximateTipThresholdMps2 > 0, "seeded delta case should remain inside its triangular support polygon");
      equal(stable.steadyLeanAngleRad, null, "rigid three-wheel layout must not reuse a two-wheel lean formula");

      const liftCase: VehicleIntent = { ...delta, parameters: { ...delta.parameters, lateralAccelerationMps2: 15 } };
      const lifted = analyzeVehicle(liftCase);
      equal(lifted.status, "blocked", "a resultant outside the support triangle should fail closed");
      assert(lifted.errors.some((error) => error.includes("support polygon")), "blocked result should explain theoretical wheel lift");
      assertJsonSafeNumbers(lifted, "blocked support-polygon analysis");

      const tadpoleIntent = createVehicleTemplate("tadpole-geometry-three-wheeler");
      const tadpole = analyzeVehicle(tadpoleIntent);
      assert(tadpole.idealInnerSteerRad !== null && tadpole.idealOuterSteerRad !== null && tadpole.idealInnerSteerRad > tadpole.idealOuterSteerRad, "ideal Ackermann must steer the inner wheel farther than the outer wheel");
      assert(tadpole.modeledInnerSteerRad !== null && tadpole.modeledOuterSteerRad !== null && tadpole.modeledInnerSteerRad > tadpole.modeledOuterSteerRad, "modeled steering target must preserve inner/outer ordering");
      near(tadpole.frontTrackM, tadpoleIntent.parameters.trackM, 1e-9, "tadpole front track must follow the user input");
      equal(tadpole.trailM, null, "double-wishbone topology must not report motorcycle trail");
      for (const result of [stable, tadpole]) {
        assert(result.supportWheelLoadsN !== null, "three-wheel analysis must expose support loads");
        const contacts = new Set(result.hardpoints.filter((point) => point.category === "contact").map((point) => point.id));
        assert(result.supportWheelLoadsN.every((load) => contacts.has(load.contactId)), "every support reaction must resolve to an authoritative contact hardpoint ID");
      }
    }
  },
  {
    name: "impossible suspension states are rejected instead of clamped into plausible geometry",
    run: () => {
      const vehicle = createVehicleTemplate("ice-road-motorcycle");
      const impossibleBump: VehicleIntent = {
        ...vehicle,
        state: "full-bump",
        parameters: {
          ...vehicle.parameters,
          rearSwingarmPivotFromRearM: 0.10,
          rearSwingarmPivotHeightM: 0.15,
          rearTravelM: 0.40,
          rearSagM: 0.02
        }
      };
      const geometry = solveVehicleGeometry(impossibleBump);
      assert(geometry.errors.some((error) => error.includes("cannot reach")), "impossible rear state must expose a blocking kinematic error");
      const project = createWorkbenchProject("project:test-impossible-vehicle");
      const designStateWithBadEnvelope: VehicleIntent = { ...impossibleBump, state: "design-ride" };
      const validated = validateWorkbenchProject({ ...project, vehicle: designStateWithBadEnvelope });
      assert(!validated.ok, "design-state project validation must fail when an alternate suspension envelope is unreachable");

      const incompleteParameters = Object.fromEntries(Object.entries(vehicle.parameters).filter(([key]) => key !== "wheelbaseM"));
      const incomplete = validateWorkbenchProject({ ...project, vehicle: { ...vehicle, parameters: incompleteParameters } });
      assert(!incomplete.ok, "arbitrarily incomplete imported vehicle parameter data must not be silently template-filled");

      const delta = createVehicleTemplate("delta-cargo-three-wheeler");
      const overlappingWheels = validateWorkbenchProject({ ...project, vehicle: { ...delta, parameters: { ...delta.parameters, trackM: delta.parameters.rearTireWidthM } } });
      assert(!overlappingWheels.ok, "paired wheel track equal to tire width must be rejected");
      const outsideTireBrake = validateWorkbenchProject({ ...project, vehicle: { ...delta, parameters: { ...delta.parameters, frontDiscEffectiveRadiusM: delta.parameters.frontLoadedRadiusM } } });
      assert(!outsideTireBrake.ok, "brake effective radius at or outside loaded tire radius must be rejected");
      const unpairedBrake = validateWorkbenchProject({ ...project, vehicle: { ...delta, parameters: { ...delta.parameters, rearDiscCount: 1 } } });
      assert(!unpairedBrake.ok, "a paired axle cannot imply an unmodeled central brake or unequal wheel braking");
    }
  },
  {
    name: "vehicle MCP analysis is read-only, model-neutral, and truth labeled",
    run: async () => {
      const project = createWorkbenchProject("project:test-vehicle-mcp");
      const before = JSON.stringify(project);
      const result = await handleWorkbenchMcpTool("ps3d_analyze_vehicle", { project });
      assert(result.isError !== true, "vehicle MCP analysis should accept a valid project");
      equal(result.structuredContent["schema"], "ps3d-vehicle-mcp-analysis/2", "vehicle MCP schema should be versioned for geometry/analysis schema 2");
      equal(result.structuredContent["tireDataStatus"], "unverified", "MCP clients must receive structured tire evidence status");
      equal(result.structuredContent["brakeDataStatus"], "unverified", "MCP clients must receive structured brake evidence status");
      equal(result.structuredContent["regulatoryResult"], false, "MCP result must not imply regulatory approval");
      equal(result.structuredContent["constructionReady"], false, "MCP result must not imply fabrication readiness");
      equal(result.structuredContent["roadworthinessApproved"], false, "MCP result must not imply roadworthiness approval");
      assertJsonSafeNumbers(result.structuredContent, "vehicle MCP response");
      equal(JSON.stringify(project), before, "read-only vehicle analysis must not mutate caller data");

      const zeroSteerVehicle = createVehicleTemplate("tadpole-geometry-three-wheeler");
      const zeroSteerProject = { ...createWorkbenchProject("project:test-vehicle-mcp-zero"), vehicle: { ...zeroSteerVehicle, parameters: { ...zeroSteerVehicle.parameters, steeringAngleRad: 0, targetDecelerationMps2: 0 } } };
      const zeroSteerValidated = validateWorkbenchProject(zeroSteerProject);
      assert(zeroSteerValidated.ok, "zero steering must be a valid project state, not only a direct-solver edge case");
      const zeroSteerResult = await handleWorkbenchMcpTool("ps3d_analyze_vehicle", { project: zeroSteerProject });
      assert(zeroSteerResult.isError !== true, "MCP must accept a validated straight-ahead project");
      const zeroSteerAnalysis = zeroSteerResult.structuredContent["analysis"] as { readonly turningRadiusM: number | null };
      equal(zeroSteerAnalysis.turningRadiusM, null, "MCP straight-ahead result must preserve an explicit null turn radius");
      assertJsonSafeNumbers(zeroSteerResult.structuredContent, "straight-ahead vehicle MCP response");
    }
  }
];

function getPoint(geometry: VehicleGeometryModel, id: string): Vec3 {
  const point = geometry.hardpoints.find((candidate) => candidate.id === id);
  if (point === undefined) throw new Error(`Missing vehicle hardpoint ${id}`);
  return point.positionM;
}

function memberLength(geometry: VehicleGeometryModel, id: string): number {
  const member = geometry.members.find((candidate) => candidate.id === id);
  if (member === undefined) throw new Error(`Missing vehicle member ${id}`);
  const a = getPoint(geometry, member.fromHardpointId);
  const b = getPoint(geometry, member.toHardpointId);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function assertMirrored(geometry: VehicleGeometryModel, leftId: string, rightId: string): void {
  const left = getPoint(geometry, leftId);
  const right = getPoint(geometry, rightId);
  near(left[0], right[0], 1e-10, `${leftId}/${rightId} X symmetry`);
  near(left[1], -right[1], 1e-10, `${leftId}/${rightId} Y symmetry`);
  near(left[2], right[2], 1e-10, `${leftId}/${rightId} Z symmetry`);
}

function assertBoundsContainGeometry(geometry: VehicleGeometryModel, minMm: Vec3, maxMm: Vec3, label: string): void {
  for (const point of geometry.hardpoints) {
    for (const axis of [0, 1, 2] as const) {
      const valueMm = point.positionM[axis] * 1_000;
      assert(valueMm >= minMm[axis] - 1e-8 && valueMm <= maxMm[axis] + 1e-8, `${label} bounds must contain ${point.id} axis ${axis}`);
    }
  }
}

function assertBoundsContainPrimitives(preview: VehiclePreview, label: string): void {
  const { min, max } = preview.scene.boundsMm;
  const assertPoint = (point: Vec3, extent: number, id: string): void => {
    for (const axis of [0, 1, 2] as const) {
      assert(point[axis] - extent >= min[axis] - 1e-7 && point[axis] + extent <= max[axis] + 1e-7, `${label} bounds must contain ${id} axis ${axis}`);
    }
  };
  for (const primitive of preview.scene.primitives) {
    if (primitive.kind === "box") assertPoint(primitive.positionMm, Math.hypot(...primitive.sizeMm) / 2, primitive.id);
    else if (primitive.kind === "cylinder") assertPoint(primitive.positionMm, Math.hypot(primitive.radiusMm, primitive.heightMm / 2), primitive.id);
    else {
      const values = primitive.kind === "mesh" ? primitive.positionsMm : primitive.segmentsMm ?? primitive.pointsMm;
      const extent = primitive.kind === "line" ? primitive.radiusMm ?? 0 : 0;
      for (let index = 0; index + 2 < values.length; index += 3) assertPoint([values[index]!, values[index + 1]!, values[index + 2]!], extent, primitive.id);
    }
  }
}

function assertWheelAndBrakePoses(preview: VehiclePreview, intent: VehicleIntent): void {
  const wheelCount = (axle: "front" | "rear"): number => preview.geometry.wheels.filter((wheel) => wheel.axle === axle).length;
  for (const wheel of preview.geometry.wheels) {
    const center = getPoint(preview.geometry, wheel.centerHardpointId);
    const tire = preview.scene.primitives.find((primitive) => primitive.id === `vehicle-wheel:tire:${wheel.id}`);
    assert(tire !== undefined && tire.kind === "cylinder", `${wheel.id} tire cylinder must resolve`);
    equal(tire.rotationOrder, "ZYX", `${wheel.id} tire must request the yaw-then-camber renderer order`);
    near(tire.rotationDeg[0], 90 + wheel.camberRad * 180 / Math.PI, 1e-10, `${wheel.id} cylinder requires the base axle rotation plus camber`);
    near(tire.rotationDeg[2], wheel.steerRad * 180 / Math.PI, 1e-10, `${wheel.id} cylinder yaw must follow wheel steer`);
    const renderedAxis = bakedCylinderAxisZYX(tire.rotationDeg);
    const expectedAxis = transformWheelOffsetForTest(wheel.camberRad, wheel.steerRad, [0, 1, 0]);
    near(Math.abs(dotVec3(renderedAxis, expectedAxis)), 1, 1e-10, `${wheel.id} rendered cylinder axis must be coaxial with the solved wheel pose`);
    const entered = wheel.axle === "front" ? intent.parameters.frontDiscCount : intent.parameters.rearDiscCount;
    const perWheel = entered / wheelCount(wheel.axle);
    const sideSign = wheel.side === "left" ? -1 : wheel.side === "right" ? 1 : 1;
    const discRadius = wheel.axle === "front" ? intent.parameters.frontDiscEffectiveRadiusM : intent.parameters.rearDiscEffectiveRadiusM;
    for (let index = 0; index < perWheel; index += 1) {
      const disc = preview.scene.primitives.find((primitive) => primitive.id === `vehicle-brake:disc:${wheel.id}:${index + 1}`);
      const caliper = preview.scene.primitives.find((primitive) => primitive.id === `vehicle-brake:caliper:${wheel.id}:${index + 1}`);
      assert(disc !== undefined && disc.kind === "cylinder", `${wheel.id} disc ${index + 1} must resolve to that wheel`);
      assert(caliper !== undefined && caliper.kind === "box", `${wheel.id} caliper ${index + 1} must resolve to that wheel`);
      equal(disc.rotationOrder, "ZYX", `${wheel.id} rotor must share the wheel Euler order`);
      equal(caliper.rotationOrder, "ZYX", `${wheel.id} caliper must share the wheel-pose Euler order`);
      near(Math.abs(dotVec3(bakedCylinderAxisZYX(disc.rotationDeg), expectedAxis)), 1, 1e-10, `${wheel.id} rotor plane must remain coaxial with the wheel`);
      const signedSide = wheel.side === "center" && perWheel > 1 ? (index % 2 === 0 ? 1 : -1) : sideSign;
      const radialTier = Math.floor(index / 2);
      const lateral = signedSide * wheel.widthM * (0.34 + radialTier * 0.06);
      const expectedDisc = addVec3(center, transformWheelOffsetForTest(wheel.camberRad, wheel.steerRad, [0, lateral, 0]));
      const expectedCaliper = addVec3(center, transformWheelOffsetForTest(wheel.camberRad, wheel.steerRad, [-discRadius * 0.55, lateral + signedSide * 0.008, discRadius * 0.34]));
      for (const axis of [0, 1, 2] as const) {
        near(disc.positionMm[axis], expectedDisc[axis] * 1_000, 1e-7, `${wheel.id} rotor center must follow the wheel axle pose`);
        near(caliper.positionMm[axis], expectedCaliper[axis] * 1_000, 1e-7, `${wheel.id} caliper center must follow the wheel pose`);
      }
    }
  }
}

function transformWheelOffsetForTest(camberRad: number, steerRad: number, offset: Vec3): Vec3 {
  const afterCamber: Vec3 = [offset[0], offset[1] * Math.cos(camberRad) - offset[2] * Math.sin(camberRad), offset[1] * Math.sin(camberRad) + offset[2] * Math.cos(camberRad)];
  return [afterCamber[0] * Math.cos(steerRad) - afterCamber[1] * Math.sin(steerRad), afterCamber[0] * Math.sin(steerRad) + afterCamber[1] * Math.cos(steerRad), afterCamber[2]];
}

function addVec3(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function dotVec3(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function bakedCylinderAxisZYX(rotationDeg: Vec3): Vec3 {
  const x = rotationDeg[0] * Math.PI / 180;
  const z = rotationDeg[2] * Math.PI / 180;
  return [Math.sin(z) * Math.sin(x), -Math.cos(z) * Math.sin(x), Math.cos(x)];
}

function assertJsonSafeNumbers(value: unknown, label: string, path = "$", seen = new Set<object>()): void {
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${label} contains a non-finite number at ${path}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} contains a cycle at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertJsonSafeNumbers(entry, label, `${path}[${index}]`, seen));
  else for (const [key, entry] of Object.entries(value)) assertJsonSafeNumbers(entry, label, `${path}.${key}`, seen);
  seen.delete(value);
  if (path === "$") {
    const serialized = JSON.stringify(value);
    assert(serialized !== undefined, `${label} must serialize to JSON`);
    equal(JSON.stringify(JSON.parse(serialized) as unknown), serialized, `${label} must survive a JSON round trip`);
  }
}
