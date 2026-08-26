import {
  CAD_COMMANDS,
  WORKBENCH_OPERATION_KINDS,
  WORKBENCH_CAPABILITIES,
  WORKBENCH_LIMITS,
  ELECTROMECHANICAL_CATALOG,
  ELECTROMECHANICAL_CATALOG_REVISION,
  analyzeElectromechanicalReadiness,
  analyzeVehicle,
  applyWorkbenchOperation,
  canonicalizeJson,
  defaultElectromechanicalMappings,
  preferredElectromechanicalLayout,
  validateWorkbenchOperation,
  validateWorkbenchProject,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkspaceId
} from "../../workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../../workbench-sketch/src/index.js";
import { createElectricalSchematic } from "../../workbench-electrical/src/index.js";
import { analyzeDesignHealth } from "../../workbench-health/src/index.js";

export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
}

export interface WorkbenchMcpResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface Ps3dAiCommandRecipe {
  readonly id: string;
  readonly workspace: WorkspaceId | "any";
  readonly title: string;
  readonly intent: string;
  readonly phrases: readonly string[];
  readonly previewPolicy: "read-only" | "generic-preview" | "dedicated-electromechanical-preview" | "confirmed-apply";
  readonly mcpTool: string;
  readonly argumentTemplate: Readonly<Record<string, unknown>>;
  readonly note: string;
}

export type Ps3dExperienceLevel = "child" | "beginner" | "engineer" | "advanced" | "phd";

export const PS3D_SUPPORTED_PROTOCOL_REVISIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const PS3D_OPERATION_KINDS = WORKBENCH_OPERATION_KINDS;

