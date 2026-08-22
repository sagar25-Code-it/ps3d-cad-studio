# Engineering Drawing Generation and Tolerance Contract

## Outcome

PS3D generates an original, deterministic engineering-drawing preview from the
qualified centered-bore `PartIntent`. The sheet is structured as a parent base
view, aligned projected views, an optional full section, an un-dimensioned
isometric reference, selected semantic dimensions, explicit GD&T records, and
reviewable sheet metadata.

The artifact is drafting assistance, not a released manufacturing drawing,
standards certification, inspection plan, or substitute for engineering
approval. Every generated sheet is marked `NOT RELEASED`.

## Independently implemented method

Official product documentation was used only to understand public drafting
behavior. No Autodesk, Siemens, SOLIDWORKS, ASME, or ISO source code, templates,
icons, screenshots, examples, assets, or documentation wording was copied.

The researched common method and PS3D implementation are:

| Public drafting concept | PS3D implementation |
| --- | --- |
| A drawing begins with a base/parent view | `front` is the descriptive base view and shows width, height, and the visible bore |
| Orthographic views are projected from a parent | `top` and `right` retain `parentId: front`, alignment metadata, and parent scale |
| Projection convention controls view placement | Third angle places top above and right to the right; first angle places top below and the right-side view to the left |
| Section views are derived from a parent cutting line | Section A-A includes a cutting plane and direction marks on the front view, a linked full section, and material hatching |
| View edge appearance is configurable | The known qualified part supports visible-edge and visible-plus-hidden-edge modes with distinct visible, hidden, and center line styles |
| Model annotations should be selective and duplicates removed | PS3D generates one overall width, height, thickness, bore callout, and only the basic dimensions required by an enabled position frame |
| Datum and geometric tolerances are authored specifications | Datum scheme and all feature-control-frame values are explicit drawing inputs, never calculations from a general tolerance |
| Company drawing automation uses rules and templates | PS3D exposes a bounded, original plate rule set and title-block template with a visible review boundary |

Primary product references:

- Autodesk Drawing views: <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-VIEWS>
- Autodesk projected views: <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-CREATE-PROJECTED-VIEW>
- Autodesk section views: <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-SECTION-VIEW>
- Autodesk dimension tolerance controls: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-REF-DIMENSION-DLG.htm>
- SOLIDWORKS projected views: <https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_projected_view.htm>
- SOLIDWORKS model-item selection and duplicate elimination: <https://help.solidworks.com/2026/english/SolidWorks/sldworks/HIDD_DVE_INSERT_MODEL_ITEMS.htm>
- SOLIDWORKS datum feature symbols: <https://help.solidworks.com/2026/english/SolidWorks/sldworks/c_datum_feature_symbols.htm>
- SOLIDWORKS geometric tolerance controls: <https://help.solidworks.com/2026/english/SolidWorks/sldworks/HIDD_GTOL.htm>
- Siemens NX product modules, including rules-based Drawing Automation: <https://blogs.sw.siemens.com/wp-content/uploads/sites/2/2020/11/NX-Add-on-Module-Brochure.pdf>

## View hierarchy and orientation

The view presets are:

| Preset | Generated views |
| --- | --- |
| Base + projections + isometric | Front base, top projected, right projected, and isometric reference |
| Three orthographic | Front base, top projected, and right projected |
| Front only | Front base only |

Section A-A can be added to either multi-view preset. The section option is
disabled for front-only because that layout cannot show a complete edge-on
datum/section relationship.

The descriptive front view is the width-by-height face and includes the bore
circle and center mark. The top view is width by thickness. The right view is
thickness by height. Projected bore edges appear as hidden lines only when the
visible-plus-hidden style is selected. Centerlines remain independent of the
hidden-edge setting.

Every SVG view records `data-view-id`, `data-view-role`, parent, alignment,
center location, and semantic source. The selected scale is honored until
bounded sheet-fit protection is required; the title block then reports the
effective `FIT 1:n` scale.

## Selective dimensions

The default multi-view plan emits six non-duplicated dimensions when the plate
datum/position specification is enabled:

