# @ps3d/associative-drawing-core

Persistent, associative engineering-drawing contract for PS3D. It models
base, projected, section, detail and auxiliary views; associative dimensions;
center marks/lines; hole and thread notes; GD&T frames and datums; balloons;
and parts lists.

Every projected curve is derived by an injected `DrawingProjectionBackend`
from an exact model revision. The core never invents hidden-line geometry. It
tracks stable topology keys and source entity IDs, invalidates only affected
views/annotations, and requires regeneration before a stale drawing can be
released.

Implemented here: schema, validation, dependency invalidation, projection
backend protocol, and deterministic SHA-256 update receipts. A qualified HLR
backend and drafting UI are subsequent adapters.
