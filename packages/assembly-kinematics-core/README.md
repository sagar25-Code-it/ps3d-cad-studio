# `@ps3d/assembly-kinematics-core`

Deterministic, kernel-neutral assembly semantics for PS3D. This package distinguishes reusable **component definitions** from positioned **occurrences** and consumes the stable IDs and rigid `Transform3` contract from `@ps3d/cad-document-core` through a type-only bridge.

## Qualified foundation

- Grounded occurrences and rigid groups.
- Joint origins expressed in occurrence-local coordinates.
- Rigid, revolute, slider, cylindrical, pin-slot, planar, and ball schemas.
- Limits, motion links, nominal degrees-of-freedom accounting, and deterministic dependency graphs.
- Analytic transform propagation for rigid, revolute, slider, and cylindrical joints.
- Closed-loop transform consistency checks using caller-defined tolerances.
- Exploded-representation interpolation with a caller-supplied envelope and a configurable envelope-fraction cap.
- Interference and clearance request/adapter contracts tied to qualified geometry handles and revisions.

## Deliberate boundaries

Pin-slot, planar, and ball semantics are stored and validated, but this package returns `UNSUPPORTED_JOINT_EVALUATION` rather than approximating their nonlinear solution. Closed-loop DOF is reported as nominal constraint counting; exact mobility requires a qualified constraint-Jacobian rank solver.

The package does **not** create collision geometry, bounding boxes, interference volumes, closest points, or clearance evidence. Those values must come from an exact B-rep or independently qualified collision adapter. Exploded-view bounds must likewise be measured upstream and supplied as an `AssemblyEnvelope`.

## Joint convention

Every joint has a first and second local origin. For the qualified subset, the target relation is:

```text
world(second origin) = world(first origin) * motion(local +Z)
```

- Revolute: rotation about joint-origin local +Z.
- Slider: translation along joint-origin local +Z.
- Cylindrical: both of the above.
- Rigid: identity motion.

At least one active occurrence must be grounded. The evaluator never chooses a hidden floating-frame anchor.

## Verification

```powershell
pnpm --filter @ps3d/assembly-kinematics-core typecheck
pnpm --filter @ps3d/assembly-kinematics-core test
```
