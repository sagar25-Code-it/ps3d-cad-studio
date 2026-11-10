# PS3D sketch environment: second re-audit of the released build (main 167da52)

Method: six read-only agents re-ran every issue of the original audit and of the first re-audit against the released build, then hunted for new problems with fresh probes (about 800 tool calls, thousands of random operations). Results below are per area: items still failing or partly fixed, then NEW issues with severity.

## Totals

- Original audit, 141 items: 124 fixed, 15 partly fixed, 1 still failing (P22, the YZ plane convention, kept by design and documented), 1 UI-only and not checkable.
- First re-audit, 62 items: 56 fixed, 6 partly fixed, 0 failing.
- New issues found: 61 (2 blocker, 23 major, 31 minor, 5 cosmetic).

## Reproduced by me independently

- Hole rows: a 100 x 40 plate with a row of 4 equal holes extrudes to a mesh with 6 open edges, and a 12-hole bolt circle gives 24 open edges (rows of 1, 2, 3, 5, 6 and a 2 x 3 grid are closed). Volume is correct, but the mesh is not a closed manifold, so a later join or cut would fail. (Regions R2-01)
- Profile tool: a closed chain of line and tangent-arc clicks stores only 2 tangent relations and 1 coincident for 6 curves (DOF 23); dragging handles opens joint gaps of up to 36 mm and the edit still reports success. (Curve creation F1)
- Fillet drops dimensions: a plate of 4 lines pinned to the origin with length 80 and length 50 is fully constrained (DOF 0). Filleting one corner removes both length dimensions and leaves DOF 2 (underconstrained); only the radius dimension remains. (Edit tools R2-2 and UX R2-1)

Everything else below is as reported by the probe agents with their repro and observed output (not re-run by me).


##### Constraint solver, degrees of freedom, dimensions (sketch)
recheck: fixed 34, partial 0, still-failing 0, cannot-recheck 0 | new issues 11 | still missing 6 | verified-working 12
SUMMARY: Against the released build (main 167da52) all 23 original solver issues and all 11 first re-audit issues re-ran as fixed, with residual notes. The solver is now sound: 8,000 random operations, no crash or wrong constraint, and DOF matched an independent numeric rank on 750 of 750 random sketches. New problems: cost grows steeply with coupled chains (edits up to 12 s), Horizontal/Vertical cannot turn a line, Refraction overrides other relations, and the arc slot has no tangents. Probes: reaudit2-solver (p*, r*, n01-n43).
  NEW [major] R2-1: Edits and drags of coupled chains take seconds (500 entities / 1000 constraints notes claim 0.1 s)
     repro: Scripts n11, n30, n33. 250 circles tangent in a chain, each with a tangent line, all equal to c0 (500 ents, 999 cons): solve 160 ms but set-sketch-dimension radius 14 on c0 takes 12 s and a centre drag 9.5 s. 100 circles+lines: 1.3 s; 150: 3.5 s. 500 lines all equal to s0: setDim 8.6 s. 312-line H/V grid: setDim 1.0 s.
     actual: Edit cost grows roughly cubically with coupled chain length while plain solve and analyze stay under 0.2 s. A 100-element equal+tangent chain already blocks the UI for about 1 s per edit, 12 s at 250.
     where: packages/parametric-sketch-core/src/lm-solver.ts and workbench-core/src/sketch-solve.ts two-level solve (inferred from timing; not profiled)
     impact: Large pattern or chain sketches freeze on every dimension edit or drag step; users will think the app hung.
  NEW [major] R2-2: Horizontal/Vertical/Parallel/Perpendicular cannot turn a line a quarter turn; near-orthogonal lines are squashed
     repro: n31, n32. (a) Line (0,0)-(10,0) + Vertical. (b) Two exactly parallel horizontal lines + Perpendicular, or a vertical and a horizontal line + Parallel. (c) Line (0,0)-(10,1) + Vertical; (0,0)-(10,3) + Vertical.
     actual: (a) refused: 'Line 1 is exactly horizontal..., so Vertical would need a quarter turn, which the solver does not do'. (b) 'These relations contradict each other and cannot all hold: Perpendicular between Line 1 and Line 2.' (false, satisfiable). (c) accepted bu
     where: packages/parametric-sketch-core/src/equation-model.ts + lm-solver.ts (least-norm step has no rotation at the exactly orthogonal point); messages in sketch-solve.ts
     impact: Ortho-lock now draws exact horizontals, so turning one with Vertical or Perpendicular is refused with a wrong 'contradict' message, and shallow lines silently lose length.
  NEW [major] R2-3: Refraction (and smooth) are applied after the solve and override other relations silently
     repro: n21. Lines inc, ref, itf plus Refraction ratio 1.5; (a) horizontal on ref first; (b) ref end coincident with a vertical next line.
     actual: (a) accepted, ref ends up not horizontal (residual 8.8 mm), no conflict, classification underconstrained. (b) accepted, gap 0.61 mm between ref end and next line start; next solve moves 2 entities. DOF drops 12 -> 11 although start-on-incident (2) + direction 
     where: packages/workbench-core/src/sketch-solve-extras.ts applyRefraction (writes start/end after the LM pass); sketch-translate.ts treats the kind as NOTHING
     impact: A sketch using refraction can break horizontal, joint and dimension relations with no warning and shows a false DOF.
  NEW [major] R2-4: Arc slots (all three builders) have no tangent relations: width changes and corners kink on edit
     repro: n04. buildArcSlot({center:[0,0],radiusMm:30,startAngle:0,sweep:PI/2},4), buildThreePointArcSlot, buildCenterpointArcSlot. Check constraints, then set radius of the outer arc 30->40, or of a cap arc 4->10.
     actual: Only 4 coincident + equal + concentric are emitted; DOF 10. Outer arc r=40 gives radii [40, 6.01, 27.97, 6.01]: inner arc 26->27.97 and width 8->12.03. Cap arc r=10 gives corner kinks of 49.7 and 85.6 degrees.
     where: packages/workbench-sketch/src/basic-curve-shapes.ts buildArcSlot / buildThreePointArcSlot / buildCenterpointArcSlot
     impact: A curved slot silently changes width or tears at its ends on a normal radius edit.
  NEW [minor] R2-5: Drag restarts from the start state, so pass-over gestures teleport the sketch or fail with a raw id
     repro: n01, n02, n09. Line rectangle: drag b.end along (-0.7,0.7)*0.5 mm steps; hexagon vertex dragged inward 54 mm; slot line start dragged 100-300 mm away.
     actual: At pointer y=30.1 the whole rectangle jumps 30 mm in a 0.35 mm step (b.start [0,29.75] -> [-30.1,30.1]). Hexagon centre jumps 17 mm at step 108. Slot gives "Geometry 'entity:s2' is degenerate." with a raw id.
     where: packages/workbench-core/src/sketch-solve.ts dragLiveSketch (sign-preserving, nearest-branch)
     impact: Dragging a corner past the opposite edge makes the shape flash to another place.
  NEW [minor] R2-6: Tangent between a free circle and a distant line/circle is refused unless the radius is dimensioned, but nearby gaps sil
     repro: n19, n24. Free circle (20,30) r5, free line y=0, add Tangent. Also tangent circles with centre gap 17 (r8 and r6).
     actual: Far apart: 'Making c tangent to l would resize circle c from radius 5 mm to 30 mm, because they are far apart and nothing holds its radius.' (raw id 'c'). Close: circle c silently resized 6 -> 9. Fixed line + free circle is refused too.
     where: packages/workbench-core/src/sketch-solve.ts (resize guard)
     impact: A routine Tangent click fails until the user dimensions the radius first; the rule is inconsistent between near and far.
  NEW [minor] R2-7: Angle dimension is directed 0-360 from the first pick: typing the acute value flips a line to the other side
     repro: n13, n28. Shaft chamfer s1 (0,12)-(3,15) vs horizontal s2: set angle 45 with s1 picked first. Line at +20 deg set angle 30 to the X axis.
     actual: The chamfer jumps to (0,12)-(3,9), below the shaft top line (measured value was 315). The +20 deg line goes to -30 deg direction; 330 is needed for +30.
     where: packages/workbench-core/src/sketch-measure.ts angleBetweenLinesDeg; sketch-dimension-edit.ts line 236 (message says counter-clockwise)
     impact: A dimension typed from the drawing value can mirror the geometry; the pick order silently matters.
  NEW [minor] R2-8: Rectangle pinned at corner/centre picks up residual rotation after drags
     repro: n15, n17. Rectangle entity 100x60, corner-0 coincident with the origin; drag corner-3 from [0,60] to [-9.32,89.2] and commit; repeat with random width/height/drag ops.
     actual: One drag gives rotationDeg 0.00019 and the pointer is not matched; after 200 mixed ops up to 0.0069 deg (centre-on-origin 0.0079), so the rectangle is no longer axis aligned.
     where: packages/parametric-sketch-core/src/lm-solver.ts rectangle rotation variable (drag branch)
     impact: Tiny skew (0.01 mm at 100 mm) that later equal/horizontal checks and tidy dimensions see.
  NEW [minor] R2-9: add-sketch-constraint reports range errors as contradictions or a generic message
     repro: n39. add-sketch-constraint: length 0.001, radius 0.001, angle 400, angle -10.
     actual: length 0.001: 'Line 1 would collapse to a point. The relations acting on it contradict each other: Length 0.001 on Line 1.' radius 0.001: 'Circle 1 would shrink to nothing...'. angle 400/-10: 'A sketch constraint is invalid, duplicated, or references a missing
     where: packages/workbench-core/src/operations.ts add-sketch-constraint validation
     impact: MCP/API callers cannot tell the value is out of range.
  NEW [minor] R2-10: Documented claim 'adding the same relations in another order gives the same geometry' is false
     repro: n41. Add the same 5-7 relations to a triangle, a tangent circle chain and a perpendicular/parallel quad in 20 random orders.
     actual: 17, 8 and 17 distinct results out of 20; coordinates differ by up to 1.1, 4.6 and 0.8 mm (all valid). Entity/constraint array order for an edit is deterministic (r31, 0 difference).
     where: docs/SKETCH_SOLVER_NOTES.md; minimum-movement path dependence
     impact: Same design built in a different order lands in a different place; the doc overstates.
  NEW [cosmetic] R2-11: Raw ids and wording slips in solver messages
     repro: n09, n19, n06, p20.
     actual: "Geometry 'entity:s2' is degenerate."; "Making c tangent to l..."; summary 'Set length of entity:b to 1 mm' when the value came from an expression (shows the supplied valueMm, not the evaluated 100); 'An collinear constraint relates two different curves'.
     where: sketch-solve.ts, sketch-dimension-edit.ts solveSummary, operations.ts
     impact: Reads inconsistent next to the named conflict messages.

