# PS3D sketch environment: full audit (2026-11)

Scope: sketch creation, constraints and dimensions, region/profile detection, edit tools, sketch-to-solid pipeline, limits. Method: six probe agents each ran 20 to 130 throwaway scripts against the compiled sketch modules (about 500 probe cases in total), plus my own live walkthrough of the production app and my own re-runs of the headline blockers. Items marked 'reproduced by me' I re-ran independently; the others carry the agent's exact repro and observed output and have not been re-run by me. Live UI behaviour (pointer gestures, rendering) was checked only in the walkthrough below.

## A. Live walkthrough findings (me, production app)

1. **Closing a drawn loop skips the last auto-constraint** (major). Four-line rectangle drawn with the Line tool: the final, exactly vertical side gets only coincident relations, no vertical. Result: 5 DOF instead of 4 and the rectangle can skew.
2. **Ribbon shortcut chips that do nothing** (minor): R2, R3, C2, C3, A2, A3 and E are printed on the tools but no key sequence triggers them (L, R, C, A, T, O, D, P work).
3. **Raw IDs leak into the UI** (minor): status text says 'Set length of entity:user-34829027-40cb-...'; the browser tree names new lines 'Line user-38289627-48cb-...'.
4. **Dimensioning is inspector-driven** (major UX): after picking a curve with the Dimension tool the value is typed in the right-hand panel, not on the canvas as in Fusion's D tool.
5. **Visual clutter** (minor): relation glyphs stack on small circles, the floating palette covers canvas area, and an unrelated 'Vehicle calculations require review' toast appears while sketching.
6. Working in the walkthrough: auto horizontal/vertical on lines, loop-close detection with profile areas, wheel zoom at cursor, Fit, middle-button pan, undo/redo, setting a line length with the rectangle following. Typed dynamic input could not be exercised with synthetic events (it needs a real pointer inside the canvas), so it is covered only by the code and probe findings.

## B. Verified by me, in short

