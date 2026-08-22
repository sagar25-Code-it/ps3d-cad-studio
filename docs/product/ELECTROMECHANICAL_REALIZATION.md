# Electromechanical Realization Contract

**Status:** Original local preview implementation  
**Release meaning:** Generic concept layout and traceability only; not a
manufacturer model, engineered wiring design, or construction deliverable

## Implemented result

PS3D can review a canonical electrical schematic and generate one linked,
revisioned Assembly concept. The pipeline is deterministic and local:

1. validate components, terminals, nets, and sheet coordinates;
2. run structural ERC and expose every warning or error;
3. resolve each supported device kind against the pinned
   `ps3d-generic-panel/2` catalog;
4. create exactly one 1400 × 900 × 260 mm mounting-plate envelope with
   deterministic DIN rails, slotted wire ducts, a PE bar, and standoffs;
5. place panel-scale generic device/interface packages and map their schematic
   terminals through one rotation-aware local-to-world transform;
6. derive bounded unsized orthogonal conductor paths that leave each terminal,
   enter the nearest horizontal duct, use alternating vertical trunks, and
   emerge only at the destination;
7. show the exact replacement scope and require explicit acknowledgement; and
8. apply the candidate as one undoable engineering revision.

ERC errors block generation. ERC warnings require acknowledgement and remain
visible. Repeating the same reviewed operation replaces the generated
electromechanical subset instead of accumulating duplicate packages.

## Original generic catalog

The repository-owned panel-scale catalog covers the schematic kinds currently exposed by
the component library: battery, fuse, disconnect, breaker, contactor,
inverter/PCS, transformer, motor, load, sensor, HVAC, terminal, and protective
earth. Each record contains a stable catalog ID, generic box or cylinder
envelope, dimensions, mounting class, display color, and named local terminal
coordinates and explicit electrical roles such as positive, negative, AC,
signal, protective earth, line, and load. Readiness and canonical validation
require each device to declare the exact catalog terminal set, reject direct
same-device self-shorts, and reject terminal-role/net-class mismatches.

Large field equipment is represented only by explicitly named interface/package
proxies; a battery field-interface module is not a battery rack and a PCS
controller/field interface is not a manufacturer PCS enclosure. Renderer-derived
faceplates, operators, status windows, terminal studs, DIN-rail flanges, duct
slots, and PE-bar screws add recognizable bounded detail without consuming
canonical component, mate, or audit-ID budgets.

These records are synthetic panel packages. They do not identify a vendor,
part number, rating, certification, connector, keep-out zone, mass, thermal
model, mounting-hole pattern, or procurement item. Replacing them with real
equipment requires authorized manufacturer data and a separately reviewed
catalog-ingestion contract.

## Canonical trace model

Generation retains the source schematic and adds explicit derived records:

- one source record with schematic ID, source revision, source signature,
  catalog revision, layout preset, and current/stale status;
- one device link per mapped schematic component, identifying its generated
  body and terminal mapping;
- one mounting plate plus the exact deterministic rail, duct, bonding, and
  standoff infrastructure set; and
- one conductor visualization per routable net, with terminal endpoints and the complete
  orthogonal point path.

A link is `current` only when the source ID, source project revision, complete
source signature (including engineering notes), catalog IDs, every component
ID/name, shape, size, transform, color, grounded/visible state, explosion
direction, identity terminal mapping, fixed mate, infrastructure body, and
conductor point still match regeneration from the canonical
electrical intent. Editing the source schematic, moving a linked package, or
altering generated geometry makes the realization stale. Historical stale
revisions remain valid audit evidence only when their retained links, complete
terminal maps, route endpoints, and non-future source revision are internally
consistent with the current pinned catalog. Legacy `ps3d-generic-em/1` records
and records missing explicit source ID/revision normalize to stale; they are
never silently reinterpreted as the new panel geometry. A future catalog needs an explicit
registry and migration decision; stale records are not silently accepted
against an unknown catalog.

A current realization also retains the exact generated fixed mates, template,
nominal envelope, design status, and non-construction safety notes. Removing or
altering those records invalidates the `current` claim instead of hiding the
safety boundary behind an apparently valid ECAD↔MCAD trace.

Linked generated packages cannot be deleted individually because that would
silently break cross-domain traceability. The user can regenerate the whole
reviewed subset or undo the generating revision. Selecting a linked package can
open its exact source device in Electrical without creating a revision.

## UI review and safety boundary

Electrical exposes component and net trees, ERC status, mapping coverage, and
a `Review wired panel candidate` action. The shared dialog reports every
body, mate, conductor, link, source mapping, position, and ERC finding and includes
complete JSON snapshots of both the removed and generated Assembly values. Its
visible header close control receives initial keyboard focus; focus stays inside
the dialog, global workspace shortcuts are isolated, Escape cancels, and focus
returns to the invoking control or active workspace tab.