##### Sketch edit and modify tools (edit-tools, split-jog, offset-move, make
recheck: fixed 22, partial 3, still-failing 0, cannot-recheck 0 | new issues 5 | still missing 5 | verified-working 9
SUMMARY: Against 167da52: of E01-E18, 16 are fixed and 2 partly fixed (E07, E10). Of N1-N7, 6 are fixed and N3 is partly fixed. I ran about 38 probe scripts in C:\Users\sagar\AppData\Local\Temp\claude\36aee56b86df2857\095156fc-788a-4fd5-834a-33694e1f4ab0\scratchpad\reaudit2-edit-tools, including 3 random walks of about 3300 edits on constrained shapes. Those found no crash, NaN, dangling id or non-determinism. I found 5 new major problems and 3 minor or cosmetic ones.
  [partially-fixed] E07: Edit results carry no relations -- Fillet/chamfer/corner/pattern/copy/offset/mirror carry relations. Still open: mirror of arc, rect, ellipse and spline says 'Recorded, not solved' and a source drag does not move the copy (p07b). Offset has no distance relation: source circle R10->20 leaves the offset at 15; polygon width 60->100 leaves the offset at 70 (p28). Fillet also drops the size dimensions (see new issue
  [partially-fixed] E10: parseClipboard rejects angle/arc-length/smooth etc. -- p27: angle, arc-length, perimeter, smooth, driven and suppressed round-trip. But diameter, aligned, horizontal/vertical distance, point-line, line-line, major/minor-radius dimensions and point refs 'curve', 'corner-N', 'major-end' still give 'The clipboard has a relation that is not valid.'
  [partially-fixed] N3: Redundant relations after split/mirror/offset -- Rectangle/polygon/hexagon split x12, mirror, pattern, offset: no issues (p17, r19). Slot and rounded-rect still show 'Over-defined: Coincident on pr-584 and s46 is redundant' after split, offset (in and out) and mirror (p17/p18). Harmless to the solve; repairAll clears it and a drag after repair keeps the joints.
  NEW [major] R2-1: Dragging an end of a clockwise-drawn constrained arc moves the opposite end (fillet arcs)
     repro: p08: lines (0,0)-(100,0) and (0,0)-(0,100) joined with coincident; filletCorners R10; commit. Then dragSketchHandle(sketch, arcId, {kind:'arc-point', which:'start'}, from, to) for each of the 4 mirrored corner orientations. Also p07f: arc (10,0),(20,10),(30,0) joined to a line, drag 'end' +2,+3.
     actual: For the clockwise arcs (2 of 4 corner orientations) 'start' drag moves arc.end to the pointer and 'end' drag moves arc.start, e.g. drag start to [11,1] gives arc.start [21,-9], arc.end [11,1]; the joined neighbour is pulled with it. Counter-clockwise arcs beha
     where: workbench-core sketch-solve.ts runSimultaneousSolve: dragTarget selector is solverSelector(drag.point) with no swap for reversed arcs; sketch-translate.ts swapReversedArcEnds is applied only to constraints and dimensions. Reached through drag.ts liveDrag for any constrained arc.
     impact: Dragging the end of a fillet, slot or tangent arc (they always carry relations) throws the wrong end around and deforms the neighbours.
  NEW [major] R2-2: Fillet drops the part's size dimensions; editing the fillet radius then resizes the part
     repro: p37b: Rectangle entity 100x60 with width and height dims (also variant pinned at the origin). filletCorners(['r'], 8), commit ('Removed 2 constraints'). Then set-sketch-dimension radius 8 -> 14. Same for a 4-line polygon with length dims (p37).
     actual: The width/height dims are removed (no line-line distance is added). After R14 the outline is -6..106 x -6..66 (112x72); lengths of the straight pieces are held and the arcs grow. With the origin pin the part is not anchored any more.
     where: corner-tools.ts roundRectangleCorners / settleRelations: dimensions on shortened lines are removed instead of re-expressed (for example as line-line distance between the two opposite sides).
     impact: A filleted, dimensioned plate changes size whenever the radius is edited; a dimension-driven design cannot keep its overall size.
  NEW [major] R2-3: Fillet/chamfer/trim/move on copies of an associative pattern: OK reported, stray arc and unsatisfied relations
     repro: p35b: planPattern of two joined lines (rectangular 2x1, 60 mm); commit. filletCorners R5 on the two copy lines (entity:pat.pr-2.1.0, entity:pat.pr-2.1.1); commit.
     actual: Summary: 'Fillet R5. 2 pattern curves were reset to follow the pattern...'. The copy lines are reset to full length (60,0)-(90,0) and (90,0)-(90,20) but the new arc (85,0)-(90,5) and its coincident/tangent/radius relations stay. analyzeSketch: '3 curves do not
     where: apply-sketch-edit reset of pattern instances (workbench-core operations) versus corner-tools/transform-tools plans that do not know patternInstances.
     impact: A normal-looking fillet of a patterned hole or bracket leaves wrong geometry and an unsolved sketch.
  NEW [major] R2-4: Dynamic Mirror images carry no joints and no arc symmetry: editing the source tears the mirrored half
     repro: p22b: construction axis x=0 (fixed). withDynamicMirror drawing line (0,0)-(30,10), arc (30,10),(40,25),(30,40), line (30,40)-(0,50) with 2 coincident joints; commit. Then dragSketchHandle on the source line end (30,10)->(34,8).
     actual: Plan has only the source's 2 coincident plus 2 line symmetries; no joints between image curves and no symmetry for the arc. Before the drag: 1 profile. After: 0 profiles, 'Open chain of 6 curves'. Rect, ellipse and spline images get no relation either.
     where: dynamic-mirror.ts withDynamicMirror: relations only for line and circle; internal relations of the drawing are not cloned (mirrorEntities uses cloneWithRelations).
     impact: A symmetric half-profile drawn with Dynamic Mirror falls apart as soon as one side is edited.
  NEW [major] R2-5: Click-fillet/chamfer, split and trim of a Rectangle silently drop its other relations (origin pin, attached lines)
     repro: p29b/p29c: Rectangle 100x60 with a coincident to sketch:origin at corner-0 plus width dim. cornerByClick on the opposite corner (100,60), R8. Variant: lines attached to corner-1 and corner-3 by coincident; fillet corner 2, or splitAt the bottom side.
     actual: 'Fillet R8. Removed 2 constraints.' The origin relation and both attached-line joints are gone (explodeRectangle keeps only width, height, squareness); the rectangle floats and the attached lines are no longer joined.
     where: corner-tools.ts explodeRectangle (also used by cornerByClick and the split path)
     impact: Anchored or connected rectangles lose their anchor after rounding one unrelated corner; the status line does not say which relations went.

##### Sketch environment: UX flow and feature-gap audit from a working mecha
recheck: fixed 39, partial 3, still-failing 0, cannot-recheck 1 | new issues 11 | still missing 10 | verified-working 16
SUMMARY: Against 167da52: 25 of 28 original E items and 13 of 15 N items are fixed (E18, E19, N13 partial; E28 is UI-only so not rechecked). Core flows work: Line-tool plate, hole dims from origin, slots and polygons, regions, audit compaction, inch entry. Fuzz (60 seeds, 4 scales) and 500 entity/1000 constraint runs were clean. New findings: fillet and rectangle-fillet silently delete size dimensions and origin anchor; typed lines never join; point-distance dims cannot take parameters in the UI; plus 9 minor issues.
  [partially-fixed] engineer-gap E18: Sketch ignores display units; angle editor in mm -- r2_17/r2_19/e24: typed fields, Measure, constraint titles, a11y text, dimension editor all follow inch ('1' -> 25.4 mm). Still metric in an inch document: grid and snap step (0.1969 in, 0.7874 in; list in mm), Create solid fields, curve option fields, plane offset (R2-10).
  [partially-fixed] engineer-gap E19: Edit panels: Enter, preview, pick, comma -- e19: '12,5' -> 12.5; SketchEditPanel and SketchPatternPanel have Enter/Esc keys and ghost preview (code). Still absent: picking the rotate/scale/circular-pattern centre on the canvas (typed numbers or an Origin button) and a trim hover highlight.
  [cannot-recheck] engineer-gap E28: Canvas accessibility and hit targets -- UI-only. Probe/code level: role=application, tabIndex 0, arrow/Home/End/Enter map to focus/select (e28), hit sizes 11 px fine / 22 px coarse, sr-only live region, reduced-motion CSS in sketch-canvas-ux.css. Real focus order and screen-reader output need a browser.
  [partially-fixed] engineer-gap N13: Tooltips hard-code default keys -- Tooltips now use keyHint from the live keymap (Q, Z, I, Shift+F, X). The global '? keys' overlay still lists the default SKETCH_HOTKEY_HELP (App.tsx:285), so it ignores rebinding (R2-7).
  NEW [major] R2-1: Fillet/chamfer silently deletes size dimensions and origin anchor; fully-constrained plate drops to 4-5 DOF
     repro: r2_03: Line tool box (0,0)-(80,50), length 80 and 50 set: fully-constrained dof 0. cornerByClick fillet R5 at 4 corners. r2_39: Rectangle tool 80x50 + width/height + Horizontal (dof 0), then filletCorners([rect], 5).
     actual: First corner: 'Removed 4 constraints' (distance=80, distance=50, origin coincident, one more). After 4 corners: dof 5, no length dimensions left, only radius=5 x4. Rectangle case: dof 0 -> 4, 'no dimensions left' but radii. Message gives a count only.
     where: packages/workbench-sketch/src/corner-tools.ts (cornerByClick/filletCorners plans) and apply-sketch-edit pruning
     impact: The most common finishing step undoes the dimensioning; plate width can no longer be driven and the origin anchor is lost. Undo is the only recovery.
  NEW [major] R2-2: Typed points never join: no Coincident when a typed point lands on an endpoint, start point or origin
     repro: r2_34: Line tool, click origin, type length/angle 80/0, 50/90, 80/180, 50/270. Then set segment 1 length 100. r2_35: typed start #10,0 on an existing line end; typed start 0,0.
     actual: Closing line gets coincident(prev)+vertical+length only; message says 'Closed the loop after 4 lines. The shape is now a closed profile.' After length 100: lines (100,50)-(20,50) and (20,50)-(20,0), a notched shape, still 'fully-constrained dof 0'. Typed start
     where: SketchWorkspace.tsx commitDynamicInput (found has no primary) -> placePoint; dynamic-entry.ts resolveDynamicEntry
     impact: Keyboard-driven outlines (the headline second-wave feature) are not parametric: first edit breaks the loop while the status claims it is closed and fully defined.
  NEW [major] R2-3: Distance dimensions (hole positions, point-line, line-line, ellipse radii, angles) cannot be bound to parameters from th
     repro: r2_28: parameter plate_w; op set-sketch-dimension horizontal origin->circle with expression 'plate_w/4' works and changing plate_w moves the circle 20 -> 30. r2_27: readSketchLength('plate_w/2') -> 'Unknown name "plate_w"'. Type plate_w/4 into the canvas editor for a hole-from-origin dimension.
     actual: Named-distance branch (SketchWorkspace.tsx:1264-1271) and the inspector Position field (SolverRelations.tsx apply) accept numbers and units only; message 'Type a length (zero or more for a distance between two points...)'. Angle, arc length, perimeter also ref
     where: SketchWorkspace.tsx:1264-1279; sketch/SolverRelations.tsx apply()
     impact: Parametric hole spacing and edge offsets, the main use of parameters, cannot be set up in the sketch UI.
  NEW [minor] R2-4: Canvas Sketch Dimension offers rectangle edge midpoints, not corners, so hole-to-rectangle distances are measure-only
     repro: Draw a rectangle and a circle, Sketch Dimension, pick the rectangle's left-middle blue point and the circle centre.
     actual: dimensionHandles(rectangle) returns left/right/top/bottom midpoints; solverPointRef returns undefined for rectangle, so the panel says 'This is a reference measurement: the solver cannot move one of these points (a rectangle's edge middle...)'. r2_26 confirms 
     where: SketchWorkspace.tsx:2661-2728 (dimensionHandles, solverPointRef)
     impact: Dimensioning a hole from a plate edge needs the inspector corner dropdown; the canvas dead-ends.
  NEW [minor] R2-5: Sketch Repair treats a Diameter dimension as a radius: false 'Conflict' error, wrong label, Fix all relaxes a valid Equa
     repro: r2_05: circle A Diameter 10, circle B Radius 5, Equal(A,B). Also circle with Diameter 10 plus Radius 5.
     actual: Analysis: redundant 1, conflict 0. Repair: 'Conflict: Equal on user-3 and user-6' (error, usableForSolid false); Fix all 'Relax the equal just added'. Diameter dims are shown as 'Radius on ...'.
     where: packages/workbench-sketch/src/sketch-repair.ts SizeClasses.dimension (line ~184) ignores constraint.dimension === 'diameter'
     impact: A healthy sketch reads as broken and the one-click fix removes a good relation.
  NEW [minor] R2-6: 2-point and centre rectangles carry a free rotation DOF, so they never read fully constrained
     repro: r2_22-24: Rectangle tool at origin, set width 80, height 50: dof 1 (analysis 'underconstrained'). Add Horizontal on the rectangle: dof 0.
     actual: Free rectangle dof 5; autoConstraintsFor adds no Horizontal for rectangle tools (relations: none/coincident). Dragging keeps rotation 0 (r2_25) and the solver holds it, so only the status and amber colour are wrong.
     where: packages/workbench-sketch/src/auto-constraints.ts (no rectangle H/V); SketchWorkspace.tsx placePoint
     impact: First-hour rectangle sketch never shows 'Fully constrained' and gives no hint why.
  NEW [minor] R2-7: Global '? keys' overlay lists default sketch keys, not the user's rebound keys
     repro: Rebind Line to K in Sketch shortcuts, press ? in Sketch.
     actual: App.tsx:285 builds the 'Sketch canvas' group from the constant SKETCH_HOTKEY_HELP (default keymap). Palette list uses sketchHotkeyHelp(sketchKeymap).
     where: apps/studio-web/src/App.tsx:285
     impact: Two shortcut lists disagree after any rebinding.
  NEW [minor] R2-8: Command search (S) misses 7 ribbon sketch commands; coincident-to-origin has no glyph
     repro: r1_search/e_catalog: search entries vs ribbon. r2_11: glyph layout for a sketch with origin coincident.
     actual: Not searchable: Elliptical arc, 3-tangent circle, 2-tangent circle, Break, Import DXF/SVG, Export DXF/SVG, Picture. Origin coincident and origin dimensions have no point glyph (only the record list); axis relations do.
     where: ui/sketch-tool-commands.ts; constraint-glyph-layout.ts
     impact: Fusion-style S search cannot reach DXF import or Break; an anchored sketch shows no anchor on canvas.
  NEW [minor] R2-9: Persisted Reach extent disables the height field in a project with no solid
     repro: r2_33: store reach.extent 'to-face', reload; buildReach with no bodies -> 'Make a solid first; there is nothing to reach to.'
     actual: reach is a durable pref; reachesTarget = isReachTarget(reach.extent) disables the value input and Create solid refuses until Extent is reset (SketchWorkspace.tsx:464, 485, 2212).
     where: SketchWorkspace.tsx:464-485; ReachOptions.tsx
     impact: New project, greyed Height box, no clue why.
  NEW [minor] R2-10: Inch documents still get metric grid, snap steps and defaults
     repro: r2_12: gridSteps at 0.2 mm/px gives 5 mm = 0.1969 in; palette Snap step list is 0.1..25 mm; edit panels seed 5 mm = 0.1969 in, fillet 2 mm = 0.0787 in; plane offset Number('0.5 in') fails.
     actual: Grid/snap/defaults stay metric and Create solid/curve option fields are labelled mm.
     where: camera.ts gridSteps; snap-assist.ts SNAP_STEP_CHOICES; SketchInputPalette.tsx; SketchPlaneDialog.tsx confirm()
     impact: Clicking with snap on in inches lands on 0.1969 in; typed entry is the only exact route.
  NEW [minor] R2-11: Inspector Radius field fails on a hole sized as Diameter on canvas
     repro: r2_04: circle Diameter 10 (canvas editor), then Radius 6 from the inspector Radius field.
     actual: FAIL 'These relations contradict each other and cannot all hold: Diameter 10 on Circle 1 and Radius 6 on Circle 1.' Radius 5 is accepted as a second, redundant dimension.
     where: sketch-dimension-edit.ts keys by dimension name; SketchWorkspace.tsx EntityDimensions circle Radius field
     impact: Changing a hole size from the inspector after dimensioning it on canvas is refused or double-dimensions it.

