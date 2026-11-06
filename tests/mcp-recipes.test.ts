import { exportFileName, safeFileStem } from "../apps/studio-web/src/file-names.js";
import { buildHostRecipes, readRemoteProbe, remoteMcpUrl } from "../apps/studio-web/src/mcp-recipes.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const mcpRecipeTests: readonly TestCase[] = [
  {
    name: "export file names come from the project name, safely, and never end up empty",
    run: () => {
      equal(safeFileStem("PS3D Fixture Study"), "PS3D-Fixture-Study", "spaces become dashes");
      equal(safeFileStem("  ***  "), "ps3d-model", "a name with nothing usable falls back");
      equal(safeFileStem("a".repeat(120)), "a".repeat(80), "stems are capped at 80 characters");
      equal(exportFileName("My Plate", "drawing", "svg"), "My-Plate-drawing.svg", "suffix and extension are appended");
      equal(exportFileName("My Plate", "", "workbench.json"), "My-Plate.workbench.json", "an empty suffix adds nothing");
      equal(exportFileName("Bracket v2", "plate-mm", "stl"), "Bracket-v2-plate-mm.stl", "unit-bearing suffixes pass through");
    }
  },
  {
    name: "every host recipe carries the deployment's own MCP URL",
    run: () => {
      equal(remoteMcpUrl("https://example.app/"), "https://example.app/api/mcp", "trailing slashes are trimmed");
      const recipes = buildHostRecipes("https://example.app");
      equal(recipes.map((recipe) => recipe.id).join(","), "claude-code,claude-desktop,cursor,vs-code", "four hosts, stable order");
      assert(recipes.every((recipe) => recipe.body.includes("https://example.app/api/mcp")), "each recipe names the endpoint");
      assert(recipes.every((recipe) => recipe.note.length > 0), "each recipe says where its text goes");
      const cursor = recipes.find((recipe) => recipe.id === "cursor");
      assert(cursor !== undefined && (JSON.parse(cursor.body) as { mcpServers: { ps3d: { url: string } } }).mcpServers.ps3d.url === "https://example.app/api/mcp", "the Cursor block is valid JSON");
      const vscode = recipes.find((recipe) => recipe.id === "vs-code");
      assert(vscode !== undefined && (JSON.parse(vscode.body) as { servers: { ps3d: { type: string } } }).servers.ps3d.type === "http", "the VS Code block is valid JSON with an http server");
    }
  },
  {
    name: "the connection test reads its probes honestly: ready, setup-required, unreachable",
    run: () => {
      const ready = readRemoteProbe({ status: "ready" }, { resource: "https://example.app/api/mcp", authorization_servers: ["https://auth.example.com/auth/v1"] });
      equal(ready.state, "ready", "a ready backend reads as ready");
      assert(ready.detail.includes("auth.example.com"), "and names the OAuth server host");
      const setup = readRemoteProbe({ status: "setup-required" }, undefined);
      equal(setup.state, "setup-required", "a reachable API without a backend says setup required");
      const dev = readRemoteProbe(undefined, undefined);
      equal(dev.state, "unreachable", "no API route reads as unreachable");
      assert(dev.detail.includes("dev server"), "and explains the dev-server case");
      const noMetadata = readRemoteProbe({ status: "ready" }, undefined);
      equal(noMetadata.state, "ready", "missing metadata does not hide a working endpoint");
      assert(noMetadata.detail.includes("metadata"), "but the missing metadata is said out loud");
    }
  }
];
