import type { AssemblyTemplateId, CapabilityLevel, ComponentShape, ElectricalComponentKind, ElectricalTemplateId, PartPreviewBodyShape, VehicleLayerId, VehicleSimulationState, VehicleTemplateId, WorkspaceId } from "./types.js";

export type CadCommandCategory = "create" | "modify" | "construct" | "assemble" | "inspect" | "document" | "automate";
export type CadSketchTool = "select" | "line" | "rectangle" | "rectangle-center" | "rectangle-three-point" | "circle" | "circle-two-point" | "circle-three-point" | "arc";

export type CadCommandAction =
  | { readonly kind: "open-workspace" }
  | { readonly kind: "finish-sketch" }
  | { readonly kind: "activate-sketch-tool"; readonly tool: CadSketchTool }
  | { readonly kind: "select-record"; readonly selectionId: string }
  | { readonly kind: "insert-current-part-into-assembly" }
  | { readonly kind: "create-part-preview-body"; readonly shape: PartPreviewBodyShape }
  | { readonly kind: "selected-part-preview-body-action"; readonly operation: "edit-transform" | "edit-size" | "edit-appearance" | "duplicate" | "mirror-x" | "pattern-x" | "bounding-block" | "isolate" | "toggle-visible" | "delete" }
  | { readonly kind: "set-part-preview-bodies-visibility"; readonly visible: boolean }
  | { readonly kind: "insert-component"; readonly shape: Extract<ComponentShape, "box" | "cylinder"> }
  | { readonly kind: "apply-assembly-template"; readonly template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel"> }
  | { readonly kind: "selected-component-action"; readonly operation: "delete" | "toggle-grounded" | "toggle-visible" }
  | { readonly kind: "set-surface-mode"; readonly mode: "bezier" | "loft" }
  | { readonly kind: "fit-view" }
  | { readonly kind: "set-view-orientation"; readonly orientation: "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric" }
  | { readonly kind: "set-view-projection"; readonly projection: "perspective" | "orthographic" }
  | { readonly kind: "set-shading-mode"; readonly mode: "shaded" | "shaded-edges" | "wireframe" }
  | { readonly kind: "set-background-tone"; readonly tone: "charcoal" | "dark-gray" | "light-gray" | "white" }
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

export interface CadCommandGuide {
  readonly selection: string;
  readonly steps: readonly string[];
  readonly result: string;
  readonly boundary: string;
}

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
  readonly group: string;
  readonly guide: CadCommandGuide;
}

export interface CadCommandAuditIssue {
  readonly code: string;
  readonly commandId: string;
  readonly message: string;
}

export interface CadCommandAuditReport {
  readonly schema: "ps3d-command-surface-audit/1";
  readonly passed: boolean;
  readonly total: number;
  readonly executable: number;
  readonly truthfullyBlocked: number;
  readonly byLevel: Readonly<Record<CapabilityLevel, number>>;
  readonly byWorkspace: Readonly<Record<string, Readonly<Record<CapabilityLevel | "total", number>>>>;
  readonly actionKindsCovered: readonly string[];
  readonly issues: readonly CadCommandAuditIssue[];
}

export const CAD_EXECUTABLE_ACTION_KINDS = [
  "open-workspace", "finish-sketch", "activate-sketch-tool", "select-record", "insert-current-part-into-assembly",
  "create-part-preview-body", "selected-part-preview-body-action", "set-part-preview-bodies-visibility", "insert-component",
  "apply-assembly-template", "selected-component-action", "set-surface-mode", "fit-view", "set-view-orientation",
  "set-view-projection", "set-shading-mode", "set-background-tone", "set-navigation-mode", "set-selection-filter",
  "open-exchange-center", "open-design-health", "apply-electrical-template", "insert-electrical-component",
  "generate-electromechanical-realization", "apply-vehicle-template", "set-vehicle-state", "toggle-vehicle-layer"
] as const;

