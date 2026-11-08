# CAD research audit: PDF spec vs PS3D CAD Studio

This audit holds the PDF "Architectural Blueprint and Feature Specification for 3D Parametric CAD Systems" (36 pages) against the code in this repository, tool by tool, so each line is honest about whether PS3D already has it, partly has it, or does not have it yet. The last column is the file or module the claim is based on.

## Legend

- **Have** - shipped in this repository and reachable from the UI.
- **Partial** - some of the specified modes or parameters are shipped; others are missing.
- **Missing** - not yet in the code.

## 1. System architecture (PDF Section 1)

| PDF requirement | Status | Where |
|---|---|---|
| Document and dependency graph (DAG) with transactional undo/redo | Have | `apps/studio-web/src/App.tsx` project history, `packages/workbench-core/src/operations.ts` audited ops, timeline |
| Parametric feature & property container, expression engine | Partial | `DesignHistory` holds features with parameters; expressions (`hole_d = 2 * pin_r`) not yet linked across features |
| Topological naming (Realthunder-style ElementMap) | Partial | `stableFaceKey` and `stableEntityToken` cover sketch faces and edges; a general ElementMap across every modeling op is still out |
| B-rep kernel (Parasolid / ASM / OCCT level) | Missing | We use the reference-runtime tessellator plus a mesh Boolean; no true persistent B-rep |
| Headless-ready MVC separation | Have | `packages/workbench-core` is kernel-adjacent; `apps/studio-web` is the view; the MCP server reuses the core headless |
| Six-stage sketch-to-part pipeline (Datum -> Solve -> Profile -> 3D feature -> TNP -> Tessellate) | Partial | Datum attachment to XY/XZ/YZ planes, their offsets and now face planes; constraint solver; profile detection; extrude/revolve; mesh-level tessellation. Topological naming for downstream references is partial. |

## 2. Sketch entity catalog (PDF Table 2)

