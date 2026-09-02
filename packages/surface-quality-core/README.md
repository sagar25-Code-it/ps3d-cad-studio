# Surface quality core

`@ps3d/surface-quality-core` is the semantic and validation boundary for exact
surface construction and surface-quality inspection. It does not contain a
mesh approximation, a mock CAD kernel, or fallback numerical analysis.

The package provides:

- typed requests for surface extrude, revolve, sweep, loft, patch, offset,
  trim, extend, stitch, and thicken operations;
- G0/G1/G2 boundary goals with explicit positional, angular, and curvature
  tolerances;
- guide-rail, centerline, edge-match, trim-loop, and stitch-gap contracts;
- zebra, reflection-line, Gaussian/mean curvature, draft, and curvature-comb
  analysis contracts;
- deterministic request, result, dependency, invalidation, and receipt hashes;
- strict runtime validation before and after an exact backend call.

## Exact-backend rule

All output geometry and all numeric analysis values must be produced by an
injected `ExactSurfaceBackend`. Creating a service without a backend throws
`EXACT_BACKEND_REQUIRED`. A backend response is rejected when its request
digest is stale, it does not assert exact-geometry provenance, it contains
non-finite numeric values, or it returns the wrong operation/analysis kind.

This is deliberate: UI previews may display sampled fields, polylines, and
combs, but this package never manufactures those samples or silently replaces
an exact evaluation with a mesh heuristic.

```ts
import { createSurfaceQualityService } from "./src/index.js";

const surfaces = createSurfaceQualityService(openCascadeSurfaceBackend);
const evaluated = await surfaces.evaluateFeature(loftRequest);
const zebra = await surfaces.analyze(zebraRequest);
```

Topology selections use the stable exact-kernel references from
`@ps3d/exact-kernel-api`. A receipt records the selected shape and topology
lineage keys, so a document rebuild can invalidate only affected surface
features and analysis artifacts.

## Scope boundary

The package is a production contract, not a claim that OpenCascade or another
exact evaluator is already connected. Backend qualification, persistent
topology resolution, UI rendering, and worker transport belong in their own
adapters. Until such an adapter is injected, evaluation fails explicitly.
