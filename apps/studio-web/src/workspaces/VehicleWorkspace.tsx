import { useEffect, useMemo, useState } from "react";
import {
  type VehicleAnalysis,
  type VehicleGeometryModel,
  type VehicleIntent,
  type VehicleLayerId,
  type VehicleLayout,
  type VehicleParameterKey,
  type VehiclePowertrainKind,
  type VehicleTemplateId
} from "../../../../packages/workbench-core/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

interface VehicleWorkspaceProps {
  readonly intent: VehicleIntent;
  readonly analysis: VehicleAnalysis;
  readonly geometry: VehicleGeometryModel;
  readonly primitiveCountByLayer: Readonly<Record<string, number>>;
  readonly selectedId: string | null;
  readonly onTemplate: (template: VehicleTemplateId) => void;
  readonly onSelect: (id: string) => void;
  readonly onParameter: (parameter: VehicleParameterKey, value: number) => boolean;
  readonly onState: (state: VehicleIntent["state"]) => void;
  readonly onLayer: (layer: VehicleLayerId) => void;
  readonly onFit: () => void;
}

type Conversion = "identity" | "mm" | "deg" | "kn-per-m" | "square-mm" | "mpa" | "percent" | "kmh" | "grade-percent" | "kwh" | "wh-per-km";

interface ParameterControl {
  readonly key: VehicleParameterKey;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly conversion?: Conversion;
  readonly layouts?: readonly VehicleLayout[];
  readonly powertrains?: readonly VehiclePowertrainKind[];
}

interface ParameterGroup {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly controls: readonly ParameterControl[];
}

const TEMPLATES: readonly { readonly id: VehicleTemplateId; readonly title: string; readonly meta: string; readonly tag: string; readonly icon: string }[] = [
  { id: "ice-road-motorcycle", title: "ICE road motorcycle", meta: "telescopic fork / rear swingarm", tag: "2W ICE", icon: "vehicle" },
  { id: "step-through-scooter", title: "Step-through scooter", meta: "telescopic fork / rigid unit swing", tag: "SCOOTER", icon: "scooter" },
  { id: "ev-street-motorcycle", title: "EV street motorcycle", meta: "telescopic fork / rear swingarm", tag: "2W EV", icon: "battery" },
  { id: "delta-cargo-three-wheeler", title: "Delta cargo three-wheeler", meta: "front fork / paired rear beam", tag: "1F2R", icon: "three-wheel" },
  { id: "tadpole-geometry-three-wheeler", title: "Tadpole double wishbone", meta: "paired front arms / rear swingarm", tag: "2F1R", icon: "steering" }
];

const LAYERS: readonly { readonly id: VehicleLayerId; readonly label: string; readonly icon: string }[] = [
  { id: "skeleton", label: "Skeleton", icon: "sketch" },
  { id: "hardpoints", label: "Hardpoints", icon: "hardpoint" },
  { id: "envelopes", label: "Envelopes", icon: "box" },
  { id: "wheels", label: "Wheels", icon: "wheel" },
  { id: "chassis", label: "Chassis", icon: "chassis" },
  { id: "suspension", label: "Suspension", icon: "suspension" },
  { id: "steering", label: "Steering", icon: "steering" },
  { id: "brakes", label: "Brakes", icon: "brake" },
  { id: "powertrain", label: "Powertrain", icon: "motor" },
  { id: "cg-loads", label: "CG + loads", icon: "cg" }
];

