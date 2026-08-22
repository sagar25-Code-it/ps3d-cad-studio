# Vehicle Engineering Preview Contract

**Status:** Original PS3D local preview implementation, geometry/analysis schema 2  
**Release meaning:** Transparent concept-study calculations and generic CAD
packages only; not a roadworthiness, homologation, fabrication, structural, or
safety approval

## Implemented scope

The Vehicle workspace is one canonical, revisioned engineering domain in the
shared PS3D project. It includes five independently authored generic starting
packages:

1. ICE road motorcycle: telescopic fork, rear swingarm, diamond/cradle frame;
2. step-through scooter: telescopic fork, rigid unit-swing powertrain,
   underbone frame;
3. EV street motorcycle: telescopic fork, rear swingarm, battery/motor package;
4. delta cargo three-wheeler: one front fork, paired rear trailing arms and
   rigid beam; and
5. tadpole three-wheeler: paired front double wishbones, uprights, steering
   rack/tie-rod packaging lines, and one rear swingarm.

They are not copies of PartMode, an OEM vehicle, or supplier CAD. Template
dimensions, masses, package envelopes, coefficients, and loads are illustrative
until the user replaces them with controlled evidence. Every template carries a
`DO NOT FABRICATE` boundary.

The canonical frame is right-handed: **+X forward, +Y vehicle-left, +Z up**.
Its origin is the rear design contact station, or the midpoint of the paired
rear contacts for a delta layout. Suspension states are chassis-fixed; the
displayed plane is the **design-ground reference**, so a contact may move above
or below it in bump or droop. SI values are canonical. The UI converts them to
engineering display units only at its boundary.

## Authoritative geometry graph

`solveVehicleGeometry()` produces one topology-specific graph of stable
hardpoints, rigid members, wheel poses, derived dimensions, and invariant
checks. The 3D scene, orthographic engineering view, audit table, analysis, and
tests all consume this graph; they do not redraw independent vehicle shapes.

- Telescopic front axles slide on the entered rake direction while preserving
  the normal fork offset from the steering axis.
- Rear single-track and delta axle centers move on a rigid arm/beam arc. A
  negative square-root domain is a blocking error rather than a clamped image.
- Shock lower eyes are transformed as arm-attached points. The scooter unit
  case and powertrain datum rotate with the unit swing.
- Tadpole front suspension uses separate left/right UCA and LCA chassis pivots,
  upper/lower ball joints, uprights, shock eyes, kingpin axes, steering arms,
  rack points, and wheel centers. Bump and droop solve a closed front-view chain
  with constant arm/upright lengths and mirrored geometry.
- Ideal inner/outer Ackermann angles and a user-entered target blend are
  reported. The current rack and tie rods are packaging lines; constant tie-rod
  length through steering, rack-travel solving, compliance, and bump-steer
  optimization remain unavailable.

Each solve reports finite-coordinate, stable-ID, design wheelbase/track,
design-contact-plane, fork-offset, rear-arm, and wishbone residual checks. The
workspace shows their measured value and requirement in a visible gate.
Paired-wheel track must exceed the corresponding tire width. Brake effective
radius must remain inside loaded tire radius, and each paired axle must declare
an equal whole-disc count per modeled wheel. PS3D has no implicit or floating
central-axle brake mechanism.

Legacy schema-1 vehicle records may omit only these geometry fields, which are
then restored from the selected PS3D template and force `inputStatus` back to
`illustrative-unvalidated`: `casterRad`, `kingpinInclinationRad`,
`scrubRadiusM`, `toeRad`, `ackermannPercent`,
`rearSwingarmPivotFromRearM`, `rearSwingarmPivotHeightM`,
`rearShockUpperFromRearM`, `rearShockUpperHeightM`, `rearShockArmRatio`,
`frontSuspensionInboardHalfTrackM`, `frontLowerArmHeightM`, and
`frontUpperArmHeightM`. Any other missing or unknown parameter fails closed.

## Transparent calculation screens

All results come directly from visible inputs and are truth-labeled as input,
derived, state, or screening values.

- **Motorcycle/delta fork trail:**
  `trail = (loadedRadius * sin(rake) - normalOffset) / cos(rake)`.
  This equation is not reused for the tadpole wishbone topology.
- **Axle loads:** grade-adjusted quasi-static longitudinal load transfer uses
  wheelbase, combined CG X/Z, mass, gravity, and acceleration. A negative
  normal reaction blocks the result.
- **Springs:** `wheelRate = springRate * motionRatio²`. The displayed frequency
  uses supported total axle mass and is explicitly a screen, not a measured
  sprung/unsprung modal result.
- **Hydraulic brakes:** line pressure is input force times lever ratio divided
  by master-cylinder area. Equivalent clamp area is entered per disc/caliper;
  pad coefficient, effective radius, disc count, and one circuit efficiency
  produce available torque. Efficiency is applied once.
- **Achieved braking:** the requested ground force is allocated only up to the
  hardware and simplified combined-tire capacities. The reported achieved
  deceleration cannot exceed requested demand. The first limiting category,
  axle loads, combined utilization, and constant-deceleration stopping distance
  are returned. A moving zero-deceleration case uses `null` for distance rather
  than a JSON-unsafe infinity; a stationary case returns zero.
- **Road load:** rolling, grade, and aerodynamic terms use constant entered
  coefficients. Rolling resistance is zero at a stationary level-road point.
- **Drive operating point:** source torque, total source-to-wheel reduction,
  efficiency, and driven rolling radius produce raw force. Iterated driven-axle
  load, the simplified combined-tire ellipse, and a front-lift screen limit the
  used force. Wheel RPM, source RPM, source power, and the first limit are
  visible.
