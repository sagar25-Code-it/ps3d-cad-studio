import type { OccurrenceId, Transform3, Vec3 } from "./canonical.js";
import { addVec3, magnitudeVec3, normalizeVec3, scaleVec3, withTranslatedTransform } from "./math.js";
import type {
  AssemblyDiagnostic,
  AssemblyEnvelope,
  AssemblyResult,
  ExplodedInterpolation,
  ExplodedRepresentation
} from "./types.js";

function invalid(message: string, relatedIds: readonly string[], recovery: string): AssemblyDiagnostic {
  return { code: "INVALID_EXPLODED_REPRESENTATION", severity: "error", message, relatedIds, recovery };
}

export function interpolateExplodedRepresentation(
  baseTransforms: Readonly<Record<string, Transform3>>,
  representation: ExplodedRepresentation,
  envelope: AssemblyEnvelope | null,
  requestedFraction: number
): AssemblyResult<ExplodedInterpolation> {
  const diagnostics: AssemblyDiagnostic[] = [];
  if (envelope === null
    || !envelope.dimensionsMeters.every((value) => Number.isFinite(value) && value >= 0)
    || Math.max(...envelope.dimensionsMeters) <= 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "MISSING_ENVELOPE",
        severity: "error",
        message: "Exploded interpolation requires caller-supplied, finite assembly envelope dimensions.",
        relatedIds: [representation.id],
        recovery: "Measure the qualified assembly geometry and provide its envelope; this layer will not invent bounds."
      }]
    };
  }
  if (!Number.isFinite(requestedFraction)
    || !Number.isFinite(representation.maximumEnvelopeFraction)
    || representation.maximumEnvelopeFraction < 0
    || representation.maximumEnvelopeFraction > 1) {
    return {
      ok: false,
      diagnostics: [invalid(
        "Exploded fractions must be finite and the envelope cap must be between 0 and 1.",
        [representation.id],
        "Use a finite interpolation fraction and maximumEnvelopeFraction in [0, 1]."
      )]
    };
  }

  const fraction = Math.min(1, Math.max(0, requestedFraction));
  const offsets = new Map<OccurrenceId, Vec3>();
  for (const step of representation.steps) {
    const direction = normalizeVec3(step.direction);
    if (baseTransforms[step.occurrenceId] === undefined
      || direction === null
      || !Number.isFinite(step.requestedDistanceMeters)
      || step.requestedDistanceMeters < 0
      || !Number.isFinite(step.startFraction)
      || !Number.isFinite(step.endFraction)
      || step.startFraction < 0
      || step.endFraction > 1
      || step.startFraction >= step.endFraction) {
      diagnostics.push(invalid(
        `Exploded step for '${step.occurrenceId}' has a missing occurrence, zero direction, invalid distance, or invalid interval.`,
        [representation.id, step.occurrenceId],
        "Repair the occurrence, direction, requested distance, and 0..1 step interval."
      ));
      continue;
    }
    const localFraction = Math.min(1, Math.max(0, (fraction - step.startFraction) / (step.endFraction - step.startFraction)));
    const offset = scaleVec3(direction, step.requestedDistanceMeters * localFraction);
    offsets.set(step.occurrenceId, addVec3(offsets.get(step.occurrenceId) ?? [0, 0, 0], offset));
  }
  if (diagnostics.some(({ severity }) => severity === "error")) return { ok: false, diagnostics };

  const maximumDistance = Math.max(...envelope.dimensionsMeters) * representation.maximumEnvelopeFraction;
  const transforms: Record<string, Transform3> = { ...baseTransforms };
  const appliedDistancesMeters: Record<string, number> = {};
  for (const [occurrenceId, requestedOffset] of [...offsets.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const magnitude = magnitudeVec3(requestedOffset);
    const scale = magnitude > maximumDistance && magnitude > 0 ? maximumDistance / magnitude : 1;
    const appliedOffset = scaleVec3(requestedOffset, scale);
    const base = baseTransforms[occurrenceId];
    if (base === undefined) continue;
    transforms[occurrenceId] = withTranslatedTransform(base, appliedOffset);
    appliedDistancesMeters[occurrenceId] = magnitudeVec3(appliedOffset);
  }
  return { ok: true, value: { fraction, transforms, appliedDistancesMeters }, diagnostics };
}