const PARAMETER_GROUPS: readonly ParameterGroup[] = [
  { id: "package", title: "Package & steering hardpoints", hint: "Coordinate frame: +X forward / +Y left / +Z up", controls: [
    c("wheelbaseM", "Wheelbase", "mm", 700, 4000, 1, "mm"),
    c("frontLoadedRadiusM", "Front loaded radius", "mm", 150, 600, 1, "mm"),
    c("rearLoadedRadiusM", "Rear loaded radius", "mm", 150, 600, 1, "mm"),
    c("frontRollingRadiusM", "Front rolling radius", "mm", 150, 650, 1, "mm"),
    c("rearRollingRadiusM", "Rear rolling radius", "mm", 150, 650, 1, "mm"),
    c("frontTireWidthM", "Front tire width", "mm", 40, 400, 1, "mm"),
    c("rearTireWidthM", "Rear tire width", "mm", 40, 500, 1, "mm"),
    c("trackM", "Paired-wheel track", "mm", 0, 2500, 1, "mm", ["delta-1f2r", "tadpole-2f1r"]),
    c("rakeRad", "Fork steering-axis rake", "deg", 5, 45, 0.1, "deg", ["single-track", "delta-1f2r"]),
    c("forkNormalOffsetM", "Fork normal offset", "mm", 0, 150, 0.5, "mm", ["single-track", "delta-1f2r"]),
    c("casterRad", "Front kingpin caster", "deg", 0, 25, 0.1, "deg", ["tadpole-2f1r"]),
    c("kingpinInclinationRad", "Kingpin inclination", "deg", 0, 25, 0.1, "deg", ["tadpole-2f1r"]),
    c("scrubRadiusM", "Scrub radius", "mm", -150, 150, 0.5, "mm", ["tadpole-2f1r"]),
    c("toeRad", "Static toe per side", "deg", -5, 5, 0.05, "deg", ["tadpole-2f1r"]),
    c("ackermannPercent", "Ackermann target blend", "%", 0, 150, 1, "percent", ["tadpole-2f1r"]),
    c("steeringAngleRad", "Steering input angle", "deg", 0, 60, 0.5, "deg"),
    c("cgFromRearM", "CG from rear station", "mm", 50, 3950, 1, "mm"),
    c("cgHeightM", "CG height", "mm", 50, 2500, 1, "mm")
  ] },
  { id: "suspension", title: "Suspension & spring data", hint: "Motion ratio = shock travel / vertical wheel travel", controls: [
    c("frontTravelM", "Front travel", "mm", 0, 400, 1, "mm"),
    c("rearTravelM", "Rear travel", "mm", 0, 400, 1, "mm"),
    c("frontSagM", "Front design sag", "mm", 0, 200, 1, "mm"),
    c("rearSagM", "Rear design sag", "mm", 0, 200, 1, "mm"),
    c("rearSwingarmPivotFromRearM", "Rear pivot from rear station", "mm", 100, 1500, 1, "mm"),
    c("rearSwingarmPivotHeightM", "Rear pivot height", "mm", 150, 1200, 1, "mm"),
    c("rearShockUpperFromRearM", "Rear shock upper X", "mm", 50, 2000, 1, "mm"),
    c("rearShockUpperHeightM", "Rear shock upper Z", "mm", 200, 1500, 1, "mm"),
    c("rearShockArmRatio", "Rear shock arm station", "%", 10, 95, 1, "percent"),
    c("frontSuspensionInboardHalfTrackM", "Front inboard half-track", "mm", 50, 1000, 1, "mm", ["tadpole-2f1r"]),
    c("frontLowerArmHeightM", "Front lower-arm axis Z", "mm", 100, 800, 1, "mm", ["tadpole-2f1r"]),
    c("frontUpperArmHeightM", "Front upper-arm axis Z", "mm", 200, 1200, 1, "mm", ["tadpole-2f1r"]),
    c("frontSpringRateNPerM", "Front spring rate", "kN/m", 1, 500, 0.5, "kn-per-m"),
    c("rearSpringRateNPerM", "Rear spring rate", "kN/m", 1, 1000, 0.5, "kn-per-m"),
    c("frontMotionRatio", "Front motion ratio", "ratio", 0.05, 2, 0.01),
    c("rearMotionRatio", "Rear motion ratio", "ratio", 0.05, 2, 0.01)
  ] },
  { id: "mass-load", title: "Mass & maneuver case", hint: "Quasi-static load transfer only", controls: [
    c("curbMassKg", "Curb mass", "kg", 20, 1500, 1),
    c("riderMassKg", "Rider / operator", "kg", 0, 250, 1),
    c("payloadKg", "Payload", "kg", 0, 2000, 1),
    c("targetDecelerationMps2", "Target deceleration", "m/s²", 0, 15, 0.1),
    c("lateralAccelerationMps2", "Lateral acceleration", "m/s²", -15, 15, 0.1),
    c("tireFrictionCoefficient", "Tire-road coefficient", "μ", 0.05, 2, 0.01),
    c("speedMps", "Scenario speed", "km/h", 0, 288, 1, "kmh"),
    c("reactionTimeS", "Reaction time", "s", 0, 5, 0.1),
    c("gradeRad", "Road grade", "%", -54, 54, 0.1, "grade-percent")
  ] },
  { id: "brakes", title: "Brake-system screen", hint: "Equivalent clamp area already represents caliper construction", controls: [
    c("frontBrakeInputForceN", "Front input force", "N", 0, 1500, 1),
    c("rearBrakeInputForceN", "Rear input force", "N", 0, 2500, 1),
    c("frontBrakeLeverRatio", "Front lever ratio", "ratio", 0.1, 12, 0.05),
    c("rearBrakeLeverRatio", "Rear lever ratio", "ratio", 0.1, 12, 0.05),
    c("frontMasterCylinderDiameterM", "Front master bore", "mm", 4, 80, 0.1, "mm"),
    c("rearMasterCylinderDiameterM", "Rear master bore", "mm", 4, 80, 0.1, "mm"),
    c("frontEquivalentClampAreaM2", "Front equivalent clamp area", "mm²", 10, 30000, 1, "square-mm"),
    c("rearEquivalentClampAreaM2", "Rear equivalent clamp area", "mm²", 10, 30000, 1, "square-mm"),
    c("frontDiscCount", "Front disc count", "count", 1, 2, 1),
    c("rearDiscCount", "Rear disc count", "count", 1, 2, 1),
    c("frontDiscEffectiveRadiusM", "Front effective radius", "mm", 30, 300, 1, "mm"),
    c("rearDiscEffectiveRadiusM", "Rear effective radius", "mm", 30, 300, 1, "mm"),
    c("frontPadFrictionCoefficient", "Front pad coefficient", "μ", 0.05, 0.8, 0.01),
    c("rearPadFrictionCoefficient", "Rear pad coefficient", "μ", 0.05, 0.8, 0.01),
    c("frontBrakeEfficiency", "Front circuit efficiency", "%", 10, 100, 1, "percent"),
    c("rearBrakeEfficiency", "Rear circuit efficiency", "%", 10, 100, 1, "percent"),
    c("frontRatedPressurePa", "Front rated pressure", "MPa", 0.1, 50, 0.1, "mpa"),
    c("rearRatedPressurePa", "Rear rated pressure", "MPa", 0.1, 50, 0.1, "mpa")
  ] },
  { id: "powertrain", title: "Powertrain & road load", hint: "One source-to-wheel operating point; no map, thermal or top-speed solver", controls: [
    c("driveTorqueNm", "Source torque at point", "N·m", 0, 1500, 1),
    c("finalDriveRatio", "Total reduction at point", "ratio", 0.1, 30, 0.05),
    c("drivelineEfficiency", "Driveline efficiency", "%", 10, 100, 1, "percent"),
    c("rollingResistanceCoefficient", "Rolling resistance", "Crr", 0, 0.2, 0.001),
    c("dragCoefficient", "Drag coefficient", "Cd", 0.05, 2, 0.01),
    c("frontalAreaSquareM", "Frontal area", "m²", 0.1, 6, 0.01),
    c("airDensityKgPerCubicM", "Air density", "kg/m³", 0.5, 1.6, 0.001),
    c("batteryEnergyCapacityJ", "Battery energy", "kWh", 0, 200, 0.1, "kwh", undefined, ["electric"]),
    c("usableBatteryFraction", "Usable energy", "%", 5, 100, 1, "percent", undefined, ["electric"]),
    c("energyConsumptionJPerM", "Energy assumption", "Wh/km", 10, 1000, 1, "wh-per-km", undefined, ["electric"])
  ] }
];

