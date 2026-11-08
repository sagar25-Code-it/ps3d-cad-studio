# What a true persistent B-rep kernel needs

**Status:** assessment and plan. Nothing in this document is implemented, and PS3D does not claim exact B-rep modelling.
**Scope:** an honest answer to "what would it take to replace the mesh bodies with a real boundary-representation kernel with persistent topological naming", with a staged plan, the risks, and what has to be decided first.
**Related:** [ADR 0001](adr/0001-permissive-mesh-solid-kernel.md) (why the mesh kernel exists), [OCCT qualification and distribution gate](architecture/OCCT_QUALIFICATION_AND_DISTRIBUTION.md) (the legal and reproducibility gate that already stands in front of any OCCT binary), [exact parametric CAD platform](architecture/EXACT_PARAMETRIC_CAD_PLATFORM.md) (the intended end state), `packages/exact-kernel-api`, `packages/exact-kernel-worker`, `packages/occt-kernel-adapter`, `packages/topology-reference-core`.

## 1. Where PS3D is today

PS3D models with triangle meshes. A solid is a `GeneralSolidBody`: a closed, outward-wound triangle mesh plus an optional `brep` summary. The pieces that matter for this plan:

- **Bodies are tessellations.** A cylinder is a 48-gon prism, a fillet is a row of facets, a thread is a mesh whose wall was re-tessellated into a helical groove. Nothing remembers the exact surface the facets sample, so any later operation works on the facets.
- **The Boolean is a BSP-tree CSG on triangles** (`mesh-boolean.ts`), with welding, T-junction repair and a strict closed-manifold check. It refuses what it cannot make clean rather than returning damage, and it is limited to 30 000 triangles per operand. It is exact for planar faces and approximate for curved ones. It has had real fragility: a coordinate that sat exactly on a half-quantum rounding boundary (a 4.9175 mm hole at 60 degrees) made two copies of one corner weld differently and the cut was refused. That was fixed by shifting the weld grid, but it is the kind of failure a tolerance-based mesh Boolean keeps having.
- **Fillet, chamfer, shell, draft, hole, thread, flange and notch are mesh operations**, each a purpose-built routine for the shapes it was written for (rectangular and circular shells, prism edge treatments, a bore cut square into flat faces). They are not general: they do not know the faces they act on, only the triangles.
- **Face names come from the reference runtime for extrudes** (`occt-kernel-adapter/src/reference-runtime.ts`: analytic planar and cylindrical faces, stable face keys from lineage and role) **and degrade to role strings after a Boolean** (`target.<role>` / `tool.<role>`, origin `mesh-boolean`). Picks that survive a rebuild today are stored as world coordinates and axis directions (hole positions, picked fillet edges), not as references to faces.
- **The exact-kernel contracts exist, the kernel does not.** `exact-kernel-api` (request/response protocol, canonical JSON, shape handles), `exact-kernel-worker` (worker transport) and `occt-kernel-adapter` (attestation of an OCCT runtime against a deployment manifest) are implemented and tested against an injected fake runtime. `topology-reference-core` implements a persistent-reference resolver (exact, unique-recovered, ambiguous, missing). There is no OCCT binary in the repository and the gate document explains why none may be added until it is reproducibly built and its LGPL obligations are met.
- **Surfaces are tessellated too.** The Surface workspace's Bezier patch and the mesh surfaces added alongside this plan (ruled, loft, boundary patch, extend, trim, stitch) are triangle meshes; SubD forms are Catmull-Clark meshes. They are honest tessellations and do not become exact on their own.

Everything above works and is tested, and it is the reason the product runs in a browser tab with no kernel download. It is also the ceiling: the items in the gap list that need exact geometry (G2 blends, variable-radius fillets on arbitrary edges, shell and draft on general bodies, offset surfaces, STEP export of true surfaces, robust Booleans on curved bodies, topological naming across a fillet) cannot be made good by writing more mesh routines.

## 2. What a persistent B-rep kernel has to provide

A kernel in the Parasolid, ACIS or OCCT sense is these capabilities together; dropping one usually moves the problem rather than removing it.

