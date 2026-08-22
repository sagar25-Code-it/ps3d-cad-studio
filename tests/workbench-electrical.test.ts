import {
  applyWorkbenchOperation,
  constrainElectricalSheetPosition,
  ELECTRICAL_ROUTING_WORK_BUDGET,
  createElectricalComponentInstance,
  createElectricalRoutePlan,
  createElectricalTemplate,
  createWorkbenchProject,
  validateWorkbenchProject,
  type ElectricalIntent
} from "../packages/workbench-core/src/index.js";
import { createElectricalSchematic, runElectricalRuleCheck } from "../packages/workbench-electrical/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchElectricalTests: readonly TestCase[] = [
  {
    name: "automatic electrical templates contain valid connected endpoints",
    run: () => {
      for (const template of ["bess-single-line", "dc-control", "motor-starter"] as const) {
        const electrical = createElectricalTemplate(template);
        const project = createWorkbenchProject(`project:test-${template}`);
        const valid = validateWorkbenchProject({ ...project, electrical });
        assert(valid.ok, `${template} should validate`);
        const components = new Map(electrical.components.map((component) => [component.id, component]));
        for (const net of electrical.nets) for (const endpoint of net.endpoints) {
          assert(components.get(endpoint.componentId)?.terminals.includes(endpoint.terminal), `${net.name} should reference a declared terminal`);
        }
      }
    }
  },
  {
    name: "electrical SVG is deterministic, review-labeled, and structurally escaped",
    run: () => {
      const base = createElectricalTemplate("dc-control");
      const intent: ElectricalIntent = {
        ...base,
        title: "DC <auxiliary> & review",
        notes: "Engineer <verify> & approve before release."
      };
      const first = createElectricalSchematic(intent);
      const second = createElectricalSchematic(intent);
      equal(first.svg, second.svg, "the same electrical intent should create byte-identical SVG");
      assert(first.svg.includes("NOT FOR CONSTRUCTION"), "sheet should carry the construction boundary");
      assert(first.svg.includes("DC &lt;auxiliary&gt; &amp; review"), "untrusted sheet text should be XML escaped");
      assert(!first.svg.includes("<auxiliary>"), "raw injected markup should not survive");
      assert(first.erc.errors === 0, `seeded DC template should have no broken connectivity errors: ${first.erc.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" | ")}`);
      const left = createElectricalComponentInstance("fuse", "electrical-component:route-left", "F20", [1_000, 200]);
      const right = createElectricalComponentInstance("fuse", "electrical-component:route-right", "F21", [1_400, 350]);
      const routed = createElectricalSchematic({ ...base, components: [left, right], nets: [{ id: "electrical-net:panel-avoidance", name: "PANEL AVOIDANCE", class: "control", endpoints: [{ componentId: left.id, terminal: "2" }, { componentId: right.id, terminal: "1" }] }] });
      const routePath = routed.svg.match(/data-net-id="electrical-net:panel-avoidance">(?:<title>.*?<\/title>)?<path[^>]+d="([^"]+)"/u)?.[1];
      assert(routePath !== undefined && !routePath.includes("H 1200 V 350"), `orthogonal routing should avoid the blocked BOM midpoint corridor; received ${routePath ?? "no route"}`);
      const routeStart = createElectricalComponentInstance("fuse", "electrical-component:route-start", "F30", [250, 330]);
      const routeObstacle = createElectricalComponentInstance("fuse", "electrical-component:route-obstacle", "F31", [600, 330]);
      const routeEnd = createElectricalComponentInstance("fuse", "electrical-component:route-end", "F32", [950, 330]);
      const componentAvoidance = createElectricalSchematic({ ...base, components: [routeStart, routeObstacle, routeEnd], nets: [{ id: "electrical-net:component-avoidance", name: "COMPONENT AVOIDANCE", class: "control", endpoints: [{ componentId: routeStart.id, terminal: "2" }, { componentId: routeEnd.id, terminal: "1" }] }] });
      const componentAvoidancePath = componentAvoidance.svg.match(/data-net-id="electrical-net:component-avoidance">(?:<title>.*?<\/title>)?<path[^>]+d="([^"]+)"/u)?.[1];
      assert(componentAvoidancePath?.includes("V") === true, "a route must visibly detour around an unrelated component instead of implying a false connection");
      const endpointSafePlan = createElectricalRoutePlan({ ...base, components: [routeStart, routeEnd], nets: [
        { id: "electrical-net:endpoint-safe-one", name: "ENDPOINT SAFE ONE", class: "control", endpoints: [{ componentId: routeStart.id, terminal: "1" }, { componentId: routeEnd.id, terminal: "1" }] },
        { id: "electrical-net:endpoint-safe-two", name: "ENDPOINT SAFE TWO", class: "control", endpoints: [{ componentId: routeStart.id, terminal: "2" }, { componentId: routeEnd.id, terminal: "2" }] }
      ] });
      equal(endpointSafePlan.blockedNetIds.length, 0, "two distinct same-row nets should route without crossing their endpoint symbols");
      equal(endpointSafePlan.routes.length, 2, "both distinct nets should receive deterministic routes");
      assert(endpointSafePlan.routes[0]!.path.includes("V") && endpointSafePlan.routes[1]!.path.includes("V"), "same-side terminals must escape outward and visibly detour instead of traversing their own symbols");
      for (const firstSegment of endpointSafePlan.routes[0]!.segments) for (const secondSegment of endpointSafePlan.routes[1]!.segments) {
        assert(!collinearOverlap(firstSegment, secondSegment), "distinct nets must not share a collinear rendered segment");
      }
      const fullValue = "V".repeat(100);
      const longTextComponent = { ...createElectricalComponentInstance("fuse", "electrical-component:long-text", "R".repeat(24), [768, 532]), label: "L".repeat(80), value: fullValue };
      const longTextIntent = { ...base, components: [longTextComponent], nets: [] };
      const longTextSvg = createElectricalSchematic(longTextIntent).svg;
      assert(validateWorkbenchProject({ ...createWorkbenchProject("project:test-electrical-long-text"), electrical: longTextIntent }).ok, "schema-limit text should remain valid at a footprint-safe position");
      assert(longTextSvg.includes(fullValue) && longTextSvg.includes(`${"V".repeat(21)}…`) && longTextSvg.includes('textLength="132"'), "the SVG should retain full text in its title while width-bounding the on-sheet display string");
      const manyBomComponents = Array.from({ length: 9 }, (_, index) => ({ ...createElectricalComponentInstance("fuse", `electrical-component:bom-${index + 1}`, `F${index + 101}`, [160 + index % 6 * 190, 250 + Math.floor(index / 6) * 220]), label: `Device group ${index + 1}`, value: `VALUE ${index + 1}` }));
      const manyBomSvg = createElectricalSchematic({ ...base, components: manyBomComponents, nets: [] }).svg;
      assert(manyBomSvg.includes("8/9 SHOWN") && manyBomSvg.includes("COMPLETE 9-ROW INDEX IN SVG METADATA") && manyBomSvg.includes('id="ps3d-electrical-export-data"') && manyBomSvg.includes("Device group 9"), "an overflowing visible device index must disclose the partial table and retain the complete continuation in SVG metadata");
      const denseComponents = Array.from({ length: 100 }, (_, index) => createElectricalComponentInstance(
        "fuse",
        `electrical-component:dense-${index + 1}`,
        `FD${index + 1}`,
        [150 + index % 10 * 100, 200 + Math.floor(index / 10) % 4 * 100]
      ));
      const denseNets = Array.from({ length: 200 }, (_, index) => ({
        id: `electrical-net:dense-${index + 1}`,
        name: `DENSE ROUTE ${index + 1}`,
        class: "control" as const,
        endpoints: [
          { componentId: denseComponents[index % denseComponents.length]!.id, terminal: index % 2 === 0 ? "1" : "2" },
          { componentId: denseComponents[(index * 37 + 17) % denseComponents.length]!.id, terminal: index % 2 === 0 ? "2" : "1" }
        ]
      } satisfies ElectricalIntent["nets"][number]));
      const denseIntent: ElectricalIntent = { ...base, components: denseComponents, nets: denseNets };
      const denseValidation = validateWorkbenchProject({ ...createWorkbenchProject("project:test-electrical-route-limit"), electrical: denseIntent });
      assert(denseValidation.ok, `the 100-component/200-net routing fixture should remain canonical input: ${denseValidation.ok ? "valid" : denseValidation.diagnostics.map((item) => item.message).join(" | ")}`);
      const denseStartedAt = Date.now();
      const densePlan = createElectricalRoutePlan(denseIntent);
      const denseElapsedMs = Date.now() - denseStartedAt;
      equal(densePlan.routes.length + densePlan.blockedNetIds.length, denseNets.length, "every near-limit net must be classified as routed or fail-closed");
      assert(densePlan.workUnits <= ELECTRICAL_ROUTING_WORK_BUDGET && densePlan.workBudget === ELECTRICAL_ROUTING_WORK_BUDGET, "the production router must not exceed its deterministic work budget");
      assert(denseElapsedMs < 2_000, `the near-limit routing pass should complete within the interactive regression guard; received ${denseElapsedMs} ms`);
      const deliberatelyBounded = createElectricalRoutePlan(denseIntent, 32);
      equal(deliberatelyBounded.workUnits, 32, "an explicit small routing budget must stop at the exact work-unit boundary");
      assert(deliberatelyBounded.budgetExceededNetIds.length > 0 && deliberatelyBounded.budgetExceededNetIds.every((id) => deliberatelyBounded.blockedNetIds.includes(id)), "budget exhaustion must identify every affected net as blocked instead of returning an incomplete route");
    }
  },
  {
    name: "electrical rule check reports duplicate references and open terminals",
    run: () => {
      const base = createElectricalTemplate("motor-starter");
      const extra = createElectricalComponentInstance("fuse", "electrical-component:test-duplicate", "QF1", [1_300, 520]);
      const issues = runElectricalRuleCheck({ ...base, components: [...base.components, extra] });
      assert(issues.some((issue) => issue.severity === "error" && issue.message.includes("QF1")), "duplicate reference should be an ERC error");
      assert(issues.some((issue) => issue.severity === "warning" && issue.message.includes("not connected")), "unwired inserted terminals should be visible warnings");
    }
  },
  {
    name: "electrical rule check rejects one terminal assigned to multiple named nets",
    run: () => {
      const base = createElectricalTemplate("motor-starter");
      const first = base.nets[0]!;
      const duplicatedEndpoint = first.endpoints[0]!;
      const intent = { ...base, nets: [...base.nets, { id: "electrical-net:test-terminal-reuse", name: "CONFLICTING NET", class: "control" as const, endpoints: [duplicatedEndpoint, base.nets[1]!.endpoints[1]!] }] };
      const issues = runElectricalRuleCheck(intent);
      assert(issues.some((issue) => issue.severity === "error" && issue.message.includes("more than one named net")), "terminal reuse should be an ERC error");
    }
  },
  {
    name: "electrical operations add devices and pin-to-pin nets atomically",
    run: () => {
      const project = createWorkbenchProject("project:test-electrical-operations");
      const component = createElectricalComponentInstance("sensor", "electrical-component:test-sensor", "B2", [1_320, 520]);
      const inserted = applyWorkbenchOperation(project, { kind: "add-electrical-component", operationId: "operation:test-electrical-insert", expectedRevision: 0, component });
      assert(inserted.ok, "an electrical component should insert");
      const source = inserted.value.project.electrical.components[0]!;
      const net = { id: "electrical-net:test-sensor", name: "TEST SIGNAL", class: "control", endpoints: [{ componentId: source.id, terminal: source.terminals[0]! }, { componentId: component.id, terminal: "1" }] } as const;
      const connected = applyWorkbenchOperation(inserted.value.project, { kind: "add-electrical-net", operationId: "operation:test-electrical-net", expectedRevision: 1, net });
      assert(connected.ok, "declared terminals should connect");
      equal(connected.value.project.electrical.nets.at(-1)?.name, "TEST SIGNAL", "net should be persisted");
      equal(connected.value.project.revision, 2, "device plus net should create two revisions");
    }
  },
  {
    name: "schematic component coordinates stay inside the canonical visible sheet envelope",
    run: () => {
      const project = createWorkbenchProject("project:test-electrical-sheet-envelope");
      const target = project.electrical.components[0]!;
      const safeBoundary = constrainElectricalSheetPosition([72, 135], target.rotationDeg);
      const boundary = applyWorkbenchOperation(project, { kind: "set-electrical-component-position", operationId: "operation:test-electrical-boundary", expectedRevision: 0, componentId: target.id, position: safeBoundary });
      assert(boundary.ok, "the nearest footprint-safe top-left sheet boundary should remain editable");
      const outside = applyWorkbenchOperation(project, { kind: "set-electrical-component-position", operationId: "operation:test-electrical-outside", expectedRevision: 0, componentId: target.id, position: [1_529, 135] });
      assert(!outside.ok, "an off-sheet position must be rejected by the operation boundary");
      const invalidProject = { ...project, electrical: { ...project.electrical, components: project.electrical.components.map((component, index) => index === 0 ? { ...component, position: [9_999, 135] as const } : component) } };
      assert(!validateWorkbenchProject(invalidProject).ok, "off-sheet schema input must not validate");
      const offSheetInsert = createElectricalComponentInstance("sensor", "electrical-component:test-off-sheet", "B99", [9_999, 135]);
      const inserted = applyWorkbenchOperation(project, { kind: "add-electrical-component", operationId: "operation:test-electrical-off-sheet-insert", expectedRevision: 0, component: offSheetInsert });
      assert(!inserted.ok, "new components must also respect the canonical sheet envelope");
    }
  },
  {
    name: "schema-1 projects without electrical data migrate locally",
    run: () => {
      const current = createWorkbenchProject("project:test-electrical-migration");
      const legacy = structuredClone(current) as unknown as Record<string, unknown>;
      delete legacy["electrical"];
      const migrated = validateWorkbenchProject(legacy);
      assert(migrated.ok, "legacy schema-1 project should migrate rather than fail");
      equal(migrated.value.electrical.template, "bess-single-line", "migration should seed the safe conceptual template");
    }
  }
];

function collinearOverlap(left: { readonly start: readonly [number, number]; readonly end: readonly [number, number] }, right: { readonly start: readonly [number, number]; readonly end: readonly [number, number] }): boolean {
  const leftHorizontal = left.start[1] === left.end[1];
  const rightHorizontal = right.start[1] === right.end[1];
  if (leftHorizontal && rightHorizontal && left.start[1] === right.start[1]) return intervalOverlap(left.start[0], left.end[0], right.start[0], right.end[0]);
  if (!leftHorizontal && !rightHorizontal && left.start[0] === right.start[0]) return intervalOverlap(left.start[1], left.end[1], right.start[1], right.end[1]);
  return false;
}

function intervalOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) - Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd)) > 0.001;
}