export function VehicleWorkspace(props: VehicleWorkspaceProps): React.JSX.Element {
  const [draft, setDraft] = useState<Readonly<Record<VehicleParameterKey, number>>>(() => displayValues(props.intent));
  useEffect(() => setDraft(displayValues(props.intent)), [props.intent]);
  const template = TEMPLATES.find((candidate) => candidate.id === props.intent.template)!;
  const totalPrimitives = Object.values(props.primitiveCountByLayer).reduce((sum, value) => sum + value, 0);
  const issueCount = props.analysis.errors.length + props.analysis.warnings.length;

  const commit = (control: ParameterControl): void => {
    const shown = draft[control.key];
    if (!Number.isFinite(shown)) return;
    const clamped = Math.min(control.max, Math.max(control.min, shown));
    const accepted = props.onParameter(control.key, fromDisplay(clamped, control.conversion ?? "identity"));
    if (!accepted) setDraft((current) => ({ ...current, [control.key]: toDisplay(props.intent.parameters[control.key], control.conversion ?? "identity") }));
  };

  return <aside className="inspector-panel vehicle-inspector" aria-label="Vehicle engineering workspace">
    <div className="inspector-title vehicle-title"><div><p>Vehicle engineering laboratory</p><h2>{props.intent.name}</h2></div><CapabilityBadge level="preview" /></div>

    <section className={`vehicle-boundary ${props.analysis.status}`}>
      <header><span><CommandIcon name={props.analysis.status === "blocked" ? "shield" : "inspect"} /></span><div><strong>{props.analysis.status === "blocked" ? "Scenario blocked" : "Preliminary calculation review"}</strong><small>{props.analysis.status === "blocked" ? `${props.analysis.errors.length} blocking condition${props.analysis.errors.length === 1 ? "" : "s"}` : "Illustrative inputs · qualified review required"}</small></div><b>{issueCount}</b></header>
      <p>No roadworthiness, homologation, structural, brake, tire, functional-safety, or fabrication approval is produced.</p>
    </section>

    <section className="vehicle-topology-strip" aria-label="Solved vehicle topology">
      <span><small>Front suspension</small><strong>{humanize(props.analysis.topology.frontSuspension)}</strong></span>
      <span><small>Rear suspension</small><strong>{humanize(props.analysis.topology.rearSuspension)}</strong></span>
      <span><small>Steering</small><strong>{humanize(props.analysis.topology.steering)}</strong></span>
      <span><small>Driven axle</small><strong>{props.analysis.topology.drivenAxle}</strong></span>
    </section>

    <VehicleOrthographicDrawing intent={props.intent} analysis={props.analysis} geometry={props.geometry} />

    <section className="vehicle-template-panel">
      <header><div><strong>Original generic templates</strong><small>No OEM geometry, branding, or copied repository content</small></div><span>{template.tag}</span></header>
      <div className="vehicle-template-grid">{TEMPLATES.map((candidate) => <button key={candidate.id} className={candidate.id === props.intent.template ? "active" : ""} aria-pressed={candidate.id === props.intent.template} onClick={() => props.onTemplate(candidate.id)}><span><CommandIcon name={candidate.icon} /></span><strong>{candidate.title}</strong><small>{candidate.meta}</small><b>{candidate.tag}</b></button>)}</div>
    </section>

    <section className="vehicle-state-panel">
      <header><div><strong>Suspension position</strong><small>Hardpoint preview state</small></div><button onClick={props.onFit}><CommandIcon name="fit" />Fit vehicle</button></header>
       <div>{(["full-droop", "design-ride", "full-bump"] as const).map((state) => <button key={state} className={props.intent.state === state ? "active" : ""} aria-pressed={props.intent.state === state} onClick={() => props.onState(state)}><CommandIcon name={state === "full-droop" ? "arrow-up" : state === "full-bump" ? "arrow-down" : "suspension"} /><strong>{state === "full-droop" ? "Full droop" : state === "design-ride" ? "Design ride" : "Full bump"}</strong><small>{state.replaceAll("-", " ")}</small></button>)}</div>
    </section>

    <section className="vehicle-layer-panel"><header><div><strong>CAD layers</strong><small>{totalPrimitives} visible preview primitives</small></div><CommandIcon name="layers" /></header><div>{LAYERS.map((layer) => <button key={layer.id} className={props.intent.layers[layer.id] ? "active" : ""} aria-pressed={props.intent.layers[layer.id]} onClick={() => props.onLayer(layer.id)}><CommandIcon name={layer.icon} /><span>{layer.label}</span><small>{props.primitiveCountByLayer[layer.id] ?? 0}</small></button>)}</div></section>

    <VehicleGeometryChecks analysis={props.analysis} />

    <VehicleResults intent={props.intent} analysis={props.analysis} />

    <section className="vehicle-parameter-stack" aria-label="Vehicle parameter controls">{PARAMETER_GROUPS.map((group, index) => {
      const visibleControls = group.controls.filter((control) => (control.layouts === undefined || control.layouts.includes(props.intent.layout)) && (control.powertrains === undefined || control.powertrains.includes(props.intent.powertrain)));
      return <details key={group.id} open={index === 0}><summary><span><CommandIcon name={group.id === "brakes" ? "brake" : group.id === "suspension" ? "suspension" : group.id === "powertrain" ? "motor" : group.id === "mass-load" ? "cg" : "hardpoint"} /></span><div><strong>{group.title}</strong><small>{group.hint}</small></div><b>{visibleControls.length}</b></summary><div className="vehicle-parameter-grid">{visibleControls.map((control) => <label key={control.key}><span>{control.label}<small>{control.unit}</small></span><input type="number" min={control.min} max={control.max} step={control.step} value={roundDraft(draft[control.key], control.step)} onChange={(event) => setDraft((current) => ({ ...current, [control.key]: Number(event.target.value) }))} onBlur={() => commit(control)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} aria-label={`${control.label} in ${control.unit}`} /></label>)}</div></details>;
    })}</section>

    <details className="vehicle-hardpoint-table"><summary><span><CommandIcon name="hardpoint" /></span><div><strong>Hardpoint data</strong><small>Click a row to cross-probe the 3D model / millimeters</small></div><b>{props.analysis.hardpoints.length}</b></summary><div><header><span>ID / source</span><span>X</span><span>Y</span><span>Z</span></header>{props.analysis.hardpoints.map((point) => <button type="button" key={point.id} className={props.selectedId === point.id ? "selected" : ""} aria-pressed={props.selectedId === point.id} onClick={() => props.onSelect(point.id)}><span title={point.id}><i className={point.category} /><b>{point.label}</b><small>{point.source}{point.stateDependent ? " / state" : ""} / {point.side}</small></span>{point.positionM.map((value, index) => <code key={index}>{format(value * 1000, 1)}</code>)}</button>)}</div></details>

    <section className="vehicle-assumption-panel"><header><strong>Model boundaries</strong><span>{props.analysis.assumptions.length}</span></header>{props.analysis.assumptions.map((assumption) => <p key={assumption}><i />{assumption}</p>)}</section>
  </aside>;
}