Assembly exposes generated packages and installation hardware, source/link
status, cross-probe actions, conductor count, and conservative AABB candidates.
Solid tube geometry visualizes current conductor paths; stale paths become
dashed warning guides. Conductor radius and color are visualization only, not
wire gauge, ampacity, or IEC/NEC/project insulation-color assignments. The
scene and inspector carry a visible boundary: the geometry is not for construction, fabrication,
procurement, energization, regulatory approval, or safety approval.

## MCP and Python contract

The project-wide stateless local MCP server exposes ten tools:

- `ps3d_guide`;
- `ps3d_find_commands`;
- `ps3d_capabilities`;
- `ps3d_inspect_project`;
- `ps3d_design_health`;
- `ps3d_analyze_vehicle`;
- `ps3d_electromechanical_catalog`;
- `ps3d_preview_electromechanical`;
- `ps3d_preview_operation`; and
- `ps3d_apply_preview`.

Circuit-to-wired-panel preview runs canonical ERC, blocks errors, and returns the exact
operation, full candidate Assembly, complete ERC issue list, complete removal
scope including the full prior Assembly/route/link/source snapshot, and a
dedicated SHA-256 disclosure receipt. The generic operation preview
rejects this operation so it cannot bypass the dedicated disclosure domain.
Apply requires the matching project, operation, receipt, and `confirmed: true`,
then returns a new project. The server does not read files,
write external state, inspect credentials, use the network, or control a live
browser. The confirmation flag is a host assertion, not proof that a person
reviewed the candidate.

The standard-library Python client provides typed convenience methods for all
ten tools, negotiates modern discovery with legacy fallback, and launches only
an explicitly supplied local stdio argv with
`shell=False`. Caller-supplied environment variables are filtered through an
explicit allowlist before launch. A real stdio rerun remains restricted to a personal or
IT-approved development/CI environment on this project.

The in-app Automate console renders the complete immutable dedicated result and
does not retain or submit an electromechanical confirmation receipt. It routes
the user to the same exact replacement dialog used by Electrical; only generic
operations can use the console's visible-preview apply flow. External calls
remain detached from the live browser project.

## Explicit exclusions

This preview does not perform conductor or cable sizing, voltage-drop or fault
calculation, protection coordination, arc-flash analysis, load flow, thermal
design, clearance checking, EMC analysis, harness construction, grounding or
bonding design, functional-safety validation, code compliance, vendor selection,
BOM costing, fabrication release, commissioning, or energization approval.
Remote authenticated MCP and live-session browser control are also unavailable.

The deterministic panel preset intentionally fails closed above **16 mapped
devices** or **8 routable conductor paths**. Within that supported envelope,
each path receives a separate 14 mm Z lane above the duct keep-out, solid route
branches are rendered once from deduplicated segments, and terminal/face detail
is retained ahead of decoration. These are visualization clearances, not an
electrical spacing, duct-fill, or thermal-design calculation.

## Verification evidence

The current no-subprocess browser-safe run passed **51/51** selected typed cases
after the wired-panel delta. Earlier 42/42, 31/31, and 48/48 runs remain
historical evidence for their recorded revisions. The current electromechanical
cases cover catalog coverage, stable terminal mapping, deterministic generation,
one plate with exact rail/duct/PE/standoff infrastructure, rotation-aware
terminal-world transforms, panel-scale package geometry, renderer-derived detail
budgets, polarity-map integrity, exact terminal-set and terminal-role
enforcement, direct self-short rejection, complete in-envelope orthogonal
conductor-path integrity, source identity/signature staleness,
stale-link internal completeness, reserved symbol/label sheet footprints,
rotation-aware panel avoidance, ellipsized and width-constrained on-sheet text
with complete title data, shared core/UI/MCP route feasibility, outward terminal
escape portals, occupied-segment separation between distinct nets, orthogonal
routing around panels and unrelated component footprints, fail-closed
blocked-route ERC, capped corridor search, a deterministic 250,000
obstacle-check budget with affected-net diagnostics, route-plan reuse, deferred
review-only 3D candidate generation, a 100-component/200-net completion guard,
complete SVG BOM/ERC overflow metadata, protected exact component/mate/
infrastructure sets and safety metadata, collision-resistant IDs,
linked-package edit behavior, electrical sheet bounds,
rotated assembly AABBs, seeded BESS interference expectations, and the dedicated
MCP disclosure/receipt path.

The current review sequence is recorded in:

- `docs/screenshots/35-reviewed-circuit-to-3d-dialog.jpg`;
- `docs/screenshots/36-linked-electromechanical-current.jpg`; and
- `docs/screenshots/37-cross-probed-electrical-device.jpg`.

The larger typed suite contains 76 authored cases, but a clean typecheck, full
suite, production build, real stdio exchange, and accessibility/security matrix
must run in an approved environment before publication.
