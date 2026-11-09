# Sketch solver notes

How the sketch solver works after the simultaneous-solver rewrite, and how to use the constraint and dimension kinds it adds. For the people who write shape-building tools (polygon, slot, rounded rectangle, patterns) and for anyone reading the analysis result.

## What changed

`solveAnalyticSketch` (packages/parametric-sketch-core/src/solver.ts) used to apply one relation at a time, at most 8 passes. It is now a simultaneous solver:

- **equation-model.ts** turns the document into one flat vector of numbers (every coordinate, radius and angle) and one residual function per relation. A fixed curve (or fixed point) is removed from the unknowns.
- **lm-solver.ts** is a damped Gauss-Newton / Levenberg-Marquardt solve over all residuals at once. Each step is the weighted least-norm correction, so geometry the relations do not force to move stays where it is. Deterministic: no randomness, ties break by index. Groups of relations that share no unknown are solved separately.
- **rank-analysis.ts** computes the degrees of freedom as `free variables - rank(Jacobian)`, finds relations that the earlier ones imply, and names them.
- **linear-algebra.ts** holds the sparse pieces (reverse Cuthill-McKee ordering with a skyline Cholesky, and an incremental sparse row elimination that also gives the exact set of rows a dependent row is a combination of).
- **default-anchors.ts** says who gives way when the caller gives no hints (the geometry a relation names first is the reference).

In the workbench, `packages/workbench-core/src/sketch-translate.ts` turns the live sketch into the document and back (and builds the names), `sketch-anchors.ts` says who gives way for each operation, `sketch-solve.ts` is `solveLiveSketch` / `dragLiveSketch`, `sketch-analysis.ts` is the rank analysis for the live sketch, and `sketch-dimension-edit.ts` is `set-sketch-dimension`.

Performance (measured on a development laptop, Node 24, a warm second run; the first call of a session is slower while the code compiles). These are the numbers the regression tests bound generously:

| sketch | solve | analyse | one dimension edit | one drag step |
| --- | --- | --- | --- | --- |
| 100 tangent circles with tangent lines, all equal to the first (200 curves, 399 relations) | 40 ms | 20 ms | 0.2 s | 60 ms |
| 250 of them (500 curves, 999 relations) | 80 ms | 70 ms | 0.4 to 0.8 s | 130 ms |
| 500 lines all equal to the first (499 relations) | 250 ms | 220 ms | 0.25 s | 0.2 s |
| a 330-line joined horizontal/vertical chain | 35 ms | 10 ms | 0.1 s | 60 ms |
| 125 joined rectangles, 500 lines, 1374 relations | 100 ms | 50 ms | 10 ms | 140 ms |

Earlier builds took 3.4 s (150 circles) and 12 s (250 circles) for the edit and 9.5 s for the drag, because every Levenberg-Marquardt step factored a dense matrix whose cost grew with the cube of a coupled chain. Now: the normal equations of each independent component are solved with a sparse minimum-degree LDL factorisation (`sparse-ldl.ts`), so a hub that many relations share (every circle equal to the first) costs a few elimination steps instead of a dense factorisation; row damping is relative to the row, so a long chain does not need ever more damping; a step that no longer improves ends the iteration early; and the rank analysis skips its support tracking when the relations are independent. The cost is still superlinear in the size of one coupled component (the 250-circle edit is about five times the 100-circle one), but a 500-curve sketch edits in well under a second.

## Behaviour you can rely on