function VehicleResults({ intent, analysis }: { readonly intent: VehicleIntent; readonly analysis: VehicleAnalysis }): React.JSX.Element {
  return <section className="vehicle-results">
    <header><div><strong>Live engineering screen</strong><small>Deterministic preliminary SI calculations</small></div><span className={analysis.status}>{analysis.status}</span></header>
    <div className="vehicle-result-hero">
      <article><span>{analysis.trailM === null ? "Ackermann error" : "Mechanical trail"}</span><strong>{analysis.trailM === null ? format((analysis.ackermannErrorRad ?? 0) * 180 / Math.PI, 2) : format(analysis.trailM * 1000, 1)} <small>{analysis.trailM === null ? "deg" : "mm"}</small></strong><em>{analysis.trailM === null ? "target blend / low-speed" : "rake / offset / loaded radius"}</em><b>derived</b></article>
      <article><span>Total mass</span><strong>{format(analysis.totalMassKg, 1)} <small>kg</small></strong><em>combined input load case</em><b>input</b></article>
      <article><span>Achieved decel.</span><strong>{format(analysis.predictedBrakeDecelerationMps2, 2)} <small>m/s2</small></strong><em>iterated combined-tire screen</em><b>screening</b></article>
      <article><span>Total stop</span><strong>{finite(analysis.totalStoppingDistanceM, "m", 1)}</strong><em>reaction + constant-decel baseline</em><b>screening</b></article>
    </div>
    <details open><summary>Geometry & suspension</summary><dl>
      <Result label="State wheelbase" value={`${format(analysis.stateWheelbaseM * 1000, 1)} mm`} status="state" />
      <Result label="Equivalent center turn radius" value={finite(analysis.turningRadiusM, "m", 2)} status="screening" />
      <Result label="Rear swingarm / shock length" value={`${format(analysis.rearSwingarmLengthM * 1000, 1)} / ${format(analysis.rearShockLengthM * 1000, 1)} mm`} status="derived" />
      <Result label="Front / rear axle wheel rate" value={`${format(analysis.frontAxleWheelRateNPerM / 1000, 1)} / ${format(analysis.rearAxleWheelRateNPerM / 1000, 1)} kN/m`} status="input model" />
      <Result label="Supported-mass frequency F / R" value={`${format(analysis.frontNaturalFrequencyHz, 2)} / ${format(analysis.rearNaturalFrequencyHz, 2)} Hz`} status="screening" />
      {analysis.frontCamberChangeRad !== null && <Result label="Front camber change" value={`${format(analysis.frontCamberChangeRad * 180 / Math.PI, 2)} deg`} status="state" />}
      {analysis.modeledInnerSteerRad !== null && analysis.modeledOuterSteerRad !== null && <Result label="Modeled inner / outer steer" value={`${format(analysis.modeledInnerSteerRad * 180 / Math.PI, 2)} / ${format(analysis.modeledOuterSteerRad * 180 / Math.PI, 2)} deg`} status="target" />}
      {analysis.steadyLeanAngleRad !== null && <Result label="Steady lean reference" value={`${format(analysis.steadyLeanAngleRad * 180 / Math.PI, 1)} deg`} status="screening" />}
    </dl></details>
    <details><summary>Axle loads & brakes</summary><dl>
      <Result label="Static front / rear" value={`${format(analysis.staticFrontLoadN, 0)} / ${format(analysis.staticRearLoadN, 0)} N`} status="derived" />
      <Result label="Requested-case front / rear" value={`${format(analysis.brakingFrontLoadN, 0)} / ${format(analysis.brakingRearLoadN, 0)} N`} status="screening" />
      <Result label="Achieved-case front / rear" value={`${format(analysis.predictedBrakingFrontLoadN, 0)} / ${format(analysis.predictedBrakingRearLoadN, 0)} N`} status="iterated" />
      <Result label="Ideal / hardware front" value={`${format(analysis.idealFrontBrakePercent, 1)} / ${format(analysis.hardwareFrontBrakePercent, 1)} %`} status="screening" />
      <Result label="Hydraulic pressure F / R" value={`${format(analysis.frontHydraulicPressurePa / 1e6, 2)} / ${format(analysis.rearHydraulicPressurePa / 1e6, 2)} MPa`} status="computed" />
      <Result label="Available torque F / R" value={`${format(analysis.availableFrontBrakeTorqueNm, 1)} / ${format(analysis.availableRearBrakeTorqueNm, 1)} N m`} status="computed" />
      <Result label="Combined tire use F / R" value={`${formatNullable(analysis.frontCombinedTireUtilization, 3)} / ${formatNullable(analysis.rearCombinedTireUtilization, 3)}`} status="screening" />
      <Result label="First brake limit" value={humanize(analysis.firstBrakeLimit)} status={analysis.firstBrakeLimit === "none" ? "none" : "limit"} />
      <Result label="Braking-only distance" value={finite(analysis.brakingDistanceM, "m", 1)} status="baseline" />
    </dl></details>
    <details><summary>Road load & drive</summary><dl>
      <Result label="Road load" value={`${format(analysis.roadLoadN, 0)} N`} status="screening" />
      <Result label="Raw / used tractive force" value={`${format(analysis.rawTractiveForceN, 0)} / ${format(analysis.tractiveForceN, 0)} N`} status="operating point" />
      <Result label="First drive limit" value={humanize(analysis.firstDriveLimit)} status="screening" />
      <Result label="Wheel / source speed" value={`${format(analysis.wheelSpeedRpm, 0)} / ${format(analysis.sourceSpeedRpm, 0)} rpm`} status="computed" />
      <Result label="Source mechanical power" value={`${format(analysis.sourcePowerW / 1000, 2)} kW`} status="computed" />
      <Result label="Longitudinal acceleration" value={`${format(analysis.scenarioLongitudinalAccelerationMps2, 2)} m/s2`} status="screening" />
      {analysis.assumptionEvRangeKm !== null && <Result label="EV energy envelope" value={`${format(analysis.assumptionEvRangeKm, 1)} km`} status="assumption" />}
      {analysis.approximateTipThresholdMps2 !== null && <Result label="Rigid tip threshold" value={`${format(analysis.approximateTipThresholdMps2, 2)} m/s2`} status="screening" />}
      {analysis.approximateTipThresholdMps2 === null && analysis.minimumSupportLoadN !== null && <Result label="Rigid tip threshold" value="> 3 g solver envelope" status="bounded" />}
      {analysis.minimumSupportLoadN !== null && <Result label="Minimum support load" value={`${format(analysis.minimumSupportLoadN, 0)} N`} status="screening" />}
    </dl>{analysis.supportWheelLoadsN !== null && <div className="vehicle-support-loads">{analysis.supportWheelLoadsN.map((load) => <span key={load.contactId}><small>{load.contactId}</small><strong>{format(load.loadN, 0)} N</strong></span>)}</div>}</details>
    {(analysis.errors.length > 0 || analysis.warnings.length > 0) && <details open className="vehicle-findings"><summary>Engineering findings · {analysis.errors.length} blocked / {analysis.warnings.length} review</summary><div>{analysis.errors.map((error) => <p className="error" key={error}><CommandIcon name="shield" />{error}</p>)}{analysis.warnings.map((warning) => <p className="warning" key={warning}><CommandIcon name="inspect" />{warning}</p>)}</div></details>}
    <footer><span>{intent.layout.replaceAll("-", " ")}</span><span>{intent.powertrain}</span><span>{intent.inputStatus.replaceAll("-", " ")}</span></footer>
  </section>;
}

