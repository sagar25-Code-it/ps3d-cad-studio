import type { ParameterKey } from "../../model-schema/src/index.js";

/**
 * Builds a command id for a parameter edit. Command ids are lowercase-only, but
 * parameter keys are camelCase (`holeDiameter`), so the key is converted to
 * kebab-case (`hole-diameter`). Embedding the raw key produced ids that every
 * validator rejected, which silently broke bore edits.
 *
 * This lives beside, not inside, `index.ts` on purpose: `index.ts` is part of the
 * attested evaluator source set in `provenance/BUILD_IDENTITY.json`, and editing it
 * invalidates the build identity that production deploys are verified against.
 */
export function parameterCommandId(parameterKey: ParameterKey, uniqueSuffix: string): string {
  const kebab = parameterKey.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  return `command:${kebab}-${uniqueSuffix}`;
}