##### Sketch-to-solid pipeline, persistence, units, import/export and operat
recheck: fixed 26, partial 7, still-failing 1, cannot-recheck 0 | new issues 11 | still missing 8 | verified-working 12
SUMMARY: Against 167da52 I re-ran all 26 original items, the 8 first re-audit items and ~75 new probes. 29 are fixed, 4 partly fixed, 1 still failing (P22, kept by design), 4 more partly (P01, P13, P14, P16). Revolve about a chosen axis, hole-keeping sweeps and lofts, cross-sketch path sweeps, face-following sketches, audit compaction, DXF/SVG round trips and atomic Finish Sketch all work. New: sweep twist builds wrong geometry, a many-hole plate blocks Finish Sketch with a generic message, inch mixed numbers like 1-1/2 are misread, and malformed constraint payloads still throw.
  [partially-fixed] pipeline P01: Saved project over 1 MB cannot be reopened -- Save and Open both use 50,000,000 bytes; 2.66 MB torus project and 8 tori (21 MB) reload ok. But meshes are still plain JSON and one MCP call is capped at 4 MB: a second torus via ps3d_prepare_design_solid gives 'The built solid is 2647 kB and the project is 2658 kB; ps3d_apply_preview needs both in one call of at most 4 MB'.
  [partially-fixed] pipeline P10: Path sweep is a sheared prism; profile and path must share a sketch -- Engine: 36 random line/arc/chain paths on XY/XZ/YZ/offset/tilted sketches, circle on a perpendicular frame: worst volume error 0.07%; loft XY to offset/tilted rect ok. UI: SketchWorkspace builds only sweepPathEntityId (same sketch, one entity) and no loft-secondary-sketch picker; cross-sketch paths exist only via engine/MCP.
  [partially-fixed] pipeline P13: All invalid entities give one generic message -- Entities, planes (offset 200000, tilt 400, frame) and the 501st entity/1001st relation now named. Still generic: bad text/pattern/underlay in objects gives 'The sketch edit payload is invalid: check removeEntityIds, updateEntities, addEntities, addConstraints and label'; parameter table without comment gives 'The parameter table is invalid.'; 'A sketch entity to remove does not
  [partially-fixed] pipeline P14: applyWorkbenchOperation throws on NaN/Infinity -- NaN/Infinity in entities, dimensions, planes now return 'The operation contains a number that is not finite'. But add-sketch-constraint with missing entityIds, missing/non-string id, null entity id or points:null still throws TypeError (115 of 2250 mutated ops); ps3d_preview_operation throws too (see new issue).
  [partially-fixed] pipeline P16: Inch entry inconsistent -- parseLengthInput accepts '1/2 in', '(1/2) in', '3/4"', '1 1/2 in', '1"-1/2"', 10 mil, 25,4 mm, 5' 6"; expressions accept 1/16 in. But '1-1/2' in inch mode reads 0.5 in, '5 + 1 in' = 30.4 mm, and the inch display unit is not saved with the project (new issues).
  [still-failing] pipeline P22: YZ plane is Y-up in a Z-up world -- YZ revolve about a vertical sketch line still turns about world Y: bbox [-15,0,-15]-[15,20,15]; sketch X = world -Z. Documented in ps3d_capabilities and the plane dialog as a deliberate convention, not changed.
  [partially-fixed] pipeline N-05: Corrupt DXF numbers replaced by 0 -- NaN, 'abc', 1e400, 0x10, '1,5', cut inside a group pair are refused with group code and line. A file cut at a group boundary (or SVG at an element boundary) still imports a partial drawing: 18 of 40 curves, no warning (new issue).
  [partially-fixed] pipeline N-08: Horizontal on an exactly vertical line refused as collapse -- Both add-sketch-constraint and apply-sketch-edit now say 'Line 1 is exactly vertical (from 30, -10 to 30, 40), so Horizontal would need a quarter turn, which the solver does not do' with a remedy. The line still cannot be turned; Fusion/SolidWorks rotate it.
  NEW [major] pipeline N2-01: Sweep twist builds only the two end rings: wrong volume
     repro: Rect 20x10 on XY, sweep sweepDirectionMm [0,0,1] valueMm 60 with sweepTwistDeg 90 (probe b5/b3; also path sweep along a 60 mm line from another sketch; also a 20x20 square and a ring).
     actual: 12 triangles, end rings rotated only: twist 30 -> 8964, 90 -> 3000, 180 -> 4000. Square 20x20x50 twist 90 -> 6667 (20000); disc twist 90 -> 10300 (15698); ring twist 90 -> 3498 (5651). Twist 360 is right (12000).
     where: apps/studio-web general-modeling tessellateSweep / sweep-loft-feature sweepRigid (workbench-geometry); Twist field in the sketch solid palette (SketchWorkspace.tsx sweepTwist).
     impact: A twisted bar or blade comes out pinched with no warning; mass and cuts against it are wrong.
  NEW [major] pipeline N2-02: Plates with many holes: slow build, 100k-vertex cap, and Finish Sketch refused with a generic message
     repro: (a) Plate with an NxN grid of r3 holes, rebuildSolidFeature then add-design-solid. (b) 260x260 plate, 8x8 holes extruded (25,772 tris), reopen sketch, add 40 r1 holes, commitWorkingSketchAtomically (or regenerate-design).
     actual: 10x10 r3: 40,252 tris, 3.7 s, add-design-solid 'The solid has 120,756 vertices; at most 100,000 can be stored.' 8x8 ok. 480 holes took 29.9 s. Every hole costs ~400 triangles even at r=0.5. In (b) Finish Sketch is REFUSED with 'The rebuild results are invalid.
     where: envelope.ts solidEnvelopeProblem (vertex cap, unindexed 3 vertices per triangle); regenerate-design validation message; kernel triangulation cost.
     impact: Vent grilles, filters and perforated panels over ~80 holes cannot be modelled, and adding holes to a working model blocks Finish Sketch without saying why.
  NEW [major] pipeline N2-03: Inch entry: hyphen mixed numbers and bare-number sums are misread
     repro: core.parseLengthInput with default unit inch: '1-1/2', '20-1/2 in', '5 + 1 in', '12 - 1/2' (probe e2).
     actual: '1-1/2' -> 12.7 mm (0.5 in); '20-1/2 in' -> 7.3 mm; '5 + 1 in' -> 30.4 mm in BOTH unit modes (bare 5 read as mm); '12 - 1/2' -> 292.1 mm. Space form '1 1/2' is right (38.1). Unicode fractions (1/2 symbol) are 'Unexpected character'.
     where: packages/workbench-core units.ts parseLengthInput / expression evaluation of dimensionless terms.
     impact: US drawing notation 2-1/2 in gives a silently wrong, usually tiny or negative dimension.
  NEW [major] pipeline N2-04: Malformed add-sketch-constraint payloads still throw TypeError (also through MCP)
     repro: applyWorkbenchOperation / handleWorkbenchMcpTool('ps3d_preview_operation') with add-sketch-constraint whose constraint lacks entityIds, or lacks id, or has id/entityIds null, or points:null (probes z2, m9).
     actual: 'constraint.entityIds.map is not a function', 'Cannot read properties of undefined (reading trim)', 'reading length'. 115 throws in 2250 mutated operations; the MCP handler throws instead of returning isError (api/mcp.ts callTool has no catch).
     where: packages/workbench-core operations.ts add-sketch-constraint validation (operation-level checks only cover entities).
     impact: A slightly wrong agent call crashes the handler instead of explaining the field; same class as audit P14.
  NEW [minor] pipeline N2-05: Truncated DXF/SVG cut at a group or element boundary imports a partial drawing without a warning
     repro: Write a 40-line polygon DXF, cut it at 30/60/90% on a group boundary, parseDxf; SVG without </svg> or cut after a />.
     actual: DXF: 'OK 18 of 40 curves' warnings []; SVG: 16 of 30 curves, no warning; missing </svg> alone also accepted.
     where: dxf.ts parseDxf / svg.ts parseSvg end-of-file checks.
     impact: A damaged or half-downloaded outline becomes a smaller wrong part.
  NEW [minor] pipeline N2-06: Inch display unit is not saved with the project or remembered
     repro: Project JSON has no unit-display field (root rejects an added displayUnit: 'missing or unsupported fields'); App creates the CAD document with the default unit at start (App.tsx:294) and keeps only the session value when opening a file.
     actual: Every new session and every opened file starts in mm; project.unit must be 'mm'. Verified by probe for the file format and by code reading for the session reset, not in a browser.
     where: workbench types/validation (project root fields); App.tsx initialDocument.
     impact: Inch users must switch Units again each time and can mistake 25.4 for 1.
  NEW [minor] pipeline N2-07: MCP inspect and design health do not see the timeline
     repro: ps3d_inspect_project on a project with sketches and solids; ps3d_design_health after a revolve axis line was deleted (feature.health: 'The line this revolve turns about (cl) is no longer in its sketch').
     actual: Summary has only working-sketch counts, part width/height/thickness and audit count; no feature, sketch or body ids. Design health lists no timeline finding (score 97). A set-sketch-dimension on an entity of a committed sketch answers 'The sketch entity does n
     where: packages/workbench-mcp index.ts projectSummary; workbench-health index.ts; recipes text.
     impact: An agent building sketch-to-solid models cannot see broken features or the ids the recipes point to.
  NEW [minor] pipeline N2-08: Loft between profiles on one plane gives a flat zero-volume body; perpendicular profiles fail with a wrong message
     repro: Circle sketch and rect sketch both on XY at the same offset, loft with loftSecondarySketchFeatureId, then add-design-solid; second case: XY circle to an XZ rect at offset -60.
     actual: vol 0, bbox z 0..0, ACCEPTED 'Added l to the timeline.' The perpendicular case: 'The profile could not be capped: The profile outline has no area.'
     where: sweep-loft-feature.ts buildLoftFeature.
     impact: A junk body enters the timeline; the elbow-loft failure message points at the wrong cause.
  NEW [minor] pipeline N2-09: sweepDirectionMm is documented as world space but is rotated with the sketch tilt/frame
     repro: Ring on XY tilted 30 deg about Y, sweep valueMm 50 with direction (0,0,1) versus the world normal (0.5,0,0.866).
     actual: (0,0,1) gives the normal sweep (5651, size 42.3x20x53.3); the true world normal gives a sheared prism (4894, size 60.6x20x35).
     where: sweep-loft-feature.ts placeDirection(shiftDatum) and general-modeling sweep.
     impact: On tilted and three-point planes a typed direction goes the wrong way.
  NEW [minor] pipeline N2-10: set-sketch-dimension summary reports the typed value, not the evaluated expression
     repro: Parameter maj = 25 mm; set-sketch-dimension minor-radius valueMm 6 expression 'maj/4' (and radius valueMm 1 expression 'maj/4').
     actual: Summary 'Set minor-radius of entity:el to 6 mm' and 'Set radius ... to 1 mm' while the geometry is 6.25.
     where: operations.ts set-sketch-dimension summary.
     impact: An MCP agent is told the wrong size.
  NEW [cosmetic] pipeline N2-11: Small message and number-dust items
     repro: (a) extrude chamfer 30 on a plate with a hole; (b) DXF round trip of an ellipse; (c) unhalvedExpression('(a) / 2 + (b) / 2').
     actual: (a) failure text ends with the unrelated 'The chamfer or fillet is applied to the outline; the holes keep their sharp edges.'; (b) majorRadiusMm 11.999999999612374, minor 5.000000003838489; (c) shows 'a) / 2 + (b'.
     where: design-regeneration.ts:182; dxf.ts ellipseCurves; dimension-expression.ts regex.
     impact: Confusing wording and 12-digit values in the dimension editor.

