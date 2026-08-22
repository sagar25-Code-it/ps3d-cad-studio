import type { Vec3 } from "../../workbench-core/src/index.js";

interface PrimitiveBase {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly opacity: number;
  readonly selectable: boolean;
}

export type PreviewPrimitive =
  | PrimitiveBase & {
      readonly kind: "box";
      readonly positionMm: Vec3;
      readonly rotationDeg: Vec3;
      /** Explicit renderer Euler order; omitted preserves the historical XYZ convention. */
      readonly rotationOrder?: "XYZ" | "ZYX";
      readonly sizeMm: Vec3;
    }
  | PrimitiveBase & {
      readonly kind: "cylinder";
      readonly positionMm: Vec3;
      readonly rotationDeg: Vec3;
      /** Explicit renderer Euler order; omitted preserves the historical XYZ convention. */
      readonly rotationOrder?: "XYZ" | "ZYX";
      readonly radiusMm: number;
      readonly heightMm: number;
      readonly radialSegments: number;
    }
  | PrimitiveBase & {
      readonly kind: "mesh";
      readonly positionsMm: readonly number[];
      readonly indices: readonly number[];
      readonly wireframe: boolean;
      readonly doubleSided: boolean;
    }
  | PrimitiveBase & {
      readonly kind: "line";
      readonly pointsMm: readonly number[];
      /** Optional deduplicated segment pairs: x1,y1,z1,x2,y2,z2 for each rendered branch. */
      readonly segmentsMm?: readonly number[];
      readonly dashed: boolean;
      /** Visual-only conductor radius. Omitted for control nets and construction guides. */
      readonly radiusMm?: number;
    };

export interface PreviewBounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly size: Vec3;
}

export interface PreviewScene {
  readonly id: string;
  readonly kind: "assembly" | "surface";
  readonly primitives: readonly PreviewPrimitive[];
  readonly boundsMm: PreviewBounds;
}

export interface InterferenceCandidate {
  readonly componentIds: readonly [string, string];
  readonly overlapMm: Vec3;
  readonly volumeCubicMm: number;
  readonly conservative: true;
}

export interface SurfaceMetrics {
  readonly vertices: number;
  readonly triangles: number;
  readonly boundaryEdges: number;
  readonly approximateAreaSquareMm: number;
  readonly maximumNormalVariationDeg: number;
  readonly finite: true;
}

export interface SurfacePreview {
  readonly scene: PreviewScene;
  readonly metrics: SurfaceMetrics;
  readonly controlNet: readonly Vec3[];
}
