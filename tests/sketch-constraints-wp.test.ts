import { sketchDimensionWpTests } from "./sketch-dimensions-wp.test.js";
import { sketchG2WpTests } from "./sketch-g2-wp.test.js";
import { sketchPierceWpTests } from "./sketch-pierce-wp.test.js";
import type { TestCase } from "./test-kit.js";

/** The constraints-and-dimensions work package: dimensions, G2 and spline helpers, pierce and refraction. */
export const sketchConstraintsWpTests: readonly TestCase[] = [...sketchDimensionWpTests, ...sketchG2WpTests, ...sketchPierceWpTests];