function VehicleGeometryChecks({ analysis }: { readonly analysis: VehicleAnalysis }): React.JSX.Element {
  const failures = analysis.geometryChecks.filter((check) => check.status === "fail").length;
  const reviews = analysis.geometryChecks.filter((check) => check.status === "review").length;
  return <section className={`vehicle-geometry-checks ${failures > 0 ? "fail" : reviews > 0 ? "review" : "pass"}`}>
    <header><div><strong>Kinematic invariant gate</strong><small>Geometry is not accepted by appearance alone</small></div><span>{failures} fail / {reviews} review</span></header>
    <div>{analysis.geometryChecks.map((check) => <article key={check.id} className={check.status}><i /><span><strong>{check.label}</strong><small>{check.measured}</small></span><em>{check.requirement}</em><b>{check.status}</b></article>)}</div>
  </section>;
}

export type VehicleDrawingView = "side" | "top" | "front";

export function VehicleOrthographicDrawing({ intent, analysis, geometry, initialView }: { readonly intent: VehicleIntent; readonly analysis: VehicleAnalysis; readonly geometry: VehicleGeometryModel; readonly initialView?: VehicleDrawingView }): React.JSX.Element {
  const defaultView = initialView ?? (intent.layout === "tadpole-2f1r" ? "front" : "side");
  const [view, setView] = useState<VehicleDrawingView>(defaultView);
  useEffect(() => setView(defaultView), [intent.template, defaultView]);
  const drawing = useMemo(() => makeDrawingProjection(geometry, view), [geometry, view]);
  const p = intent.parameters;
  const solvedTrackM = geometry.frontTrackM > 0 ? geometry.frontTrackM : geometry.rearTrackM;
  const dimensionLabel = view === "side" ? `WB INPUT ${format(p.wheelbaseM * 1000, 0)} mm`
    : solvedTrackM > 0 ? `TRACK SOLVED ${format(solvedTrackM * 1000, 0)} mm` : "CENTER PLANE";
  return <section className="vehicle-orthographic">
    <header><div><strong>Solved hardpoint projection</strong><small>{humanize(intent.state)} / same graph as the 3D preview</small></div><nav aria-label="Vehicle drawing view">{(["side", "top", "front"] as const).map((candidate) => <button key={candidate} className={view === candidate ? "active" : ""} aria-pressed={view === candidate} onClick={() => setView(candidate)}>{candidate}</button>)}</nav></header>
    <svg viewBox="0 0 300 188" role="img" aria-label={`${intent.name} ${view} hardpoint drawing`}>
      <defs><marker id="vehicle-dim-arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse"><path d="M0 0L6 3L0 6Z" /></marker><pattern id="vehicle-grid" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M12 0H0V12" /></pattern></defs>
      <rect className="drawing-grid" x="0" y="0" width="300" height="188" />
      {drawing.members.map((member) => <line key={member.id} className={`drawing-member ${member.layer} ${member.style}`} x1={member.a[0]} y1={member.a[1]} x2={member.b[0]} y2={member.b[1]} />)}
      {drawing.wheels.map((wheel) => view === "side"
        ? <g key={wheel.id}><circle className="drawing-wheel" cx={wheel.center[0]} cy={wheel.center[1]} r={wheel.radius} /><circle className="drawing-rim" cx={wheel.center[0]} cy={wheel.center[1]} r={wheel.radius * 0.62} /></g>
        : view === "top"
          ? <rect key={wheel.id} className="drawing-wheel-plane" x={wheel.center[0] - wheel.radius} y={wheel.center[1] - wheel.width / 2} width={wheel.radius * 2} height={wheel.width} rx="2" transform={`rotate(${-wheel.steerDeg} ${wheel.center[0]} ${wheel.center[1]})`} />
          : <rect key={wheel.id} className="drawing-wheel-plane" x={wheel.center[0] - wheel.width / 2} y={wheel.center[1] - wheel.radius} width={wheel.width} height={wheel.radius * 2} rx="2" transform={`rotate(${wheel.camberDeg} ${wheel.center[0]} ${wheel.center[1]})`} />)}
      {drawing.points.map((point) => point.source === "authored" ? <rect key={point.id} className={`drawing-point ${point.category}`} x={point.xy[0] - 2.4} y={point.xy[1] - 2.4} width="4.8" height="4.8" /> : <circle key={point.id} className={`drawing-point ${point.category} ${point.stateDependent ? "state" : ""}`} cx={point.xy[0]} cy={point.xy[1]} r="2.3" />)}
      {view === "side" && <><line className="drawing-dimension" x1={drawing.dimensionA[0]} y1="177" x2={drawing.dimensionB[0]} y2="177" markerStart="url(#vehicle-dim-arrow)" markerEnd="url(#vehicle-dim-arrow)" /><line className="drawing-extension" x1={drawing.dimensionA[0]} y1={drawing.dimensionA[1]} x2={drawing.dimensionA[0]} y2="181" /><line className="drawing-extension" x1={drawing.dimensionB[0]} y1={drawing.dimensionB[1]} x2={drawing.dimensionB[0]} y2="181" /></>}
      {view !== "side" && solvedTrackM > 0 && <><line className="drawing-dimension" x1="286" y1={drawing.dimensionA[1]} x2="286" y2={drawing.dimensionB[1]} markerStart="url(#vehicle-dim-arrow)" markerEnd="url(#vehicle-dim-arrow)" /><line className="drawing-extension" x1={drawing.dimensionA[0]} y1={drawing.dimensionA[1]} x2="290" y2={drawing.dimensionA[1]} /><line className="drawing-extension" x1={drawing.dimensionB[0]} y1={drawing.dimensionB[1]} x2="290" y2={drawing.dimensionB[1]} /></>}
      <text className="drawing-dimension-label" x="150" y="185">{dimensionLabel}</text>
      <text className="drawing-axis-label" x="8" y="14">{view === "side" ? "X / Z" : view === "top" ? "X / Y" : "Y / Z"}</text>
      <text className="drawing-state-label" x="292" y="14" textAnchor="end">{analysis.status.toUpperCase()}</text>
    </svg>
    <footer><span><b>{view === "side" ? "INPUT" : "SOLVED"}</b>{view === "side" ? ` WB ${format(p.wheelbaseM * 1000, 0)} mm` : solvedTrackM > 0 ? ` track ${format(solvedTrackM * 1000, 0)} mm` : " center plane"}</span><span><b>DERIVED</b>{analysis.trailM !== null ? ` trail ${format(analysis.trailM * 1000, 1)} mm` : ` Ackermann error ${format((analysis.ackermannErrorRad ?? 0) * 180 / Math.PI, 2)} deg`}</span><span><b>STATE</b>{humanize(intent.state)}</span></footer>
  </section>;
}

