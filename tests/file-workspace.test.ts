import { formatStorageSize, normalizeProjectFileName } from "../apps/studio-web/src/file-workspace.js";
import { CAD_COMMANDS, auditCadCommandSurface } from "../packages/workbench-core/src/index.js";
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
    name: "file lifecycle and render workflows are machine-discoverable commands",
    run: () => {
      const required = ["file-new", "file-open", "file-save", "file-save-as", "file-save-copy", "file-workspace", "open-render-studio"];
      for (const actionKind of required) assert(CAD_COMMANDS.some((command) => command.action.kind === actionKind), `${actionKind} should be discoverable by the command and MCP guide`);
      const audit = auditCadCommandSurface();
      assert(audit.passed, `the extended action dispatcher should remain audited: ${audit.issues.map((issue) => issue.code).join(", ")}`);
    }
  }
];
