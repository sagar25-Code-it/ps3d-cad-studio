# ADR 0010: Local 3D exchange and two explicit PDF delivery paths

## Status

Accepted for the Phase 1 preview.

## Context

Users need broad 3D interchange, but browser scene loaders do not recover exact
B-rep topology or vendor-native feature history. PDF model attachments are also
different from PDF 3D annotations: the latter require U3D or PRC data and remain
subject to viewer security controls.

## Decision

PS3D will:

1. Parse reviewed runtime scene, mesh, toolpath, and point-cloud formats from a
   bounded local `File` set.
2. Block unresolved and remote companion-resource URLs.
3. Treat imported geometry as an ephemeral reference, never as recovered native
   PS3D features.
4. Export visible tessellated geometry to GLB, glTF, OBJ, STL, PLY, or USDZ.
5. Offer a universally readable PDF model package with an associated GLB.
6. Offer a separate true PDF 3D annotation only as U3D/PRC pass-through.
7. Catalog exact/proprietary CAD families as unavailable until an authorized,
   independently reviewed kernel or converter is integrated.

## Consequences

The browser feature is useful with a fully free local stack and has a precise
security/fidelity boundary. Users must choose units for unitless mesh exchange.
STEP/IGES and native CAD history remain future work. Interactive 3D PDF from a
normal mesh remains unavailable until a lawful U3D/PRC encoder is adopted; the
UI cannot imply that the GLB-attached PDF is the same thing.
