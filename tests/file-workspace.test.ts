import {
  MAX_PROJECT_BYTES,
  assertProjectFileSize,
  formatStorageSize,
  normalizeProjectFileName,
  openProjectWithPicker,
  readProjectFilePayload,
  saveModeRebindsCurrentFile
} from "../apps/studio-web/src/file-workspace.js";
import { createQualifiedPartDocument } from "../apps/studio-web/src/project-worker-sync.js";
import { parameterByKey } from "../packages/model-schema/src/index.js";
import { CAD_COMMANDS, auditCadCommandSurface, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const fileWorkspaceTests: readonly TestCase[] = [
  {
    name: "project file names are bounded and preserve the PS3D native suffix",
    run: () => {
      equal(normalizeProjectFileName(" Fixture Study "), "Fixture Study.ps3d.json", "plain project names should receive the native suffix");
      equal(normalizeProjectFileName("fixture.workbench.json"), "fixture.ps3d.json", "legacy workbench suffixes should normalize to the native suffix");
      equal(normalizeProjectFileName("../Unsafe:*? Name"), "Unsafe- Name.ps3d.json", "path separators and reserved punctuation should not enter the visible filename");
      assert(normalizeProjectFileName("x".repeat(200)).length <= 107, "the filename stem should remain bounded");
    }
  },
  {
    name: "storage status text uses stable human-readable units",
    run: () => {
      equal(formatStorageSize(0), "0 B", "zero bytes should not emit NaN");
      equal(formatStorageSize(1024), "1.0 KB", "one kibibyte should use the KB label");
      equal(formatStorageSize(10 * 1024 * 1024), "10 MB", "larger values should avoid meaningless decimals");
    }
  },
  {
    name: "project reads reject unsafe sizes before allocating file text",
    run: async () => {
      let textRead = false;
      let rejected = false;
      try {
        await readProjectFilePayload({
          name: "oversized.ps3d.json",
          size: MAX_PROJECT_BYTES + 1,
          text: async () => { textRead = true; return "{}"; }
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "an oversized project should be rejected");
      assert(!textRead, "an oversized project should be rejected before File.text allocates its contents");
      for (const invalid of [0, -1, Number.NaN, MAX_PROJECT_BYTES + 1]) {
        let failed = false;
        try { assertProjectFileSize(invalid); } catch { failed = true; }
        assert(failed, `invalid project byte size ${String(invalid)} should fail`);
      }
      assertProjectFileSize(MAX_PROJECT_BYTES);
    }
  },
  {
    name: "file-picker open requests read-only permission and defers persistent rebinding",
    run: async () => {
      const globalWindow = globalThis as unknown as { window?: Window };
      const originalWindow = globalWindow.window;
      const requestedModes: string[] = [];
      const handle = {
        kind: "file",
        name: "candidate.ps3d.json",
        queryPermission: async (descriptor?: { readonly mode?: "read" | "readwrite" }) => {
          requestedModes.push(descriptor?.mode ?? "missing");
          return "granted" as PermissionState;
        },
        getFile: async () => new File(["{}"], "candidate.ps3d.json", { type: "application/json" })
      } as unknown as FileSystemFileHandle;
      globalWindow.window = { showOpenFilePicker: async () => [handle] } as unknown as Window;
      try {
        const payload = await openProjectWithPicker();
        equal(payload?.fileName, "candidate.ps3d.json", "the selected file should be staged for caller validation");
        equal(requestedModes.join(","), "read", "opening must not ask for write access");
      } finally {
        if (originalWindow === undefined) delete globalWindow.window;
        else globalWindow.window = originalWindow;
      }
    }
  },
  {
    name: "save-copy keeps the active binding while save and save-as rebind",
    run: () => {
      assert(saveModeRebindsCurrentFile("save"), "Save without a current target should bind its successful destination");
      assert(saveModeRebindsCurrentFile("save-as"), "Save As should bind its successful destination");
      assert(!saveModeRebindsCurrentFile("copy"), "Save a Copy must leave the active file binding unchanged");
    }
  },
  {
    name: "broad project parameters become one coherent qualified-worker snapshot",
    run: () => {
      const project = createWorkbenchProject("project:file-sync-test");
      const changed = {
        ...project,
        part: { ...project.part, widthMm: 125.5, heightMm: 82.25, thicknessMm: 14.75, holeDiameterMm: 18.5 }
      };
      const document = createQualifiedPartDocument(changed, "document:file-sync-test", "in");
      equal(parameterByKey(document, "width").valueMeters * 1000, 125.5, "qualified width should match the opened broad project");
      equal(parameterByKey(document, "height").valueMeters * 1000, 82.25, "qualified height should match the opened broad project");
      equal(parameterByKey(document, "thickness").valueMeters * 1000, 14.75, "qualified thickness should match the opened broad project");
      equal(parameterByKey(document, "holeDiameter").valueMeters * 1000, 18.5, "qualified bore should match the opened broad project");
      equal(document.displayUnit, "in", "the user's qualified display unit should survive project synchronization");
      equal(document.commandJournal.length, document.revision + 1, "the synchronized document should have a contiguous replayable journal");
    }
  },
  {
    name: "file lifecycle and render workflows are machine-discoverable commands",
    run: () => {
      const required = ["file-new", "file-open", "file-save", "file-save-as", "file-save-copy", "file-workspace", "open-render-studio"];
      for (const actionKind of required) assert(CAD_COMMANDS.some((command) => command.action.kind === actionKind), `${actionKind} should be discoverable by the command and MCP guide`);
      const audit = auditCadCommandSurface();
      assert(audit.passed, `the extended action dispatcher should remain audited: ${audit.issues.map((issue) => issue.code).join(", ")}`);
    }
  }
];
