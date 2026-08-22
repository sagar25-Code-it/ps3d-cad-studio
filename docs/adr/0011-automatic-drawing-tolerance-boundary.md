# ADR 0011: Engineering drawing method and tolerance boundary

- Status: accepted for local preview
- Date: 2026-08-20

## Context

The first drawing generator mislabeled the descriptive width-by-height face as
`top`, treated a width-by-thickness strip as `front`, omitted a true section
workflow, and calculated GD&T values from the general linear tolerance. Those
choices were deterministic but not a defensible engineering-drawing method.

Official Autodesk, Siemens, and SOLIDWORKS documentation describes a common
public workflow based on a parent base view, aligned projected/section views,
configurable edge display, selective model annotations, and explicit datum and
geometric-tolerance authoring. Standards-body sources distinguish general
tolerances from geometric requirements.

## Decision

Use the front width-by-height face as the descriptive base view. Derive aligned
top and right views according to first- or third-angle placement. Add a bounded
full section A-A for the qualified centered-bore part with a parent cutting
plane and hatching. Keep the isometric view un-dimensioned and for reference.

Generate a selective, non-duplicated dimension set. Emit boxed basic bore
locations only when an explicit position frame and usable datum reference frame
exist. Never dimension a feature in a view where it is not visible.

Persist general tolerances and GD&T specifications separately. General
tolerances cannot create datums or calculate flatness, perpendicularity, or
position values. Datum A/B/C is an explicit seeded plate template requiring
engineer confirmation. Flatness remains datum-independent.

Mark the artifact `NOT RELEASED`; include sheet zones, revision metadata,
projection method, drawn/check/approval placeholders, and an explicit
engineering-review boundary. Keep all SVG geometry, symbols, title-block
layout, source, and tests project-owned and original.

## Consequences

- Drawing structure is auditable as a base/child view graph rather than a list
  of decorative projections.
- First- and third-angle placement can be tested numerically.
- GD&T values remain stable when a general tolerance changes.
- Datum-free mode cannot silently produce datum-referenced position or
  orientation requirements.
- Legacy schema-1 projects remain readable because added settings are optional
  and use conservative fallbacks.
- The full-section and edge-classification implementation is limited to the
  qualified centered-bore intent; arbitrary B-rep drafting remains deferred.
- A responsible engineer retains authority for design intent, tolerances,
  material/process, inspection, checking, and release.
