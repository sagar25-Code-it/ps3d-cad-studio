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
| Centerpoint arc, 3-point arc, Tangent arc | Partial | Only `arc` (3-point); centerpoint and tangent arc modes missing |
| Straight slot, Centerpoint slot | Partial | `slot` is centerpoint; straight slot (two endpoints + width) missing |
| 3-point arc slot, Centerpoint arc slot | Missing | Curved slot variants missing |
| Regular polygon | Have | `polygon` |
| Ellipse, Elliptical arc | **Missing** | No ellipse entity at all |
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
| Driving vs Driven (Reference), Deactivate, Equations | **Missing** | No reference-dimension toggle; no `fx` expressions |

## 5. Part / solid features (PDF Section 4)

| PDF feature | Status | Where / Gap |
|---|---|---|
| Extrude (Boss / Cut, Pad / Pocket, One-side, Symmetric, Through-all, To-face) | Partial | One-side, Symmetric, Flipped and Through-all for a cut shipped. To-face and To-vertex missing. |
| Revolve (One / Two / Symmetric / Thin, To-first / To-last) | Partial | Base revolve shipped; thin wall and "to" terminations missing |
| Sweep (section along path with twist control) | **Missing** | |
| Loft / Boundary (G0/G1/G2 continuity, rails, tangency weight) | **Missing** | |
| Helix / Coil / Thread | Missing | |
| Rib, Web, Emboss, Wrap | Missing | |
| Solid primitives (Box, Cylinder, Sphere, Cone, **Torus**, Ellipsoid, Prism, Wedge, Spiral, Tube) | Partial | Box, Cylinder, Sphere, Cone shipped; **Torus missing**; the rest missing |
| Hole / Hole Wizard (counterbore, countersink, threaded) | Missing | `set-part-parameter:holeDiameterMm` on the template plate only; no hole wizard |
| Dome, Indent, Flex, Scale | Missing | |
| Combine (Union, Cut, Intersect) | Have | `combine-general-bodies` with `mode: join|cut|intersect` |
| Fillet / Edge blend (constant radius, variable, G2) | Missing | `edge` pre-processed during extrude only; no post-op fillet picking |
| Chamfer (symmetric, asymmetric, offset+angle) | Missing | Same as fillet |
| Shell / Thickness | Missing | |
| Draft | Missing | |
| Linear / Circular / Mirror pattern | Partial | `pattern-part-feature` and `mirror-part-feature` on the template plate; no general-body pattern |
| Surface / Patch tools, T-Splines | Missing | Surface workspace is a bezier preview, not a full surfacing layer |
| Synchronous direct editing (Move / Pull / Offset region / Replace face) | Missing | |

## 6. Construction geometry (datums)

| PDF requirement | Status | Where / Gap |
|---|---|---|
| Offset plane | Have | Sketch-plane dialog carries `planeOffsetMm` |
| Plane at angle | Missing | |
| Tangent plane | Missing | |
| Midplane | Missing | |
| Perpendicular plane | Missing | |
| Plane through two edges | Missing | |
| Plane through three points | Missing | |
| Plane along path | Missing | |
| Construction axes (5 modes) | Missing | |
| Construction points & UCS | Missing | |
| Shape binder / Sub-shape binder | Missing | |

## 7. Work-window UX (PDF Table 7)

| PDF zone | Status | Where / Gap |
|---|---|---|
| Top command bar: workspace switcher, contextual ribbon, tab bar | Have | `WorkbenchHeader`, `WorkbenchRibbon` |
| Left docked navigator: model browser / feature tree | Have | `ProjectTree` |
| **4-Tab NX Sketch Navigator (Curves / Relations / External refs / Issues)** | Missing | Only a flat tree; no sub-tabs |
| **Padlock icon on a fully constrained sketch** | Missing | No glyph in the tree |
| Right / docked inspector: PropertyManager / Task panel | Have | `PartInspector`, sketch inspector |
| **Floating sketch palette (Fusion style)** | Have | `.sketch-palette` panel |
| **Confirmation Corner (viewport-upper OK / Cancel)** | Missing | |
| **View Cube** | Missing | |
| Cursor-centric HUD, marking menu, S-key toolbox | Partial | S opens the command palette; no marking menu |
| **On-view parameters (OVP) at the cursor** | Missing | Values are entered in the palette, not at the cursor |
| Parametric history timeline | Have | `TimelineBar` |
| **Quick-measure status bar (edge length, face area, radius)** | Missing | Status bar carries messages, not live measure |
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

These are the items the PDF most emphasizes that are entirely missing (not just incomplete) in PS3D today:

1. **Ellipse entity** - a standard sketch primitive.
2. **Centerpoint arc and tangent arc tool modes** - reuse the existing `arc` entity; only the input flow is missing.
3. **Straight slot mode** - two endpoints and a width; reuse the existing `slot` shape builder.
4. ~~**Sketch chamfer** - alongside the existing `fillet` sketch edit tool.~~ Shipped: equal-distance, two-distance and distance + angle.
5. **Driven (reference) dimension toggle** - a per-constraint flag so a dimension can measure without driving.
6. **Torus primitive** - the one shape from the PDF's standard primitive list that we do not have.
7. **Padlock icon in the model browser** when a sketch's constraint classification says "fully constrained".
8. **Quick-measure status bar** - the selected entity's length / area / angle under the viewport.

These eight items are what this slice ships.
