import { useEffect, useRef, useState } from "react";
import type { WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import type { ThreeViewportAdapter } from "../../../packages/viewport-three/src/index.js";
import type { CommandPanelState } from "./command-panel.js";
import { createPreviewController, previewNote, type PreviewController, type PreviewState } from "./part-preview.js";
import { featurePreviewRequest, panelCandidate, panelPreviewRequest } from "./part-preview-build.js";
import { extrudeHandleSpec, handleDragValue, handleTipDistanceMm, handleValueText, previewHandleSpec, type PreviewHandleSpec } from "./part-preview-handle.js";
import type { DockPreview, ValueBridge } from "./part-preview-bridge.js";

/**
 * React side of live preview (see part-preview.ts for the attach API and what the controller promises). It watches whatever command is
 * open, a command panel or the Edit Feature dock, asks the controller for the ghost of its current values, draws the ghost and the drag
 * arrow in the 3D view, and writes arrow drags back into the form. It never commits: the form's own OK is the one history step, and
 * closing the form (OK, Cancel, Esc) removes the ghost and the arrow.
 *
 * Extrude and Revolve attach by passing their open command as `dock` (a candidate step) the same way the Edit Feature dock does.
 */
export interface PartPreviewInput {
  readonly viewportRef: { readonly current: ThreeViewportAdapter | undefined };
  readonly project: WorkbenchProject;
  readonly commandPanel: CommandPanelState | null;
  /** The Edit Feature dock's candidate (or another command's), used while no command panel is open. */
  readonly dock: DockPreview | undefined;
  /** The arrow wrote `text` into a command panel field. */
  readonly onPanelValue: (fieldId: string, text: string) => void;
  /** The arrow's channel into the dock's own fields. */
  readonly dockBridge: ValueBridge;
}

export interface PartPreviewOutput {
  /** One line about the preview for the open form (undefined = nothing to say). */
  readonly note: string | undefined;
}

export function usePartPreview(input: PartPreviewInput): PartPreviewOutput {
  const { viewportRef, project, commandPanel, dock, onPanelValue, dockBridge } = input;
  const [state, setState] = useState<PreviewState>({ state: "idle" });
  const controllerRef = useRef<PreviewController | undefined>(undefined);
  const dragRef = useRef<{ readonly startValue: number; readonly startText: string } | undefined>(undefined);
  const dockAnchorRef = useRef<{ readonly key: string; readonly spec: PreviewHandleSpec } | undefined>(undefined);
  const writePanelRef = useRef(onPanelValue);
  writePanelRef.current = onPanelValue;

  // The controller draws the ghost into whichever 3D view exists when a result arrives.
  useEffect(() => {
    const controller = createPreviewController({
      onGhost: (ghost, meta) => viewportRef.current?.setPreviewGhost(ghost === null ? null : { ...ghost, stale: meta.stale }),
      onState: setState
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = undefined;
      viewportRef.current?.setPreviewHandle(null);
    };
  }, [viewportRef]);

  // The ghost of the open form's current values.
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === undefined) return;
    if (commandPanel !== null) { controller.preview(panelPreviewRequest(project, commandPanel)); return; }
    if (dock !== undefined && "invalid" in dock) { controller.preview({ invalid: dock.invalid }); return; }
    if (dock !== undefined && dock.changed) { controller.preview(featurePreviewRequest(project, dock.feature, "edit")); return; }
    controller.clear();
  }, [project, commandPanel, dock]);

  // The drag arrow: replaced on every change (a drag in progress keeps going), removed when no form is open or it has no sensible place.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    let current = true;
    const show = (spec: PreviewHandleSpec | undefined, write: (fieldId: string, text: string) => void, textNow: string): void => {
      if (!current) return;
      if (spec === undefined) { viewport.setPreviewHandle(null); dragRef.current = undefined; return; }
      viewport.setPreviewHandle({
        anchorMm: spec.anchorMm, directionMm: spec.directionMm, tipDistanceMm: handleTipDistanceMm(spec),
        onDrag: (event) => {
          if (event.phase === "start") { dragRef.current = { startValue: spec.value, startText: textNow }; return; }
          const drag = dragRef.current;
          if (drag === undefined) return;
          // Escape drops the drag and puts the field back exactly as it was before the press.
          if (event.phase === "cancel") { write(spec.fieldId, drag.startText); dragRef.current = undefined; return; }
          write(spec.fieldId, handleValueText(handleDragValue(spec, drag.startValue, event.deltaMm, event.shiftKey)));
          if (event.phase === "end") dragRef.current = undefined;
        }
      });
    };
    if (commandPanel !== null) {
      const candidate = panelCandidate(project, commandPanel);
      const spec = candidate.ok && candidate.timelineSketchId !== undefined ? previewHandleSpec(project, commandPanel, candidate.feature) : undefined;
      show(spec, (fieldId, text) => writePanelRef.current(fieldId, text), spec === undefined ? "" : commandPanel.values[spec.fieldId] ?? handleValueText(spec.value));
    } else if (dock !== undefined && !("invalid" in dock) && dock.feature.kind === "extrude") {
      const feature = dock.feature;
      const distance = Math.abs(feature.valueMm);
      const key = `${project.id}|${project.revision}|${feature.id}|${feature.direction ?? "one-side"}|${feature.extent ?? "distance"}`;
      const cached = dockAnchorRef.current;
      void (cached !== undefined && cached.key === key ? Promise.resolve(cached.spec) : extrudeHandleSpec(project, feature, distance > 0 ? distance : 1)).then((spec) => {
        if (spec !== undefined) dockAnchorRef.current = { key, spec };
        show(spec === undefined ? undefined : { ...spec, value: distance }, (fieldId, text) => dockBridge.push(fieldId, text), handleValueText(distance));
      });
    } else {
      show(undefined, () => undefined, "");
    }
    return () => { current = false; };
  }, [viewportRef, project, commandPanel, dock, dockBridge]);

  return { note: commandPanel === null && dock === undefined ? undefined : previewNote(state) };
}
