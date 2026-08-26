import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";

export type WorkbenchHistoryLane = "qualified-part" | "broad-project" | null;

/**
 * Select the history that owns the next global Undo/Redo action. Qualified
 * Part-worker history takes priority only while it actually has an entry;
 * broad project operations remain undoable from every workspace, including
 * after the user switches back to Part.
 */
export function selectWorkbenchHistoryLane(
  workspace: WorkspaceId,
  qualifiedPartDepth: number,
  broadProjectDepth: number
): WorkbenchHistoryLane {
  if (workspace === "part" && qualifiedPartDepth > 0) return "qualified-part";
  if (broadProjectDepth > 0) return "broad-project";
  return null;
}
