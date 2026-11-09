import type { WorkbenchProject } from "./types.js";

/**
 * The unit a project is shown and typed in. The model itself is always millimetres (`unit: "mm"`); this only says how lengths read. It is a
 * property of the project so that it is saved with the file, comes back when the file is opened and travels through MCP copies. A project
 * that never recorded one (every file saved before this existed) has no `displayUnit`, which means "no preference": the session's unit stays.
 */
export type ProjectDisplayUnit = "mm" | "in";

export function isProjectDisplayUnit(value: unknown): value is ProjectDisplayUnit {
  return value === "mm" || value === "in";
}

/** The unit the project asks for, or undefined when it recorded none. */
export function projectDisplayUnit(project: Pick<WorkbenchProject, "displayUnit">): ProjectDisplayUnit | undefined {
  return project.displayUnit;
}

/** The project with its display unit recorded. The same object when it already says so. */
export function withDisplayUnit(project: WorkbenchProject, unit: ProjectDisplayUnit): WorkbenchProject {
  return project.displayUnit === unit ? project : { ...project, displayUnit: unit };
}

/**
 * Which unit to show: the project's own when it recorded one, otherwise the one remembered from the last choice, otherwise what the
 * session already shows.
 */
export function resolveDisplayUnit(projectUnit: ProjectDisplayUnit | undefined, remembered: ProjectDisplayUnit | undefined, current: ProjectDisplayUnit): ProjectDisplayUnit {
  return projectUnit ?? remembered ?? current;
}