- **Minimum movement.** Untouched geometry does not move. Of the ways to meet a relation the solver takes the one that moves the least (sizes are stiffer than positions, so a circle is slid before it is resized).
- **Fixed never moves.** `fixed` (whole curve, or one point with `points`) removes those numbers from the unknowns. A dimension that contradicts a Fix is refused, and the message names both.
- **Driven (reference) dimensions never move geometry.** They are measured.
- **Dimensions are equations.** A stale dimension (a radius that says 7 on a circle that is 6) snaps the geometry to the dimension when solved or restored, like a line length always did. Rectangle width and height are enforced on restore and on drag.
- **No sign flips.** Line length, signed point-to-line distance, tangency type (outside or inside) and point-to-point direction are kept from the geometry as it is when the solve starts, so lengthening a joined line slides its neighbour instead of folding it back.
- **Editing either entity of an equal or symmetric pair works.** Which of the two is edited does not matter for the result.
- **Order of adding relations.** Every relation is solved from where the previous one left the geometry and moves it as little as it can, so adding the same relations in another order gives geometry that satisfies all of them, with the same degrees of freedom and the same classification, but not necessarily the same coordinates (three test sketches gave 8 to 17 different valid results out of 20 orders, up to about 5 mm apart). What is guaranteed: the same sketch and the same operation always give exactly the same result (no randomness, ties break by index), the result satisfies every relation, and solving it again moves nothing. If a design must come out the same however it was built, state its size with dimensions or Fix instead of relying on the starting positions.
- **Failures name relations.** A solve that cannot hold returns a `CONSTRAINT_CONFLICT` (or `DIMENSION_CONFLICT`, `DRAG_CONFLICT`) whose message lists the relations by name ("Length 20 on Line 1, Length 30 on Line 2 and Equal between Line 1 and Line 2 contradict each other") and whose `relatedIds` are the constraint IDs (not the document ID). A solution that squashes a curve to nothing is reported the same way ("Line 1 would collapse to a point...").
- **Drag.** The dragged point (a line end, a centre, a rectangle corner, a line midpoint for a body drag) is held exactly under the pointer and everything else relaxes around it. If a dimension makes that impossible the point goes as near as the relations allow.

## Entity names and relation labels

`entityNames(sketch)` gives "Line 2", "Circle 1" (position among entities of the same kind, in sketch order); the origin and axes are "the origin", "the X axis", "the Y axis". `describeConstraint(constraint, names)` gives labels such as "Horizontal on Line 2", "Length 40 on Line 1", "Coincident: Line 1 end and Line 2 start", "Radius 6 on Circle 1", "Angle 60° between Line 1 and Line 2". A relation that is several solver relations (a mirror pair) has IDs `constraint:id#start`, `#end`, `#centre`, `#radius`; `liveConstraintId()` strips the suffix.

## Constraint kinds and payloads

All are `WorkbenchSketchConstraint` records (`kind`, `entityIds`, optional `points`, `valueMm` / `valueDeg`, `dimension`, `driven`, `expression`, `suppressed`). The rule table is `constraintFit(kind, kinds, points, { driven, dimension })`; `add-sketch-constraint` refuses what it rejects, with its reason.

| kind | entityIds | points | notes |
| --- | --- | --- | --- |
| `horizontal`, `vertical` | line, or rectangle | | a rectangle is turned to a multiple of 90° |
| `parallel`, `perpendicular`, `collinear` | line or axis, line or axis | | two different curves, not two axes |
| `tangent` | line or axis with circle or arc, or two circles/arcs | | outside or inside tangency is kept as it is |
| `concentric` | two of circle, arc, ellipse, rectangle | | centres coincide |
| `equal` | two lines; two circles/arcs; two ellipses; two rectangles | | ellipses: both radii; rectangles: width and height |
| `midpoint` | point owner, line | `[ref]` | |
| `symmetry` | two lines / circles / points, then a line or axis | | |
| `coincident` | two entities | `[refA, refB]` | joins two points. **A `curve` ref makes it point-on-curve** (see below) |
| `fixed` | one or more entities | optional, one ref per entity | no `points`: the whole curve; with `points`: only that point |
| `smooth`, `pierce`, `refraction` | unchanged | | solved after the main pass |

### Point references (`points`)

`start`, `end`, `mid` (line midpoint; an arc's midpoint is its `mid`), `center` (circle, arc, ellipse, rectangle), `self` (a point entity, or the origin), `corner-0` to `corner-3` (rectangle corners, counter-clockwise from the lower left of the rectangle's own frame), `curve` ("anywhere on this curve"). `SOLVABLE_POINT_REFS` lists which refs each entity kind has:

