import { sketchEditClipboardTests } from "./sketch-edit-clipboard.test.js";
import { sketchEditCornerTests } from "./sketch-edit-corners.test.js";
import { sketchEditOffsetTests } from "./sketch-edit-offset.test.js";
import { sketchEditTransformTests } from "./sketch-edit-transform.test.js";
import { sketchEditTrimTests } from "./sketch-edit-trim.test.js";
import type { TestCase } from "./test-kit.js";

/** The sketch edit and modify tools work package: every audit repro as a regression test. */
export const sketchEditSuiteTests: readonly TestCase[] = [
  ...sketchEditCornerTests,
  ...sketchEditTrimTests,
  ...sketchEditOffsetTests,
  ...sketchEditTransformTests,
  ...sketchEditClipboardTests
];
