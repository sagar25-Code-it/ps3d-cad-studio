/**
 * Every size limit of the model in one place, with no imports, so a layer that cannot import the validators (the arc geometry the
 * validators themselves use, the sketch profile engine, the browser file workspace, the remote MCP transport) still reads the same
 * number. The documented envelope in envelope.ts and WORKBENCH_LIMITS in validation.ts are built from these constants.
 *
 *  - Geometry: coordinates up to +/-100 m, nothing smaller than 0.01 mm (and the profile engine closes and keeps regions that small).
 *  - Bytes: a project file is at most PROJECT_FILE_MAX_BYTES whether it is saved, opened, listed or parsed; one MCP call (the
 *    project plus the operation plus the receipt) is at most MCP_CALL_MAX_BYTES on the local server and on the deployed transport.
 */
export const ENVELOPE_LIMITS = {
  /** The smallest feature a sketch holds: a line, a radius, a rectangle side, a gap between spline fit points. */
  minGeometryMm: 0.01,
  maxSketchCoordinateMm: 100_000,
  maxSketchSizeMm: 200_000,
  maxSketchRadiusMm: 100_000,
  maxSketchLongMm: 400_000,
  maxFeatureDistanceMm: 100_000,
  maxPlaneOffsetMm: 100_000,
  maxBodyCoordinateMm: 1_000_000
} as const;

/** A project file as Save writes it, Open reads it and the validators accept it (decimal megabytes, so the message and the number agree). */
export const PROJECT_FILE_MAX_BYTES = 50_000_000;

/**
 * What one MCP tool call may carry. The deployed transport sits behind a serverless host that refuses request bodies over 4.5 MB, so
 * the local and the remote server share a 4 MB cap with a margin.
 */
export const MCP_CALL_MAX_BYTES = 4_000_000;

/** A short, honest description of a byte limit for messages: "50 MB", "4 MB". */
export function describeByteLimit(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}