```
line      start end mid          arc       center start end mid
circle    center                 ellipse   center
point     self                   rectangle center corner-0..corner-3
origin    self                   axis      (curve only)
```

Arc ends are real: join a line end to an arc end with `coincident` and hold the join tangent with `tangent`; editing the line moves the arc end with it.

### The origin and the axes

Three reserved IDs can be used anywhere an entity ID is accepted in a constraint or a point dimension. They never move and are never in `sketch.entities`:

- `sketch:origin` is a point: use ref `self`.
- `sketch:axis-x` and `sketch:axis-y` are infinite lines: use ref `curve` in a coincident (point on the axis), or name them as a line in parallel / perpendicular / collinear / tangent / symmetry / angle.

```ts
{ id, kind: "coincident", entityIds: ["sketch:origin", "entity:a"], points: ["self", "start"] }   // a line start on the origin
{ id, kind: "coincident", entityIds: ["entity:p", "sketch:axis-x"], points: ["self", "curve"] }   // a point on the X axis
{ id, kind: "symmetry", entityIds: ["entity:a", "entity:b", "sketch:axis-y"] }                    // mirror about the Y axis
```

(`sketch:origin`, `sketch:axis-x`, `sketch:axis-y` are exported as `SKETCH_ORIGIN_ID`, `SKETCH_AXIS_X_ID`, `SKETCH_AXIS_Y_ID`.)

### Point on curve

`coincident` with `curve` as the second (or first) ref: `{ kind: "coincident", entityIds: ["entity:p", "entity:circle"], points: ["self", "curve"] }`. Supported curves: line (its infinite extension), circle, arc (its circle), ellipse, and the two axes. The point may be any solvable point ref, including an arc end or a rectangle corner.

## Dimensions

Stored as constraints of kind `radius`, `distance`, `angle`, `arc-length` or `perimeter`. `set-sketch-dimension` creates or updates one: `{ entityId, dimension, valueMm, secondEntityId?, points?, driven?, expression? }` (the value is in degrees for an angle).

| `dimension` | constraint kind and `dimension` field | entities | points |
| --- | --- | --- | --- |
| `length` | `distance` / `length` | one line | |
| `width`, `height` | `distance` | one rectangle | |
| `radius` | `radius` / `radius` | circle or arc | |
| `diameter` | `radius` / `diameter` (`valueMm` is the diameter) | circle or arc | |
| `major-radius`, `minor-radius` | `radius` | one ellipse | |
| `angle` | `angle` (`valueDeg`) | two lines (or a line and an axis); **one ellipse = its rotation from +X** | |
| `arc-length` | `arc-length` | one arc | |
| `perimeter` | `perimeter` | circle, rectangle or ellipse | |
| `aligned`, `horizontal`, `vertical` | `distance` | two entities (the first may be `sketch:origin`) | one ref per entity |
| `point-line` | `distance` | a point owner, then a line or axis | `[ref]` for the first |
| `line-line` | `distance` | two lines | |

A distance between points may be 0. Horizontal / vertical keep their sign from the geometry (which side the second point is on). `point-line` keeps the side; `line-line` is the distance from the first line to the midpoint of the second. The second entity of a point-to-point distance is the one that moves; the first is the reference.

**Expressions.** Any driving dimension accepts `expression`, evaluated against the parameter table (`set-design-parameters`). An angle takes degrees (a plain number, `35 deg` or `0.5 rad`); lengths take mm. Changing a parameter re-drives the dimension and the sketch follows (a relaxed dimension takes the new number but stays relaxed).

**Relaxed dimensions.** Setting the value of a relaxed (suppressed) dimension updates its value and keeps it relaxed; the summary says so. Restoring it enforces the value.

## Degrees of freedom and diagnostics

`analyzeWorkbenchSketch(sketch)` returns, besides the old fields:

