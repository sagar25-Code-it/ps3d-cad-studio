# PS3D 3D Exchange and PDF Contract

## Outcome

PS3D has an original, local-first 3D Exchange Center. It opens a broad set of
runtime scene, mesh, toolpath, and point-cloud files as reference geometry,
exports the visible tessellated scene, creates a PDF model package with an
attached GLB, and can pass an already encoded U3D or PRC payload into a true PDF
3D annotation.

The feature does not claim that every possible 3D format is locally supported.
It does not claim that an imported polygon mesh becomes an editable mechanical
CAD feature tree. Those distinctions are part of the UI and capability schema.

## Reviewed format matrix

| Family | Extensions | Current direction | Current status | Fidelity boundary |
| --- | --- | --- | --- | --- |
| glTF / GLB | `.gltf`, `.glb` | Import + export | Local preview | Runtime scene in meters; no parametric history |
| Wavefront OBJ | `.obj` | Import + export | Local preview | Unitless polygon mesh |
| STL | `.stl` | Import + export | Local preview | Unitless triangles only |
| PLY | `.ply` | Import + export | Local preview | Polygon/vertex data; explicit unit handoff |
| 3MF | `.3mf` | Import | Local preview | Additive reference mesh |
| COLLADA | `.dae` | Import | Local preview | Runtime scene subset |
| FBX | `.fbx` | Import | Local preview | Runtime reference; not Autodesk authoring semantics |
| AMF | `.amf` | Import | Local preview | Additive reference mesh |
| 3D Studio | `.3ds` | Import | Local preview | Legacy tessellated scene |
| VRML | `.wrl`, `.vrml` | Import | Local preview | Runtime scene; scripts are not executed |
| VTK legacy | `.vtk` | Import | Local preview | Polygon geometry; upstream glTF conversion preferred |
| USD family | `.usd`, `.usda`, `.usdc`, `.usdz` | Import + USDZ export | Local preview | Runtime USD subset, not a composition engine |
| G-code | `.gcode`, `.nc`, `.tap` | Import | Local preview | Toolpath lines, not a solid |
| XYZ | `.xyz` | Import | Local preview | Point cloud, not a reconstructed surface |
| U3D / PRC | `.u3d`, `.prc` | PDF only | Pass-through | Already encoded stream only |
| STEP / IGES | `.step`, `.stp`, `.iges`, `.igs` | Planned | Exact kernel required | No current local parser |
| Parasolid / ACIS | `.x_t`, `.x_b`, `.sat`, `.sab` | Planned | Licensed kernel required | No current local parser |
| DWG / DXF | `.dwg`, `.dxf` | Planned | Reviewed converter required | No current 3D conversion |
| Native mechanical CAD | SolidWorks, Inventor, CATIA, Creo, Fusion and peers | Planned | Authorized vendor SDK or upstream export | No current local parser |
| DCC authoring | Blender, 3ds Max, Cinema 4D, SketchUp, Maya and peers | Planned | Upstream neutral export | No current local parser |

The implementation uses the reviewed loaders and exporters already supplied by
the exact-pinned Three.js dependency. Three.js recommends glTF for delivery
because it is compact and fast to load, while Khronos defines glTF as a
royalty-free runtime asset format rather than an authoring format:

- [Three.js loading 3D models](https://threejs.org/manual/en/loading-3d-models.html)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html)
- [Khronos glTF overview](https://www.khronos.org/gltf/)
- [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)

## Unit policy

PS3D renders in meters internally. The import control accepts `auto`, `mm`,
`cm`, `m`, or `in`. Auto uses a visible format convention and always reports the
resolved source unit. Unitless formats such as STL, OBJ, and PLY show a scale
warning and let the user override it.

GLB/glTF and USDZ exports preserve the runtime scene in meters. OBJ, STL, and
PLY receive an explicit coordinate-unit selection because those handoffs do not
provide a universally authoritative unit field.

## Local security boundary

- Input is a user-selected browser `File` set only; no server upload exists.
- A selection is limited to 64 files and 200 MB total.
- Parsed geometry is limited to five million vertices/points.
- Main files are parsed from memory instead of passed to network loaders.
- Companion buffers, images, and materials resolve only from the selected local
  file set or embedded `data:`/`blob:` resources.
- Missing and HTTP(S) companion URLs are blocked before a request is made.
- Imported objects are disposable references and are not persisted into the
  semantic PS3D feature document.

## PDF outputs

### PDF model package

This works for the visible PS3D part, assembly, surface, or imported reference.
The browser writer produces one audited landscape page with a viewport preview,
source label, object/mesh counts, vertices, triangles, and bounds. It also adds
`ps3d-model.glb` through the PDF embedded-files name tree and associated-file
relationship.

This output is intentionally labeled as a model package, not as an interactive
3D annotation. The page remains readable in ordinary PDF viewers; the GLB
attachment opens in PS3D or another glTF-capable viewer.

The running application requests a fresh JPEG from the active viewport before
writing this package. The committed sample PDF is retained as structural
evidence only: its PDF objects, xref, attachment relationship, GLB payload, and
JPEG stream are testable, but its recorded page image is blank. It therefore
does not verify viewport-image quality. A fresh non-blank export plus PDF render
comparison remains a release gate in an approved environment.

### Interactive U3D/PRC pass-through

Adobe's PDF 3D annotation model references a `/3DD` stream whose subtype is
U3D or PRC. PS3D can build that annotation when the user already has a `.u3d`
or `.prc` payload. It embeds the bytes unchanged and does not claim to encode a
GLB, STL, mesh, or B-rep into U3D/PRC.

- [Adobe 3D annotation sample documentation](https://opensource.adobe.com/dc-acrobat-sdk-docs/library/plugin/Plugins_3D_samples.html)
- [Adobe 3D API documentation](https://opensource.adobe.com/dc-acrobat-sdk-docs/library/plugin/Plugins_A3D_API.html)
- [Adobe: enable 3D content in PDF](https://helpx.adobe.com/acrobat/using/enable-3d-content-pdf.html)

Compatible viewer support is required, and Acrobat disables automatic 3D
playback by default for security. That is why the two PDF workflows are visibly
separate.

## Verification evidence

The local browser review covered:

- A real OBJ fixture parsed to one mesh, 12 triangles, 36 vertices, and the
  expected `40 x 30 x 10 mm` envelope.
- A glTF fixture with an HTTP companion URI was rejected with the explicit
  `Blocked non-local or missing companion resource` boundary.
- GLB, glTF, OBJ, STL, PLY, and USDZ export buttons completed against the native
  qualified part.
- The committed PDF model-package sample passed PDF header, EOF, `startxref`,
  xref offset, embedded-file, associated-file, GLB subtype, JPEG stream, and GLB
  magic structural checks. Its recorded viewport image is blank, so no visual
  preview-quality claim is made from that sample.
- The U3D pass-through writer passed annotation, `/3DD`, stream subtype,
  activation-dictionary, xref, and EOF checks.
- The sample PDF opened in the browser PDF viewer, where the blank recorded page
  image exposed the evidence limitation above. The protected workstation did
  not start Poppler or a Python child process; clean CI must add a fresh runtime
  export plus independent PDF parser/render and non-blank-image regression gate.

The reviewed screenshots are `18-exchange-center-import.jpg` through
`24-exchange-format-matrix.jpg` under [`docs/screenshots`](../screenshots).
