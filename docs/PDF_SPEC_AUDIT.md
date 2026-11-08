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
| Array / Polar / Move-Copy-Rotate-Scale-Stretch | Shipped | Rectangular and circular (polar) patterns, Move / Copy, Rotate, Scale and Stretch are sketch edit tools (`patternEntities`, `transformEntities`, `stretchEntities`). Each in-place edit is solved against the sketch relations and refused if it would break one. Stretch moves only what lies inside a window (line ends, arc and spline points, circles and points by centre, rectangle sides that lie fully inside, which resize the rectangle). With Stretch active, dragging on empty canvas draws the window (orange, dashed) and fills its four corner fields; typing the corners draws the same rectangle, and "Use selection bounds" is a third way in |
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
| Angle, Arc length, Perimeter | Partial | Angle via distance shim; `drivenDimensionLayout(entity, "arc-length" \| "perimeter", pxMm)` in `packages/workbench-sketch/src/dimension-layout.ts` now returns a reference-dimension layout for arc length (lines + 3-point arcs) and perimeter (rectangles + circles). A UI binding for the Sketch Dimension tool is still to come |
| Chain, Baseline, Ordinate | Shipped | `DrawingSettings.dimensionStyle` ships `"individual"` (the legacy single-callout default), `"chain"` (two or more end-to-end linear dimensions), `"baseline"` (several dimensions from a common origin) and `"ordinate"` (coordinate readouts along both axes from the view's lower-left datum). `DrawingDimensionKind` gains `"linear-chain"`, `"linear-baseline"` and `"ordinate"` so saved plans tag the style of each dimension record |
| Driving vs Driven (Reference), Deactivate, Equations | Partial | `DimensionMode = "driving" \| "driven"` is wired on constraints; Suppress (Deactivate) is wired on every constraint; `fx` expression binding across features is still out |

## 5. Part / solid features (PDF Section 4)

| PDF feature | Status | Where / Gap |
|---|---|---|
| Extrude (Boss / Cut, Pad / Pocket, One-side, Symmetric, Through-all, To-face) | Partial | One-side, Symmetric, Flipped and Through-all for a cut shipped. To-face and To-vertex missing. |
| Revolve (One / Two / Symmetric / Thin, To-first / To-last) | Partial | Base revolve shipped; thin wall and "to" terminations missing |
| Sweep (section along path with twist control) | Shipped | Linear sweep (`sweepDirectionMm`), path-guided sweep along a sketch line/arc/spline (`sweepPathEntityId`), twist control (`sweepTwistDeg`, degrees across the whole sweep about the profile centroid) and perpendicular-to-tangent frame transport (`sweepFrameTransport`, central-differenced tangent per sample so the profile sits ⟂ to the path) are all shipped |
| Loft / Boundary (G0/G1/G2 continuity, rails, tangency weight) | Shipped | Scaled-top loft (`loftTopScale`) and two-profile loft (`loftSecondaryProfileIds`) are shipped with G0 / G1 / G2 continuity (linear / smoothstep / smootherstep), auto-resampling across mismatched vertex counts, an optional guide-curve rail (`loftRailEntityId`) that bends ring centroids away from the straight interpolation, and tangency-weight control (`loftTangencyWeight`, 0 → linear / 1 → full G1/G2 / 2 → punchy middle) |
| Helix / Coil / Thread | Shipped | `DesignSolidFeature.kind: "helix"` winds a sketch profile (coil radius / pitch / turns / handedness). `DesignSolidFeature.kind: "thread"` ships a helical V-section ridge with `threadPitchMm`, `threadTurns`, `threadDepthMm` and `threadHandedness` — the builder synthesizes the triangular thread section automatically |
| Rib, Web, Emboss, Wrap | Partial | `DesignSolidFeature.kind: "rib"` (thin-wall extrude with `ribThicknessMm` and `ribDirection`) and `DesignSolidFeature.kind: "emboss"` (direct-edit vertex transform on a target brep face, with a cosine falloff from the centroid and `embossHeightMm` controlling raise/depress along the face normal) are shipped. Web is Rib's near-identical sibling (deferred to a labeled Rib). Wrap (2D sketch wrapped around a cylindrical face) still needs the 3D-sketch stage |
| Solid primitives (Box, Cylinder, Sphere, Cone, Torus, Ellipsoid, Prism, Wedge, Spiral, Tube) | Partial | Box, Cylinder, Sphere, Cone and Torus shipped (see `PartPreviewBodyShape` and `torusMesh`); Ellipsoid / Prism / Wedge / Spiral / Tube still missing |
| Hole / Hole Wizard (counterbore, countersink, threaded) | Shipped | `kind: "hole"` is a timeline step: the Hole Wizard asks you to click the face where the hole starts, then takes the type (simple, counterbore, countersink or tapped) and an M3 to M10 fastener size. The click records the start point and the face normal (`holePositionMm`, `holeNormal`; a normal within a hair of an axis is snapped onto it), and `holeCutter` spins a radius-against-depth profile about that axis into a closed cutter that `booleanMeshes` subtracts, so it works from any face, blind or through all (depth 0). Counterbore and countersink carry their pocket or cone (`holeCounterDiameterMm`, `holeCounterDepthMm`, `holeSinkDiameterMm`, `holeSinkAngleDeg`); a tapped hole is a plain hole at the tap-drill diameter. Double-click the step to move it or change its numbers; suppress, roll back and save/load all work. A body that is not in the timeline keeps the older whole-body version. The thread itself is not modelled |
| Dome, Indent, Flex, Scale | Partial | `kind: "dome"` is a true rounded dome: `tessellateDome` raises rings of the profile scaled by cos(φ) to height·sin(φ) and closes them with an apex fan, so a circular profile is a half-ellipsoid (volume checked against 2/3 π r³) and a negative height domes below the plane. `kind: "indent"` boolean-subtracts a second solid chosen by name (ribbon Indent). `kind: "scale-body"` is Scale. Flex still needs a bending kernel |
| Combine (Union, Cut, Intersect) | Have | `combine-general-bodies` with `mode: join|cut|intersect` |
| Fillet / Edge blend (constant radius, variable, G2) | Partial | `DesignSolidFeature.kind: "edge-fillet"` creates a solid with the fillet treatment applied through the same corner-treatment kernel path extrude already uses; variable radius is stored via the optional `edgeEndSizeMm` field (start radius → end radius along the vertical edge). True post-op edge picking and mesh-level lerped radii still need the edge-selection UI |
| Chamfer (symmetric, asymmetric, offset+angle) | Partial | `DesignSolidFeature.kind: "edge-chamfer"` ships; symmetric only in this slice (the sketch-side chamfer already ships the three asymmetric/distance+angle modes) |
| Shell / Thickness | Partial | `DesignSolidFeature.kind: "shell"` hollows an extrude-class body with a wall thickness, open-top/open-bottom/fully-closed options via `shellThicknessMm` and `shellOpenFace`; only rectangular and circular profiles are supported in this slice |
| Draft | Partial | `DesignSolidFeature.kind: "draft"` produces a tapered prism with `draftAngleDeg` and `draftNeutralFace`; per-face selection is still out — the taper applies uniformly to every side face |
| Linear / Circular / Mirror pattern | Partial | `pattern-part-feature` and `mirror-part-feature` on the template plate; no general-body pattern |
| Surface / Patch tools, T-Splines | Missing | Surface workspace is a bezier preview, not a full surfacing layer |
| Synchronous direct editing (Move / Pull / Offset region / Replace face) | Partial | Move Body, Scale Body, Move Face, Offset Face and Emboss direct-edit feature kinds (`kind: "move-body" \| "scale-body" \| "move-face" \| "offset-face" \| "emboss"`, `operation: "direct-edit"`) are shipped as first-class timeline steps that replay in order against the current body. Emboss applies a cosine-falloff raise/depress along the target face's averaged normal from the face centroid. Replace face and Delete face still need a boundary-rebuild pass |

## 6. Construction geometry (datums)

| PDF requirement | Status | Where / Gap |
|---|---|---|
| Offset plane | Have | Sketch-plane dialog carries `planeOffsetMm` |
| Plane at angle | Missing | |
| Tangent plane | Have | `ConstructionPlaneDefinition.kind: "tangent-to-cylinder"` ships: the plane sits on a revolve/extrude body's maximum-radius envelope at a chosen angle around its axis; origin is at the cylinder surface, normal is outward radial, in-plane axes line up with the body axis |
| Midplane | Missing | |
| Perpendicular plane | Shipped | `ConstructionPlaneDefinition.kind: "perpendicular-to-axis"` is a plane through a chosen point whose normal is a construction axis's direction. `evaluateConstructionPlane(plane, bodies, axes)` resolves the axis (and reports a missing or unevaluable one); the Construction ribbon has a "Plane ⟂ axis" button that asks for the axis and the point |
| Plane through two edges | Missing | |
| Plane through three points | Missing | |
| Plane along path | Missing | |
| Construction axes (5 modes) | Have | `ConstructionAxis` carries all five modes: `two-points`, `point-and-direction`, `plane-intersection`, `perpendicular-to-plane`, and `cylinder-axis` (donates the axis of a revolve or extrude body). Rendered as dashed line segments in the viewport; UCS not yet modelled |
| Construction points & UCS | Shipped | `ConstructionPoint` ships `xyz`, `midpoint` and `axis-plane-intersection` modes. `ConstructionUcs` ships origin + xAxis + yAxis (zAxis = xAxis × yAxis, Gram-Schmidted); add / delete / toggle-visibility / rename operations are in `WORKBENCH_OPERATION_KINDS`, with the UCS stored in `PartIntent.constructionUcses` |
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
| Pick faces, edges and hole positions by clicking in the viewport | Shipped | A command that needs a place on the model asks for a click: the viewport enters its pick mode (`requestViewportPick`, Esc cancels), reports the 3D point, the clicked body, its face number (through `faceTriangles`) and the surface normal, and the command reads what it needs. Move Face, Offset Face and Emboss take the clicked named face, Edge Flange the nearest plate edge (every candidate edge is drawn over the model), Hole Wizard the point and normal. A click on a different body or on a face with no name is refused with a message. Edges of general bodies other than a sheet plate's top face, and vertices, are not pickable yet |
| Menubar: File / Edit / Create / Modify / View / Inspect / Tools / Help | Have | `WorkbenchHeader` menus |

## 8. Inspect / diagnostics suite

| PDF tool | Status | Where / Gap |
|---|---|---|
| Zebra stripes (G0 / G1 / G2 / G3) | Partial | The Part ribbon's Zebra toggle shades every body with the black-and-white bands of a striped environment reflected in its surface (`Viewport.setZebra`, a `MeshStandardMaterial` fragment-shader patch driven by world-space reflection). Axis (X / Y / Z) and stripe density are adjustable. It shows G0 and G1 breaks by eye; there is no automatic continuity grade or G3 test |
| Gaussian / mean curvature map | Missing | |
| Curvature comb | Partial | The Sketch palette's Curvature comb toggle draws teeth along arcs, circles, ellipses and fit-point splines (`curvatureCombOf`, `sketchCurvatureCombs`): tooth length is curvature times a common scale so curves compare, teeth point away from the centre of curvature and flip sides at an inflection, and the tooth tips are joined into an envelope. Combs on surface edges and on 3D curves are still out |
| Mass-inertia integrator (BRepGProp) | Shipped | `solidMetrics` returns volume, surface area, centroid, triangle count AND the full 3×3 inertia tensor at the body centroid (`inertiaTensorMm5`), computed per-tetrahedron with the Tonon-2004 explicit formulas and summed against the mesh centroid. Multiply by a density in kg/mm³ to get the kg·mm² inertia the mass-properties report needs |
| Geometry checker (BRepCheck) | Partial | Design-health report flags open / near-open profiles; full B-rep checks missing |
| Section analysis | Shipped | `sectionAnalysis(positionsMm, indices, plane, offsetMm)` in `packages/workbench-core/src/solid-metrics.ts` computes a planar cross-section of any general-body mesh and returns the ordered edges (pairs of 3D endpoints) where each triangle crosses the plane; a UI binding to display the cross-section on the viewport is still to come |
| Interference detection | Partial | Only in the Assembly workspace |
| Draft angle / wall thickness / DFM | Missing | |

## 9. Sheet metal

| PDF requirement | Status | Where / Gap |
|---|---|---|
| Base flange / sheet base | Shipped | `DesignSolidFeature.kind: "sheet-base"` extrudes a sketch profile by `sheetThicknessMm` |
| Edge flange (bend angle, inner radius, length) | Shipped | `kind: "sheet-flange"` builds a standalone leg + circular bend + straight flange (`bentStripSection` / `tessellateBentStrip`) from `sheetThicknessMm`, `sheetBendRadiusMm`, `flangeLengthMm`, `flangeAngleDeg` (1-180 degrees). `kind: "sheet-edge-flange"` bends the same flange from a picked top-face edge of an existing plate: `sheetFrameOf` names the plate's straight boundary edges, and `attachEdgeFlange` removes the plate's side wall on that edge and the flange's end wall and welds the two, so the result is one closed solid whose inner and outer surfaces continue the plate's top and bottom faces. The edge number is stable because it indexes the plate as its first step made it, so further flanges can be added on other edges; the timeline step replays when the sketch or an earlier step changes. The Edge Flange command puts the plate's edges on the model as cyan rods and takes the edge nearest your click (`nearestFrameEdge`); the step's edge number can still be changed by double-clicking it. Neighbouring flanges take a corner relief (see Corner relief below) |
| Hem (closed / open) | Shipped | `kind: "sheet-hem"` is a 180° flange; closed uses a 0.05 mm inner radius so the return leg lies on the sheet, open keeps the bend radius |
| Bend allowance / deduction / K-factor | Shipped | `sheetBendAllowanceMm`, `sheetOutsideSetbackMm`, `sheetBendDeductionMm` in `packages/workbench-geometry/src/sheet-metal.ts`, default K-factor 0.44 |
| Unfold / flat pattern | Shipped | `flatPatternOfPlate` unfolds a plate with any number of edge flanges: the top-face boundary is chained into loops (blank plus holes), each flange becomes a rectangle of (bend allowance + flange length) by the edge length, and each bend gets a centre line; bend allowance and deduction are totalled. `flatPatternForBody` finds the body's live (not suppressed or rolled-back) flange steps, and a standalone flange or hem unfolds to its single-bend strip. Corner reliefs are not generated: flanges on neighbouring edges are flagged in a note |
| Flat pattern export (DXF / SVG) | Shipped | The Part ribbon's Sheet metal group has Flat Pattern SVG and Flat Pattern DXF buttons. The DXF is ASCII R12 with LINE entities on an OUTLINE layer and a dashed BEND layer in millimetres; the SVG draws solid outlines and dashed bend lines at 1 unit per mm |
| Corner relief | Shipped | `flangeReliefMm` on an edge flange is the gap a shared corner needs. `flangeReliefs` gives each of the two flanges half of the larger of their two values, and only at an end where another flange meets it, so asking for the relief on either flange is enough. The 3D flange stops short of that end (`attachEdgeFlange` keeps the plate's side wall there and splits the plate's top and bottom faces on the edge, so the mesh stays closed and outward), and the flat pattern shortens its rectangle and bend line by the same amount; without a relief it still says the corner needs one. The relief is a straight gap, not a notch cut into the base or a round relief |
| Miter flange, jog, lofted bend, bend table | Missing | |

Sheet metal here is mesh-based like the rest of the modeler, so folded and flat shapes are computed from the same parameters rather than from a true sheet-metal B-rep with edge-attached flanges.

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
