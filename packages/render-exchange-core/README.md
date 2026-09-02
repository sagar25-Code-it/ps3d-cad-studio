# `@ps3d/render-exchange-core`

Contract-first foundations for truthful CAD rendering and file exchange.

This package deliberately separates three concerns:

1. **Engineering material** stores physical properties used by mass, thermal, and structural consumers.
2. **Appearance** stores PBR presentation properties. Appearance overrides never change physical properties.
3. **Exact geometry** remains owned by the CAD kernel. A render scene may reference only digest-bound, derived tessellations; it cannot write B-rep geometry or modelling tolerances.

The exchange contract covers STEP, IGES, BREP, STL, OBJ, 3MF, DXF, and SVG. NX, CATIA, Creo, and SOLIDWORKS native formats are represented only as licensed-translator requests. Capability gating returns an explicit unsupported or license diagnostic instead of pretending a neutral translator can read or write a proprietary native file.

## Security and provenance

- Every external texture, decal, environment, import, and export artifact is content-addressed with a SHA-256 digest.
- URI schemes are checked against an explicit policy. Embedded credentials, fragments, traversal segments, and unapproved network origins can be rejected.
- Canonical JSON and SHA-256 receipts bind jobs, reports, source models, generated artifacts, translator builds, and render products.
- Import reports disclose healing, validation, unit conversion, loss, and preservation outcomes.
- Render products identify the exact document digest and every tessellation digest they consumed.

## Boundary

This package defines and validates protocols. It does not contain a renderer, path tracer, CAD kernel, or proprietary translator and does not claim native-format support without a separately installed and licensed capability.
