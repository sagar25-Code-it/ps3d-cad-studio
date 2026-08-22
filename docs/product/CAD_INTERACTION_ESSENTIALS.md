# PS3D CAD interaction essentials

This checklist records the interaction systems expected in a serious CAD
workspace and the truth boundary of the independent PS3D implementation. It is
product research, not a source-code or visual-design specification. PS3D uses
its own controls, names, styling, data model, and implementation.

## Primary-source findings

- A persistent orientation control should expose standard and isometric views,
  a home view, and perspective/orthographic projection. Autodesk documents
  these interaction concepts in [About Orienting Views with the ViewCube](https://help.autodesk.com/cloudhelp/ENU/BIM-360/files/GUID-5C15A82B-E1CB-435A-87A2-C07D5512225B.htm).
- View navigation needs explicit pan, zoom, and orbit tools. Orbit moves the
  camera around a focal point, while pan moves the view parallel to the screen.
  See [About Navigation and the Navigation Bar](https://help.autodesk.com/cloudhelp/ENU/BIM-360/files/GUID-A25EDAB0-DB1A-46A3-8F7D-35F1D55D3531.htm).
- Selection systems need type filters, mutually exclusive selection priorities,
  and an explicit select-through boundary. See [Selection in Fusion](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION.htm)
  and [Use selection priority filters](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-PRIORITY-FILTERS.htm).
- Sketches need visible constrained status, dimensions, geometric constraints,
  grid/snap controls, profile visibility, and construction geometry controls.
  See [Sketches in Fusion](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-3D-SKETCH.htm),
  [Fully define and constrain sketches](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-FULLY-DEFINE-CONSTRAIN-SKETCH.htm),
  and [Use dimensions to control sketch curves](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/GUID-3C4D29F6-11D6-4AAC-8F08-8EAF1B780909.htm).
- Measurement should preserve the selected references and report coordinates,
  distance, and coordinate-system deltas. See [Measure objects](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MEASURE.htm).
- A broader inspect surface eventually includes section, interference, mass,
  curvature, draft, and surface-quality analysis. See [Analysis tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSPECT-TOOLS.htm).

## Implemented now

| System | PS3D behavior | Truth level |
| --- | --- | --- |
| Camera navigation | Select, orbit, pan, middle-button pan, Shift+middle/right-button orbit, wheel zoom, fit, and home | Preview |
| Named orientation | Front, back, left, right, top, bottom, and isometric camera snaps | Preview |
| Projection | Perspective and orthographic cameras with a shared target and fit radius | Preview |
| Orientation aids | Original PS3D view box, current-view label, WCS axis viewer, world grid, and scene axes | Preview |
| Selection controller | Auto, body, and component priority; unsupported face/edge filters remain visibly disabled | Preview |
| Point measurement | Two triangle-ray points, persistent markers, connecting line, XYZ points, XYZ delta, and Euclidean distance | Preview |
| Sketch palette | Grid, snap, profile, dimension, constraint, and construction display controls | Preview |
| Sketch dimensions | Driving line length, rectangle width/height, and circle radius; atomic geometry and constraint-record update | Preview |
| Constraint controller | Single and two-entity selection plus horizontal, vertical, parallel, perpendicular, collinear, concentric, equal, tangent, and fixed records | Preview |
| Constraint status | Visible records, glyphs, conflicts, per-entity freedom, and total degrees-of-freedom estimate | Preview |
| Keyboard navigation | `F` fit, `1` front, `2` top, `3` right, `4` isometric, `V` select, `O` orbit, `P` pan, `M` measure | Preview |

## Explicitly not claimed

- Face, edge, and vertex selection need persistent exact-topology identifiers.
- Window/crossing/freeform selection and select-through need a selection-volume
  implementation and occlusion policy.
- Angle, area, minimum-distance, and curve-length inspection need typed topology
  and reference-specific measurement algorithms.
- Section views, mass properties, curvature, zebra, draft, and thickness analysis
  need separately validated geometry algorithms.
- Pair constraints currently validate intent and update the explainable freedom
  model. They do not claim a general nonlinear geometric solve.
- Arc, angular, positional, and inter-entity driving dimensions remain future
  solver work.

Unavailable behavior must remain disabled or explicitly labeled until its
geometry, numerical tolerances, reference repair, and regression evidence are
defined.
