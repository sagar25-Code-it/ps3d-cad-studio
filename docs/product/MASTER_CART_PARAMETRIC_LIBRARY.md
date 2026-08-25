# PS3D Master Cart parametric library

## Purpose

Master Cart is PS3D CAD Studio's original, standards-oriented component
configuration workspace. It gives a familiar engineering workflow without
copying a supplier website or catalog database:

1. choose a component category and family;
2. filter metric, inch, or universal nominal sizes;
3. select material and finish;
4. edit bounded envelope parameters;
5. inspect the regenerated 3D preview and dimension table; and
6. add the configured multipart item to Assembly as one undoable group.

Every inserted detail carries a stable PS3D trace recording its template,
instance, role, nominal size, material, finish, parameter summary, and original
preview provenance. Moving, grounding, hiding, or deleting any detail acts on
the complete inserted group so a multipart bearing, fitting, or fastener cannot
leave orphaned preview bodies.

## Ready families

| Category | Original PS3D ready families | Selection reference |
| --- | --- | --- |
| Fasteners | socket-head cap screw, hex-head bolt, flat-head socket screw, shoulder screw, hex nut, flat washer | [McMaster fasteners](https://www.mcmaster.com/products/fasteners/) |
| Bearings and bushings | deep-groove ball bearing, sleeve bushing, flanged bushing | [McMaster bearings](https://www.mcmaster.com/products/bearings/) |
| Gears | spur gear | [McMaster gears](https://www.mcmaster.com/products/gears/) |
| Chain and sprockets | roller-chain sprocket, roller-chain link | [McMaster chain and sprockets](https://www.mcmaster.com/products/roller-chain-and-sprockets/) |
| Belts and pulleys | timing-belt pulley, closed timing-belt envelope | [McMaster timing belts and pulleys](https://www.mcmaster.com/products/timing-belts-and-pulleys/) |
| Seals | O-ring | [McMaster O-rings](https://www.mcmaster.com/products/o-rings/) |
| Linear motion | linear bearing, precision shaft, ACME/trapezoidal lead screw, shaft collar | [McMaster linear motion](https://www.mcmaster.com/products/linear-motion/) |
| Hose fittings | straight and elbow hydraulic fitting envelopes | [McMaster hydraulic hose fittings](https://www.mcmaster.com/products/hydraulic-hose-fittings/) |
| Tube fittings | compression union and compression elbow envelopes | [McMaster tube fittings](https://www.mcmaster.com/products/tube-fittings/) |
| Hand tools | hex key and combination wrench envelopes | [McMaster hand tools](https://www.mcmaster.com/products/hand-tools/) |

The 25 ready families are extensible typed templates, not a claim to reproduce
every supplier product, SKU, dimensional table, stock status, price, CAD file,
or engineering rating.

## Geometry and dimensions

The library uses millimeters internally and exposes common metric, inch, and
universal nominal choices where appropriate. Derived preview dimensions include
items such as screw head and shank envelopes, bearing ring envelopes, gear and
sprocket pitch diameters, timing-pulley pitch diameters, O-ring outside diameter,
and fitting envelopes. Special preview primitives include annular rings, tori,
hexagonal prisms, gears, cones, and spheres.

These are deterministic planning previews. They intentionally omit exact
threads, tooth involutes, chain articulation, bearing race conformity, seal
squeeze, tool forging details, hose/tube pressure ratings, tolerances, load/life
ratings, manufacturer part numbers, certification, price, and availability.
Before procurement or manufacturing, the user must validate the selected
standard, fit, tolerance, load, material, finish, pressure/temperature rating,
and current supplier drawing.

## Source and intellectual-property boundary

McMaster-Carr links are category-level selection references. PS3D CAD Studio is
not affiliated with or endorsed by McMaster-Carr. The repository does not copy
supplier photographs, illustrations, page layout, logos, product descriptions,
SKU database, pricing, inventory, or downloadable CAD assets. Template names,
typed data structures, interface, symbols, geometry generators, and tests are
project-owned original implementation. External standards and supplier pages
remain subject to their respective owners' rights and terms.

## Brand and interface verification

Master Cart consumes the same reviewed `PS3D_BRAND` record and `BrandLogo`
component as the public About, account, learning, audit, and footer surfaces.
Its visible lockup therefore uses:

- PS3D Master;
- PS3D CAD Studio;
- Precision CAD Design & Mechanical Services;
- the approved `/ps3d-master-logo.png` asset; and
- original `CommandIcon` SVG symbols for every catalog category.

The red, white, light-gray, and charcoal catalog palette is intentionally
consistent with the approved professional PS3D shell. It does not reproduce
McMaster-Carr's page design or another CAD product's protected artwork.

## Verification contract

The automated suite verifies category coverage, source-reference boundaries,
default generation for every family, finite validated geometry, broad metric
and inch socket-head choices, grouped move/hide/delete semantics, and custom
ring/torus/gear preview behavior. Existing release tests separately lock the
owner name, product name, service line, tagline, founder attribution, social
handle, and official logo path. Browser evidence is stored under
`docs/screenshots/master-cart` and packaged as a local review ZIP after each
visual verification run.
