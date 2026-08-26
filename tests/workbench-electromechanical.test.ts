import {
  ELECTROMECHANICAL_CATALOG,
  ELECTROMECHANICAL_CATALOG_REVISION,
  analyzeElectromechanicalReadiness,
  applyWorkbenchOperation,
  createElectromechanicalAssembly,
  createElectricalComponentInstance,
  createElectricalTemplate,
  createWorkbenchProject,
  constrainElectricalSheetPosition,
  defaultElectromechanicalMappings,
  electricalSignature,
  isElectricalSheetPositionAvailable,
  preferredElectromechanicalLayout,
  validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { createElectricalSchematic } from "../packages/workbench-electrical/src/index.js";
import { buildAssemblyPreview, findAssemblyInterference, type PreviewPrimitive } from "../packages/workbench-geometry/src/index.js";
import { handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchElectromechanicalTests: readonly TestCase[] = [
  {
    name: "generic electromechanical catalog covers every current schematic kind and terminal",
    run: () => {
      const kinds = ["battery", "fuse", "disconnect", "contactor", "inverter", "transformer", "breaker", "load", "motor", "ground", "terminal", "sensor", "hvac"] as const;
      equal(ELECTROMECHANICAL_CATALOG.length, kinds.length, "the local catalog should have one bounded entry for every current kind");
      for (const template of ["bess-single-line", "dc-control", "motor-starter"] as const) {
        const intent = createElectricalTemplate(template);
        for (const component of intent.components) {
          const part = ELECTROMECHANICAL_CATALOG.find((item) => item.kind === component.kind);
          assert(part !== undefined, `${component.kind} should resolve to a local package`);
          const terminals = new Set(part.terminals.map((terminal) => terminal.name));
          assert(component.terminals.every((terminal) => terminals.has(terminal)), `${component.reference} terminals should map exactly by name`);
        }
      }
      const battery = ELECTROMECHANICAL_CATALOG.find((part) => part.kind === "battery")!;
      equal(battery.terminals.find((terminal) => terminal.name === "P")?.role, "positive", "battery P should retain an explicit positive role");
      equal(battery.terminals.find((terminal) => terminal.name === "N")?.role, "negative", "battery N should retain an explicit negative role");
    }
  },
  {
    name: "circuit realization produces a traceable wired mounting plate",
    run: () => {
      const electrical = createElectricalTemplate("motor-starter");
      const layout = preferredElectromechanicalLayout(electrical);
      equal(layout, "panel-backplate", "built-in circuits should realize as one mounting-plate assembly");
      const mappings = defaultElectromechanicalMappings(electrical);
      const readiness = analyzeElectromechanicalReadiness(electrical, layout, mappings);
      equal(readiness.status, "ready", "the built-in motor starter should resolve without a mapping blocker");
      const generated = createElectromechanicalAssembly(electrical, layout, mappings);
      assert(generated.ok, "the resolved circuit should create a linked assembly");
      equal(generated.value.electricalLinks?.length, electrical.components.length, "every device should link to one package");
      equal(generated.value.electricalRoutes?.length, electrical.nets.length, "every net should link to one conductor path");
      equal(generated.value.components.filter((component) => component.id === "component:em-support").length, 1, "the realization should contain exactly one mounting plate");
      assert(generated.value.components.some((component) => component.id === "component:em-din-rail-01"), "the panel should include deterministic DIN-rail hardware");
      assert(generated.value.components.some((component) => component.id === "component:em-wire-duct-v-left"), "the panel should include deterministic wiring ducts");
      assert(generated.value.components.some((component) => component.id === "component:em-protective-earth-bar"), "the panel should include a protective-earth bonding bar");
      assert(generated.value.electricalLinks?.every((link) => link.terminalMap.length > 0), "every device link should retain terminal traceability");
      assert(generated.value.electricalRoutes?.every((route) => route.pointsMm.length >= 2 && route.endpoints.length >= 2), "every conductor should retain physical waypoints and source endpoints");
      assert(generated.value.electricalRoutes?.every((route) => route.pointsMm.slice(1).every((point, index) => {
        const prior = route.pointsMm[index]!;
        return point.filter((value, axis) => Math.abs(value - prior[axis]!) > 1e-9).length <= 1;
      })), "every conductor segment should be orthogonal");
      const tooManyDevices = {
        ...electrical,
        components: Array.from({ length: 17 }, (_, index) => createElectricalComponentInstance("fuse", `electrical-component:capacity-${index + 1}`, `F${index + 1}`, [100 + index * 40, 100])),
        nets: []
      };
      assert(analyzeElectromechanicalReadiness(tooManyDevices).blockingErrors.some((error) => error.includes("at most 16 devices")), "automatic mounting-plate generation must fail closed above its verified device capacity");
      const tooManyPaths = {
        ...electrical,
        nets: Array.from({ length: 9 }, (_, index) => {
          const net = electrical.nets[index % electrical.nets.length]!;
          return { ...net, id: `${net.id}:capacity-${index + 1}`, name: `${net.name} CAPACITY ${index + 1}` };
        })
      };
      assert(analyzeElectromechanicalReadiness(tooManyPaths).blockingErrors.some((error) => error.includes("at most 8 collision-separated conductor paths")), "automatic mounting-plate generation must fail closed above its verified conductor-lane capacity");
      equal(generated.value.electromechanicalSource?.catalogRevision, ELECTROMECHANICAL_CATALOG_REVISION, "catalog revision should persist");
      assert(validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-validation"), electrical, assembly: generated.value }).ok, "generated realization should validate as a workbench project");
    }
  },
  {
    name: "generated mounting-plate scene is bounded, detailed, wired, and collision free",
    run: () => {
      const electrical = createElectricalTemplate("bess-single-line");
      const generated = createElectromechanicalAssembly(electrical, "panel-backplate", defaultElectromechanicalMappings(electrical));
      assert(generated.ok, "BESS single-line should realize against the generic catalog");
      const scene = buildAssemblyPreview(generated.value);
      assert(scene.primitives.some((primitive) => primitive.kind === "line" && (primitive.radiusMm ?? 0) > 0), "3D preview should include tube-capable unsized conductor paths");
      assert(scene.primitives.some((primitive) => primitive.id.startsWith("detail:panel-terminal:")), "3D preview should derive terminal-stud detail without inflating assembly component count");
      assert(scene.primitives.some((primitive) => primitive.id.startsWith("detail:panel-face:")), "3D preview should derive recognizable device-face detail");
      const routeLanes = generated.value.electricalRoutes!.map((route) => route.pointsMm[2]![2]).sort((left, right) => left - right);
      equal(new Set(routeLanes).size, routeLanes.length, "each automatic conductor path should use one unique panel-depth lane");
      assert(routeLanes[0]! >= 50 && routeLanes.slice(1).every((lane, index) => lane - routeLanes[index]! >= 14), "conductor lanes should clear duct covers and adjacent maximum-radius conductors");
      const conductorPrimitives = scene.primitives.filter(
        (primitive): primitive is Extract<PreviewPrimitive, { readonly kind: "line" }> => primitive.kind === "line" && primitive.radiusMm !== undefined
      );
      assert(conductorPrimitives.every((primitive) => primitive.segmentsMm !== undefined && primitive.segmentsMm.length % 6 === 0), "solid conductor previews should expose an explicit deduplicated branch graph");
      assert(conductorPrimitives.some((primitive) => primitive.segmentsMm!.length < Math.max(0, primitive.pointsMm.length / 3 - 1) * 6), "a multidrop conductor should remove retraced branch segments before solid rendering");
      assert(conductorPrimitives.every((primitive) => {
        const keys = Array.from({ length: primitive.segmentsMm!.length / 6 }, (_, index) => primitive.segmentsMm!.slice(index * 6, index * 6 + 6).join(","));
        return new Set(keys).size === keys.length;
      }), "deduplicated conductor previews should never contain duplicate undirected segments");
      const nearLimitElectrical = {
        ...createElectricalTemplate("dc-control"),
        components: Array.from({ length: 16 }, (_, index) => createElectricalComponentInstance("inverter", `electrical-component:detail-${index + 1}`, `PCS${index + 1}`, [100 + index * 40, 100])),
        nets: []
      };
      const nearLimitAssembly = createElectromechanicalAssembly(nearLimitElectrical, "panel-backplate", defaultElectromechanicalMappings(nearLimitElectrical));
      assert(nearLimitAssembly.ok, "a verified sixteen-device mounting plate should realize at the supported boundary");
      const nearLimitScene = buildAssemblyPreview(nearLimitAssembly.value);
      const expectedTerminalCount = nearLimitElectrical.components.reduce((count, component) => count + ELECTROMECHANICAL_CATALOG.find((part) => part.kind === component.kind)!.terminals.length, 0);
      equal(nearLimitScene.primitives.filter((primitive) => primitive.id.startsWith("detail:panel-terminal:")).length, expectedTerminalCount, "terminal studs must outrank decorative panel detail at the supported device limit");
      equal(nearLimitScene.primitives.filter((primitive) => primitive.id.startsWith("detail:panel-face:")).length, 16, "every supported device should retain a recognizable front face before infrastructure decoration");
      const envelope = generated.value.nominalEnvelopeMm!;
      assert(scene.boundsMm.size.every((size, axis) => size <= envelope[axis]! + 1e-6), "generated geometry should remain inside the declared layout envelope");
      equal(findAssemblyInterference(generated.value).length, 0, "the generated package layout should have no unexplained AABB overlaps");
    }
  },
  {
    name: "realization operation is atomic, idempotent, and marked stale after schematic movement",
    run: () => {
      const project = createWorkbenchProject("project:test-em-operation");
      const operation = {
        kind: "generate-electromechanical-realization",
        operationId: "operation:test-em-generate",
        expectedRevision: 0,
        catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
        layoutPreset: preferredElectromechanicalLayout(project.electrical),
        mappings: defaultElectromechanicalMappings(project.electrical),
        replaceMode: "replace-assembly"
      } as const;
      const applied = applyWorkbenchOperation(project, operation);
      assert(applied.ok, "realization should apply as one revision");
      equal(applied.value.project.revision, 1, "realization should be atomic");
      const retry = applyWorkbenchOperation(applied.value.project, operation);
      assert(retry.ok && retry.value.exactRetry, "an exact retry should not duplicate geometry or revision");
      const first = applied.value.project.electrical.components[0]!;
      const moved = applyWorkbenchOperation(applied.value.project, { kind: "set-electrical-component-position", operationId: "operation:test-em-move", expectedRevision: 1, componentId: first.id, position: [first.position[0] + 10, first.position[1]] });
      assert(moved.ok, "schematic movement should apply");
      equal(moved.value.project.assembly.electromechanicalSource?.status, "stale", "physical trace should never stay current after topology-layout input changes");

      const linked = applied.value.project.assembly.electricalLinks?.[0];
      assert(linked !== undefined, "generated assembly should retain a linked component");
      const body = applied.value.project.assembly.components.find((component) => component.id === linked.assemblyComponentId)!;
      const movedBody = applyWorkbenchOperation(applied.value.project, { kind: "set-component-translation", operationId: "operation:test-em-body-move", expectedRevision: 1, componentId: body.id, translationMm: [body.translationMm[0] + 25, body.translationMm[1], body.translationMm[2]] });
      assert(movedBody.ok, "a linked package planning move should remain editable");
      equal(movedBody.value.project.assembly.electromechanicalSource?.status, "stale", "moving a linked package must stale the fixed route geometry");
      assert(validateWorkbenchProject(movedBody.value.project).ok, "a visibly stale realization should remain a valid historical project state");
      const deletedBody = applyWorkbenchOperation(applied.value.project, { kind: "delete-assembly-component", operationId: "operation:test-em-body-delete", expectedRevision: 1, componentId: body.id });
      assert(!deletedBody.ok, "a linked package must not be deleted outside the reviewed whole-realization workflow");
    }
  },
  {
    name: "current ECAD to MCAD trace rejects cross-domain corruption and ambiguous ERC input",
    run: async () => {
      const guideAcknowledgement = await currentGuideAcknowledgement();
      const electrical = createElectricalTemplate("bess-single-line");
      const generated = createElectromechanicalAssembly(electrical, "panel-backplate", defaultElectromechanicalMappings(electrical));
      assert(generated.ok, "the built-in realization should generate");
      const project = { ...createWorkbenchProject("project:test-em-cross-domain"), electrical, assembly: generated.value };
      assert(validateWorkbenchProject(project).ok, "the intact cross-domain trace should validate");
      const corrupted = { ...project, assembly: { ...project.assembly, electricalLinks: project.assembly.electricalLinks!.map((link, index) => index === 0 ? { ...link, electricalComponentId: "electrical-component:missing" } : link) } };
      assert(!validateWorkbenchProject(corrupted).ok, "a current link to a missing electrical component must be rejected");
      const disconnected = { ...project, assembly: { ...project.assembly, electricalRoutes: project.assembly.electricalRoutes!.map((route, index) => index === 0 ? { ...route, pointsMm: route.pointsMm.map((point, pointIndex) => pointIndex === 0 ? [point[0] + 5, point[1], point[2]] as const : point) } : route) } };
      assert(!validateWorkbenchProject(disconnected).ok, "a current route endpoint detached from its mapped terminal must be rejected");
      const rerouted = { ...project, assembly: { ...project.assembly, electricalRoutes: project.assembly.electricalRoutes!.map((route, index) => index === 0 ? { ...route, pointsMm: route.pointsMm.map((point, pointIndex) => pointIndex === 1 ? [point[0] + 5, point[1], point[2]] as const : point) } : route) } };
      assert(!validateWorkbenchProject(rerouted).ok, "an unreviewed intermediate route-point change must be rejected while the trace is current");
      const firstLink = project.assembly.electricalLinks![0]!;
      const corruptedGeometry = { ...project, assembly: { ...project.assembly, components: project.assembly.components.map((body) => body.id === firstLink.assemblyComponentId ? { ...body, sizeMm: [body.sizeMm[0] + 1, body.sizeMm[1], body.sizeMm[2]] as const, rotationDeg: [0, 0, 5] as const } : body) } };
      assert(!validateWorkbenchProject(corruptedGeometry).ok, "a current linked body with unreviewed geometry or rotation must be rejected");
      const firstRail = project.assembly.components.find((body) => body.id.startsWith("component:em-din-rail-"))!;
      const corruptedInfrastructure = { ...project, assembly: { ...project.assembly, components: project.assembly.components.map((body) => body.id === firstRail.id ? { ...body, color: "#ff00ff" } : body) } };
      assert(!validateWorkbenchProject(corruptedInfrastructure).ok, "current DIN-rail and duct infrastructure must remain an exact generated set");
      const battery = electrical.components.find((component) => component.kind === "battery")!;
      const polaritySwapped = { ...project, assembly: { ...project.assembly, electricalLinks: project.assembly.electricalLinks!.map((link) => link.electricalComponentId === battery.id ? { ...link, terminalMap: link.terminalMap.map((terminal) => ({ electricalTerminal: terminal.electricalTerminal, catalogTerminal: terminal.catalogTerminal === "P" ? "N" : "P" })) } : link) } };
      assert(!validateWorkbenchProject(polaritySwapped).ok, "a current link with an unreviewed polarity swap must be rejected");

      const ambiguous = { ...electrical, components: electrical.components.map((component, index) => index === 1 ? { ...component, reference: electrical.components[0]!.reference } : component) };
      equal(analyzeElectromechanicalReadiness(ambiguous).status, "blocked", "duplicate references must block realization in core");
      const ambiguousProject = { ...createWorkbenchProject("project:test-em-erc"), electrical: ambiguous };
      const preview = await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project: ambiguousProject, guideAcknowledgement });
      assert(preview.isError === true, "MCP must not receipt-gate an electrically ambiguous realization");
    }
  },
  {
    name: "electromechanical generation and dedicated MCP receipts are deterministic",
    run: async () => {
      const guideAcknowledgement = await currentGuideAcknowledgement();
      const electrical = createElectricalTemplate("dc-control");
      const mappings = defaultElectromechanicalMappings(electrical);
      const first = createElectromechanicalAssembly(electrical, "panel-backplate", mappings);
      const second = createElectromechanicalAssembly(electrical, "panel-backplate", [...mappings].reverse());
      assert(first.ok && second.ok, "both deterministic realizations should generate");
      equal(JSON.stringify(first.value), JSON.stringify(second.value), "mapping input order must not change realization bytes");
      const project = { ...createWorkbenchProject("project:test-em-determinism"), electrical };
      const previewA = await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project, guideAcknowledgement });
      const previewB = await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project, guideAcknowledgement });
      equal(previewA.structuredContent["receipt"], previewB.structuredContent["receipt"], "identical project inputs must produce identical realization receipts");
      const blockedSource = createElectricalComponentInstance("fuse", "electrical-component:mcp-blocked-source", "F82", [1_050, 200]);
      const blockedTarget = createElectricalComponentInstance("fuse", "electrical-component:mcp-blocked-target", "F83", [900, 500]);
      const blockedElectrical = { ...electrical, components: [blockedSource, blockedTarget], nets: [{ id: "electrical-net:mcp-blocked", name: "MCP BLOCKED ROUTE", class: "control" as const, endpoints: [{ componentId: blockedSource.id, terminal: "2" }, { componentId: blockedTarget.id, terminal: "1" }] }] };
      const blockedPreview = await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project: { ...createWorkbenchProject("project:test-em-mcp-blocked"), electrical: blockedElectrical }, guideAcknowledgement });
      assert(blockedPreview.isError === true && blockedPreview.content.some((item) => item.type === "text" && item.text.includes("no clear orthogonal sheet route")), "the dedicated MCP preview must enforce the same blocked-route invariant as direct core generation");
    }
  },
  {
    name: "MCP exposes local catalog and a receipt-gated realization preview",
    run: async () => {
      const guideAcknowledgement = await currentGuideAcknowledgement();
      const catalog = await handleWorkbenchMcpTool("ps3d_electromechanical_catalog", {});
      assert(catalog.isError !== true, "catalog discovery should be read-only and callable");
      equal((catalog.structuredContent["parts"] as readonly unknown[]).length, ELECTROMECHANICAL_CATALOG.length, "MCP catalog should match the in-process catalog");
      const project = createWorkbenchProject("project:test-em-mcp");
      const preview = await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project, guideAcknowledgement });
      assert(preview.isError !== true, "MCP should prepare a deterministic realization preview");
      assert(typeof preview.structuredContent["receipt"] === "string", "preview should return a receipt");
      equal((preview.structuredContent["operation"] as { kind: string }).kind, "generate-electromechanical-realization", "preview should return the exact bounded operation");
      assert((preview.structuredContent["replacementScope"] as { candidateAssembly?: unknown }).candidateAssembly !== undefined, "dedicated preview should expose the full replacement candidate");
      assert((preview.structuredContent["replacementScope"] as { removedAssembly?: unknown }).removedAssembly !== undefined, "dedicated preview should expose the complete prior Assembly snapshot");
      assert(Array.isArray((preview.structuredContent["erc"] as { issues?: unknown }).issues), "dedicated preview should expose every ERC issue");
      const generic = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: preview.structuredContent["operation"], guideAcknowledgement });
      equal(generic.structuredContent["code"], "DEDICATED_PREVIEW_REQUIRED", "generic preview must not bypass electromechanical disclosure");
      const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation: preview.structuredContent["operation"], receipt: preview.structuredContent["receipt"], confirmed: true, guideAcknowledgement });
      assert(applied.isError !== true, "the dedicated disclosure receipt should gate confirmed apply");
    }
  },
  {
    name: "source signatures cover engineering text and stale traces remain internally linked",
    run: () => {
      const electrical = createElectricalTemplate("bess-single-line");
      const generated = createElectromechanicalAssembly(electrical, "equipment-lineup", defaultElectromechanicalMappings(electrical), 0);
      assert(generated.ok, "the reviewed realization should generate");
      equal(generated.value.electromechanicalSource?.sourceElectricalId, electrical.id, "source identity should be explicit");
      equal(generated.value.electromechanicalSource?.sourceProjectRevision, 0, "source project revision should be explicit");
      const changedValue = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, value: `${component.value} UPDATED` } : component) };
      const changedRotation = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, rotationDeg: 90 } : component) };
      const changedNet = { ...electrical, nets: electrical.nets.map((net, index) => index === 0 ? { ...net, name: `${net.name} UPDATED` } : net) };
      const changedNotes = { ...electrical, notes: `${electrical.notes} UPDATED` };
      assert(electricalSignature(changedValue) !== electricalSignature(electrical), "component values must participate in the source signature");
      assert(electricalSignature(changedRotation) !== electricalSignature(electrical), "component rotation must participate in the source signature");
      assert(electricalSignature(changedNet) !== electricalSignature(electrical), "net names must participate in the source signature");
      assert(electricalSignature(changedNotes) !== electricalSignature(electrical), "engineering notes must participate in the source signature");
      const base = { ...createWorkbenchProject("project:test-em-signature"), electrical, assembly: generated.value };
      const noted = applyWorkbenchOperation(base, { kind: "set-electrical-notes", operationId: "operation:test-em-notes", expectedRevision: 0, notes: changedNotes.notes });
      assert(noted.ok && noted.value.project.assembly.electromechanicalSource?.status === "stale", "notes edits must stale the linked realization");
      const brokenStale = { ...noted.value.project, assembly: { ...noted.value.project.assembly, electricalRoutes: noted.value.project.assembly.electricalRoutes!.map((route, index) => index === 0 ? { ...route, endpoints: route.endpoints.map((endpoint, endpointIndex) => endpointIndex === 0 ? { ...endpoint, componentId: "electrical-component:missing" } : endpoint) } : route) } };
      assert(!validateWorkbenchProject(brokenStale).ok, "stale route endpoints must remain covered by retained links and terminal maps");
      const futureStale = { ...noted.value.project, assembly: { ...noted.value.project.assembly, electromechanicalSource: { ...noted.value.project.assembly.electromechanicalSource!, sourceProjectRevision: noted.value.project.revision + 1 } } };
      assert(!validateWorkbenchProject(futureStale).ok, "stale trace evidence must not claim a future source revision");
      const remappedStale = { ...noted.value.project, assembly: { ...noted.value.project.assembly, electricalLinks: noted.value.project.assembly.electricalLinks!.map((link, index) => index === 0 ? { ...link, terminalMap: [...link.terminalMap].reverse().map((terminal, terminalIndex, all) => ({ ...terminal, catalogTerminal: all[(terminalIndex + 1) % all.length]!.catalogTerminal })) } : link) } };
      assert(!validateWorkbenchProject(remappedStale).ok, "stale trace evidence must reject unreviewed terminal remapping");
      const missingMates = { ...base, assembly: { ...base.assembly, mates: [] } };
      const missingSafety = { ...base, assembly: { ...base.assembly, safetyNotes: [] } };
      const changedStatus = { ...base, assembly: { ...base.assembly, designStatus: "editable-preview" as const } };
      assert(!validateWorkbenchProject(missingMates).ok, "a current realization must retain every generated fixed mate");
      assert(!validateWorkbenchProject(missingSafety).ok, "a current realization must retain its safety boundary");
      assert(!validateWorkbenchProject(changedStatus).ok, "a current realization must retain its protected design status");
      const legacyCatalog = { ...base, assembly: { ...base.assembly, electromechanicalSource: { ...base.assembly.electromechanicalSource!, catalogRevision: "ps3d-generic-em/1" } } };
      const migratedLegacy = validateWorkbenchProject(legacyCatalog);
      assert(migratedLegacy.ok && migratedLegacy.value.assembly.electromechanicalSource?.status === "stale", "revision-1 generic layouts should load only as visibly stale historical evidence");
    }
  },
  {
    name: "realization rejects direct self-shorts and deterministic ID aliasing",
    run: () => {
      const electrical = createElectricalTemplate("bess-single-line");
      const battery = electrical.components.find((component) => component.kind === "battery")!;
      const selfShort = { ...electrical, nets: [{ ...electrical.nets[0]!, endpoints: [{ componentId: battery.id, terminal: "P" }, { componentId: battery.id, terminal: "N" }] }, ...electrical.nets.slice(1)] };
      equal(analyzeElectromechanicalReadiness(selfShort).status, "blocked", "a direct same-component terminal join must block realization");
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-self-short"), electrical: selfShort }).ok, "a direct self-short must fail canonical schema validation");
      const inverter = electrical.components.find((component) => component.kind === "inverter")!;
      const roleMismatch = { ...electrical, nets: [{ ...electrical.nets[0]!, endpoints: [{ componentId: battery.id, terminal: "P" }, { componentId: inverter.id, terminal: "AC" }] }, ...electrical.nets.slice(1)] };
      assert(analyzeElectromechanicalReadiness(roleMismatch).blockingErrors.some((error) => error.includes("incompatible with power-dc")), "DC realization must block AC and protective-earth terminal roles");
      assert(createElectricalSchematic(roleMismatch).erc.issues.some((issue) => issue.severity === "error" && issue.id.startsWith("erc:role-")), "ERC must expose terminal-role/net-class mismatches");
      const terminalSubset = { ...electrical, components: electrical.components.map((component) => component.id === battery.id ? { ...component, terminals: ["P"] } : component) };
      assert(analyzeElectromechanicalReadiness(terminalSubset).blockingErrors.some((error) => error.includes("must exactly match")), "readiness must reject omitted catalog terminals");
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-terminal-subset"), electrical: terminalSubset }).ok, "canonical schema must reject terminal subsets");
      const hiddenPosition = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, position: [1_200, 150] as const } : component) };
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-panel-overlap"), electrical: hiddenPosition }).ok, "component centers inside reserved sheet panels must be rejected");
      const constrained = constrainElectricalSheetPosition([1_200, 150]);
      assert(isElectricalSheetPositionAvailable(constrained), "interactive placement must move the complete symbol footprint outside the reserved BOM region");
      const labelOverErc = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, position: [600, 581] as const } : component) };
      const labelOverTitle = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, position: [1_200, 599] as const } : component) };
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-erc-footprint"), electrical: labelOverErc }).ok, "label footprints must remain outside the ERC overlay");
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-title-footprint"), electrical: labelOverTitle }).ok, "label footprints must remain outside the release-title overlay");
      const rotatedOverBom = { ...electrical, components: electrical.components.map((component, index) => index === 0 ? { ...component, position: [1_039, 200] as const, rotationDeg: -90 } : component) };
      assert(!validateWorkbenchProject({ ...createWorkbenchProject("project:test-em-rotated-footprint"), electrical: rotatedOverBom }).ok, "rotated symbols and labels must remain outside the concept BOM");

      const routePortalSource = createElectricalComponentInstance("fuse", "electrical-component:blocked-route-source", "F80", [1_050, 200]);
      const routePortalTarget = createElectricalComponentInstance("fuse", "electrical-component:blocked-route-target", "F81", [900, 500]);
      const blockedRouteElectrical = { ...createElectricalTemplate("dc-control"), components: [routePortalSource, routePortalTarget], nets: [{ id: "electrical-net:blocked-route", name: "BLOCKED ROUTE", class: "control" as const, endpoints: [{ componentId: routePortalSource.id, terminal: "2" }, { componentId: routePortalTarget.id, terminal: "1" }] }] };
      const blockedRouteProject = { ...createWorkbenchProject("project:test-em-blocked-route"), electrical: blockedRouteElectrical };
      assert(validateWorkbenchProject(blockedRouteProject).ok, "the blocked-route fixture should remain canonical input");
      assert(analyzeElectromechanicalReadiness(blockedRouteElectrical).blockingErrors.some((error) => error.includes("no clear orthogonal sheet route")), "shared readiness must expose an unroutable schematic net");
      const blockedRouteApply = applyWorkbenchOperation(blockedRouteProject, { kind: "generate-electromechanical-realization", operationId: "operation:test-em-blocked-route", expectedRevision: blockedRouteProject.revision, catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION, layoutPreset: preferredElectromechanicalLayout(blockedRouteElectrical), mappings: defaultElectromechanicalMappings(blockedRouteElectrical), replaceMode: "replace-assembly" });
      assert(!blockedRouteApply.ok && blockedRouteApply.diagnostics.some((item) => item.message.includes("no clear orthogonal sheet route")), "the core mutation boundary must reject generation when the shared router blocks a net");

      const firstId = electrical.components[0]!.id;
      const secondId = electrical.components[1]!.id;
      const aliases = new Map([[firstId, "electrical-component:a_b"], [secondId, "electrical-component:a-b"]]);
      const aliased = {
        ...electrical,
        components: electrical.components.map((component) => ({ ...component, id: aliases.get(component.id) ?? component.id })),
        nets: electrical.nets.map((net) => ({ ...net, endpoints: net.endpoints.map((endpoint) => ({ ...endpoint, componentId: aliases.get(endpoint.componentId) ?? endpoint.componentId })) }))
      };
      const realized = createElectromechanicalAssembly(aliased, "equipment-lineup", defaultElectromechanicalMappings(aliased));
      assert(realized.ok, "valid punctuation-distinct source IDs should realize without aliasing");
      const generatedIds = realized.value.electricalLinks!.map((link) => link.assemblyComponentId);
      equal(new Set(generatedIds).size, generatedIds.length, "deterministic physical IDs must remain unique");
    }
  }
];

async function currentGuideAcknowledgement(): Promise<Readonly<Record<string, unknown>>> {
  const guide = await handleWorkbenchMcpTool("ps3d_guide", {});
  const manifestSha256 = guide.structuredContent["manifestSha256"];
  assert(typeof manifestSha256 === "string", "guide should provide a manifest digest");
  return { manifestSha256, understood: true };
}
