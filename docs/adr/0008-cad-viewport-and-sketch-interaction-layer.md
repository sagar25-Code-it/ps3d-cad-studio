# ADR 0008: CAD viewport and sketch interaction layer

- Status: accepted
- Date: 2026-08-19

## Context

The broad workbench exposed modeling commands but lacked the interaction systems
needed to inspect and control geometry: named camera views, projection control,
orientation aids, explicit navigation modes, selection priority, point
measurement, driving sketch dimensions, and an in-canvas sketch palette.

## Decision

PS3D owns an original interaction layer with three boundaries:

1. `viewport-three` owns camera state, orbit/pan/wheel input, projection,
   raycasting, selection filtering, measurement markers, and disposable scene
   display helpers.
2. `ViewportChrome` owns accessible screen-space controls: navigation and
   selection controller, named-view box, WCS axis viewer, display navigation
   bar, and measurement result panel.
3. Workbench project operations own durable sketch dimension and construction
   edits. Camera, grid, and measurement picks remain session presentation state
   and do not alter the semantic project.

Driving dimensions are deliberately bounded to line length, rectangle width and
height, and circle radius. They update the entity and its dimension record in a
single revision-checked operation. Pair constraints remain validated semantic
records and freedom-accounting inputs until a separately qualified nonlinear
solver exists.

## Consequences

- Named views and orthographic/perspective projection are deterministic and do
  not change model geometry.
- Measurement is based on actual visible triangle-ray intersections and returns
  WCS coordinates, delta values, and Euclidean distance.
- Body and component selection priorities are functional. Face and edge
  priority remain disabled because no persistent topology reference exists.
- The view box and axis viewer are original PS3D UI components; external CAD
  source code, icons, and assets are not used.
- More advanced selection, inspection, and solver work stays visibly outside
  the current claim.