const PROJECT_SCHEMA = {
  type: "object",
  description: "A complete caller-owned ps3d-workbench-project/1 value. PS3D never discovers this value from files or a browser session.",
  additionalProperties: false,
  required: ["format", "schemaVersion", "applicationVersion", "id", "name", "revision", "unit", "activeWorkspace", "sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "audit"],
  properties: {
    format: { type: "string" }, schemaVersion: { type: "string" }, applicationVersion: { type: "string" },
    id: { type: "string" }, name: { type: "string" }, revision: { type: "integer", minimum: 0 }, unit: { const: "mm" },
    activeWorkspace: { enum: ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"] },
    sketch: { type: "object" }, part: { type: "object" }, assembly: { type: "object" }, surface: { type: "object" },
    drawing: { type: "object" }, electrical: { type: "object" }, vehicle: { type: "object" }, audit: { type: "array", maxItems: 500 }
  }
} as const;
const OPERATION_SCHEMA = {
  type: "object",
  description: "A revision-checked PS3D workbench operation. Use ps3d_guide and ps3d_find_commands for exact common payload templates; semantic validation remains fail-closed.",
  required: ["operationId", "expectedRevision", "kind"],
  properties: {
    operationId: { type: "string", pattern: "^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$" },
    expectedRevision: { type: "integer", minimum: 0 },
    kind: { type: "string", enum: PS3D_OPERATION_KINDS }
  }
} as const;
const GUIDE_ACKNOWLEDGEMENT_SCHEMA = {
  type: "object",
  description: "Proof that the caller read the current ps3d_guide manifest before requesting a preview or apply.",
  additionalProperties: false,
  required: ["manifestSha256", "understood"],
  properties: {
    manifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    understood: { type: "boolean", const: true }
  }
} as const;
const EXPERIENCE_LEVELS: readonly Ps3dExperienceLevel[] = ["child", "beginner", "engineer", "advanced", "phd"];
const AGENT_HANDSHAKE_SCHEMA = {
  type: "object",
  description: "Stateless PS3D coordination request. It activates no hidden model and stores no session; it returns a deterministic host/PS3D working contract for this request.",
  additionalProperties: false,
  required: ["request", "experienceLevel"],
  properties: {
    request: { type: "string", minLength: 2, maxLength: 500 },
    experienceLevel: { enum: EXPERIENCE_LEVELS },
    workspace: { enum: ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"] },
    clientName: { type: "string", minLength: 1, maxLength: 80 },
    projectRevision: { type: "integer", minimum: 0 },
    proposedTool: { type: "string", minLength: 1, maxLength: 80 },
    proposedRecipeId: { type: "string", minLength: 1, maxLength: 100 }
  }
} as const;
const STRUCTURED_OUTPUT_SCHEMA = { type: "object", additionalProperties: true } as const;

const operationEnvelope = (kind: string, values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  project: "<complete ps3d-workbench-project/1>",
  operation: { operationId: "operation:<caller-unique-id>", expectedRevision: "<current project revision>", kind, ...values },
  guideAcknowledgement: { manifestSha256: "<current ps3d_guide manifestSha256>", understood: true }
});

export const PS3D_AI_COMMAND_RECIPES: readonly Ps3dAiCommandRecipe[] = [
  recipe("guide", "any", "Learn the safe AI workflow", "Discover tools, protocol support, state ownership, and confirmation rules.", ["help", "start", "connect ai", "what can you do"], "read-only", "ps3d_guide", {}, "Call this first from a new host."),
  recipe("coordinate", "any", "Activate the PS3D collaboration agent", "Configure a stateless two-agent working contract, adapt explanations to the user, match bounded commands, and correct an AI host's proposed tool or recipe before execution.", ["activate agent", "collaborate", "coordinate ai", "check command", "validate plan", "beginner help", "phd mode"], "read-only", "ps3d_agent_handshake", { request: "<user engineering goal>", experienceLevel: "engineer", workspace: "<optional workspace>" }, "Call after ps3d_guide and again whenever the goal or proposed tool is unclear."),
  recipe("inspect", "any", "Understand the current project", "Validate and summarize a caller-supplied project without changing it.", ["inspect project", "understand model", "summarize cad", "read project"], "read-only", "ps3d_inspect_project", { project: "<complete ps3d-workbench-project/1>" }, "The open browser project is not exposed automatically."),
  recipe("design-health", "any", "Review design health and dependencies", "Analyze every workspace, actual associativity, rebuild order, evidence gaps, and release boundaries without changing the project.", ["design health", "rebuild all", "dependency", "associativity", "quality check", "model readiness", "professional review"], "read-only", "ps3d_design_health", { project: "<complete ps3d-workbench-project/1>" }, "Findings are deterministic assistance, not a manufacturing or regulatory release."),
  recipe("sketch-geometry", "sketch", "Create bounded sketch geometry", "Prepare a revision-checked line, rectangle, circle, or three-point arc entity on the supported datum plane.", ["draw line", "create rectangle", "make circle", "three point arc", "sketch geometry", "add sketch entity"], "generic-preview", "ps3d_preview_operation", operationEnvelope("add-sketch-entity", { entity: { id: "sketch-entity:<caller-unique-id>", kind: "line", start: [0, 0], end: [40, 0], construction: false, visible: true } }), "Use a unique stable entity ID, millimetres, and only the supported entity fields; preview before apply."),
  recipe("sketch-dimension", "sketch", "Set a selected sketch dimension", "Prepare a direct length, width, height, or radius edit for one existing sketch entity ID.", ["sketch dimension", "dimension line", "dimension circle", "set radius", "edit sketch size", "direct dimension"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-sketch-dimension", { entityId: "<existing sketch entity ID from ps3d_inspect_project>", dimension: "length", valueMm: 40 }), "The entity and dimension type must be compatible; use the exact inspected ID and retry only after resolving diagnostics."),
  recipe("sketch-constraint", "sketch", "Constrain selected sketch entities", "Prepare a supported horizontal, vertical, parallel, perpendicular, tangent, collinear, midpoint, symmetry, coincident, concentric, equal, radius, distance, or fixed constraint.", ["sketch constraint", "make horizontal", "make tangent", "make concentric", "coincident points", "fix sketch"], "generic-preview", "ps3d_preview_operation", operationEnvelope("add-sketch-constraint", { constraint: { id: "sketch-constraint:<caller-unique-id>", kind: "horizontal", entityIds: ["<existing sketch entity ID>"] } }), "Inspect first, supply exactly the required compatible entity IDs, and treat constraint-conflict diagnostics as a correction request."),
  recipe("part-parameter", "part", "Change a part parameter", "Prepare a revision-checked width, height, thickness, bore, edge, pattern, or revolve change.", ["resize part", "change thickness", "change hole", "make bore", "part dimension"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-part-parameter", { parameter: "thicknessMm", value: 12 }), "Preview first, show the candidate project, then request confirmation."),
  recipe("assembly-template", "assembly", "Create an assembly planning template", "Prepare a cargo-container or BESS planning-frame template operation.", ["cargo container", "bess container", "assembly template", "equipment layout"], "generic-preview", "ps3d_preview_operation", operationEnvelope("apply-assembly-template", { template: "cargo-20ft" }), "Templates are planning geometry, not certified construction models."),
  recipe("assembly-insert", "assembly", "Insert one assembly component", "Prepare one bounded component instance with explicit shape, transform, size, visibility, grounding, color, and explosion direction.", ["insert component", "add component", "place part", "assembly component", "add to assembly"], "generic-preview", "ps3d_preview_operation", operationEnvelope("add-assembly-component", { component: { id: "component:<caller-unique-id>", name: "New component", shape: "box", grounded: false, visible: true, color: "#b8bdc5", translationMm: [0, 0, 0], rotationDeg: [0, 0, 0], sizeMm: [40, 30, 20], explosionDirection: [1, 0, 0] } }), "Use a unique component ID and confirm units and placement before apply."),
  recipe("assembly-insert-group", "assembly", "Insert a grouped Master Cart item", "Prepare a bounded array of independently generated component instances for a multi-body catalog item.", ["master cart", "insert fastener", "add bearing", "add sprocket", "grouped component", "add components"], "generic-preview", "ps3d_preview_operation", operationEnvelope("add-assembly-components", { components: "<non-empty bounded array of validated ComponentInstance values generated from the selected local template>" }), "Every component requires a unique stable ID; PS3D validates the complete group atomically and never fetches supplier geometry through MCP."),
  recipe("assembly-mate", "assembly", "Mate selected assembly components", "Prepare a fixed, coincident-origin, or aligned-axis mate between existing component IDs.", ["assembly mate", "mate components", "align parts", "concentric mate", "fix component", "assembly joint"], "generic-preview", "ps3d_preview_operation", operationEnvelope("add-assembly-mate", { mate: { id: "mate:<caller-unique-id>", name: "Aligned-axis mate", kind: "aligned-axis", componentIds: ["<first existing component ID>", "<second existing component ID>"], axis: "z", status: "satisfied" } }), "Inspect first; use existing visible component IDs and resolve broken-reference, redundancy, or conflict diagnostics before applying."),
  recipe("assembly-explode", "assembly", "Set an exploded assembly view", "Prepare a deterministic assembly explode-distance change.", ["explode assembly", "separate components", "assembly view"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-assembly-explode", { valueMm: 120 }), "The returned project is a detached copy until the user imports or opens it."),
  recipe("surface-shape", "surface", "Change a surface study", "Prepare a bounded surface mode or crown/twist/segment parameter change.", ["surface", "loft", "bezier", "crown", "twist", "surfacing"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-surface-parameter", { parameter: "crownMm", value: 24 }), "This is a preview surface study, not an exact Class-A/NURBS kernel result."),
  recipe("drawing-standard", "drawing", "Set professional drawing conventions", "Prepare a sheet, projection, scale, drafting-standard, view, or display-style change.", ["engineering drawing", "drawing standard", "sheet", "projection", "scale", "iso drawing"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-drawing-drafting-standard", { standard: "ISO" }), "Review title-block and projection disclosures in the returned drawing."),
  recipe("drawing-tolerance", "drawing", "Set drawing tolerances and GD&T", "Prepare general linear/angular tolerances or bounded GD&T values.", ["tolerance", "gdt", "gd&t", "flatness", "perpendicularity", "position tolerance"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-drawing-general-tolerance", { linearMm: 0.2, angularDeg: 0.5 }), "Values are user engineering inputs; PS3D does not certify fitness for manufacture."),
  recipe("electrical-template", "electrical", "Create an electrical schematic template", "Prepare a bounded motor-starter, BESS auxiliary, or other supported electrical template.", ["electrical circuit", "schematic", "motor starter", "bess auxiliary", "circuit diagram"], "generic-preview", "ps3d_preview_operation", operationEnvelope("apply-electrical-template", { template: "motor-starter" }), "Run ERC and review the schematic before physical realization."),
  recipe("electrical-panel", "electrical", "Preview a wired mounting plate", "Resolve a supplied schematic into generic panel envelopes, rails, ducts, terminal links, and unsized routes.", ["circuit to 3d", "wired mounting plate", "electrical panel", "din rail", "panel wiring"], "dedicated-electromechanical-preview", "ps3d_preview_electromechanical", { project: "<complete ps3d-workbench-project/1>", guideAcknowledgement: { manifestSha256: "<current ps3d_guide manifestSha256>", understood: true } }, "This dedicated preview cannot be replaced by the generic operation tool."),
  recipe("vehicle-template", "vehicle", "Create a vehicle study template", "Prepare a motorcycle, scooter, EV two-wheeler, or three-wheeler study template.", ["bike", "motorcycle", "scooter", "ev bike", "three wheeler", "vehicle skeleton"], "generic-preview", "ps3d_preview_operation", operationEnvelope("apply-vehicle-template", { template: "ice-road-motorcycle" }), "Vehicle outputs remain preliminary engineering studies only."),
  recipe("vehicle-parameter", "vehicle", "Change vehicle hard points or parameters", "Prepare a wheelbase, trail, rake, mass, CG, suspension, tire, brake, or powertrain parameter change.", ["wheelbase", "rake", "trail", "cg", "hard point", "suspension", "brake", "spring", "vehicle geometry"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-vehicle-parameter", { parameter: "wheelbaseM", value: 1.42 }), "Supplier tire/brake evidence may be invalidated by parameter changes."),
  recipe("vehicle-state", "vehicle", "Set a vehicle simulation state", "Prepare full-droop, design-ride, or full-bump deterministic state selection.", ["full bump", "no bump", "design ride", "vehicle state", "suspension travel"], "generic-preview", "ps3d_preview_operation", operationEnvelope("set-vehicle-simulation-state", { state: "design-ride" }), "This is not multibody dynamics, roadworthiness, or homologation proof."),
  recipe("vehicle-analysis", "vehicle", "Analyze a vehicle study", "Run read-only preliminary geometry, suspension, axle-load, braking, road-load, and support-polygon calculations.", ["analyze vehicle", "vehicle calculation", "axle load", "road load", "brake calculation", "support polygon"], "read-only", "ps3d_analyze_vehicle", { project: "<complete ps3d-workbench-project/1>" }, "All qualification and evidence boundaries remain in the structured result."),
  recipe("apply", "any", "Apply an approved preview", "Return a new project only for the same project, operation, receipt, and explicit confirmation.", ["apply change", "confirm preview", "approve operation", "return new project"], "confirmed-apply", "ps3d_apply_preview", { project: "<same project used for preview>", operation: "<same canonical operation>", receipt: "<64-character preview receipt>", confirmed: true, guideAcknowledgement: { manifestSha256: "<current ps3d_guide manifestSha256>", understood: true } }, "confirmed:true is a host assertion, not cryptographic proof of human approval.")
] as const;

export const PS3D_MCP_INSTRUCTIONS = "Start with ps3d_guide and read its complete machine-readable contract. Then call ps3d_agent_handshake with the user's request and experience level; this stateless coordinator assigns the host-AI/PS3D roles, identifies ambiguity, and returns corrections before execution. Copy the guide manifestSha256 into guideAcknowledgement with understood:true for every preview and apply call; stale or missing acknowledgements are rejected. The caller supplies the complete project; PS3D never discovers browser state or files. Use ps3d_find_commands for deterministic intent recipes, ps3d_design_health for cross-workspace dependencies and readiness, inspect before proposing a change, preview every write intent, show the exact candidate and receipt, obtain user confirmation for that revision, and only then call ps3d_apply_preview. Electromechanical realization must use its dedicated preview tool. Treat every structured diagnostic as feedback: correct the named command, ID, selection, field, unit, or revision and revalidate instead of guessing. The server returns data only and never writes external state.";

export const WORKBENCH_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "ps3d_guide",
    title: "PS3D AI collaboration guide",
    description: "Return the model-neutral connection contract, supported MCP revisions, command namespaces, safe workflow, limitations, and starter prompts.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D AI collaboration guide", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_agent_handshake",
    title: "PS3D collaboration agent handshake",
    description: "Activate a stateless PS3D coordination pass for one user goal. It adapts communication depth, matches bounded recipes, checks proposed stable IDs, and returns exact correction and next-step feedback without executing CAD changes.",
    inputSchema: AGENT_HANDSHAKE_SCHEMA,
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D collaboration agent handshake", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_find_commands",
    title: "Find PS3D command recipes",
    description: "Deterministically match a plain-language goal to bounded PS3D tool and operation templates. This read-only lookup never executes the matched command.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 160 },
        workspace: { enum: ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"] },
        limit: { type: "integer", minimum: 1, maximum: 12, default: 6 }
      }
    },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "Find PS3D command recipes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_capabilities",
    title: "PS3D capability matrix",
    description: "List qualified, preview, and unavailable PS3D CAD capabilities. This call is read-only and has no external side effects.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D capability matrix", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_inspect_project",
    title: "Inspect PS3D project",
    description: "Validate and summarize a supplied PS3D workbench project without modifying it or reading any file.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project"], properties: { project: PROJECT_SCHEMA } },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "Inspect PS3D project", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_design_health",
    title: "PS3D design health",
    description: "Analyze every CAD workspace, actual associative and detached links, deterministic rebuild order, engineering findings, and release boundaries without modifying state.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project"], properties: { project: PROJECT_SCHEMA } },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D design health", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_analyze_vehicle",
    title: "PS3D vehicle analysis",
    description: "Validate the project and return deterministic preliminary vehicle geometry, suspension, axle-load, brake, road-load, powertrain, lean or three-wheel support-polygon calculations. No regulatory, construction, roadworthiness, or safety approval is produced.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project"], properties: { project: PROJECT_SCHEMA } },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D vehicle analysis", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_electromechanical_catalog",
    title: "PS3D electromechanical catalog",
    description: "List the bounded local panel-scale generic package catalog and rotation-aware terminal coordinates. No manufacturer accuracy, network lookup, or external asset discovery is implied.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "PS3D electromechanical catalog", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_preview_electromechanical",
    title: "Preview wired mounting plate",
    description: "Resolve the supplied schematic into a deterministic mounting plate with generic panel packages, DIN rails, wiring ducts, bonding hardware, terminal trace, and unsized conductors. Returns a review operation plus receipt without applying it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project", "guideAcknowledgement"], properties: { project: PROJECT_SCHEMA, guideAcknowledgement: GUIDE_ACKNOWLEDGEMENT_SCHEMA } },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "Preview wired mounting plate", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_preview_operation",
    title: "Preview PS3D operation",
    description: "Validate a proposed project operation and return its diff summary and cryptographic receipt without mutating anything.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project", "operation", "guideAcknowledgement"], properties: { project: PROJECT_SCHEMA, operation: OPERATION_SCHEMA, guideAcknowledgement: GUIDE_ACKNOWLEDGEMENT_SCHEMA } },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "Preview PS3D operation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ps3d_apply_preview",
    title: "Apply confirmed PS3D preview",
    description: "Return a new project only when a matching preview receipt and explicit confirmation are supplied. The server writes no file or external state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "operation", "receipt", "confirmed", "guideAcknowledgement"],
      properties: {
        project: PROJECT_SCHEMA,
        operation: OPERATION_SCHEMA,
        receipt: { type: "string", pattern: "^[a-f0-9]{64}$" },
        confirmed: { type: "boolean", const: true },
        guideAcknowledgement: GUIDE_ACKNOWLEDGEMENT_SCHEMA
      }
    },
    outputSchema: STRUCTURED_OUTPUT_SCHEMA,
    annotations: { title: "Apply confirmed PS3D preview", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

export async function handleWorkbenchMcpTool(name: string, args: unknown): Promise<WorkbenchMcpResult> {
  if (encodedSize(args) > WORKBENCH_LIMITS.maxJsonBytes) return error("RESOURCE_LIMIT", "The MCP tool input exceeds the 1 MB limit.");
  if (name === "ps3d_guide") {
    if (!isRecord(args) || Object.keys(args).length !== 0) return error("INVALID_PARAMS", "ps3d_guide accepts no arguments.");
    const guide = await createPs3dCollaborationGuide();
    return success("PS3D AI collaboration guide ready. Connect, discover, inspect, preview, confirm, then apply or import the returned project copy.", guide);
  }
  if (name === "ps3d_agent_handshake") {
    if (!isRecord(args) || !exactOptionalKeys(args, ["request", "experienceLevel"], ["workspace", "clientName", "projectRevision", "proposedTool", "proposedRecipeId"])) {
      return error("INVALID_PARAMS", "Expected request and experienceLevel plus optional workspace, clientName, projectRevision, proposedTool, and proposedRecipeId.");
    }
    if (typeof args.request !== "string" || args.request.trim().length < 2 || args.request.length > 500) return error("INVALID_PARAMS", "request must contain 2 to 500 characters.");
    if (!isExperienceLevel(args.experienceLevel)) return error("INVALID_PARAMS", "experienceLevel must be child, beginner, engineer, advanced, or phd.");
    if (args.workspace !== undefined && !isWorkspace(args.workspace)) return error("INVALID_PARAMS", "workspace is not a supported PS3D workspace.");
    if (args.clientName !== undefined && (typeof args.clientName !== "string" || args.clientName.trim().length < 1 || args.clientName.length > 80)) return error("INVALID_PARAMS", "clientName must contain 1 to 80 characters.");
    if (args.projectRevision !== undefined && (typeof args.projectRevision !== "number" || !Number.isInteger(args.projectRevision) || args.projectRevision < 0)) return error("INVALID_PARAMS", "projectRevision must be a non-negative integer.");
    if (args.proposedTool !== undefined && (typeof args.proposedTool !== "string" || args.proposedTool.length < 1 || args.proposedTool.length > 80)) return error("INVALID_PARAMS", "proposedTool must contain 1 to 80 characters.");
    if (args.proposedRecipeId !== undefined && (typeof args.proposedRecipeId !== "string" || args.proposedRecipeId.length < 1 || args.proposedRecipeId.length > 100)) return error("INVALID_PARAMS", "proposedRecipeId must contain 1 to 100 characters.");
    const matches = findAiCommandRecipes(args.request, args.workspace as WorkspaceId | undefined, 6);
    const proposedTool = typeof args.proposedTool === "string" ? WORKBENCH_MCP_TOOLS.find((tool) => tool.name === args.proposedTool) : undefined;
    const proposedRecipe = typeof args.proposedRecipeId === "string" ? PS3D_AI_COMMAND_RECIPES.find((recipeEntry) => recipeEntry.id === args.proposedRecipeId) : undefined;
    const feedback: Array<Readonly<Record<string, unknown>>> = [];
    if (typeof args.proposedTool === "string" && proposedTool === undefined) feedback.push({ code: "UNKNOWN_MCP_TOOL", severity: "error", message: `${args.proposedTool} is not a registered PS3D MCP tool.`, recovery: "Use one exact tool name returned by tools/list or the top bounded recipe below." });
    if (typeof args.proposedRecipeId === "string" && proposedRecipe === undefined) feedback.push({ code: "UNKNOWN_RECIPE_ID", severity: "error", message: `${args.proposedRecipeId} is not a registered PS3D AI recipe ID.`, recovery: "Use one exact ai-command:* ID returned by ps3d_find_commands." });
    const top = matches[0];
    const second = matches[1];
    const topScore = typeof top?.["score"] === "number" ? top["score"] : 0;
    const secondScore = typeof second?.["score"] === "number" ? second["score"] : 0;
    const ambiguous = top !== undefined && second !== undefined && topScore - secondScore < 10;
    if (matches.length === 0) feedback.push({ code: "NO_BOUNDED_RECIPE", severity: "question", message: "The goal does not match a bounded PS3D recipe strongly enough to propose execution.", recovery: "Clarify the target workspace, selected object, desired result, units, and whether the request is inspection or a change." });
    if (ambiguous) feedback.push({ code: "AMBIGUOUS_INTENT", severity: "question", message: "More than one bounded recipe has a similar deterministic match score.", recovery: "Ask the user to choose the intended result before preparing an operation." });
    if (proposedTool !== undefined && top !== undefined && proposedTool.name !== top["mcpTool"]) feedback.push({ code: "PROPOSED_TOOL_MISMATCH", severity: "warning", message: `${proposedTool.name} does not match the highest-scoring bounded recipe ${String(top["id"])}.`, recovery: `Review the goal and use ${String(top["mcpTool"])} only if the user confirms that recipe.` });
    if (proposedRecipe !== undefined && top !== undefined && proposedRecipe.id !== top["id"]) feedback.push({ code: "PROPOSED_RECIPE_MISMATCH", severity: "warning", message: `${proposedRecipe.id} is not the highest-scoring bounded recipe for this goal.`, recovery: `Compare it with ${String(top["id"])} and ask for clarification if their outcomes differ.` });
    const guide = await createPs3dCollaborationGuide();
    const hasError = feedback.some((item) => item["severity"] === "error");
    const needsQuestion = feedback.some((item) => item["severity"] === "question");
    const status = hasError ? "needs-correction" : needsQuestion ? "needs-clarification" : feedback.length > 0 ? "review-warning" : "ready-to-inspect";
    return success(`PS3D collaboration agent ${status}; no CAD command was executed.`, {
      schema: "ps3d-agent-handshake/1",
      activation: {
        state: "active-for-this-response",
        persistentSession: false,
        hiddenModel: false,
        coordinator: "deterministic-ps3d-contract-validator",
        host: args.clientName ?? "unspecified MCP host"
      },
      audience: audienceProfile(args.experienceLevel),
      request: args.request.trim(),
      workspace: args.workspace ?? null,
      projectRevision: args.projectRevision ?? null,
      status,
      roles: {
        hostAi: ["Understand the user's engineering intent", "Ask the human when intent or approval is ambiguous", "Explain assumptions at the selected experience level", "Supply only caller-authorized project data"],
        ps3dAgent: ["Match only registered tools, recipes, operations, and stable IDs", "Validate project and operation payloads fail-closed", "Return structured diagnostics and exact recovery actions", "Create deterministic preview receipts without external writes"],
        sharedRule: "Both sides must inspect feedback and correct the plan before retrying; neither side may invent geometry success, IDs, selections, approvals, or live-browser state."
      },
      intent: { matching: "deterministic-token-and-phrase", ambiguous, matches },
      proposal: {
        proposedTool: args.proposedTool ?? null,
        toolRegistered: args.proposedTool === undefined ? null : proposedTool !== undefined,
        proposedRecipeId: args.proposedRecipeId ?? null,
        recipeRegistered: args.proposedRecipeId === undefined ? null : proposedRecipe !== undefined,
        executionPerformed: false
      },
      feedback,
      recoveryContract: [
        { failure: "unknown command, tool, recipe, or operation kind", action: "Refresh tools/list and ps3d_guide; use the exact returned stable name." },
        { failure: "missing or wrong selection ID", action: "Call ps3d_inspect_project, refresh the current project revision, and choose an ID that exists in that project." },
        { failure: "sketch, mate, or geometry precondition", action: "Read every diagnostic and recovery field; repair the named plane, entity, component, mate reference, constraint, or closed profile before retrying." },
        { failure: "stale revision or receipt mismatch", action: "Discard the old preview, inspect the latest project, create a new operation for that revision, and preview again." },
        { failure: "unsupported exact-kernel result", action: "Do not approximate it as completed; report the unavailable boundary and propose only a truth-labeled preview or supported alternative." }
      ],
      requiredSequence: ["ps3d_guide", "ps3d_agent_handshake", "ps3d_inspect_project", "ps3d_design_health", "ps3d_find_commands", "required preview tool", "human confirmation", "ps3d_apply_preview or explicit import"],
      guide: { schema: guide["schema"], manifestSha256: guide["manifestSha256"] },
      nextAction: status === "ready-to-inspect" ? "Supply the complete caller-owned project to ps3d_inspect_project, then validate the chosen bounded recipe." : "Resolve every feedback item, then call ps3d_agent_handshake again with the corrected goal or proposed stable IDs."
    });
  }
  if (name === "ps3d_find_commands") {
    if (!isRecord(args) || !exactOptionalKeys(args, ["query"], ["workspace", "limit"])) return error("INVALID_PARAMS", "Expected query plus optional workspace and limit arguments.");
    if (typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 160) return error("INVALID_PARAMS", "query must contain 2 to 160 characters.");
    if (args.workspace !== undefined && !isWorkspace(args.workspace)) return error("INVALID_PARAMS", "workspace is not a supported PS3D workspace.");
    if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 12)) return error("INVALID_PARAMS", "limit must be an integer from 1 to 12.");
    const matches = findAiCommandRecipes(args.query, args.workspace as WorkspaceId | undefined, (args.limit as number | undefined) ?? 6);
    return success(matches.length === 0 ? "No bounded command recipe matched. Refine the goal or call ps3d_guide." : `Found ${matches.length} bounded command recipe${matches.length === 1 ? "" : "s"}; nothing was executed.`, {
      schema: "ps3d-command-search/1",
      query: args.query.trim(),
      workspace: args.workspace ?? null,
      executionPerformed: false,
      matching: "deterministic-token-and-phrase",
      matches,
      nextStep: matches.length === 0 ? "Call ps3d_guide or use a more specific engineering term." : "Choose a recipe, fill only its explicit placeholders, and follow its preview policy."
    });
  }
  if (name === "ps3d_capabilities") {
    if (!isRecord(args) || Object.keys(args).length !== 0) return error("INVALID_PARAMS", "ps3d_capabilities accepts no arguments.");
    return success(`PS3D exposes ${WORKBENCH_CAPABILITIES.length} truth-labeled capabilities; unavailable entries are never callable implementations.`, {
      schema: "ps3d-capabilities/1",
      capabilities: WORKBENCH_CAPABILITIES,
      collaborationGuideTool: "ps3d_guide",
      commandFinderTool: "ps3d_find_commands",
      operationKinds: PS3D_OPERATION_KINDS
    });
  }
  if (name === "ps3d_electromechanical_catalog") {
    if (!isRecord(args) || Object.keys(args).length !== 0) return error("INVALID_PARAMS", "ps3d_electromechanical_catalog accepts no arguments.");
    return success(`Listed ${ELECTROMECHANICAL_CATALOG.length} original panel-scale generic package definitions.`, {
      schema: "ps3d-electromechanical-catalog/1",
      catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
      classification: "generic-envelope",
      constructionReady: false,
      parts: ELECTROMECHANICAL_CATALOG
    });
  }
  if (!isRecord(args)) return error("INVALID_PARAMS", "Tool arguments must be an object.");
  if (name === "ps3d_inspect_project") {
    if (!exactKeys(args, ["project"])) return error("INVALID_PARAMS", "Expected only the project argument.");
    const project = validateWorkbenchProject(args.project);
    if (!project.ok) return diagnostics(project.diagnostics);
    const summary = projectSummary(project.value);
    return success(`Validated ${project.value.name} at revision ${project.value.revision}.`, summary);
  }
  if (name === "ps3d_design_health") {
    if (!exactKeys(args, ["project"])) return error("INVALID_PARAMS", "Expected only the project argument.");
    const report = analyzeDesignHealth(args.project);
    if (!report.ok) return diagnostics(report.diagnostics);
    return success(`Design health ${report.value.overallStatus} at ${report.value.score}/100 with ${report.value.errors} blocking and ${report.value.warnings} review finding(s).`, { ...report.value });
  }
  if (name === "ps3d_analyze_vehicle") {
    if (!exactKeys(args, ["project"])) return error("INVALID_PARAMS", "Expected only the project argument.");
    const project = validateWorkbenchProject(args.project);
    if (!project.ok) return diagnostics(project.diagnostics);
    const analysis = analyzeVehicle(project.value.vehicle);
    return success(`Analyzed ${project.value.vehicle.name}; ${analysis.errors.length} blocking and ${analysis.warnings.length} review finding(s).`, {
      schema: "ps3d-vehicle-mcp-analysis/2",
      template: project.value.vehicle.template,
      state: project.value.vehicle.state,
      inputStatus: project.value.vehicle.inputStatus,
      tireDataStatus: project.value.vehicle.tireDataStatus,
      brakeDataStatus: project.value.vehicle.brakeDataStatus,
      regulatoryResult: false,
      constructionReady: false,
      roadworthinessApproved: false,
      analysis
    });
  }
  if (name === "ps3d_preview_operation") {
    if (!exactKeys(args, ["project", "operation", "guideAcknowledgement"])) return error("INSTRUCTION_ACKNOWLEDGEMENT_REQUIRED", "Read ps3d_guide and provide project, operation, and its current guideAcknowledgement.");
    const guideError = await requireGuideAcknowledgement(args.guideAcknowledgement);
    if (guideError !== undefined) return guideError;
    if (isRecord(args.operation) && args.operation.kind === "generate-electromechanical-realization") {
      return error("DEDICATED_PREVIEW_REQUIRED", "Use ps3d_preview_electromechanical so the exact replacement candidate, ERC issues, generic-catalog boundary, and confirmation disclosure are returned together.");
    }
    return preview(args.project, args.operation);
  }
  if (name === "ps3d_preview_electromechanical") {
    if (!exactKeys(args, ["project", "guideAcknowledgement"])) return error("INSTRUCTION_ACKNOWLEDGEMENT_REQUIRED", "Read ps3d_guide and provide the project plus its current guideAcknowledgement.");
    const guideError = await requireGuideAcknowledgement(args.guideAcknowledgement);
    if (guideError !== undefined) return guideError;
    const project = validateWorkbenchProject(args.project);
    if (!project.ok) return diagnostics(project.diagnostics);
    const layoutPreset = preferredElectromechanicalLayout(project.value.electrical);
    const mappings = defaultElectromechanicalMappings(project.value.electrical);
    const electricalArtifact = createElectricalSchematic(project.value.electrical);
    if (electricalArtifact.erc.errors > 0) return error("ERC_BLOCKED", electricalArtifact.erc.issues.find((issue) => issue.severity === "error")?.message ?? "Electrical rule-check errors block realization.");
    const readiness = analyzeElectromechanicalReadiness(project.value.electrical, layoutPreset, mappings);
    if (readiness.status === "blocked") return error("REALIZATION_BLOCKED", readiness.blockingErrors[0] ?? "The electromechanical mapping is incomplete.");
    const operation: WorkbenchOperation = {
      kind: "generate-electromechanical-realization",
      operationId: `operation:mcp-em-r${project.value.revision}`,
      expectedRevision: project.value.revision,
      catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
      layoutPreset,
      mappings,
      replaceMode: "replace-assembly"
    };
    const prepared = await preparePreview(project.value, operation);
    if ("isError" in prepared && prepared.isError === true) return prepared;
    const candidate = (prepared.structuredContent["nextProject"] as WorkbenchProject).assembly;
    return success(`Prepared a ${mappings.length}-device wired mounting-plate preview; no project or live session was modified.`, {
      schema: "ps3d-electromechanical-preview/1",
      operation,
      receipt: prepared.structuredContent["receipt"],
      receiptInfo: prepared.structuredContent["receiptInfo"],
      summary: prepared.structuredContent["summary"],
      exactRetry: prepared.structuredContent["exactRetry"],
      baseProjectRef: prepared.structuredContent["baseProjectRef"],
      candidateProjectRef: prepared.structuredContent["candidateProjectRef"],
      readiness,
      erc: electricalArtifact.erc,
      replacementScope: {
        removedAssemblyId: project.value.assembly.id,
        removedComponentIds: project.value.assembly.components.map((component) => component.id),
        removedMateIds: project.value.assembly.mates.map((mate) => mate.id),
        removedRouteIds: project.value.assembly.electricalRoutes?.map((route) => route.id) ?? [],
        removedDeviceLinks: project.value.assembly.electricalLinks ?? [],
        removedSourceRecord: project.value.assembly.electromechanicalSource ?? null,
        removedAssembly: project.value.assembly,
        candidate: {
          assemblyId: candidate.id,
          name: candidate.name,
          components: candidate.components.length,
          mates: candidate.mates.length,
          linkedDevices: candidate.electricalLinks?.length ?? 0,
          installationHardware: candidate.components.length - (candidate.electricalLinks?.length ?? 0),
          conductorPaths: candidate.electricalRoutes?.length ?? 0,
          routeGuides: candidate.electricalRoutes?.length ?? 0,
          nominalEnvelopeMm: candidate.nominalEnvelopeMm ?? null,
          designStatus: candidate.designStatus ?? null
        },
        candidateAssembly: candidate
      },
      confirmationBoundary: "Apply only through ps3d_apply_preview after the host has shown the removed IDs, full mounting-plate candidate, every ERC issue, unsized-conductor limitation, and generic non-construction boundary. confirmed:true is a host assertion, not cryptographic proof of human approval."
    });
  }
  if (name === "ps3d_apply_preview") {
    if (!exactKeys(args, ["project", "operation", "receipt", "confirmed", "guideAcknowledgement"])) return error("INSTRUCTION_ACKNOWLEDGEMENT_REQUIRED", "Read ps3d_guide and provide project, operation, receipt, confirmation, and its current guideAcknowledgement.");
    const guideError = await requireGuideAcknowledgement(args.guideAcknowledgement);
    if (guideError !== undefined) return guideError;
    if (args.confirmed !== true) return error("CONFIRMATION_REQUIRED", "The apply tool requires confirmed: true after the preview is shown to the user.");
    if (typeof args.receipt !== "string" || !/^[a-f0-9]{64}$/u.test(args.receipt)) return error("INVALID_PARAMS", "The preview receipt must be a 64-character lowercase SHA-256 value.");
    const prepared = await preparePreview(args.project, args.operation);
    if ("isError" in prepared && prepared.isError === true) return prepared;
    if (prepared.structuredContent["receipt"] !== args.receipt) return error("PREVIEW_RECEIPT_MISMATCH", "The receipt does not match this project revision and operation.");
    const nextProject = prepared.structuredContent["nextProject"] as WorkbenchProject;
    return success(`Applied confirmed preview; returned revision ${nextProject.revision} without writing external state.`, {
      schema: "ps3d-applied-operation/1",
      project: nextProject,
      receipt: args.receipt,
      receiptInfo: prepared.structuredContent["receiptInfo"],
      summary: prepared.structuredContent["summary"],
      changedIds: prepared.structuredContent["changedIds"],
      exactRetry: prepared.structuredContent["exactRetry"],
      projectRef: prepared.structuredContent["candidateProjectRef"]
    });
  }
  return error("METHOD_NOT_FOUND", `Unknown PS3D MCP tool: ${name}`);
}

async function preview(projectInput: unknown, operationInput: unknown): Promise<WorkbenchMcpResult> {
  const prepared = await preparePreview(projectInput, operationInput);
  if ("isError" in prepared && prepared.isError === true) return prepared;
  const nextProject = prepared.structuredContent["nextProject"] as WorkbenchProject;
  return success(`Preview ready: ${String(prepared.structuredContent["summary"])} No state was modified.`, {
    schema: "ps3d-operation-preview/1",
    receipt: prepared.structuredContent["receipt"],
    receiptInfo: prepared.structuredContent["receiptInfo"],
    baseRevision: (prepared.structuredContent["baseProjectRef"] as Readonly<Record<string, unknown>>)["revision"],
    nextRevision: nextProject.revision,
    exactRetry: prepared.structuredContent["exactRetry"],
    summary: prepared.structuredContent["summary"],
    changedIds: prepared.structuredContent["changedIds"],
    baseProjectRef: prepared.structuredContent["baseProjectRef"],
    candidateProjectRef: prepared.structuredContent["candidateProjectRef"],
    candidateProject: nextProject,
    confirmationBoundary: "The receipt is an unkeyed deterministic integrity checksum, not a signature or proof of human approval. The host must show the candidate project and bind confirmation to this exact base revision before apply."
  });
}

async function requireGuideAcknowledgement(value: unknown): Promise<WorkbenchMcpResult | undefined> {
  if (!isRecord(value) || !exactKeys(value, ["manifestSha256", "understood"]) || value.understood !== true || typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifestSha256)) {
    return error("INSTRUCTION_ACKNOWLEDGEMENT_REQUIRED", "Call ps3d_guide, read its complete contract, then provide { manifestSha256, understood: true }.");
  }
  const guide = await createPs3dCollaborationGuide();
  if (value.manifestSha256 !== guide.manifestSha256) {
    return error("STALE_INSTRUCTION_ACKNOWLEDGEMENT", "The PS3D collaboration guide changed. Read ps3d_guide again and acknowledge its new manifestSha256.");
  }
  return undefined;
}

async function preparePreview(projectInput: unknown, operationInput: unknown): Promise<WorkbenchMcpResult> {
  const project = validateWorkbenchProject(projectInput);
  if (!project.ok) return diagnostics(project.diagnostics);
  const operation = validateWorkbenchOperation(operationInput);
  if (!operation.ok) return diagnostics(operation.diagnostics);
  const applied = applyWorkbenchOperation(project.value, operation.value);
  if (!applied.ok) return diagnostics(applied.diagnostics);
  const receipt = await previewReceipt(project.value, operation.value, applied.value.project);
  const [baseProjectRef, candidateProjectRef, operationSha256] = await Promise.all([
    projectReference(project.value),
    projectReference(applied.value.project),
    sha256Hex(canonicalizeJson(operation.value))
  ]);
  return success("Prepared preview receipt.", {
    receipt,
    receiptInfo: {
      schema: "ps3d-preview-receipt-info/1",
      algorithm: "sha-256",
      signed: false,
      approvalProof: false,
      domain: operation.value.kind === "generate-electromechanical-realization" ? "ps3d-electromechanical-disclosure-receipt/1" : "ps3d-operation-preview-receipt/1",
      base: baseProjectRef,
      operationSha256,
      candidate: candidateProjectRef,
      disposition: applied.value.exactRetry ? "exact-retry" : "previewed",
      value: receipt
    },
    summary: applied.value.summary,
    changedIds: applied.value.changedIds,
    nextProject: applied.value.project,
    exactRetry: applied.value.exactRetry,
    baseProjectRef,
    candidateProjectRef
  });
}

export async function previewReceipt(project: WorkbenchProject, operation: WorkbenchOperation, nextProject: WorkbenchProject): Promise<string> {
  return sha256Hex(canonicalizeJson({
    domain: operation.kind === "generate-electromechanical-realization" ? "ps3d-electromechanical-disclosure-receipt/1" : "ps3d-operation-preview-receipt/1",
    projectId: project.id,
    baseRevision: project.revision,
    operation,
    nextProject
  }));
}

export async function projectReference(project: WorkbenchProject): Promise<Readonly<Record<string, unknown>>> {
  return {
    schema: "ps3d-project-ref/1",
    projectId: project.id,
    revision: project.revision,
    projectSha256: await sha256Hex(canonicalizeJson(project))
  };
}

export function projectSummary(project: WorkbenchProject): Readonly<Record<string, unknown>> {
  const analysis = analyzeWorkbenchSketch(project.sketch);
  return {
    schema: "ps3d-project-summary/1",
    id: project.id,
    name: project.name,
    revision: project.revision,
    activeWorkspace: project.activeWorkspace,
    unit: project.unit,
    sketch: {
      entities: project.sketch.entities.length,
      constraints: project.sketch.constraints.length,
      classification: analysis.classification,
      degreesOfFreedom: analysis.degreesOfFreedom
    },
    part: {
      widthMm: project.part.widthMm,
      heightMm: project.part.heightMm,
      thicknessMm: project.part.thicknessMm,
      holeDiameterMm: project.part.holeDiameterMm
    },
    assembly: { template: project.assembly.template ?? "custom", nominalEnvelopeMm: project.assembly.nominalEnvelopeMm ?? null, components: project.assembly.components.length, mates: project.assembly.mates.length, explodeMm: project.assembly.explodeMm, electricalLinks: project.assembly.electricalLinks?.length ?? 0, routeGuides: project.assembly.electricalRoutes?.length ?? 0, electromechanicalStatus: project.assembly.electromechanicalSource?.status ?? null },
    surface: { mode: project.surface.mode, segments: [project.surface.uSegments, project.surface.vSegments] },
    drawing: { sheet: project.drawing.sheet, projection: project.drawing.projection, scale: project.drawing.scale },
    electrical: { template: project.electrical.template, standard: project.electrical.standard, components: project.electrical.components.length, nets: project.electrical.nets.length },
    vehicle: { template: project.vehicle.template, kind: project.vehicle.kind, powertrain: project.vehicle.powertrain, layout: project.vehicle.layout, state: project.vehicle.state, inputStatus: project.vehicle.inputStatus },
    auditEntries: project.audit.length
  };
}

export async function createPs3dCollaborationGuide(): Promise<Readonly<Record<string, unknown>>> {
  const manifest = {
    schema: "ps3d-ai-collaboration/3",
    implementation: { name: "ps3d-cad-studio", title: "PS3D CAD Studio", version: "0.2.0-preview.1", license: "MIT" },
    compatibility: {
      direct: "Any host that implements MCP tools over a supported stdio revision can use this local server without a model-vendor SDK.",
      adapter: "A non-MCP application can use the dependency-free Python client or implement the same JSON-RPC tools/list and tools/call boundary.",
      notAutomatic: ["No automatic compatibility with every AI product", "No live bridge to an open PS3D browser tab", "No filesystem, credential, profile, or secret discovery"]
    },
    protocol: {
      standard: "Model Context Protocol",
      preferredRevision: PS3D_SUPPORTED_PROTOCOL_REVISIONS[0],
      supportedRevisions: PS3D_SUPPORTED_PROTOCOL_REVISIONS,
      eraNegotiation: "Modern clients use server/discover; 2025-era clients use initialize.",
      transports: [
        { kind: "stdio", status: "available", launch: { buildOnce: "pnpm mcp:build", command: "node", arguments: ["apps/mcp-server/dist/apps/mcp-server/src/server.js"], workingDirectoryRequired: true } },
        { kind: "streamable-http", status: "available-when-deployed-and-configured", endpoint: "/api/mcp", safeguards: ["OAuth or expiring personal bearer token", "tenant-scoped tools", "Origin validation", "1 MB body limit", "60 requests/minute identity quota"] }
      ]
    },
    discovery: {
      guideTool: "ps3d_guide",
      agentHandshakeTool: "ps3d_agent_handshake",
      commandFinderTool: "ps3d_find_commands",
      resource: "ps3d://ai/collaboration-guide",
      prompt: "ps3d-guided-change"
    },
    state: {
      model: "stateless-caller-owned",
      projectSchema: "ps3d-workbench-project/1",
      browserSessionConnected: false,
      externalWrites: false,
      returnedProjectMustBeReviewedAndOpenedOrImported: true
    },
    collaborationAgent: {
      implementation: "deterministic contract validator; no bundled language model and no hidden autonomous process",
      activation: "Call ps3d_agent_handshake after reading this guide and again whenever the goal, proposed tool, recipe ID, selection, or recovery path is unclear.",
      experienceLevels: EXPERIENCE_LEVELS,
      roleSplit: {
        hostAi: "Converses, reasons about user intent, requests missing human decisions, and explains the result.",
        ps3dAgent: "Matches registered capabilities, validates exact data contracts, returns diagnostics, and gates mutation through preview receipts.",
        jointRule: "Every mismatch is feedback to correct and revalidate; it is never permission to invent a command, identity, mate, sketch relation, geometry result, or approval."
      }
    },
    cadInteractionContract: {
      worldCoordinateSystem: "One right-handed Z-up WCS drives the grid, origin triad, camera orientation cube, named views, sketch plane, and model transforms.",
      environment: "Sketch, solid, assembly, surface, drawing, electrical, vehicle, and automation are workspaces over one caller-owned project rather than separate model files.",
      browserTree: ["Document settings", "Named views", "Origin", "Components", "Bodies", "Sketches", "Construction", "Mates", "Feature history"],
      sketchSelectionIntents: ["profile", "sketch-curve", "connected", "tangent"],
      extrudeOperations: {
        available: ["new-body", "new-component"],
        unavailableWithoutBrep: ["join", "cut", "intersect"],
        rule: "Never claim a boolean result unless the exact solid-kernel precondition is satisfied and a valid result is returned."
      },
      contextMenus: "Commands are resolved from active workspace plus selected datum, sketch, profile, feature, body, component, or mate; disabled commands include the reason."
    },
    commandNamespaces: [
      { namespace: "mcp-tool", count: WORKBENCH_MCP_TOOLS.length, callable: true, description: "Discoverable protocol calls registered by the server." },
      { namespace: "workbench-operation", count: PS3D_OPERATION_KINDS.length, callable: "only through preview/apply", description: "Canonical revision-checked project mutations hashed into receipts." },
      { namespace: "ui-command", count: CAD_COMMANDS.length, callable: false, description: "Browser interaction records; these are not MCP tools and are never executed by command search." }
    ],
    workflow: [
      { step: 1, name: "Connect", action: "Launch the prebuilt local stdio server with an explicit working directory." },
      { step: 2, name: "Discover and acknowledge", action: "Read this complete guide, list tools, and retain its manifestSha256 as guideAcknowledgement with understood:true." },
      { step: 3, name: "Activate collaboration", action: "Call ps3d_agent_handshake with the user request and experience level; resolve every correction or clarification before continuing." },
      { step: 4, name: "Understand", action: "Supply the complete caller-owned project to ps3d_inspect_project, run ps3d_design_health, and use ps3d_find_commands for a bounded recipe." },
      { step: 5, name: "Preview", action: "Call the required preview tool with the current guideAcknowledgement and show candidateProject, changedIds, warnings, base/candidate references, and receiptInfo." },
      { step: 6, name: "Confirm", action: "Obtain explicit user approval tied to the exact base revision and candidate." },
      { step: 7, name: "Apply or import", action: "Call ps3d_apply_preview with the same guideAcknowledgement, project, operation, receipt, and confirmed:true; review and open/import the returned copy." }
    ],
    safety: {
      maxInputBytes: WORKBENCH_LIMITS.maxJsonBytes,
      closedWorld: true,
      unavailableCapabilitiesCallable: false,
      previewReceipt: "Unkeyed deterministic SHA-256 integrity checksum; not authentication, a digital signature, or proof of approval.",
      instructionAcknowledgement: "Every preview/apply requires the current guide manifestSha256 plus understood:true. A stale digest fails closed and forces the client to read the guide again.",
      electromechanicalPolicy: "generate-electromechanical-realization must use ps3d_preview_electromechanical and its full disclosure response.",
      diagnosticFeedback: "Unknown names, missing stable IDs, invalid selections, contradictory sketch constraints, invalid mates, stale revisions, and unsupported geometry return typed diagnostics with recovery. The host must correct and revalidate instead of guessing."
    },
    tools: WORKBENCH_MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, readOnly: tool.annotations.readOnlyHint, approvalRequired: !tool.annotations.readOnlyHint })),
    operationKinds: PS3D_OPERATION_KINDS,
    commonRecipes: PS3D_AI_COMMAND_RECIPES,
    starterPrompt: "Use the connected PS3D MCP server. First call ps3d_guide and read the complete result. Then call ps3d_agent_handshake with my exact request and experience level; resolve all feedback before execution. Retain the guide manifestSha256 and pass {manifestSha256, understood:true} as guideAcknowledgement to every preview/apply. Inspect the complete project I provide and run design health. Use ps3d_find_commands to choose only a bounded recipe. Preview every proposed change, show me the exact candidate project, changed IDs, warnings, revision references, and receipt, and wait for my approval before apply. Treat every error as correction feedback and never invent missing command IDs, selections, mates, sketch relations, geometry results, approvals, live-browser mutations, or file writes."
  } as const;
  return { ...manifest, manifestSha256: await sha256Hex(canonicalizeJson(manifest)) };
}

