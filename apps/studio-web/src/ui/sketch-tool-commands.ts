import { CAD_COMMANDS, type CadCommandRecord, type CadSketchCommand, type CadSketchEditTool, type CadSketchTool } from "../../../../packages/workbench-core/src/index.js";
import { CURVE_TOOL_PROMPTS, isFixedCurveTool } from "../../../../packages/workbench-sketch/src/curve-tools.js";
import { getActiveSketchKeymap, keyLabelForTool, type SketchKeymap } from "../../../../packages/workbench-sketch/src/hotkeys.js";
import { sketchToolLabel, type SketchTool } from "../../../../packages/workbench-sketch/src/index.js";
import { nextClickPrompt } from "../../../../packages/workbench-sketch/src/tool-prompts.js";

/**
 * Command search (S) entries for every sketch tool on the ribbon.
 *
 * CAD_COMMANDS lists the original sketch tools only; the ellipse, the centerpoint and tangent arcs, the straight slot, the 15
 * newer curve tools, the split / jog / delete / path edit tools and the projection variants are on the ribbon but could not be
 * found by the search. They are added here rather than to the catalog so the catalog count (and the MCP surface built from it)
 * stays as released. Every entry runs through the same executor as a catalog entry (activate-sketch-tool and so on).
 *
 * The shortcut shown on each entry is read from the live keymap, so a key the user changed is the key the search shows.
 */
const EXTRA_DRAW_TOOLS: readonly CadSketchTool[] = [
  "ellipse", "arc-center", "arc-tangent", "slot-straight",
  "line-midpoint", "centerline", "parallelogram", "rectangle-rounded", "slot-arc-three-point", "slot-arc-center",
  "spline-control", "parabola", "hyperbola", "conic", "conic-five", "blend", "profile", "text", "block",
  "ellipse-arc", "circle-tangent-3", "circle-tangent-2"
];

const EXTRA_EDIT_TOOLS: readonly { readonly tool: CadSketchEditTool; readonly name: string; readonly description: string; readonly keywords: readonly string[] }[] = [
  { tool: "split", name: "Sketch Split", description: "Click a curve to cut it into two at that point; the halves keep the relations of the original.", keywords: ["break", "divide", "cut"] },
  { tool: "jog", name: "Sketch Jog", description: "Click a line to put a step (a jog) of a given offset and width into it.", keywords: ["step", "offset", "kink"] },
  { tool: "delete-curve", name: "Delete Curve", description: "Click a curve to delete it and heal the gap by extending its neighbours to meet.", keywords: ["remove", "heal", "erase"] },
  { tool: "offset-move", name: "Offset Move", description: "Offset a chain or region of curves and move it as one.", keywords: ["chain", "region", "translate"] },
  { tool: "make-path", name: "Make Path", description: "Chain connected curves into one path for a sweep, a loft rail or a wrap.", keywords: ["chain", "join", "rail"] },
  { tool: "dynamic-mirror", name: "Dynamic Mirror", description: "Pick a mirror axis, then draw: everything you draw is mirrored across it as you go.", keywords: ["symmetry", "axis", "live"] },
  { tool: "break", name: "Sketch Break", description: "Cut every curve into separate pieces wherever it crosses another, so each piece can be deleted or kept on its own.", keywords: ["intersections", "divide", "cut", "pieces"] },
  { tool: "import-drawing", name: "Import DXF / SVG", description: "Bring the curves of a DXF or SVG file into the sketch; choose the file in the right panel and confirm the scale.", keywords: ["dxf", "svg", "import", "insert", "drawing", "file", "laser", "cnc"] },
  { tool: "export-drawing", name: "Export DXF / SVG", description: "Save the sketch as a DXF or SVG file; choose the format in the right panel, then download.", keywords: ["dxf", "svg", "export", "save", "drawing", "file", "laser", "cnc"] },
  { tool: "underlay", name: "Picture", description: "Place a PNG or JPEG under the sketch, calibrate its scale with two points and trace over it.", keywords: ["image", "picture", "underlay", "trace", "calibrate", "photo", "png", "jpeg"] }
];

const EXTRA_COMMANDS: readonly { readonly command: CadSketchCommand; readonly name: string; readonly description: string; readonly keywords: readonly string[] }[] = [
  { command: "project-edge", name: "Project edge", description: "Pick one edge or run of edges of a solid body and project it onto the sketch plane.", keywords: ["include", "reference", "edge"] },
  { command: "intersect-body", name: "Intersect body", description: "Cut the sketch plane through a solid body and draw the cross-section outline.", keywords: ["section", "cut", "slice"] },
  { command: "silhouette-body", name: "Silhouette", description: "Draw the outline a solid body casts on the sketch plane.", keywords: ["outline", "projection", "profile"] },
  { command: "convert-face", name: "Convert face", description: "Pick a face of a solid and convert its outline into sketch curves.", keywords: ["face", "outline", "project"] },
  { command: "project-reference", name: "Project as reference", description: "Switch projected curves between reference (construction) and real profile geometry.", keywords: ["construction", "reference", "toggle"] }
];

