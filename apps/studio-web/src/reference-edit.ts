import type { DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, usesExpressions } from "../../../packages/workbench-core/src/index.js";
import { planeFollowFrames } from "./reference-follow.js";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "operationId" | "expectedRevision"> : never;
type OperationIntent = WithoutEnvelope<WorkbenchOperation>;

/**
 * Applies an edited construction plane, axis, point or primitive step. The step is replaced; then the sketches placed on construction planes
 * are moved onto the planes as they are now, and the solids built on those sketches are rebuilt, all as one undo step.
 */
export interface ReferenceEditDeps {
  readonly project: () => WorkbenchProject;
  /** The app's commit with replay: applies `intent` to `options.from` (or the live project), rebuilds the solids and records one project. */
  readonly commit: (intent: OperationIntent, mustApply?: string, forceReplay?: boolean, options?: { readonly from?: WorkbenchProject }) => Promise<boolean>;
  readonly refuse: (message: string) => void;
}

export async function applyReferenceEdit(deps: ReferenceEditDeps, next: DesignSolidFeature): Promise<boolean> {
  const live = deps.project();
  const intent: OperationIntent = { kind: "update-design-reference", feature: next };
  const dry = applyWorkbenchOperation(live, { ...intent, operationId: `operation:ui-${crypto.randomUUID()}`, expectedRevision: live.revision } as WorkbenchOperation);
  if (!dry.ok) { deps.refuse(dry.diagnostics[0]?.message ?? "That edit was refused."); return false; }
  const frames = planeFollowFrames(dry.value.project);
  // Another step may use this step's numbers in an expression, so the solids are rebuilt whenever expressions are in play.
  const replay = frames.length > 0 || usesExpressions(dry.value.project) || next.expressions !== undefined;
  if (frames.length === 0) return deps.commit(intent, undefined, replay);
  return deps.commit({ kind: "follow-design-planes", frames }, undefined, true, { from: dry.value.project });
}