| PDF entity | Status | Where / Gap |
|---|---|---|
| Point / Construction Point | Have | `point` in `SketchEntity`; `construction` flag on every entity |
| Profile / Polyline (continuous Line-Arc chain) | Partial | Line chain supported; arc chain not seamless with the Line tool |
| Line segment, Midpoint line | Partial | Line has one creation mode; dedicated Midpoint line (symmetric growth from a centre) is missing |
| Centerline / Infinite line / Route line | Missing | No dedicated centerline tool; construction toggle is the closest |
| Corner rectangle (2-point) | Have | `rectangle-two-point` |
| Center rectangle | Have | `rectangle-center` |
| 3-point rectangles (corner / centre) | Have | `rectangle-three-point` |
| Parallelogram, Rounded / Offset framing | Missing | No parallelogram tool, no rounded-corner rectangle option |
| Circle by centre and point | Have | `circle` |
| 3-point / Perimeter circle | Have | `circle-two-point`, `circle-three-point` |
| Centerpoint arc, 3-point arc, Tangent arc | Have | `arc`, `arc-center` and `arc-tangent` all wired in `workbench-sketch`'s SketchTool and the ribbon |
| Straight slot, Centerpoint slot | Have | `slot` is center-to-center; `slot-straight` (end-to-end + width) added as `buildSlotOverall` and wired in the ribbon |
| 3-point arc slot, Centerpoint arc slot | Missing | Curved slot variants missing |
| Regular polygon | Have | `polygon` |
| Ellipse, Elliptical arc | Have | `ellipse` is a first-class sketch entity (see `kind: "ellipse"` in `workbench-core`'s types and the Center ellipse ribbon tool) |
| Parabola, Hyperbola, Conic | Missing | Not critical for mechanical modelling |
| Interpolating / Fit-point spline | Have | `spline` with fit points |
| Control-point spline / Style spline | Missing | No control-polygon spline |
| Blend / Bridge curve, Equation / Law curve | Missing | No blend curve |
| Sketch text, Reusable sketch blocks | Missing | No text, no blocks |
| 3D sketch, Spline on surface | Missing | No 3D sketch |

## 3. Sketch modification tools (PDF Table 3)

| PDF tool | Status | Where / Gap |
|---|---|---|
| Sketch Fillet, Sketch Chamfer | Shipped | `edit-tool` offset, fillet and chamfer (equal-distance, two-distance and distance + angle) all wired |
| Trim, Extend, Make Corner, Delete Curve | Partial | Trim, Extend, Corner shipped; Delete Curve (auto-heal) missing |
| Split, Jogging | Missing | No split; no jog |
| Offset (D-Cubed PGM) | Have | `offset` sketch edit tool |
| Move Curve / Offset Move Curve | Partial | Drag is live-solve; offset-move (whole region) missing |
| Mirror | Have | `mirror` edit tool |
| Dynamic Mirror | Missing | Pre-select an axis and mirror future strokes live - not shipped |
| Make Path (chain for cams) | Missing | |
| Array / Polar / Move-Copy-Rotate-Scale-Stretch | Partial | Linear pattern shipped; Polar / Rotate / Scale / Stretch missing |
| Clipboard (Ctrl+C/X/V in a sketch) | Missing | |
| Convert / Project / Intersect / Silhouette / Face curves | Missing | No projection from a solid onto the sketch |
| Repair sketch / Validate sketch / SketchXpert | Partial | Health report flags over-defined sketches; interactive repair missing |

## 4. Geometric relations and dimensions (PDF Table 4)

| PDF constraint | Status | Where / Gap |
|---|---|---|
| Coincident / Point on object | Have | `coincident` |
| Midpoint | Have | `midpoint` |
| Horizontal / Vertical (auto) | Have | `horizontal`, `vertical` |
| Parallel, Perpendicular | Have | `parallel`, `perpendicular` |
| Tangent, Collinear | Have | `tangent`, `collinear` |
| Smooth / Equal curvature (G2) | Missing | Spline-specific; would need spline derivatives |
| Equal (length / radius) | Have | `equal` |
| Symmetric | Have | `symmetry` |
| Fix / Unfix / Lock / Block | Have | `fixed` |
| Pierce / Refraction | Missing | Needs 3D-curve-through-plane intersection |
| Spline helpers (tangent, curvature control, min radius) | Missing | |
| Smart dimension (D key, single unified tool) | Have | Sketch dimension tool |
| Horizontal / Vertical / Aligned distance | Have | Distance dimension |
| Radius, Diameter, Half-Diameter | Have | `radius` plus `distance` |
| Angle, Arc length, Perimeter | Partial | Angle via distance shim; true arc-length and perimeter dimensions missing |
| Chain, Baseline, Ordinate | Missing | |
| Driving vs Driven (Reference), Deactivate, Equations | Partial | `DimensionMode = "driving" \| "driven"` is wired on constraints; Suppress (Deactivate) is wired on every constraint; `fx` expression binding across features is still out |

## 5. Part / solid features (PDF Section 4)

| PDF feature | Status | Where / Gap |
|---|---|---|
| Extrude (Boss / Cut, Pad / Pocket, One-side, Symmetric, Through-all, To-face) | Partial | One-side, Symmetric, Flipped and Through-all for a cut shipped. To-face and To-vertex missing. |
| Revolve (One / Two / Symmetric / Thin, To-first / To-last) | Partial | Base revolve shipped; thin wall and "to" terminations missing |
| Sweep (section along path with twist control) | Shipped | Linear sweep (`sweepDirectionMm`), path-guided sweep along a sketch line/arc/spline (`sweepPathEntityId`), twist control (`sweepTwistDeg`, degrees across the whole sweep about the profile centroid) and perpendicular-to-tangent frame transport (`sweepFrameTransport`, central-differenced tangent per sample so the profile sits ⟂ to the path) are all shipped |
| Loft / Boundary (G0/G1/G2 continuity, rails, tangency weight) | Shipped | Scaled-top loft (`loftTopScale`) and two-profile loft (`loftSecondaryProfileIds`) are shipped with G0 / G1 / G2 continuity (linear / smoothstep / smootherstep), auto-resampling across mismatched vertex counts, an optional guide-curve rail (`loftRailEntityId`) that bends ring centroids away from the straight interpolation, and tangency-weight control (`loftTangencyWeight`, 0 → linear / 1 → full G1/G2 / 2 → punchy middle) |
| Helix / Coil / Thread | Missing | |
| Rib, Web, Emboss, Wrap | Missing | |
| Solid primitives (Box, Cylinder, Sphere, Cone, Torus, Ellipsoid, Prism, Wedge, Spiral, Tube) | Partial | Box, Cylinder, Sphere, Cone and Torus shipped (see `PartPreviewBodyShape` and `torusMesh`); Ellipsoid / Prism / Wedge / Spiral / Tube still missing |
| Hole / Hole Wizard (counterbore, countersink, threaded) | Missing | `set-part-parameter:holeDiameterMm` on the template plate only; no hole wizard |
| Dome, Indent, Flex, Scale | Missing | |
| Combine (Union, Cut, Intersect) | Have | `combine-general-bodies` with `mode: join|cut|intersect` |
| Fillet / Edge blend (constant radius, variable, G2) | Partial | `DesignSolidFeature.kind: "edge-fillet"` creates a solid with the fillet treatment applied through the same corner-treatment kernel path extrude already uses; true post-op edge picking (select an edge of an existing body and apply a fillet) still needs edge-selection UI |
| Chamfer (symmetric, asymmetric, offset+angle) | Partial | `DesignSolidFeature.kind: "edge-chamfer"` ships; symmetric only in this slice (the sketch-side chamfer already ships the three asymmetric/distance+angle modes) |
| Shell / Thickness | Partial | `DesignSolidFeature.kind: "shell"` hollows an extrude-class body with a wall thickness, open-top/open-bottom/fully-closed options via `shellThicknessMm` and `shellOpenFace`; only rectangular and circular profiles are supported in this slice |
| Draft | Partial | `DesignSolidFeature.kind: "draft"` produces a tapered prism with `draftAngleDeg` and `draftNeutralFace`; per-face selection is still out — the taper applies uniformly to every side face |
| Linear / Circular / Mirror pattern | Partial | `pattern-part-feature` and `mirror-part-feature` on the template plate; no general-body pattern |
| Surface / Patch tools, T-Splines | Missing | Surface workspace is a bezier preview, not a full surfacing layer |
| Synchronous direct editing (Move / Pull / Offset region / Replace face) | Partial | Move Body and Scale Body direct-edit feature kinds (`kind: "move-body"` / `"scale-body"`, `operation: "direct-edit"`) are shipped as first-class timeline steps that replay in order against the current body — Move translates every vertex by a stored (dx, dy, dz) delta, Scale uniformly scales about the body's current centroid. Pull/Offset face and Replace face still need a face picker and face-normal propagation |

## 6. Construction geometry (datums)

| PDF requirement | Status | Where / Gap |
|---|---|---|
| Offset plane | Have | Sketch-plane dialog carries `planeOffsetMm` |
| Plane at angle | Missing | |
| Tangent plane | Have | `ConstructionPlaneDefinition.kind: "tangent-to-cylinder"` ships: the plane sits on a revolve/extrude body's maximum-radius envelope at a chosen angle around its axis; origin is at the cylinder surface, normal is outward radial, in-plane axes line up with the body axis |
| Midplane | Missing | |
| Perpendicular plane | Missing | |
| Plane through two edges | Missing | |
| Plane through three points | Missing | |
| Plane along path | Missing | |
| Construction axes (5 modes) | Have | `ConstructionAxis` carries all five modes: `two-points`, `point-and-direction`, `plane-intersection`, `perpendicular-to-plane`, and `cylinder-axis` (donates the axis of a revolve or extrude body). Rendered as dashed line segments in the viewport; UCS not yet modelled |
| Construction points & UCS | Partial | `ConstructionPoint` ships `xyz`, `midpoint` and `axis-plane-intersection` modes with sphere rendering; UCS (user coordinate systems) still missing |
| Shape binder / Sub-shape binder | Missing | |

## 7. Work-window UX (PDF Table 7)

| PDF zone | Status | Where / Gap |
|---|---|---|
| Top command bar: workspace switcher, contextual ribbon, tab bar | Have | `WorkbenchHeader`, `WorkbenchRibbon` |
| Left docked navigator: model browser / feature tree | Have | `ProjectTree` |
| 4-Tab NX Sketch Navigator (Curves / Relations / External refs / Issues) | Have | `SketchNavigator` renders four tabs inside the Sketches section of the model browser when the Sketch workspace is active |
| Padlock icon on a fully constrained sketch | Have | `TreeItem`'s `trailingIcon="lock"` is wired via `isSketchFullyConstrained` on the working sketch and on each timeline sketch feature |
| Right / docked inspector: PropertyManager / Task panel | Have | `PartInspector`, sketch inspector |
| **Floating sketch palette (Fusion style)** | Have | `.sketch-palette` panel |
| Confirmation Corner (viewport-upper OK / Cancel) | Have | `.confirmation-corner` is pinned to the top-right of the sketch viewport; OK calls `finishSketch`, Cancel drops pending points and returns to Design |
| View Cube | Have | `ViewCube` inside `ViewportChrome` renders the six faces, edges and corners of a camera-synchronized cube with isometric Home and six face buttons |
| Cursor-centric HUD, marking menu, S-key toolbox | Partial | S opens the command palette; no marking menu |
| **On-view parameters (OVP) at the cursor** | Missing | Values are entered in the palette, not at the cursor |
| Parametric history timeline | Have | `TimelineBar` |
| Quick-measure status bar (edge length, face area, radius) | Have | `.quick-measure-bar` in `App.tsx` renders live edge / face metrics under the viewport |
| Menubar: File / Edit / Create / Modify / View / Inspect / Tools / Help | Have | `WorkbenchHeader` menus |

## 8. Inspect / diagnostics suite

| PDF tool | Status | Where / Gap |
|---|---|---|
| Zebra stripes (G0 / G1 / G2 / G3) | Missing | |
| Gaussian / mean curvature map | Missing | |
| Curvature comb | Missing | |
| Mass-inertia integrator (BRepGProp) | Partial | Volume, surface area, centroid, triangles computed by `solidMetrics`; mass (density) and full 3x3 inertia matrix missing |
| Geometry checker (BRepCheck) | Partial | Design-health report flags open / near-open profiles; full B-rep checks missing |
| Section analysis | Missing | |
| Interference detection | Partial | Only in the Assembly workspace |
| Draft angle / wall thickness / DFM | Missing | |

## 9. Sheet metal

Out of this repository entirely so far; the PDF devotes a full section to it (base flange, hem, miter, jog, unfold / fold, flat pattern, DXF / SVG export). This is a separate workspace stage - not addressed here.

## Summary - biggest gaps to close before pending Hole / Fillet / Chamfer / Shell

The audit entries below were re-checked against the code on 2026-11-07. Every item in the original
eight-point list is now shipped; this summary reflects the state of the code, not of the previous audit.

1. ~~Ellipse entity~~ — Shipped (`kind: "ellipse"` in `workbench-core` types; Center ellipse ribbon tool).
2. ~~Centerpoint arc and tangent arc tool modes~~ — Shipped (`arc-center`, `arc-tangent` with full geometry in `buildSketchEntity`, three-click input flow, ribbon entries).
3. ~~Straight slot mode~~ — Shipped (`slot-straight` in `SketchTool`, `buildSlotOverall` reuses `buildSlot` after pulling cap centres inward).
4. ~~Sketch chamfer~~ — Shipped: equal-distance, two-distance and distance + angle.
5. ~~Driven (reference) dimension toggle~~ — Wired as `DimensionMode = "driving" \| "driven"` on sketch constraints plus a per-constraint `suppressed` flag for Deactivate.
6. ~~Torus primitive~~ — Shipped (`PartPreviewBodyShape` includes `"torus"`; `torusMesh` in `workbench-geometry`).
7. ~~Padlock icon in the model browser~~ — Shipped (`TreeItem trailingIcon="lock"` driven by `isSketchFullyConstrained` on both the working sketch and every timeline sketch feature).
8. ~~Quick-measure status bar~~ — Shipped (`.quick-measure-bar` in `App.tsx`).

Additional UX items from Section 7 also closed in this slice:

- 4-tab Sketch Navigator (Curves / Relations / External refs / Issues) renders in the Sketches section when the Sketch workspace is active.
- Confirmation Corner (viewport-upper OK / Cancel) is pinned to the top-right of the sketch viewport.
- The ViewCube continues to render inside `ViewportChrome` for every 3D workspace with Home, named-view buttons, and drag-to-orbit.

Next audit-surface gaps (bigger, not yet in this slice): Sweep / Loft, Surface workspace beyond the bezier preview,
3D edge-fillet and chamfer (post-op edge picking), Shell, Draft, construction axes and construction points, and the
full 4-mode slot family (3-point arc slot and centerpoint arc slot).
