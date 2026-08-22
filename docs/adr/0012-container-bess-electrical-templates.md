# ADR 0012: Original Container, BESS, and Electrical Templates

## Status

Accepted for the local preview on 2026-08-20.

## Context

PS3D needed repeatable cargo-container and BESS arrangement studies plus basic
electrical circuit creation. The work must remain original, schema-compatible,
local-first, and honest about the difference between CAD layout, electrical
connectivity, engineering analysis, certification, and construction release.

## Decision

1. Store assembly templates as normal editable component/mate intent with an
   optional template ID, nominal envelope, design status, and safety notes.
2. Seed only nominal container envelopes from public primary sources. Generate
   original planning-frame geometry rather than detailed/certified ISO hardware.
3. Treat BESS output as an equipment-arrangement study with explicit placeholder
   equipment and required-review notes. Never infer NFPA 855, UL 9540, UL 9540A,
   or jurisdictional compliance from the layout.
4. Add a separate Electrical workspace whose canonical model is components,
   declared terminals, named nets, notes, and drafting basis. SVG is a disposable
   derived artifact.
5. Provide three bounded automatic circuit templates and user-created devices
   and pin-to-pin nets. Run structural ERC after every change.
6. Keep sizing, fault studies, coordination, arc flash, load flow, thermal/fire
   analysis, functional safety, and compliance unavailable until separately
   qualified project-specific engines and review processes exist.
7. Migrate schema-1 projects that lack electrical intent without changing the
   schema version or invalidating their prior revision audit.

## Consequences

- Templates participate in normal undo/redo, local persistence, JSON exchange,
  command search, and MCP preview/confirm/apply.
- Large container dimensions expand the assembly component-size envelope to
  20,000 mm while retaining bounded coordinates and component limits.
- Intentional planning-frame joints are excluded from template AABB candidate
  noise; equipment-to-equipment and equipment-to-frame candidates remain.
- The Electrical workspace can make and validate connectivity concepts but does
  not present itself as an electrical engineering analysis package.
- Public release still requires approved-environment build/security verification
  and human provenance, technical, safety, and accessibility review.

