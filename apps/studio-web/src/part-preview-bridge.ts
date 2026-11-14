import type { DesignSolidFeature } from "../../../packages/workbench-core/src/index.js";

/**
 * Two small pieces the live preview shares between the 3D view and a form that owns its own field state (the Edit Feature dock).
 *
 * `ValueBridge`: the drag arrow writes a number into a field. A command panel's fields live in App state and are written directly;
 * the dock keeps its fields inside the dialog, so the arrow reaches them through this channel (the dialog subscribes while it is open).
 *
 * `DockPreview`: what the dock tells the preview about its form as it stands now. Undefined means the dock is closed. Otherwise
 * `feature` is the step the form would apply and `changed` says whether it differs from the step on file (an unchanged form shows no
 * ghost, since it would only repeat the model, but still gets its drag arrow); `invalid` is why the form cannot be applied.
 */
export interface ValueBridge {
  push(fieldId: string, text: string): void;
  subscribe(listener: (fieldId: string, text: string) => void): () => void;
}

export function createValueBridge(): ValueBridge {
  const listeners = new Set<(fieldId: string, text: string) => void>();
  return {
    push(fieldId, text) { for (const listener of [...listeners]) listener(fieldId, text); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}

export type DockPreview =
  | { readonly feature: DesignSolidFeature; readonly changed: boolean }
  | { readonly invalid: string };

/** The dock's preview state for a form: the candidate, flagged unchanged when it equals the step on file. */
export function dockPreviewOf(stored: DesignSolidFeature, result: { readonly ok: true; readonly feature: DesignSolidFeature } | { readonly ok: false; readonly message: string }): DockPreview {
  if (!result.ok) return { invalid: result.message };
  return { feature: result.feature, changed: JSON.stringify(result.feature) !== JSON.stringify(stored) };
}