export function findAiCommandRecipes(query: string, workspace?: WorkspaceId, limit = 6): readonly Readonly<Record<string, unknown>>[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = expandSearchTokens(normalizedQuery.split(" ").filter(Boolean));
  return PS3D_AI_COMMAND_RECIPES
    .map((entry, index) => ({ entry, index, score: scoreRecipe(entry, normalizedQuery, queryTokens, workspace) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      workspace: entry.workspace,
      intent: entry.intent,
      score,
      mcpTool: entry.mcpTool,
      previewPolicy: entry.previewPolicy,
      argumentTemplate: entry.argumentTemplate,
      note: entry.note,
      executionPerformed: false
    }));
}

function scoreRecipe(entry: Ps3dAiCommandRecipe, normalizedQuery: string, queryTokens: readonly string[], workspace?: WorkspaceId): number {
  if (workspace !== undefined && entry.workspace !== "any" && entry.workspace !== workspace) return 0;
  const title = normalizeSearchText(entry.title);
  const phraseText = entry.phrases.map(normalizeSearchText).join(" ");
  const body = normalizeSearchText(`${entry.title} ${entry.intent} ${entry.phrases.join(" ")} ${entry.workspace}`);
  let score = workspace !== undefined && entry.workspace === workspace ? 18 : entry.workspace === "any" ? 2 : 0;
  if (title === normalizedQuery) score += 120;
  if (title.includes(normalizedQuery) || phraseText.includes(normalizedQuery)) score += 55;
  for (const token of queryTokens) {
    if (title.split(" ").includes(token)) score += 18;
    else if (phraseText.split(" ").includes(token)) score += 12;
    else if (body.includes(token)) score += 5;
  }
  return score;
}

