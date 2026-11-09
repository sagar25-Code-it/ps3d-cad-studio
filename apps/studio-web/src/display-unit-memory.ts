import { isProjectDisplayUnit, resolveDisplayUnit, type ProjectDisplayUnit, type WorkbenchProject } from "../../../packages/workbench-core/src/index.js";

/**
 * The display unit across sessions. The unit is saved in the project (displayUnit); the last unit the person chose is also remembered in
 * the browser, so a new project or a file saved before the project recorded one opens in it. Storage can be blocked or empty (private
 * window, cleared site data), so every access is guarded and the app works without it.
 */

const STORAGE_KEY = "ps3d.display-unit";

export function rememberedDisplayUnit(): ProjectDisplayUnit | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isProjectDisplayUnit(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function rememberDisplayUnit(unit: ProjectDisplayUnit): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, unit);
  } catch {
    // Storage is a convenience only.
  }
}

/** The unit the app should show for `project` while the CAD document shows `current`. */
export function unitToShow(project: Pick<WorkbenchProject, "displayUnit">, current: ProjectDisplayUnit, remembered: ProjectDisplayUnit | undefined = rememberedDisplayUnit()): ProjectDisplayUnit {
  return resolveDisplayUnit(project.displayUnit, remembered, current);
}
