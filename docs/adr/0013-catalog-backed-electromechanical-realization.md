# ADR 0013: Catalog-Backed Electromechanical Realization

## Status

Accepted for the local preview on 2026-08-20.

## Context

PS3D needs a useful bridge from electrical connectivity intent to spatial CAD
without implying that an AI model, schematic symbol, or generic library can
invent manufacturer geometry, ratings, cable design, compliance, or release
authority. The bridge must preserve the source schematic, use the existing
revision/receipt boundary, remain deterministic, and be controllable by any MCP
host without granting that host hidden file or browser access.

## Decision

1. Keep Electrical intent authoritative and generate only a linked Assembly
   concept from it.
2. Resolve supported devices against the repository-owned,
   `ps3d-generic-panel/2` catalog of original panel-scale generic packages and
   rotation-aware named local terminal coordinates. Label large field equipment
   as interface/package proxies.
3. Use one deterministic mounting-plate preset: exactly one plate plus bounded
   DIN rails, wire ducts, a PE bar, and standoffs. Route unsized orthogonal
   conductor visualizations through the declared duct/trunk corridors. Store
   the complete reviewed result, not a loose visual association.
   Fail closed above 16 mapped devices or 8 routable conductor paths. Within
   that supported envelope, allocate one 14 mm Z lane per path above the duct
   keep-out and deduplicate undirected branch segments before solid rendering.
4. Record source signature, catalog revision, exact device/infrastructure body
   IDs, identity terminal maps, fixed mates, conductor points, and current/stale
   status in canonical intent. Keep cosmetic face/terminal/duct detail
   renderer-derived and capped so it cannot exhaust component or audit limits;
   preserve terminal studs and primary device faces before decorative details.
5. Validate a current realization by regenerating every deterministic property.
   Reject added or altered current components, mates, routes, links, visibility,
   colors, transforms, or safety fields. Allow historical stale revisions only when retained links, exact terminal
   maps, routes, source identity/revision, and the current pinned catalog remain
   internally consistent; never mislabel them as current. Treat a new catalog
   revision as a separate registry/migration decision rather than silently
   accepting old derived records. Normalize `ps3d-generic-em/1` records to
   visibly stale evidence.
6. Replace the generated subset atomically after an exact UI or MCP preview.
   Block ERC errors, require acknowledgement for warnings, and require a matching
   receipt plus explicit confirmation before MCP apply.
7. Make cross-probing selection-only and revision-neutral. Prevent isolated
   deletion of linked packages; source or placement edits stale the realization.
8. Keep MCP stateless and model-neutral. It returns operations and new project
   values; it does not control the browser, discover files, or access secrets.
9. Treat sheet symbols, ellipsized and width-constrained display labels, and
   fixed drawing panels as physical 2D footprints while retaining full text in
   the SVG title and inspector. Constrain placement by the rotated footprint;
   escape each pin outward before entering the orthogonal sheet router; reserve
   prior net segments and labels; route around panels and every unrelated
    component footprint; enforce the same route plan in UI, core generation, and
    MCP preview/apply; and emit an ERC error instead of a false wire when no clear
    route exists. Bound primary/extended corridor sets to 48/24 candidates and
    every plan to 250,000 obstacle checks; identify every budget-affected net and
    fail it closed. Reuse the plan through render/ERC/readiness and defer the 3D
    candidate until exact review. Disclose visible BOM/ERC truncation and retain
    the complete continuation in deterministic SVG metadata.
10. Bind a `current` realization to its generated fixed mates, template,
    envelope, design status, and safety notes. The in-app automation console may
    preview the complete circuit replacement but must route confirmation through
    the exact engineering dialog.

## Consequences

- Schematic and assembly intent remain traceable across undo/redo, persistence,
  JSON exchange, command search, UI review, MCP, and the Python client.
- Deterministic validation detects body geometry, transform, polarity mapping,
  support, route-path, or source-signature tampering in current records.
- AI hosts can propose and apply the same bounded operation as the UI, but they
  cannot bypass the catalog, ERC, receipt, confirmation, or validation boundary.
- The generated scene is immediately useful for panel arrangement and wiring-path
  design
  discussion while remaining visibly non-construction and non-manufacturer.
- Manufacturer catalogs, exact CAD, cable/harness engineering, electrical
  analysis, remote auth, live-session control, and production release remain
  separate future decisions and qualification programs.
