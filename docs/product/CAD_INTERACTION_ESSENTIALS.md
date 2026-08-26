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
- A professional sketch remains part of the same design document and may be
  inspected with orbit, pan, zoom, Fit, and Look At while its geometry stays on
  the active sketch plane. Autodesk documents the corresponding 2D/3D sketch
  interaction in [Create a 3D sketch](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-3D-SKETCH.htm).
- Solid Extrude distinguishes Join, Cut, Intersect, New Body, and New Component
  and keeps the source profile associative. See [Extrude a solid body](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EXTRUDE-SOLID.htm).
- Components, sketches, bodies, and assembly relationships coexist in one
  design document. See [Components](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-COMPONENTS.htm).

These references describe user-facing interaction concepts only. PS3D does not
copy Autodesk or Siemens code, icons, artwork, labels, layouts, or proprietary
assets.

## Unified interaction contract

1. The document uses one right-handed, Z-up WCS: X red, Y green, and Z blue.
   The grid, origin axes, lower WCS viewer, ViewCube, named views, and camera
   projection all derive from the same camera basis.
2. Orbit changes the camera, never the WCS or model. Sketch orbit changes only
   the view; `Look At` returns normal to the active XY sketch plane.
3. Sketch, Part, Surface, and Assembly are toolbar contexts over one document,
   canvas, selection model, camera state, revision history, and undo boundary.
4. Sketch selection intent is explicit: Profile, Curve, Connected, or Tangent.
   A closed selected profile can pass directly to Extrude with its source ID.
5. `New Body` and `New Component` are functional in the bounded kernel. Join,
   Cut, and Intersect remain visible but disabled unless a future exact B-rep
   kernel can prove overlap and preserve stable topology.
6. The browser separates Origin, Sketches, Feature History, Bodies, Components,
   and Mates, and exposes the selected node's parent and children.
7. Right-click commands are resolved from workspace, selection kind, selection
   count, and capability truth. Canvas, sketch, body, component, and mate menus
   therefore expose different commands while sharing stable command IDs.
8. An MCP client must first read `ps3d://guide/ai-collaboration` and return the
   current guide digest with `understood: true` before any preview or apply tool
   is accepted. A stale or missing acknowledgement fails closed.

## Implemented now

| System | PS3D behavior | Truth level |
| --- | --- | --- |
| Camera navigation | Select, orbit, pan, middle-button pan, Shift+middle-button orbit, wheel zoom, fit, and home; pointer direction follows the displayed camera motion | Preview |
| Named orientation | Front, back, left, right, top, bottom, and isometric camera snaps | Preview |
| Projection | Perspective and orthographic cameras with a shared target and fit radius | Preview |
| Orientation aids | Camera-driven six-face/twelve-edge/eight-corner ViewCube, current-view label, synchronized WCS axis viewer, world grid, and scene axes | Preview |
| Selection controller | Auto, body, component, profile, curve, connected-chain, and tangent-chain intent; unsupported persistent face/edge filters remain visibly disabled | Preview |
| Point measurement | Two triangle-ray points, persistent markers, connecting line, XYZ points, XYZ delta, and Euclidean distance | Preview |
| Sketch palette | Grid, snap, profile, dimension, constraint, and construction display controls | Preview |
| Sketch dimensions | Driving line length, rectangle width/height, and circle radius; atomic geometry and constraint-record update | Preview |
| Constraint controller | Single and two-entity selection plus horizontal, vertical, parallel, perpendicular, collinear, concentric, equal, tangent, and fixed records | Preview |
| Constraint status | Visible records, glyphs, conflicts, per-entity freedom, and total degrees-of-freedom estimate | Preview |
| Sketch handoff | Closed profile selection opens Extrude; New Body and New Component produce a revision-linked output while preserving the source sketch relationship | Preview |
| Unified tree | Document, Origin, Sketches, Feature History, Bodies, Components, Mates, and parent/child relationship panels share canvas selection | Preview |
| Context commands | Workspace- and selection-aware canvas/tree menus use stable IDs and explain unavailable topology-dependent operations | Preview |
| Assembly relationships | Add/delete direct mate records in the common document; records are inspectable but are not claimed as a solved kinematic system | Preview |
| MCP prerequisite | Versioned guide digest acknowledgement is required for preview/apply calls over local stdio and authenticated remote MCP | Qualified protocol guard |
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
- Assembly mate records are durable relationships, but they do not yet drive a
  general six-degree-of-freedom kinematic solver.
- Join, Cut, and Intersect require an exact B-rep Boolean engine, target-body
  overlap detection, tolerance policy, and persistent face/edge identity.
- Connected selection at branching vertices needs a future direction chooser;
  the bounded implementation reports branch count rather than silently claiming
  an arbitrary professional chain result.
- Arc, angular, positional, and inter-entity driving dimensions remain future
  solver work.

Unavailable behavior must remain disabled or explicitly labeled until its
geometry, numerical tolerances, reference repair, and regression evidence are
defined.
