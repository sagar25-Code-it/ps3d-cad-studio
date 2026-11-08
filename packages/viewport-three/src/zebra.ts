/**
 * Zebra-stripe analysis: the surface is shaded with the black and white bands of a striped environment seen in its
 * reflection. A smooth (G1) joint shows stripes that run straight across the seam, a tangent break shows them kinking, and a
 * curvature (G2) break shows them meeting at the same angle but bending differently on either side.
 *
 * This file has no three.js import so the maths can be tested in Node; `ZEBRA_FRAGMENT_SOURCE` is the GLSL mirror of
 * `zebraBandAt` that the viewport injects into its standard material.
 */

export type ZebraAxis = "x" | "y" | "z";

export interface ZebraOptions {
  readonly axis: ZebraAxis;
  /** Stripes per unit of the reflection vector's component along the axis (about twice the number of black bands across a flat mirror). */
  readonly frequency: number;
}

export const ZEBRA_DEFAULT: ZebraOptions = { axis: "z", frequency: 6 };
export const ZEBRA_AXES: readonly ZebraAxis[] = ["x", "y", "z"];
export const ZEBRA_MIN_FREQUENCY = 1;
export const ZEBRA_MAX_FREQUENCY = 40;

type Vec3 = readonly [number, number, number];

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 1e-12 ? [0, 0, 0] : [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** The mirror reflection of the view ray about the surface normal, in the space both vectors are given in. */
export function zebraReflection(toCamera: Vec3, normal: Vec3): Vec3 {
  const v = normalize(toCamera);
  const n = normalize(normal);
  const along = 2 * (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]);
  return normalize([n[0] * along - v[0], n[1] * along - v[1], n[2] * along - v[2]]);
}

/** 0 for a dark band and 1 for a light band at a surface point, from the world-space view direction and normal. */
export function zebraBandAt(toCamera: Vec3, normal: Vec3, options: ZebraOptions): 0 | 1 {
  const reflection = zebraReflection(toCamera, normal);
  const component = reflection[options.axis === "x" ? 0 : options.axis === "y" ? 1 : 2];
  const phase = component * options.frequency;
  return phase - Math.floor(phase) >= 0.5 ? 1 : 0;
}

export function clampZebraFrequency(frequency: number): number {
  return Number.isFinite(frequency) ? Math.min(ZEBRA_MAX_FREQUENCY, Math.max(ZEBRA_MIN_FREQUENCY, frequency)) : ZEBRA_DEFAULT.frequency;
}

export function axisVector(axis: ZebraAxis): Vec3 {
  return axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

/** GLSL declarations that go before `void main()` in the fragment shader of a MeshStandardMaterial. */
export const ZEBRA_UNIFORMS_SOURCE = "uniform vec3 uZebraAxis;\nuniform float uZebraFrequency;\n";

/** GLSL that replaces the lit colour with the zebra band; it runs right after `opaque_fragment`, where `normal` is in view space. */
export const ZEBRA_FRAGMENT_SOURCE = `
{
  vec3 zebraReflection = reflect( -normalize( vViewPosition ), normalize( normal ) );
  vec3 zebraWorld = normalize( ( vec4( zebraReflection, 0.0 ) * viewMatrix ).xyz );
  float zebraPhase = dot( zebraWorld, uZebraAxis ) * uZebraFrequency;
  float zebraBand = step( 0.5, fract( zebraPhase ) );
  gl_FragColor = vec4( vec3( mix( 0.05, 0.95, zebraBand ) ), diffuseColor.a );
}
`;