function expandSearchTokens(tokens: readonly string[]): readonly string[] {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    ai: ["connect", "guide", "help"], start: ["guide", "help"], make: ["create", "apply", "change"], check: ["inspect", "analyze", "measure"],
    bike: ["motorcycle", "vehicle", "wheelbase"], scooter: ["vehicle", "scooter"], trike: ["three", "wheeler", "vehicle"],
    wire: ["electrical", "panel", "wiring"], circuit: ["electrical", "schematic"], hole: ["bore", "diameter", "part"],
    drawing: ["sheet", "projection", "tolerance"], dimension: ["parameter", "tolerance", "drawing", "sketch"], constraint: ["sketch", "relation"],
    mate: ["assembly", "align", "joint"], mating: ["assembly", "mate", "align"], fastener: ["master", "cart", "assembly"], simulate: ["state", "analysis"]
  };
  return [...new Set(tokens.flatMap((token) => [token, ...(aliases[token] ?? [])]))];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function audienceProfile(level: Ps3dExperienceLevel): Readonly<Record<string, unknown>> {
  const profiles: Readonly<Record<Ps3dExperienceLevel, Readonly<Record<string, unknown>>>> = {
    child: { level, language: "very simple", explainTerms: true, equations: "only with a worked example", evidenceDepth: "show the visible result and one safety reason", interaction: "one small confirmed step at a time" },
    beginner: { level, language: "plain engineering language", explainTerms: true, equations: "show units and a short worked example", evidenceDepth: "state assumptions, selection, expected result, and limitations", interaction: "short numbered steps with confirmation before changes" },
    engineer: { level, language: "concise professional engineering", explainTerms: false, equations: "show governing inputs, units, and checks", evidenceDepth: "include stable IDs, revision, diagnostics, and qualification boundaries", interaction: "bounded plan, preview, review, confirm" },
    advanced: { level, language: "technical and implementation-aware", explainTerms: false, equations: "include derivation path and sensitivity-relevant inputs", evidenceDepth: "include data lineage, dependency impact, failure recovery, and uncertainty", interaction: "compare valid alternatives before committing intent" },
    phd: { level, language: "research-grade but unambiguous", explainTerms: false, equations: "include assumptions, derivation, dimensional consistency, uncertainty, and validation method", evidenceDepth: "separate model, evidence, inference, numerical result, and external validation need", interaction: "challenge identifiability and request missing evidence before claiming a conclusion" }
  };
  return profiles[level];
}