function drawRecord(tool: CadSketchTool): CadCommandRecord {
  const label = sketchToolLabel(tool as SketchTool);
  const prompts = Array.from({ length: 6 }, (_, index) => nextClickPrompt(tool as SketchTool, index)).filter((prompt): prompt is string => prompt !== undefined);
  const flow = isFixedCurveTool(tool) ? CURVE_TOOL_PROMPTS[tool] : prompts;
  const description = flow.length === 0 ? `Draw with the ${label} tool.` : `${label}: click ${flow.join(", then ")}.`;
  return {
    id: `command:sketch-tool-${tool}`,
    workspace: "sketch",
    category: "create",
    name: label,
    description,
    level: "preview",
    action: { kind: "activate-sketch-tool", tool },
    keywords: [...label.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean), "curve", "sketch tool"],
    group: "Sketch / Create",
    guide: {
      selection: "Activate or create a sketch on the intended plane.",
      steps: [
        "Open the Sketch workspace and pick the plane.",
        flow.length === 0 ? `Run ${label} and click in the canvas.` : `Run ${label}: ${flow.map((prompt, index) => `${index + 1}. ${prompt}`).join("; ")}.`,
        "Type exact values in the fields next to the cursor (Tab for the next field, Enter to place), or click."
      ],
      result: description,
      boundary: "Runs as a revisioned preview; verify before manufacturing or release."
    }
  };
}

function editRecord(entry: (typeof EXTRA_EDIT_TOOLS)[number]): CadCommandRecord {
  return {
    id: `command:sketch-edit-${entry.tool}`,
    workspace: "sketch",
    category: "modify",
    name: entry.name,
    description: entry.description,
    level: "preview",
    action: { kind: "activate-sketch-edit", tool: entry.tool },
    keywords: [...entry.keywords, "sketch edit"],
    group: "Sketch / Modify",
    guide: {
      selection: "Open the sketch; select curves first when the tool says so.",
      steps: ["Open the Sketch workspace.", `Run ${entry.name} and read its panel.`, "Click the curve (or apply in the panel); undo if the result is wrong."],
      result: entry.description,
      boundary: "Runs as a revisioned preview; verify before manufacturing or release."
    }
  };
}

function commandRecord(entry: (typeof EXTRA_COMMANDS)[number]): CadCommandRecord {
  return {
    id: `command:sketch-${entry.command}`,
    workspace: "sketch",
    category: "construct",
    name: entry.name,
    description: entry.description,
    level: "preview",
    action: { kind: "sketch-command", command: entry.command },
    keywords: [...entry.keywords, "project"],
    group: "Sketch / Construct",
    guide: {
      selection: "Select the solid body or face to read from, as the command asks.",
      steps: ["Open the Sketch workspace.", `Run ${entry.name}.`, "Check the new curves in the sketch; they are a snapshot of the body."],
      result: entry.description,
      boundary: "The curves are a snapshot of the body and do not follow later edits."
    }
  };
}

function toolIdOf(record: CadCommandRecord): string | undefined {
  return record.action.kind === "activate-sketch-tool" || record.action.kind === "activate-sketch-edit" ? record.action.tool : record.action.kind === "activate-sketch-dimension" ? "dimension" : undefined;
}

/** The sketch tool entries missing from the catalog. Each carries the key from `keymap`. */
export function extraSketchSearchCommands(keymap: SketchKeymap = getActiveSketchKeymap()): readonly CadCommandRecord[] {
  const present = new Set(CAD_COMMANDS.map((record) => `${record.action.kind}:${toolIdOf(record) ?? (record.action.kind === "sketch-command" ? record.action.command : "")}`));
  const records = [
    ...EXTRA_DRAW_TOOLS.map(drawRecord),
    ...EXTRA_EDIT_TOOLS.map(editRecord),
    ...EXTRA_COMMANDS.map(commandRecord)
  ].filter((record) => !present.has(`${record.action.kind}:${toolIdOf(record) ?? (record.action.kind === "sketch-command" ? record.action.command : "")}`));
  return records.map((record) => withKeymapShortcut(record, keymap));
}

function withKeymapShortcut(record: CadCommandRecord, keymap: SketchKeymap): CadCommandRecord {
  const tool = toolIdOf(record);
  if (record.workspace !== "sketch" || tool === undefined) return record;
  const key = keyLabelForTool(tool, keymap);
  if (key === undefined) {
    if (record.shortcut === undefined) return record;
    const { shortcut: _removed, ...rest } = record;
    return rest;
  }
  return { ...record, shortcut: key };
}

/**
 * Every command the search should offer: the catalog (with the live key on each sketch tool) plus the sketch tools the
 * catalog does not list.
 */
export function searchableCommands(keymap: SketchKeymap = getActiveSketchKeymap()): readonly CadCommandRecord[] {
  return [...CAD_COMMANDS.map((record) => withKeymapShortcut(record, keymap)), ...extraSketchSearchCommands(keymap)];
}
