import type { AssemblyTemplateId, CapabilityLevel, ComponentShape, ElectricalComponentKind, ElectricalTemplateId, VehicleLayerId, VehicleSimulationState, VehicleTemplateId, WorkspaceId } from "./types.js";

export type CadCommandCategory = "create" | "modify" | "construct" | "assemble" | "inspect" | "document" | "automate";
export type CadSketchTool = "select" | "line" | "rectangle" | "circle" | "arc";

export type CadCommandAction =
  | { readonly kind: "open-workspace" }
  | { readonly kind: "activate-sketch-tool"; readonly tool: CadSketchTool }
  | { readonly kind: "select-record"; readonly selectionId: string }
  | { readonly kind: "insert-component"; readonly shape: Extract<ComponentShape, "box" | "cylinder"> }
  | { readonly kind: "apply-assembly-template"; readonly template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel"> }
  | { readonly kind: "selected-component-action"; readonly operation: "delete" | "toggle-grounded" | "toggle-visible" }
  | { readonly kind: "set-surface-mode"; readonly mode: "bezier" | "loft" }
  | { readonly kind: "fit-view" }
  | { readonly kind: "set-view-orientation"; readonly orientation: "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric" }
  | { readonly kind: "set-view-projection"; readonly projection: "perspective" | "orthographic" }
  | { readonly kind: "set-navigation-mode"; readonly mode: "select" | "orbit" | "pan" | "measure" }
  | { readonly kind: "set-selection-filter"; readonly filter: "auto" | "body" | "component" }
  | { readonly kind: "open-exchange-center" }
  | { readonly kind: "open-design-health" }
  | { readonly kind: "apply-electrical-template"; readonly template: ElectricalTemplateId }
  | { readonly kind: "insert-electrical-component"; readonly componentKind: ElectricalComponentKind }
  | { readonly kind: "generate-electromechanical-realization" }
  | { readonly kind: "apply-vehicle-template"; readonly template: VehicleTemplateId }
  | { readonly kind: "set-vehicle-state"; readonly state: VehicleSimulationState }
  | { readonly kind: "toggle-vehicle-layer"; readonly layer: VehicleLayerId }
  | { readonly kind: "unavailable" };

export interface CadCommandRecord {
  readonly id: string;
  readonly workspace: WorkspaceId;
  readonly category: CadCommandCategory;
  readonly name: string;
  readonly description: string;
  readonly level: CapabilityLevel;
  readonly action: CadCommandAction;
  readonly keywords: readonly string[];
  readonly shortcut?: string;
}

export const CAD_COMMANDS: readonly CadCommandRecord[] = [
  command("command:sketch-select", "sketch", "inspect", "Select", "Select sketch entities by stable ID.", "preview", { kind: "activate-sketch-tool", tool: "select" }, ["cursor", "pick"], "V"),
  command("command:sketch-line", "sketch", "create", "Line", "Create a bounded two-point line.", "preview", { kind: "activate-sketch-tool", tool: "line" }, ["segment", "profile"], "L"),
  command("command:sketch-rectangle", "sketch", "create", "Center rectangle", "Create a center-defined rectangle.", "preview", { kind: "activate-sketch-tool", tool: "rectangle" }, ["box", "profile"], "R"),
  command("command:sketch-circle", "sketch", "create", "Center circle", "Create a center-and-radius circle.", "preview", { kind: "activate-sketch-tool", tool: "circle" }, ["diameter", "round"], "C"),
  command("command:sketch-arc", "sketch", "create", "Three-point arc", "Create a non-collinear three-point arc.", "preview", { kind: "activate-sketch-tool", tool: "arc" }, ["curve", "radius"], "A"),
  unavailable("command:sketch-spline", "sketch", "create", "Fit-point spline", "Requires a qualified spline representation and solver.", ["bezier", "curve"]),
  unavailable("command:sketch-slot", "sketch", "create", "Slot", "Requires tangent-chain constraints and profile trimming.", ["obround", "profile"]),
  unavailable("command:sketch-polygon", "sketch", "create", "Polygon", "Requires parametric edge-count and construction constraints.", ["hexagon", "profile"]),
  unavailable("command:sketch-trim", "sketch", "modify", "Trim", "Requires robust curve intersection and reference repair.", ["extend", "split"]),
  unavailable("command:sketch-offset", "sketch", "modify", "Offset", "Requires robust curve offsetting and corner resolution.", ["parallel", "distance"]),
  unavailable("command:sketch-project", "sketch", "construct", "Project geometry", "Requires persistent topology references from a qualified solid kernel.", ["include", "reference"]),
  command("command:sketch-dimension", "sketch", "construct", "Driving dimension", "Edit bounded line length, rectangle width/height, and circle radius dimensions.", "preview", { kind: "open-workspace" }, ["constraint", "measure"], "D"),
  command("command:sketch-pair-constraints", "sketch", "construct", "Pair constraints", "Shift-select two entities for parallel, perpendicular, collinear, concentric, equal, or tangent intent.", "preview", { kind: "open-workspace" }, ["horizontal", "vertical", "parallel", "perpendicular", "concentric"]),
  command("command:sketch-palette", "sketch", "inspect", "Sketch palette", "Control grid, snap, profile shading, dimensions, constraints, and construction geometry.", "preview", { kind: "open-workspace" }, ["grid", "snap", "show", "hide"]),

  command("command:part-extrude", "part", "create", "Extrude", "Edit the qualified centered-bore plate extrusion.", "qualified", { kind: "select-record", selectionId: "feature:plate-extrusion" }, ["solid", "push", "pull"], "E"),
  command("command:part-bore", "part", "create", "Bore", "Edit the qualified centered through-bore.", "qualified", { kind: "select-record", selectionId: "feature:centered-through-hole" }, ["hole", "cut", "drill"]),
  command("command:part-edge", "part", "modify", "Edge treatment", "Semantic chamfer/fillet intent; display remains the qualified base mesh.", "preview", { kind: "select-record", selectionId: "feature:edge-treatment" }, ["fillet", "chamfer", "round"]),
  command("command:part-pattern", "part", "create", "Linear pattern", "Semantic instance-count preview for the bounded study.", "preview", { kind: "select-record", selectionId: "feature:linear-pattern" }, ["array", "repeat"]),
  command("command:part-revolve", "part", "create", "Revolve study", "Angle-parametric feature intent without exact solid output.", "preview", { kind: "select-record", selectionId: "feature:revolve-study" }, ["lathe", "axis"]),
  unavailable("command:part-sweep", "part", "create", "Sweep", "Requires exact profiles, guide paths, and self-intersection checks.", ["path", "profile"]),
  unavailable("command:part-loft", "part", "create", "Solid loft", "Requires exact section matching and closed-body validation.", ["blend", "profiles"]),
  unavailable("command:part-shell", "part", "modify", "Shell", "Requires robust face offsetting from an exact topology kernel.", ["hollow", "wall"]),
  unavailable("command:part-draft", "part", "modify", "Draft", "Requires persistent faces, pull direction, and exact intersection repair.", ["taper", "mold"]),
  unavailable("command:part-mirror", "part", "modify", "Mirror", "Requires persistent feature references and exact Boolean composition.", ["symmetry", "copy"]),
  unavailable("command:part-boolean", "part", "modify", "Boolean combine", "Requires a separately qualified exact Boolean kernel.", ["union", "cut", "intersect"]),
  command("command:view-fit", "part", "inspect", "Fit view", "Fit all visible model geometry in the viewport.", "preview", { kind: "fit-view" }, ["zoom", "all", "home"], "F"),
  command("command:view-isometric", "part", "inspect", "Isometric view", "Snap the camera to the standard PS3D isometric orientation.", "preview", { kind: "set-view-orientation", orientation: "isometric" }, ["home", "iso"], "4"),
  command("command:view-front", "part", "inspect", "Front view", "Snap the camera normal to the front plane.", "preview", { kind: "set-view-orientation", orientation: "front" }, ["orthographic", "named view"], "1"),
  command("command:view-top", "part", "inspect", "Top view", "Snap the camera normal to the XY plane.", "preview", { kind: "set-view-orientation", orientation: "top" }, ["plan", "orthographic"], "2"),
  command("command:view-right", "part", "inspect", "Right view", "Snap the camera normal to the right plane.", "preview", { kind: "set-view-orientation", orientation: "right" }, ["side", "orthographic"], "3"),
  command("command:view-orbit", "part", "inspect", "Orbit navigation", "Use left drag to rotate around the current target.", "preview", { kind: "set-navigation-mode", mode: "orbit" }, ["rotate", "camera"], "O"),
  command("command:view-pan", "part", "inspect", "Pan navigation", "Use left drag to move the camera target in the view plane.", "preview", { kind: "set-navigation-mode", mode: "pan" }, ["move", "camera"], "P"),
  command("command:view-measure", "part", "inspect", "Point measure", "Pick two triangle intersection points for distance and XYZ delta.", "preview", { kind: "set-navigation-mode", mode: "measure" }, ["inspect", "distance", "delta"], "M"),
  command("command:view-orthographic", "part", "inspect", "Orthographic projection", "Remove perspective convergence for technical inspection.", "preview", { kind: "set-view-projection", projection: "orthographic" }, ["parallel", "camera"]),
  command("command:view-perspective", "part", "inspect", "Perspective projection", "Use perspective projection for spatial depth cues.", "preview", { kind: "set-view-projection", projection: "perspective" }, ["camera", "depth"]),
  command("command:select-body-priority", "part", "inspect", "Body selection priority", "Restrict viewport picking to semantic bodies.", "preview", { kind: "set-selection-filter", filter: "body" }, ["filter", "pick"]),
  command("command:select-auto-priority", "part", "inspect", "Automatic selection priority", "Allow all currently supported semantic object selections.", "preview", { kind: "set-selection-filter", filter: "auto" }, ["filter", "pick"]),
  command("command:exchange-center", "part", "document", "3D Exchange Center", "Open the local reference-import, scene-export, and PDF delivery workspace.", "preview", { kind: "open-exchange-center" }, ["import", "export", "glb", "gltf", "obj", "stl", "ply", "3mf", "fbx", "usd"]),
  command("command:exchange-export", "part", "document", "Export visible 3D scene", "Export the visible runtime geometry as GLB, glTF, OBJ, STL, PLY, or USDZ.", "preview", { kind: "open-exchange-center" }, ["mesh", "scene", "download", "interchange"]),
  command("command:exchange-pdf-package", "part", "document", "PDF model package", "Create an audited PDF report with the visible model attached as GLB.", "preview", { kind: "open-exchange-center" }, ["3d pdf", "report", "attachment", "glb"]),
  command("command:exchange-interactive-pdf", "part", "document", "Interactive U3D / PRC PDF", "Embed an already encoded U3D or PRC payload as a true PDF 3D annotation.", "preview", { kind: "open-exchange-center" }, ["3d pdf", "adobe", "u3d", "prc", "pass-through"]),

  command("command:assembly-insert-box", "assembly", "create", "Insert box", "Insert a bounded editable box component.", "preview", { kind: "insert-component", shape: "box" }, ["component", "cube", "plate"]),
  command("command:assembly-insert-cylinder", "assembly", "create", "Insert cylinder", "Insert a bounded editable cylinder component.", "preview", { kind: "insert-component", shape: "cylinder" }, ["component", "pin", "round"]),
  command("command:assembly-cargo-20", "assembly", "create", "20 ft cargo planning frame", "Generate an original editable frame using the nominal 6058 × 2438 × 2591 mm external envelope.", "preview", { kind: "apply-assembly-template", template: "cargo-20ft" }, ["container", "iso", "template", "shipping"]),
  command("command:assembly-cargo-40-hc", "assembly", "create", "40 ft high-cube planning frame", "Generate an original editable frame using the nominal 12192 × 2438 × 2896 mm external envelope.", "preview", { kind: "apply-assembly-template", template: "cargo-40ft-hc" }, ["container", "high cube", "template", "shipping"]),
  command("command:assembly-bess-20-hc", "assembly", "create", "BESS container arrangement", "Generate a non-certified 20 ft high-cube equipment and service-aisle planning study.", "preview", { kind: "apply-assembly-template", template: "bess-20ft-hc" }, ["battery", "energy storage", "container", "layout"]),
  command("command:assembly-move", "assembly", "modify", "Move component", "Edit the selected component X/Y/Z translation.", "preview", { kind: "select-record", selectionId: "assembly-action:move" }, ["translate", "position"]),
  command("command:assembly-ground", "assembly", "assemble", "Ground / release", "Toggle the selected component grounded state.", "preview", { kind: "selected-component-action", operation: "toggle-grounded" }, ["fix", "lock"]),
  command("command:assembly-visibility", "assembly", "inspect", "Hide / show", "Toggle the selected component preview visibility.", "preview", { kind: "selected-component-action", operation: "toggle-visible" }, ["eye", "display"]),
  command("command:assembly-delete", "assembly", "modify", "Delete component", "Delete the selected component and its dependent direct mates.", "preview", { kind: "selected-component-action", operation: "delete" }, ["remove"]),
  command("command:assembly-explode", "assembly", "inspect", "Exploded view", "Apply deterministic component explosion directions.", "preview", { kind: "open-workspace" }, ["separate", "presentation"]),
  command("command:assembly-interference", "assembly", "inspect", "Interference check", "Run conservative visible-component AABB overlap checks.", "preview", { kind: "select-record", selectionId: "analysis:interference" }, ["collision", "clash"]),
  command("command:assembly-mates", "assembly", "assemble", "Direct mates", "Inspect ordered fixed, coincident-origin, and aligned-axis records.", "preview", { kind: "select-record", selectionId: "assembly-action:mates" }, ["constraint", "joint"]),
  unavailable("command:assembly-rigid-joint", "assembly", "assemble", "Rigid joint", "Requires a full constraint graph and transform solver.", ["mate", "constraint"]),
  unavailable("command:assembly-motion", "assembly", "assemble", "Motion link", "Requires joints, limits, degrees of freedom, and simulation.", ["animate", "mechanism"]),

  command("command:surface-bezier", "surface", "create", "Bicubic Bézier patch", "Create a deterministic tessellated open patch.", "preview", { kind: "set-surface-mode", mode: "bezier" }, ["control net", "patch"]),
  command("command:surface-loft", "surface", "create", "Ruled loft", "Create a deterministic two-section ruled loft preview.", "preview", { kind: "set-surface-mode", mode: "loft" }, ["profiles", "blend"]),
  unavailable("command:surface-sweep", "surface", "create", "Surface sweep", "Requires exact curve-on-surface and continuity handling.", ["rail", "path"]),
  unavailable("command:surface-patch", "surface", "create", "Boundary patch", "Requires ordered boundary loops and continuity constraints.", ["fill", "network"]),
  unavailable("command:surface-trim", "surface", "modify", "Trim surface", "Requires exact surface intersections and parameter-space loops.", ["split", "cut"]),
  unavailable("command:surface-stitch", "surface", "modify", "Stitch surfaces", "Requires topology sewing, gap tolerances, and watertight validation.", ["sew", "join"]),
  unavailable("command:surface-thicken", "surface", "modify", "Thicken", "Requires robust offset surfaces and exact side-wall construction.", ["solid", "offset"]),

  command("command:drawing-views", "drawing", "document", "Base and projected views", "Generate a descriptive front base view with aligned top/right first- or third-angle projections and an un-dimensioned isometric reference.", "preview", { kind: "open-workspace" }, ["orthographic", "projection", "parent", "aligned"]),
  command("command:drawing-dimensions", "drawing", "document", "Selected model dimensions", "Derive a non-duplicated set of visible overall, thickness, bore, and conditionally basic position dimensions from current part intent.", "preview", { kind: "select-record", selectionId: "drawing-action:dimensions" }, ["measure", "annotation", "basic", "baseline"]),
  command("command:drawing-general-tolerance", "drawing", "document", "General tolerance", "Set bounded user-defined linear and angular tolerances for dimensions without individual tolerance indications.", "preview", { kind: "select-record", selectionId: "drawing-action:tolerance" }, ["limits", "plus-minus", "annotation"]),
  command("command:drawing-gdt", "drawing", "document", "Explicit GD&T and datums", "Enter GD&T values independently, select a reviewable datum template, and show position, flatness, and perpendicularity frames.", "preview", { kind: "select-record", selectionId: "drawing-action:gdt" }, ["feature-control-frame", "datum", "position", "explicit"]),
  command("command:drawing-title-block", "drawing", "document", "Title block", "Edit bounded sheet metadata and manufacturing warning notes.", "preview", { kind: "select-record", selectionId: "drawing:main-sheet" }, ["sheet", "notes"]),
  command("command:drawing-svg", "drawing", "document", "SVG output", "Download the deterministic vector sheet.", "preview", { kind: "open-workspace" }, ["export", "vector"]),
  command("command:drawing-section", "drawing", "document", "Full section A-A", "Generate the qualified centered-bore plate's deterministic full section, parent cutting plane, and material hatching.", "preview", { kind: "open-workspace" }, ["cut", "hatch", "parent", "aligned"]),
  unavailable("command:drawing-detail", "drawing", "document", "Detail view", "Requires persistent view references and clipping boundaries.", ["magnify", "callout"]),
  unavailable("command:drawing-bom", "drawing", "document", "Parts list / BOM", "Requires item numbering, quantities, and assembly-document linkage.", ["table", "balloon"]),
  unavailable("command:drawing-dxf", "drawing", "document", "DXF / DWG output", "Requires a separately reviewed interchange writer and conformance tests.", ["export", "autocad"]),
  unavailable("command:drawing-pdf", "drawing", "document", "PDF output", "Requires print layout, font embedding, and artifact verification.", ["print", "export"]),

  command("command:electrical-bess-sld", "electrical", "create", "BESS single-line", "Generate a connected battery-to-PCC conceptual single-line with protection placeholders and live ERC.", "preview", { kind: "apply-electrical-template", template: "bess-single-line" }, ["battery", "pcs", "inverter", "transformer", "grid"]),
  command("command:electrical-dc-control", "electrical", "create", "DC auxiliary circuit", "Generate a fused DC auxiliary and permissive circuit concept.", "preview", { kind: "apply-electrical-template", template: "dc-control" }, ["24v", "control", "relay", "sensor"]),
  command("command:electrical-motor-starter", "electrical", "create", "Motor starter single-line", "Generate a protected direct-on-line motor power concept.", "preview", { kind: "apply-electrical-template", template: "motor-starter" }, ["motor", "starter", "contactor", "breaker"]),
  command("command:electrical-insert-battery", "electrical", "create", "Insert battery", "Insert an editable battery symbol with stable reference and terminals.", "preview", { kind: "insert-electrical-component", componentKind: "battery" }, ["cell", "string", "dc"]),
  command("command:electrical-insert-fuse", "electrical", "create", "Insert fuse", "Insert an editable fuse symbol.", "preview", { kind: "insert-electrical-component", componentKind: "fuse" }, ["protection", "ocpd"]),
  command("command:electrical-insert-breaker", "electrical", "create", "Insert breaker", "Insert an editable circuit-breaker symbol.", "preview", { kind: "insert-electrical-component", componentKind: "breaker" }, ["protection", "switchgear"]),
  command("command:electrical-insert-disconnect", "electrical", "create", "Insert disconnect", "Insert an editable isolation-switch symbol.", "preview", { kind: "insert-electrical-component", componentKind: "disconnect" }, ["isolator", "switch"]),
  command("command:electrical-insert-inverter", "electrical", "create", "Insert inverter / PCS", "Insert an editable DC/AC converter symbol.", "preview", { kind: "insert-electrical-component", componentKind: "inverter" }, ["converter", "pcs", "dc ac"]),
  command("command:electrical-insert-transformer", "electrical", "create", "Insert transformer", "Insert an editable transformer symbol.", "preview", { kind: "insert-electrical-component", componentKind: "transformer" }, ["ratio", "isolation"]),
  command("command:electrical-net-editor", "electrical", "modify", "Pin-to-pin net editor", "Connect two declared component terminals with a named AC, DC, control, or ground net.", "preview", { kind: "select-record", selectionId: "electrical-action:nets" }, ["wire", "connect", "route", "net"]),
  command("command:electrical-erc", "electrical", "inspect", "Electrical rule check", "Check duplicate references, broken terminals, unconnected pins, protective-device presence, and ground-reference presence.", "preview", { kind: "select-record", selectionId: "electrical-action:erc" }, ["erc", "validate", "connectivity"]),
  command("command:electrical-bom", "electrical", "document", "Concept device index", "Group reference designators, descriptions, values, and quantities for the schematic concept.", "preview", { kind: "select-record", selectionId: "electrical-action:bom" }, ["bom", "parts", "devices"]),
  command("command:electrical-svg", "electrical", "document", "Electrical SVG output", "Download the deterministic vector schematic sheet.", "preview", { kind: "open-workspace" }, ["export", "drawing", "vector"]),
command("command:electrical-to-3d", "electrical", "automate", "Circuit to wired mounting plate", "Preview a deterministic mounting plate with generic panel packages, DIN rails, ducts, terminal mappings, and unsized orthogonal conductor paths.", "preview", { kind: "generate-electromechanical-realization" }, ["physical", "assembly", "panel", "din", "duct", "wire", "ai", "mcp"]),
  unavailable("command:electrical-cable-sizing", "electrical", "inspect", "Automatic conductor sizing", "Requires project-specific load, installation, temperature, grouping, voltage-drop, fault-duty, and jurisdictional rules.", ["wire size", "ampacity", "voltage drop"]),
  unavailable("command:electrical-coordination", "electrical", "inspect", "Protection coordination", "Requires verified device curves, fault levels, settings, selectivity criteria, and licensed engineering review.", ["short circuit", "selectivity", "arc flash"]),
  unavailable("command:electrical-simulation", "electrical", "inspect", "Circuit simulation", "Requires a separately qualified analysis engine and validated component models.", ["spice", "load flow", "transient"]),

  command("command:vehicle-ice-motorcycle", "vehicle", "create", "ICE road motorcycle skeleton", "Apply the original generic single-track ICE motorcycle template.", "preview", { kind: "apply-vehicle-template", template: "ice-road-motorcycle" }, ["bike", "motorcycle", "engine", "template"]),
  command("command:vehicle-scooter", "vehicle", "create", "Step-through scooter skeleton", "Apply the original generic compact step-through scooter template.", "preview", { kind: "apply-vehicle-template", template: "step-through-scooter" }, ["scooter", "cvt", "template"]),
  command("command:vehicle-ev-motorcycle", "vehicle", "create", "EV street motorcycle skeleton", "Apply the original generic electric motorcycle battery-and-motor package template.", "preview", { kind: "apply-vehicle-template", template: "ev-street-motorcycle" }, ["electric", "bike", "battery", "motor", "template"]),
  command("command:vehicle-delta-three-wheel", "vehicle", "create", "Delta cargo three-wheeler skeleton", "Apply the original generic one-front/two-rear cargo three-wheeler template.", "preview", { kind: "apply-vehicle-template", template: "delta-cargo-three-wheeler" }, ["three wheeler", "cargo", "delta", "1f2r", "template"]),
  command("command:vehicle-tadpole-three-wheel", "vehicle", "create", "Tadpole three-wheeler geometry study", "Apply the original generic two-front/one-rear steering packaging study.", "preview", { kind: "apply-vehicle-template", template: "tadpole-geometry-three-wheeler" }, ["three wheeler", "tadpole", "ackermann", "2f1r", "template"]),
  command("command:vehicle-full-droop", "vehicle", "modify", "Full-droop state", "Show the user-entered suspension at the maximum-rebound hardpoints.", "preview", { kind: "set-vehicle-state", state: "full-droop" }, ["full droop", "rebound", "suspension"]),
  command("command:vehicle-design-ride", "vehicle", "modify", "Design-ride state", "Show the design sag datum hardpoints.", "preview", { kind: "set-vehicle-state", state: "design-ride" }, ["sag", "ride height", "suspension"]),
  command("command:vehicle-full-bump", "vehicle", "modify", "Full-bump state", "Show the user-entered full-travel hardpoints.", "preview", { kind: "set-vehicle-state", state: "full-bump" }, ["bump", "jounce", "suspension"]),
  command("command:vehicle-hardpoint-layer", "vehicle", "inspect", "Toggle vehicle hardpoints", "Toggle state-dependent hardpoint markers in the 3D preview.", "preview", { kind: "toggle-vehicle-layer", layer: "hardpoints" }, ["points", "coordinates", "xyz"]),
  command("command:vehicle-skeleton-layer", "vehicle", "inspect", "Toggle vehicle skeleton", "Toggle centerlines, ground, and wheelbase construction guides.", "preview", { kind: "toggle-vehicle-layer", layer: "skeleton" }, ["sketch", "layout", "construction"]),
  command("command:vehicle-load-layer", "vehicle", "inspect", "Toggle CG and load layer", "Toggle combined-CG projection and three-wheel support polygon.", "preview", { kind: "toggle-vehicle-layer", layer: "cg-loads" }, ["center of gravity", "support polygon", "load"]),
  command("command:vehicle-geometry-analysis", "vehicle", "inspect", "Vehicle geometry calculations", "Inspect trail, turn radius, hardpoints, axle stations, and suspension state.", "preview", { kind: "select-record", selectionId: "vehicle-analysis:geometry" }, ["rake", "trail", "wheelbase", "steering"]),
  command("command:vehicle-brake-analysis", "vehicle", "inspect", "Vehicle brake calculations", "Inspect quasi-static load transfer, hydraulic pressure, torque, force split, lock margin, and stopping distance.", "preview", { kind: "select-record", selectionId: "vehicle-analysis:brakes" }, ["braking", "deceleration", "caliper", "disc", "stopping"]),
  command("command:vehicle-stability-analysis", "vehicle", "inspect", "Vehicle stability calculations", "Inspect steady lean reference or rigid three-wheel support-polygon loads and tip threshold.", "preview", { kind: "select-record", selectionId: "vehicle-analysis:stability" }, ["cg", "lean", "rollover", "wheel lift"]),
  command("command:vehicle-powertrain-analysis", "vehicle", "inspect", "Powertrain operating-point calculations", "Inspect road load, traction-capped force, acceleration, and assumption-based EV energy envelope.", "preview", { kind: "select-record", selectionId: "vehicle-analysis:powertrain" }, ["torque", "gear", "range", "drag", "rolling resistance"]),
  command("command:vehicle-fit", "vehicle", "inspect", "Fit vehicle", "Fit all visible vehicle preview geometry.", "preview", { kind: "fit-view" }, ["view", "zoom", "home"], "F"),
  command("command:vehicle-measure", "vehicle", "inspect", "Measure vehicle points", "Activate two-point triangle intersection measurement in the vehicle viewport.", "preview", { kind: "set-navigation-mode", mode: "measure" }, ["distance", "delta", "inspect"], "M"),
  unavailable("command:vehicle-multibody", "vehicle", "inspect", "Multibody ride and handling simulation", "Requires validated joints, tire models, damping curves, inertia tensors, controls, road inputs, and test correlation.", ["dynamic", "ride", "handling", "simulation"]),
  unavailable("command:vehicle-structural", "vehicle", "inspect", "Chassis and triple-clamp structural validation", "Requires material allowables, real sections, joints, welds, load spectra, boundary conditions, FEA convergence, fatigue, and physical validation.", ["stress", "fea", "fatigue", "frame", "triple clamp"]),
  unavailable("command:vehicle-homologation", "vehicle", "document", "Roadworthiness and homologation release", "Requires current jurisdiction requirements, accredited test evidence, configuration control, and qualified sign-off.", ["certification", "regulation", "approval"]),

  command("command:automate-guide", "automate", "automate", "AI collaboration guide", "Open the model-neutral connection, discovery, preview, confirmation, and returned-project contract.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_guide" }, ["ai", "mcp", "connect", "help", "workflow"]),
  command("command:automate-design-health", "automate", "inspect", "Design Health Center", "Analyze all workspaces, actual associativity, deterministic rebuild order, and release boundaries.", "preview", { kind: "open-design-health" }, ["health", "rebuild", "dependency", "associativity", "quality", "readiness"], "Ctrl+Shift+H"),
  command("command:automate-find", "automate", "automate", "Smart command finder", "Match a plain-language engineering goal to bounded command recipes without executing it.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_find_commands" }, ["ai", "intent", "natural language", "recipe", "command"]),
  command("command:automate-capabilities", "automate", "automate", "MCP capability matrix", "List qualified, preview, and unavailable capabilities.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_capabilities" }, ["ai", "tools", "schema"]),
  command("command:automate-inspect", "automate", "automate", "MCP inspect project", "Validate and summarize a supplied in-memory project.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_inspect_project" }, ["read", "validate"]),
  command("command:automate-preview", "automate", "automate", "MCP preview operation", "Validate intent and issue a deterministic receipt.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_preview_operation" }, ["diff", "receipt"]),
  command("command:automate-apply", "automate", "automate", "MCP apply confirmed preview", "Return a new project only after matching receipt and confirmation.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_apply_preview" }, ["confirm", "mutation"]),
  command("command:automate-python", "automate", "automate", "Python SDK", "Connect standard-library Python to the local MCP stdio server.", "preview", { kind: "select-record", selectionId: "automation:python-sdk" }, ["script", "client", "stdlib"]),
  unavailable("command:automate-remote", "automate", "automate", "Remote authenticated MCP", "Requires OAuth, tenant isolation, rate limits, Origin validation, and deployment review.", ["http", "cloud", "oauth"])
] as const;

export function commandsForWorkspace(workspace: WorkspaceId): readonly CadCommandRecord[] {
  return CAD_COMMANDS.filter((record) => record.workspace === workspace);
}

function command(
  id: string,
  workspace: WorkspaceId,
  category: CadCommandCategory,
  name: string,
  description: string,
  level: CapabilityLevel,
  action: CadCommandAction,
  keywords: readonly string[],
  shortcut?: string
): CadCommandRecord {
  const base = { id, workspace, category, name, description, level, action, keywords };
  return shortcut === undefined ? base : { ...base, shortcut };
}

function unavailable(
  id: string,
  workspace: WorkspaceId,
  category: CadCommandCategory,
  name: string,
  description: string,
  keywords: readonly string[]
): CadCommandRecord {
  return command(id, workspace, category, name, description, "unavailable", { kind: "unavailable" }, keywords);
}
