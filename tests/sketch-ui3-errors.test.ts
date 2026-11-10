import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { ChangeParametersDialog } from "../apps/studio-web/src/ui/ChangeParametersDialog.js";
import { CombineDialog } from "../apps/studio-web/src/ui/CombineDialog.js";
import { CommandPalette } from "../apps/studio-web/src/ui/CommandPalette.js";
import { DesignHealthCenter } from "../apps/studio-web/src/ui/DesignHealthCenter.js";
import { NewProjectDialog } from "../apps/studio-web/src/ui/NewProjectDialog.js";
import { SaveProjectDialog } from "../apps/studio-web/src/ui/SaveProjectDialog.js";
import { ShortcutsOverlay } from "../apps/studio-web/src/ui/ShortcutsOverlay.js";
import { SketchPlaneDialog } from "../apps/studio-web/src/ui/SketchPlaneDialog.js";
import { BendTableDialog } from "../apps/studio-web/src/ui/BendTableDialog.js";
import { shortcutGroupsFor } from "../apps/studio-web/src/ui/sketch-shortcut-items.js";
import { DEFAULT_SKETCH_KEYMAP } from "../packages/workbench-sketch/src/hotkeys.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { renderWorkspaceMarkup } from "./sketch-ui3-dimensions.test.js";

/** Wave 3 (ui3), "solve all errors": the sketch workspace and the main dialogs render with many prop variants and React writes nothing to the console. */