export const CAD_COMMANDS: readonly CadCommandRecord[] = [
  command("command:sketch-select", "sketch", "inspect", "Select", "Select sketch entities by stable ID.", "preview", { kind: "activate-sketch-tool", tool: "select" }, ["cursor", "pick"], "V"),
  command("command:sketch-line", "sketch", "create", "Line", "Create a bounded two-point line.", "preview", { kind: "activate-sketch-tool", tool: "line" }, ["segment", "profile"], "L"),
  command("command:sketch-rectangle", "sketch", "create", "2-point rectangle", "Create an axis-aligned rectangle from opposite corners.", "preview", { kind: "activate-sketch-tool", tool: "rectangle" }, ["box", "profile", "corner"], "R"),
  command("command:sketch-center-rectangle", "sketch", "create", "Center rectangle", "Create an axis-aligned rectangle from its center and one corner.", "preview", { kind: "activate-sketch-tool", tool: "rectangle-center" }, ["box", "profile", "symmetric"]),
  command("command:sketch-three-point-rectangle", "sketch", "create", "3-point rectangle", "Create a rotated rectangle from an edge and a width point.", "preview", { kind: "activate-sketch-tool", tool: "rectangle-three-point" }, ["box", "profile", "rotated"]),
  command("command:sketch-circle", "sketch", "create", "Center circle", "Create a circle from its center and radius point.", "preview", { kind: "activate-sketch-tool", tool: "circle" }, ["diameter", "round"], "C"),
  command("command:sketch-two-point-circle", "sketch", "create", "2-point circle", "Create a circle from the two endpoints of its diameter.", "preview", { kind: "activate-sketch-tool", tool: "circle-two-point" }, ["diameter", "round", "two point"]),
  command("command:sketch-three-point-circle", "sketch", "create", "3-point circle", "Create the unique circle passing through three non-collinear points.", "preview", { kind: "activate-sketch-tool", tool: "circle-three-point" }, ["circumcircle", "round", "three point"]),
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
  command("command:sketch-create", "sketch", "construct", "Create Sketch", "Open the sketch workspace on the current bounded XY datum plane.", "preview", { kind: "open-workspace" }, ["sketch", "construction", "plane"]),
  command("command:sketch-profile", "sketch", "inspect", "Profile", "Detect and list closed rectangle and circular sketch regions that can feed the qualified extrusion workflow.", "preview", { kind: "open-workspace" }, ["closed loop", "region", "construction"]),
  unavailable("command:sketch-datum-plane", "sketch", "construct", "Datum Plane", "The origin XY/YZ/XZ planes are available, but editable offset, angle, tangent, and three-point datum planes require a persistent construction-reference graph.", ["construction", "reference plane", "datum dropdown"]),
  unavailable("command:sketch-point", "sketch", "create", "Point", "Requires a persistent point entity, coordinate dimensions, construction-state handling, and solver participation.", ["curve", "reference", "vertex"]),
  unavailable("command:sketch-fillet", "sketch", "modify", "Sketch Fillet", "Requires two intersecting curves, trim/extend rules, a tangent arc, driving radius, and constraint repair.", ["round", "corner", "radius"]),
  unavailable("command:sketch-chamfer", "sketch", "modify", "Sketch Chamfer", "Requires two intersecting curves, distance/angle modes, trimming, and persistent constraints.", ["bevel", "corner"]),
  unavailable("command:sketch-extend", "sketch", "modify", "Extend", "Requires a target boundary, bounded curve extension, intersection ordering, and constraint repair.", ["trim", "edit", "curve"]),
  unavailable("command:sketch-corner", "sketch", "modify", "Corner", "Requires two curve selections, intersection construction, extend/trim behavior, and stable endpoint relations.", ["trim", "extend", "join"]),
  unavailable("command:sketch-pattern", "sketch", "modify", "Sketch Pattern", "Requires associative linear or circular instances, quantity and spacing controls, and solver-managed dependencies.", ["array", "repeat", "circular"]),
  unavailable("command:sketch-mirror", "sketch", "modify", "Sketch Mirror", "Requires an entity set, construction mirror line, symmetric constraints, and regeneration-safe references.", ["symmetry", "copy", "axis"]),
  unavailable("command:sketch-fix", "sketch", "construct", "Fix Curve", "Requires solver-backed fixed degrees of freedom and an explicit unfix workflow.", ["lock", "ground", "constraint"]),
  unavailable("command:sketch-show-movable", "sketch", "inspect", "Show Movable Geometry", "Requires solver degree-of-freedom analysis and per-entity visual diagnostics.", ["under constrained", "degrees of freedom", "solve"]),
  unavailable("command:sketch-relax-dimensions", "sketch", "construct", "Relax Dimensions", "Requires controlled conversion between driving and reference dimensions plus conflict diagnostics.", ["driven", "reference", "over constrained"]),
  unavailable("command:sketch-relax-relations", "sketch", "construct", "Relax Relations", "Requires constraint suppression, solve diagnostics, and a reversible relation state model.", ["constraint", "suppress", "solve"]),
  unavailable("command:sketch-check", "sketch", "inspect", "Sketch Checking", "Requires open-loop, overlap, duplicate, self-intersection, small-entity, and solver-status diagnostics.", ["validate", "profile", "diagnostic"]),
  unavailable("command:sketch-reattach", "sketch", "construct", "Reattach Sketch", "Requires persistent plane or face references, orientation mapping, origin control, and broken-reference repair.", ["plane", "face", "support"]),
  unavailable("command:sketch-update-model", "sketch", "inspect", "Update Model", "Requires a dependency graph that rebuilds every downstream feature from the edited sketch.", ["regenerate", "rebuild", "history"]),
  command("command:sketch-finish", "sketch", "construct", "Finish Sketch", "Close the active sketch session and return to the Part workspace while preserving the revisioned sketch geometry.", "preview", { kind: "finish-sketch" }, ["finish", "exit sketch", "update model"], "Esc"),
  command("command:sketch-options", "sketch", "inspect", "Sketch Options", "Open the existing sketch palette for grid, snap, profile shading, dimensions, constraints, and construction visibility.", "preview", { kind: "open-workspace" }, ["options", "palette", "show movable", "sketch checking"]),

  command("command:part-extrude", "part", "create", "Extrude", "Edit the qualified centered-bore plate extrusion.", "qualified", { kind: "select-record", selectionId: "feature:plate-extrusion" }, ["solid", "push", "pull"], "E"),
  command("command:part-bore", "part", "create", "Bore", "Edit the qualified centered through-bore.", "qualified", { kind: "select-record", selectionId: "feature:centered-through-hole" }, ["hole", "cut", "drill"]),
  command("command:part-edge", "part", "modify", "Edge treatment", "Semantic chamfer/fillet intent; display remains the qualified base mesh.", "preview", { kind: "select-record", selectionId: "feature:edge-treatment" }, ["fillet", "chamfer", "round"]),
  command("command:part-pattern", "part", "create", "Linear pattern", "Semantic instance-count preview for the bounded study.", "preview", { kind: "select-record", selectionId: "feature:linear-pattern" }, ["array", "repeat"]),
  command("command:part-pattern-feature", "part", "create", "Pattern Feature", "Select the bounded linear-pattern feature intent for quantity and spacing review.", "preview", { kind: "select-record", selectionId: "feature:linear-pattern" }, ["pattern geometry", "feature pattern", "array", "repeat"]),
  command("command:part-revolve", "part", "create", "Revolve study", "Angle-parametric feature intent without exact solid output.", "preview", { kind: "select-record", selectionId: "feature:revolve-study" }, ["lathe", "axis"]),
  command("command:part-block", "part", "create", "Block", "Create a separately selectable, dimensioned rectangular preview body.", "preview", { kind: "create-part-preview-body", shape: "block" }, ["box", "primitive", "new body"]),
  command("command:part-cylinder", "part", "create", "Cylinder", "Create a separately selectable diameter-and-height cylindrical preview body.", "preview", { kind: "create-part-preview-body", shape: "cylinder" }, ["round", "primitive", "new body"]),
  command("command:part-cone", "part", "create", "Cone", "Create a separately selectable base-diameter, top-diameter, and height preview body.", "preview", { kind: "create-part-preview-body", shape: "cone" }, ["frustum", "taper", "primitive", "new body"]),
  command("command:part-sphere", "part", "create", "Sphere", "Create a separately selectable diameter-controlled spherical preview body.", "preview", { kind: "create-part-preview-body", shape: "sphere" }, ["ball", "primitive", "new body"]),
  command("command:part-move-body", "part", "modify", "Move Body", "Open XYZ translation and rotation controls for the selected independent preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-transform" }, ["synchronous", "translate", "rotate", "direct edit"]),
  command("command:part-scale-body", "part", "modify", "Scale Body", "Open exact size controls for the selected independent preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-size" }, ["resize", "uniform", "nonuniform", "dimension"]),
  command("command:part-copy-body", "part", "modify", "Copy Body", "Create an independent translated copy of the selected preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "duplicate" }, ["duplicate", "reuse", "copy geometry"]),
  command("command:part-pattern-body", "part", "modify", "Pattern Body", "Create three independent preview-body instances along the global X direction.", "preview", { kind: "selected-part-preview-body-action", operation: "pattern-x" }, ["pattern geometry", "linear", "array", "instances"]),
  command("command:part-mirror-body", "part", "modify", "Mirror Body", "Create an independent preview-body copy mirrored across the global YZ plane.", "preview", { kind: "selected-part-preview-body-action", operation: "mirror-x" }, ["mirror geometry", "symmetry", "copy"]),
  command("command:part-bounding-body", "part", "construct", "Bounding Body", "Create an editable block using the selected preview body's current oriented-envelope dimensions.", "preview", { kind: "selected-part-preview-body-action", operation: "bounding-block" }, ["bounding box", "envelope", "stock"]),
  command("command:part-body-appearance", "part", "modify", "Assign Body Color", "Open the appearance control for the selected independent preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-appearance" }, ["color feature", "assign feature color", "appearance", "display"]),
  command("command:part-isolate-body", "part", "inspect", "Isolate Object or Feature", "Show the selected preview body and hide the other preview bodies; the qualified base remains visible.", "preview", { kind: "selected-part-preview-body-action", operation: "isolate" }, ["solo", "hide others", "visibility"]),
  command("command:part-toggle-body", "part", "inspect", "Show / Hide Body", "Toggle visibility of the selected independent preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "toggle-visible" }, ["visibility", "display"]),
  command("command:part-delete-body", "part", "modify", "Delete Body", "Delete the selected independent preview body in one undoable revision.", "preview", { kind: "selected-part-preview-body-action", operation: "delete" }, ["remove", "synchronous delete"]),
  command("command:part-insert-assembly", "part", "assemble", "Insert current part into assembly", "Create a revisioned editable assembly snapshot from the current qualified part envelope.", "preview", { kind: "insert-current-part-into-assembly" }, ["component", "assembly", "place", "downstream"]),
  unavailable("command:part-sweep", "part", "create", "Sweep", "Requires exact profiles, guide paths, and self-intersection checks.", ["path", "profile"]),
  unavailable("command:part-loft", "part", "create", "Solid loft", "Requires exact section matching and closed-body validation.", ["blend", "profiles"]),
  unavailable("command:part-shell", "part", "modify", "Shell", "Requires robust face offsetting from an exact topology kernel.", ["hollow", "wall"]),
  unavailable("command:part-draft", "part", "modify", "Draft Body", "Requires persistent faces, a neutral plane or parting line, pull direction, and exact intersection repair.", ["draft", "taper", "mold", "body"]),
  unavailable("command:part-mirror-feature", "part", "modify", "Mirror Feature", "Requires persistent feature references, a mirror plane, and exact Boolean composition.", ["mirror", "symmetry", "copy"]),
  unavailable("command:part-boolean", "part", "modify", "Boolean combine", "Requires a separately qualified exact Boolean kernel.", ["union", "cut", "intersect"]),
  unavailable("command:part-unite", "part", "modify", "Unite", "Requires two overlapping exact solid bodies and a validated union operation with persistent result topology.", ["boolean", "join", "combine"]),
  unavailable("command:part-subtract", "part", "modify", "Subtract", "Requires an exact target body, one or more tool bodies, and a validated cut result.", ["boolean", "cut", "difference"]),
  unavailable("command:part-intersect", "part", "modify", "Intersect", "Requires exact overlapping bodies and validated intersection topology.", ["boolean", "common", "combine"]),
  unavailable("command:part-edge-blend", "part", "modify", "Edge Blend", "The current edge-treatment value records blend intent, but exact rounded faces require persistent edge references and a topology kernel.", ["fillet", "round", "blend"]),
  unavailable("command:part-chamfer", "part", "modify", "Chamfer", "The current edge-treatment value records chamfer intent, but exact beveled faces require persistent edge references and a topology kernel.", ["bevel", "edge"]),
  unavailable("command:part-rib", "part", "create", "Rib", "Requires an open sketch chain, thickness direction, extent rules, and an exact join to a target body.", ["detail feature", "web", "stiffener"]),
  unavailable("command:part-contour-rib", "part", "create", "Contour Rib", "Requires curve-chain continuity, section control, target intersections, and exact joined topology.", ["detail feature", "stiffener", "web"]),
  unavailable("command:part-thread", "part", "create", "Thread", "Requires a cylindrical face, thread standard and size tables, handedness, pitch, extent, and cosmetic or modeled output.", ["detail feature", "screw", "helix"]),
  unavailable("command:part-groove", "part", "create", "Groove", "Requires a section profile, rotational axis, target face/body, and validated revolve-cut topology.", ["detail feature", "recess", "cut"]),
  unavailable("command:part-emboss", "part", "create", "Emboss", "Requires sketch curves, target faces, wrap/projection rules, depth, and robust face splitting or Boolean output.", ["detail feature", "deboss", "text", "emboss body"]),
  unavailable("command:part-offset-emboss", "part", "create", "Offset Emboss", "Requires associative target-face projection, offset regions, and validated emboss or deboss topology.", ["design feature", "wrap", "relief"]),
  unavailable("command:part-implicit", "part", "create", "Implicit Modeling", "Requires a signed-distance or volumetric field engine, field Boolean operations, meshing controls, and validation.", ["design feature", "voxel", "field", "lattice"]),
  unavailable("command:part-equation-body", "part", "create", "Body by Equation", "Requires bounded analytic or implicit equations, domain controls, singularity checks, and closed-body tessellation.", ["design feature", "formula", "parametric"]),
  unavailable("command:part-algorithmic-feature", "part", "create", "Algorithmic Feature", "Requires a sandboxed deterministic feature API, bounded execution, provenance, and geometry validation.", ["design feature", "script", "procedural"]),
  unavailable("command:part-trim-body", "part", "modify", "Trim Body", "Requires an exact target body, trimming tool, kept-region selection, and persistent output topology.", ["trim", "cut", "body"]),
  unavailable("command:part-split-body", "part", "modify", "Split Body", "Requires an exact body plus plane, face, surface, or profile splitting tool and two validated output bodies.", ["trim", "divide", "separate"]),
  unavailable("command:part-divide-face", "part", "modify", "Divide Face", "Requires persistent face selection and an intersecting curve, plane, or surface without changing body volume.", ["split face", "partition", "trim"]),
  unavailable("command:part-offset-face", "part", "modify", "Offset Face", "Requires persistent face selection, normal direction, neighbor extension, and self-intersection repair.", ["synchronous", "press pull", "direct edit"]),
  unavailable("command:part-replace-face", "part", "modify", "Replace Face", "Requires target and replacement faces or surfaces plus exact trim/extend and healing.", ["synchronous", "direct edit"]),
  unavailable("command:part-resize-blend", "part", "modify", "Resize Blend", "Requires automatic recognition of a fillet face chain and exact radius regeneration.", ["synchronous", "fillet", "direct edit"]),
  unavailable("command:part-copy-face", "part", "modify", "Copy Face", "Requires persistent face selection and independent or associative sheet-body creation.", ["reuse", "extract", "face"]),
  unavailable("command:part-cut-face", "part", "modify", "Cut Face", "Requires persistent selected faces, clipboard-safe topology references, and source-body healing.", ["reuse", "clipboard", "face"]),
  unavailable("command:part-paste-face", "part", "modify", "Paste Face", "Requires a validated copied-face payload, placement transform, and target-body stitching or replacement.", ["reuse", "clipboard", "face"]),
  unavailable("command:part-mirror-face", "part", "modify", "Mirror Face", "Requires persistent faces, a mirror plane, and exact copied or joined surface output.", ["copy", "reuse", "pattern face"]),
  unavailable("command:part-pattern-face", "part", "modify", "Pattern Face", "Requires persistent face sets, a linear/circular/path layout, and per-instance topology validation.", ["copy", "reuse", "array"]),
  unavailable("command:part-pattern-geometry", "part", "modify", "Pattern Geometry", "Requires persistent mixed geometry references, pattern boundaries, orientation, and clocking controls.", ["copy", "array", "repeat"]),
  unavailable("command:part-promote-body", "part", "modify", "Promote Body", "Requires an assembly-context body reference, ownership rules, update behavior, and revision-safe associativity.", ["copy", "assembly", "reuse"]),
  unavailable("command:part-extract-geometry", "part", "construct", "Extract Geometry", "Requires persistent body, face, edge, or curve references plus associative and non-associative output modes.", ["copy", "reference", "reuse"]),
  unavailable("command:part-external-geometry-link", "part", "construct", "External Geometry Link", "Requires document-to-document persistent references, update control, cycle detection, and broken-link repair; this is the PS3D-neutral equivalent of an NX WAVE geometry link.", ["wave geometry linker", "associative", "interpart", "link"]),
  unavailable("command:part-interface-link", "part", "construct", "Interface Reference Link", "Requires a stable published interface contract, source revision identity, update policy, and replacement workflow.", ["wave interface linker", "associative", "link"]),
  unavailable("command:part-pmi-link", "part", "construct", "PMI Reference Link", "Requires semantic PMI entities, model-view context, source revision identity, and standards-aware update behavior.", ["wave pmi linker", "annotation", "link"]),
  unavailable("command:part-transfer-voids", "part", "modify", "Transfer Voids", "Requires exact source void recognition, target body selection, transform context, and Boolean subtraction.", ["combine", "cavity", "copy"]),
  unavailable("command:part-assembly-cut", "part", "assemble", "Assembly Cut", "Requires assembly occurrence context, participating-component scope, feature ownership, and exact multi-part cuts.", ["combine", "cut", "context"]),
  unavailable("command:part-wrap-geometry", "part", "modify", "Wrap Geometry", "Requires curves or regions, target faces, projection direction, distortion rules, and curve-on-surface topology.", ["feature tools", "project", "emboss"]),
  unavailable("command:part-user-defined-feature", "part", "automate", "User Defined Feature", "Requires a versioned reusable feature definition with placement references, parameters, validation, and provenance.", ["feature tools", "custom", "template"]),
  unavailable("command:part-topology-optimization", "part", "automate", "Topology Optimization", "Requires loads, constraints, material, manufacturing objectives, a validated solver, mesh independence, and engineering review.", ["feature tools", "generative", "optimize"]),
  unavailable("command:part-group-edge", "part", "construct", "Group Edge", "Requires persistent edge references and a named selection-set model that survives regeneration.", ["feature tools", "selection set", "organize"]),
  unavailable("command:part-group-body", "part", "construct", "Group Body", "Requires named body selection sets, visibility control, persistence, and revision-safe membership updates.", ["feature tools", "selection set", "organize"]),
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
  command("command:view-shaded", "part", "inspect", "Shaded", "Render faces with lighting and no explicit edge overlay.", "preview", { kind: "set-shading-mode", mode: "shaded" }, ["display", "style", "faces"]),
  command("command:view-shaded-edges", "part", "inspect", "Shaded with edges", "Render shaded faces with a visible model-edge overlay.", "preview", { kind: "set-shading-mode", mode: "shaded-edges" }, ["display", "style", "static wireframe"]),
  command("command:view-wireframe", "part", "inspect", "Wireframe", "Render visible model edges without opaque qualified-body faces.", "preview", { kind: "set-shading-mode", mode: "wireframe" }, ["display", "style", "wire"]),
  command("command:view-show-all", "part", "inspect", "Show All Bodies", "Show every independent preview body in one revision.", "preview", { kind: "set-part-preview-bodies-visibility", visible: true }, ["show", "visibility", "content"]),
  command("command:view-hide-all", "part", "inspect", "Hide All Preview Bodies", "Hide every independent preview body while preserving the qualified base body.", "preview", { kind: "set-part-preview-bodies-visibility", visible: false }, ["hide", "visibility", "content"]),
  command("command:view-background-charcoal", "part", "inspect", "Charcoal Background", "Set a low-glare charcoal viewport background.", "preview", { kind: "set-background-tone", tone: "charcoal" }, ["scene", "display", "background", "dark gray"]),
  command("command:view-background-dark", "part", "inspect", "Dark Gray Background", "Set the default neutral dark-gray viewport background.", "preview", { kind: "set-background-tone", tone: "dark-gray" }, ["scene", "display", "background"]),
  command("command:view-background-light", "part", "inspect", "Light Gray Background", "Set a neutral light-gray viewport background for drawing-like inspection.", "preview", { kind: "set-background-tone", tone: "light-gray" }, ["scene", "display", "background"]),
  command("command:view-background-white", "part", "inspect", "White Background", "Set a white viewport background for high-contrast capture.", "preview", { kind: "set-background-tone", tone: "white" }, ["scene", "display", "background"]),
  command("command:view-refresh", "part", "inspect", "Refresh View", "Re-fit the current visible geometry and redraw the current scene.", "preview", { kind: "fit-view" }, ["redraw", "update", "camera"]),
  command("command:view-zoom", "part", "inspect", "Zoom In / Out", "Use the mouse wheel over the viewport for cursor-centered camera zoom.", "preview", { kind: "open-workspace" }, ["camera", "scale", "wheel"]),
  command("command:view-rotate", "part", "inspect", "Rotate View", "Activate orbit navigation for drag-based camera rotation.", "preview", { kind: "set-navigation-mode", mode: "orbit" }, ["camera", "precise rotation", "view operation"]),
  command("command:view-orient-wcs", "part", "inspect", "Orient to WCS", "Return the camera to the global isometric orientation and keep the global axes visible.", "preview", { kind: "set-view-orientation", orientation: "isometric" }, ["set view to wcs", "restore", "orient"]),
  command("command:view-fit-selection", "part", "inspect", "Fit View to Selection", "Fit the currently visible model envelope; selection-only bounds require persistent topology and remain a boundary.", "preview", { kind: "fit-view" }, ["camera", "selection", "fit"]),
  unavailable("command:view-exclude-datums-fit", "part", "inspect", "Exclude Datums from Fit", "Requires a persistent datum-object inventory and selection-aware camera bounds before datums can be excluded deterministically.", ["camera", "fit", "datum", "view operation"]),
  command("command:view-show-and-hide", "part", "inspect", "Show and Hide", "Open the Part workspace visibility controls for individual bodies and the complete preview-body set.", "preview", { kind: "open-workspace" }, ["content", "visibility", "display"]),
  command("command:view-immediate-hide", "part", "inspect", "Immediate Hide", "Toggle the selected independent preview body without changing the qualified base body.", "preview", { kind: "selected-part-preview-body-action", operation: "toggle-visible" }, ["hide", "visibility", "content"]),
  unavailable("command:view-section", "part", "inspect", "Section View", "The drawing workspace provides the bounded A-A section, but an interactive clipping plane requires cap geometry, drag controls, and selectable section results.", ["clip", "cut", "content"]),
  unavailable("command:view-clip-section", "part", "inspect", "Clip Section", "Requires an interactive clipping plane, watertight cap generation, stable pick results, and reversible camera-scene state.", ["section", "clip", "cutaway"]),
  unavailable("command:view-show-all-type", "part", "inspect", "Show All of Type", "Requires typed persistent object collections and one atomic visibility transaction scoped to the selected object type.", ["visibility", "content", "type filter"]),
  unavailable("command:view-show-by-name", "part", "inspect", "Show by Name", "Requires a persistent searchable object inventory plus atomic visibility-set updates.", ["visibility", "find", "content"]),
  unavailable("command:view-invert-visibility", "part", "inspect", "Invert Visibility", "Requires a visibility transaction spanning every supported object type and protected datum rules.", ["show", "hide", "content"]),
  command("command:view-fit-show-hide", "part", "inspect", "Fit on Show Hide", "Refit the visible model envelope after a body visibility change.", "preview", { kind: "fit-view" }, ["camera", "visibility", "fit"]),
  unavailable("command:view-precise-rotation", "part", "inspect", "Precise Rotation", "Requires numeric camera-axis and angle input with a saved-view model.", ["camera", "angle", "view operation"]),
  unavailable("command:view-layout", "part", "inspect", "Window / View Layout", "Requires multiple synchronized viewport instances, saved layouts, and active-view routing.", ["split view", "window", "camera"]),
  command("command:view-studio", "part", "inspect", "Studio", "Use the PS3D studio-style shaded-with-edges viewport presentation.", "preview", { kind: "set-shading-mode", mode: "shaded-edges" }, ["display", "style", "shaded"]),
  unavailable("command:view-preferences", "part", "inspect", "Preferences", "Requires a versioned user-preference schema, migration rules, reset behavior, and accessible settings UI.", ["display", "application", "settings"]),
  unavailable("command:view-visual-material", "part", "inspect", "Visual Material", "Display appearance is supported, but physical/render materials require a material library, texture assets, units, and rendering provenance.", ["appearance", "finish", "render"]),
  command("command:view-appearance-management", "part", "inspect", "Appearance Management", "Open the selected preview body's display-only color and appearance controls.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-appearance" }, ["visual material", "color", "object display"]),
  unavailable("command:view-immersive", "part", "inspect", "Immersive", "Requires an XR renderer, supported device session, interaction model, frame-budget validation, and permission controls.", ["display", "xr", "virtual reality"]),
  unavailable("command:view-omniverse", "part", "inspect", "Omniverse", "Requires a separately licensed and authenticated interchange connector plus schema, material, and revision mapping.", ["display", "connector", "collaboration"]),
  unavailable("command:view-background-graduated-light", "part", "inspect", "Graduated Light Gray", "The current renderer supports four solid background tones; a graduated scene requires a validated gradient renderer and saved scene preferences.", ["background", "scene", "light theme"]),
  unavailable("command:view-background-graduated-dark", "part", "inspect", "Graduated Dark Gray", "The current renderer supports four solid background tones; a graduated scene requires a validated gradient renderer and saved scene preferences.", ["background", "scene", "dark theme"]),
  unavailable("command:view-light-theme", "part", "inspect", "Light Theme", "The current public shell is intentionally PS3D light-neutral; a user-selectable theme requires token coverage, persistence, and contrast verification.", ["display", "background", "preferences"]),
  unavailable("command:view-dark-theme", "part", "inspect", "Dark Theme", "Requires a complete PS3D dark token set, persisted preference, chart/canvas adaptation, and WCAG contrast verification.", ["display", "background", "preferences"]),
  command("command:view-edit-object-display", "part", "inspect", "Edit Object Display", "Open the selected preview body's display-only color controls without changing its engineering geometry.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-appearance" }, ["appearance", "object", "color"]),
  unavailable("command:view-global-finish", "part", "inspect", "Global Finish", "Requires a rendering-material library, finish definitions, texture provenance, scene lighting, and deterministic export mapping.", ["appearance", "material", "render"]),
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
  command("command:assembly-fix", "assembly", "assemble", "Fix / Release Component", "Toggle the selected component between grounded and movable state.", "preview", { kind: "selected-component-action", operation: "toggle-grounded" }, ["position", "ground", "lock"]),
  command("command:assembly-work-context", "assembly", "assemble", "Work on Assembly", "Open the assembly workspace and expose component, mate, explosion, and interference records.", "preview", { kind: "open-workspace" }, ["context", "work part", "assembly"]),
  command("command:assembly-clearance", "assembly", "inspect", "Clearance / Interference", "Run the bounded visible-component axis-aligned overlap screen.", "preview", { kind: "select-record", selectionId: "analysis:interference" }, ["clearance", "collision", "clash"]),
  command("command:assembly-position-editor", "assembly", "modify", "Position Component", "Open XYZ translation controls for the selected component.", "preview", { kind: "select-record", selectionId: "assembly-action:move" }, ["move component", "translate", "arrange"]),
  unavailable("command:assembly-auto-align", "assembly", "assemble", "Auto Align", "Requires inferred mating references, orientation candidates, a constraint solver, and ambiguity review.", ["position", "mate", "automatic"]),
  unavailable("command:assembly-touch", "assembly", "assemble", "Touch", "Requires selectable exact faces, contact direction, offset, and a solved component transform.", ["mate", "contact", "position"]),
  unavailable("command:assembly-align", "assembly", "assemble", "Align", "Requires persistent planar, cylindrical, linear, or point references and a transform solver.", ["mate", "position", "constraint"]),
  unavailable("command:assembly-parallel", "assembly", "assemble", "Parallel", "Requires two directional or planar references and solver-managed rotational degrees of freedom.", ["mate", "orientation", "position"]),
  unavailable("command:assembly-perpendicular", "assembly", "assemble", "Perpendicular", "Requires two directional references and a validated 90-degree solved relation.", ["mate", "orientation", "position"]),
  unavailable("command:assembly-concentric", "assembly", "assemble", "Concentric", "Requires persistent cylindrical axes, axial freedom rules, and solver-backed placement.", ["mate", "axis", "position"]),
  unavailable("command:assembly-align-lock", "assembly", "assemble", "Align / Lock", "Requires paired alignment references plus explicit locking of remaining degrees of freedom.", ["mate", "constraint", "position"]),
  unavailable("command:assembly-distance", "assembly", "assemble", "Distance Constraint", "Requires two geometric references, signed offset, direction, limits, and a solver.", ["mate", "offset", "position"]),
  unavailable("command:assembly-angle", "assembly", "assemble", "Angle Constraint", "Requires two directional references, solution quadrant, limits, and a solver.", ["mate", "rotation", "position"]),
  unavailable("command:assembly-bond", "assembly", "assemble", "Bond", "Requires a rigid relationship that preserves the complete relative transform through regeneration.", ["mate", "rigid", "position"]),
  unavailable("command:assembly-center", "assembly", "assemble", "Center", "Requires opposing reference pairs, symmetry evaluation, and a component transform solver.", ["mate", "midplane", "position"]),
  unavailable("command:assembly-fit", "assembly", "assemble", "Fit Constraint", "Requires size-matched cylindrical or prismatic references, clearance rules, and a solver.", ["mate", "insert", "position"]),
  unavailable("command:assembly-joints-couplers", "assembly", "assemble", "Joints and Couplers", "Requires degrees-of-freedom definitions, limits, drivers, coupler equations, and motion validation.", ["revolute", "slider", "gear", "motion"]),
  unavailable("command:assembly-arrangements", "assembly", "assemble", "Arrangements", "Requires named alternative component positions, suppression states, consistency rules, and revision-safe switching.", ["configuration", "position", "variant"]),
  unavailable("command:assembly-pattern-component", "assembly", "create", "Pattern Component", "Requires associative occurrence instances, layout controls, transform propagation, and dependency handling.", ["component", "array", "copy"]),
  unavailable("command:assembly-mirror", "assembly", "create", "Mirror Assembly", "Requires an assembly mirror plane, occurrence mapping, handed-part policy, and mate remapping.", ["component", "symmetry", "copy"]),
  unavailable("command:assembly-make-unique", "assembly", "modify", "Make Unique", "Requires document-backed component definitions, occurrence ownership, copied design data, and reference remapping.", ["component", "copy", "independent"]),
  unavailable("command:assembly-reference-sets", "assembly", "assemble", "Reference Sets", "Requires named subsets of component geometry, loading policy, display scope, and replacement-safe references.", ["context", "representation", "replace reference set"]),
  unavailable("command:assembly-compare", "assembly", "inspect", "Compare Assemblies", "Requires two revisioned assemblies, stable identity mapping, geometry/attribute differencing, and a review report.", ["context", "diff", "revision"]),
  unavailable("command:assembly-show-only", "assembly", "inspect", "Show Only", "Requires an atomic visibility transaction for selected occurrences and restore support.", ["context", "isolate", "visibility"]),
  unavailable("command:assembly-interpart-links", "assembly", "assemble", "Interpart Links", "Requires persistent cross-document geometry references, update policies, cycle detection, and repair.", ["wave", "associative", "context"]),
  unavailable("command:assembly-simplify", "assembly", "modify", "Simplify Assembly", "Requires defeaturing rules, envelope accuracy targets, protected interfaces, and traceability to source geometry.", ["lightweight", "defeature", "representation"]),
  unavailable("command:assembly-sequence", "assembly", "document", "Assembly Sequence", "Requires ordered installation steps, component states, path validation, timing, and playback controls.", ["sequence", "animation", "process"]),
  unavailable("command:assembly-label-modeling", "assembly", "assemble", "Label as Modeling Component", "Requires ownership metadata, editable occurrence definitions, and context-aware authoring permissions.", ["component", "context", "work part"]),
  command("command:utility-move-object", "part", "modify", "Move Object", "Open XYZ translation and rotation controls for the selected independent preview body.", "preview", { kind: "selected-part-preview-body-action", operation: "edit-transform" }, ["utilities", "ctrl t", "transform"]),
  unavailable("command:utility-assign-materials", "part", "modify", "Assign Materials", "Appearance color is supported, but engineering material assignment requires density, elastic, thermal, provenance, and unit-aware property records.", ["utilities", "physical material", "mass"]),
  unavailable("command:utility-expressions", "part", "automate", "Expressions", "Requires named parameters, dimensional equation parsing, dependency ordering, cycle detection, and solve diagnostics.", ["utilities", "formula", "ctrl e"]),
  unavailable("command:utility-part-families", "part", "automate", "Part Families", "Requires a validated parameter table, member generation, naming rules, document storage, and configuration traceability.", ["utilities", "configuration", "family"]),
  unavailable("command:utility-parameter-tables", "part", "automate", "Parameter Tables", "Requires typed parameter columns, units, expressions, validation, configuration selection, and import/export.", ["utilities", "spreadsheet", "table"]),
  unavailable("command:utility-spreadsheet", "part", "automate", "Spreadsheet", "Requires a sandboxed workbook model, explicit cell-to-parameter links, recalculation rules, and safe import/export.", ["utilities", "table", "excel"]),
  unavailable("command:utility-raster-image", "part", "construct", "Raster Image", "Requires a user-selected image asset, plane placement, calibration scale, opacity, persistence, and safe decoding.", ["utilities", "canvas", "reference"]),
  unavailable("command:route-piping", "assembly", "create", "Piping and Tubing", "Requires a component and fitting catalog, nominal-size rules, centerline routes, bend constraints, joints, and fabrication output.", ["routing", "mechanical", "pipe"]),
  unavailable("command:route-hvac", "assembly", "create", "HVAC Route", "Requires duct catalogs, airflow sizing inputs, fitting rules, clearances, supports, and pressure-loss validation.", ["routing", "mechanical", "duct"]),
  unavailable("command:route-platform", "assembly", "create", "Platform Route", "Requires standards-aware structural sections, path framing, connections, loads, access rules, and fabrication output.", ["routing", "mechanical", "structure"]),
  unavailable("command:route-cableway", "assembly", "create", "Cableway", "Requires tray catalogs, bend radii, fill calculations, supports, separation rules, and route ownership.", ["routing", "mechanical", "tray"]),
  unavailable("command:route-pipe-welding", "assembly", "create", "Pipe Welding", "Requires weld-joint preparation, process, material, procedure, inspection, and spool traceability.", ["routing", "mechanical", "weld"]),
  unavailable("command:route-mechanical-system", "assembly", "assemble", "Mechanical System", "Requires typed ports, connected route networks, equipment ownership, flow direction, and system validation.", ["route", "piping", "system"]),
  unavailable("command:weld-groove", "assembly", "assemble", "Groove Weld", "Requires edge pairs, joint preparation, weld symbol data, process/material inputs, and modeled or symbolic output.", ["solid weld", "weld assistant", "groove"]),
  unavailable("command:weld-fillet", "assembly", "assemble", "Fillet Weld", "Requires joined faces or edges, leg/throat sizing, intermittent options, process data, and inspection notation.", ["solid weld", "weld assistant", "fillet"]),
  unavailable("command:weld-user-defined", "assembly", "assemble", "User Defined Weld", "Requires a versioned weld profile, placement path, orientation, metadata, and validation.", ["solid weld", "custom", "weld assistant"]),
  unavailable("command:weld-plug-slot", "assembly", "assemble", "Plug / Slot Weld", "Requires hole or slot features, overlapping members, fill definition, spacing, and welding annotation.", ["solid weld", "weld assistant", "plug"]),
  unavailable("command:weld-compound", "assembly", "assemble", "Compound Weld", "Requires coordinated multiple weld features, shared joint references, sequencing, and combined symbol output.", ["solid weld", "weld assistant", "compound"]),
  unavailable("command:mold-design", "part", "automate", "Mold Design", "Requires parting analysis, shrinkage, core/cavity extraction, tooling catalogs, cooling, ejection, and manufacturing validation.", ["mold and die", "toolbox", "plastic"]),
  unavailable("command:mold-progressive-die", "part", "automate", "Progressive Die", "Requires sheet-metal strip layout, stations, forming operations, carrier design, forces, and die-set validation.", ["mold and die", "tooling", "stamping"]),
  unavailable("command:mold-electrode-design", "part", "automate", "Electrode Design", "Requires EDM face selection, offsets, holder systems, burn allowances, setup coordinates, and manufacturing documentation.", ["mold and die", "edm", "tooling"]),
  unavailable("command:mold-engineering-die", "part", "automate", "Engineering Die", "Requires forming-process definition, addendum, binder, draw beads, trimming, springback, and CAE correlation.", ["mold and die", "stamping", "tooling"]),
  unavailable("command:mold-feature-cost", "part", "inspect", "Feature to Cost", "Requires manufacturing feature recognition, process/rate libraries, material data, assumptions, and cost provenance.", ["feature2cost", "manufacturing", "estimate"]),
  unavailable("command:mold-conformal-cooling", "part", "automate", "Conformal Cooling", "Requires cooling-channel synthesis, manufacturability constraints, fluid/thermal analysis, and tool validation.", ["mold and die", "cooling", "additive"]),
  unavailable("command:die-engineering", "part", "automate", "Die Engineering", "Requires tool architecture, standards, insert design, clearances, process forces, and production validation.", ["mold and die", "tooling", "stamping"]),
  unavailable("command:die-design", "part", "automate", "Die Design", "Requires forming geometry, trim and pierce operations, standard parts, tolerances, and manufacturing drawings.", ["mold and die", "tooling", "stamping"]),
  unavailable("command:die-validation", "part", "inspect", "Die Validation", "Requires forming simulation, interference, force, springback, fatigue, tolerance, and tryout evidence.", ["mold and die", "verify", "stamping"]),

  command("command:surface-bezier", "surface", "create", "Bicubic Bézier patch", "Create a deterministic tessellated open patch.", "preview", { kind: "set-surface-mode", mode: "bezier" }, ["control net", "patch"]),
  command("command:surface-loft", "surface", "create", "Ruled loft", "Create a deterministic two-section ruled loft preview.", "preview", { kind: "set-surface-mode", mode: "loft" }, ["profiles", "blend"]),
  unavailable("command:surface-sweep", "surface", "create", "Surface sweep", "Requires exact curve-on-surface and continuity handling.", ["rail", "path"]),
  unavailable("command:surface-patch", "surface", "create", "Boundary patch", "Requires ordered boundary loops and continuity constraints.", ["fill", "network"]),
  unavailable("command:surface-trim", "surface", "modify", "Trim surface", "Requires exact surface intersections and parameter-space loops.", ["split", "cut"]),
  unavailable("command:surface-stitch", "surface", "modify", "Stitch surfaces", "Requires topology sewing, gap tolerances, and watertight validation.", ["sew", "join"]),
  unavailable("command:surface-thicken", "surface", "modify", "Thicken", "Requires robust offset surfaces and exact side-wall construction.", ["solid", "offset"]),
  unavailable("command:curve-project", "surface", "construct", "Project Curve", "Requires source curves or edges, target planes or faces, projection direction or closest-point rules, and associative references.", ["curve", "derived", "include"]),
  unavailable("command:curve-intersection", "surface", "construct", "Intersection Curve", "Requires exact face/face, body/plane, or curve/surface intersection and ordered output segments.", ["curve", "derived", "intersect"]),
  unavailable("command:curve-shadow", "surface", "construct", "Shadow Curve", "Requires a projection direction, target body or face set, silhouette extraction, and persistent result curves.", ["curve", "derived", "silhouette"]),
  unavailable("command:curve-offset", "surface", "construct", "Offset Curve", "Requires curve-chain selection, plane or support surface, distance, corner handling, and self-intersection checks.", ["curve", "derived", "parallel"]),
  unavailable("command:curve-offset-face", "surface", "construct", "Offset Curve in Face", "Requires a curve-on-face reference, surface metric offsetting, side choice, and singularity handling.", ["curve", "derived", "surface", "offset in face"]),
  unavailable("command:curve-bridge", "surface", "construct", "Bridge Curve", "Requires two endpoint references, tangent or curvature constraints, magnitude controls, and continuity validation.", ["curve", "derived", "blend"]),
  unavailable("command:curve-composite", "surface", "construct", "Composite Curve", "Requires an ordered connected chain, gap tolerance, direction control, and persistent member references.", ["curve", "derived", "join"]),

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
  unavailable("command:table-edit", "drawing", "document", "Edit Table", "Requires persistent drawing-table entities, typed cells, style inheritance, selection, and undoable edits.", ["table", "edit", "drafting", "edit without spreadsheet"]),
  unavailable("command:table-edit-cell", "drawing", "document", "Edit Cell", "Requires a selected table cell, typed value or formula validation, and layout regeneration.", ["table", "cell", "edit"]),
  unavailable("command:table-edit-text", "drawing", "document", "Edit Table Text", "Requires rich drafting text, symbol/font handling, wrapping, and cell association.", ["table", "text", "edit"]),
  unavailable("command:table-spreadsheet-edit", "drawing", "document", "Edit Using Spreadsheet", "Requires a safe workbook bridge, explicit synchronization policy, and conflict handling.", ["table", "spreadsheet", "edit"]),
  unavailable("command:table-insert-row-above", "drawing", "document", "Insert Row Above", "Requires a selected cell/row plus merged-cell, style, formula, and reference propagation.", ["table", "row", "column"]),
  unavailable("command:table-insert-row-below", "drawing", "document", "Insert Row Below", "Requires a selected cell/row plus merged-cell, style, formula, and reference propagation.", ["table", "row", "column"]),
  unavailable("command:table-insert-column-right", "drawing", "document", "Insert Column to the Right", "Requires a selected column plus style, width, formula, and reference propagation.", ["table", "row", "column"]),
  unavailable("command:table-insert-column-left", "drawing", "document", "Insert Column to the Left", "Requires a selected column plus style, width, formula, and reference propagation.", ["table", "row", "column"]),
  unavailable("command:table-resize", "drawing", "document", "Resize Table", "Requires persistent row heights, column widths, content fitting, and sheet-boundary checks.", ["table", "row", "column"]),
  unavailable("command:table-header-row", "drawing", "document", "Insert Header Row", "Requires table semantics, header style, repetition rules, and parts-list compatibility.", ["table", "header", "row"]),
  unavailable("command:table-lock-rows", "drawing", "document", "Lock / Unlock Rows", "Requires row state, editing permissions, sorting behavior, and update preservation.", ["table", "lock", "row"]),
  unavailable("command:table-attach-rows", "drawing", "document", "Attach / Detach Rows", "Requires split-table continuation, page/sheet placement, and shared data identity.", ["table", "row", "split"]),
  unavailable("command:table-import-attributes", "drawing", "document", "Import Attributes", "Requires a documented attribute schema, safe parsing, key mapping, and conflict review.", ["table", "import", "metadata"]),
  unavailable("command:table-import-expressions", "drawing", "document", "Import Expressions", "Requires typed dimensional expressions, dependency validation, units, and safe merge rules.", ["table", "import", "parameters"]),
  unavailable("command:table-import-spreadsheet", "drawing", "document", "Import Spreadsheet", "Requires safe workbook parsing, sheet/range selection, schema mapping, and formula policy.", ["table", "import", "spreadsheet"]),
  unavailable("command:table-export", "drawing", "document", "Export Table", "Requires a selected table, explicit format, encoding, units, and verified output.", ["table", "export", "csv"]),
  unavailable("command:table-save-template", "drawing", "document", "Save Table as Template", "Requires a versioned style/content template with ownership and placeholder rules.", ["table", "template", "reuse"]),
  unavailable("command:document-save-as-template", "drawing", "document", "Save As Template", "Requires versioned document ownership, placeholder rules, compatibility migration, and a safe template-library boundary.", ["drawing", "table", "template", "reuse"]),
  unavailable("command:table-update-parts-list", "drawing", "document", "Update Parts List", "Requires assembly-document linkage, item numbering, quantities, exclusions, and revision tracking.", ["table", "update", "bom"]),
  unavailable("command:table-update-tabular-note", "drawing", "document", "Update Tabular Note", "Requires linked source data, formatting rules, and deterministic regeneration.", ["table", "update", "note"]),
  unavailable("command:table-update-hole", "drawing", "document", "Update Hole Table", "Requires persistent exact cylindrical features, datum coordinates, callout rules, and view association.", ["table", "update", "hole"]),
  unavailable("command:table-evaluate-rules", "drawing", "document", "Evaluate Rules and Update", "Requires a sandboxed rule engine, dependency graph, diagnostics, and deterministic output.", ["table", "update", "rule"]),
  unavailable("command:table-update-bend", "drawing", "document", "Update Bend Table", "Requires sheet-metal bend features, flat-pattern identity, bend allowance data, and view linkage.", ["table", "update", "sheet metal"]),
  unavailable("command:table-update-family", "drawing", "document", "Update Part Family Table", "Requires configuration-family membership, parameter columns, revision status, and document linkage.", ["table", "update", "family"]),

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
  command("command:electrical-system", "electrical", "create", "Electrical System", "Open the connected schematic workspace with typed devices, terminals, nets, and electrical-rule checks.", "preview", { kind: "open-workspace" }, ["route", "toolbox", "logical"]),
  command("command:electrical-harness-preview", "electrical", "automate", "Harness Physicalization Preview", "Generate the review-gated wired mounting-plate candidate with component mappings and unsized conductor paths.", "preview", { kind: "generate-electromechanical-realization" }, ["route", "harness", "cabling", "physical"]),
  unavailable("command:electrical-harness", "electrical", "create", "Production Harness", "Requires connector and terminal catalogs, wire gauges, splice rules, branch points, coverings, lengths, flattening, and manufacturing drawings.", ["route", "electrical", "harness"]),
  unavailable("command:electrical-cabling", "electrical", "create", "Cabling", "Requires cable catalogs, conductor definitions, connectors, bend radius, routing clearances, lengths, and fabrication data.", ["route", "electrical", "cable"]),
  unavailable("command:electrical-logical", "electrical", "construct", "Logical Design", "Requires a typed functional connectivity model with allocation to physical devices and revision-safe trace links.", ["application", "design", "logical"]),
  unavailable("command:simulation-pre-post", "automate", "inspect", "Simulation Pre / Post", "Requires validated meshers and solvers, unit-aware loads and constraints, convergence evidence, and result postprocessing.", ["simulation", "pre post", "fea"]),
  unavailable("command:simulation-motion", "automate", "inspect", "Motion Simulation", "Requires solved joints, mass and inertia, contacts, drivers, time integration, and physical correlation.", ["simulation", "kinematics", "dynamics"]),
  unavailable("command:simulation-design", "automate", "inspect", "Design Simulation", "Requires a defined physics domain, material models, loads, boundary conditions, solver verification, and engineering review.", ["simulation", "analysis", "cae"]),
  unavailable("command:simulation-flexible-pipe", "automate", "inspect", "Flexible Pipe Simulation", "Requires nonlinear beam or shell properties, pressure, temperature, contacts, supports, fatigue, and test correlation.", ["simulation", "pipe", "routing"]),
  unavailable("command:simulation-mold-cooling", "automate", "inspect", "Mold Cooling Analysis", "Requires mold geometry, cooling circuits, material thermal data, process conditions, meshing, and correlated solver models.", ["simulation", "mold", "thermal"]),
  unavailable("command:journal-play", "automate", "automate", "Play Journal", "Python and MCP automation are supported, but deterministic journal recording/playback requires a versioned command log, sandbox, permissions, and failure recovery.", ["journal", "play", "macro", "alt f8"]),

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
  command("command:automate-agent", "automate", "automate", "Collaboration agent handshake", "Configure a stateless host-AI and PS3D coordination pass with experience-level guidance, bounded recipe matching, stable-ID checks, and correction feedback before execution.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_agent_handshake" }, ["ai", "agent", "collaborate", "coordinate", "beginner", "phd", "feedback", "validate"]),
  command("command:automate-design-health", "automate", "inspect", "Design Health Center", "Analyze all workspaces, actual associativity, deterministic rebuild order, and release boundaries.", "preview", { kind: "open-design-health" }, ["health", "rebuild", "dependency", "associativity", "quality", "readiness"], "Ctrl+Shift+H"),
  command("command:automate-find", "automate", "automate", "Smart command finder", "Match a plain-language engineering goal to bounded command recipes without executing it.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_find_commands" }, ["ai", "intent", "natural language", "recipe", "command"]),
  command("command:automate-capabilities", "automate", "automate", "MCP capability matrix", "List qualified, preview, and unavailable capabilities.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_capabilities" }, ["ai", "tools", "schema"]),
  command("command:automate-inspect", "automate", "automate", "MCP inspect project", "Validate and summarize a supplied in-memory project.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_inspect_project" }, ["read", "validate"]),
  command("command:automate-preview", "automate", "automate", "MCP preview operation", "Validate intent and issue a deterministic receipt.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_preview_operation" }, ["diff", "receipt"]),
  command("command:automate-apply", "automate", "automate", "MCP apply confirmed preview", "Return a new project only after matching receipt and confirmation.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_apply_preview" }, ["confirm", "mutation"]),
  command("command:automate-python", "automate", "automate", "Python SDK", "Connect standard-library Python to the local MCP stdio server.", "preview", { kind: "select-record", selectionId: "automation:python-sdk" }, ["script", "client", "stdlib"]),
  command("command:automate-remote", "automate", "automate", "Remote authenticated MCP", "Review the deployed /api/mcp OAuth or expiring-token connection contract and current guide acknowledgement requirement.", "preview", { kind: "select-record", selectionId: "mcp-tool:ps3d_guide" }, ["http", "cloud", "oauth", "token", "remote"])
] as const;