function recipe(
  id: string,
  workspace: WorkspaceId | "any",
  title: string,
  intent: string,
  phrases: readonly string[],
  previewPolicy: Ps3dAiCommandRecipe["previewPolicy"],
  mcpTool: string,
  argumentTemplate: Readonly<Record<string, unknown>>,
  note: string
): Ps3dAiCommandRecipe {
  return { id: `ai-command:${id}`, workspace, title, intent, phrases, previewPolicy, mcpTool, argumentTemplate, note };
}

function success(text: string, structuredContent: Readonly<Record<string, unknown>>): WorkbenchMcpResult {
  return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

function error(code: string, message: string): WorkbenchMcpResult {
  const structuredContent = { code, message };
  return { content: [{ type: "text", text: `${code}: ${message}` }, { type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

function diagnostics(values: readonly { readonly code: string; readonly message: string; readonly relatedIds: readonly string[]; readonly recovery: string }[]): WorkbenchMcpResult {
  const first = values[0];
  const code = first?.code ?? "INVALID_REQUEST";
  const message = first?.message ?? "The request was rejected.";
  return {
    content: [
      { type: "text", text: `${code}: ${message}${first?.recovery === undefined ? "" : ` Recovery: ${first.recovery}`}` },
      { type: "text", text: JSON.stringify({ code, message, diagnostics: values }) }
    ],
    structuredContent: { code, message, diagnostics: values },
    isError: true
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key));
}

function isWorkspace(value: unknown): value is WorkspaceId {
  return typeof value === "string" && ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"].includes(value);
}

function isExperienceLevel(value: unknown): value is Ps3dExperienceLevel {
  return typeof value === "string" && (EXPERIENCE_LEVELS as readonly string[]).includes(value);
}