1. **Exact geometry.** Analytic surfaces (plane, cylinder, cone, sphere, torus) and NURBS surfaces and curves, with parametric evaluation, so a face can be asked for its normal, curvature and offset, not only its facets.
2. **Topology.** Vertex, edge, coedge/wire, face, shell, solid, with orientation, adjacency and tolerance. Faces are bounded by trimmed curves, not triangles.
3. **A tolerant Boolean and local operations.** Union, cut, intersect, plus fillet, chamfer, shell, draft, offset, split, with healing for the near-coincident cases real models produce.
4. **Tessellation on demand.** The viewer mesh is generated from the B-rep and every triangle knows its face, which replaces today's `faceTriangles` bookkeeping with the real thing.
5. **Validity checking and shape healing**, so a failed operation is reported and rolled back, not silently wrong.
6. **Exact queries.** Mass properties, distances, intersections, silhouette and section curves for drawings.
7. **Exchange.** STEP (and IGES) read and write of exact geometry.
8. **Persistent naming.** The operation history reports what each result face, edge and vertex was generated from, so a reference stored in the timeline can be found again after a rebuild (section 4).

## 3. Options

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **A. Open CASCADE (OCCT) as WebAssembly in a worker** | The open-source kernel behind FreeCAD, CAD Assistant and the `opencascade.js` / `replicad` wrappers, built with Emscripten | Complete: all eight capabilities, STEP/IGES, fillets, shells, offsets, NURBS, healing, and a history API for naming. Proven in browsers. The repository's adapter, worker and attestation contracts were written for exactly this | **Size:** the two WASM binaries of the locally inspected `replicad-opencascadejs` 0.23.0 are about 10.8 MB each, to be measured after a module-trimmed custom build. **Licence:** LGPL-2.1 with the OCCT exception, which for a statically linked WASM artifact needs legal review and the replaceability measures in the gate document. **Threads and memory:** multithreaded builds need `SharedArrayBuffer`, hence cross-origin isolation headers (`COOP`/`COEP`) on every page and embed, which constrains hosting and any third-party iframe. **Cold start:** instantiating a 10 MB module costs hundreds of milliseconds to seconds on a slow device. **API:** large and C++-shaped; the bindings are the main integration effort |
| **B. Native OCCT worker (desktop or server)** | The same kernel as an isolated process | No download, full speed and threads, no browser memory ceiling | A server or a desktop shell; offline use in a plain browser tab is lost; operating a compute service has its own costs and privacy implications |
| **C. Manifold (already evaluated)** | Robust Boolean on manifold triangle meshes, Apache-2.0, WASM | Fixes the mesh Boolean's fragility cheaply; a plausible near-term replacement for `mesh-boolean.ts` | Still a mesh: no exact surfaces, no fillet or shell, no STEP geometry, no persistent faces. It improves the current kernel, it is not a B-rep |
| **D. Another B-rep kernel** (for example the Rust `truck` crates, CGAL-based or research kernels) | Smaller or differently licensed kernels | Possibly lighter and permissively licensed | Far less complete (fillets, healing, Booleans on NURBS are the hard 80 percent), small communities, and the qualification effort is the same |
| **E. Write our own** | A kernel in TypeScript | Full control | Not realistic. Robust Booleans and fillets are decades of tolerance engineering; the likely outcome is a worse mesh kernel with a B-rep label. **Not recommended and not proposed here** |

**Recommendation:** option A behind the existing `exact-kernel-api` boundary as the target, with option C as an optional interim hardening of the current Boolean, and option B as the deployment profile where the WASM costs are unacceptable. The decision that gates everything is the licence and distribution review, not the engineering.

## 4. Topological naming, which the kernel does not solve by itself

A timeline stores references: "fillet this edge", "start the hole on this face", "sketch on this face". After the model is edited and replayed, the references must find their targets again. Meshes make this hard (faces are anonymous triangle sets); a B-rep makes it possible but not automatic.

**Approach (history-based first, geometry as a fallback):**

