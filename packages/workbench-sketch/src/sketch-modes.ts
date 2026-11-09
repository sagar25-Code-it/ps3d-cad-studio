/**
 * Small decisions of the sketch canvas that are easier to get right (and to test) as plain functions.
 */

/** What was active when Zoom window or Measure began. Both take the canvas clicks, so changing any of these ends them. */
export interface ModalContext {
  readonly tool: string;
  readonly editTool: string | null;
  readonly dimensionMode: boolean;
}

/** True when Zoom window or Measure, begun in `started`, must end because the tool, the edit tool or Sketch Dimension changed. */
export function modalModeEnded(started: ModalContext | undefined, now: ModalContext): boolean {
  return started !== undefined && (started.tool !== now.tool || started.editTool !== now.editTool || started.dimensionMode !== now.dimensionMode);
}

/** The context Measure starts in: the Select tool with no edit tool and no Sketch Dimension (it closes those when it starts). */
export const MEASURE_CONTEXT: ModalContext = { tool: "select", editTool: null, dimensionMode: false };

export type SolidResult = "new-body" | "join" | "cut";

/**
 * The Result of Create solid that applies right now. Join and Cut need a solid to change and only exist for an extrude or revolve, so with
 * no solid, or any other operation, the result reads New body whatever was chosen before (a Cut remembered from another project used to
 * leave Create solid disabled until the person found the Result select).
 */
export function effectiveSolidResult(stored: SolidResult, solidCount: number, operation: string): SolidResult {
  return solidCount === 0 || (operation !== "extrude" && operation !== "revolve") ? "new-body" : stored;
}