type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
let serial = 0;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:ui3-errors-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  if (!result.ok) throw new Error(`${operation.kind} refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}
const noop = (): undefined => undefined;

/** A sketch with every kind of curve and several kinds of relation and dimension, so every drawing and inspector branch runs. */
function richProject(): WorkbenchProject {
  const entities: readonly SketchEntity[] = [
    { id: "entity:l1", kind: "line", start: [0, 0], end: [60, 0], construction: false },
    { id: "entity:l2", kind: "line", start: [60, 0], end: [60, 20], construction: false },
    { id: "entity:l3", kind: "line", start: [60, 20], end: [0, 20], construction: true },
    { id: "entity:r1", kind: "rectangle", center: [100, 10], widthMm: 30, heightMm: 20, rotationDeg: 15, construction: false },
    { id: "entity:c1", kind: "circle", center: [20, 50], radiusMm: 6, construction: false },
    { id: "entity:a1", kind: "arc", start: [0, 80], mid: [10, 90], end: [20, 80], construction: false },
    { id: "entity:e1", kind: "ellipse", center: [80, 60], majorRadiusMm: 14, minorRadiusMm: 7, rotationDeg: 20, construction: false },
    { id: "entity:p1", kind: "point", point: [5, 5], construction: false },
    { id: "entity:s1", kind: "spline", fitPoints: [[0, 100], [15, 110], [30, 100], [45, 112]], construction: false }
  ];
  let project = createWorkbenchProject("project:ui3-errors");
  project = { ...project, sketch: { ...project.sketch, entities, constraints: [] } };
  project = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:o", kind: "coincident", entityIds: ["sketch:origin", "entity:l1"], points: ["self", "start"] } });
  project = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:h", kind: "horizontal", entityIds: ["entity:l1"] } });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:l1", dimension: "length", valueMm: 60 });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:c1", dimension: "diameter", valueMm: 12 });
  project = run(project, { kind: "set-sketch-dimension", entityId: "sketch:origin", secondEntityId: "entity:c1", dimension: "horizontal", valueMm: 20, points: ["self", "center"] });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:e1", dimension: "major-radius", valueMm: 14 });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:l1", secondEntityId: "entity:l3", dimension: "line-line", valueMm: 20 });
  return project;
}

/** Runs `body` and returns what React (or anything) wrote to console.error and console.warn while it ran. */
function consoleOutput(body: () => void): readonly string[] {
  const written: string[] = [];
  const { error, warn } = console;
  console.error = (...args: unknown[]): void => { written.push(`error: ${args.map(String).join(" ").slice(0, 240)}`); };
  console.warn = (...args: unknown[]): void => { written.push(`warn: ${args.map(String).join(" ").slice(0, 240)}`); };
  try { body(); } finally { console.error = error; console.warn = warn; }
  return written;
}

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/u.test(name) ? [path] : [];
  });
}

export const sketchUi3ErrorTests: readonly TestCase[] = [
  {
    name: "Re-audit UX (solve all errors): the Sketch workspace renders a sketch with every curve kind and dimension in every tool, edit tool, unit and mode with nothing written to the console",
    run: () => {
      const project = richProject();
      const tools = ["select", "line", "rectangle", "rectangle-center", "rectangle-three-point", "circle", "circle-two-point", "circle-three-point", "arc", "arc-center", "arc-tangent", "ellipse", "ellipse-arc", "circle-tangent-3", "circle-tangent-2", "point", "spline", "spline-control", "polygon", "slot", "slot-straight", "slot-arc-three-point", "slot-arc-center", "text", "block", "profile", "blend", "conic", "parabola", "hyperbola", "centerline", "line-midpoint", "parallelogram", "rectangle-rounded"];
      const editTools = ["offset", "mirror", "pattern", "move", "rotate", "scale", "stretch", "corner", "fillet", "chamfer", "trim", "extend", "split", "jog", "delete-curve", "offset-move", "make-path", "dynamic-mirror", "break", "import-drawing", "export-drawing", "underlay"];
      const variants: Record<string, unknown>[] = [{}, { displayUnit: "in" }, { dimensionMode: true }, { dimensionMode: true, displayUnit: "in" }, { checkOpen: true }, { showMovable: true }, { selectedId: "entity:c1" }, { selectedId: "entity:r1", displayUnit: "in" }];
      for (const tool of tools) variants.push({ tool });
      for (const editTool of editTools) variants.push({ editTool }, { editTool, displayUnit: "in" });
      const written = consoleOutput(() => {
        for (const variant of variants) {
          const html = renderWorkspaceMarkup(project, variant);
          if (!html.includes("sketch-palette") || !html.includes("Sketch inspector")) throw new Error(`${JSON.stringify(variant)} did not render the palette and the inspector`);
        }
      });
      equal(JSON.stringify(written), "[]", `React wrote nothing while rendering ${variants.length} variants`);
    }
  },
  {
    name: "Re-audit UX (solve all errors): the main dialogs (shortcuts, command search, parameters, combine, new, save, health, sketch plane, bend table) render in several states with nothing written to the console",
    run: () => {
      const project = richProject();
      const withParameters = run(project, { kind: "set-design-parameters", parameters: [{ name: "plate_w", expression: "80 mm", unit: "mm", comment: "overall" }, { name: "turn", expression: "30", unit: "deg", comment: "" }], renames: [] });
      const status = { apiSupported: false, bound: false, permission: "unsupported", folderName: "PS CAD Studio", persistentStorage: false, cacheReady: false, usageBytes: 0, quotaBytes: 0, currentFileName: null };
      const written = consoleOutput(() => {
        const groups = [{ title: "Sketch canvas", items: [] }, { title: "Panels", items: [{ keys: ["Ctrl", "K"], label: "Open the command palette" }] }];
        for (const open of [true, false]) renderToStaticMarkup(createElement(ShortcutsOverlay, { open, groups: shortcutGroupsFor(groups, DEFAULT_SKETCH_KEYMAP), onClose: noop }));
        for (const workspace of ["sketch", "part", "assembly", "electrical", "drawing"] as const) renderToStaticMarkup(createElement(CommandPalette, { open: true, workspace, onClose: noop, onCommand: noop }));
        renderToStaticMarkup(createElement(CommandPalette, { open: false, workspace: "sketch", onClose: noop, onCommand: noop }));
        for (const p of [project, withParameters]) for (const busy of [true, false]) renderToStaticMarkup(createElement(ChangeParametersDialog, { open: true, project: p, busy, onApply: () => Promise.resolve(undefined), onClose: noop }));
        renderToStaticMarkup(createElement(ChangeParametersDialog, { open: false, project, busy: false, onApply: () => Promise.resolve(undefined), onClose: noop }));
        renderToStaticMarkup(createElement(CombineDialog, { bodies: [{ id: "body:a", name: "Plate", visible: true }, { id: "body:b", name: "Boss", visible: false }], initialTargetId: "body:a", initialMode: "join", onApply: () => Promise.resolve(undefined), onCancel: noop }));
        renderToStaticMarkup(createElement(CombineDialog, { bodies: [], initialTargetId: undefined, initialMode: "cut", onApply: () => Promise.resolve(undefined), onCancel: noop }));
        for (const dirty of [true, false]) renderToStaticMarkup(createElement(NewProjectDialog, { open: true, dirty, onConfirm: noop, onSaveAndCreate: noop, onClose: noop }));
        for (const mode of ["save-as", "copy"] as const) renderToStaticMarkup(createElement(SaveProjectDialog, { open: true, mode, projectName: "Bracket", workspaceStatus: status as never, onConfirm: noop, onClose: noop }));
        renderToStaticMarkup(createElement(DesignHealthCenter, { report: buildDesignHealthReport(withParameters), onClose: noop, onWorkspace: noop }));
        for (const mode of ["set", "new"] as const) renderToStaticMarkup(createElement(SketchPlaneDialog, { open: true, mode, initialPlane: "xy", initialOffsetMm: 0, faces: [{ plane: "xy", offsetMm: 25, label: "Plate · z = 25 mm", hint: "Top face · 2400 mm²" }], onConfirm: noop, onClose: noop }));
        renderToStaticMarkup(createElement(BendTableDialog, { open: true, bodyName: "Bracket", table: undefined, onApply: noop, onExportRows: noop, onClose: noop }));
      });
      equal(JSON.stringify(written), "[]", "React wrote nothing while rendering the dialogs");
    }
  },
  {
    name: "Re-audit UX (solve all errors): the code review findings stay fixed (no console output in shipped UI code, no TODO or not-implemented text a person could read, dialogs that await a step never stick on working)",
    run: () => {
      const root = new URL("../../apps/studio-web/src", import.meta.url);
      const files = sourceFiles(root.pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
      assert(files.length > 100, `the UI sources were read (${files.length})`);
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (/console\.(error|warn|log|debug)\(/u.test(text)) offenders.push(`${file}: console output`);
        if (/\b(TODO|FIXME)\b|not implemented|coming soon/iu.test(text)) offenders.push(`${file}: placeholder text`);
      }
      equal(JSON.stringify(offenders), "[]", "the UI code writes nothing to the console and shows no placeholder text");
      // A dialog that awaits the app must clear its working state and say what happened when the step throws.
      for (const name of ["CombineDialog", "PatternDialog"]) {
        const source = readFileSync(new URL(`../../apps/studio-web/src/ui/${name}.tsx`, import.meta.url), "utf8");
        assert(source.includes("finally") && source.includes("setWorking(false)") && source.includes("describeFailure"), `${name} clears its working state in a finally block and reports a thrown step`);
      }
      const app = readFileSync(new URL("../../apps/studio-web/src/App.tsx", import.meta.url), "utf8");
      assert(!/void (finishSketch|changeUnit|handleSketchProject|createGeneralSolid)\(/u.test(app), "the background steps of the sketch are guarded, not fired and forgotten");
      assert(app.includes('aria-live={status === "error" ? "assertive" : "polite"}'), "an error in the status line is announced at once");
    }
  }
];