```ts
degreesOfFreedom   // free variables - rank; a duplicate relation removes nothing, an unenforced one removes nothing
entityFreedom      // per entity: independent ways it can still move or change shape (others free to follow)
rank               // rank of the relation Jacobian
redundant          // [{ constraintIds, labels, message, impliedConstraintId }]  consistent but dependent
conflictSets       // [{ constraintIds, labels, message }]  contradicting at the stored geometry
conflicts          // plain-language strings (the fit problems, plus the conflict set messages)
classification     // "fully-constrained" only when degreesOfFreedom is 0 and the sketch has geometry
```

A line-built rectangle with only a width and a height and no position fix reports 2 (translation). An arc is 5, an ellipse 5, a rectangle entity 5, a circle 3, a point 2, a line 4. An empty sketch is not fully constrained. `redundant[i].impliedConstraintId` is the relation made last that the others already imply (the one to delete); the Check Sketch panel offers to delete or relax it.

The core result (`SketchSolveResult.dof`) carries the same data: `total`, `byEntity`, `unconstrainedEntityIds`, `rank`, `variables`, `relationSets`, `redundantIds`, `conflictingIds`, and `method: "jacobian-rank-v2"`.

## Telling the solver who gives way (`LiveAnchor`)

`SolveAnchor` / `LiveAnchor` hints decide which geometry moves when a relation can be met several ways; they never change what is satisfied. `priority` 2 holds almost rigidly, 1 moves only if it must, 0 resets to free; later entries override earlier ones. `sketch-anchors.ts` has the rule for each constraint and dimension (the curve picked first is the reference; a line turns about its start; a circle is resized before it is moved; the edited dimension's curve keeps its place and its neighbours follow). `preserve` names lines whose length must survive being turned (the second line of a parallel / perpendicular / collinear / angle). Lines joined to others at both ends are weakly kept at their length so a chain moves rather than stretches. If the hints cannot be honoured the solver retries with fewer.

## For shape-building tools (wave 2)

The shapes can now emit relations that make the whole shape edit and drag:

- **Rounded rectangle and slot:** join each line end to the arc end beside it (`coincident` with `points: ["end", "start"]` between a line and an arc), keep the `tangent` pairs, and the equal radii. Editing one side then moves the arc ends with it and the profile stays closed.
  (Done in `shapes.ts` / `basic-curve-shapes.ts` through `joinRing`: slot, rounded rectangle and arc slot all carry the joints.)
- **Regular polygon** (`regular-polygon.ts`): n lines joined end to end, a construction circle, every corner `coincident` with the circle's `curve`, every side `equal` to the first. Four degrees of freedom (centre, size, turn), three once the one size dimension is set; the shape also returns `sizeDimension` for it: a `radius` on the circle (inscribed, the default), a `point-line` distance from the circle's `center` to the first side (circumscribed, the apothem) or a `length` of the first side (edge mode). Editing the length of any side scales the polygon about its centre (`anchorsAfterResize` in `sketch-anchors.ts`).
- **Joining a rectangle corner or an arc end:** the follower is carried by sliding the whole curve (only its centre is free), so a join never stretches, turns or re-radii it.
- **Locate a shape:** `coincident` with `sketch:origin`, or `distance` dimensions with `horizontal` / `vertical` from `sketch:origin`, instead of fixing a whole curve.
- **A rectangle drawn as lines:** four `coincident` joints, `horizontal` / `vertical` on the sides, and `lengthDim`s; with a corner on the origin it is fully constrained (0 degrees of freedom).
- **A hole in a plate:** `coincident` between the hole's `center` and the plate's `center` (a rectangle entity), plus a radius or diameter.

## Limits

- The solver finds the solution nearest to where the geometry is; it does not search for other branches. A relation set whose only solutions are degenerate (a circle between two lines that cross at its centre) is reported as a conflict naming the relations, even if a different starting position would have a solution.
- Point on curve uses the infinite extension of a line and the full circle of an arc; it does not keep the point inside the segment or arc span.
- Splines take part only through Fix, Smooth, and the degrees-of-freedom count.
- Not built: tangent and coincident handling for splines, rectangle symmetry, equal between a circle and an ellipse, sweep/loft interactions.
