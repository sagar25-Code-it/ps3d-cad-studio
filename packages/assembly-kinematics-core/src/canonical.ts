/**
 * Type-only bridge to the canonical CAD document. No assembly-specific ID or
 * transform is allowed to fork the persistent document schema.
 */
export type {
  ComponentId,
  JointId,
  OccurrenceId
} from "../../cad-document-core/src/ids.js";
export type {
  Quaternion,
  Transform3,
  Vec3
} from "../../cad-document-core/src/types.js";

import type { Transform3 } from "../../cad-document-core/src/types.js";

export const ASSEMBLY_IDENTITY_TRANSFORM: Transform3 = {
  translationMeters: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1]
};