- **EV energy:** usable battery energy divided by user-entered consumption is an
  assumption-only planning quotient, not a certified range.
- **Single-track lean:** steady lean is a reference only, not a transient
  stability solution.
- **Three-wheel support:** barycentric reactions on the triangular contact
  polygon provide a rigid quasi-static lift screen and approximate lateral
  threshold. Suspension roll, compliance, bumps, tyre transients, and tripped
  rollover are excluded.

## Deliberately unavailable

The preview is not a multibody dynamics solver, finite-element model, tyre
model, ABS/regen controller, brake fade/compliance test, structural fatigue or
crash analysis, thermal model, durability program, or homologation tool. It does
not include a full 3D rack/tie-rod steering closure, compliance steer,
high-fidelity bump steer, measured spring/damper curves, unsprung-mass modes,
road excitation, transient braking, or suspension roll.

The powertrain contract is one operating point. ICE gear/CVT maps, clutch
state, torque-speed/BSFC maps, motor peak/continuous envelopes, inverter and
battery current limits, SOC, auxiliaries, regen, drive cycles, thermal limits,
and sustained top-speed/gradeability are unavailable. A result must not be used
to fabricate or operate a vehicle without qualified engineering, controlled
component data, tests, applicable standards, and authority approval.

## MCP and Python boundary

`ps3d_analyze_vehicle` is read-only and model-neutral. Outer response schema
`ps3d-vehicle-mcp-analysis/2` contains nested
`ps3d-vehicle-analysis/2`, the selected topology/state, invariant results, and
explicit `regulatoryResult: false`, `constructionReady: false`, and
`roadworthinessApproved: false` labels. Structured `inputStatus`,
`tireDataStatus`, and `brakeDataStatus` fields accompany the result. Undefined
finite quantities use explicit `null`, never Infinity or NaN. It reads no file, applies no mutation,
discovers no credential, and contacts no network service. The Python client uses
the same JSON/MCP contract; it does not contain a separate hidden solver.

## Specialist review model

Five AI review lenses challenge the work: topology/kinematics, brakes/tyres and
dynamics, ICE/EV operating point, professional CAD UI, and quality/release
evidence. They are software review roles, not human hires. PS3D does not claim
that they hold a PhD, professional registration, or 30 years of employment.

## Research index

These primary, official, or open technical sources define vocabulary and the
verification boundary. Linking a source is not a compliance claim.

| Area | Source | Use in PS3D |
| --- | --- | --- |
| Road-vehicle dynamics frame | [ISO 8855](https://www.iso.org/standard/51180.html) | Coordinate and dynamics vocabulary |
| Motorcycle vocabulary | [ISO 11838](https://www.iso.org/standard/1518.html) | Kinematic terminology |
| Motorcycle dimensions | [ISO 9131](https://www.iso.org/standard/16727.html) | Steering/package terminology |
| Suspension hardpoint vocabulary | [Project Chrono wheeled suspensions](https://api.projectchrono.org/7.0.0/wheeled_suspension.html) | UCA/LCA/upright/tie-rod reference vocabulary |
| Motorcycle brake-system procedures | [NHTSA FMVSS 122 laboratory procedure](https://www.nhtsa.gov/document/laboratory-test-procedure-fmvss-122-motorcycle-brake-systems) | Test boundary; preview is not a test |
| International motorcycle braking | [UNECE Regulation No. 78 index](https://unece.org/transport/vehicle-regulations-wp29/standards/addenda-1958-agreement-regulations-61-80) | Regulatory boundary |
| Motorcycle tyres | [UNECE Regulation No. 75 index](https://unece.org/transport/vehicle-regulations-wp29/standards/addenda-1958-agreement-regulations-61-80) | Supplier/regulatory boundary |
| L-category EV safety | [UNECE Regulation No. 136](https://unece.org/sites/default/files/2025-03/R136r1e.pdf) | EV safety boundary |
| Vehicle road load | [40 CFR 1066.305](https://www.ecfr.gov/current/title-40/chapter-I/subchapter-U/part-1066/subpart-D/section-1066.305) | Road-load measurement boundary |
| Engine torque-speed mapping | [40 CFR 1065.510](https://www.ecfr.gov/current/title-40/chapter-I/subchapter-U/part-1065/subpart-F/section-1065.510) | Explains why one torque point is not a map |
| EV range testing | [US EPA range-testing overview](https://www.epa.gov/greenvehicles/fuel-economy-and-ev-range-testing) | Explains why the energy quotient is not certified range |
| Three-wheel steering study | [Mechanisms and Machine Science 13, 189–217 (2022)](https://ms.copernicus.org/articles/13/189/2022/) | Open steering/hardpoint research reference |

## Verification evidence

The dedicated vehicle browser-runtime gate currently covers six independent
test groups: all five templates and all three states; finite/unique/connected
geometry and bounds; independent brake/load/stopping/power equations; fork,
swingarm, wishbone, upright, symmetry, and unit-swing invariants; topology-
specific Ackermann/support screens; impossible-state rejection; revisioned
layer operations; and read-only MCP truth labels.

The broader browser-compatible application gate covers 70 deterministic tests.
The solid-kernel evidence suite is Node/CI-only and is deliberately excluded
from the browser gate rather than weakened or silently polyfilled. Replacement
screenshots are acceptable evidence only when the vehicle gate is fully green,
the visible invariant gate has no failed checks, and the shown topology matches
the selected template.
