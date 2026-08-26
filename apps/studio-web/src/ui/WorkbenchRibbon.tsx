import type { DisplayUnit } from "../../../../packages/model-schema/src/index.js";
import type { AssemblyTemplateId, DrawingDatumScheme, DrawingDisplayStyle, DrawingDraftingStandard, DrawingSettings, ElectricalComponentKind, ElectricalStandard, ElectricalTemplateId, PartPreviewBodyShape, SurfaceIntent, VehicleLayerId, VehicleSimulationState, VehicleTemplateId, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { SketchTool } from "../../../../packages/workbench-sketch/src/index.js";
import { WORKBENCH_MCP_TOOLS } from "../../../../packages/workbench-mcp/src/index.js";
import { CapabilityBadge } from "./CapabilityBadge.js";
import { CommandIcon, iconTone } from "./CommandIcon.js";

type SurfaceParameter = "widthMm" | "depthMm" | "crownMm" | "twistDeg" | "uSegments" | "vSegments";

interface WorkbenchRibbonProps {
  readonly project: WorkbenchProject;
  readonly masterCartOpen: boolean;
  readonly displayUnit: DisplayUnit;
  readonly sketchTool: SketchTool;
  readonly sketchDimensionMode: boolean;
  readonly selectedId: string | null;
  readonly onSketchTool: (tool: SketchTool) => void;
  readonly onSketchDimension: () => void;
  readonly onToggleSketchEntityVisibility: (entityId: string) => void;
  readonly onFinishSketch: () => void;
  readonly onCancelSketchPoints: () => void;
  readonly onSelect: (id: string | null) => void;
  readonly onFit: () => void;
  readonly onMeasure: () => void;
  readonly onNativeDownload: () => void;
  readonly onNativeOpen: () => void;
  readonly onExportStl: () => void;
  readonly onExchange: () => void;
  readonly onDisplayUnit: (unit: DisplayUnit) => void;
  readonly onAssemblyExplode: (valueMm: number) => void;
  readonly onAssemblyTemplate: (template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel">) => void;
  readonly onInsertPartIntoAssembly: () => void;
  readonly onCreatePartPreviewBody: (shape: PartPreviewBodyShape) => void;
  readonly onPartPreviewAction: (operation: "edit-transform" | "edit-size" | "edit-appearance" | "duplicate" | "mirror-x" | "pattern-x" | "toggle-visible" | "delete", commandName: string) => void;
  readonly onInsertComponent: (shape: "box" | "cylinder") => void;
  readonly onDeleteComponent: (componentId: string) => void;
  readonly onToggleGrounded: (componentId: string) => void;
  readonly onToggleVisibility: (componentId: string) => void;
  readonly onSurfaceMode: (mode: SurfaceIntent["mode"]) => void;
  readonly onSurfaceParameter: (parameter: SurfaceParameter, value: number) => void;
  readonly onDrawingSheet: (sheet: DrawingSettings["sheet"]) => void;
  readonly onDrawingProjection: (projection: DrawingSettings["projection"]) => void;
  readonly onDrawingScale: (scale: DrawingSettings["scale"]) => void;
  readonly onDrawingDimensions: (show: boolean) => void;
  readonly onDrawingViewPreset: (preset: NonNullable<DrawingSettings["viewPreset"]>) => void;
  readonly onDrawingDisplayStyle: (style: DrawingDisplayStyle) => void;
  readonly onDrawingSectionView: (show: boolean) => void;
  readonly onDrawingDraftingStandard: (standard: DrawingDraftingStandard) => void;
  readonly onDrawingGdt: (show: boolean) => void;
  readonly onDrawingDatumScheme: (scheme: DrawingDatumScheme) => void;
  readonly onDrawingDownload: () => void;
  readonly onElectricalTemplate: (template: ElectricalTemplateId) => void;
  readonly onElectricalStandard: (standard: ElectricalStandard) => void;
  readonly onElectricalInsert: (kind: ElectricalComponentKind) => void;
  readonly onElectricalPhysicalize: () => void;
  readonly onElectricalDownload: () => void;
  readonly onVehicleTemplate: (template: VehicleTemplateId) => void;
  readonly onVehicleState: (state: VehicleSimulationState) => void;
  readonly onVehicleLayer: (layer: VehicleLayerId) => void;
  readonly onCloseMasterCart: () => void;
}

const SKETCH_TOOLS: readonly { readonly id: SketchTool; readonly icon: string; readonly label: string; readonly key: string }[] = [
  { id: "select", icon: "select", label: "Select", key: "V" },
  { id: "line", icon: "line", label: "Line", key: "L" },
  { id: "rectangle", icon: "rectangle", label: "2-point rectangle", key: "R" },
  { id: "rectangle-center", icon: "rectangle", label: "Center rectangle", key: "R2" },
  { id: "rectangle-three-point", icon: "rectangle", label: "3-point rectangle", key: "R3" },
  { id: "circle", icon: "circle", label: "Center circle", key: "C" },
  { id: "circle-two-point", icon: "circle", label: "2-point circle", key: "C2" },
  { id: "circle-three-point", icon: "circle", label: "3-point circle", key: "C3" },
  { id: "arc", icon: "arc", label: "3-point arc", key: "A" }
];

const PART_FEATURES = [
  { id: "feature:plate-extrusion", icon: "extrude", label: "Extrude", level: "qualified" },
  { id: "feature:centered-through-hole", icon: "bore", label: "Bore", level: "qualified" },
  { id: "feature:edge-treatment", icon: "edge", label: "Edge", level: "preview" },
  { id: "feature:linear-pattern", icon: "pattern", label: "Pattern", level: "preview" },
  { id: "feature:revolve-study", icon: "revolve", label: "Revolve", level: "preview" }
] as const;

export function WorkbenchRibbon(props: WorkbenchRibbonProps): React.JSX.Element {
  const level = props.project.activeWorkspace === "part" ? "qualified" : "preview";
  const selectedComponent = props.project.assembly.components.find((component) => component.id === props.selectedId);
  const selectedSketchEntity = props.project.sketch.entities.find((entity) => entity.id === props.selectedId);
  return <section className="command-ribbon" role="toolbar" aria-label={`${props.project.activeWorkspace} command ribbon`}>
    <div className="ribbon-context">
      <small>Active workspace</small>
      <strong>{props.masterCartOpen ? "Master Cart" : workspaceLabel(props.project.activeWorkspace)}</strong>
      <CapabilityBadge level={level} />
    </div>
    {props.masterCartOpen && <>
      <RibbonGroup label="Parametric catalog">
        <RibbonButton icon="master-cart" label="25 families" hint="original PS3D" active />
        <RibbonButton icon="fastener" label="Fasteners" hint="metric + inch" active />
        <RibbonButton icon="bearing" label="Bearings" hint="rotary + linear" active />
        <RibbonButton icon="gear" label="Power transmission" hint="gear · chain · belt" active />
      </RibbonGroup>
      <RibbonGroup label="Supplier reference boundary">
        <RibbonButton icon="shield" label="No copied assets" hint="source links only" active />
        <RibbonButton icon="dimension" label="Editable sizes" hint="mm internal" active />
        <RibbonButton icon="assemble" label="Grouped insert" hint="one revision" active />
      </RibbonGroup>
      <RibbonGroup label="Return">
        <RibbonButton icon="assembly" label="Assembly" hint="close catalog" onClick={props.onCloseMasterCart} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "sketch" && <>
      <RibbonGroup label="Create geometry">
        {SKETCH_TOOLS.map((tool) => <RibbonButton key={tool.id} icon={tool.icon} label={tool.label} hint={tool.key} active={props.sketchTool === tool.id} onClick={() => props.onSketchTool(tool.id)} />)}
        <RibbonButton icon="spline" label="Spline" hint="solver req." disabled />
        <RibbonButton icon="insert" label="Point" hint="solver req." disabled />
      </RibbonGroup>
      <RibbonGroup label="Sketch session">
        <RibbonButton icon="save" label="Finish Sketch" hint="to Part" onClick={props.onFinishSketch} />
        <RibbonButton icon="cancel" label="Cancel points" hint="Esc" onClick={props.onCancelSketchPoints} />
        <RibbonButton icon="plane" label="XY plane" hint={`${props.project.sketch.gridMm} mm`} active />
      </RibbonGroup>
      <RibbonGroup label="Dimension & modify">
        <RibbonButton icon="dimension" label="Dimension" hint="points / curve" active={props.sketchDimensionMode} onClick={props.onSketchDimension} />
        <RibbonButton icon={selectedSketchEntity?.visible === false ? "eye" : "eye-off"} label={selectedSketchEntity?.visible === false ? "Show" : "Hide"} hint="sketch entity" disabled={selectedSketchEntity === undefined} onClick={() => { if (selectedSketchEntity !== undefined) props.onToggleSketchEntityVisibility(selectedSketchEntity.id); }} />
        <RibbonButton icon="trim" label="Trim" hint="exact req." disabled />
        <RibbonButton icon="offset" label="Offset" hint="exact req." disabled />
        <RibbonButton icon="edge" label="Fillet" hint="exact req." disabled />
        <RibbonButton icon="edge" label="Chamfer" hint="exact req." disabled />
        <RibbonButton icon="line" label="Extend" hint="exact req." disabled />
        <RibbonButton icon="constraint" label="Corner" hint="solver req." disabled />
        <RibbonButton icon="pattern" label="Pattern" hint="solver req." disabled />
        <RibbonButton icon="mirror" label="Mirror" hint="solver req." disabled />
      </RibbonGroup>
      <RibbonGroup label="Include & solve">
        <RibbonButton icon="projection" label="Include" hint="topology req." disabled />
        <RibbonButton icon="fixed" label="Fix Curve" hint="solver req." disabled />
        <RibbonButton icon="inspect" label="Show Movable" hint="solver req." disabled />
        <RibbonButton icon="dimension" label="Relax Dimensions" hint="solver req." disabled />
        <RibbonButton icon="constraint" label="Relax Relations" hint="solver req." disabled />
        <RibbonButton icon="shield" label="Sketch Checking" hint="solver req." disabled />
        <RibbonButton icon="display" label="Options" hint="palette" disabled />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "part" && <>
      <RibbonGroup label="Feature tools">
        {PART_FEATURES.map((feature) => <RibbonButton key={feature.id} icon={feature.icon} label={feature.label} hint={feature.level} active={props.selectedId === feature.id} onClick={() => props.onSelect(feature.id)} />)}
      </RibbonGroup>
      <RibbonGroup label="Primitive bodies">
        <RibbonButton icon="box" label="Block" hint="preview body" onClick={() => props.onCreatePartPreviewBody("block")} />
        <RibbonButton icon="cylinder" label="Cylinder" hint="preview body" onClick={() => props.onCreatePartPreviewBody("cylinder")} />
        <RibbonButton icon="cone" label="Cone" hint="preview body" onClick={() => props.onCreatePartPreviewBody("cone")} />
        <RibbonButton icon="sphere" label="Sphere" hint="preview body" onClick={() => props.onCreatePartPreviewBody("sphere")} />
      </RibbonGroup>
      <RibbonGroup label="Direct body edit">
        <RibbonButton icon="move" label="Move" hint="XYZ / rotate" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("edit-transform", "Move Body")} />
        <RibbonButton icon="scale" label="Size" hint="dimensions" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("edit-size", "Scale Body")} />
        <RibbonButton icon="copy" label="Copy" hint="independent" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("duplicate", "Copy Body")} />
        <RibbonButton icon="pattern" label="Pattern" hint="3 × X" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("pattern-x", "Pattern Body")} />
        <RibbonButton icon="mirror" label="Mirror" hint="YZ plane" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("mirror-x", "Mirror Body")} />
        <RibbonButton icon="appearance" label="Appearance" hint="display color" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("edit-appearance", "Edit Object Display")} />
        <RibbonButton icon="eye-off" label="Hide / show" hint="body" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("toggle-visible", "Show / Hide Body")} />
        <RibbonButton icon="trash" label="Delete" hint="body" disabled={props.selectedId?.startsWith("part-body:") !== true} onClick={() => props.onPartPreviewAction("delete", "Delete Body")} />
      </RibbonGroup>
      <RibbonGroup label="Inspect & exchange">
        <RibbonButton icon="fit" label="Fit" hint="view" onClick={props.onFit} />
        <RibbonButton icon="json" label="Native JSON" hint="save" onClick={props.onNativeDownload} />
        <RibbonButton icon="open" label="Open native" hint="load" onClick={props.onNativeOpen} />
        <RibbonButton icon="export" label="Export STL" hint="mesh" onClick={props.onExportStl} />
        <RibbonButton icon="exchange" label="3D Exchange" hint="14 in · 6 out" onClick={props.onExchange} />
      </RibbonGroup>
      <RibbonGroup label="Downstream">
        <RibbonButton icon="assemble" label="Insert to assembly" hint="snapshot" onClick={props.onInsertPartIntoAssembly} />
      </RibbonGroup>
      <RibbonGroup label="Display units">
        <RibbonButton icon="units-mm" label="Millimeter" hint="mm" active={props.displayUnit === "mm"} onClick={() => props.onDisplayUnit("mm")} />
        <RibbonButton icon="units-in" label="Inch" hint="in" active={props.displayUnit === "in"} onClick={() => props.onDisplayUnit("in")} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "assembly" && <>
      <RibbonGroup label="Auto-generate template">
        <RibbonButton icon="container" label="20 ft cargo" hint="6058 mm nominal" active={props.project.assembly.template === "cargo-20ft"} onClick={() => props.onAssemblyTemplate("cargo-20ft")} />
        <RibbonButton icon="container" label="40 ft high cube" hint="12192 mm nominal" active={props.project.assembly.template === "cargo-40ft-hc"} onClick={() => props.onAssemblyTemplate("cargo-40ft-hc")} />
        <RibbonButton icon="battery" label="BESS layout" hint="20 ft HC concept" active={props.project.assembly.template === "bess-20ft-hc"} onClick={() => props.onAssemblyTemplate("bess-20ft-hc")} />
      </RibbonGroup>
      <RibbonGroup label="Insert component">
        <RibbonButton icon="box" label="Box" hint="preview" onClick={() => props.onInsertComponent("box")} />
        <RibbonButton icon="cylinder" label="Cylinder" hint="preview" onClick={() => props.onInsertComponent("cylinder")} />
      </RibbonGroup>
      <RibbonGroup label="Assembly position">
        <RibbonButton icon="assemble" label="Assemble" hint="0 mm" active={props.project.assembly.explodeMm === 0} onClick={() => props.onAssemblyExplode(0)} />
        <RibbonButton icon="explode" label="Explode" hint="32 mm" active={props.project.assembly.explodeMm > 0} onClick={() => props.onAssemblyExplode(32)} />
        <RibbonButton icon="fit" label="Fit all" hint="view" onClick={props.onFit} />
      </RibbonGroup>
      <RibbonGroup label="Component state">
        <RibbonButton icon="move" label="Move" hint="XYZ" active={props.selectedId === "assembly-action:move"} disabled={selectedComponent === undefined} onClick={() => { if (selectedComponent !== undefined) props.onSelect(selectedComponent.id); }} />
        <RibbonButton icon="ground" label={selectedComponent?.grounded === true ? "Release" : "Ground"} hint="toggle" active={selectedComponent?.grounded === true} disabled={selectedComponent === undefined} onClick={() => { if (selectedComponent !== undefined) props.onToggleGrounded(selectedComponent.id); }} />
        <RibbonButton icon={selectedComponent?.visible === false ? "eye" : "eye-off"} label={selectedComponent?.visible === false ? "Show" : "Hide"} hint="preview" disabled={selectedComponent === undefined} onClick={() => { if (selectedComponent !== undefined) props.onToggleVisibility(selectedComponent.id); }} />
        <RibbonButton icon="trash" label="Delete" hint="component" disabled={selectedComponent === undefined} onClick={() => { if (selectedComponent !== undefined) props.onDeleteComponent(selectedComponent.id); }} />
      </RibbonGroup>
      <RibbonGroup label="Inspect & relationships">
        <RibbonButton icon="mate" label="Mates" hint={`${props.project.assembly.mates.length}`} onClick={() => props.onSelect(props.project.assembly.mates[0]?.id ?? null)} />
        <RibbonButton icon="interference" label="Interference" hint="AABB" onClick={() => props.onSelect("analysis:interference")} />
        <RibbonButton icon="exchange" label="3D Exchange" hint="scene out" onClick={props.onExchange} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "surface" && <>
      <RibbonGroup label="Surface creation">
        <RibbonButton icon="bezier" label="Bézier" hint="patch" active={props.project.surface.mode === "bezier"} onClick={() => props.onSurfaceMode("bezier")} />
        <RibbonButton icon="loft" label="Ruled loft" hint="2 profiles" active={props.project.surface.mode === "loft"} onClick={() => props.onSurfaceMode("loft")} />
      </RibbonGroup>
      <RibbonGroup label="Shape presets">
        <RibbonButton icon="flatten" label="Flatten" hint="C0" onClick={() => { props.onSurfaceParameter("crownMm", 0); props.onSurfaceParameter("twistDeg", 0); }} />
        <RibbonButton icon="canopy" label="Canopy" hint="crown" onClick={() => { props.onSurfaceParameter("crownMm", 22); props.onSurfaceParameter("twistDeg", 12); }} />
        <RibbonButton icon="fit" label="Fit surface" hint="view" onClick={props.onFit} />
        <RibbonButton icon="exchange" label="3D Exchange" hint="scene out" onClick={props.onExchange} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "drawing" && <>
      <RibbonGroup label="Automatic drawing">
        <RibbonButton icon="auto-view" label="Base + projections" hint="linked" active={(props.project.drawing.viewPreset ?? "automatic-4-view") === "automatic-4-view"} onClick={() => props.onDrawingViewPreset("automatic-4-view")} />
        <RibbonButton icon="projection" label="3 orthographic" hint="linked" active={props.project.drawing.viewPreset === "orthographic-3-view"} onClick={() => props.onDrawingViewPreset("orthographic-3-view")} />
        <RibbonButton icon="section" label="Section A–A" hint="full section" active={props.project.drawing.showSectionView ?? false} disabled={(props.project.drawing.viewPreset ?? "automatic-4-view") === "front-only"} onClick={() => props.onDrawingSectionView(!(props.project.drawing.showSectionView ?? false))} />
        <RibbonButton icon="dimension" label="Selected dimensions" hint="no duplicates" active={props.project.drawing.showDimensions} onClick={() => props.onDrawingDimensions(!props.project.drawing.showDimensions)} />
      </RibbonGroup>
      <RibbonGroup label="Standard & projection">
        <RibbonButton icon="sheet" label="ASME basis" hint="3rd angle default" active={(props.project.drawing.draftingStandard ?? "ASME") === "ASME"} onClick={() => props.onDrawingDraftingStandard("ASME")} />
        <RibbonButton icon="sheet" label="ISO basis" hint="1st angle default" active={props.project.drawing.draftingStandard === "ISO"} onClick={() => props.onDrawingDraftingStandard("ISO")} />
        <RibbonButton icon="projection" label="Third angle" hint="projection" active={props.project.drawing.projection === "third-angle"} onClick={() => props.onDrawingProjection("third-angle")} />
        <RibbonButton icon="projection" label="First angle" hint="projection" active={props.project.drawing.projection === "first-angle"} onClick={() => props.onDrawingProjection("first-angle")} />
      </RibbonGroup>
      <RibbonGroup label="Visibility & annotation">
        <RibbonButton icon="eye" label="Visible edges" hint="HLR" active={(props.project.drawing.displayStyle ?? "visible-hidden-edges") === "visible-edges"} onClick={() => props.onDrawingDisplayStyle("visible-edges")} />
        <RibbonButton icon="eye-off" label="Hidden edges" hint="show hidden" active={(props.project.drawing.displayStyle ?? "visible-hidden-edges") === "visible-hidden-edges"} onClick={() => props.onDrawingDisplayStyle("visible-hidden-edges")} />
        <RibbonButton icon="datum" label="Plate datums" hint="3-2-1 draft" active={props.project.drawing.datumScheme === "plate-3-2-1"} onClick={() => props.onDrawingDatumScheme(props.project.drawing.datumScheme === "plate-3-2-1" ? "none" : "plate-3-2-1")} />
        <RibbonButton icon="gdt-position" label="Explicit GD&amp;T" hint="authored values" active={props.project.drawing.showGdt ?? false} onClick={() => props.onDrawingGdt(!(props.project.drawing.showGdt ?? false))} />
      </RibbonGroup>
      <RibbonGroup label="Sheet, scale & output">
        {(["A4", "A3"] as const).map((sheet) => <RibbonButton key={sheet} icon="sheet" label={`${sheet} sheet`} hint="format" active={props.project.drawing.sheet === sheet} onClick={() => props.onDrawingSheet(sheet)} />)}
        {([1, 2, 5] as const).map((scale) => <RibbonButton key={scale} icon="scale" label={`Scale 1:${scale}`} hint="sheet" active={props.project.drawing.scale === scale} onClick={() => props.onDrawingScale(scale)} />)}
        <RibbonButton icon="download" label="Download" hint="vector" onClick={props.onDrawingDownload} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "electrical" && <>
      <RibbonGroup label="Auto-generate circuit">
        <RibbonButton icon="battery" label="BESS single-line" hint="DC → PCS → PCC" active={props.project.electrical.template === "bess-single-line"} onClick={() => props.onElectricalTemplate("bess-single-line")} />
        <RibbonButton icon="contactor" label="DC auxiliary" hint="control concept" active={props.project.electrical.template === "dc-control"} onClick={() => props.onElectricalTemplate("dc-control")} />
        <RibbonButton icon="motor" label="Motor starter" hint="DOL concept" active={props.project.electrical.template === "motor-starter"} onClick={() => props.onElectricalTemplate("motor-starter")} />
      </RibbonGroup>
      <RibbonGroup label="Insert electrical component">
        <RibbonButton icon="battery" label="Battery" hint="BAT" onClick={() => props.onElectricalInsert("battery")} />
        <RibbonButton icon="fuse" label="Fuse" hint="F" onClick={() => props.onElectricalInsert("fuse")} />
        <RibbonButton icon="breaker" label="Breaker" hint="QF" onClick={() => props.onElectricalInsert("breaker")} />
        <RibbonButton icon="disconnect" label="Disconnect" hint="QS" onClick={() => props.onElectricalInsert("disconnect")} />
        <RibbonButton icon="transformer" label="Transformer" hint="T" onClick={() => props.onElectricalInsert("transformer")} />
        <RibbonButton icon="motor" label="Motor" hint="M" onClick={() => props.onElectricalInsert("motor")} />
      </RibbonGroup>
      <RibbonGroup label="Drafting basis & output">
        <RibbonButton icon="electrical" label="IEC basis" hint="symbols" active={props.project.electrical.standard === "IEC"} onClick={() => props.onElectricalStandard("IEC")} />
        <RibbonButton icon="electrical" label="ANSI basis" hint="symbols" active={props.project.electrical.standard === "ANSI"} onClick={() => props.onElectricalStandard("ANSI")} />
        <RibbonButton icon="wire" label="Net editor" hint={`${props.project.electrical.nets.length} nets`} onClick={() => props.onSelect("electrical-action:nets")} />
        <RibbonButton icon="inspect" label="Run ERC" hint="live" onClick={() => props.onSelect("electrical-action:erc")} />
        <RibbonButton icon="download" label="Download SVG" hint="vector" onClick={props.onElectricalDownload} />
      </RibbonGroup>
      <RibbonGroup label="ECAD → MCAD">
        <RibbonButton icon="circuit-3d" label="Wired mounting plate" hint="DIN + ducts + conductors" onClick={props.onElectricalPhysicalize} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "vehicle" && <>
      <RibbonGroup label="Original vehicle templates">
        <RibbonButton icon="vehicle" label="ICE motorcycle" hint="single-track" active={props.project.vehicle.template === "ice-road-motorcycle"} onClick={() => props.onVehicleTemplate("ice-road-motorcycle")} />
        <RibbonButton icon="scooter" label="Scooter" hint="step-through" active={props.project.vehicle.template === "step-through-scooter"} onClick={() => props.onVehicleTemplate("step-through-scooter")} />
        <RibbonButton icon="battery" label="EV motorcycle" hint="single operating point" active={props.project.vehicle.template === "ev-street-motorcycle"} onClick={() => props.onVehicleTemplate("ev-street-motorcycle")} />
        <RibbonButton icon="three-wheel" label="Delta cargo 3W" hint="1 front · 2 rear" active={props.project.vehicle.template === "delta-cargo-three-wheeler"} onClick={() => props.onVehicleTemplate("delta-cargo-three-wheeler")} />
        <RibbonButton icon="steering" label="Tadpole geometry" hint="2 front · 1 rear" active={props.project.vehicle.template === "tadpole-geometry-three-wheeler"} onClick={() => props.onVehicleTemplate("tadpole-geometry-three-wheeler")} />
      </RibbonGroup>
      <RibbonGroup label="Suspension state">
        <RibbonButton icon="arrow-up" label="Full droop" hint="maximum rebound state" active={props.project.vehicle.state === "full-droop"} onClick={() => props.onVehicleState("full-droop")} />
        <RibbonButton icon="suspension" label="Design ride" hint="sag datum" active={props.project.vehicle.state === "design-ride"} onClick={() => props.onVehicleState("design-ride")} />
        <RibbonButton icon="arrow-down" label="Full bump" hint="travel limit" active={props.project.vehicle.state === "full-bump"} onClick={() => props.onVehicleState("full-bump")} />
      </RibbonGroup>
      <RibbonGroup label="Engineering layers">
        <RibbonButton icon="sketch" label="Skeleton" hint="centerlines" active={props.project.vehicle.layers.skeleton} onClick={() => props.onVehicleLayer("skeleton")} />
        <RibbonButton icon="hardpoint" label="Hardpoints" hint="XYZ stations" active={props.project.vehicle.layers.hardpoints} onClick={() => props.onVehicleLayer("hardpoints")} />
        <RibbonButton icon="suspension" label="Suspension" hint="members" active={props.project.vehicle.layers.suspension} onClick={() => props.onVehicleLayer("suspension")} />
        <RibbonButton icon="cg" label="CG + loads" hint="support screen" active={props.project.vehicle.layers["cg-loads"]} onClick={() => props.onVehicleLayer("cg-loads")} />
      </RibbonGroup>
      <RibbonGroup label="Inspect & exchange">
        <RibbonButton icon="fit" label="Fit vehicle" hint="view" onClick={props.onFit} />
        <RibbonButton icon="measure" label="Measure" hint="two points" onClick={props.onMeasure} />
        <RibbonButton icon="exchange" label="3D Exchange" hint="visible scene" onClick={props.onExchange} />
      </RibbonGroup>
    </>}
    {!props.masterCartOpen && props.project.activeWorkspace === "automate" && <>
      <RibbonGroup label="MCP tool surface">
        {WORKBENCH_MCP_TOOLS.map((tool) => <RibbonButton key={tool.name} icon="mcp" label={tool.title.replace("PS3D ", "")} hint={tool.annotations.readOnlyHint ? "read" : "confirm"} active={props.selectedId === `mcp-tool:${tool.name}`} onClick={() => props.onSelect(`mcp-tool:${tool.name}`)} />)}
      </RibbonGroup>
      <RibbonGroup label="Language linking">
        <RibbonButton icon="python" label="Python SDK" hint="stdlib" active={props.selectedId === "automation:python-sdk"} onClick={() => props.onSelect("automation:python-sdk")} />
        <RibbonButton icon="mcp" label="Remote MCP" hint="security req." disabled />
      </RibbonGroup>
    </>}
    <div className="ribbon-spacer" />
    <div className="ribbon-project-facts"><span>Revision</span><strong>{props.project.revision}</strong><span>Selection</span><strong>{props.selectedId?.split(":").at(-1) ?? "none"}</strong></div>
  </section>;
}

function RibbonGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="ribbon-group" role="group" aria-label={label}><div>{children}</div><small>{label}</small></div>;
}

function RibbonButton(props: { readonly icon: string; readonly label: string; readonly hint: string; readonly active?: boolean; readonly disabled?: boolean; readonly onClick?: () => void }): React.JSX.Element {
  return <button className={`ribbon-button tone-${iconTone(props.icon)} ${props.active === true ? "active" : ""}`} aria-pressed={props.active} disabled={props.disabled} onClick={props.onClick} title={`${props.label} · ${props.hint}`}><span aria-hidden="true"><CommandIcon name={props.icon} /></span><strong>{props.label}</strong><small>{props.hint}</small></button>;
}

function workspaceLabel(workspace: WorkbenchProject["activeWorkspace"]): string {
  const labels = { sketch: "Sketch", part: "Part modeling", assembly: "Assembly", surface: "Surface", drawing: "Drawing", electrical: "Electrical", vehicle: "Vehicle engineering", automate: "Automate" };
  return labels[workspace];
}
