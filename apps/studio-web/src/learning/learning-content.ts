export type LearningLevel = "Beginner" | "Student" | "Professional" | "Advanced";

export interface LearningModule {
  readonly id: string;
  readonly number: string;
  readonly level: LearningLevel;
  readonly workspace: string;
  readonly title: string;
  readonly summary: string;
  readonly outcomes: readonly string[];
  readonly practice: readonly string[];
  readonly verification: readonly string[];
  readonly boundary: string;
}

export interface LearningManual {
  readonly title: string;
  readonly edition: string;
  readonly owner: string;
  readonly introduction: string;
  readonly modules: readonly LearningModule[];
}

export const LEARNING_LEVELS: readonly LearningLevel[] = ["Beginner", "Student", "Professional", "Advanced"];

export const PS3D_LEARNING_MANUAL: LearningManual = {
  title: "PS3D CAD Studio Learning and Safe Practice Manual",
  edition: "Public preview edition 0.2 - August 2026",
  owner: "Sagar Patel / PS3D Master",
  introduction: "A progressive, evidence-aware path from first navigation to multidisciplinary CAD review and secure AI collaboration. Every exercise distinguishes qualified geometry, deterministic engineering assistance, illustrative previews, and unavailable professional-kernel behavior.",
  modules: [
    module("orientation", "01", "Beginner", "Foundation", "Workspace orientation and project safety", "Learn the top command system, workspace tabs, feature history, project persistence, and truthful capability labels.", [
      "Identify Sketch, Part, Assembly, Surface, Drawing, Electrical, Vehicle, and Automate workspaces.",
      "Use local Save, Download, Open, undo, redo, Design Health, and the all-command launcher.",
      "Read Qualified, Preview, and Unavailable labels before treating an output as engineering evidence."
    ], [
      "Open the command launcher with Ctrl+K and search for measure, drawing, and vehicle commands.",
      "Change workspaces from the top tabs and locate feature history in the left project tree.",
      "Download a project copy before a major template replacement."
    ], ["The project revision changes after an accepted operation.", "Undo restores the preceding broad-workbench revision.", "No warning or truth label is hidden by the selected workspace."], "A browser preview is not manufacturing release, certification, roadworthiness, or regulatory approval."),
    module("navigation", "02", "Beginner", "3D View", "View orientation, orbit, selection, and measurement", "Control the model without losing spatial context or confusing a display measurement with a metrology result.", [
      "Use the view cube, named Front/Back/Top/Bottom/Left/Right/Isometric views, and perspective/orthographic projection.",
      "Switch Select, Orbit, Pan, Zoom, and Measure modes and apply body/face/edge/vertex filters.",
      "Read the axis triad, grid, camera angles, and two-point measure result."
    ], [
      "Fit the current model, select Top, switch to orthographic, then return Home.",
      "Measure between two visible points and clear the result before selecting geometry.",
      "Orbit once and confirm the orientation becomes Custom while the axis triad remains consistent."
    ], ["Fit encloses all visible geometry.", "The active navigation mode is visible.", "Measurement units and selection filter are stated."], "Viewport picking is geometric assistance; it is not calibrated inspection equipment."),
    module("sketch", "03", "Student", "Sketch", "Constrained sketch construction", "Create bounded 2D design intent using entities, construction geometry, constraints, and driving dimensions.", [
      "Create line, rectangle, circle, arc, and point entities on the sketch plane.",
      "Apply horizontal, vertical, coincident, parallel, perpendicular, tangent, equal, concentric, and fixed constraints.",
      "Edit length, radius, diameter, and coordinate dimensions while monitoring solve state."
    ], [
      "Build a centered rectangular profile with a concentric circular feature.",
      "Add dimensions in a stable order and remove redundant constraints if the diagnostic reports conflict.",
      "Toggle reference geometry to construction and verify it does not define the intended profile boundary."
    ], ["Every constraint references existing entities.", "Dimension values remain finite and positive where required.", "The solver reports no blocked conflict before downstream use."], "This preview does not yet provide a commercial symbolic solver or every geometric constraint type."),
    module("part", "04", "Student", "Part", "Qualified parametric solid workflow", "Drive the native bracket solid through bounded parameters and independently checked topology evidence.", [
      "Change width, height, thickness, bore, edge, pattern, and revolve-related parameters within schema limits.",
      "Distinguish the qualified native body from imported tessellated reference geometry.",
      "Read manifold, triangle, volume, bounds, and revision evidence returned by the isolated worker."
    ], [
      "Change thickness, inspect the updated revision, undo, and redo.",
      "Compare native body evidence with an imported mesh reference in the Part workspace.",
      "Run Design Health before exporting a release candidate."
    ], ["Worker output passes topology and limit checks.", "The browser production graph excludes the Node MCP server and candidate kernel packages.", "A failed update leaves the last valid revision available."], "The current qualified body family is bounded; it is not a general B-rep feature kernel equivalent to Fusion 360, NX, or SolidWorks."),
    module("assembly", "05", "Professional", "Assembly", "Assembly planning and dependency control", "Create editable component arrangements, grounding, visibility, explode state, basic mates, and deterministic interference candidates.", [
      "Use cargo, BESS, and electrical-panel templates as editable planning geometry.",
      "Move components, control grounding and visibility, and inspect mate and interference status.",
      "Review cross-workspace electrical links before replacing an assembly template."
    ], [
      "Load a cargo or BESS arrangement and examine components by subsystem.",
      "Move one ungrounded component, set an exploded view, and confirm undo returns the prior layout.",
      "Generate an electrical mounting plate only after reviewing the schematic-to-3D mapping dialog."
    ], ["Grounded components are not moved by an edit.", "AABB interference candidates are reviewed rather than declared exact contact.", "Template replacement explicitly reports broken cross-workspace links."], "Assembly previews do not provide a full mate solver, exact collision kernel, tolerance stack, or structural certification."),
    module("surface", "06", "Professional", "Surface", "Bounded surface-shape studies", "Explore crown, twist, segmentation, and display topology while preserving the distinction between a tessellated study and exact Class-A surfacing.", [
      "Switch supported surface modes and edit bounded shaping parameters.",
      "Read patch, vertex, and triangle metrics and inspect open boundaries.",
      "Use orthographic views, wireframe cues, and fit to review continuity visually."
    ], [
      "Create a crown study, change twist, and compare the topology metrics.",
      "Inspect the boundary from top and isometric views.",
      "Record unresolved continuity requirements before downstream use."
    ], ["All generated coordinates are finite.", "Segment limits prevent runaway tessellation.", "The UI calls the output a preview surface study."], "No exact NURBS, trimmed-surface, zebra, curvature-comb, or certified Class-A continuity claim is made."),
    module("drawing", "07", "Professional", "Drawing", "Engineering drawing and GD&T review", "Generate ISO/ASME-oriented multi-view sheets with projection disclosure, dimensions, section view, title block, notes, general tolerances, datums, and bounded GD&T symbols.", [
      "Choose sheet size, projection method, scale, view preset, and display style.",
      "Control automatic dimensions, section view, datum scheme, position, flatness, and perpendicularity entries.",
      "Review title-block metadata, general tolerance values, and SVG export safety."
    ], [
      "Generate a four-view plus isometric ISO sheet and verify first-angle disclosure.",
      "Enable a section view and datum A-B-C scheme; enter explicit GD&T values appropriate to an exercise only.",
      "Export SVG and compare the rendered sheet with project parameters."
    ], ["Views fit inside the selected sheet and do not overlap the title block.", "Dimension values match the project intent and units.", "User-entered tolerances are reviewed by a responsible engineer."], "Automatic dimensions and GD&T are drafting assistance, not semantic product-manufacturing information or an authority-approved drawing release."),
    module("electrical", "08", "Professional", "Electrical", "Schematic, ERC, and mounting-plate realization", "Build a bounded schematic, run deterministic electrical-rule checks, then map verified devices and nets into generic 3D panel envelopes and conductor routes.", [
      "Insert and place supported devices, terminals, protection, power conversion, loads, sensors, and grounding symbols.",
      "Create nets with class metadata and interpret ERC findings.",
      "Review package mappings, DIN rails, ducts, bonding, clearances, and unsized routes before physicalization."
    ], [
      "Generate a motor-starter or BESS auxiliary schematic and resolve every blocking ERC finding.",
      "Open the circuit-to-3D review, inspect each generic package mapping, then confirm a linked mounting plate.",
      "Cross-probe one physical component back to its schematic source."
    ], ["Reference designators are unique.", "Every net endpoint exists.", "Generic envelopes and unsized wires are not mistaken for manufacturer parts or construction routing."], "PS3D does not replace ECAD, creepage/clearance qualification, short-circuit study, thermal study, cable sizing, or electrical code approval."),
    module("vehicle", "09", "Advanced", "Vehicle", "Two- and three-wheeler engineering studies", "Use layered generic templates and deterministic preliminary calculations for topology, hard points, suspension state, axle loads, braking, road load, powertrain, lean, and support polygon.", [
      "Compare ICE motorcycle, scooter, EV motorcycle, delta three-wheeler, and tadpole three-wheeler topologies.",
      "Edit wheelbase, rake, trail, CG, mass, suspension, tire, brake, and powertrain inputs with units and bounds.",
      "Switch full-droop, design-ride, and full-bump state and isolate sketch, boundary, chassis, suspension, wheel, brake, steering, and powertrain layers."
    ], [
      "Load an EV motorcycle and inspect named hard points from side and top views.",
      "Change one parameter at a time and compare geometry invariants, axle loads, and braking screens.",
      "Load both three-wheeler layouts and compare the displayed support polygon without claiming stability certification."
    ], ["Topology-specific hard points exist and remain finite.", "Calculated forces and loads disclose assumptions and evidence gaps.", "Design Health blocks release claims when supplier, tire, brake, or regulatory evidence is absent."], "Outputs are preliminary deterministic studies only - not multibody dynamics, FEA, CFD, fatigue, crash, handling validation, homologation, or roadworthiness evidence."),
    module("exchange", "10", "Professional", "Exchange", "3D import, export, and PDF model packages", "Move bounded reference geometry through browser-safe exchange paths while clearly reporting fidelity and unsupported native formats.", [
      "Import supported browser-decodable mesh and scene formats with explicit unit handling.",
      "Export supported tessellated formats and distinguish them from native parametric CAD exchange.",
      "Create an audit-page PDF with embedded GLB, or pass through a user-supplied U3D/PRC payload for compatible PDF viewers."
    ], [
      "Import a reference model and inspect format, file set, size, triangle count, bounds, and warnings.",
      "Export GLB and STL from a visible scene and verify the chosen unit.",
      "Create a PDF model package and confirm it is not mislabeled as interactive U3D/PRC."
    ], ["External buffers and unsafe paths are rejected.", "Unsupported STEP/IGES/native formats remain unavailable rather than silently degraded.", "Export filenames are fixed and sanitized."], "The public browser app cannot honestly support every 3D format without licensed or server-side translators; native CAD associativity is not reconstructed from meshes."),
    module("mcp", "11", "Advanced", "AI / MCP", "Secure model-neutral AI collaboration", "Connect any compatible AI host through OAuth 2.1 or one expiring personal token, then use deterministic discovery, inspect, preview, receipt review, and confirmed-return workflow.", [
      "Sign in with email and password, verify the account, and create one scoped token per client when OAuth is unavailable.",
      "Call initialize, tools/list, ps3d_guide, ps3d_find_commands, inspect, preview, and only then the receipt-gated apply tool.",
      "Keep project ownership with the caller: the remote server reads only request payloads, stores no project, and writes no browser or filesystem state."
    ], [
      "Prefer a client that follows protected-resource metadata and OAuth 2.1 automatically.",
      "For a header-based client, paste the shown-once bearer token into its secret configuration - never the web password.",
      "Revoke the token after a test and confirm the next request returns an authorization error."
    ], ["The MCP endpoint is HTTPS and returns protected-resource metadata.", "Every token is unique, hashed at rest, scope-limited, expiring, rate-limited, and revocable.", "No raw token, password, project payload, or AI prompt is committed or logged by PS3D."], "MCP compatibility depends on each AI host's transport and authentication support. PS3D tools do not grant autonomous access to an open browser model or private files."),
    module("verification", "12", "Advanced", "Release", "Design health and public-release verification", "Build an evidence trail for a public preview without claiming absolute security, professional-kernel parity, or certification.", [
      "Run schema, geometry, drawing, vehicle, MCP, repository-boundary, dependency, SBOM, source-identity, and production-build gates.",
      "Review accessibility, responsive layout, headers, authentication failure paths, tenant isolation, token revocation, rate limits, and secret handling.",
      "Use GitHub private vulnerability reporting, dependency updates, code scanning, and protected release checks."
    ], [
      "Complete the release checklist from a clean approved CI environment.",
      "Create a test account, create and revoke a token, and run initialize plus tools/list against the live endpoint.",
      "Inspect public source and deployment artifacts for credentials or private paths before announcing the URL."
    ], ["CI is green from a clean checkout.", "The live site sends restrictive security headers and fails closed without environment configuration.", "Known limitations and third-party notices remain visible."], "No application is unhackable. Security requires continuing patching, monitoring, disclosure handling, backups, and incident response after release.")
  ]
};

function module(id: string, number: string, level: LearningLevel, workspace: string, title: string, summary: string, outcomes: readonly string[], practice: readonly string[], verification: readonly string[], boundary: string): LearningModule {
  return { id, number, level, workspace, title, summary, outcomes, practice, verification, boundary };
}