##### Closed-profile / region detection and extrusion readiness (detectSketc
recheck: fixed 27, partial 2, still-failing 0, cannot-recheck 0 | new issues 10 | still missing 4 | verified-working 10
SUMMARY: Of the 18 original and 11 first-re-audit items, 27 are fixed and 2 are partial (P-05 legacy bare ids, N-04 silent re-attachment). The arrangement engine is sound: 6000 random mixed scenes had no overlapping faces and the face areas were consistent. All 512 hole-layout trials and 210 grids now extrude. But 8 new problems remain. The worst: rows of 3 or more equal holes and a 12-hole bolt circle extrude with an open mesh, so any later join or cut fails. Faces vanish silently for near-coincident (about 0.007 mm) intersections. Stored region refs silently lose or shrink holes after sketch edits.
  [partially-fixed] P-05: Loop ids change on topology edit -- Stored refs survive rectangle fillet (7922.56), line chamfer, split, trim. Legacy bare ids ('profile:p') still fail after fillet when 2+ regions remain: 'a profile this feature was built on no longer exists in its sketch (p)'; with 1 region left it works with a note.
  [partially-fixed] N-04: Region ref silently re-attaches to larger piece -- Line 5 mm off centre: vol 8000 to 5000 with note (63%); centre line and diagonal now refuse ('split into 2 regions'). But a line 1 mm from the edge gives 7800 and 0.2 mm gives 7960 with no message; a circle crossing an edge gives 7608, no message (5% threshold).
  NEW [blocker] R2-01: Plates with rows/columns/grids of equal holes (and 12-hole bolt circle) extrude to an OPEN mesh, so any later join/cut/i
     repro: Sketch rect 60x40 at origin plus circles r2.5 at (-8,0),(0,0),(8,0). rebuildSolidFeature (empty selection or plate ref), valueMm 10: ok vol 23411.34. Then combineGeneralBodies cut or join with any box. Also: disc R50 plus 12 circles r3 on R35 (16 open edges); 5x4 and 6x6 grids; loft with 2+ holes; random multi-region selections (430/1060).
     actual: 'The target is not a closed solid (it has open or non-manifold edges), so a Boolean cannot use it.' 24 of 72 equal-r rows, 63 of 160 inch hole layouts, 15-40 of 40 hole orders on grids and bolt circles. Cap area is complete, edges between hole extreme points a
     where: packages/occt-kernel-adapter/src/polygon.ts triangulateLoops/bridgeHole/earClip (suspect: degenerate ring vertices dropped, bridges between holes); also loft/regions in apps/studio-web/src/sweep-loft-feature.ts
     impact: After drilling a bolt row or perforation pattern, pocket/boss/slot cuts on that body are refused with a message that points nowhere; the engineer cannot add features to the plate.
  NEW [major] R2-02: Near-coincident intersections (about 0.006-0.009 mm) make whole faces vanish with no warning
     repro: detectSketchProfiles: circle (0,0) r10, circle (12,0) r10, line x=6.007 from y=-15 to 15 gives 2 faces [225,45] total 269.4. x=6, 6.004, 6.006 give 4 faces; x=6.009 gives 6 faces, all total 538.9. Also circle centre (-7.262,-23.823) r5.457 plus rectangle centre (-16.94,-22.33) 19.679x13.869 gives 1 face of 3. 3 of 6000 random scenes lose a face.
     actual: Half the area disappears; Validate says 'No errors. No warnings. 2 closed profiles ready'. At x=6.008 it instead warns 'Curves overlap'.
     where: packages/workbench-sketch/src/arrangement.ts (vertex clustering at PROFILE_GAP_TOLERANCE_MM 0.01 inconsistent between curves)
     impact: A line or corner placed about 7 microns off an intersection silently removes regions, and a feature built on them reports a missing profile; exact or clearly offset geometry is fine, so it is hard to 
  NEW [major] R2-03: Stored region ref silently loses its original hole when an outline is drawn around it or the hole is redrawn
     repro: Project sketch: rect 80x40 plus circle r3 at (-18,0). add-design-solid extrude with plate ref (vol 31717). edit-design-sketch, add circle r8 at (-18,0) (or inner rect 74x34, or replace the circle by a hexagon), commit, rebuildDependents.
     actual: Volume 32000 (hole gone), message undefined, for concentric circle r8, r3.5, inner rect, and hexagon replacement.
     where: packages/workbench-sketch/src/profile-select.ts unionRegion (non-kept hole filled with every face inside, including the pinned hole's own disc)
     impact: Adding a counterbore circle or redrawing a hole in the same sketch quietly fills the through hole in the earlier extrude; mass and fit are wrong without any notice.
  NEW [major] R2-04: Geometry re-match treats any one new hole as the old hole, turning a plate into a 3 mm frame
     repro: Sketch rect 80x40 plus circle r3; extrude plate ref (31717). Replace the rect by 4 lines (same outline, new ids, as after a fillet/explode) and add an inner 74x34 loop (offset); rebuildDependents.
     actual: Volume 6840 (only the 3 mm band between outline and inner loop), no message.
     where: packages/workbench-sketch/src/profile-select.ts resolveProfileRegion: keep='all' when found.how==='geometry' && holes.length===keys.size
     impact: A common edit sequence (fillet, then offset the outline for a rim or pocket) shrinks the earlier extrude by 78% with no warning.
  NEW [major] R2-05: Straight sweep with Twist builds only two stations: volume and shape wrong
     repro: rebuildSolidFeature kind sweep, sweepDirectionMm [0,0,1], valueMm 20, sweepTwistDeg T on rect 20x40: T=5 gives 15398.7, 20 gives 13398.2, 45 gives 9723.9, 90 gives 4000.0, 180 gives 5333.3 (expected 16000). Circle r10, T=90: 4120 vs 6283. Rect with hole T=90: 3617 vs 15434. Only 12 triangles for the rect.
     actual: Collapsed, self-folding sweep; no warning. Twist field is offered in the sweep dialog and the feature table.
     where: packages/workbench-geometry/src/sweep-solid.ts sweepRigid / sweepAlongPath (stationCount = path points, 2 for a straight sweep)
     impact: A twisted sweep (screw, twisted bar) produces a wrong shrunk solid and wrong mass.
  NEW [major] R2-06: A plate cannot hold more than about 83 round holes; editing past it is rejected with a cryptic message
     repro: Plate plus N circles r2: N=80 ok (96,600 vertices). N=100: add-design-solid 'The solid has 120,744 vertices; at most 100,000 can be stored. Simplify the shape.' With 80 holes already stored, edit sketch to 110 holes, rebuildDependents (body of 132,810 vertices, no message) then regenerate-design: REJECTED 'The rebuild results are invalid. Use an exact bounded operation schema f
     actual: Each hole costs about 1,207 raw vertices at every radius (unindexed triangle soup, 3 per triangle); the sketch commit succeeds while the solid stays stale with an unhelpful error.
     where: mesh storage limit (100,000 vertices) vs packages/occt-kernel-adapter tessellation; apps/studio-web design regeneration
     impact: Grilles, speaker covers and pegboards are impossible, and a sketch edit that crosses the limit leaves a stale solid with an unexplained error.
  NEW [minor] R2-07: Break at intersections: pieces meeting at the crossing get no joint; Validate then warns 'Open chain of 9 curves'
     repro: 4-line joined square (20x20) plus line from (-3,10) to (23,10); commit(breakAtIntersections); analyzeSketch; then set-sketch-dimension a length 30.
     actual: Constraints 7 to 12 (corner joints only). After length 30 the divider no longer reaches the new edge: faces 2 to 1, area 600. analyzeSketch: warning 'Open chain of 9 curves ... does not enclose a profile' next to '2 closed profiles ready' (none before the brea
     where: packages/workbench-sketch/src/break-intersections.ts; packages/workbench-sketch/src/sketch-repair.ts open-chain branch
     impact: Resizing a broken sketch detaches the dividers and the Validate panel contradicts itself.
  NEW [minor] R2-08: Sweep and loft drop region warnings (crossing circle left out silently)
     repro: rect 20x40 plus circle crossing its edge; rebuildSolidFeature extrude, revolve and chamfered extrude return warnings; sweep (z 10) and loft (topScale 0.7) return warnings null.
     actual: No note for sweep/loft: result built without the circle.
     where: apps/studio-web/src/design-regeneration.ts lines 110-113 (special builder path returns only special.warning)
     impact: Silent hole loss remains for sweeps and lofts.
  NEW [minor] R2-09: Selecting regions whose union touches itself at a vertex fails with 'The profile outline crosses itself.'
     repro: 3x3 line grid (10 mm cells); extrude refs of all cells except (0,0) and the centre cell. Also 43 of 1060 random multi-region selections.
     actual: 'The solid kernel could not extrude this profile: The profile outline crosses itself.' (no regions named; the hole case does name them).
     where: packages/workbench-sketch/src/profile-select.ts unionRegion pinch handling; message from occt-kernel-adapter polygon.ts
     impact: A valid-looking selection fails with a misleading message about self-crossing.
  NEW [cosmetic] R2-10: Hole-touch messages cite internal region hashes
     repro: plate 40x40 plus circle r5 with 0.005 wall; ref extrude.
     actual: 'The hole a touches the outline of rg-ed3366d2 (or lies within 0.01 mm of it)'.
     where: packages/workbench-sketch/src/profile-select.ts shortId/touchWarnings
     impact: Message points at an id the engineer cannot find in the UI.

##### Curve creation tools, dynamic input, inference/snapping, auto-constrai
recheck: fixed 32, partial 6, still-failing 0, cannot-recheck 0 | new issues 13 | still missing 6 | verified-working 12
SUMMARY: Against commit 167da52: of 38 items, 31 are fixed, 7 partly fixed, none fully failing. Polygon (all 3 modes, n=3..64), slot, rounded rectangle and parallelogram now survive dimension edits, drags, 20 repeated edits, JSON round trips and a scale sweep from 0.05 to 2000. Typed entry, origin snapping, tangent-arc inheritance, relation hints, hotkeys and camera all pass. New problems cluster in sibling shapes that wave 2 did not cover: the Profile tool with arcs still tears apart on edit (blocker), arc-to-arc tangent is flagged redundant and Fix all deletes it, and contradictory opposite-side dimensions are accepted. 13 new issues.
  [partially-fixed] T13: Conic/control-spline fit error larger than documented -- 60 mm span deviation: rho 0.5 0.0124 mm, 0.9 0.1009, 0.98 0.5327, 0.05 0.0138 (was 0.013/0.33/0.89/0.12). Control-point spline still 0.104 mm. High-rho hyperbolas still exceed the documented 0.05 mm.
  [partially-fixed] T17: Typed dynamic values lose design intent -- Line 50 @0: [horizontal, distance:length=50]; @90: vertical; rect 20x10: width+height; circle r5: radius. Polygon r10, arc-center r10/sweep 90, ellipse 10x4, slot give []: typed sizes not stored.
  [partially-fixed] T18: Builders accept NaN/Infinity; op layer throws -- Single-entity builders refuse with a clear message. buildSlot, buildSlotOverall, buildPolygon, centerline, line-midpoint, parallelogram, rounded rectangle still return ok:true with NaN geometry; apply-sketch-edit now refuses cleanly ('not finite') instead of throwing.
  [partially-fixed] T26: Fit spline needs 3 points, fixed limits -- 64 points ok, 65 refused with message, A,B,A refused with explanation. Two-point spline still 'requires 3 points'; no end tangent conditions.
  [partially-fixed] T28: Camera NaN guard, crossing tolerance -- zoomCamera/fit with NaN, 0, Infinity return a finite camera; 2000 random fits land inside the free area; 0.2 mm box on r=1000 circle selects it; 300 splines infer in 5 ms. gridSteps(1, NaN) and (1, Infinity) still return NaN.
  [partially-fixed] N9: No key for elliptical-arc/tangent-circle tools -- tool:ellipse-arc, circle-tangent-2/3, arc-tangent are keymap commands; rebinding ellipse-arc to H resolves {tool:ellipse-arc} and shows chip H. Unbound by default, and dynamic input still offers only X/Y for the first click.
  NEW [blocker] F1: Profile tool outline with tangent arcs tears apart on edit; edit reports OK
     repro: Profile tool clicks: start (0,0); Line (40,0); Tangent arc (40,30); Line (0,30); Line (0,0) (via extendProfileChain, applied with its constraints). Then set-sketch-dimension length of line 1 to 24, or dragLiveSketch any vertex by (2.5,-1.5).
     actual: Edit says ok, detectSketchProfiles goes 1 to 0, joint gap 16 mm. 6 of 8 vertex drags lose the profile (gap up to 10.7 mm). Relations are only tangent + a few coincident: constraints=[tangent,coincident,coincident]; arc ends have no Coincident.
     where: blend-profile.ts extendProfileChain (stale comment: 'solver only enforces tangency between line and arc')
     impact: A routine profile with a rounded end silently becomes open curves after any change; Extrude then fails with no hint. Same defect class as T02, left in the Profile tool.
  NEW [major] F2: Tangent arc started on an arc end is flagged redundant; Fix all deletes the Tangent
     repro: Arc (50,0)-(60,10)-(70,0). Arc-tangent tool: first click on its end (70,0), then (90,-30) (relations [coincident, tangent]). analyzeWorkbenchSketch; validateSketch; repairAll; then dragLiveSketch arc 1 mid by (4,6).
     actual: redundant=1 'Coincident: Arc 1 end and Arc 2 start ; Tangent between Arc 1 and Arc 2'; Over-defined warning; repairAll applies 'Delete the redundant tangent'; after it a drag leaves the joint 12.3 deg off tangent. 9 of 2000 random draws hit it, all arc-tangent
     where: solver redundancy analysis for arc-arc Tangent + Coincident; sketch-repair.ts
     impact: Every tangent chain made of arcs shows an Over-defined warning on creation, and the suggested one-click fix destroys the design intent.
  NEW [major] F3: Contradictory opposite-side dimensions are accepted on parallelogram, rounded rectangle and slot
     repro: (a) buildCurveTool parallelogram [[0,0],[20,0],[28,10]]; set length of line 0 to 12, then line 2 to 7. (b) rounded rectangle 50x30 r6: lengths line 6 to 14.21, line 4 to 36.56, line 0 to 48.02. (c) slot [0,0],[20,0],[10,3]: top 30, then bottom 12. Compare a 4-line H/V rectangle: 20 then 12 is refused.
     actual: All ok. (a) collapses to a flat zero-area quad at y=10 (all four lines collinear), DOF 4, 0 conflicts, profiles 0. (b) self-crossing outline, 2 profiles. (c) lens with unequal sides; earlier sequence top=bottom=50 then top=100 gives cap radius 43.3 instead of 
     where: shapes.ts buildSlot, curve-tools parallelogram, rounded rectangle: no Equal between opposite sides; solver allows collinear/anti-parallel solutions
     impact: Dimensioning the second long side of a slot or plate (natural when fully defining a sketch) silently turns it into a distorted or empty profile.
  NEW [minor] F4: Arc slots are born with a redundant relation set and lose tangency on drag
     repro: buildCurveTool slot-arc-three-point [[0,0],[10,6],[20,0],[10,9]] (or slot-arc-center [[0,0],[10,0],[0,10],[8,2]]); add; validateSketch; repairAll; dragLiveSketch arc 3 start by (1.5,-1.2).
     actual: Fresh slot shows 'Over-defined: Concentric on Arc 1 and Arc 3 is redundant'; Fix all deletes the concentric (DOF 10 to 11). Relations are only coincident x4, equal, concentric (no Tangent), so a single drag gives an 11.6 deg kink at a joint.
     where: curve-tools buildThreePointArcSlot / buildCenterpointArcSlot
     impact: Warning on every new arc slot; edited arc slots stop being slots.
  NEW [minor] F5: 3-point arc whose through-point snaps to origin, an endpoint, a line/arc curve or a crossing: relation refused as 'confl
     repro: Line (-10,0)-(10,0) exists. 3-point arc start (40,40), through-point (10,0) snapped to the line end, end (-40,40); autoConstraintsFor gives coincident[line.end, arc.mid]; apply-sketch-edit. Also mid on a line/arc curve or on the origin.
     actual: 'This edit conflicts with a sketch relation on Line 1, Arc 1' ; the arc is added without the relation. Refused for mid on line/arc ends, rectangle corners, line/arc curves; fine for circle/ellipse curves. 70 of 71 refused draws in 1800 simulated draws were thi
     where: auto-constraints.ts emits coincident with arc 'mid' (SOLVABLE_POINT_REFS allows it) but the solver cannot satisfy it
     impact: Arcs through an existing point get a false conflict message and no attachment.
  NEW [minor] F6: Ellipse x circle / ellipse x ellipse intersection snap is inexact and its relation is always refused
     repro: Ellipse (-8.3,15.6, 47.6x13.3, -74.9 deg) and circle (10,-0.15, r29.1); inferSketchPoint near (-18.77,4.30); point tool with autoConstraintsFor; apply-sketch-edit.
     actual: Snap point is 0.0014 mm off the circle (up to 2.3e-3 across 105 trials); coincident x2 refused 105/105 (ellipse x circle) and 117/117 (ellipse x ellipse) with 'This edit conflicts with a sketch relation on Ellipse 1, Circle 1, Point 1'. Ellipse x line is exact
     where: inference.ts ellipse intersections (polyline based)
     impact: Cannot pin a point or line end to an ellipse crossing; message blames the user's sketch.
  NEW [minor] F7: Ortho lock turns every rectangle into a square
     repro: assistedInference with settings.ortho=true, tool rectangle / rectangle-center / rectangle-rounded, anchor (0,0), pointer (30,12).
     actual: Point becomes (30,30) note 'Square' for all three; Shift does the same by design. Ortho is a sticky palette switch, so a non-square rectangle cannot be drawn with the mouse while it is on.
     where: snap-assist.ts DIRECTION_LOCK rectangle: 'every' and constrain() SQUARE_TOOLS
     impact: Surprising for anyone who switched Ortho on to draw lines.
  NEW [minor] F8: Polygon dynamic-input field is labelled Circumradius in every mode
     repro: dynamicFieldsFor('polygon',1) -> 'Circumradius'. Type 10 in circumscribed mode (n=6); buildPolygonByMode.
     actual: Circumscribed: typed 10 gives circumradius 11.547 (apothem 10). Edge mode: first click is a side end and 10 is the side length. Field name never changes (function has no mode argument).
     where: dynamic-input.ts FIELD.circumradius, SketchWorkspace dynamicFields
     impact: Typed hex across-flats or side length is read under a wrong label.
  NEW [minor] F9: Shape tools ignore their snaps: no coincident to origin, endpoints or centres
     repro: Read SketchWorkspace.tsx placePoint (lines ~1004-1013): for isShapeTool tools only polygonCentreRelations is added; autoConstraintsFor is not called for slot, slot-straight, rounded rectangle, parallelogram, line-midpoint, centerline, arc slots, conics, ellipse-arc, tangent circles. Polygon corner and edge-mode ends are also not related.
     actual: Code-read only (not run in a browser): shape added with its own relations only; T11 is fixed for single-entity tools only.
     where: SketchWorkspace.tsx placePoint isShapeTool branch
     impact: Slots and plates cannot be located parametrically by snapping.
  NEW [minor] F10: Malformed constraint payloads throw TypeError instead of a diagnostic
     repro: applyWorkbenchOperation add-sketch-constraint with constraint {kind:'horizontal',entityIds:['entity:l1']} (no id); or {id:'constraint:z',kind:'horizontal'} (no entityIds); or entityIds:'entity:l1'; same inside apply-sketch-edit addConstraints.
     actual: TypeError 'Cannot read properties of undefined (reading trim / map / some)' from validateParametricSketch / constraint code. Malformed entities are refused cleanly.
     where: operations.ts add-sketch-constraint and apply-sketch-edit validation (only isRecord checked)
     impact: MCP/API callers crash the operation instead of getting a message.
  NEW [minor] F11: Text tool refuses long text with a stale per-edit limit
     repro: curveTools.buildCurveTool('text', ..., text 'B' x 40) gives 240 curves.
     actual: Refused: 'This text would need 240 curves; one sketch edit takes at most 200.' TEXT_MAX_ENTITIES=200.
     where: stroke-text.ts TEXT_MAX_ENTITIES
     impact: Wide-letter labels over about 33 characters are refused for a limit that no longer exists.
  NEW [cosmetic] F12: Unit conversion dust in typed inch values
     repro: resolveDynamicEntry unit 'in', line length '3*2' (or '#2,3' y).
     actual: typed.length 152.39999999999998 (y 76.19999999999999) is stored as the driving dimension valueMm (point itself is cleaned).
     where: dynamic-entry.ts parseFieldEntry (value * 25.4)
     impact: Odd digits in stored dimensions and exports.
  NEW [cosmetic] F13: Misleading thousands-comma message
     repro: parseFieldEntry('1,5.5') and ('1.000,5').
     actual: 'Write 1,5.5 without the thousands comma: a comma here is a decimal comma' (tells the user to write what they typed).
     where: dynamic-entry.ts COMMA_AND_POINT message
     impact: Confusing error text for mixed separators.

TOTAL original-audit items: {"fixed":124,"still-failing":1,"partially-fixed":15,"cannot-recheck":1}
TOTAL first-reaudit items: {"fixed":56,"still-failing":0,"partially-fixed":6,"cannot-recheck":0}
NEW issues by severity: {"blocker":2,"major":23,"minor":31,"cosmetic":5}