export function commandsForWorkspace(workspace: WorkspaceId): readonly CadCommandRecord[] {
  return CAD_COMMANDS.filter((record) => record.workspace === workspace);
}

export function auditCadCommandSurface(commands: readonly CadCommandRecord[] = CAD_COMMANDS): CadCommandAuditReport {
  const issues: CadCommandAuditIssue[] = [];
  const ids = new Set<string>();
  const shortcuts = new Set<string>();
  const executableKinds = new Set<string>(CAD_EXECUTABLE_ACTION_KINDS);
  for (const record of commands) {
    if (!/^command:[a-z0-9][a-z0-9-]*$/u.test(record.id)) issues.push({ code: "INVALID_COMMAND_ID", commandId: record.id, message: "Command IDs must use the stable command:<kebab-case> namespace." });
    if (ids.has(record.id)) issues.push({ code: "DUPLICATE_COMMAND_ID", commandId: record.id, message: "Command IDs must be globally unique." });
    ids.add(record.id);
    if (record.name.trim().length === 0 || record.description.trim().length === 0 || record.keywords.length === 0) issues.push({ code: "INCOMPLETE_DISCOVERY_TEXT", commandId: record.id, message: "Name, description, and at least one search keyword are required." });
    if (record.guide.selection.trim().length === 0 || record.guide.steps.length < 3 || record.guide.result.trim().length === 0 || record.guide.boundary.trim().length === 0) issues.push({ code: "INCOMPLETE_TRIAL_CONTRACT", commandId: record.id, message: "Selection, at least three trial steps, expected result, and verification boundary are required." });
    if ((record.action.kind === "unavailable") !== (record.level === "unavailable")) issues.push({ code: "CAPABILITY_LABEL_MISMATCH", commandId: record.id, message: "Unavailable execution and capability labels must agree exactly." });
    if (record.action.kind !== "unavailable" && !executableKinds.has(record.action.kind)) issues.push({ code: "UNREGISTERED_ACTION_HANDLER", commandId: record.id, message: `No audited UI action-handler contract is registered for ${record.action.kind}.` });
    if (record.action.kind === "select-record" && record.action.selectionId.trim().length === 0) issues.push({ code: "EMPTY_SELECTION_ID", commandId: record.id, message: "Selection commands require a non-empty stable selection ID." });
    if (record.shortcut !== undefined) {
      const key = `${record.workspace}:${record.shortcut.toLowerCase()}`;
      if (shortcuts.has(key)) issues.push({ code: "DUPLICATE_WORKSPACE_SHORTCUT", commandId: record.id, message: `Shortcut ${record.shortcut} is already assigned in ${record.workspace}.` });
      shortcuts.add(key);
    }
  }
  const levels: readonly CapabilityLevel[] = ["qualified", "preview", "unavailable"];
  const workspaces: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];
  const byLevel = Object.fromEntries(levels.map((level) => [level, commands.filter((record) => record.level === level).length])) as Record<CapabilityLevel, number>;
  const byWorkspace = Object.fromEntries(workspaces.map((workspace) => {
    const scoped = commands.filter((record) => record.workspace === workspace);
    return [workspace, { total: scoped.length, ...Object.fromEntries(levels.map((level) => [level, scoped.filter((record) => record.level === level).length])) }];
  })) as Record<string, Record<CapabilityLevel | "total", number>>;
  return {
    schema: "ps3d-command-surface-audit/1",
    passed: issues.length === 0,
    total: commands.length,
    executable: commands.filter((record) => record.action.kind !== "unavailable").length,
    truthfullyBlocked: commands.filter((record) => record.action.kind === "unavailable").length,
    byLevel,
    byWorkspace,
    actionKindsCovered: [...new Set(commands.filter((record) => record.action.kind !== "unavailable").map((record) => record.action.kind))].sort(),
    issues
  };
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
  shortcut?: string,
  guide?: CadCommandGuide
): CadCommandRecord {
  const base = {
    id, workspace, category, name, description, level, action, keywords,
    group: `${workspaceLabel(workspace)} / ${categoryLabel(category)}`,
    guide: guide ?? defaultGuide(workspace, name, description, level, action)
  };
  return shortcut === undefined ? base : { ...base, shortcut };
}

