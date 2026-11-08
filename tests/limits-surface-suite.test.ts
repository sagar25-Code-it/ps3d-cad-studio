import { splitPieceTests } from "./split-pieces.test.js";
import { holeThreadTests } from "./hole-thread.test.js";
import { reliefNotchTests } from "./relief-notch.test.js";
import type { TestCase } from "./test-kit.js";

/** Known-limit fixes, the surface layer and the SubD form: one suite so the shared runner needs a single line. */
export const limitsSurfaceTests: readonly TestCase[] = [
  ...splitPieceTests,
  ...holeThreadTests,
  ...reliefNotchTests
];