interface DrawingProjection {
  readonly members: readonly { readonly id: string; readonly layer: VehicleLayerId; readonly style: string; readonly a: readonly [number, number]; readonly b: readonly [number, number] }[];
  readonly wheels: readonly { readonly id: string; readonly center: readonly [number, number]; readonly radius: number; readonly width: number; readonly steerDeg: number; readonly camberDeg: number }[];
  readonly points: readonly { readonly id: string; readonly xy: readonly [number, number]; readonly source: string; readonly category: string; readonly stateDependent: boolean }[];
  readonly dimensionA: readonly [number, number];
  readonly dimensionB: readonly [number, number];
}

function makeDrawingProjection(geometry: VehicleGeometryModel, view: VehicleDrawingView): DrawingProjection {
  const raw = geometry.hardpoints.map((point) => projectPoint(point.positionM, view));
  const wheelRaw = geometry.wheels.map((wheel) => {
    const point = geometry.hardpoints.find((candidate) => candidate.id === wheel.centerHardpointId)!;
    return { wheel, center: projectPoint(point.positionM, view) };
  });
  const horizontalWheelHalfExtent = (wheel: VehicleGeometryModel["wheels"][number]): number => view === "front" ? wheel.widthM / 2 : wheel.radiusM;
  const verticalWheelHalfExtent = (wheel: VehicleGeometryModel["wheels"][number]): number => view === "top" ? wheel.widthM / 2 : wheel.radiusM;
  const uReferenceMin = view === "front" ? -Math.max(geometry.frontTrackM, geometry.rearTrackM, 0.2) / 2 - 0.15 : -0.15;
  const uReferenceMax = view === "front" ? Math.max(geometry.frontTrackM, geometry.rearTrackM, 0.2) / 2 + 0.15 : geometry.designWheelbaseM + 0.15;
  const minU = Math.min(...raw.map((point) => point[0]), ...wheelRaw.map(({ wheel, center }) => center[0] - horizontalWheelHalfExtent(wheel)), uReferenceMin);
  const maxU = Math.max(...raw.map((point) => point[0]), ...wheelRaw.map(({ wheel, center }) => center[0] + horizontalWheelHalfExtent(wheel)), uReferenceMax);
  const minV = Math.min(...raw.map((point) => point[1]), ...wheelRaw.map(({ wheel, center }) => center[1] - verticalWheelHalfExtent(wheel)), -0.08);
  const maxV = Math.max(...raw.map((point) => point[1]), ...wheelRaw.map(({ wheel, center }) => center[1] + verticalWheelHalfExtent(wheel)), 0.15);
  const rangeU = Math.max(0.1, maxU - minU);
  const rangeV = Math.max(0.1, maxV - minV);
  const scale = Math.min(270 / rangeU, 145 / rangeV);
  const originU = 15 + (270 - rangeU * scale) / 2;
  const originV = 14 + (145 - rangeV * scale) / 2;
  const screen = (point: readonly [number, number]): readonly [number, number] => [originU + (point[0] - minU) * scale, originV + (maxV - point[1]) * scale];
  const byId = new Map(geometry.hardpoints.map((point) => [point.id, point]));
  const members = geometry.members.map((member) => ({ id: member.id, layer: member.layer, style: member.style, a: screen(projectPoint(byId.get(member.fromHardpointId)!.positionM, view)), b: screen(projectPoint(byId.get(member.toHardpointId)!.positionM, view)) }));
  const wheels = wheelRaw.map(({ wheel, center }) => ({ id: wheel.id, center: screen(center), radius: wheel.radiusM * scale, width: wheel.widthM * scale, steerDeg: wheel.steerRad * 180 / Math.PI, camberDeg: wheel.camberRad * 180 / Math.PI }));
  const points = geometry.hardpoints.map((point) => ({ id: point.id, xy: screen(projectPoint(point.positionM, view)), source: point.source, category: point.category, stateDependent: point.stateDependent }));
  const trackStationX = geometry.frontTrackM > 0 ? geometry.designWheelbaseM : 0;
  const dimensionA = view === "side" ? screen(projectPoint([0, 0, 0], view)) : screen(projectPoint([trackStationX, geometry.frontTrackM > 0 ? geometry.frontTrackM / 2 : geometry.rearTrackM / 2, 0], view));
  const dimensionB = view === "side" ? screen(projectPoint([geometry.designWheelbaseM, 0, 0], view)) : screen(projectPoint([trackStationX, geometry.frontTrackM > 0 ? -geometry.frontTrackM / 2 : -geometry.rearTrackM / 2, 0], view));
  return { members, wheels, points, dimensionA, dimensionB };
}

