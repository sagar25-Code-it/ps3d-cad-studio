/**
 * Limits of the one-number analytic Part tools (Edge Blend, Chamfer, Resize Blend, Trim Body). The tools used to clamp a typed value
 * to these limits and report the clamped number as if it were the typed one; a value outside a limit is now refused with the
 * limit named, and nothing is applied. The numbers match what the project operation itself enforces (part-features.ts).
 */

/** Thinnest wall the analytic tools keep, in mm (the same floor the project operation uses). */
export const ANALYTIC_MIN_WALL_MM = 0.5;

function mm(value: number): string {
  return `${Number(value.toFixed(2))} mm`;
}

/** The largest edge blend or chamfer on a plain block: half its narrower side, less the minimum wall. */
export function blendLimitMm(sizeMm: readonly [number, number, number]): number {
  return Math.min(sizeMm[0], sizeMm[1]) / 2 - ANALYTIC_MIN_WALL_MM;
}

/** A refusal naming the limit, or undefined when the typed size can be applied exactly as typed. */
export function blendSizeProblem(bodyName: string, label: string, typedMm: number, sizeMm: readonly [number, number, number]): string | undefined {
  const limit = blendLimitMm(sizeMm);
  if (!Number.isFinite(typedMm) || typedMm <= 0) return `${label} must be greater than 0 mm; nothing was applied to ${bodyName}.`;
  if (limit <= 0) return `${bodyName} is too narrow for a ${label.toLowerCase()} (half its narrower side must leave ${mm(ANALYTIC_MIN_WALL_MM)} of wall); nothing was applied.`;
  if (typedMm > limit) return `${label} ${mm(typedMm)} is more than ${bodyName} allows: at most ${mm(limit)} (half its narrower side less ${mm(ANALYTIC_MIN_WALL_MM)}). Nothing was applied; enter ${mm(limit)} or less.`;
  return undefined;
}

/** What Resize Blend would set next (one more half millimetre), or a refusal when that is past the limit. */
export function resizeBlendNext(bodyName: string, currentMm: number, sizeMm: readonly [number, number, number]): { readonly ok: true; readonly sizeMm: number } | { readonly ok: false; readonly message: string } {
  const limit = blendLimitMm(sizeMm);
  const next = currentMm + 0.5;
  if (next > limit) return { ok: false, message: `Resize Blend: ${bodyName} cannot grow past ${mm(limit)} (half its narrower side less ${mm(ANALYTIC_MIN_WALL_MM)}); it is already ${mm(currentMm)}. Nothing was changed.` };
  return { ok: true, sizeMm: next };
}

/** A refusal for a Trim Body kept length that would remove nothing or everything, or undefined. */
export function trimKeptProblem(bodyName: string, keptMm: number, heightMm: number): string | undefined {
  if (!Number.isFinite(keptMm) || keptMm <= 0) return `Trim Body: the kept length must be greater than 0 mm; ${bodyName} was not changed.`;
  if (keptMm >= heightMm) return `Trim Body: the kept length ${mm(keptMm)} must be shorter than ${bodyName}'s height of ${mm(heightMm)}, or nothing is removed. ${bodyName} was not changed.`;
  return undefined;
}