1. overall width on the front base view;
2. overall height on the front base view;
3. thickness on the top projected view;
4. through-bore diameter callout on the front base view;
5. boxed basic horizontal bore location; and
6. boxed basic vertical bore location.

The two basic locations exist only when an explicit position feature-control
frame and usable datum reference frame are present. With no datum scheme, they
are removed. Front-only produces only the visible width, height, and bore
callout; it does not claim a thickness dimension.

Dimension lines include witness/extension lines, arrowheads, source/view IDs,
and a tolerance-source classification. Imported tessellated references do not
acquire manufacturing dimensions or feature semantics through this generator.

## General tolerance and GD&T separation

General linear and angular tolerances apply only where an individual
dimensional tolerance is not shown. Default preview values are `+/- 0.20 mm`
and `+/- 0.50 deg`.

Changing the general tolerance cannot change:

- datum selection;
- flatness tolerance;
- perpendicularity tolerance;
- position tolerance; or
- basic-dimension presence except through a separate datum/GD&T setting.

GD&T fields are explicit independent inputs. Flatness has no datum reference.
Perpendicularity references datum A only when a plate datum frame is selected.
Position uses a diametric zone relative to A, B, and C and activates the boxed
basic bore-location dimensions.

The plate 3-2-1 datum scheme is a seeded review template, not inferred design
intent. A responsible engineer must confirm datum features, precedence,
tolerance magnitudes, material-condition modifiers, fit/function, process, and
inspection method.

ASME lists Y14.5-2018 (R2024) as its current GD&T guideline. ISO lists ISO
2768-1:1989 as current but expected to be replaced and publishes ISO 22081:2021
for general geometrical and size specifications. PS3D therefore labels ASME or
ISO only as a drafting basis and does not claim conformance or encode a named
company/general-tolerance class.

Primary standards-body references:

- <https://www.asme.org/codes-standards/find-codes-standards/y14-5-dimensiones-y-tolerancias>
- <https://www.iso.org/standard/7748.html>
- <https://www.iso.org/standard/85741.html>
- <https://www.iso.org/standard/72514.html>
- <https://www.iso.org/standard/55979.html>

## Sheet format

The generated A4/A3 landscape sheet includes:

- border coordinate zones;
- model/view-method metadata;
- revision history table;
- drawing number, revision, sheet count, units, scale, and drafting basis;
- first- or third-angle text and projection symbol;
- user-defined general-tolerance note;
- explicit statement that GD&T values are not derived from general tolerance;
- drawn/check/approval placeholders;
- engineer-confirmation datum note; and
- `NOT RELEASED` status in both watermark and title block.

## Validation

- Drawing changes are revisioned and idempotency checked.
- General linear tolerance is bounded to `0.001..10 mm`; angular tolerance is
  bounded to `0.01..10 deg`.
- Each explicit GD&T value is independently bounded to `0.001..10 mm`.
- Titles and notes are XML escaped.
- SVG contains no scripts, remote resources, copied assets, or third-party
  fonts.
- Seven focused tests cover determinism, base/parent semantics, first/third
  angle placement, hidden lines, section associativity, tolerance independence,
  datum-free behavior, front-only visibility, and injection safety.

## Deferred capabilities

The current section and edge classification are qualified only for the known
centered-bore plate intent. General B-rep hidden-line removal, arbitrary section
geometry, detail/broken/auxiliary views, surface-finish and weld symbols,
thread standards and fit lookup, BOM balloons/parts lists, DXF/DWG output, and a
production drawing-PDF release pipeline remain separate reviewed capabilities.

## Verification screenshots

- [`27-engineering-drawing-method.jpg`](../screenshots/27-engineering-drawing-method.jpg)
  shows the corrected base/projected/section sheet, top command workflow, model
  browser, dimensions, datum template, and release-marked title block.
- [`28-explicit-gdt-specification.jpg`](../screenshots/28-explicit-gdt-specification.jpg)
  shows the independent position, flatness, and perpendicularity controls and
  explicit feature-control-frame audit list.
