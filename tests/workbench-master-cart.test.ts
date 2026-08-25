import {
  applyWorkbenchOperation,
  buildMasterCartItem,
  createMasterCartConfiguration,
  createWorkbenchProject,
  MASTER_CART_CATEGORIES,
  MASTER_CART_TEMPLATES,
  masterCartTemplate
} from "../packages/workbench-core/src/index.js";
import { buildAssemblyPreview, findAssemblyInterference } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchMasterCartTests: readonly TestCase[] = [
  {
    name: "Master Cart covers every requested component category with original source references",
    run: () => {
      equal(MASTER_CART_CATEGORIES.length, 10, "the requested catalog should have ten visible category groups");
      equal(MASTER_CART_TEMPLATES.length, 25, "the curated catalog should expose twenty-five ready parametric families");
      for (const category of MASTER_CART_CATEGORIES) {
        assert(MASTER_CART_TEMPLATES.some((template) => template.categoryId === category.id), `${category.id} needs at least one ready template`);
        assert(category.sourceUrl.startsWith("https://www.mcmaster.com/products/"), `${category.id} should use an explicit category reference link`);
      }
      assert(MASTER_CART_TEMPLATES.every((template) => template.sourceUrl.startsWith("https://www.mcmaster.com/products/")), "templates should link only to the related McMaster category page");
      assert(MASTER_CART_TEMPLATES.every((template) => !template.description.toLowerCase().includes("mcmaster")), "template descriptions should remain original PS3D copy rather than supplier marketing text");
    }
  },
  {
    name: "every Master Cart default builds finite validated grouped assembly geometry",
    run: () => {
      for (const template of MASTER_CART_TEMPLATES) {
        const configuration = createMasterCartConfiguration(template.id);
        const built = buildMasterCartItem(template.id, configuration, `master-cart:test-${template.id}`);
        assert(built.components.length >= 1 && built.components.length <= 32, `${template.id} should generate a bounded multipart item`);
        equal(new Set(built.components.map((component) => component.id)).size, built.components.length, `${template.id} component IDs should be unique`);
        assert(built.components.every((component) => component.masterCart?.templateId === template.id), `${template.id} bodies need grouped trace metadata`);
        assert(built.components.every((component) => component.sizeMm.every((value) => Number.isFinite(value) && value > 0)), `${template.id} dimensions must be finite and positive`);
        const project = createWorkbenchProject(`project:test-${template.id}`);
        const inserted = applyWorkbenchOperation(project, { kind: "add-assembly-components", operationId: `operation:test-${template.id}`, expectedRevision: 0, components: built.components });
        assert(inserted.ok, `${template.id} should pass the same validation used by Assembly insertion`);
      }
    }
  },
  {
    name: "socket-head fastener provides broad metric and inch dropdown coverage",
    run: () => {
      const fastener = masterCartTemplate("socket-head-cap-screw");
      const metric = fastener.sizeOptions.filter((option) => option.system === "metric");
      const inch = fastener.sizeOptions.filter((option) => option.system === "inch");
      assert(metric.some((option) => option.label.startsWith("M2 ")) && metric.some((option) => option.label.startsWith("M24 ")), "metric socket sizes should span M2 through M24");
      assert(inch.some((option) => option.label.includes("#4-40")) && inch.some((option) => option.label.includes("1-8 UNC")), "inch socket sizes should span small machine screw through 1 inch UNC");
      assert(fastener.materialOptions.some((option) => option.label.includes("316")), "material dropdown should include corrosion-resistant stainless steel");
    }
  },
  {
    name: "Master Cart grouped move hide and delete keep multipart items coherent",
    run: () => {
      const project = createWorkbenchProject("project:test-master-cart-group");
      const built = buildMasterCartItem("socket-head-cap-screw", createMasterCartConfiguration("socket-head-cap-screw"), "master-cart:test-group");
      const inserted = applyWorkbenchOperation(project, { kind: "add-assembly-components", operationId: "operation:test-master-cart-insert", expectedRevision: 0, components: built.components });
      assert(inserted.ok, "grouped socket screw should insert");
      const selected = built.components[0]!;
      const moved = applyWorkbenchOperation(inserted.value.project, { kind: "set-component-translation", operationId: "operation:test-master-cart-move", expectedRevision: 1, componentId: selected.id, translationMm: [20, 30, 40] });
      assert(moved.ok, "moving one detail should move its complete group");
      const movedGroup = moved.value.project.assembly.components.filter((component) => component.masterCart?.instanceId === "master-cart:test-group");
      equal(movedGroup.length, built.components.length, "all group bodies should remain present");
      equal(movedGroup[0]?.translationMm[0], 20, "selected detail should reach the requested X position");
      equal(movedGroup[1]?.translationMm[0], built.components[1]!.translationMm[0] + 20, "dependent group detail should receive the same translation delta");

      const hidden = applyWorkbenchOperation(moved.value.project, { kind: "toggle-component-visibility", operationId: "operation:test-master-cart-hide", expectedRevision: 2, componentId: selected.id });
      assert(hidden.ok && hidden.value.project.assembly.components.filter((component) => component.masterCart?.instanceId === "master-cart:test-group").every((component) => !component.visible), "hiding one detail should hide the complete item");
      const deleted = applyWorkbenchOperation(hidden.value.project, { kind: "delete-assembly-component", operationId: "operation:test-master-cart-delete", expectedRevision: 3, componentId: selected.id });
      assert(deleted.ok, "deleting one detail should delete the complete item");
      equal(deleted.value.project.assembly.components.filter((component) => component.masterCart?.instanceId === "master-cart:test-group").length, 0, "no grouped detail should remain orphaned");
    }
  },
  {
    name: "custom ring torus and gear previews are finite and suppress self-interference",
    run: () => {
      const builds = [
        buildMasterCartItem("flat-washer", createMasterCartConfiguration("flat-washer"), "master-cart:test-washer"),
        buildMasterCartItem("o-ring", createMasterCartConfiguration("o-ring"), "master-cart:test-o-ring"),
        buildMasterCartItem("spur-gear", createMasterCartConfiguration("spur-gear"), "master-cart:test-gear"),
        buildMasterCartItem("deep-groove-ball-bearing", createMasterCartConfiguration("deep-groove-ball-bearing"), "master-cart:test-bearing")
      ];
      for (const built of builds) {
        const assembly = { ...createWorkbenchProject(`project:${built.template.id}`).assembly, explodeMm: 0, components: built.components, mates: [] };
        const scene = buildAssemblyPreview(assembly);
        assert(scene.primitives.some((primitive) => primitive.kind === "mesh") || built.template.id === "deep-groove-ball-bearing", `${built.template.id} should create custom or detailed preview geometry`);
        assert(scene.boundsMm.size.every((value) => Number.isFinite(value) && value > 0), `${built.template.id} preview bounds should be finite`);
        equal(findAssemblyInterference(assembly).length, 0, `${built.template.id} internal construction bodies should not be reported as assembly collisions`);
      }
    }
  }
];
