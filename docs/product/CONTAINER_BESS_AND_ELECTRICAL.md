# Container, BESS, and Electrical Workflows

**Status:** Original local preview implementation  
**Release meaning:** Planning and schematic intent only; not certified, not for
construction, and not a substitute for manufacturer data or licensed
engineering.

## Implemented result

PS3D now has three deterministic assembly generators and three deterministic
electrical generators. All output remains editable through the same revisioned
project and operation/MCP boundary used by the other workspaces.

### Assembly generators

| Template | Nominal external envelope | Generated content |
| --- | ---: | --- |
| 20 ft cargo planning frame | 6,058 × 2,438 × 2,591 mm | Floor/roof planning panels, corner posts, side rails, end headers/sills, door leaves, fixed layout records |
| 40 ft high-cube planning frame | 12,192 × 2,438 × 2,896 mm | Same original editable planning structure at the high-cube envelope |
| 20 ft high-cube BESS arrangement | 6,058 × 2,438 × 2,896 mm | Planning frame, eight battery racks, PCS, AC switchgear, DC combiner/disconnect, HVAC, fire-interface placeholder, auxiliary panel, cable tray, and hidden service-aisle keep-clear volume |

ISO 668 establishes Series 1 freight-container classification and external
dimensions. The dimensions above are nominal external figures corroborated by
an official carrier specification; production tolerances and the selected
manufacturer's data remain authoritative. PS3D does not reproduce a detailed
ISO corner fitting, structural rating, door design, or certified container.

- ISO 668 catalog: <https://www.iso.org/standard/76912.html>
- ISO freight-container sector: <https://www.iso.org/sectors/transport/freight-containers>
- Hapag-Lloyd container specification: <https://www.hapag-lloyd.com/content/dam/website/downloads/pdf/17038_Update_Container_Specification_engl_sRGB.pdf>

The BESS layout is deliberately an arrangement study. NFPA 855 addresses ESS
installation lifecycle and fire-safety topics; UL 9540 covers ESS product
safety and UL 9540A provides a thermal-runaway/fire-propagation test method.
PS3D cannot infer compliance from geometry and never labels the generated
layout as NFPA/UL compliant.

- NFPA 855 official publication: <https://link.nfpa.org/all-publications/855/2023>
- UL explanation of UL 9540, UL 9540A, and NFPA 855 roles: <https://www.ul.com/thecodeauthority/knowledge/understanding-UL-9540A-NFPA-855>
- UL 9540A test method: <https://www.ul.com/services/ul-9540a-test-method>

Required project work outside the generator includes cell/module/rack data,
listings, fire-test evidence, thermal and gas analysis, structural design,
lifting/transport ratings, egress, separation, access, ventilation, detection
and suppression, cable/grounding/protection design, AHJ review, and permit or
construction release.

## Electrical workspace

The Electrical workspace adds an original vector schematic language with:

- battery, fuse, disconnect, breaker, contactor, inverter/PCS, transformer,
  motor, load, sensor, HVAC, terminal, and protective-earth symbols;
- stable reference designators, values, declared terminals, and XY positions;
- explicit pin-to-pin AC power, DC power, control, and ground nets;
- automatic BESS single-line, DC auxiliary, and direct-on-line motor-starter
  concepts;
- live electrical rule checks for duplicate references, broken component or
  terminal references, open terminals, protective-device presence, and ground
  reference presence;
- a deterministic concept device index/BOM and downloadable SVG sheet; and
- IEC or ANSI drafting-basis metadata with explicit notice that the icon set is
  original PS3D preview artwork, not a claimed certified symbol library.

The data model follows public professional ECAD behavior: components expose
connectable pins/terminals, wires form named nets, libraries separate logical
representation from later physical implementation, and ERC checks connectivity
before downstream use. These behaviors were learned from official Autodesk
documentation without copying vendor source, artwork, libraries, templates, or
wording.

