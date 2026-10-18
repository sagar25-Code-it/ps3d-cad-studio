# `@ps3d/parametric-sketch-core`

This package defines PS3D's additive, kernel-neutral parametric sketch contract.
It is intentionally independent of React, Three.js, storage, and the current
workbench preview model.

## Qualified analytic subset

- Persistent factories and runtime validation for points, lines, circles, arcs,
  ellipses, regular polygons, centerline slots, and non-rational B-splines.
- Construction flags and associative projected-source identity. Associative
  projected entities are read-only in this package and carry zero local DOF.
- Fixed, horizontal, vertical, coincident, concentric, midpoint, equal,
  parallel, perpendicular, and simple collinear relations for the compatible
  analytic line/point/circle/arc/ellipse subset.
- Driving/driven line length, linear, coordinate, radius, diameter, and
  line-to-line angle dimensions. A fixed endpoint is respected by moving the
  free side where a unique analytic result exists.
- Deterministic parameter expressions with numbers, identifiers, parentheses,
  unary signs, and `+ - * /` with standard precedence.
- Right-handed orthonormal plane validation, constraint-residual validation,
  immutable constrained drag previews with one revision advanced at commit,
  conflict/DOF diagnostics, and exact independent line/circle offsets.
- Schema and validation contracts for arcs, ellipses, splines, polygons, slots,
  tangent/symmetric constraints, trim, extend, and associative projection.
- Analytic tangency between a line and a circle/arc and between two
  circles/arcs (external or internal), and point symmetry mirrored about a
  line axis.

## Truthful boundary

The included analytic backend is a deterministic baseline, not a general
nonlinear geometric constraint solver. Unsupported relations return structured
`unsupported: true` diagnostics and remain preserved in the sketch document.
This includes point-on-curve coincidence, tangency or symmetry that involves
splines, ellipses, or other free-form curves, complex spline relations,
associative offsets, and topology-dependent trim/extend/project operations. The
package does not approximate these operations or report them as solved.
The `ParametricSketchSolver` interface allows a future WASM or native solver to
replace it without changing document persistence, feature references, MCP
receipts, or UI orchestration.

Run the focused tests with:

```powershell
pnpm --dir packages/parametric-sketch-core test
```