1. **Generated/modified/deleted maps.** Each OCCT operation (`BRepBuilderAPI_MakeShape::Generated`, `Modified`, `IsDeleted`, and the Boolean's history) reports, for every input sub-shape, which result sub-shapes descend from it. The adapter records these per feature as a lineage edge: result entity to (feature id, input entity, role).
2. **Names are lineage paths, not indices.** A persistent name is the chain "created by feature F as role R from entity E", for example "the side face generated by edge 3 of Sketch 1's profile, after Extrude 2". The existing `FeatureLineageIdentity` and `PersistentTopologyEntity` types in `topology-reference-core` are the right shape; `stableFaceKey` already builds this kind of key for extrudes.
3. **Splits and merges need rules.** One face splitting in two (a cut through it) makes the reference ambiguous; a merge makes two names one. The resolver's existing outcomes (exact, unique-recovered, ambiguous, missing) are the honest answer, and the UI needs a repair flow for the ambiguous and missing cases (pick again, or pick among the candidates), because no algorithm resolves all of them.
4. **Fingerprints as the fallback.** Where history is lost (imports, kernel upgrades), match by geometry and adjacency: surface type and parameters, area, centroid, the names of neighbours. The resolver already scores candidates this way.
5. **Corpus-driven.** Naming quality is measured, not designed: a corpus of edit-and-replay scenarios (change a sketch dimension, insert an earlier feature, reorder, suppress) with the fraction of references that resolve exactly, recover uniquely, go ambiguous or break. That number, not an architecture diagram, says when naming is good enough to ship.

**What migrates:** references that are today world coordinates and face roles (hole origin and normal, picked-edge fillets, sketch planes on faces, flange edge numbers) become persistent entity references, with the stored coordinates kept as the fallback fingerprint.

## 5. Migration path from mesh bodies

Strangler, not rewrite. The mesh path stays working until each feature kind has been proven on the exact path.

1. **The mesh body becomes a render and exchange cache.** `GeneralSolidBody` keeps its role as what the viewport and STL/3MF export read; it gains an optional reference to an exact shape in the kernel session (and, for saved files, to the feature history that recreates it). The viewer mesh is then produced by tessellating the shape, per face.
2. **Route per feature kind.** A flag in the feature (or the project) selects the kernel. New kinds start on exact; old kinds are switched one at a time.
3. **Shadow mode first.** For each switched kind, run both kernels on the corpus and compare volume, bounding box, area, topology counts and Boolean success. Promote only with the numbers.
4. **Old files.** A project saved before the switch has bodies stored as meshes and a timeline that can be replayed. Replaying on the exact kernel rebuilds them; bodies with no replayable history (mesh imports, results of the old free-form Boolean) stay mesh bodies, clearly labelled, and keep using the mesh Boolean.
5. **The bodies added in this phase are mesh by nature and migrate differently:**
   - Pieces of a severed body (`<body>.piece-N`) are just solids on the exact path.
   - Hole threads: a modelled thread is a helical sweep cut on the exact path, and the cosmetic thread annotation carries over unchanged.
   - Corner relief notches are ordinary cuts on a sheet-metal body; the flat pattern then unfolds exact faces.
   - Surfaces: ruled, loft, patch, trim, extend and stitch have direct counterparts (ruled and loft surfaces, filling/patch surfaces, trimming, extension, sewing) producing real NURBS faces. Today's tessellated surface bodies would be rebuilt from their curves, not converted.
   - **SubD forms have no exact counterpart.** A Catmull-Clark limit surface is bicubic away from extraordinary vertices and not at them, so "Finish Form" to B-rep is an approximation (fitted patches with a stated deviation), or it stays a mesh solid. This is the same trade-off every CAD system with SubD makes, and the plan should say so to users.

## 6. Staged plan

Estimates are order-of-magnitude for a small focused team and assume the licence review does not block.

| Milestone | Content | Exit criteria |
| --- | --- | --- |
| **M0. Spike and decisions** (2 to 4 weeks) | Reproducible custom OCCT WASM build with only the needed toolkits (kernel, math, 2D/3D geometry, BRep, primitives, Boolean, fillet, offset, mesh, shape healing; data exchange later). Measure size (raw and gzipped), cold start, memory, and a 20-operation golden set (extrude, revolve, Boolean, fillet, shell, loft, STEP round trip). Legal review of LGPL-2.1 plus the exception for a bundled WASM artifact. Decide threads/COOP-COEP | Written numbers for size, start-up and the golden set; a licence conclusion; a go or no-go on option A versus B |
| **M1. Kernel behind the boundary** (4 to 6 weeks) | Wire `occt-kernel-adapter` to a real, attested runtime in the worker; extrude, revolve, sweep, loft and Booleans on exact; tessellate to the viewer per face; shadow-compare against the mesh path | Shadow comparison within tolerance on the corpus; Boolean success rate at least as good as the mesh path and no crashes; worker isolation and timeouts hold |
| **M2. Persistent naming MVP** (4 to 8 weeks) | Record generated/modified/deleted maps per feature; lineage-path names; resolver with repair UX; migrate hole placement, picked-edge fillet and sketch-on-face to references | Naming corpus: exact plus unique-recovered at or above an agreed target (for example 95 percent on pure parameter edits), and every other case reported as ambiguous or missing, never silently wrong |
| **M3. Local operations on exact** (6 to 10 weeks) | Fillet (constant, then variable), chamfer (all three modes), shell and draft per face, holes with real threads, patterns on general bodies, offset face, replace face | Each kind passes shadow mode, then becomes the default; the gap-list items for these kinds are closed or explicitly deferred |
| **M4. Sheet metal on exact** (4 to 6 weeks) | Flanges, hems, reliefs and the flat pattern from exact faces; bend table | Flat patterns agree with the mesh results on the existing sheet-metal tests |
| **M5. Surfaces** (6 to 10 weeks) | Exact ruled, loft, patch, trim, extend, stitch and thicken; planes through edges and along paths; SubD finish as fitted surfaces with a reported deviation | Stitching a closed set yields a valid solid; deviation of SubD finish stated in the UI |
| **M6. Exchange and retirement** (4 to 8 weeks) | STEP and IGES in and out of exact geometry, exact mass properties and sections, retire the mesh kernel for new bodies | A STEP round trip keeps surface types; mesh kernel remains only for imported meshes |

Each milestone ships behind a flag and is reversible until its exit criteria are met. The whole programme is on the order of six to twelve months of focused work; it is not a feature that can be added in a sprint, and any schedule shorter than that is a sign that scope has been cut, not that the problem is easy.

## 7. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Licence or distribution blocks option A** | An LGPL static link in a browser bundle is the least settled part | Do the legal review in M0, before engineering; keep option B (native worker) as the fallback profile; the gate document already forbids shipping an unattested binary |
| **Bundle size and cold start** | A 10 MB-class module changes how the app loads | Custom module-trimmed build, lazy load only when a feature needs the kernel, cache with the service worker, keep the mesh path for the first paint |
| **Cross-origin isolation** | `SharedArrayBuffer` needs `COOP`/`COEP`, which breaks third-party embeds and some hosting | Prefer the single-threaded build for the kernel worker unless profiling proves threads are needed; evaluate before committing |
| **Naming never reaches the target** | History maps lose information at merges and imports | Corpus-measured; ambiguous and missing are first-class outcomes with repair UX; fingerprints as the fallback |
| **Fidelity regressions during the switch** | Users have files and expectations built on the mesh behaviour | Shadow mode with numbers, per-kind promotion, old projects replay unchanged on the mesh path until switched |
| **Failure containment** | A kernel crash or runaway operation must not take down the session | Worker isolation (ADR 0002), operation time and memory limits, rollback to the last valid shape |
| **Scope creep into writing a kernel** | The most expensive mistake available | Option E is out of scope; gaps are closed by using the kernel's operations, not by reimplementing them |
| **Two geometry worlds in one file** | Mesh bodies, exact bodies and SubD meshes coexist for a long time | Label each body's kind in the model browser and file; never imply exactness a body does not have |

## 8. Decisions needed before M0 starts

1. Is an LGPL-2.1-with-exception WASM component acceptable for the public build, and what replaceability evidence does legal need?
2. Is a native worker profile (desktop or server) in scope, or is the browser the only target?
3. Is cross-origin isolation acceptable for every page, or must the kernel run single-threaded?
4. What are the corpus and the acceptance numbers (Boolean success, regeneration time, naming survival) that decide promotion?
5. Who owns the naming resolver and its repair UX, since it is as much product design as geometry?

## 9. What this does not change

Until M1 passes, the mesh kernel is the kernel, and the documentation must keep saying so: bodies are tessellated, curved faces are the facets of the input meshes, face names after a Boolean are labelled regions, and surfaces and SubD forms are meshes. The improvements made on the mesh path in the meantime (severed bodies kept as pieces, modelled threads, notch reliefs, mesh surfaces, SubD forms, a sturdier weld) are worth having and are deliberately kept in separate modules with their own tests so that each one can be replaced by its exact-kernel counterpart without touching the rest.