function projectPoint(point: readonly [number, number, number], view: VehicleDrawingView): readonly [number, number] {
  if (view === "side") return [point[0], point[2]];
  if (view === "top") return [point[0], point[1]];
  return [point[1], point[2]];
}

function Result({ label, value, status }: { readonly label: string; readonly value: string; readonly status?: string }): React.JSX.Element { return <div><dt>{label}</dt><dd>{value}{status !== undefined && <small>{status}</small>}</dd></div>; }

function c(key: VehicleParameterKey, label: string, unit: string, min: number, max: number, step: number, conversion: Conversion = "identity", layouts?: readonly VehicleLayout[], powertrains?: readonly VehiclePowertrainKind[]): ParameterControl {
  return { key, label, unit, min, max, step, conversion, ...(layouts === undefined ? {} : { layouts }), ...(powertrains === undefined ? {} : { powertrains }) };
}

function displayValues(intent: VehicleIntent): Readonly<Record<VehicleParameterKey, number>> {
  const result = {} as Record<VehicleParameterKey, number>;
  for (const group of PARAMETER_GROUPS) for (const control of group.controls) result[control.key] = toDisplay(intent.parameters[control.key], control.conversion ?? "identity");
  return result;
}

function toDisplay(value: number, conversion: Conversion): number {
  if (conversion === "mm") return value * 1000;
  if (conversion === "deg") return value * 180 / Math.PI;
  if (conversion === "kn-per-m") return value / 1000;
  if (conversion === "square-mm") return value * 1e6;
  if (conversion === "mpa") return value / 1e6;
  if (conversion === "percent") return value * 100;
  if (conversion === "kmh") return value * 3.6;
  if (conversion === "grade-percent") return Math.tan(value) * 100;
  if (conversion === "kwh") return value / 3.6e6;
  if (conversion === "wh-per-km") return value / 3.6;
  return value;
}

function fromDisplay(value: number, conversion: Conversion): number {
  if (conversion === "mm") return value / 1000;
  if (conversion === "deg") return value * Math.PI / 180;
  if (conversion === "kn-per-m") return value * 1000;
  if (conversion === "square-mm") return value / 1e6;
  if (conversion === "mpa") return value * 1e6;
  if (conversion === "percent") return value / 100;
  if (conversion === "kmh") return value / 3.6;
  if (conversion === "grade-percent") return Math.atan(value / 100);
  if (conversion === "kwh") return value * 3.6e6;
  if (conversion === "wh-per-km") return value * 3.6;
  return value;
}

function roundDraft(value: number, step: number): number { return Number(value.toFixed(step < 0.01 ? 4 : step < 0.1 ? 3 : step < 1 ? 2 : 1)); }
function format(value: number, digits: number): string { return Number.isFinite(value) ? Number(value.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits }) : "—"; }
function finite(value: number | null, unit: string, digits: number): string { return value !== null && Number.isFinite(value) ? `${format(value, digits)} ${unit}` : "unavailable"; }
function formatNullable(value: number | null, digits: number): string { return value === null ? "unavailable" : format(value, digits); }
function humanize(value: string): string { return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