function unavailable(
  id: string,
  workspace: WorkspaceId,
  category: CadCommandCategory,
  name: string,
  description: string,
  keywords: readonly string[],
  guide?: CadCommandGuide
): CadCommandRecord {
  return command(id, workspace, category, name, description, "unavailable", { kind: "unavailable" }, keywords, undefined, guide);
}

function defaultGuide(workspace: WorkspaceId, name: string, description: string, level: CapabilityLevel, action: CadCommandAction): CadCommandGuide {
  const unavailableCommand = level === "unavailable" || action.kind === "unavailable";
  return {
    selection: selectionPrompt(action),
    steps: unavailableCommand
      ? [
          `Review the ${name} definition and required references in the command details.`,
          "Supply the missing persistent data model, validated geometry/solver or domain catalog, and every required reference named in the boundary.",
          "Add preview, failure diagnostics, undo/redo, validation, and regression evidence before enabling execution."
        ]
      : [
          `Open the ${workspaceLabel(workspace)} workspace and prepare the required selection.`,
          `Run ${name}, enter or review its bounded parameters, and confirm the operation.`,
          "Inspect the viewport, model browser, feature history, and revision result; undo if the design intent is wrong."
        ],
    result: unavailableCommand ? "No geometry is changed; the command remains discoverable with an explicit implementation boundary." : description,
    boundary: unavailableCommand ? description : level === "qualified" ? "Runs on the published qualified geometry path." : "Runs as a revisioned preview; verify before manufacturing or release."
  };
}

function selectionPrompt(action: CadCommandAction): string {
  if (action.kind === "create-part-preview-body") return "No preselection required; the body is created at an offset from the qualified base body.";
  if (action.kind === "selected-part-preview-body-action") return "Select one independent preview body in the viewport or Bodies tree.";
  if (action.kind === "activate-sketch-tool") return "Activate or create a sketch on the intended plane.";
  if (action.kind === "selected-component-action") return "Select one assembly component.";
  if (action.kind === "insert-current-part-into-assembly" || action.kind === "insert-component") return "No preselection required.";
  if (action.kind === "select-record") return `The command selects ${action.selectionId} for editing or inspection.`;
  if (action.kind === "unavailable") return "Selection contract is documented, but execution is disabled until its kernel dependency is present.";
  return "No preselection required unless the command panel requests a target.";
}

function workspaceLabel(workspace: WorkspaceId): string {
  return workspace === "automate" ? "Automate" : `${workspace[0]!.toUpperCase()}${workspace.slice(1)}`;
}

function categoryLabel(category: CadCommandCategory): string {
  return `${category[0]!.toUpperCase()}${category.slice(1)}`;
}
