/** How many fit points a sketch fit-point spline may hold. The limit used to be 24; dense conic and blend fits need more. */
export const SPLINE_MIN_FIT_POINTS = 3;
export const SPLINE_MAX_FIT_POINTS = 64;

/** The same two limits under the names the on-canvas spline editing uses. */
export const MAX_SPLINE_FIT_POINTS = SPLINE_MAX_FIT_POINTS;
export const MIN_SPLINE_FIT_POINTS = SPLINE_MIN_FIT_POINTS;
