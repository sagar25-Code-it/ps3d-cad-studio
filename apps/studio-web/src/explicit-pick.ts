import type { DesignHistory, DesignSketchFeature } from "../../../packages/workbench-core/src/index.js";

/**
 * PT-02: a command never acts on a body, tool or sketch the user did not pick. These helpers resolve what the user
 * meant: the selected thing, or the only candidate (nothing else it could mean), and otherwise a message naming what
 * to select, never a silent first-in-the-list choice.
 */

export type ExplicitPick<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** The body a command acts on: the selected one, else the only one; with several and none selected it refuses. */
export function explicitBody<T extends { readonly id: string; readonly name: string }>(
  bodies: readonly T[],
  selectedId: string | null,
  command: string
): ExplicitPick<T> {
  const selected = bodies.find((candidate) => candidate.id === selectedId);
  if (selected !== undefined) return { ok: true, value: selected };
  if (bodies.length === 1) return { ok: true, value: bodies[0]! };
  if (bodies.length === 0) return { ok: false, message: `${command}: create a solid body first.` };
  return { ok: false, message: `${command}: select which solid first (${bodies.map((body) => body.name).join(", ")}).` };
}

/** The finished, unsuppressed timeline sketches that satisfy `wanted`, newest first. Sketches after the rollback marker do not exist yet at that point, so a new step cannot use them (HS-12). */
export function matchingSketches(history: DesignHistory, wanted: (sketch: DesignSketchFeature) => boolean): readonly DesignSketchFeature[] {
  const found: DesignSketchFeature[] = [];
  for (let index = Math.min(history.rollbackIndex, history.features.length) - 1; index >= 0; index -= 1) {
    const feature = history.features[index]!;
    if (feature.kind === "sketch" && !feature.suppressed && wanted(feature)) found.push(feature);
  }
  return found;
}

/** The sketch a typed answer means, by name or id; an empty answer means the offered default. */
export function sketchByAnswer(candidates: readonly DesignSketchFeature[], answer: string): DesignSketchFeature | undefined {
  const trimmed = answer.trim();
  if (trimmed === "") return candidates[0];
  return candidates.find((candidate) => candidate.name === trimmed || candidate.id === trimmed)
    ?? candidates.find((candidate) => candidate.name.toLowerCase() === trimmed.toLowerCase());
}

/**
 * The profiles a typed answer means, for a sketch with several closed regions: "all" (or an empty answer) is every
 * profile (stored as an empty list, the existing meaning), and numbers such as "1 3" pick those profiles in the
 * detector's order. Anything else is undefined: refused, never a silent first profile.
 */
export function profilesByAnswer(profiles: readonly { readonly id: string }[], answer: string): readonly string[] | undefined {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return [];
  const parts = trimmed.split(/[\s,]+/u).filter((part) => part.length > 0);
  const ids: string[] = [];
  for (const part of parts) {
    const ordinal = /^p?(\d+)$/u.exec(part);
    if (ordinal === null) return undefined;
    const profile = profiles[Number.parseInt(ordinal[1]!, 10) - 1];
    if (profile === undefined) return undefined;
    if (!ids.includes(profile.id)) ids.push(profile.id);
  }
  return ids.length === 0 ? undefined : ids;
}

/** What the Combine dialog opens with: the body the user had selected as the target, and no tool until one is chosen. */
export function combineInitialChoice(
  bodies: readonly { readonly id: string }[],
  initialTargetId: string | undefined
): { readonly targetId: string; readonly toolId: string } {
  const target = initialTargetId !== undefined && bodies.some((body) => body.id === initialTargetId) ? initialTargetId : "";
  return { targetId: target, toolId: "" };
}