- Autodesk schematic wiring and nets: <https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-TUT-SCHEMATIC-3.htm>
- Autodesk Schematic Editor command reference: <https://help.autodesk.com/view/fusion360/ENU/?guid=ECD-SCHEMATIC-ED-CMDS-REF>
- Autodesk electronics libraries: <https://help.autodesk.com/view/fusion360/ENU/?contextId=ECD-LIBRARIES>
- Autodesk ERC: <https://help.autodesk.com/view/fusion360/ENU/?guid=ECD-CLI-E>
- Autodesk BOM behavior: <https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-BOM-CPT.htm>

## Explicit electrical exclusions

The current preview does not calculate or approve conductor ampacity, voltage
drop, short-circuit duty, breaker/fuse ratings, selectivity, relay settings,
arc-flash incident energy, grounding/bonding, load flow, harmonics, thermal
performance, functional safety, controls philosophy, machinery safety,
utility interconnection, code compliance, field wiring, or construction
release. Those commands remain cataloged as unavailable.

## Persistence and MCP operations

Older schema-1 projects without an `electrical` field migrate locally to the
default conceptual single-line. New canonical operations are:

- `apply-assembly-template`;
- `apply-electrical-template` and `set-electrical-standard`;
- `add-electrical-component` and `delete-electrical-component`;
- `set-electrical-component-position`;
- `add-electrical-net` and `delete-electrical-net`; and
- `set-electrical-notes`; and
- `generate-electromechanical-realization` with a pinned catalog revision,
  deterministic layout preset, explicit device mappings, and replace mode.

They receive the same revision conflict, exact idempotency, bounded validation,
preview-receipt, and return-new-project behavior as existing MCP edits.

## Verification evidence

The current no-subprocess in-browser runner passed **51/51** selected typed
cases after the wired-panel delta. Earlier 42/42, 31/31, and 48/48 runs are
historical evidence for their recorded revisions. The current run covers the
existing workbench core, assembly/surface geometry, drawing output, nominal
container envelopes, BESS content/boundaries, electrical endpoint validity,
XML escaping, ERC behavior, revisioned operations, schema migration, generic
catalog coverage, exact terminal sets and electrical roles, direct self-short
rejection, deterministic one-plate/rail/duct/PE/standoff realization,
terminal-to-duct conductor paths, stale-link completeness,
rotation/text-footprint-aware panel avoidance, ellipsized and width-constrained
on-sheet labels with full title data, shared core/UI/MCP route feasibility,
outward terminal escape portals, occupied-segment separation between distinct
nets, routing around panels and unrelated component footprints, fail-closed
blocked-route ERC, capped route-corridor search, a deterministic 250,000
obstacle-check work budget with affected-net diagnostics, route-plan reuse,
lazy review-only 3D candidate generation, a 100-component/200-net completion
guard, explicit partial-table disclosure with complete SVG metadata,
protected exact component/mate/infrastructure sets and safety metadata,
collision-resistant generated IDs,
rotated assembly bounds, the electrical sheet-coordinate envelope, zero seeded
BESS AABB conflicts, and the dedicated MCP disclosure/receipt boundary.

Screenshots:

- `docs/screenshots/29-bess-container-arrangement.jpg`
- `docs/screenshots/30-cargo-container-template.jpg`
- `docs/screenshots/31-electrical-schematic-workspace.jpg`
- `docs/screenshots/32-professional-electrical-workspace.jpg`
- `docs/screenshots/33-circuit-to-3d-review.jpg`
- `docs/screenshots/34-linked-electromechanical-assembly.jpg`
- `docs/screenshots/35-reviewed-circuit-to-3d-dialog.jpg`
- `docs/screenshots/36-linked-electromechanical-current.jpg`
- `docs/screenshots/37-cross-probed-electrical-device.jpg`

The linked output is a catalog-backed wired mounting-plate preview with
panel-scale generic proxies and unsized conductor visualization, not
manufacturer geometry or an engineered cable/harness design. See
`docs/product/ELECTROMECHANICAL_REALIZATION.md` for the complete boundary.
