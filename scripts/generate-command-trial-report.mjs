import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAD_COMMANDS } from "../.test-dist/packages/workbench-core/src/commands.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(repositoryRoot, "artifacts", "command-trials");
const screenshotRoot = join(artifactRoot, "screenshots");
mkdirSync(screenshotRoot, { recursive: true });

const auditImages = {
  sketch: "07-audit-sketch-all-commands.png",
  part: "08-audit-part-all-commands.png",
  assembly: "09-audit-assembly-all-commands.png",
  surface: "10-audit-surface-all-commands.png",
  drawing: "11-audit-drawing-all-commands.png",
  electrical: "12-audit-electrical-all-commands.png",
  vehicle: "13-audit-vehicle-all-commands.png",
  automate: "14-audit-automate-all-commands.png"
};

const workspaceImages = {
  sketch: "06-sketch-ribbon-constraints-profiles.png",
  part: "02-part-primitives-and-professional-layout.png",
  assembly: "15-workspace-assembly-trial.png",
  surface: "16-workspace-surface-trial.png",
  drawing: "17-workspace-drawing-trial.png",
  electrical: "18-workspace-electrical-trial.png",
  vehicle: "19-workspace-vehicle-trial.png",
  automate: "20-workspace-automate-trial.png"
};

const officialReferences = [
  { title: "Autodesk Fusion Extrude reference", url: "https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-EXTRUDE.htm" },
  { title: "Autodesk Fusion solid-body modification", url: "https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MODIFY-SOLID-BODY.htm" },
  { title: "Autodesk Fusion project/include sketch geometry", url: "https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-SKETCH-CREATE-PROJECT-INCLUDE.htm" },
  { title: "Autodesk Fusion surface primitives", url: "https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-CREATE-SURFACE-PRIMITIVE.htm" },
  { title: "Siemens Designcenter NX synchronous modeling", url: "https://blogs.sw.siemens.com/designcenter/designcenternx-synchronous-modeling/" },
  { title: "Siemens Designcenter NX first-part modeling", url: "https://blogs.sw.siemens.com/designcenter/nx-how-to-series-modeling-a-part-for-the-first-time/" },
  { title: "Siemens Designcenter NX advanced patterns", url: "https://blogs.sw.siemens.com/designcenter/nx-tips-tricks-advanced-patterns/" }
];

const commands = CAD_COMMANDS.map((command) => ({
  id: command.id,
  name: command.name,
  workspace: command.workspace,
  group: command.group,
  category: command.category,
  capability: command.level,
  action: command.action.kind,
  shortcut: command.shortcut ?? "",
  description: command.description,
  selection: command.guide.selection,
  steps: command.guide.steps,
  expectedResult: command.guide.result,
  verificationBoundary: command.guide.boundary,
  auditImage: `screenshots/${auditImages[command.workspace]}`,
  workspaceTrialImage: `screenshots/${workspaceImages[command.workspace]}`
}));

const screenshotManifest = readdirSync(screenshotRoot)
  .filter((name) => name.toLowerCase().endsWith(".png"))
  .sort()
  .map((name) => {
    const bytes = readFileSync(join(screenshotRoot, name));
    return { file: `screenshots/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });

const summary = {
  total: commands.length,
  qualified: commands.filter((command) => command.capability === "qualified").length,
  preview: commands.filter((command) => command.capability === "preview").length,
  unavailable: commands.filter((command) => command.capability === "unavailable").length,
  screenshots: screenshotManifest.length
};

const report = {
  format: "ps3d-command-trial-report/1",
  generatedAt: new Date().toISOString(),
  scope: "Local PS3D build only; no GitHub or Vercel deployment was performed.",
  interpretation: {
    qualified: "Executed on the published bounded geometry path and covered by repository tests.",
    preview: "Executable or inspectable revisioned assistance with a visible verification boundary.",
    unavailable: "Discoverable and documented, but deliberately non-executable until the stated kernel, solver, catalog, or data model exists."
  },
  summary,
  officialReferences,
  screenshots: screenshotManifest,
  commands
};

writeFileSync(join(artifactRoot, "command-coverage.json"), `${JSON.stringify(report, null, 2)}\n`);

const csvColumns = ["id", "name", "workspace", "group", "category", "capability", "action", "shortcut", "selection", "expectedResult", "verificationBoundary", "auditImage", "workspaceTrialImage"];
const csvRows = [csvColumns.join(","), ...commands.map((command) => csvColumns.map((column) => csv(command[column])).join(","))];
writeFileSync(join(artifactRoot, "command-coverage.csv"), `${csvRows.join("\n")}\n`);

const markdown = [
  "# PS3D professional command trial evidence",
  "",
  `- Total commands: **${summary.total}**`,
  `- Qualified: **${summary.qualified}**`,
  `- Executable/inspectable preview: **${summary.preview}**`,
  `- Correctly gated as unavailable: **${summary.unavailable}**`,
  `- Screenshot artifacts: **${summary.screenshots}**`,
  "",
  "The source NX screenshots supplied by the user are reference material only and are not redistributed in this package. All included images were generated from the independent local PS3D build.",
  "",
  "## Capability interpretation",
  "",
  "- `qualified`: bounded behavior with executed repository evidence gates.",
  "- `preview`: a real local command, inspector, visualization, or calculation with an explicit verification boundary.",
  "- `unavailable`: no fake execution; the card states the missing persistent references, kernel/solver/catalog, validation, and expected result.",
  "",
  "## Screenshot index",
  "",
  ...screenshotManifest.map((item) => `- [${item.file}](${item.file}) — ${item.bytes.toLocaleString("en-US")} bytes — SHA-256 \`${item.sha256}\``),
  "",
  "## Per-command coverage",
  "",
  "| Command | Workspace | Capability | Action | Audit evidence |",
  "|---|---|---:|---|---|",
  ...commands.map((command) => `| ${escapeMarkdown(command.name)} | ${command.workspace} | ${command.capability} | ${command.action} | [image](${command.auditImage}) |`),
  "",
  "## Official workflow references",
  "",
  ...officialReferences.map((reference) => `- [${reference.title}](${reference.url})`),
  ""
].join("\n");
writeFileSync(join(artifactRoot, "README.md"), markdown);

const manifestText = screenshotManifest.map((item) => `${item.sha256}  ${item.file}`).join("\n");
writeFileSync(join(artifactRoot, "SHA256SUMS.txt"), `${manifestText}\n`);

console.log(`Generated ${relative(repositoryRoot, artifactRoot)}: ${summary.total} commands and ${summary.screenshots} screenshots.`);

function csv(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