- Dragging any corner of a 4-line rectangle with coincident corners and H/V on every side fails ('The analytic solver exceeded 8 deterministic passes.') for drags of 0.001, 1 and 10 mm; changing a side length works.
- Editing the side of a hexagon built by the app's own Polygon tool fails with the same message.
- A rectangle plus a corner-to-corner diagonal returns 0 profiles (expected 2 triangles); a rectangle plus a mid line across it returns 1 profile of the full area (expected 2 halves); two overlapping rectangles return 2 profiles (expected 3 regions).
- Filleting a corner of a drawn rectangle is refused ('This edit conflicts with a sketch relation'); the same geometry with no relations fillets fine.
- The 500th operation of a project is refused and so is every operation after it ('The preview audit reached its 500-entry limit'); the app has no compaction. The sketch also stops at 500 entities.
- Revolve is hard-wired to the sketch Y axis (the app's own message says so). A saved project over 1 MB hits the 1 MB parse limit (`maxJsonBytes`) although Save allows 50 MB (read in code, not run).

## C. Closed-profile / region detection and extrusion readiness

I ran about 130 probe cases against the compiled modules. Profile detection is exact and deterministic for clean, isolated loops. It breaks the moment geometry touches, crosses or shares anything. There is no arrangement engine: no curve is ever split at an intersection. Loops are found only as whole connected components in which every joint has exactly two edges. The result is that crossing lines, T-junctions, a diagonal in a square, adjacent regions and overlapping shapes yield no regions or wrong ones. Profile ids for line and arc loops are hashes of member entity ids, so a fillet, chamfer or split makes an existing feature fail with "profile no longer exists". Holes that touch or cross the outer profile are silently dropped. Several diagnostics are misleading.

### [blocker] P-01: No arrangement engine: crossing, T-junction and overlapping geometry gives no regions or wrong regions

- Evidence: reproduced by me
- Repro: detectSketchProfiles on: (a) 4 lines forming # (2 horizontal x 2 vertical, crossing); (b) 30x30 line border + 2 horizontal + 2 vertical lines; (c) two overlapping 20x20 line squares; (d) rectangle 20x20 + circle r8 crossing its edge; (e) circle r10 + diameter line; (f) rectangle 20x10 + centre line across; (g) 7 lines: a square with a mid divider whose ends sit on edge midpoints.
- Expected: (a) 1 enclosed centre cell; (b) 9 cells; (c) 3 regions (A only, A and B, B only); (d) 3 regions; (e) 2 half-discs; (f) 2 halves; (g) 2 halves, as in Fusion/Onshape.
- Actual: (a) 0. (b) 1 (only the border). (c) 2 profiles, each the FULL square, overlapping. (d) 2 full shapes. (e) 1. (f) 1. (g) 0, so even the outer square is lost. Only the Trim tool workaround closes a # (probe: 8 trims then gives 1 profile).
- Where: packages/workbench-sketch/src/index.ts detectCurveLoops (about line 936) and detectSketchProfiles
- Impact on an engineer: Draw-then-extrude, the normal sketch workflow, fails whenever lines cross or overlap. The engineer must pre-trim every intersection by hand or redraw the shape as separate primitives.

### [blocker] P-02: Any branching vertex (degree>2) destroys the whole loop, including the enclosing outline

- Evidence: reproduced by me
- Repro: square of 4 lines (0,0)-(10,10) plus ONE line from corner (10,10) to (15,15); or plus a diagonal (0,0)-(10,10); or two line squares sharing one corner; or two triangles sharing a diagonal (6 lines, or 5 with the shared line drawn once); or two half-discs (arc plus chord) sharing a diameter.
- Expected: Square survives as a profile (dangling stub ignored); diagonal gives 2 triangles; adjacent shapes give 2 regions.
- Actual: 0 profiles in every case. The detector requires every endpoint of the entire connected component to have exactly two edges, otherwise the component is skipped. Adding one construction-like stub to a finished square deletes its profile and breaks any feature built on it.
- Where: packages/workbench-sketch/src/index.ts line 965 (endpoint degree must be 2 for every key in the component)
- Impact on an engineer: A stray or reference line touching a corner silently removes a valid profile. Adjacent regions of a part (L-shape from two touching rectangles, split faces) cannot be built from lines or arcs at all.

### [major] P-03: Endpoint matching tolerance is about 1e-6 mm, while the UI and repair advertise 0.75 mm and claim profiles still join

- Evidence: reproduced by probe agent
- Repro: Square of 4 lines whose last edge ends gap mm short of the start: gap=1e-7 gives 1 profile; 1e-6, 1e-5, 1e-4, 1e-3, 0.5, 0.75 all give 0. repair.analyzeSketch on the 0.5 mm gap says 'close enough that profiles still join, but the geometry is not exact' while closedProfiles=0. For gaps 1e-6 to 1e-4 analyzeSketch reports NO issue at all (usable=false, summary 0 closed profiles).
- Expected: Either the profile engine honours sketch.snapToleranceMm (default 0.75) or the report never claims they join; a sub-0.1 mm gap must be reported.
- Actual: Contradictory feedback. The 5e-5 mm gap case is a silent failure: no profile, no warning. pointKey rounds to 1e-6 grid cells, so two points 4e-13 apart that straddle a rounding boundary (x.xxxxxx5) also fail to join (rare but real).
- Where: packages/workbench-sketch/src/index.ts pointKey (line 1008); packages/workbench-sketch/src/sketch-repair.ts line 451 (message) and COINCIDENT_MM (line 62)
- Impact on an engineer: A nearly closed sketch looks closed, validates as OK or 'will join', and then cannot be extruded for no visible reason.

### [major] P-04: Validate Sketch gives no reason when branching, crossing or T-junction geometry prevents a profile

- Evidence: reproduced by probe agent
- Repro: repair.analyzeSketch on (a) square + corner-to-corner diagonal, (b) # crossing lines, (c) 7-line divided square, (d) square + T line whose ends sit mid-edge.
- Expected: A warning such as 'lines cross or branch at (x,y); trim or split them', as SolidWorks Sketch Doctor does.
- Actual: (a)(b)(c): 'No errors. No warnings. 0 closed profiles (a solid feature needs at least one closed profile)' with zero issues. (d): '1 closed profile ready for a solid feature' while the divider is silently ignored (its two ends are only noted as open ends by checkSketch). checkSketch does flag degree>2 joints, but only as info and repeated 3 times per point (6 lines for 2 points).
- Where: packages/workbench-sketch/src/sketch-repair.ts analyzeSketch (no branch, crossing or T-junction category); packages/workbench-sketch/src/edit-tools.ts line 870
- Impact on an engineer: The engineer sees a green report and no way to learn why Extrude finds nothing.

### [major] P-05: Line/arc-loop profile ids change on any topology edit, breaking features built on them

- Evidence: reproduced by probe agent
- Repro: Feature extrude with profileIds=[profile:r] on a rectangle; apply edit.filletCorners on the rectangle, then rebuildSolidFeature. Same for a 4-line square with profileIds=[profile:loop-...]: chamferCorners, and splitAt of one side (geometry unchanged).
- Expected: Feature keeps working, or re-matches the profile by geometry, as Fusion/SolidWorks do.
- Actual: All three fail with 'A profile this feature was built on no longer exists in its sketch. Edit the sketch to close it again, or delete the feature.' Loop id is fnv1a of the sorted member entity ids; a rectangle id is its entity id (rectangle fillet replaces it with 8 entities). Dragging corners or adding unrelated geometry keeps ids stable (verified). In SketchWorkspace a stale selection is silently dropped (line 566).
- Where: packages/workbench-sketch/src/index.ts line 992 (id), apps/studio-web/src/design-regeneration.ts line 66-67
- Impact on an engineer: Filleting, chamfering, splitting or trimming a profile that already has a downstream extrude/cut breaks the model, so the engineer cannot do the normal 'extrude, then round the sketch corners' iteration.

### [major] P-06: Fillet and chamfer on drawn lines are refused when the lines have the auto-created coincident joint

- Evidence: reproduced by probe agent
- Repro: Two lines with constraint coincident(a.end,b.start) (what Auto-constrain, default ON, creates): commit(filletCorners(ctx, [a,b], 2)) and chamferCorners. Same on a 4-line square with joints, with or without horizontal/vertical.
- Expected: Fillet replaces the corner joint with a tangent arc.
- Actual: Refused: 'This edit conflicts with a sketch relation on b. Moved line b.' Recovery: use Relax Relations first. Works only on unconstrained lines or rectangles.
- Where: packages/workbench-sketch/src/edit-tools.ts filletCorners / chamferCorners (plan does not remove or replace the corner's coincident relation)
- Impact on an engineer: Rounding the corners of a polyline drawn in the UI needs a manual relax step; it is the edit that then also changes the profile id (P-05). Adjacent to my area, reported because it blocks profile editing.

### [major] P-07: Holes that touch or cross the outer profile are silently dropped, with no warning, so the solid has no hole

- Evidence: reproduced by probe agent
- Repro: resolveProfileRegion / rebuildSolidFeature with empty profileIds: 20x20 plate + circle r3 at x=0 and x=6 give a hole (volume 3717.6). At x=7 (tangent to edge), 8, 9, 10, 12 the volume is 4000.0, a full plate. Also 10x10 plate + inscribed r5 circle, and a circle r10 with an inscribed hexagon: holes=[] with ok result.
- Expected: Tangent hole is kept, or crossing hole gives a notch or a warning.
- Actual: Candidate is a hole only if all 72 sampled outline points are strictly inside; boundary points make pointInPolygon arbitrary. Crossing or tangent profiles are ignored. Explicit selection of plate + tangent circle errors with 'one of the selected profiles is outside it'.
- Where: packages/workbench-sketch/src/index.ts resolveProfileRegion lines 537 and 547
- Impact on an engineer: A parametric hole dimensioned to be tangent to or dragged across an edge makes the feature volume jump to a full plate with no message; downstream mass and fit analysis is wrong.

### [major] P-08: Several disjoint profiles cannot be extruded or cut together; error wording is also wrong for overlap

- Evidence: reproduced by probe agent
- Repro: resolveProfileRegion with all profiles selected: 4 disjoint circles; 2 disjoint rectangles; 2 overlapping rectangles; rectangle + partly overlapping circle.
- Expected: Disjoint profiles extrude as one multi-region feature (Fusion/Onshape). Overlap gets its own message.
- Actual: All four fail: 'Every extra selected profile must lie inside the largest selected profile; it becomes a hole. One of the selected profiles is outside it.' The overlap cases are not 'outside'. With nothing selected only the single largest profile is used and the others are silently skipped.
- Where: packages/workbench-sketch/src/index.ts resolveProfileRegion lines 538-545
- Impact on an engineer: Cutting 4 bolt holes or extruding several bosses from one sketch needs one feature per circle.

### [major] P-09: A closed fit-point spline (first fit point = last) gives no profile; the report calls it an open chain

- Evidence: reproduced by probe agent
- Repro: detect([spline fitPoints [[10,0],[0,10],[-10,0],[0,-10],[10,0]]]). Same for a self-closed single-spline figure.
- Expected: A single closed spline bounds a region.
- Actual: 0 profiles. analyzeSketch reports 'Open chain of 1 curve with 2 free ends: Free ends at (10, 0), (10, 0)' with no fix. buildSketchEntity accepts the points; there is no closed fit-point spline option (only the control-point spline closes, as two splines).
- Where: packages/workbench-sketch/src/index.ts line 965 (a loop needs at least 2 edges when it has an arc/spline) and buildSketchEntity (spline)
- Impact on an engineer: A freeform blob outline drawn as one closed spline is not extrudable.

### [minor] P-10: Self-intersecting loops are accepted as profiles and only fail at extrude

- Evidence: reproduced by probe agent
- Repro: asymmetric bow-tie of 4 lines (0,0)-(10,10)-(10,0)-(0,20); a 5-line pentagram; a spline that crosses itself closed by a line; two arcs and two lines forming a figure 8. Then createGeneralSolidBody.
- Expected: Not offered as a profile, or flagged.
- Actual: Each is listed as one closed profile with a signed net area (e.g. 50) and shows as selectable; extrude fails with 'The solid kernel could not extrude this profile: The profile outline crosses itself.' A symmetric bow-tie is silently dropped (net area 0).
- Where: packages/workbench-sketch/src/index.ts detectCurveLoops (no simple-polygon test)
- Impact on an engineer: A shaded 'ready' region that cannot extrude, with the cause shown only after the attempt.

### [minor] P-11: Curved profile outlines use a fixed facet count, so solids and areas are off and large circles are visibly faceted

- Evidence: reproduced by probe agent
- Repro: Cylinder r10 h10 via createGeneralSolidBody gives volume 3137.607 vs exact 3141.593 (-0.127%). Plate with r5 hole: 15215.598 vs 15214.602 (hole undersized). circleOutline = 72 points for every radius: r=500 sagitta 0.476 mm, r=5000 4.76 mm. Arc loops: half-disc r10 area 313.655 vs 314.159; slot 378.414 vs 378.540.
- Expected: Tolerance-driven sampling (about 0.01 mm chord error) or exact analytic faces.
- Actual: profile.areaMm2 is analytic for circle/ellipse but the solid is built from the inscribed 72-gon, so area and volume disagree. Arc facet is a fixed pi/32.
- Where: packages/workbench-sketch/src/index.ts profileOutlineMm (line 481), ARC_FACET_RADIANS (line 906)
- Impact on an engineer: Mass properties and clearance are slightly wrong, and a large bore or boss is polygonal at tolerance.

### [minor] P-12: Degenerate or invalid primitives are returned as profiles

- Evidence: reproduced by probe agent
- Repro: detect([rect w=0 or 0.001]), circle r=0, circle r=-3, ellipse minor>major, rect with NaN width, circle Infinity radius.
- Expected: Skipped, or reported as degenerate.
- Actual: Each yields a profile: area 0 for w=0/r=0, area 28.27 for r=-3, NaN/Infinity area for non-finite. A 4-line loop with a NaN coordinate yields a profile with NaN area (the 1e-6 area test lets NaN through). Only buildSketchEntity guards sizes; solver, JSON import or dimension edits are not guarded here.
- Where: packages/workbench-sketch/src/index.ts detectSketchProfiles lines 448-474 and 987
- Impact on an engineer: A zero-size circle becomes a selectable profile that the kernel then rejects.

### [minor] P-13: Duplicate or overlapping collinear edges kill the loop; the suggested repair is wrong

- Evidence: reproduced by probe agent
- Repro: Square with one edge drawn twice (also reversed): 0 profiles. Two identical 4-line squares: 0. Bottom edge as two overlapping lines (0-6, 4-10): 0 profiles; analyzeSketch reports 'Open chain ... open at (6,0) and (4,0), 2 mm apart' offering 'Close the chain with a line'. Two identical circles give 2 profiles, which then fail as holes.
- Expected: Duplicates merged; overlap reported as overlap.
- Actual: Duplicate lines are reported by the repair panel (fix exists), but overlap is misdiagnosed as a gap and the closing-line fix draws a third overlapping segment. Identical circles used as holes: 'A hole crosses the profile outline or another hole.'
- Where: packages/workbench-sketch/src/index.ts detectCurveLoops; packages/workbench-sketch/src/sketch-repair.ts open-chain branch
- Impact on an engineer: Coincident or overlapping geometry from copy/paste or projection silently removes profiles.

### [minor] P-14: Overlapping holes cannot be merged; they fail in the kernel

- Evidence: reproduced by probe agent
- Repro: Plate 40x40 + two overlapping circles r5 at (-3,0) and (3,0), empty selection: resolveProfileRegion returns both as holes, createGeneralSolidBody fails.
- Expected: Union of the two holes (a slot-like cut), as the region would be in Fusion.
- Actual: 'The solid kernel could not extrude this profile: A hole crosses the profile outline or another hole.' The profile list offers no merged hole region.
- Where: packages/workbench-sketch/src/index.ts resolveProfileRegion islands filter (line 548)
- Impact on an engineer: Overlapping bolt-circle or keyhole holes need two separate cut features.

### [minor] P-15: resolveProfileRegion silently substitutes the largest profile for an unknown selection

- Evidence: reproduced by probe agent
- Repro: resolveProfileRegion(profiles, ['profile:gone'], {includeIslands:true}) on plate + circle.
- Expected: Failure that names the missing id.
- Actual: ok result: outer = the largest profile with the circle as a hole. rebuildSolidFeature pre-checks ids, so the main path is protected; the UI filters stale ids; other callers (MCP/API, loft secondary list, sheet-metal commands) are exposed.
- Where: packages/workbench-sketch/src/index.ts line 534 (selected[0] ?? profiles[0])
- Impact on an engineer: A stale reference could extrude the wrong profile without telling anyone.

### [minor] P-16: A plate cannot be extruded solid while a contained profile exists

- Evidence: reproduced by probe agent
- Repro: Plate rectangle + inner circle (e.g. a reference circle for a later feature). resolveProfileRegion(['profile:p'], includeIslands:true) always returns the circle as a hole; selecting both makes the circle a hole too.
- Expected: Option to extrude the full plate (select ring and island regions, or ignore the inner profile).
- Actual: No way short of toggling the circle to construction or hiding it. The panel hint tells only half the story.
- Where: packages/workbench-sketch/src/index.ts resolveProfileRegion line 546-549
- Impact on an engineer: Surprise holes in the solid; workaround is non-obvious.

### [minor] P-17: Outline winding is inconsistent between profile kinds

- Evidence: reproduced by probe agent
- Repro: Signed area of profileOutlineMm: rectangle/circle/ellipse are always CCW. A 4-line loop is CW or CCW depending on drawing direction and entity-id sort order (e.g. ids z0,y1,x2,w3 drawn CCW gives -100).
- Expected: One documented winding for all consumers.
- Actual: Mixed. The extrude kernel accepts both (verified), but any other consumer (revolve, thin revolve, loft ring matching, flat pattern) must normalise itself.
- Where: packages/workbench-sketch/src/index.ts detectCurveLoops ordering (lines 966-985)
- Impact on an engineer: Latent risk for lofts and sweeps that pair outlines by index; no visible failure observed in extrude.

### [minor] P-18: UI gives no reason when the Create solid button is disabled, and crossing-box select uses bounding boxes

- Evidence: read from code, not run
- Repro: Code read of SketchWorkspace.tsx line 1623 (disabled when profiles.length===0 with no message) and lines 1113-1122 (profile box select tests the bounding box of the outline, window or crossing).
- Expected: A hint or tooltip stating no closed profile exists, with a pointer to Validate Sketch. Crossing select that hits the actual region.
- Actual: Button is silently disabled. A crossing box touching only the corner of a large plate's bounding box selects the plate and any profile whose bbox overlaps, including ones the box never touches.
- Where: apps/studio-web/src/workspaces/SketchWorkspace.tsx lines 1623 and 1113
- Impact on an engineer: Engineer cannot tell why Extrude is grey; box selects pull in unintended profiles.

### Missing capability

- (blocker) **Planar-arrangement region engine: split all curves at mutual intersections and T-junctions, then expose every enclosed face (including holes and ring regions) as a selectable region**: Everyday sketches have crossing, touching and overlapping geometry. Without it nothing but isolated, non-touching loops extrudes. (compared with Fusion 360 profiles, SolidWorks contours, Onshape regions)
- (major) **Break/Split all curves at intersections (one-click 'Intersect' or 'Break at intersections') as a stopgap for the missing region engine**: Only a manual single-pick Trim and Split exist. Splitting a # grid into cells takes many picks. (compared with Fusion Break/Trim; SolidWorks Split Entities; Onshape Split)
- (major) **Persistent profile reference that survives fillet, chamfer, split and trim (geometric-signature re-match, or a re-attach prompt)**: Features built on drawn-line profiles break on any sketch topology edit. (compared with Fusion/SolidWorks/Onshape keep features on edited sketches)
- (major) **Extrude or cut of several disjoint or independent profiles in one feature**: Bolt-hole patterns and multi-boss parts are one feature in every other CAD tool. (compared with Fusion Extrude with multiple profiles; SolidWorks selected contours; Onshape multi-region extrude)
- (major) **Gap-closure tolerance honoured by the profile engine (or auto-heal near-coincident ends at sketch finish)**: Profiles require 1e-6 mm identity while the UI snap and the repair text say 0.75 mm. (compared with SolidWorks Sketch gap-closure; Fusion tolerance on joined curves)
- (major) **Sketch diagnostics that name branching, crossing, T-junction, overlap and self-intersection (and the cause of '0 closed profiles')**: Validate Sketch is silent in the common failure cases (P-04). (compared with SolidWorks Sketch Doctor and Check Sketch for Feature Usage)
- (minor) **Closed (periodic) fit-point spline and closed single-spline profiles**: Freeform outlines are drawn as one closed spline. (compared with Fusion spline close, SolidWorks closed spline)
- (minor) **Elliptical arc and partial ellipse that can join lines and arcs into a loop**: An ellipse is only a closed primitive; trimmed ellipses cannot bound a region (grep: no elliptical arc anywhere). (compared with Fusion/SolidWorks elliptical arcs)
- (minor) **Filled-plate versus holed-plate region choice, and a union region for overlapping holes**: Control of which inner regions become voids. (compared with Fusion: pick ring and disc regions separately)
- (minor) **Tolerance-adaptive curve sampling (chord error bound) for profile outlines**: 72 facets for every circle gives 0.48 mm chord error at r=500. (compared with All three use exact curved faces)

### Verified working

- Isolated rectangles, circles and ellipses always give one exact profile each; area and centroid are correct.
- Closed line loops, arc loops, spline loops, two-arc lens and circle, mixed line/arc/spline loops, centre and overall slots, regular polygons: one profile each, area within 0.2% (inscribed sampling).
- Construction entities and visible=false entities never create profiles; one hidden or construction edge opens a line loop as intended.
- Zero-length line mid-edge is ignored; zero-length at a corner breaks the loop (repair flags it as error).
- Concentric circles, nested line squares and a hole inside an arm of a concave U shape resolve correctly; the notch circle is not a hole; plate hole, line-loop hole and island-inside-hole volumes are correct (15215.6 vs 15214.6 analytic).
- Determinism: 50 random shuffles of entity order give identical ids, areas and outline points; JSON round trip is identical; inputs are not mutated (deep-frozen input accepted).
- Profile ids are stable across dragging corners, resizing primitives and adding unrelated geometry.
- Large and tiny: 1e5 mm square, a square at 1e7 mm offset, 0.02 mm square and 0.001 x 100 sliver are detected with correct areas.
- Performance: 8000 lines (2000 squares) in 193 ms; 2000 circles in under 1 ms; 2000-segment loop in 18 ms; 200 nested squares in 5 ms; resolve with 2001 profiles in 20 ms.
- Trim of overshooting # lines (8 picks) yields a closed profile; fillet and chamfer on a rectangle or on unconstrained lines keep one closed profile.
- Closed loops through the live solver (square with H/V joints, constrained slot) and rotated copies at 17.3, 37.7, 123.456 and 211.9 degrees still detect as one profile.
- Kernel extrude accepts CW and CCW outlines; self-crossing and crossing-hole cases are rejected with specific messages; rebuildSolidFeature reports a missing profile clearly.
- Edge cases: two adjacent rectangle primitives or two tangent circles give 2 profiles; empty sketch gives 0 profiles and a clear 'Draw or select a closed profile first.'

Not checked in this area: ["Real in-browser behaviour: profile hover/click hit-testing and z-order in overlap areas, shading, the Create solid panel flow (SketchWorkspace read only).","Undo/redo stacks and repeated apply/undo through the operation layer (only pure functions probed; detectSketchProfiles is stateless).","Tilted or three-point sketch planes and projected or intersect edges; STEP and mesh export of faceted curved profiles.","Revolve, loft, sweep and sheet-metal consumers of the profile beyond extrude; kernel face naming (edgeGroups) for curve loops.","Mixed units: the sketch is mm-only, so no unit conversion exists to probe.","Pointer-driven drag of corners with live solve at 200+ entities (only pure detect timing measured)."]

## C. Constraint solver, degrees of freedom, dimensions

About 33 probe scripts were run against the compiled modules. Single-entity work is solid: line length, circle radius, angle, arc length, perimeter, driven dimensions, determinism, JSON round trip, and 500 entities with 1000 constraints in 42 ms. The core weakness is the solver. solveAnalyticSketch in parametric-sketch-core is a sequential, one-relation-at-a-time pass capped at 8 passes. It cannot resolve closed loops or interacting relations, and it fails with "The analytic solver exceeded 8 deterministic passes", which names no constraint. That breaks basic tasks: pinning a rectangle, dragging a corner, editing a hexagon, slot or tangent circle. The DOF analysis (analyzeWorkbenchSketch) is a counting heuristic, not a rank analysis. It reports fully constrained when the sketch is not, and it counts relations the solver does not enforce.

### [blocker] S1: A closed 4-line rectangle cannot be pinned to a fixed point

- Evidence: reproduced by probe agent
- Repro: 4 lines joined by coincident (end->start) with horizontal on b,t and vertical on r,l (each at x0+0..52, y 0..30). Add point entity:o at (0,0) plus fixed on it. Then add coincident [o self, b start] when b starts at x=0.5, 2, 10 or 100. Also run solveAnalyticSketch with maxPasses 32.
- Expected: The whole rectangle translates so b.start lands on the point (a rigid move).
- Actual: All offsets, even 0.5 mm: 'The analytic solver exceeded 8 deterministic passes.' Same status SOLVER_DID_NOT_CONVERGE at 16 and 32 passes, so it is not just the pass cap. Closed coincident loops oscillate: each pass moves one end of one line.
- Where: packages/parametric-sketch-core/src/solver.ts solveAnalyticSketch / makePointsCoincident (per-constraint Gauss-Seidel, DEFAULT_MAX_PASSES=8)
- Impact on an engineer: A rectangle drawn with the Line tool cannot be anchored to the origin by the normal route (fixed point plus coincident). Fixing a whole line locks its length, so there is no good way to locate a profile.

### [blocker] S2: Dragging any corner of a line-built rectangle fails

- Evidence: reproduced by me
- Repro: Same 4-line ring with H/V (no fixed geometry). dragSketchHandle(sketch,'entity:b',{kind:'point',ref:'end'},[50,0],[50+d,d]) for d = 0.001, 0.1, 1, 5, 20. Also try all four corners, a body drag of a dimensioned line, and a drag to (500,-300).
- Expected: The corner follows the pointer, neighbours stretch, and the sketch stays H/V.
- Actual: Every drag returns 'The analytic solver exceeded 8 deterministic passes.', even for 0.001 mm. The same happens on a rectangle with length dims set. A triangle with plain coincidents drags fine.
- Where: packages/workbench-sketch/src/drag.ts liveDrag -> dragLiveSketch -> solver.ts drag mode
- Impact on an engineer: The basic move-a-corner gesture is dead on the most common sketch (a rectangle of lines).

### [blocker] S3: The app's own generated shapes cannot be resized or dragged

- Evidence: reproduced by me
- Repro: Build with buildPolygon(6 sides), buildSlot, buildRoundedRectangle, buildParallelogram (workbench-sketch shapes.ts, basic-curve-shapes.ts). Then set-sketch-dimension on a side or arc radius, and drag a vertex.
- Expected: The shape resizes and its relations (equal sides, tangents, parallels) follow.
- Actual: Hexagon side set to 10, 40 or 200 fails. Hexagon vertex drag fails. Slot arc radius 5->12 fails. Rounded-rect corner radius 6->10 fails. Parallelogram side->50 and its drag fail. All with 'exceeded 8 deterministic passes'.
- Where: parametric-sketch-core/src/solver.ts; callers in workbench-core/src/sketch-dimension-edit.ts
- Impact on an engineer: Every polygon, slot and rounded rectangle becomes frozen once drawn. The only edit is delete and redraw.

### [blocker] S4: A circle cannot be tangent to two lines, and its radius cannot be edited with two tangents

- Evidence: reproduced by probe agent
- Repro: Lines y=10 and y=-10, circle at the origin r=10, tangent(a,c) and tangent(b,c). set-sketch-dimension radius 25, both lines free. Separately: circle r=5 tangent to a line, then add tangent to a second line at 60 degrees.
- Expected: The lines (or the centre) move so both tangencies hold, or a clear conflict.
- Actual: The radius edit fails with 'exceeded 8 deterministic passes' even with both lines free, with one fixed, or with both fixed (so even a true conflict is unnamed). Adding the second tangent to the 60 degree pair fails the same way.
- Where: solver.ts applyTangent (only moves the circle, never the line)
- Impact on an engineer: A circle in a corner, a slot or a belt/pulley layout is not buildable or editable.

### [blocker] S5: A dimension edit can reverse a joined line and produce wrong geometry

- Evidence: reproduced by probe agent
- Repro: a (0,0)->(10,0) and b (10,0)->(20,0), coincident a.end/b.start, both horizontal, b length dim 10. set-sketch-dimension a length 25. Also 40, and a length 20.
- Expected: a=25 and b slides to (25,0)->(35,0).
- Actual: a=25: b becomes (25,0)->(15,0), reversed and folded back over a. a=40 does the same. a=20 returns 'A degenerate line cannot be dimensioned.' because b collapses to zero length. Chain test: 3 lines of 10, first set to 25 gives s001 25->15, s002 15->25. The constraints are satisfied but the geometry is inverted.
- Where: solver.ts resizeLine uses the current (already flipped) direction after makePointsCoincident moved the start
- Impact on an engineer: A routine dimension change silently inverts a chain, or fails on one specific value.

### [major] S6: Chains of 9 or more dimensioned lines cannot be edited

- Evidence: reproduced by probe agent
- Repro: N horizontal lines, each with a length dim of 10, joined by coincident. set-sketch-dimension on the first line to 25. Try N = 3, 6, 9, 10, 12, 20, 50 with forward and reverse constraint ids.
- Expected: The whole chain shifts.
- Actual: N=3 and 6 succeed (N=3 wrongly, see S5). N>=9 always fails with 'exceeded 8 deterministic passes'. Propagation along the chain takes one pass per link. A 100-gon with equal sides also fails (side->50).
- Where: solver.ts DEFAULT_MAX_PASSES=8 and sequential propagation
- Impact on an engineer: Any long polyline or profile with more than 8 linked, dimensioned segments is locked.

### [major] S7: Result depends on which entity of a related pair you edit

- Evidence: reproduced by probe agent
- Repro: (1) Closed 4-line rect with equal(b,t), set b length 200. (2) equal-length chain a,b: edit a=30 then edit b=30. (3) symmetric lines a,b about an axis: edit a=30 then b=30.
- Expected: Both entities of an equal or symmetric pair can be driven.
- Actual: The equal rect fails with 'exceeded 8 passes'. Equal chain: editing a works, editing b fails. Symmetric: editing a works (b mirrors), editing b fails.
- Where: solver.ts applyEqual / applySymmetric always push changes to the second entity; sorted by constraint id
- Impact on an engineer: Unpredictable edits. Users find 'half' of a pair editable and the other half rejected.

### [major] S8: Neighbouring geometry is not moved minimally (perpendicular arm stretches)

- Evidence: reproduced by probe agent
- Repro: a (0,0)->(10,0), b (10,0)->(10,10), coincident a.end/b.start, perpendicular(a,b), no other dims. set-sketch-dimension a length 30.
- Expected: b translates, so b = (30,0)->(30,10) (length 10).
- Actual: b = (30,0)->(30,22.36). Its length goes 10 to 22.36 because coincident drags b.start while b.end stays, then perpendicular rotates b keeping the stretched length.
- Where: solver.ts orientLineFromReference / makePointsCoincident ordering
- Impact on an engineer: Changing one dimension silently distorts untouched, undimensioned neighbours.

### [major] S9: Conflict errors do not name the conflicting dimensions or constraints

- Evidence: reproduced by probe agent
- Repro: (1) equal(a,b), set a=20, then b=30. (2) parallel(a,b), then perpendicular(a,b). (3) perpendicular(a,b), then angle 60. (4) horizontal then vertical on one line. Read diagnostics[0].message and relatedIds.
- Expected: A message naming both contradicting constraints/dimensions.
- Actual: (1)-(3): 'The analytic solver exceeded 8 deterministic passes.' with relatedIds ['sketch:primary-profile'] (not a constraint). (4): 'Geometry entity:a is degenerate.' Only some cases name a constraint (e.g. 'Both lines are fixed...', but not the two fixing constraints). Circle case: 'Both unequal circle radii are fixed.' names only the equal constraint, not the two radius dims.
- Where: solver.ts SOLVER_DID_NOT_CONVERGE diagnostic (relatedIds:[document.id]); workbench-core/src/sketch-solve.ts solveFailure
- Impact on an engineer: The user cannot tell which dimension to remove. The spec's 'error must name them' is not met.

### [major] S10: DOF analysis undercounts when constraints are redundant (false 'fully constrained')

- Evidence: reproduced by probe agent
- Repro: Two free points + coincident, then the same coincident again. Or fixed line a, horizontal b, parallel(a,b) (redundant), length(b). Or equal + a=20 + b=20.
- Expected: Redundant relations are flagged and not subtracted: DOF 2 for the points, 2 for the b example, 6 for equal.
- Actual: The duplicate coincident gives DOF 0 and classification 'fully-constrained' (true 2). The b example gives 1 (true 2). The equal/consistent dims example gives 5 (true 6). Only the repair panel reports the redundancy (analysis classification never says over-constrained).
- Where: packages/workbench-sketch/src/index.ts analyzeWorkbenchSketch + reduce()
- Impact on an engineer: The padlock (ProjectTree isSketchFullyConstrained) can show on an under-defined sketch.

### [major] S11: A fully dimensioned loop reports 0 DOF although it still floats and has redundant dimensions

- Evidence: reproduced by probe agent
- Repro: L-bracket of 6 lines, coincident ring, H/V alternating, then set all 6 side lengths (60,20,40,30,20,50). analyzeWorkbenchSketch + repair.analyzeSketch, then dragSketchHandle kind 'body' on p0, then set p0 to 30.
- Expected: DOF 2 (position) and two dimensions flagged as redundant (the ring closes).
- Actual: DOF 0, 'fully-constrained', repair issues []. A body drag translates the whole profile by (10,10). Later set p0=30/100/500 fails with the unnamed 'exceeded 8 passes'.
- Where: index.ts analyzeWorkbenchSketch; sketch-repair.ts redundancy rules (documented as no rank analysis) but DOF claim is undocumented
- Impact on an engineer: No warning that dimension #5 or #6 is redundant, and the sketch is called fully constrained while not located.

### [major] S12: Symmetric and midpoint relations remove too little freedom in the DOF count

- Evidence: reproduced by probe agent
- Repro: fixed axis; two free lines; symmetry(a,b,ax). Two circles symmetric. Fixed line plus point; midpoint(m,a).
- Expected: Symmetric lines remove 4 (DOF 8 to 4 total), symmetric circles remove 3, a point at a midpoint removes 2.
- Actual: Lines: 8 to 7. Circles: 6 to 5. Midpoint: point DOF 2 to 1 although the point is fully fixed at (5,0). A fully located midpoint point stays 'underconstrained'.
- Where: index.ts analyzeWorkbenchSketch generic fallthrough 'reduce(freedom, ids, 1)' for symmetry/midpoint/equal/tangent
- Impact on an engineer: Sketches using symmetry or midpoints never reach 'fully constrained' (wasted dimensions).

### [major] S13: Relations the solver does not enforce still reduce DOF (hole in a plate shows fully constrained)

- Evidence: reproduced by probe agent
- Repro: Rectangle 'plate' fixed. Circle 'hole' centre (7,3). add coincident(hole center, plate center), then radius dim 6. analyzeWorkbenchSketch.
- Expected: The coincident is 'recorded, not solved': hole stays off-centre and the sketch must not be fully constrained.
- Actual: Summary says 'Recorded, not solved: Rectangles are rigid...'. Hole centre stays at [7,3], yet classification='fully-constrained', DOF 0. Same for equal on two rectangles, horizontal on a rectangle, tangent line-spline and ellipse coincident (also constraintFit says ellipse centre is joinable but the solver does not move ellipses).
- Where: index.ts analyzeWorkbenchSketch counts every constraint; sketch-solve.ts toSolverGeometry drops ellipse/rectangle
- Impact on an engineer: Centre-a-hole-in-a-plate, the canonical case, gets the padlock with the hole in the wrong place.

### [major] S14: Fixed geometry is silently changed by a dimension edit

- Evidence: reproduced by probe agent
- Repro: Line a fixed, then set-sketch-dimension length 50. Same for a fixed circle (radius 10 to 20) and a fixed rectangle (width 60 to 100).
- Expected: A conflict or refusal: fixed geometry cannot move.
- Actual: All three succeed. The line end moves to (50,0), the circle goes to r=20, the rectangle to width 100, while the fixed constraint still exists and DOF stays 0.
- Where: workbench-core/src/sketch-dimension-edit.ts: resizeSketchEntity applied before the solver, solver then sees the new size as the baseline
- Impact on an engineer: Locked geometry is not locked; 'Fix' gives false security.

### [major] S15: A radius or perimeter dimension that disagrees with the geometry makes every solve fail

- Evidence: reproduced by probe agent
- Repro: Circle r=6 with a radius constraint of 7 (stale file, expression update, manual edit) then solveLiveSketch. Or: radius dim, relax it, change the radius, restore (set-sketch-constraints-suppressed false). Same with circle perimeter. Compare a line length dim.
- Expected: The circle snaps to 7, as a line snaps to its length dim.
- Actual: 'The radius is fixed at another value.' Restore is refused and any related solve fails. The line length restore snaps correctly.
- Where: solver.ts applyDrivingDimension radius branch + sketch-solve.ts translateDimension adds a 'fix radius' before the dimension
- Impact on an engineer: Relaxed radius dims cannot be restored. Stale-radius sketches are unsolvable.

### [major] S16: Rectangle width/height dimensions are not enforced on restore or drag

- Evidence: reproduced by probe agent
- Repro: Rectangle with width dim 60 and height dim 40. dragSketchHandle kind 'corner' to (80,50). Separately: relax the width dim, change the width to 100, restore.
- Expected: Drag refuses or holds 60x40; restore snaps back to 60.
- Actual: The drag returns 110 x 70 with no error and the constraints still say 60/40. Restore keeps width 100 with dim 60. repair.analyzeSketch reports no issue.
- Where: sketch-solve.ts translateDimension (rectangle w/h 'applied directly'), workbench-sketch/src/drag.ts rectangle corner branch
- Impact on an engineer: A driving dimension that says 60 while the part is 110 is a silent data lie.

### [major] S17: Tangent circles flip from external to internal when a radius grows

- Evidence: reproduced by probe agent
- Repro: circles a r=5 at (0,0), b r=10 at (15,0), tangent(a,b). set-sketch-dimension a radius 30.
- Expected: Keep the tangency type (external), or report a conflict.
- Actual: b silently resizes 10 to 15 and becomes internally tangent (inside a). a=15 gives a 'collapse to zero radius' error.
- Where: solver.ts applyTangent: radius = |centerGap - keptRadius|
- Impact on an engineer: A radius edit can invert the design intent without notice.

### [major] S18: Editing one side of a rounded rectangle breaks the closed profile

- Evidence: reproduced by probe agent
- Repro: buildRoundedRectangle([0,0],[60,40],6). set-sketch-dimension bottom line length 50 (was 48).
- Expected: The arcs stay joined and the profile stays closed.
- Actual: Bottom end moves to x=56; the arc still starts at x=54 (2 mm gap). Closed profiles drops 1 to 0 ('Open chain of 8 curves'), so it will no longer extrude. The docs mention arcs cannot be joined, but not that dimension edits silently open the profile.
- Where: constraint-fit.ts SOLVABLE_POINT_REFS (arc ends not solvable); basic-curve-shapes.ts uses tangent only
- Impact on an engineer: Common fillet-corner profiles are destroyed by a normal edit.

### [minor] S19: Out-of-envelope results give a misleading error

- Evidence: reproduced by probe agent
- Repro: line from x=5000, set length 9000 (end at 14000). Also add an entity of length 0.005.
- Expected: A message about the +/-10,000 mm coordinate limit or 0.01 mm minimum.
- Actual: 'A sketch entity is invalid or has a duplicate ID.' for coordinates over 10000 and for sub-0.01 geometry.
- Where: workbench-core/src/validation.ts (maxCoordinateMm 10_000) via applyWorkbenchOperation result validation
- Impact on an engineer: Users cannot tell why a legitimate edit is refused.

### [minor] S20: NaN / Infinity in add-sketch-entity or add-sketch-constraint throws instead of returning a diagnostic

- Evidence: reproduced by probe agent
- Repro: applyWorkbenchOperation(project,{kind:'add-sketch-entity', entity:{line with end x NaN}}), likewise a circle radius Infinity or a radius constraint valueMm NaN.
- Expected: A WorkbenchResult failure.
- Actual: Throws TypeError 'Canonical JSON rejects non-finite numbers.' (set-sketch-dimension is guarded and returns invalid).
- Where: workbench-core/src/operations.ts boundedIntentKey/canonicalizeJson before validation
- Impact on an engineer: An uncaught exception can reach a UI handler that computes a NaN coordinate.

### [minor] S21: Degenerate self-relations and unfit constraints are accepted and change DOF

- Evidence: reproduced by probe agent
- Repro: add-sketch-constraint parallel [a,a], equal [a,a], collinear [a,a], concentric [c,c], horizontal [a,a], radius on a line without value, equal [line, circle].
- Expected: Rejected as invalid.
- Actual: All accepted. parallel a,a and equal a,a lower DOF by 1, collinear a,a by 2, concentric c,c by 2. A valueless radius on a line is stored and makes the sketch 'conflict'. perpendicular a,a is rejected only by the 8-pass failure.
- Where: workbench-core/src/operations.ts add-sketch-constraint (constraintFit not enforced for arity or duplicates)
- Impact on an engineer: MCP/API callers can mark a sketch as constrained with no-op relations.

### [minor] S22: A 3-point arc counts 6 DOF instead of 5, and an empty sketch is 'fully-constrained'

- Evidence: reproduced by probe agent
- Repro: analyzeWorkbenchSketch on a single arc, then on an empty sketch.
- Expected: Arc 5, arc+radius 4, arc+radius+arc-length 3. Empty: not fully constrained.
- Actual: 6, 5, 4. Empty sketch: classification 'fully-constrained', DOF 0 (only the tree guards it).
- Where: index.ts baseFreedom (returns 6 for arc) and classification
- Impact on an engineer: An arc can only reach 0 through Fix; health/MCP consumers read the empty sketch as fully constrained.

### [minor] S23: Re-setting a relaxed dimension silently reactivates it

- Evidence: reproduced by probe agent
- Repro: Dimension a line length, relax the dimension, then set-sketch-dimension length 30 on the same line.
- Expected: Either stays relaxed or the summary says it was reactivated.
- Actual: The new constraint replaces the old one and drops 'suppressed'; the summary does not mention it.
- Where: workbench-core/src/sketch-dimension-edit.ts withDimension replaces the constraint
- Impact on an engineer: A relaxed dimension quietly starts driving again.

### Missing capability

- (blocker) **Point-to-point, horizontal, vertical and aligned distance dimensions, point-to-line and line-to-line distance**: Only a line's own length and a rectangle's width/height can be dimensioned. A hole position, an offset between two edges or a hole pitch cannot be driven. The parametric core has 'linear' and 'coordinate-x/y' dimensions but they are not wired to WorkbenchSketchConstraint (constraint-fit.ts 'distance' accepts only a line or rectangle). (compared with Fusion Sketch Dimension, SolidWorks Smart Dimension, Onshape Dimension)
- (blocker) **Sketch origin and projected references: coincident to the origin or axes, and point-on-curve (point on line/circle/arc)**: Nothing in the sketch can be tied to the origin, and 'point on line' is not available (solver reports it unsupported). Without these, profiles cannot be located or made symmetric about the datum, and the only anchor is Fix on a whole curve. (compared with Fusion, SolidWorks, Onshape origin coincident and point-on-curve)
- (blocker) **A simultaneous nonlinear solver (Newton/LM) with a rank-based DOF, redundancy and over-constraint detection, and conflict-set reporting**: The sequential 8-pass solver cannot solve loops (S1-S7). The DOF is a count (S10-S13). There is no 'over-constrained' state and no way to say 'these constraints conflict'. (compared with D-Cubed/Parasolid-style solvers in Fusion/SolidWorks, planegcs in Onshape/FreeCAD)
- (major) **Point-level Fix (lock one endpoint or centre) instead of locking the whole curve**: Fixed on a circle or line locks its size too (S14). Anchoring one corner of a line rectangle requires a helper point entity, and that route fails (S1). (compared with Fusion Fix/Unfix on a point, SolidWorks Fix)
- (major) **Solver-aware rectangles (corner/centre coincident, horizontal/vertical, equal, concentric, symmetric) or a rectangle tool that emits constrained lines**: The rectangle entity is rigid: every relation except Fixed and its own width/height is 'recorded, not solved' (S13). Common tasks like centring a hole on a plate cannot be done. (compared with Fusion 2-point rectangle, which creates 4 constrained lines)
- (major) **Arc end-point joins (coincident/tangent at arc ends) in the solver**: Documented limit, but it makes rounded rectangles, slots and fillet chains break on edit (S18). Profile chains with arcs rely on 'tangent by construction' only. (compared with Fusion/Onshape all curve-end coincident and tangent)
- (minor) **Ellipse axis/rotation dimensions, equal on ellipses, tangent/coincident handling of ellipses and splines**: An ellipse has 5 DOF and only perimeter or Fix can reduce them; radius dims are refused ('applies to one circle or arc'). (compared with Fusion ellipse major/minor axis dimensions, SolidWorks ellipse dims)
- (minor) **Expressions on angle, arc-length and perimeter dimensions, and expressions that reference other sketch dimensions (d1*2)**: set-sketch-dimension with expression on angle, arc-length or perimeter returns 'The sketch dimension edit is invalid.' (not a reason). 'c.radius' is not resolvable. Both are listed as not done in docs/PDF_SPEC_AUDIT.md, but the error is unhelpful. (compared with Fusion user and model parameters, SolidWorks Equations)

### Verified working

- Single-entity dimensions: line length (0.01 to 10000 mm), circle radius, rectangle width/height, angle between joined lines (0 to 359.999 deg, lengths preserved, fixed first or second line handled), arc length (CW and CCW, over 180 deg), circle/rectangle/ellipse perimeter. Rectangle w+h+perimeter disagreement is refused with a message.
- Out-of-range and NaN guards on set-sketch-dimension: 0, negative, 0.009, 10001 mm, NaN and Infinity all return diagnostics, not corruption.
- Classic DOF: line 4, circle 3, rectangle 5 (3 with w+h), point 2; circle with a fixed point-centre plus radius gives 0; triangle with 3 side dims gives 3 DOF and the 30/40/50 triangle solves with correct side lengths; hexagon DOF 7; L-bracket before dims 6.
- Driven (reference) dimensions on length, radius, rect w/h, angle never move geometry, take 0 DOF, and measure live; driven to driving works.
- Suppress/restore: horizontal, line length and angle and arc-length all snap back correctly; relaxed constraints give DOF back (+1); a relaxed dimension is not re-imposed by later solves.
- Single-relation solves keep other relations: midpoint follows a length change, concentric stays concentric on radius edits, parallel and collinear hold, tangent line-circle holds when the line length changes or radius changes (single tangent), equal circles propagate radius.
- Determinism and idempotence: solve twice equals once (0 moved), repeated identical dimension applies leave 1 constraint and identical geometry, 30 alternating 10/25 edits do not drift, JSON round trip keeps DOF 6 and re-solves identically.
- Performance: 200 entities / 400 constraints solve in 25 ms, 500 entities / 999 constraints in 42 ms, analyze in 4 ms; far-from-origin (9000 mm) edits keep exact 123.456789.
- Expressions: radius = 2*pin_r follows the parameter (6 to 9 gives 18); units (in, cm, m) convert; angle-plus-length and bad expressions are refused with a character position; a failing param update keeps the last good value and reports it.
- Conflicting fixed geometry is refused with a named constraint (parallel on two fixed lines, horizontal on a fixed slanted line, equal on two unequal fixed circles, angle on two fixed lines).
- Entity delete removes dependent constraints; the repair panel flags duplicate/redundant parallel and redundant dimension on an equal pair, and open chains.

Not checked in this area: React/UI behaviour (SketchWorkspace dimension editor, Constrain buttons, padlock rendering), undo/redo, dimension label layout (dimension-layout.ts), smooth (G2), pierce, refraction, spline and ellipse relations beyond the checks above, arc-to-arc tangent chains, construction plane/tilted sketches, and the full repair-panel fixes. No browser or UI was driven. Probes used the compiled .test-dist output of the day, not a fresh build.

## C. Sketch environment: UX flow and feature-gap audit from a working mecha

I ran about 20 probe scripts (200+ cases) against the compiled logic and read the sketch React code. The sketch is broad: about 35 tools, 18 edit commands, Fusion-style palette, dynamic input, marking menu, repair panel. But a working engineer hits real walls. (1) The project accepts only 500 operations in total, then every edit is refused. (2) Line profiles with any branching vertex produce 0 profiles. (3) Filleting or chamfering a corner of lines drawn with the Line tool is refused. (4) No driving dimension between two entities or from the origin, and no point-on-curve. (5) The DOF count and fully-defined state are unreliable. (6) Conflict messages are unusable. (7) No way to select a constraint on the canvas. Most other problems are UX rough edges: ribbon chips advertising dead hotkeys, silently ignored typed units, Cancel that does not cancel, and palette settings that reset on workspace switch.

### [blocker] E01: Project accepts only 500 operations in total, then every edit is refused

- Evidence: reproduced by me
- Repro: Probe p15: createWorkbenchProject, then apply 100 add-sketch-entity ops + toggle-sketch-construction ops via applyWorkbenchOperation. Every UI action (each line click, constraint, dimension, drag, extrude) is one op.
- Expected: A normal multi-hour design session keeps working; old history is compacted automatically or on request.
- Actual: Op 501 fails: RESOURCE_LIMIT 'The preview audit reached its 500-entry limit. Recovery: Export the project and start a compacted revision lineage.' No compaction exists in the app (grep found none). Validation also requires audit.length === revision. A 60-curve sketch with relations and dimensions uses 200+ ops.
- Where: packages/workbench-core/src/operations.ts:112; validation.ts:55,990; workbench-health warns only at 450
- Impact on an engineer: A project becomes read-only after a few sketches. Undo only gives entries back. The message points to a feature that does not exist, and it is not in PDF_SPEC_AUDIT.md (only in the PRD).

### [major] E02: Line loops with any branching vertex yield zero profiles; the validator calls it 'Valid'

- Evidence: reproduced by me
- Repro: Probe p18/p20: a 4-line box plus a dividing line, properly split (7 lines, T-junctions at (0,5) and (20,5)). Also two adjacent squares from 7 lines, and a box with a corner-to-corner diagonal.
- Expected: Two regions (as in Fusion), or at least the outer loop.
- Actual: detectSketchProfiles returns 0. Repair summary says 'No errors. No warnings. 0 closed profiles'; checkSketch gives only info lines 'More than two curves meet at (20, 5) mm; profiles need exactly two'. An unsplit chord is ignored and 1 profile of area 200 is returned.
- Where: packages/workbench-sketch/src/index.ts:442-477 (detectCurveLoops); edit-tools.ts checkSketch
- Impact on an engineer: Plates with a rib line, shared edges, or 'divide a rectangle' sketches cannot be extruded. The report gives no actionable reason and there is no auto-split at intersections.

### [major] E03: Overlapping closed shapes are not split into regions

- Evidence: reproduced by me
- Repro: Probe p17/p18: two overlapping circles; a rectangle with a circle straddling its edge; a rectangle crossed by a full-width line.
- Expected: Fusion gives 3 regions for two overlapping circles (A only, lens, B only). A rect plus an overlapping circle also gives 3, and a rect split by a line gives 2.
- Actual: Two overlapping circles give 2 profiles (the full circles). Rect plus overlapping circle gives 2 (rectangle:800, circle:201). Rect plus a spanning line gives 1. Only nested islands are handled (as holes).
- Where: packages/workbench-sketch/src/index.ts:442-477
- Impact on an engineer: You cannot extrude the lens or the crescent without manual Split and Trim on every curve. The common 'sketch overlapping shapes, pick regions' workflow does not exist.

### [major] E04: Fillet / Chamfer / Trim on a corner of Line-tool geometry is refused with CONSTRAINT_CONFLICT

- Evidence: reproduced by me
- Repro: Probe p6/p7: emulate the Line tool exactly (autoConstraintsFor chain: coincident joints plus H/V from guides). Run filletCorners R3 on two adjacent lines, then apply-sketch-edit. Also trimAt on a box edge (p5).
- Expected: Fillet drops the corner coincident, adds tangent plus radius, and succeeds.
- Actual: FAIL[CONSTRAINT_CONFLICT] 'This edit conflicts with a sketch relation on chain1, chain2. Moved line chain1; Moved line chain2.' Same with only a coincident, and for chamfer and trim. Deleting or relaxing the coincident first makes it work.
- Where: packages/workbench-sketch/src/edit-tools.ts filletCorners/chamferCorners/trimAt (plans carry no removeConstraintIds); operations.ts:1316-1325
- Impact on an engineer: Drawing an outline with the Line tool and rounding a corner, the first thing everyone does, fails. The advised 'Relax Relations' is not obvious or targeted.

### [major] E05: Fillet, chamfer and offset create no relations, so results are not parametric

- Evidence: reproduced by probe agent
- Repro: Probe p3/p12: filletCorners on two lines, then offsetEntities on a loop, then inspect addConstraints and constraints after apply.
- Expected: Fillet adds tangent joints and a radius dimension; offset keeps an offset relation.
- Actual: addConstraints.length is 0 for fillet and offset. The fillet arc ends are not joined to the lines, and changing a neighbouring line leaves the arc behind.
- Where: packages/workbench-sketch/src/edit-tools.ts:72, 446, 468
- Impact on an engineer: Edits dimensioned later pull geometry apart. Design intent is lost; fillet radius is not a driving value.

### [major] E06: Arc radius cannot be dimensioned from the UI although the core supports it

- Evidence: reproduced by probe agent
- Repro: Probe p12: set-sketch-dimension radius=12 on an arc returns OK. In the UI, Sketch Dimension on an arc, or the inspector, offers only arc length / 'reference only'.
- Expected: Click an arc (e.g. a fillet or tangent arc) and type a radius.
- Actual: openDimensionEditor forces arc -> 'arc-length'. EntityDimensions shows 'Three-point arc: reference only'. Ellipse axes cannot be driven at all (core refuses width/radius; only perimeter).
- Where: apps/studio-web/src/workspaces/SketchWorkspace.tsx:784,1890; ConstraintExtras.tsx dimensionTarget
- Impact on an engineer: Fillet and slot arcs cannot be sized by radius. Radius is the most common dimension on arcs.

### [major] E07: DOF count and 'fully constrained' are unreliable; redundancy goes undetected

- Evidence: reproduced by probe agent
- Repro: Probe p8/p9: 4 lines with 4 coincident joints, H/V, length dims and Fixed on the bottom line. Also: concentric circles with one fixed; add a duplicate Parallel / Horizontal; add a third redundant length (c=60 after a=60).
- Expected: True DOF 0 'Fully constrained'; duplicates flagged redundant.
- Actual: Reports 2 DOF 'underconstrained' (true 0). Concentric+fixed shows 2 (true 1). Duplicate parallel and horizontal are accepted silently (constraints grow to 2). Redundant dimension c=60 accepted; Repair reports 0 warnings.
- Where: packages/workbench-sketch/src/index.ts:120-230 (per-entity subtraction analyzeWorkbenchSketch); sketch-repair.ts
- Impact on an engineer: You can never trust the padlock/colour coding. Fix on one line cannot reach 0 DOF. Over-constraint is not warned. The UI calls it an 'estimate', but the colouring and padlock rely on it.

### [major] E08: Conflict errors use solver jargon and do not name the conflicting relations

- Evidence: reproduced by probe agent
- Repro: Probe p9: Parallel then Perpendicular on the same two lines; box with a=60 then c=50; Horizontal then Vertical on one line; Rotate a loop that has H/V relations.
- Expected: Say which relations conflict, and highlight them.
- Actual: CONSTRAINT_CONFLICT 'The analytic solver exceeded 8 deterministic passes. Remove cyclic relations or delegate the sketch to a nonlinear solver backend.' For H+V: 'Geometry entity:p is degenerate'.
- Where: packages/workbench-core/src/operations.ts solveFailure; parametric-sketch-core/src/solver.ts
- Impact on an engineer: An engineer cannot fix an over-constrained sketch from this text. 'Cyclic relations' and 'nonlinear backend' are wrong advice here.

### [major] E09: A specific constraint cannot be selected or deleted from the canvas; the list shows only the last 10

- Evidence: read from code, not run
- Repro: Code-read. Constraint glyphs have pointer-events none. The 'Constraint records' list is built from constraints.slice(-10).reverse(); clicking a row deletes it at once. 'Relations on selection' only relaxes/restores. Navigator Relations tab only selects.
- Expected: Click a glyph, see its geometry highlighted, press Delete; every constraint reachable.
- Actual: Older constraints can only be removed by deleting geometry. Glyphs show 'T', 'C', 'S', 'D' letters with no hover or legend. Delete is a bare one-click with no label.
- Where: SketchWorkspace.tsx:1762, 2061-2072; styles/workspaces.css:470; SketchEditPanel.tsx:275-294; ui/ProjectTree.tsx:250
- Impact on an engineer: Constraint cleanup in a sketch with more than 10 relations is nearly impossible without relaxing everything.

### [major] E10: Typed dynamic input silently ignores units and expressions

- Evidence: reproduced by probe agent
- Repro: Probe p2: parseDynamicNumber('10mm'), ('10 mm'), ('2*5'), ('1/2'), ('plate_w'), ('1 in') all return undefined. commitDynamicInput skips unparsable fields. Also '0x10' parses as 16.
- Expected: Accept units and expressions as the dimension editor does, or reject with a message.
- Actual: The text stays in the 'locked' field, but the shape is placed with the cursor-implied value and no message.
- Where: packages/workbench-sketch/src/dynamic-input.ts:128; SketchWorkspace.tsx:713-724
- Impact on an engineer: A user who types '25.4mm' or '1/2' gets geometry at a different size without noticing. Dimension editor and plane dialog behave differently from drawing input.

### [major] E11: Undo during a line chain leaves stale pending points and a stale tail

- Evidence: read from code, not run
- Repro: Code-read plus probe p5. Draw 2 line segments; Ctrl+Z; click again.
- Expected: Chain steps back to the earlier vertex.
- Actual: pending/chainStart/pendingInference only reset on tool or cancelVersion change. The next segment starts at the removed vertex and carries an auto Coincident to the removed entity id. The edit is refused (INVALID_PROJECT 'references a missing entity') and the line is then drawn without the relation but with a floating start.
- Where: SketchWorkspace.tsx:534-542,678-699; probe p5 dangling-constraint result
- Impact on an engineer: A routine Ctrl+Z mid-polyline produces disconnected geometry, silently.

### [major] E12: Cancel in the confirmation corner does not cancel; Finish after deleting everything keeps old geometry

- Evidence: read from code, not run
- Repro: Code-read. Click Cancel after drawing: the app only switches workspace. Finish when the working sketch is empty.
- Expected: Cancel discards the session's edits (or is not offered). Finish after emptying a sketch updates the timeline sketch.
- Actual: Cancel keeps all geometry (status text: 'committed geometry is kept') though its tooltip says 'Cancel the sketch'. commitWorkingSketch returns editing?.id when entities.length === 0, so emptying an existing timeline sketch and pressing Finish leaves the old geometry in the timeline, with the message 'Finished the sketch into the timeline'.
- Where: App.tsx:3859, 2392-2408; SketchWorkspace.tsx:1690
- Impact on an engineer: No clean discard. Deleting a sketch's contents can silently not take effect.

### [major] E13: Profile gaps of 1e-6 to <1e-3 mm kill the profile and the checker reports nothing

- Evidence: reproduced by probe agent
- Repro: Probe p19: 20x10 box of 4 lines with the last endpoint off by g.
- Expected: A gap warning at any size that stops a profile.
- Actual: g=1e-7 gives 1 profile; g=1e-6..1e-4 gives 0 profiles and the repair report lists no issue ('Valid, but no closed profile'); only g>=1e-3 reports 'Gap of 0.001 mm'.
- Where: packages/workbench-sketch/src/index.ts detectCurveLoops tolerance vs sketch-repair.ts gap threshold
- Impact on an engineer: Invisible gaps from typed decimals or rotated geometry make Create solid silently unavailable with no explanation.

### [minor] E14: Ribbon chips advertise hotkeys that do not exist

- Evidence: reproduced by me
- Repro: Probe p1: resolveSketchHotkey for e, and ribbon chips R2, R3, C2, C3, A2, A3.
- Expected: A chip is a working shortcut.
- Actual: 'E' (ellipse) returns nothing; 'R2/R3/C2/C3/A2/A3' have no binding (only r, c, a). No keys for polygon, slot, spline, point, mirror, fillet, extend.
- Where: ui/WorkbenchRibbon.tsx:100-113; packages/workbench-sketch/src/hotkeys.ts:61
- Impact on an engineer: Pressing the shown key does nothing; muscle-memory shortcuts do not match Fusion for ellipse.

### [minor] E15: Shortcut help is inaccurate and Enter cannot end a line chain

- Evidence: reproduced by probe agent
- Repro: Probe p1 against SKETCH_HOTKEY_HELP.
- Expected: Help matches behaviour; Enter ends the chain.
- Actual: Backspace deletes the selection when no points are pending (help says only 'remove last point'). Delete cancels the pending chain even when curves are selected. Enter also finishes Profile (help says spline only). Enter does nothing on Line. Shift+Tab returns nothing.
- Where: packages/workbench-sketch/src/hotkeys.ts:91-100,117-137
- Impact on an engineer: Small surprises in the keyboard-only flow.

### [minor] E16: Palette toggles and tool settings reset every time you leave and re-enter the sketch

- Evidence: read from code, not run
- Repro: Code-read. Turn Snap/Auto-constrain/Dimensions off, set polygon sides, extrude settings or Dynamic Mirror; switch to Part and back.
- Expected: Preferences persist for the session.
- Actual: All are useState inside SketchWorkspace, which is unmounted when the workspace changes (conditional mount).
- Where: SketchWorkspace.tsx:256-352; App.tsx:3859
- Impact on an engineer: Snap/auto-constraint choices and solid parameters must be redone after each Finish/edit cycle.

### [minor] E17: Status bar shows '1 selected' for any multi-selection

- Evidence: read from code, not run
- Repro: Code-read. Ctrl+A with 200 curves, or box-select 12.
- Expected: N selected.
- Actual: The footer prints selectedId === null ? '0 selected' : '1 selected'; sketch multi-selection is local state.
- Where: App.tsx:3933; SketchWorkspace.tsx:286
- Impact on an engineer: Cannot confirm what a Copy/Offset/Delete will hit.

### [minor] E18: Sketch ignores display units; angle editor is labelled in millimetres

- Evidence: read from code, not run
- Repro: Code-read. Switch display unit to inch in Part; open a sketch. Open the angle dimension editor.
- Expected: Sketch honours the document unit; the angle editor shows degrees.
- Actual: All sketch fields, HUD and dimensions are hard-coded mm; the footer still shows 'in'. The editor always renders '<small>mm</small>' and aria-label '… in millimetres', also for 'Angle (degrees)'. The Display units ribbon exists only in Part.
- Where: SketchWorkspace.tsx:1793,1802,1687; ui/WorkbenchRibbon.tsx:365
- Impact on an engineer: Inch-based designers get mismatched units; mislabelled angle field.

### [minor] E19: Edit-tool panels: no Enter-to-apply, no live preview, no on-canvas pick, comma decimals rejected

- Evidence: read from code, not run
- Repro: Code-read plus probe p3. Offset: type 12,5 and press Enter.
- Expected: Enter applies; preview of offset/fillet; pick centre or corner on the canvas; comma accepted as in dynamic input.
- Actual: Inputs have no key handler (Apply button only). Number('12,5') is NaN (generic 'Enter an offset distance…'). Rotate/scale/pattern centres are typed numbers (default 0,0). Esc is ignored while an input has focus. No preview for any tool, and trim does not highlight what will be removed.
- Where: SketchEditPanel.tsx:152-184; hotkeys ignore inputs (useSketchHotkeys.ts:10)
- Impact on an engineer: Slow trial-and-undo workflow for the daily modify tools.

### [minor] E20: Offset direction depends on how the line was drawn; no flip, no chain options

- Evidence: reproduced by probe agent
- Repro: Probe p3: offsetEntities +5 on (0,0)->(10,0) and on (10,0)->(0,0).
- Expected: Predictable side with preview and flip.
- Actual: Lands at y=+5 for the first and y=-5 for the second. The tool text says 'positive is outward for closed loops' but the open-line rule is direction-based. No tangent-chain select or corner-type option.
- Where: packages/workbench-sketch/src/edit-tools.ts:72; SketchEditPanel.tsx:62
- Impact on an engineer: Need trial and undo to find the side.

### [minor] E21: Rectangle entity cannot be trimmed or cornered; error gives no workaround

- Evidence: reproduced by probe agent
- Repro: Probe p17: trimAt on a rectangle crossed by a line; cornerLines on a rectangle.
- Expected: Trim works, or the message says Split first.
- Actual: 'Trim applies to lines, arcs and circles; a rectangle is a single entity.' / 'Select exactly two lines.' Fillet All Corners works (converts to 8 lines/arcs).
- Where: packages/workbench-sketch/src/edit-tools.ts trimAt
- Impact on an engineer: Draw rectangle then trim is the commonest sequence; the user must find Split first.

### [minor] E22: Model envelope: geometry beyond ±10,000 mm or below 0.01 mm is rejected with a misleading message

- Evidence: reproduced by probe agent
- Repro: Probe p7: add-sketch-entity with a line to 100000 mm or length 0.001; set-sketch-dimension 12000 or 0.0001.
- Expected: A message naming the limit when clicking/typing.
- Actual: Entity: 'A sketch entity is invalid or has a duplicate ID.' Dimension: OUTSIDE_SUPPORTED_ENVELOPE '0.01–10,000 mm'. The sketch plane dialog allows an offset up to ±100000. Typed 0.005 gives 'Type a size greater than zero'.
- Where: packages/workbench-core/src/validation.ts:56; SketchPlaneDialog.tsx:94; dynamic-input.ts
- Impact on an engineer: A 12 m beam or micron features cannot be drawn; a click that fails reports an unrelated error.

### [minor] E23: Inspector buttons act on the last-picked curve while hotkeys and ribbon act on the whole selection

- Evidence: read from code, not run
- Repro: Code-read. Select 5 curves; click 'Delete primary', 'Fix primary' or palette 'Construction'; compare with Delete key, ribbon Fix Curve, X.
- Expected: Same scope everywhere.
- Actual: The buttons affect one curve; Delete/X/Fix Curve affect all selected.
- Where: SketchWorkspace.tsx:1436,1731-1736 vs 1057-1072,1010-1020
- Impact on an engineer: Partial edits on multi-selections.

### [minor] E24: Dimension display is minimal: fixed offset, no units, no repositioning, 3 decimals

- Evidence: reproduced by probe agent
- Repro: Probe p10: dimensionLayout labels; code-read of layout offset.
- Expected: Drag dimension text; precision; units; no overlaps.
- Actual: Labels are bare numbers rounded to 3 decimals (0.0004 shows '0'). Offset is a fixed 30 px (DIMENSION_OFFSET_PX), so stacked dimensions overlap. Un-dimensioned lines show a quiet length number that looks like a dimension. The value editor pre-fills a 3-decimal rounded value, so Enter without editing re-drives geometry slightly.
- Where: packages/workbench-sketch/src/dimension-layout.ts:46; SketchWorkspace.tsx:1774,2049-2058
- Impact on an engineer: Dense dimensioned sketches become hard to read.

### [minor] E25: Spline editing is thin: max 24 fit points, no add/remove, no tangent handles; ellipse has only a centre handle

- Evidence: reproduced by probe agent
- Repro: Probe p14; code-read of the 24-point limit.
- Expected: Edit fit points, drag tangent handles, resize an ellipse by dragging.
- Actual: Fit points are draggable, but tangent and curvature are set only via numeric fields (angle/reach). The 24-point cap is enforced at creation. No insert/delete of fit points. Ellipse grab handles: centre only.
- Where: SketchWorkspace.tsx:622; drag.ts:162-189; ConstraintExtras.tsx:264
- Impact on an engineer: Complex curves can't be refined; ellipse can't be resized by dragging.

### [cosmetic] E26: Misleading help strings

- Evidence: read from code, not run
- Repro: Code-read. Empty Relations tab; Sketch Dimension status.
- Expected: Text matches the UI.
- Actual: Relations tab says 'The Constrain group in the ribbon … adds them', but no such ribbon group exists (the buttons are in the inspector Selection controller). The Dimension status says to 'edit the driving value in the inspector' but the editor opens in-canvas.
- Where: ui/ProjectTree.tsx:249; App.tsx:3304
- Impact on an engineer: A short hunt for a control that isn't there.

### [cosmetic] E27: Typed angles leave floating-point dust, add no H/V relation, and negative typed sizes are silently flipped

- Evidence: reproduced by probe agent
- Repro: Probe p2: pointFromDynamicInput line length 5 angle 90 gives [3e-16, 5]; rectangle width -40 with cursor right gives x=+40.
- Expected: Exact vertical with a Vertical relation; negative width goes left.
- Actual: End x = 3.06e-16; no Horizontal/Vertical auto-relation for typed points (found is undefined in placePoint). Negative typed values are abs()-ed.
- Where: dynamic-input.ts:84-120; SketchWorkspace.tsx:723
- Impact on an engineer: A 'vertical' line typed at 90° isn't exactly vertical or constrained.

### [cosmetic] E28: Canvas accessibility and hit targets

- Evidence: read from code, not run
- Repro: Code-read.
- Expected: Keyboard focus and operable controls.
- Actual: The interactive canvas is role=img with no focus or keyboard path to select entities; grab handles have r=5px (10px), dimension points r=6px; constraint glyphs inert; reduced-motion only in responsive.css.
- Where: SketchWorkspace.tsx:1302,1991,1365; styles/workspaces.css:973
- Impact on an engineer: Hard for keyboard users and for small handles on touch screens.

### Missing capability

- (blocker) **Driving distance dimension between two entities/points (horizontal, vertical, aligned), point-to-line, line-to-line, and from the origin**: Hole position, edge offset and spacing are dimensioned this way. Today only single-entity length/width/height/radius/angle/arc/perimeter can drive; two-point pairs are 'reference measurement'. set-sketch-dimension refuses a second entity. (compared with Fusion Sketch Dimension, SolidWorks Smart Dimension, Onshape Dimension (all drive any pair))
- (major) **Sketch origin and axes as referenceable geometry (coincident to origin, point on axis, dimension from origin)**: Needed to locate a sketch and reach a fully defined state. Origin is only a drawn dot and an 'origin' snap; no constraint uses it, so the only anchor is Fix on a whole curve. (compared with Fusion/SolidWorks/Onshape: origin is constrainable)
- (major) **Point-on-curve (coincident to a line/circle/arc), arc end-point coincident/midpoint, rectangle corner relations**: constraintFit refuses arc ends, rectangle corners and spline points; 'on-curve' snap creates no relation. Slots, fillets and profile arcs are 'tangent by construction' only. (compared with All three have Coincident to curve and endpoints of arcs)
- (major) **Automatic region subdivision at intersections (all enclosed regions selectable, auto-split on crossings)**: Overlapping or divided shapes are common in layout sketches; currently 0 or whole-shape profiles. (compared with Fusion profile regions, SolidWorks contour selection, Onshape regions)
- (major) **Sketch DXF/SVG import and DXF export of a sketch**: Laser/CNC outlines and vendor drawings arrive as DXF. Only flat-pattern DXF export exists; DWG/DXF in the exchange list is 'converter-required' and is not a sketch import. (compared with Fusion Insert DXF/SVG and Save as DXF; SolidWorks DXF import to sketch; Onshape DXF import)
- (major) **Fillet by clicking a corner (multi-select corners, keep tangent plus radius), Offset with chain/tangent options, live preview**: Fillet needs two preselected lines and a typed radius; all-4-lines fillet is refused ('Select exactly two lines'); no relations remain; no preview. (compared with Fusion Fillet/Offset dialogs with preview and Tangent Chain; SolidWorks Sketch Fillet)
- (minor) **Power Trim (drag across curves), trim hover preview, trim to closest**: Trim is one click per segment with no highlight of what is removed. (compared with Fusion Trim; SolidWorks Power Trim)
- (minor) **Draw-as-construction mode (toggle while drawing)**: Must draw then convert. X only toggles the selection. Same for hide/show of a whole sketch from the canvas. (compared with Fusion Normal/Construction toggle; SolidWorks For construction checkbox)
- (minor) **Path pattern; associative/parametric sketch patterns; pattern instance suppression**: Rect/circular patterns are static copies (max 101 instances), not editable after. (compared with Fusion Rectangular/Circular/Path sketch patterns)
- (minor) **Hold-key temporary snap override and snap/grid increment control**: Snap is a single palette checkbox; grid steps are adaptive; no way to set 5 mm increments. (compared with Fusion Ctrl-to-disable snap, Grid and Snap settings)
- (minor) **Dimension text drag/offset, tolerance and precision settings, driving-vs-reference toggle for line length/radius/diameter**: Reference exists only via the arc-length / perimeter / angle panel; no reference diameter; layout fixed. (compared with Fusion/SolidWorks dimension properties)
- (minor) **Sketch text with true fonts and symbols (Ø ± ° µ, lowercase), editable after placement**: Probe p11: single-stroke caps only; 'Ø20' and 'é' rejected. (compared with Fusion Text tool (TrueType); SolidWorks Text)
- (minor) **Live (associative) projection and sketch-on-face re-attach**: Project/Intersect/Convert are snapshots; the plane dialog offers only axis-aligned faces from a list, not a clicked face. (compared with Fusion Project (linked); Onshape Use/Project)
- (minor) **Equations/parameters in angle, arc, perimeter dimensions and in typed draw input**: Expressions only work for length/width/height/radius in the editor. (compared with Fusion parametric dimensions in any field)
- (minor) **Command search (S) entries for all ribbon sketch tools**: Probe p13: 19 sketch tools, 6 edit tools and 5 project/command buttons are ribbon-only. (compared with Fusion S-key search lists every tool)
- (minor) **Constraint glyph hover highlight, per-type show/hide, redundancy highlight**: One global 'Constraints' toggle; no per-type filter, no hover highlight of related geometry. (compared with Fusion Sketch Palette > Show Constraints)
- (nice) **Double-click gestures, touch pinch/two-finger pan, zoom window / zoom to selection / keyboard zoom**: No onDoubleClick; only wheel, middle/Space/Pan-mode and Fit exist. (compared with Fusion/Onshape navigation)
- (nice) **Sketch slice (section view) and sketch Measure tool**: No slice toggle; Measure mode is filtered out in the sketch workspace (only 2-point direct readout). (compared with Fusion Slice, Inspect > Measure)

### Verified working

- Hotkey Esc ladder: drag, points, pick, dimension, edit tool, drawing tool, selection (probe p1 matches the documented order); Tab/typed-digit focus into dynamic fields; Ctrl+A/C/X/V gated by selection
- Window vs crossing box selection: left-to-right takes enclosed curves, right-to-left takes touched curves (p11)
- Edit tool input validation: offset, fillet, chamfer, pattern, move, rotate, scale, stretch and corner reject 0, NaN, out of range with specific messages (p3)
- Rectangle entity fillet converts to 8 lines/arcs; fillet with no relations succeeds; deleting/relaxing the coincident first lets the line-corner fillet through (p7)
- Circular pattern: 360 spreads evenly, partial angle uses count-1; limit of 101 instances is reported (p3)
- Setting a length on a constrained box propagates through coincident joints (p6)
- Clipboard: copy keeps relations and dimensions, paste offset grows with each paste, plan refuses over the entity limit (p11)
- Trim of a crossing line, circle to arc, Split carries relations, Extend refuses with a reason (p4)
- Constrain button table (constraintFit) gives a specific disabled reason for each unsupported pair (p9)
- Text tool rejects unsupported glyphs and lists the supported set (p11)
- Performance is fine: inference 0.2-0.3 ms with 300-500 entities, profile detection 5 ms, analysis 1.6 ms (p11)
- Camera limits 0.25 mm to 200 m view width with adaptive grid at extremes (p11)
- Block library validation: 150-curve limit, name length, and 61 saved blocks work (p16)
- Core refuses H+V, conflicting length dimensions and dangling constraint ids without corrupting the sketch (p5/p9)

Not checked in this area: Live UI behaviour (another auditor does that): actual rendering, pointer gestures, marking-menu keyboard nav, focus handling, mobile layout. Also not checked: solver numerical accuracy for tangent/symmetry, spline math, extrude/revolve/sweep/loft results, Sketch Repair auto-fix correctness, JSON save/load round trip and reload of the 500-op state, timeline re-edit rebuild, ReachOptions, per-sketch visibility in the browser, collaboration, and performance with real browser rendering of 200+ SVG entities.

## C. Curve creation tools, dynamic input, inference/snapping, auto-constrai

About 27 probe scripts were run against the compiled modules. Creation geometry, the camera math and window/crossing selection are accurate. The real problems are in what the shape tools leave behind and how the editing helpers read it. (1) Polygon and parallelogram shapes cannot be dragged or dimensioned: the solver fails with "exceeded 8 deterministic passes". (2) Slot and rounded-rectangle shapes fall apart when a side is dimensioned or dragged: the profile count goes 1 to 0 and the edit still reports OK. (3) The centerpoint arc cannot exceed 180 degrees. (4) The Tangent selection filter fails for any arc over about 4 degrees. (5) Profile detection returns nothing for squares that share an edge or have a stray line at a corner. (6) Fit-point splines loop with uneven click spacing. (7) Dynamic input covers only 7 tools and silently ignores text it cannot parse. (8) Origin snaps and arc and ellipse centres create no constraints. (9) Polygons are only equilateral, not regular. Docs/PDF_SPEC_AUDIT.md-documented limits are not repeated unless worse than documented.

### [blocker] T01: Polygon and parallelogram cannot be dragged or dimensioned: solver fails with a cryptic error

- Evidence: reproduced by probe agent
- Repro: buildPolygon([0,0],[10,0],n,ids) for n=3,4,6, add it with apply-sketch-edit, then set-sketch-dimension length=12 on one side (or dragSketchHandle on a vertex or on the line body). Same for buildCurveTool('parallelogram',[[0,0],[10,0],[14,6]]). Plain 4-line coincident loop drags fine; adding 'equal' x3 breaks it.
- Expected: Side resizes, the other sides follow, the polygon stays closed. Dragging a vertex deforms or moves it.
- Actual: Every attempt returns 'The analytic solver exceeded 8 deterministic passes.' (hexagon, square, triangle, parallelogram; drag vertex and drag body). Adding the shape succeeds, so the failure only shows when the user edits it.
- Where: shapes.ts buildPolygon (coincident cycle plus equal chain), basic-curve-shapes.ts buildParallelogram; solver in workbench-core/src/sketch-solve.ts and parametric-sketch-core
- Impact on an engineer: Any polygon or parallelogram drawn with the tool is effectively frozen. The user cannot resize, dimension or move it, and the error text says nothing useful.

### [blocker] T02: Slot and rounded rectangle tear apart on edit; the profile disappears and the edit still reports OK

- Evidence: reproduced by probe agent
- Repro: Add buildSlot([0,0],[20,0],[10,3]) or the rounded rectangle [[0,0],[40,20]] r=5. Run set-sketch-dimension length=12 on a straight side, or dragSketchHandle point 'end' on a side line, or drag the slot cap centre. Then call detectSketchProfiles.
- Expected: Caps and corner arcs follow the line end (tangent joints stay joined), or the edit is refused.
- Actual: Edit returns OK and only the line moves (line end 20 to 12 while the cap arc stays at x=20). Profiles go 1 to 0. Drag of cap centre or side end returns ok with moved=1 and the same loss. Dragging the line body or an arc mid point fails with 'exceeded 8 deterministic passes'.
- Where: shapes.ts buildSlot and basic-curve-shapes.ts buildRoundedRectangle record only 'tangent' (no Coincident, because arc ends are unsolvable per constraint-fit.ts); sketch-solve.ts does not enforce line-arc end contact
- Impact on an engineer: A routine action (change slot length or rounded-plate edge) silently turns a closed profile into open curves, so Extrude fails afterwards with no hint why. Arc slots are documented as 'tangent by construction'; slot and rounded rectangle are not documented as fragile.

### [major] T03: Polygon is only equilateral, not regular, for n>=4

- Evidence: reproduced by probe agent
- Repro: analyzeWorkbenchSketch on buildPolygon([0,0],[10,0],n). Result: n=4 DOF 5, n=6 DOF 7, n=64 DOF 65 (true regular polygon is 4 DOF: centre, size, rotation).
- Expected: Regular polygon stays regular and has 4 DOF: a centre and circumscribing circle, or equal angles.
- Actual: Only coincident joints and 'equal' side lengths are recorded. A 4-gon is a rhombus once the solver can move it; a hexagon can become a non-regular equilateral hexagon. No centre point or construction circle exists to dimension or locate it.
- Where: shapes.ts buildPolygon
- Impact on an engineer: The polygon cannot be sized by one radius or across-flats dimension (needed for hex nuts, bolt heads, hex pockets) and cannot be located by its centre.

### [major] T04: Centerpoint arc can never exceed 180 degrees

- Evidence: reproduced by probe agent
- Repro: buildSketchEntity('arc-center',[[0,0],[10,0],[10cos a, 10sin a]]) for a=181, 270, 359.
- Expected: The arc direction follows the pointer path: a 270 degree CCW arc is possible.
- Actual: Sweep is normalised to (-180,180]. Click at 270 gives a 90 degree CW arc, 359 gives 1 degree, 181 gives 179 degrees on the other side. Arcs over 180 degrees are only reachable through the 3-point arc.
- Where: index.ts buildSketchEntity 'arc-center' (while sweep > PI loop); centerpoint arc slot has the same rule (documented)
- Impact on an engineer: Flange arcs, C-shapes and bore arcs over a half-turn cannot be drawn with the centre-first tool engineers prefer.

### [major] T05: Tangent selection filter fails on any real arc (uses chord direction, not tangent)

- Evidence: reproduced by probe agent
- Repro: selectTangentSketchEntities on a line plus an exactly tangent arc: sweep 4 degrees selects both; 10, 20, 45, 90, 180 degrees select only the line. Rounded rectangle returns 1 of 8, slot 1 of 4.
- Expected: Whole tangent-continuous chain (8 of 8, 4 of 4).
- Actual: curveEndTangents takes arc end tangents from the start-to-mid and mid-to-end chords, so the error is about sweep/4 and exceeds the 2 degree tolerance beyond about 4 degrees. Spline ends use the first and last fit chord.
- Where: index.ts curveEndTangents / curvesShareTangent
- Impact on an engineer: The Tangent selection filter, used to grab a fillet-rounded outline for offset, copy or construction toggle, selects one curve instead of the chain.

### [major] T06: Profile detection drops whole loops for shared edges and stray ends

- Evidence: reproduced by probe agent
- Repro: detectSketchProfiles on: (a) two squares of lines sharing one edge (7 lines); (b) a closed square plus one line starting at a corner and sticking outward; (c) two squares touching at a corner.
- Expected: (a) the two squares or at least the outer loop; (b) the square; (c) both squares.
- Actual: (a) NONE; (b) NONE; (c) NONE. A stray line crossing a mid-edge (not touching a vertex) is ignored and the square is found, so behaviour is inconsistent. Any vertex with degree other than 2 discards the entire component.
- Where: index.ts detectCurveLoops (requires every joint to have exactly 2 edges)
- Impact on an engineer: A rectangle divided by a rib line, or any construction scrap attached to a vertex, kills extrudable regions. Fusion and Onshape form regions from planar arrangements.

### [major] T07: Fit-point spline loops and backtracks when clicks are unevenly spaced

- Evidence: reproduced by probe agent
- Repro: sampleSpline([[0,0],[1,10],[100,10]],16) and [[0,0],[1,0],[2,5],[40,5],[41,0]]
- Expected: Curve follows the fit points without reversing direction.
- Actual: Uniform Catmull-Rom: x runs backwards on 10 and 20 samples, with 0.6 to 0.74 mm overshoot beyond the fit-point range. The curve-math.ts comment admits it 'loops if neighbouring gaps differ too much'. buildSketchEntity('spline') does not refuse or reparametrise.
- Where: index.ts sampleSpline (uniform parameterisation)
- Impact on an engineer: Splines through mixed-spacing points show loops or cusps and give wrong extrusion edges; a centripetal or chord-length parameterisation would avoid it.

### [major] T08: Closed fit-point spline makes no profile and has an 84 degree kink at the join

- Evidence: reproduced by probe agent
- Repro: buildSketchEntity('spline',[[0,0],[10,0],[10,10],[0,0]]) is accepted; detectSketchProfiles returns 0 profiles. sampleSpline of [[0,0],[10,0],[10,10],[0,10],[0,0]] gives an 84.3 degree angle between end and start tangents.
- Expected: Closing a spline (first point equal to last) gives a smooth periodic profile.
- Actual: Accepted silently, but it needs at least 2 curves to form a loop (detectCurveLoops min 2 edges) and the end tangent is clamped, not periodic.
- Where: index.ts buildSketchEntity 'spline', detectCurveLoops, sampleSpline
- Impact on an engineer: Cam outlines, gasket shapes and organic holes drawn as one closed spline cannot be extruded. Only the control-point spline has a workaround (two splines).

### [major] T09: Dynamic input silently ignores text it cannot parse and places the cursor value instead

- Evidence: reproduced by probe agent
- Repro: parseDynamicNumber('12 mm'), '2in', '10+5', '1,000.5' all return undefined; '0x10' returns 16; '1e3' accepted. commitDynamicInput only copies parsed fields into typed; pointFromDynamicInput then uses the live cursor value for the field.
- Expected: Reject the entry with a message, or evaluate units and expressions (the app has an expression engine).
- Actual: The shape is placed at the cursor's measured size with no warning. Typed negative length or width is silently abs() (-5 becomes 5). Hex is accepted.
- Where: dynamic-input.ts parseDynamicNumber, pointFromDynamicInput; SketchWorkspace.tsx commitDynamicInput
- Impact on an engineer: A user typing '25.4 mm' or '1/2in' gets an arbitrary size and may not notice.

### [major] T10: Dynamic input exists for only 7 tools; no fields for arc, polygon, slot, ellipse, spline, 3-point circle and all curve tools

- Evidence: reproduced by probe agent
- Repro: dynamicFieldsFor(tool,1) and (tool,2) for every tool id: only line, rectangle, rectangle-center, rectangle-three-point, circle, circle-two-point return fields.
- Expected: Radius or sweep for arcs, circumradius for polygon, length and width for slots, major and minor for ellipse, rounded-rect radius.
- Actual: All others return []. The audit documents this only for the newer curve tools; arc, arc-center, arc-tangent, ellipse, polygon, slot and slot-straight (older tools) are not mentioned. There is no absolute X/Y entry for the first point either.
- Where: dynamic-input.ts dynamicFieldsFor
- Impact on an engineer: Exact-size polygons, slots and arcs can only be made by clicking on grid nodes and then editing dimensions.

### [major] T11: Snapping to the origin creates no constraint; no way to locate geometry parametrically except Fix

- Evidence: reproduced by probe agent
- Repro: draw circle, point or line with its first point snapped to origin: autoConstraintsFor returns []. primary.kind 'origin' has no entityId, so auto-constraints return early. constraintFit('distance') applies only to a line or rectangle length. SketchConstraintKind has no point-to-point, point-to-origin or point-on-curve.
- Expected: Coincident-to-origin on snap (Fusion), plus horizontal and vertical offset dimensions from the origin.
- Actual: Nothing is recorded. The only way to pin a feature is Fixed, which also locks its size.
- Where: auto-constraints.ts autoConstraintsFor; workbench-core constraint-fit.ts and types.ts
- Impact on an engineer: A sketch cannot be fully constrained with its size parametric and its position tied to the origin or a datum.

### [major] T12: Tangent arc tool does not inherit tangency from the curve it starts on and records no relation

- Evidence: reproduced by probe agent
- Repro: autoConstraintsFor with tool 'arc-tangent': entity kind arc gives ownRefs [] and [] constraints. buildSketchEntity uses click 2 as the direction (anchor to click), not the snapped curve's end tangent. No per-click prompt exists for it (SketchWorkspace nextPrompt only for fixed curve tools).
- Expected: Start on a line or arc end and the arc leaves tangent to it (as Fusion does), with a Tangent relation.
- Actual: The user has to place the direction point exactly on the curve's tangent line; any slight miss gives a visually tangent but not tangent arc, with nothing recorded.
- Where: index.ts buildSketchEntity 'arc-tangent'; auto-constraints.ts; SketchWorkspace.tsx placePoint
- Impact on an engineer: Tangent arcs for blend, fillet-like transitions and slot ends are approximate and break tangent continuity checks.

### [major] T13: Conic and control-spline fit error is larger than documented

- Evidence: reproduced by probe agent
- Repro: Measure sampled spline versus exact conicArcPoint curve for a 60 mm span, apex (30,40): rho 0.5 gives 0.013 mm, rho 0.9 gives 0.33 mm, rho 0.98 gives 0.89 mm, rho 0.05 gives 0.12 mm. Control-point spline deviation is 0.10 mm vs the true B-spline (docs say 0.24 worst).
- Expected: Audit says the conic spline stays within 0.05 mm.
- Actual: Only holds near the parabola (rho 0.5); high-rho hyperbolic arcs deviate up to 0.9 mm.
- Where: conic-curves.ts buildConicByRho (24 uniform fit points)
- Impact on an engineer: A hyperbolic or conic profile used as a machined or optical surface is off by up to nearly 1 mm without warning.

### [minor] T14: Spurious 'Intersection' inference along every spline

- Evidence: reproduced by probe agent
- Repro: inferSketchPoint over 264 hover positions along a 4-point spline (tol 1 mm): kinds returned were intersection 192, on-curve 22, endpoint 41, origin 9. The intersection hit has entityId equal to otherEntityId.
- Expected: Smooth on-curve snap, with no intersection label for a single curve.
- Actual: The spline is chopped into sample segments, adjacent segments of the same entity 'intersect' at each sample vertex (tier 1 beats on-curve tier 3), so the cursor jumps between sample vertices labelled Intersection.
- Where: inference.ts intersect loop (skips same-entity pairs only for rounds)
- Impact on an engineer: Confusing snap glyphs and quantised snapping on splines.

### [minor] T15: Ellipse is invisible to inference and auto-constraints

- Evidence: reproduced by probe agent
- Repro: inferSketchPoint 0.05 mm off an ellipse outline gives no snap; ellipse x line shows only the line's on-curve; ellipse perpendicular and tangent from an anchor never appear. Line start on ellipse centre gives [] constraints; arc-center or ellipse centre on circle centre gives [].
- Expected: On-curve, tangent, perpendicular and intersection on ellipses; coincident or concentric centres (SOLVABLE_POINT_REFS allows ellipse and arc centre).
- Actual: primitivesOf returns [] for ellipse; pointRefOf handles only line, circle, arc and point; ownRefs only for line, circle and point.
- Where: inference.ts primitivesOf; auto-constraints.ts pointRefOf and ownRefs
- Impact on an engineer: Concentric arcs and ellipse features cannot be located by snapping.

### [minor] T16: No parallel, equal-length, collinear or point-on-curve inference

- Evidence: reproduced by probe agent
- Repro: Draw a line parallel to a 37 degree line (end within 0.1 mm of the parallel): autoConstraintsFor returns []. Equal-length line gives only horizontal from the guide. Ending on a line away from its feet gives on-curve, which creates no relation.
- Expected: Fusion offers parallel, perpendicular, tangent, equal and point-on-curve (coincident) hints.
- Actual: Only coincident, midpoint, horizontal, vertical, perpendicular, tangent (line to circle or arc).
- Where: auto-constraints.ts, inference.ts
- Impact on an engineer: Many manual Constrain clicks after drawing.

### [minor] T17: Typed dynamic values lose design intent

- Evidence: read from code, not run
- Repro: Type angle 90 or 0 with a length for a line: placePoint(target,'typed') passes no found inference, so no horizontal or vertical relation; the typed length and radius are not stored as dimensions.
- Expected: Typed 0 or 90 degrees gives Horizontal or Vertical; typed sizes become driving dimensions (Fusion).
- Actual: Plain geometry only.
- Where: SketchWorkspace.tsx commitDynamicInput / placePoint (lines ~713-724, 641-660)
- Impact on an engineer: A line typed as 50 mm at 0 degrees can drift when other geometry moves.

### [minor] T18: Builders accept NaN and Infinity; the operation layer throws

- Evidence: reproduced by probe agent
- Repro: buildSketchEntity for line, rectangle, circle, ellipse, arc, spline or point with a NaN or Infinity coordinate returns ok with non-finite geometry (all comparisons like '< 0.01' are false for NaN). Passing that to applyWorkbenchOperation throws 'Canonical JSON rejects non-finite numbers.'
- Expected: Clear refusal.
- Actual: ok:true with NaN geometry, then an uncaught TypeError.
- Where: index.ts buildSketchEntity (no finite check); operations.ts canonicalizeJson
- Impact on an engineer: Only reachable through API or MCP callers, not mouse input, but it contradicts the 'never NaN geometry' expectation.

### [minor] T19: Size limits are inconsistent and the refusal message is misleading

- Evidence: reproduced by probe agent
- Repro: buildSketchEntity('line',[[0,0],[20000,5]]) is OK (1e9 also OK), but apply-sketch-edit refuses it with 'A sketch entity is invalid or has a duplicate ID.' (coordinate limit is 10,000 mm). Camera allows 200,000 mm views.
- Expected: A message naming the 10,000 mm limit, or a builder-level refusal.
- Actual: Generic message. Also a 240-entity text (40 x 'B') passes buildSketchText (limit 360) but the edit is refused with 'The sketch edit payload is invalid.' (limit 200 per edit).
- Where: index.ts, stroke-text.ts TEXT_MAX_ENTITIES, operations.ts validateWorkbenchOperation
- Impact on an engineer: A user zoomed out cannot place far geometry or long text and gets no cause.

### [minor] T20: Near-collinear 3-point arc or circle accepted with absurd radius, while tiny valid arcs are refused

- Evidence: reproduced by probe agent
- Repro: circle-three-point [[0,0],[100,0.0001],[200,0]] gives r 5.0e7 mm; arc [[0,0],[1000,0.001],[2000,0]] accepted (radius about 5e8). arc [[0,0],[0.005,0.0005],[0.01,0]] (r about 0.0125 mm) is refused as collinear.
- Expected: Scale-relative collinearity and a sensible maximum radius.
- Actual: Absolute thresholds (1e-4 cross product, 1e-9 determinant).
- Where: index.ts buildSketchEntity 'arc' and 'circle-three-point'
- Impact on an engineer: A slightly bent 3-point arc yields a near-straight arc with a huge circle that slows sampling and extrusion.

### [minor] T21: Arc-bounded profile area is low by up to 0.16%

- Evidence: reproduced by probe agent
- Repro: Two semicircle arcs of r=10: detectSketchProfiles areaMm2 = 313.655 vs 314.159 exact (a circle entity is exact). Slot 148.229 vs 148.274; rounded rectangle 778.417 vs 778.540.
- Expected: Exact area for arc-bounded profiles.
- Actual: Arcs facetted at pi/32; area uses the polygon.
- Where: index.ts ARC_FACET_RADIANS, detectCurveLoops
- Impact on an engineer: Area and volume of extruded arc slots and rounded plates is slightly low compared with circle entities.

### [minor] T22: Profile joint matching uses a 1e-6 mm hash grid, no neighbour check

- Evidence: reproduced by probe agent
- Repro: A four-line square whose last start differs by 1e-12 but straddles the 1e-6 rounding boundary gives 0 profiles; exact gives 1. A 4e-6 gap gives 0. selectConnectedSketchEntities treats a 0.4 mm gap as connected.
- Expected: Tolerant matching (about 1e-6 to 1e-4 mm, with neighbour cells) and consistency with the connected selection.
- Actual: Sporadic open loops after solver or imported coordinate noise.
- Where: index.ts pointKey and registerEndpoint
- Impact on an engineer: A loop that looks closed occasionally has no profile.

### [minor] T23: Alignment guides and first-point inference only for line, spline and profile

- Evidence: read from code, not run
- Repro: SketchWorkspace.tsx line 582: anchor is passed only when tool is line, spline, spline-control or profile. Horizontal and vertical alignment sources are endpoints and centres only (pointer aligned with a midpoint at (50,20) gives no snap).
- Expected: Guides from the first point for slot, ellipse major axis, arc-center, polygon and circle-two-point; alignment to midpoints and quadrants.
- Actual: A horizontal slot or ellipse axis cannot be snapped level to its own first point, except by grid nodes.
- Where: SketchWorkspace.tsx pointer(); inference.ts alignmentSources
- Impact on an engineer: Level slots and axes need typing or later constraints.

### [minor] T24: Hotkeys cover only L, R, C, A and edit keys; no per-click prompts for older multi-click tools

- Evidence: reproduced by probe agent
- Repro: resolveSketchHotkey: bound letters are a c d f l o p r t v x. Unbound: spline, ellipse, polygon, slot, point, mirror, fillet, extend, move. event.key based, so non-Latin layouts break. Ctrl+V with pending points falls through. Status prompts (CURVE_TOOL_PROMPTS) exist only for the fixed curve tools, not arc-center, arc-tangent, ellipse, polygon, slot, slot-straight, rectangle-three-point and circle-three-point.
- Expected: Hotkeys for the common tools; every multi-click tool says what the next click means.
- Actual: As described. No duplicate or conflicting keys were found.
- Where: hotkeys.ts; SketchWorkspace.tsx placePoint nextPrompt
- Impact on an engineer: Slower workflow; the user must guess what click 2 of the centerpoint arc or ellipse is.

### [minor] T25: Text font lacks degree, diameter and common symbols; NaN rotation gives a misleading error

- Evidence: reproduced by probe agent
- Repro: buildSketchText with ° Ø ⌀ # % @ * < > [ ] & ^ ~ is refused. textRotationDeg NaN gives 'Nothing to draw: text too small', not an invalid-rotation message.
- Expected: Engineering symbols at least; correct message.
- Actual: Refusals are clear for unsupported characters; the symbol set is the gap.
- Where: stroke-text.ts GLYPHS
- Impact on an engineer: Cannot engrave 'Ø12' or '90°' labels.

### [minor] T26: Fit-point spline needs at least 3 points and uses fixed limits

- Evidence: reproduced by probe agent
- Repro: buildSketchEntity('spline',[[0,0],[1,1]]) is refused ('requires 3 points'); 25 points refused; A,B,A accepted.
- Expected: Two-point spline or tangent end conditions; no duplicate-return points.
- Actual: As described.
- Where: index.ts buildSketchEntity 'spline'
- Impact on an engineer: Minor friction.

### [cosmetic] T27: Dirty floats from grid snapping and unnormalised ellipse rotation

- Evidence: reproduced by probe agent
- Repro: Grid 0.1 gives snapped y=0.30000000000000004; rectangle between grid points 0.1 and 0.8 gives widthMm 0.7000000000000001, center y 0.6000000000000001. Ellipse swapped axes give rotationDeg 225 or 180; five-point ellipse normalises to (-90,90].
- Expected: Exact decimals; one rotation convention.
- Actual: As described.
- Where: inference.ts roundTo; index.ts buildSketchEntity 'ellipse'
- Impact on an engineer: Odd numbers in dimension fields and exports.

### [cosmetic] T28: Camera NaN guard and crossing selection tolerance

- Evidence: reproduced by probe agent
- Repro: zoomCamera(cam,[0,0],NaN) returns a NaN camera; fitCameraToViewport with NaN extents returns NaN. A 0.2 mm crossing box centred on an r=1000 mm circle between samples is missed (64-gon sagitta 1.2 mm). Inference on 300 overlapping splines takes 21 ms per call.
- Expected: Clamp or guard; exact circle hit test.
- Actual: As described. These are unlikely in normal use.
- Where: camera.ts clampWidth; selection.ts entityPolyline; inference.ts
- Impact on an engineer: Rare.

### Missing capability

- (major) **Regular polygon modes (inscribed, circumscribed, edge/side length) with a centre point and one radius dimension**: Hex nuts and bolt heads are sized across flats (circumscribed) or by edge; the tool has a single corner-radius mode and no centre or circle relation (grep: no 'inscribed' or 'circumscribed' anywhere). (compared with Fusion 360 Polygon (inscribed, circumscribed, edge), SolidWorks Polygon)
- (major) **Point-to-point and point-to-origin horizontal and vertical distance dimensions, coincident-to-origin and point-on-curve (coincident to a curve) constraints**: Needed to locate holes and features and to fully constrain a sketch. Distance applies only to a line or rectangle length; no constraint kind places a point on a curve. (compared with Fusion 360, SolidWorks, Onshape)
- (major) **Rectangle as four lines (or joinable corners and edges)**: The rectangle is one rigid entity (SOLVABLE_POINT_REFS.rectangle is empty), so a corner cannot be made coincident with a line end, an origin or a centre, and a single edge cannot be dimensioned, offset, trimmed or filleted on its own. (compared with Fusion 360 and SolidWorks draw 4 lines with constraints)
- (major) **Closed (periodic) fit-point spline and a chord-length or centripetal spline option**: Closed splines for cam profiles and gaskets; current uniform Catmull-Rom loops with uneven spacing (T07, T08). (compared with Fusion 360 Fit point spline (close), SolidWorks Spline (periodic))
- (minor) **Tangent circle (3 tangent) and circle tangent to curves; elliptical arc**: Fillet-like construction and cam or flange outlines; grep finds neither tool. (compared with Fusion 360 Circle 2-tangent and 3-tangent, Ellipse arc; SolidWorks Tangent arc and Elliptical arc)
- (minor) **Dynamic input with units, expressions, absolute X/Y entry and dimension creation**: Typing 25.4 mm or 1/2in or a parameter name; locating the first point exactly. Only plain numbers parse today. (compared with Fusion 360 dynamic input creates dimensions and accepts expressions; AutoCAD dynamic input and coordinate entry)
- (minor) **Parallel, equal-length, collinear and point-on-curve inference hints and a hold-key to suppress snapping**: Fewer manual Constrain steps; the pointer must be free of snap when precise placement is wanted. No pointer modifier handling for snapping (grep of event.ctrlKey/altKey in SketchWorkspace shows only selection use). (compared with Fusion 360 inference glyphs, SolidWorks inference lines)
- (minor) **Select-other / cycle selection for overlapping or coincident curves**: Two coincident lines (duplicates are possible: window select returns both o1 and o2) cannot be told apart by click; hit testing is SVG order. (compared with Fusion 360 Select Other; SolidWorks Select Other)
- (nice) **Polar or angle snapping (15 or 45 degree increments) and an ortho lock for line drawing**: Fast accurate angled lines without typing; only horizontal and vertical alignment exist. (compared with SolidWorks and AutoCAD polar tracking)
- (nice) **Hotkeys for spline, ellipse, polygon, slot, point, fillet, extend, move, mirror and a customisable keymap**: Only L R C A D T O X F V P are mapped. (compared with Fusion 360 and SolidWorks customisable shortcuts)
- (nice) **Engineering glyphs and outline fonts for sketch text**: Ø, ⌀, ° and lowercase text; the stroke skeleton font only bounds profiles for closed letters (documented). (compared with Fusion 360 Text with TrueType fonts)

### Verified working

- Degenerate refusals work with clear messages: zero or 0.009 mm line, zero-area rectangle, identical-point circle, collinear 3-point arc and circle, 2 or 25 point spline, duplicate spline points, polygon sides 2, 65, 3.5, NaN, polygon radius under 0.1, slot narrower than long (slot-straight), rounded-rectangle radius limits, conic rho outside 0.02 to 0.98, tension outside 0.2 to 3, hyperbola with branch point on axis or behind vertex.
- Analytic accuracy: 2-point and 3-point circles exact; 3-point rectangle (rotation, corners); ellipse axes (with major/minor swap); polygon area for n=3 to 64 matches 0.5nR²sin(2π/n) exactly; parallelogram area exact; tangent arc centre lies on the perpendicular and radius is exact in all four quadrants; centerpoint arc radius exact; arc slot area within 0.2%.
- Dynamic input: measureFromCursor then pointFromDynamicInput round-trips to 1e-15 for line, rectangle, centre rectangle, circle, 2-point circle and 3-point rectangle; zero and below-0.01 typed sizes return undefined; comma accepted as decimal separator.
- Inference priority and geometry: endpoint, centre and origin beat intersection, midpoint and quadrant, which beat perpendicular and tangent, then on-curve, then H/V alignment, then grid. Line-arc intersections, arc quadrants, arc centre, perpendicular feet and tangent points are exact (tangent error 0.000). Hidden entities ignored; tolerance is a pure input so pixel scaling is correct. 1600 lines infer in 1 ms.
- Auto-constraints add the right relations: coincident to line ends and circle centres, midpoint on a line, horizontal or vertical from guides and grid, perpendicular to a line, chained line joints and closing joints. No spurious relations were seen for arc ends or rectangle corners (the solver cannot take them).
- Camera: zoom-at-cursor anchor drift 1e-14 mm including clamped zoom; screen to sketch round trip 5e-15; pan keeps the point under the cursor; fit with floating-panel insets lands inside the free area; 1-2-5 grid ladder and clamp limits behave.
- Selection: window versus crossing by drag direction; arcs, splines, ellipses and rotated rectangles; hidden entities excluded; box inside a circle does not select it; 1e8 mm coordinates work.
- Hotkey table has no duplicate or conflicting keys; Escape ladder and Backspace and Delete rules behave; Ctrl+C, X, V gating is right.
- Shape builders are deterministic and JSON round-trip stable with no -0 or undefined fields; add through apply-sketch-edit works for polygon, slot, rounded rectangle and parallelogram (the problem starts on later edits); 500 overlapping circles and 400 line squares profile in under 40 ms.
- Five-point conic: ellipse and circle are recovered exactly and independent of point order; exact parabola is recognised; collinear, two-line and too-close sets are refused; hyperbola sits on the true curve at the fit points.
- Blend curve is G1 within 0.6 degrees at both ends; Profile tool closes the loop and joins line-line joints; tangent arc after a line is tangent.

Not checked in this area: Not exercised: real pointer and React behaviour (drag preview, DynamicInputBox focus and Tab flow, how drag failures are shown to the user), how the UI presents the T01/T02 failures, rendering of inference glyphs and dimension layouts, Trim, Extend, Fillet, Offset and Mirror edit tools, block insertion, Dynamic Mirror, repeated apply/undo through App project history (only single-operation apply was run), the solver internals (parametric-sketch-core) beyond observing outputs, and behaviour on touch or non-Latin keyboards. Findings marked code-read are from source reading only.

## C. Sketch edit and modify tools

I ran about 200 probe cases against the compiled modules. The geometry of the basic cases is exact: fillet tangency, mirror symmetry, offset distance and pattern positions. The weakness is how the tools behave in a real, constrained sketch. Fillet, chamfer, corner, and trim or extend at a joined end are refused on every line that has a Coincident relation, which the drawing tools add by default. Results come back as unconstrained dumb geometry. Several tools silently produce wrong geometry (angle chamfer over the corner angle, offset of mixed line and arc profiles, offset with self-overlap, fillet of crossing lines). Fixed relations are ignored by half the tools. NaN input crashes the apply path. Many limit violations surface as a misleading "invalid or has a duplicate ID" error.

### [blocker] E01: Fillet, chamfer, corner, and trim/extend at a joined end are refused on any line with a Coincident relation

- Evidence: reproduced by me
- Repro: Lines a (0,0)-(100,0) and b (100,0)-(100,100) with constraint coincident [a end, b start] (as shapes.ts:47 and auto-constraints.ts:62 create). filletCorners(ctx, [a,b], 10), then commit via apply-sketch-edit. The same happens with chamferCorners, trimAt on a at (80,0) with a crossing line at x=60, and extendAt on a's joined end.
- Expected: The fillet is applied. The old coincident is replaced by tangent relations or dropped with a note, as in Fusion and SolidWorks.
- Actual: FAIL[CONSTRAINT_CONFLICT] This edit conflicts with a sketch relation on b. Moved line b. The plan never sets removeConstraintIds, so the only route is a manual Relax Relations first. After that, re-enabling the relations gives 'solve would move entity:b', so the relaxed relations are left stale.
- Where: edit-tools.ts filletCorners/chamferCorners*/cornerLines/trimAt/extendAt build plans that never set removeConstraintIds; operations.ts applySketchEdit rejects when the solver has to move geometry.
- Impact on an engineer: Fillet and chamfer cannot be applied to a drawn polyline, one of the most common sketch tasks, without a manual relax step that leaves a broken sketch behind.

### [major] E02: Fixed relations are ignored by fillet, chamfer, corner, trim, extend, move, rotate and scale, but honoured by split, jog, offset-move and delete-heal

- Evidence: reproduced by probe agent
- Repro: circle c with constraint fixed [c]. transformEntities(move dx=20) commits OK and c.center becomes [20,0]. scale x3 commits OK (r=15). A fixed line a is shortened by filletCorners and by trimAt, and extended by extendAt, all committed OK. offsetMoveEntities on the same fixed circle returns 'c is fixed and would have to move'.
- Expected: A pinned curve is never moved by an edit, or the edit is refused consistently.
- Actual: The Fixed relation stays in place and now pins the curve at its new location, so an origin-locked anchor can be moved silently.
- Where: edit-tools.ts has no pinnedAmong check (sketch-clone.ts:80). It is used only by split-jog.ts, offset-move.ts and make-path.ts.
- Impact on an engineer: Locked anchor geometry silently moves; behaviour differs between neighbouring tools.

### [major] E03: Distance + angle chamfer with an angle larger than the corner angle produces wrong geometry

- Evidence: reproduced by probe agent
- Repro: a (0,0)-(100,0), b (100,0)-(100,50). chamferCornersAngle(ctx,[a,b],10,135), then commit. The same occurs at 120, 150 and 170 degrees.
- Expected: Refused, because the chamfer ray never meets the second line on the corner side, or a valid chamfer.
- Actual: OK. Line b is extended through the old corner to (100,-10) and the chamfer runs (90,0)->(100,-10), so there is a tail outside the shape. The planner never checks that pointB lies on the corner side of the second line (edit-tools.ts:534-539).
- Where: edit-tools.ts chamferCornersAngle
- Impact on an engineer: Silently wrong profile geometry that extrudes into a bad solid.

### [major] E04: Fillet and corner pick the surviving side by length, not by pick, and silently delete half of a crossing line

- Evidence: reproduced by probe agent
- Repro: a (-50,0)-(50,0), b (0,-50)-(0,50): filletCorners R5 gives a=(-50..-5), b=(-50..-5) and adds the arc. The +x and +y halves of both lines are deleted. cornerLines on a (0,0)-(100,0) crossed by a vertical line at x=30 gives a=(30..100), so the 0..30 part is deleted.
- Expected: The quadrant is chosen by where the user picked, and the other halves are kept (Fusion) or the user is warned.
- Actual: cornerGeometry takes the end farthest from the intersection (ties go to start), moveNearEnd takes the nearer end. There is no pick input and no warning.
- Where: edit-tools.ts cornerGeometry, moveNearEnd, replaceNearEnd
- Impact on an engineer: Data loss on crossing lines, and no way to choose which corner is rounded.

### [major] E05: Offset of a mixed line + arc profile does not join the pieces, and the side depends on the line drawing direction

- Evidence: reproduced by probe agent
- Repro: Slot: t (0,10)-(50,10), arc ar (50,10),(60,0),(50,-10), b drawn left-to-right (0,-10)-(50,-10), arc al. offsetEntities(+3) returns lines at y=13 and y=-7 (inward) while both arcs grow outward to radius 13.
- Expected: A consistent outward +3 offset with the lines and arcs joined, as in Fusion.
- Actual: Lines offset to the left of their own direction, arcs always scale about their centre, and line chains are only mitred among lines. The result is a mis-sided, disconnected loop. The panel text mentions only line chains.
- Where: edit-tools.ts offsetEntities: arcs and lines are handled independently; buildLineChains considers lines only
- Impact on an engineer: A rounded rectangle or slot profile cannot be offset reliably (used for walls, clearances and gaskets).

### [major] E06: Offset does not detect self-overlap when features are narrower than 2d

- Evidence: reproduced by probe agent
- Repro: Dumbbell polygon: blocks 0..40 and 60..100, neck 10 wide. offsetEntities(all 12 lines, -6) returns OK with 4 self-intersections (the neck lines cross). The same at -8. A 4.9 offset is fine.
- Expected: Reject the offset or trim the overlap. The offset distance exceeds half the neck width.
- Actual: The only collapse test is a per-segment direction flip (edit-tools.ts:209), so crossed but unflipped edges pass. Parallel neck edges swap sides and the loop self-intersects.
- Where: edit-tools.ts offsetChain
- Impact on an engineer: A self-intersecting loop is committed silently. Profile detection later fails or gives wrong faces.

### [major] E07: Edit results carry no relations: fillet, chamfer, corner, offset, mirror (except line/circle), pattern, copy

- Evidence: reproduced by probe agent
- Repro: Fillet two lines: constraints=0 (no tangent, no radius dim, no coincident). Fillet a rectangle that has a width dimension: it becomes 8 entities, the dimension is dropped ('Removed 1 constraint') and the result has 0 relations. Mirror an arc or rectangle: no symmetry. Mirror or pattern lines that have coincident, H and a length dim: copies get none of them. Corner adds no coincident joint.
- Expected: Fillet gets tangent and radius relations, mirror gets symmetry for all kinds, and copies keep their internal relations. Clipboard paste already does this via cloneWithRelations.
- Actual: The copies are free geometry. Dragging a vertex breaks tangency, and the fillet radius cannot be edited as a dimension.
- Where: edit-tools.ts roundRectangle, filletCorners, mirrorEntities (symmetry only for line and circle), patternEntities, transformEntities(copy)
- Impact on an engineer: The sketch is not parametric after any modify tool, so design changes need redraw.

### [major] E08: Scale, stretch and offset of a rectangle leave its width/height dimension stale; scale/rotate of dimensioned lines is refused

- Evidence: reproduced by probe agent
- Repro: A rectangle with the real width dim (distance, dimension:width, 100). Scale x2 gives OK, width=200, constraint still 100, and a full solve reports nothing moved. A dimensioned line pair with distance length 100: scale x2 gives CONSTRAINT_CONFLICT. Rotating lines that have a Horizontal relation also gives CONSTRAINT_CONFLICT.
- Expected: Scale rewrites the dimension values (or asks), and rotate drops or keeps the relations explicitly.
- Actual: For a rectangle the driving dimension no longer matches the geometry, and no check flags it. For lines the whole edit is refused until the user relaxes the relations by hand.
- Where: edit-tools.ts transformEntities and stretchEntities; solver does not enforce rectangle dimensions in a full solve
- Impact on an engineer: A displayed driving dimension can be wrong. Scaling a dimensioned sketch is impossible without manual cleanup.

### [major] E09: NaN or Infinity centre in Rotate, Scale or Circular Pattern is accepted by the planner and then throws in apply

- Evidence: reproduced by probe agent
- Repro: transformEntities(rotate, centre [NaN,0]) and patternEntities(circular, centre [NaN,0]) both return ok:true with null coordinates. commit throws TypeError 'Canonical JSON rejects non-finite numbers.' Scale and Infinity behave the same way. In the panel, Number('abc') gives NaN for the Centre X/Y fields.
- Expected: A rejection message, as for the other fields.
- Actual: The throw is not caught: App.tsx applyProjectOperation (line 507-525) has no try/catch, so the click does nothing and the status bar is not updated.
- Where: edit-tools.ts transformEntities and patternEntities (centre not validated); SketchEditPanel.tsx:167-174; App.tsx:510
- Impact on an engineer: A typo in a centre field makes the Apply button appear dead.

### [major] E10: parseClipboard rejects any clipboard that contains angle, arc-length, perimeter, smooth, pierce or refraction relations

- Evidence: reproduced by probe agent
- Repro: copySketchSelection of two lines with an Angle dimension, serializeClipboard, parseClipboard gives FAIL 'The clipboard has a relation that is not valid.' Same for smooth and arc-length.
- Expected: The clipboard round-trips all relation kinds, including valueDeg and ratio.
- Actual: CONSTRAINT_KINDS (sketch-clipboard.ts:110) lists 14 of the 20 kinds. The panel then shows 'The sketch clipboard is empty', which is misleading. Only the in-session store path works. Also accepted at parse: coordinates up to 1e6 (project limit 1e4) and unknown extra fields on entities.
- Where: sketch-clipboard.ts:110, validConstraint, validEntity; SketchWorkspace.tsx:526-531
- Impact on an engineer: Cross-window or after-reload paste fails for any sketch with an angle dimension.

### [minor] E11: Plans that the validator will reject are not pre-checked, so the user sees 'A sketch entity is invalid or has a duplicate ID'

- Evidence: reproduced by probe agent
- Repro: trimAt leaving a 0.005 mm piece; fillet R10 on a 10.0001 leg (0.0001 left); fillet R0.01; scale 0.01 of a 0.5 mm line; pattern spacing 1e9; move 99999; offset of an 18000 mm square by +2000 (beyond 10000); stretch moving an arc start onto its mid; mirror about a zero-length axis (plan contains NaN). Each plan is ok:true and each commit fails INVALID_PROJECT.
- Expected: A message naming the limit (minimum 0.01 mm, maximum 10000 mm).
- Actual: The generic error names neither the entity nor the cause.
- Where: edit-tools.ts (all planners); validation limits minGeometryMm 0.01 and maxCoordinateMm 10000
- Impact on an engineer: Confusing failures at the extremes of size.

### [minor] E12: Pattern and circular copy counts can exceed the entity limit, with a vague failure

- Evidence: reproduced by probe agent
- Repro: 40 circles with a rectangular pattern 100x1 (3960 copies): plan ok, commit gives 'The sketch edit payload is invalid.' The per-instance MAX_COPIES=100 is checked, but not total entities against maxEntities=500.
- Expected: 'Would create N entities; the limit is 500.'
- Actual: A generic payload error. Circular pattern around the entity's own centre also stacks exact duplicates without warning.
- Where: edit-tools.ts patternEntities
- Impact on an engineer: Pattern fails without explanation on larger sketches.

### [minor] E13: Offset of a branching line network offsets each line to its own left, with no warning

- Evidence: reproduced by probe agent
- Repro: A square plus one diagonal (5 lines), offset +10: the square lines go inward, the diagonal goes up-left, with no error.
- Expected: Reject or warn that the selection branches. A closed square alone offsets outward.
- Actual: The same selection gives different sides depending on whether a diagonal is added (edit-tools.ts:147-150).
- Where: edit-tools.ts buildLineChains non-simple branch
- Impact on an engineer: Inconsistent, hard-to-predict sides for T and cross junctions.

### [minor] E14: Trim loses relations on new pieces; trimming a circle drops its radius; trim and extend ignore ellipses as boundaries

- Evidence: reproduced by probe agent
- Repro: Horizontal line trimmed in the middle: the new right-hand piece has no Horizontal relation (constraints list only the one on the left piece). Circle with a radius dimension trimmed to an arc: 'Removed 1 constraint', and the arc has no radius dimension. extendAt toward an ellipse gives 'Nothing lies beyond that end'.
- Expected: Relations migrate as in split (split-jog.ts), and the ellipse is a trim/extend boundary.
- Actual: trimAt has no relation migration; curvesOf() returns [] for ellipse.
- Where: edit-tools.ts trimAt, curvesOf
- Impact on an engineer: A trimmed profile loses its constraints. A boundary ellipse is invisible to Trim and Extend.

### [minor] E15: Fillet and chamfer ignore construction and visible flags of the source lines

- Evidence: reproduced by probe agent
- Repro: Two construction lines a, b filleted: the new arc has construction:false. Chamfering construction lines gives a real chamfer line. Hidden (visible:false) lines give an arc with visible undefined.
- Expected: The new curve inherits construction (and visible) from its parents.
- Actual: edit-tools.ts hard-codes construction:false in filletCorners and chamfer*. Only rectangles and split inherit it.
- Where: edit-tools.ts filletCorners, chamferCorners, chamferCornersAsymmetric, chamferCornersAngle
- Impact on an engineer: A real profile curve appears inside a construction layout and can create an unexpected extrude profile.

### [minor] E16: selectionBounds is wrong for arcs and ellipses, so the Stretch window seeded from it misses extremes

- Evidence: reproduced by probe agent
- Repro: A 270 degree arc (10,0),(-7.07,7.07),(0,-10) gives bounds x -7.07..10, y -10..7.07 (true -10..10 in both). An ellipse 30x10 gives -30..30 in y (true +-10).
- Expected: The true extent of each curve.
- Actual: Arcs use only start, mid and end. Ellipses use the major radius in both directions and ignore rotation.
- Where: edit-tools.ts selectionBounds
- Impact on an engineer: 'Use selection bounds' under-selects arc extremes, so Stretch leaves part of the arc behind.

### [minor] E17: Spline split changes the curve shape by about 0.75 mm on a 30 mm spline

- Evidence: reproduced by probe agent
- Repro: spline (0,0),(10,10),(20,0),(30,10) split at (15,5): the sampled halves deviate by up to 0.75 mm from the original curve. Splitting a 3-point spline yields a half with a new fit point and a different curvature.
- Expected: The halves reproduce the original curve, or the dialog states the deviation.
- Actual: Each half is a fresh Catmull-Rom fit. The documented 'close, not exact' hides a deviation of about 2.5 percent.
- Where: split-jog.ts splitSpline
- Impact on an engineer: A split changes the curve outline slightly.

### [minor] E18: Pasted or mirrored sets are silently demoted to unconstrained when the solver reads a Parallel pair as same-direction

- Evidence: reproduced by probe agent
- Repro: Parallel relation between lines a (0,0)-(100,0) and c (100,50)-(0,50): a full solve says 'solve would move entity:c'. Pasting this pair gives 'Pasted 2 curves (relations not carried over)'.
- Expected: Parallel holds for any direction, since a mirrored polygon reverses line directions.
- Actual: The edit tools then drop all copied relations quietly (label only). Mirror/dynamic-mirror hit the same solver quirk.
- Where: sketch-clipboard.ts pasteSketchClipboard fallback; solver parallel semantics (sketch-solve.ts)
- Impact on an engineer: Relations vanish on paste for common profiles. The fallback is only reported in the status line.

### Missing capability

- (major) **Fillet of line-arc and arc-arc corners, multi-corner polyline fillet, fillet by clicking a vertex**: Rounding any profile containing arcs, or all corners of a polyline in one go, is routine; only two lines or one rectangle are accepted ('Select exactly two lines'). (compared with Fusion Sketch Fillet, SolidWorks Sketch Fillet)
- (major) **Offset of splines and ellipses; mixed line+arc chain joined with corner type; automatic selection of the connected or tangent chain; both-sides, offset dimension relation**: Offset of a real profile is needed for walls, gaskets and clearances. connectedSelection exists in offset-move.ts but no UI code calls it (grep), so each segment must be picked by hand. (compared with Fusion Offset (chain select, live preview), SolidWorks Offset Entities)
- (major) **Tangent, equal and radius relations created by Fillet, and driving relations for Pattern/Mirror results (associative pattern)**: Parametric sketches need the fillet radius and pattern spacing to stay editable. (compared with Fusion fillet/circular pattern, SolidWorks linear pattern)
- (major) **Trim of rectangle, ellipse and spline entities; Extend of arcs and splines**: A rectangle drawn with the Rectangle tool cannot be trimmed (message says to fillet it first). Arc end extension is common when closing profiles. (compared with Fusion Trim/Extend (rectangles are lines), SolidWorks Trim)
- (major) **Pick-driven quadrant choice for Corner, Fillet and Chamfer on crossing lines; automatic Relax-and-apply when relations block an edit**: Avoids data loss in E04 and the manual Relax Relations step in E01. (compared with AutoCAD Fillet pick behaviour, Fusion constraint handling during trim)
- (minor) **Linear pattern along an angled direction, a picked line or a path; pattern spacing mode 'total extent'**: patternEntities applies dx per column and dy per row only (axis-aligned grid), so a single-direction angled pattern cannot be produced. (compared with Fusion Rectangular Pattern, Onshape Linear Pattern)
- (minor) **Mirror about the sketch origin X or Y axis without drawing a helper line**: mirrorEntities requires a line entity as the last selection; the origin axes are not entities. (compared with Fusion Mirror (select axis from origin), SolidWorks Mirror (centerline or origin))
- (minor) **Non-uniform scale, scale about the selected reference, multiple rotated/moved copies in one command, scale that updates dimension values**: Rotate and Move copy only make one copy; Scale is uniform with a typed centre. (compared with Fusion Scale/Move-Copy, SolidWorks Scale/Move Entities)
- (nice) **Break/Intersect (split all curves at every crossing in one step) and drag-sweep trim**: Cleaning a sketch of many crossing curves needs one click per segment today. (compared with Fusion Trim sweep, SolidWorks Power Trim)

### Verified working

- Fillet line-line: tangent points and radius exact (arc R within 1e-12, |cos(line,radius)| 2.5e-14), also on a rotated rectangle; three successive triangle fillets give 1 detected profile
- Rectangle fillet and chamfer produce 8 connected entities with 0 unmatched ends and 1 profile; half-side limit enforced
- Chamfer equal, two-distance, and distance+angle for angles up to the corner angle (30 degree case exact); swapped line order handled
- Offset of closed line loops goes outward for +d regardless of line drawing direction (mixed directions tested); circles, arcs, rectangles exact; +d then -d returns the original; 20 repeated offsets show no drift
- Offset collapse (square -60, -50) and per-segment flips are refused; sharp-corner mitre limit refuses a 10x blow-up
- Mirror is exact (corner and ellipse/rectangle rotation mapping, 45 degree axis tested) for line, circle, arc, rectangle, ellipse, spline, point; commit passes validate
- Rectangular and circular pattern positions exact, 360 spreads evenly, partial angle reaches the last instance, count and spacing limits enforced
- Rotate 360 x 1 degree shows about 1e-12 drift; scale x1.7 / 1.7 over 100 operations shows about 1e-15 drift
- Split line, arc (CW and CCW), circle (radius dim duplicated onto both arcs), rectangle (5 lines) with relation migration; integrity check clean afterwards
- Jog bump and single step, on a diagonal line and inside a chain, with end relations carried; integrity clean
- Delete Curve heal line-line, line-arc and un-filleting a rectangle corner; refuses parallel neighbours with a reason
- Clipboard copy, cut and paste keep 8 internal relations incl. dimensions, drop fixed, produce fresh ids; limits and fallbacks work
- Dynamic Mirror creates mirror images with symmetry relations, skips on-axis entities, leaves plan unchanged if the axis is missing
- Make Path orders shuffled selections, reports gaps, branches and unlinked curves; healPathGaps and pathToSpline work, 24-point limit is reported
- Sketch repair finds and fixes gap, duplicate, degenerate, conflict, redundant, orphan and open-chain cases; repairAll is idempotent; analyze on 300 lines takes about 32 ms
- Offset Move works on a fully constrained square with coincident relations; JSON round trip and determinism of edits verified; no NaN or dangling constraint ids from valid inputs; ids unique

Not checked in this area: "Anything in a browser (UI event handling, hit-testing, previews, undo/redo stack, drag behaviour); the constraint solver internals beyond what the edit operations expose; spline offset/ellipse behaviour in other modules; performance of the solve with 500 entities plus constraints; how the Rectangle tool vs Line tool joins interact in the live UI. E09 and the E01 'no relax step' behaviour are confirmed at API level and by reading App.tsx and SketchEditPanel.tsx."

## C. Sketch-to-solid pipeline, persistence, units, import/export and operat

I ran about 35 probe scripts against the compiled modules. The basic pipeline is solid. Extrude and cut work on all 12 plane kinds with correct sizes, committed-sketch edits and parameter changes rebuild the solids, and every entity and constraint kind survives a JSON round trip. Several normal tasks still fail or silently give wrong geometry. Any saved project over 1 MB cannot be reopened, and a project is frozen after 500 operations. Revolving a profile on the negative-X side gives an inside-out solid, and revolve always uses the sketch Y axis, ignoring a centerline. Sweeping a tube (two concentric circles) gives a solid bar. Editing a sketch can break its solid, and a new circle in the sketch later puts a hole in an existing extrude. Region detection never splits at intersections. There is no sketch DXF or SVG import or export, and no point-to-point dimension.

### [blocker] P01: A saved project over 1 MB cannot be reopened (Save allows 50 MB, Open allows 1 MB)

- Evidence: reproduced by probe agent
- Repro: probe t6/t7/t8. Circle r5 at (20,0), revolve 360, add-design-solid (9216 triangles). Serialise exactly as App does: JSON.stringify(project,null,2). Then call core.parseWorkbenchProjectText(text).
- Expected: A file the app wrote reopens. Realistic parts (a few bodies with holes) fit.
- Actual: The torus body alone is 1.76 MB compact / 3.1 MB pretty and parse returns RESOURCE_LIMIT 'The project exceeds the 1 MB preview limit'. A 100x60 plate with 4 holes is 327 KB pretty; a 200x100 plate with 12 holes is 969 KB, so a second such body breaks reopening. ps3d_* MCP calls reject the project above 1 MB too.
- Where: validation.ts:49,185 (maxJsonBytes 1,000,000 in parseWorkbenchProjectText); file-workspace.ts:11 MAX_PROJECT_BYTES 50 MB; App.tsx:2764 and 2831; mcp index.ts:290
- Impact on an engineer: The file saves without complaint, then the design is lost on reopen. Every tessellated body is stored inside the project JSON.

### [blocker] P02: Project is frozen after 500 operations and nothing can compact it

- Evidence: reproduced by me
- Repro: probe t11. New project, new-design-sketch, then add-sketch-entity in a loop.
- Expected: Long sessions work, or the app compacts the audit.
- Actual: The 500th operation fails with RESOURCE_LIMIT 'The preview audit reached its 500-entry limit. Export the project and start a compacted revision lineage.' Every UI action (each line, dimension, drag release, constraint, feature) is one audit entry and the cap is stored in the file. No compaction function or UI exists anywhere (grepped packages and apps); the only warning is a health finding at 450.
- Where: operations.ts:112; validation.ts:55,990; workbench-health index.ts:134; App.tsx:507 applyProjectOperation
- Impact on an engineer: A normal design day exhausts it. After that every sketch edit is refused and the saved file stays at the cap.

### [blocker] P03: Revolve of a profile on the negative-X side makes an inside-out solid

- Evidence: reproduced by probe agent
- Repro: probe t3/t4/t31. Sketch rect center (-10,10) 10x20 on datum:xy, rebuildSolidFeature kind revolve valueMm 360. Also tested: lines, circle (torus), thin wall, 180 degrees, XZ plane, and a rect touching the axis from the left.
- Expected: Positive volume 12546 mm3, same as the mirrored profile at +X.
- Actual: Mesh volume is -12546 (the torus gives -9841 and the left-touching rect -6273). combineGeneralBodies then refuses the solid as a cut or join tool: 'The tool has no positive volume (its faces may point inward)'. The solid is still added to the timeline with no warning.
- Where: general-modeling.ts ~395-430 (only strictly positive-X uses the kernel); workbench-geometry tessellate.ts tessellateRevolve
- Impact on an engineer: Drawing the profile left of the axis is routine. The result is invisible or inverted, fails Booleans and gives negative mass.

### [blocker] P04: Revolve always uses the sketch Y axis; a drawn centerline or construction line is ignored

- Evidence: reproduced by probe agent
- Repro: probe t3. datum:xy: rect center (40,10) 10x20 (x 35..45) plus construction line (30,-10)-(30,40). Revolve 360.
- Expected: Revolve about the centerline at x=30, volume about 4712 mm3 (ring r5..15).
- Actual: Revolved about x=0: bbox 90x20x90, volume 50185 mm3, with no message. No axis option exists. A profile crossing Y is refused with 'crosses the revolve axis (the sketch Y axis)'.
- Where: general-modeling.ts:395 and revolveAxisRelation in tessellate.ts:40; no axisEntityId in types.ts (grepped)
- Impact on an engineer: Pulleys, shafts and anything with a drawn axis come out wrong and silently, or the profile must be redrawn at the origin.

### [blocker] P05: Sweep and loft drop holes: a tube (two concentric circles) becomes a solid bar

- Evidence: reproduced by probe agent
- Repro: probe t14. Sketch circles r10 and r8, feature kind sweep (also loft) profileIds [outer, inner], sweepDirectionMm [0,0,1], valueMm 50.
- Expected: Hollow tube, volume about 5648 mm3 (extrude of the same selection gives 5648).
- Actual: Volume 15688 (full disc) for sweep and loft. rebuildSolidFeature resolves hole profiles, then createGeneralSolidBody sweep/loft branches never read request.holes. No error.
- Where: design-regeneration.ts:50-56 (holes resolved); general-modeling.ts:315-348 (holes ignored; only extrude and revolve check them)
- Impact on an engineer: Pipes and tubes are the commonest sweep. The geometry is wrong with no warning.

### [major] P06: Editing a sketch can break its solid because profile IDs are a hash of member entity IDs

- Evidence: reproduced by probe agent
- Repro: probe t9 case C. Four-line loop, extrude, reopen the sketch, add a chamfer line and shorten two sides, commit, rebuildDependents. Case B: replace a rectangle with 4 lines.
- Expected: The only profile is still the extruded one and the solid follows.
- Actual: Profile id changes (profile:loop-9fdbaa8f to profile:loop-0ba1ea6e). Result: 'Rebuilt 0 features; 1 could not be rebuilt' and the feature health reads 'A profile this feature was built on no longer exists'. The stale solid stays in the part with its old shape.
- Where: workbench-sketch index.ts:991 (id = fnv1a of entity ids); design-regeneration.ts:50
- Impact on an engineer: Adding a chamfer or fillet, trimming, or splitting a side after extruding is common. It orphans the feature and the user must re-create it.

### [major] P07: An extrude silently gains a hole when a circle is added inside its profile later

- Evidence: reproduced by probe agent
- Repro: probe t25. Rect 60x60 extruded 10 (volume 36000). Reopen the sketch, add a circle r10 inside (meant for a later boss), commit, rebuild.
- Expected: The existing extrude is unchanged.
- Actual: Volume becomes 32862: islands are re-detected on every rebuild (includeIslands for extrude) although profileIds still lists only the outer profile.
- Where: design-regeneration.ts:51 resolveProfileRegion includeIslands: kind==='extrude'
- Impact on an engineer: Drawing geometry for a second feature in the same sketch changes the first feature.

### [major] P08: Profile detection never splits regions at intersections or T-junctions

- Evidence: reproduced by me
- Repro: probe t26. (a) Two overlapping circles r10 offset 8. (b) Rect plus a line crossing it. (c) A square from lines with a divider line whose ends are on the sides.
- Expected: Fusion/SolidWorks give 3 regions (lens plus two crescents), two halves, and so on.
- Actual: (a) only the two full circles; (b) only the outer rect, the line is ignored; (c) 0 profiles (every endpoint must have exactly 2 edges). Trim or Split must be done by hand first. Not listed as a known limit in the audit doc.
- Where: workbench-sketch index.ts:936-1000 detectCurveLoops, 442-476
- Impact on an engineer: Extruding a region of overlapping shapes, or half of a divided area, is impossible without manual cleanup.

### [major] P09: One extrude cannot take several disjoint profiles, and a nested island is dropped

- Evidence: reproduced by probe agent
- Repro: probe t27. (a) Four separate circles r5 in one sketch, extrude profileIds all four. (b) Concentric circles r30, r20, r10, select the outer only.
- Expected: (a) four cylinders in one feature. (b) a ring plus a core, volume about 18850 mm3.
- Actual: (a) 'Every extra selected profile must lie inside the largest selected profile; it becomes a hole.' (b) volume 15688: the core r10 is silently omitted.
- Where: workbench-sketch index.ts resolveProfileRegion (~528-552)
- Impact on an engineer: A bolt pattern or several bosses needs one feature each; a core inside a groove is lost without a message.

### [major] P10: Path sweep is a sheared prism, not a sweep along a path; path and loft profiles must be in the same sketch

- Evidence: reproduced by probe agent
- Repro: probe t14. rect 10x10 at origin plus line (20,0)-(60,0) in the same XY sketch, kind sweep, sweepPathEntityId = line, valueMm 40.
- Expected: Profile swept along the path, or the path rejected as being in the profile plane.
- Actual: A prism z 0..40 sheared 40 mm in X (bbox x -5..45): the in-plane path is read as lateral offset while Z rises linearly over valueMm. A path is one entity from the same sketch (no chain, no other plane). Loft secondary profile and rail also come only from the same sketch.
- Where: tessellate.ts:189-245 tessellateSweepPath; design-regeneration.ts:84-120
- Impact on an engineer: Pipe runs, rails and lofts between sketches on different planes cannot be built. The docs call this 'Shipped'.

### [major] P11: A sketch on a face is a fixed number, so features built on it go stale silently

- Evidence: reproduced by probe agent
- Repro: probe t15. Base extrude 10, boss sketch at offset 10 (top face), join extrude 15. Edit the base to 25, replay.
- Expected: The boss sketch follows the top face (z=25).
- Actual: Plane offset stays 10, the boss is buried (final bbox height 25, expected 40), and the replay returns no message. Only axis-aligned planar faces can be sketched on at all.
- Where: planar-faces.ts (offsetMm only); types.ts WorkbenchSketch has no face reference
- Impact on an engineer: Any dimension change upstream leaves floating or buried features, with no warning.

### [major] P12: One sketch edit is capped near 100 jointed segments; the errors are misleading

- Evidence: reproduced by probe agent
- Repro: probe t11/t28b. apply-sketch-edit with N lines plus N-1 coincident joints. Also 201 lines, and one edit updating 200 lines.
- Expected: Up to the 500-entity limit, or a message naming the per-edit limit.
- Actual: 101 lines plus 100 joints is ok (201 ids). 120 lines plus 119 joints fails with 'An audit entry is invalid or out of sequence.' (audit changedIds limit is 201). 201 lines fails with 'The sketch edit payload is invalid.' (limit 200). A paste, pattern or transform above these fails the same way. 300-segment polylines need several edits.
- Where: operations.ts:213-218 (200/400 caps); validation.ts:997 (changedIds <= maxMates+1)
- Impact on an engineer: Arrays, large pastes and imported outlines fail, and the message points at a problem the engineer cannot understand.

### [major] P13: All invalid entities give one message that blames the project and hides the cause

- Evidence: reproduced by probe agent
- Repro: probe t19. add-sketch-entity with: zero-length line, 0.005 mm line or circle, coordinate 10001, circle r 10001, rect width 20001, rotation 400, collinear arc, 2-point spline, 25-point spline, uppercase id, minor>major ellipse, unknown kind, extra field.
- Expected: A message saying which field and limit failed.
- Actual: Every case returns INVALID_PROJECT 'A sketch entity is invalid or has a duplicate ID.' with recovery 'Use a bounded PS3D workbench project created by this version.' No entity id and no limit are named. apply-sketch-edit rejects the whole batch the same way.
- Where: validation.ts:237-239, 251-289 validateEntity
- Impact on an engineer: Hitting the 0.01 mm minimum, the 10 m coordinate limit or the 24-fit-point spline cap is undiagnosable from the UI or MCP.

### [major] P14: applyWorkbenchOperation throws on NaN or Infinity in an entity payload

- Evidence: reproduced by probe agent
- Repro: probe t19b. add-sketch-entity point [NaN,0] (also Infinity; apply-sketch-edit with radiusMm NaN).
- Expected: A diagnostic result like set-sketch-dimension gives.
- Actual: Uncaught TypeError 'Canonical JSON rejects non-finite numbers' from boundedIntentKey. Operation-level validation only checks entities with isRecord. applyProjectOperation has no try/catch.
- Where: operations.ts:104,553-609 canonicalizeJson; operations.ts:191 case add-sketch-entity; App.tsx:507-525
- Impact on an engineer: Any geometry maths that yields NaN (zero-length normalisation, 0/0 in a transform) crashes the handler instead of showing an error.

### [major] P15: Reopening a sketch from the timeline discards the uncommitted working sketch

- Evidence: reproduced by probe agent
- Repro: probe t20. Draw a new sketch (3 entities, not finished), then edit-design-sketch on an older sketch. Also: edit sketch A's width to 99 without committing, then edit sketch B.
- Expected: Pending work is committed or the user is asked first.
- Actual: project.sketch is overwritten with the old snapshot; the 3 new entities and the edit to 99 are gone (only Undo recovers). The new-sketch and new-plane paths in App call commitWorkingSketch first, but editTimelineFeature (App.tsx:2707) and switchWorkspace do not.
- Where: design.ts:198 editDesignSketch; App.tsx:2707-2709; workspace switch App.tsx:828
- Impact on an engineer: Silent loss of sketch work after leaving the Sketch workspace without pressing Finish.

### [major] P16: Inch entry is inconsistent: '1/2 in' fails in dimensions, and the sketch is mm-only

- Evidence: reproduced by probe agent
- Repro: probe t30/t30b. set-sketch-dimension width with expression: '1/2 in', '(1/2) in', '1/16 in', '1 in * 1 in', '3 ft', '1.5"', '25,4 mm', '10 mil'.
- Expected: Fractional inches accepted, as in the on-view numeric field.
- Actual: '1/2 in' gives 'A dimension needs a length, but this expression gives a value in mm^-1' (parsed as 1/(2 in)); '(1/2) in' gives 'Unexpected "in"'. 0.5 in and 1 in work. ft, ", mil and comma decimals are rejected here but accepted by the on-view field. The inspector DimensionField uses Number(text), so units are not accepted there at all. Canvas dimension text is hard-coded ' mm' and the ribbon Inch unit does not change the sketch. Project unit must be 'mm'.
- Where: expressions.ts unit handling (~247); SketchWorkspace.tsx:1894-1897 and 1959; validation.ts:79
- Impact on an engineer: Inch shops cannot type fractions, and every dimension reads in mm.

### [major] P17: Meaningless constraints are accepted and stored (core op does not use constraintFit)

- Evidence: reproduced by probe agent
- Repro: probe t13/t16. add-sketch-constraint: horizontal on a circle; parallel line+circle; radius value 5 on a line; distance 100 on two circles; parallel of one line with itself; equal circle+arc; concentric line+line; pierce with axisId 'axis:z' that does not exist.
- Expected: Rejected, as constraintFit already decides for the UI.
- Actual: All are ACCEPTED and kept. Some say 'Recorded, not solved' in the summary; 'radius 5 on a line' and 'distance 100 on two circles' give no note and do not move geometry. They remain as dead relations, and the pierce reference dangles.
- Where: operations.ts:590-601 (no fit check); constraint-fit.ts exists but is not used by the op
- Impact on an engineer: The MCP/agent route and any programmatic caller can fill a sketch with dead dimensions that look driving.

### [major] P18: Angle, arc-length and perimeter dimensions cannot be bound to parameters; ellipse axes cannot be dimensioned

- Evidence: reproduced by probe agent
- Repro: probe t12/t24. set-sketch-dimension with expression 'ang' for dimension angle; arc-length with expression; dimension radius/width/length on an ellipse; arc-length on a spline.
- Expected: Angle can be parametric. Ellipse major/minor can be driven.
- Actual: Angle and arc-length with an expression return 'The sketch dimension edit is invalid.' with no reason. Ellipse: 'A radius dimension applies to one circle or arc.' / 'A distance dimension applies to one line or rectangle.' Plain width/radius bindings work.
- Where: operations.ts:197-205; constraint-fit.ts:69-84; SketchWorkspace.tsx:1889 (ellipse shown read-only)
- Impact on an engineer: Angle-driven designs cannot change from the parameter table. An ellipse cannot be fully defined.

### [minor] P19: Duplicate timeline names, and a confusing rename error

- Evidence: reproduced by probe agent
- Repro: probe t10. Create Sketch 1,2,3, delete Sketch 2, commit with the app's name (count+1 = 'Sketch 3'). Rename a feature to '  '.
- Expected: Unique default name; clear error on a blank name.
- Actual: Timeline lists 'Sketch 3' twice (App.tsx:2394 uses count+1); duplicate names are allowed at all levels. Whitespace-only rename gives 'The design timeline is invalid: a feature, a sketch snapshot, a reference or the rollback marker is wrong.'
- Where: App.tsx:2394; design.ts renameDesignFeature; operations.ts rename validation
- Impact on an engineer: Two identically named sketches and a misleading error.

### [minor] P20: Coordinate and size limits disagree across layers, with only the generic message

- Evidence: reproduced by probe agent
- Repro: probe t5/t18/t18b. Rect 100000 wide; extrude 20000; extrude valueMm 0.005; plane offset 99990 then extrude 100000.
- Expected: One set of limits with named messages.
- Actual: Sketch coordinates and sizes: 10,000 / rect 20,000 / dimension max 10,000. Body coordinates in add-design-solid: 10,000 (project validator allows 1,000,000); feature valueMm up to 100,000; plane offset up to 100,000. So a valid 20 m extrude or high-offset sketch gives 'The solid feature or its body is invalid.' Extrude 0.005 mm is accepted although the sketch minimum is 0.01 mm.
- Where: operations.ts:1560 vs validation.ts:426; design.ts:416; validation.ts:230,261
- Impact on an engineer: Large parts (vehicles, structures, over 10 m) hit an undocumented wall.

### [minor] P21: Fixed tessellation: 72 facets per circle at any size; splines use uniform Catmull-Rom with 8 samples per span

- Evidence: reproduced by probe agent
- Repro: probe t22/t29. Extrude circles r 0.5 to 5000. sampleSpline on fit points [[0,0],[2,1],[4,0],[60,0],[62,1],[64,0]] and a 3-point 2000 mm spline.
- Expected: Facet count follows size; spline passes smoothly through uneven points.
- Actual: Every circle or ellipse is 284 triangles and volume is -0.127 % (chord sag 0.095 mm at r100, 0.95 mm at r1000). Unevenly spaced fit points overshoot (y down to -3.66 mm for points between 0 and 50) and loop (10 backwards-x steps). A 1000 mm span is only 8 chords.
- Where: workbench-sketch index.ts profileOutlineMm (72) and sampleSpline; occt-kernel-adapter reference-runtime
- Impact on an engineer: STL and mass of large round parts are faceted, and splines can bulge outside their fit points.

### [minor] P22: YZ plane is a Y-up convention in a Z-up world; revolve on YZ turns about world Y

- Evidence: reproduced by probe agent
- Repro: probe t2/t3. Sketch rect on datum:yz and revolve 360.
- Expected: On a Z-up Right plane, sketch vertical = world Z (Fusion/Onshape).
- Actual: Sketch X maps to world -Z and sketch Y to world +Y (HUD '−Z →, Y ↑'). The revolve solid is bbox [-15,0,-15]-[15,20,15], axis along world Y. The XZ plane is fine. Documented in a code comment only.
- Where: SketchWorkspace.tsx:114-118; sketch-project.ts:34-38; general-modeling.ts rotateLocalToPlane
- Impact on an engineer: A profile drawn upright on the Right plane turns out sideways in the model, and revolve axes come out unexpectedly.

### [minor] P23: Every sketch operation revalidates and persists the whole project including meshes

- Evidence: reproduced by probe agent
- Repro: probe t21. Add 20 plate bodies of 3500 triangles each, then time a trivial toggle-sketch-construction op.
- Expected: Sketch edits stay fast on a large model.
- Actual: Project 8.7 MB JSON: trivial sketch op takes 153 ms (33 ms at 1.8 MB). applyWorkbenchOperation validates twice, and pushProject structuredClones the full project to IndexedDB on every op.
- Where: operations.ts:93-137; App.tsx:445-478; workbench-store.ts:8
- Impact on an engineer: Drawing with a larger model open becomes sluggish.

### [minor] P24: Loops close only at exact 1e-6 mm; the snap tolerance is not used

- Evidence: reproduced by probe agent
- Repro: probe t32. Four-line square with one corner gap of 2e-10 mm straddling a 1e-6 rounding boundary, and gaps 2e-6, 1e-5, 1e-3.
- Expected: Visually closed corners (0.00001 mm) count as closed, or the gap is reported.
- Actual: All give 0 profiles (even the 2e-10 mm gap, because endpoints are keyed by Math.round(x*1e6)). Only Sketch Repair can fix it.
- Where: workbench-sketch index.ts:1008-1010 pointKey
- Impact on an engineer: A near-closed loop silently has no extrudable profile.

### [minor] P25: Finish Sketch plus rebuild is two undo steps

- Evidence: read from code, not run
- Repro: Code-read: commitWorkingSketch then rebuildFrom.
- Expected: One Ctrl+Z reverts the sketch edit and the rebuilt solids together.
- Actual: commit-design-sketch and regenerate-design are separate applyProjectOperation calls, each a pushProject history entry. After one undo the new sketch snapshot is back with the old solids missing, or the old sketch with the new solids.
- Where: App.tsx:2371-2400 (rebuildFrom, commitWorkingSketch); pushProject 464
- Impact on an engineer: Undo can leave the model in an inconsistent half state (the health flag may show).

### [minor] P26: A tangent constraint silently resizes the circle when the geometry is far apart

- Evidence: reproduced by probe agent
- Repro: probe t13. Add tangent line+circle(far) and tangent circle+circle.
- Expected: Move the free line or circle, or warn about a large change.
- Actual: Circle c1 changes from radius 5 to 30 mm; circle c2 from radius 3 to 23.284 mm. Only the operation summary mentions it.
- Where: sketch-solve.ts tangent handling
- Impact on an engineer: A hole or boss size changes without being dimensioned.

### Missing capability

- (blocker) **Choose the revolve axis (sketch line, centerline, model edge or axis)**: Revolved parts rarely have their axis on the sketch Y axis. Today the construction line is ignored and the profile must be moved to the origin. (compared with Fusion Revolve (Axis), SolidWorks Revolve (Axis of revolution), Onshape Revolve (Axis))
- (blocker) **A way to compact or archive the audit trail, and a streaming/binary storage format for meshes**: Needed to keep a project editable past 500 operations and over 1 MB; meshes are stored as plain JSON numbers. (compared with Fusion .f3d / SolidWorks .sldprt have no operation cap and store compact geometry)
- (major) **Sketch DXF/SVG export, and DXF/DWG/SVG/image import into a sketch**: Laser, waterjet and customer outlines, logos and traced drawings. Only sheet-metal flat patterns export DXF/SVG; DXF/DWG import is marked 'converter-required'; the importers produce meshes, not sketch curves. (compared with Fusion Insert DXF / Export sketch as DXF, SolidWorks DXF import/export, Onshape DXF import/export)
- (major) **Point-to-point, horizontal/vertical and line-to-point distance dimensions, plus diameter as the stored dimension**: Fully defined sketches need distances between points and from points to lines. The UI says 'Point-to-point dimension selected; edit it when it maps to a supported driving parameter' and the distance constraint only applies to one line or rectangle. (compared with Fusion Sketch Dimension, SolidWorks Smart Dimension, Onshape Dimension)
- (major) **Sweep along a path from another sketch or plane (chained path of several entities) and a loft between sketches on different planes with guide rails**: Real sweeps and lofts put the profile and path on different planes; the existing path sweep needs both in one sketch and takes a single entity. (compared with Fusion Sweep/Loft, SolidWorks Sweep/Loft, Onshape Sweep/Loft)
- (major) **Associative sketch plane on a face or construction plane (follows the face; also curved and tilted faces)**: Edits upstream move the face; sketches stored as a plane plus a numeric offset do not follow. (compared with Fusion sketch on face, SolidWorks sketch on face, Onshape sketch on face)
- (major) **Region selection from intersecting curves; several profiles or regions in one extrude/revolve**: Needed for extruding overlaps, crescents and pattern-like layouts in one feature. (compared with Fusion profile regions, SolidWorks contours, Onshape region selection)
- (major) **STEP/IGES (and other exact-CAD) export of solids**: Supplier hand-off. Only STL, OBJ, PLY, GLB/USD (meshes) can be exported; STEP is marked 'kernel-required' and there is no export. (compared with Fusion, SolidWorks and Onshape export STEP/IGES/Parasolid)
- (major) **Sketch-driving MCP tools: new-design-sketch (plane choice), apply-sketch-edit, commit, extrude/revolve from a sketch, set-design-parameters, timeline edits**: The MCP recipes cover only the single working sketch (line, rectangle, circle, arc; fewer constraint kinds listed than exist) and every call carries the whole project under 1 MB. An agent cannot make sketch-to-solid models. (compared with Fusion/Onshape APIs create sketches, planes and features)
- (minor) **Display unit (inch) for sketch dimensions, and project-level unit choice**: Sketch labels are fixed 'mm' and project.unit must be 'mm'; the ribbon unit button does not affect sketches. (compared with Fusion document units, SolidWorks document properties, Onshape units)
- (minor) **Control-point/NURBS splines with weights and more than 24 fit points**: Splines are capped at 24 fit points and stored as fit points; imported or class-A curves need more. (compared with Fusion Control Point Spline, SolidWorks Style Spline, Onshape Spline)
- (minor) **Text with the characters engravers need (Ø ° ± # % &, TrueType outlines)**: The built-in stroke font rejects these characters and only closed letters can be extruded. (compared with Fusion Text, SolidWorks Text, Onshape Text)
- (nice) **Sketch section properties (inertia, centroid of a selected region) and canvas/image underlay for tracing**: Profile area and centroid exist; second moments and image tracing do not. (compared with Fusion Sketch Properties/Canvas, SolidWorks Section Properties/Sketch Picture)

### Verified working

- Extrude on all 12 plane kinds (XY/XZ/YZ, offsets 25 and -25, tilt x45, tilt y90, offset plus tilt, three-point frames): bounding boxes and volumes are correct (probe t2).
- Through-all and distance cuts from XZ, YZ, offset, tilted and frame planes remove the expected volume; a cut that misses the body gives a clear message and a full-width slot splits the body into pieces (probe t23).
- Editing a committed sketch dimension and rebuilding dependents works: width 40 to 60 gives a 60 mm body; parameter bindings (w, w/8) update committed and working sketches and the solid (probe t9/t12).
- Hidden and construction entities never form profiles; open chains, a bow-tie and a CW-drawn loop behave correctly; profile ids and meshes are independent of entity order and repeatable (probe t5/t26).
- JSON round trip: all 7 entity kinds, 14 constraint kinds (smooth, pierce, driven, suppressed, expression, points), committed tilted and offset planes and hidden/construction flags come back identical, with stable canonical JSON (probe t16).
- Size limits are enforced at the sketch level: 0.01 mm geometry, 20000 x 20000 x 20000 mm rect and a 0.01 mm thick extrude all rebuild; a 0.02 mm hole in a 100 mm plate is found (probe t5/t17).
- Revolve 360/90 on the positive side is accurate within 0.2 % (kernel and tessellator); a profile that crosses the axis is refused with a clear message; angle 0 and above 360 are refused (probe t3).
- Expression engine: cycles, division by zero and out-of-range values (0, negative, 20000 mm) are reported per binding with the previous geometry kept (probe t12).
- Undo and redo restore full project snapshots (code-read), so constraints are restored exactly. Idempotency on a repeated operation id is implemented and tested in operations.ts.
- Entity and constraint limits are explicit at the single-op level: 500 entities and 1000 constraints per sketch; a 64-body and 200-feature cap is checked with named messages; 100 jointed segments in a single edit is fine.

Not checked in this area: The browser UI itself (rendering, drag/solve feel, dialogs), real DXF/STEP conformance, sheet-metal flat-pattern DXF, MCP server behaviour over the wire (only code-read on the 1 MB check and recipes), the two-lane qualified-part worker, and viewport performance.


## D. Status after the fix waves (2026-11-09)

What was done, in order: nine engineers fixed the 141 issues above on separate branches (wave 1, merged); six auditors re-ran every original probe against the merged build and hunted for regressions (re-audit); five engineers fixed what the re-audit found (wave 2, merged). The merged build passes 1383 tests (including a regression test per fix) and its production bundle builds.

### Re-audit of the wave 1 build (before wave 2)

Of the 141 original issues: 109 fixed, 23 partly fixed, 6 still failing, 3 not checkable without a browser. The re-audit also found 62 new issues, most of them regressions from the fixes. The serious ones were: editing one side of a plain joined polygon collapsed it; a rectangle with a pinned corner rotated and distorted; rows of four or more equal holes failed to extrude; every filleted line-to-arc joint was reported as redundant (DOF inflated, Sketch Repair "Fix all" deleted the tangents); sweep, loft and revolve dropped the holes of a region.

### Wave 2 (fixed, each with a regression test)

- Solver: two-level solve (hard relations first, then keep the untouched shape), rectangle rotation held, angle to an axis and 180 degree flips, tangent to an axis, line-to-arc tangent no longer counted as redundant, Repair keeps origin and axis relations, clean results without numeric dust, readable conflict messages.
- Shapes: slots and rounded rectangles joined at every line-arc junction so edits and drags keep them closed; regular polygon with a guide circle (inscribed, circumscribed, edge length); joining a rectangle corner or arc end slides the curve instead of deforming it; draw-time origin and axis snapping, tangent-arc inheritance, parallel, perpendicular, collinear and on-curve inference; ortho lock applied only where a direction matters.
- Regions: the hole-row failure was a bug in the polygon triangulator (hole bridging crossed itself when holes share a top coordinate); all 210 hole layouts now extrude (50 failed). Sweep, loft, revolve and chamfered extrudes keep region holes. Region warnings reach the timeline as notes. Break at intersections keeps the joints.
- Pipeline: size limits aligned, chord-error tessellation, accurate path sweeps, DXF/SVG number refusal and identity round trip, current MCP capability text.
- UI: one Pattern panel with live preview (rectangular, circular, path), distance dimensions drawn on the canvas, typed entry with `@` and `#`, document-unit entry, pattern and mirror copies no longer over-define the sketch.
- Merge fix: the merged spline sampler recomputed a whole-spline scan for every span, which made it quadratic; the chord ratio is now cached with the prepared spline (64 points cost 4 times 16, not 15 times).

### Still open or not verified

- No second full re-audit was run after wave 2. Each wave 2 fix has a regression test and the full suite is green, but the 62 new issues were not re-probed by an independent auditor.
- No UI behaviour from the fix waves was exercised in a browser by the engineers. I exercised these live on the merged build: sketch plane dialog and chip, build version footer and the "newer version available" banner, closing-loop auto-constraint, DOF of a drawn rectangle (4), corner drag, inline dimension editor, friendly entity names, region count with a diagonal (2), fillet of a drawn rectangle corner with relations, DXF import, slot creation with joints. A slot side-length edit and a regular polygon edit were not driven through the UI.
- Not fixed: legacy bare profile ids after a fillet or chamfer (the id carries no information to tell regions apart); the stored outline start vertex stays arbitrary (kernel face names depend on it); the YZ plane keeps its Y-up convention in a Z-up world (documented in the plane dialog, the status line and the revolve axis chip); meshes are still stored as plain JSON (only the size limits were aligned); a UI path picker for cross-sketch sweep paths; imported layer names other than construction cannot be kept (sketch entities carry no layer field); revolve of a circle profile keeps a fixed facet count because the mesh is stored as JSON; STEP/IGES export and DWG import are out of scope.
- Known interactions to watch: the arc radius limit is duplicated in `arc-geometry.ts` and `envelope.ts` (change both); Fix on a rectangle now really holds it, so dimensioning a rectangle that still carries a Fix needs the "Relax the Fix" step.
