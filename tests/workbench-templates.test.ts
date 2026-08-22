import {
  applyWorkbenchOperation,
  createBessContainerAssembly,
  createCargoContainerAssembly,
  createWorkbenchProject,
  validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { findAssemblyInterference } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchTemplateTests: readonly TestCase[] = [
  {
    name: "cargo planning templates preserve published nominal external envelopes",
    run: () => {
      const short = createCargoContainerAssembly("cargo-20ft");
      const long = createCargoContainerAssembly("cargo-40ft-hc");
      equal(short.nominalEnvelopeMm?.join("x"), "6058x2438x2591", "20 ft nominal dimensions should be explicit");
      equal(long.nominalEnvelopeMm?.join("x"), "12192x2438x2896", "40 ft high-cube nominal dimensions should be explicit");
      equal(new Set(short.components.map((component) => component.id)).size, short.components.length, "cargo component IDs should be unique");
      assert(short.safetyNotes?.some((note) => note.includes("NOT FOR FABRICATION")), "cargo output should prohibit fabrication release");

      const seeded = createWorkbenchProject("project:test-container-validation");
      const valid = validateWorkbenchProject({ ...seeded, assembly: long });
      assert(valid.ok, "the extended 12,192 mm component envelope should validate");
    }
  },
  {
    name: "BESS arrangement contains explicit equipment roles and engineering boundary",
    run: () => {
      const assembly = createBessContainerAssembly();
      const names = assembly.components.map((component) => component.name.toLowerCase());
      for (const expected of ["battery rack", "pcs", "switchgear", "dc combiner", "hvac", "fire detection", "cable tray", "service aisle"]) {
        assert(names.some((name) => name.includes(expected)), `BESS template should include ${expected}`);
      }
      assert(assembly.safetyNotes?.some((note) => note.includes("NOT FOR CONSTRUCTION")), "BESS output should be visibly non-construction");
      equal(assembly.template, "bess-20ft-hc", "template identity should be persisted");
      equal(assembly.nominalEnvelopeMm?.join("x"), "6058x2438x2896", "BESS planning envelope should be explicit");
      assert(assembly.mates.every((mate) => mate.status === "satisfied"), "all seeded layout records should be satisfied");
    }
  },
  {
    name: "assembly template operation is revisioned and exactly idempotent",
    run: () => {
      const project = createWorkbenchProject("project:test-template-operation");
      const operation = { kind: "apply-assembly-template", operationId: "operation:test-bess-template", expectedRevision: 0, template: "bess-20ft-hc" } as const;
      const applied = applyWorkbenchOperation(project, operation);
      assert(applied.ok, "BESS template operation should apply");
      equal(applied.value.project.revision, 1, "template generation should create one revision");
      equal(applied.value.project.assembly.template, "bess-20ft-hc", "generated template should persist");
      const retry = applyWorkbenchOperation(applied.value.project, operation);
      assert(retry.ok, "exact template retry should succeed");
      equal(retry.value.exactRetry, true, "exact template retry should be classified");
      equal(retry.value.project.revision, 1, "retry should not duplicate a revision");
    }
  },
  {
    name: "container interference check omits intentional planning-frame joints",
    run: () => {
      const assembly = createBessContainerAssembly();
      const candidates = findAssemblyInterference(assembly);
      equal(candidates.length, 0, "the seeded BESS arrangement should have no unexplained AABB overlap candidates");
      assert(candidates.every((candidate) => !candidate.componentIds.every((id) => id.startsWith("component:bess-20ft-hc-"))), "no frame-to-frame pair should be reported");
    }
  }
];
