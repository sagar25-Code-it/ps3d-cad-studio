import {
  applyWorkbenchOperation,
  createBessContainerAssembly,
  createCargoContainerAssembly,
  createWorkbenchProject,
  type AssemblyMate,
  type ComponentInstance,
  type WorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { solveAssemblyMates } from "../packages/workbench-core/src/assembly-solve.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;

function part(id: string, translationMm: readonly [number, number, number], grounded = false): ComponentInstance {
  return { id: `component:${id}`, name: id, shape: "box", grounded, visible: true, color: "#aab2b8", translationMm: translationMm as never, rotationDeg: [0, 0, 0], sizeMm: [10, 10, 10], explosionDirection: [0, 0, 1] };
}

function projectOf(components: readonly ComponentInstance[], mates: readonly AssemblyMate[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-mates");
  return { ...base, assembly: { ...base.assembly, components, mates } };
}

function mate(kind: AssemblyMate["kind"], ids: readonly string[], axis?: "x" | "y" | "z"): AssemblyMate {
  serial += 1;
  return { id: `mate:t-${serial}`, name: `${kind} ${serial}`, kind, componentIds: ids.map((id) => `component:${id}`), ...(axis === undefined ? {} : { axis }), status: "satisfied" };
}

function addMate(project: WorkbenchProject, created: AssemblyMate) {
  serial += 1;
  return applyWorkbenchOperation(project, { kind: "add-assembly-mate", operationId: `operation:mate-${serial}`, expectedRevision: project.revision, mate: created });
}

function at(project: WorkbenchProject, id: string): readonly number[] {
  return project.assembly.components.find((component) => component.id === `component:${id}`)!.translationMm;
}

export const assemblyMateTests: readonly TestCase[] = [
  {
    name: "a coincident-origin mate moves the second part onto the first and never moves a grounded part",
    run: () => {
      const project = projectOf([part("a", [0, 0, 0]), part("b", [30, 20, 10])]);
      const result = addMate(project, mate("coincident-origin", ["a", "b"]));
      assert(result.ok, "the mate applies");
      equal(at(result.value.project, "b").join(), "0,0,0", "the second part moved onto the first");
      equal(at(result.value.project, "a").join(), "0,0,0", "the first stayed");
      assert(result.value.summary.includes("Moved b"), result.value.summary);
      equal(result.value.project.assembly.mates[0]!.status, "satisfied", "and the mate is satisfied");

      const grounded = projectOf([part("a", [0, 0, 0]), part("b", [30, 20, 10], true)]);
      const anchored = addMate(grounded, mate("coincident-origin", ["a", "b"]));
      assert(anchored.ok, "mating to a grounded part applies");
      equal(at(anchored.value.project, "b").join(), "30,20,10", "the grounded part stays put");
      equal(at(anchored.value.project, "a").join(), "30,20,10", "so the free part moves to it");
    }
  },
  {
    name: "an aligned-axis mate keeps the parts coaxial along that axis and leaves their heights alone",
    run: () => {
      const project = projectOf([part("base", [0, 0, 0], true), part("pin", [4, -3, 16])]);
      const result = addMate(project, mate("aligned-axis", ["base", "pin"], "z"));
      assert(result.ok, "the mate applies");
      equal(at(result.value.project, "pin").join(), "0,0,16", "X and Y snap to the base axis, Z is untouched");
    }
  },
  {
    name: "chains of mates carry a part group together and the grounded anchor decides the position",
    run: () => {
      const project = projectOf([part("a", [10, 10, 10], true), part("b", [0, 0, 0]), part("c", [50, 50, 50])]);
      const first = addMate(project, mate("coincident-origin", ["b", "c"]));
      assert(first.ok, "b and c mate");
      equal(at(first.value.project, "c").join(), "0,0,0", "c moved onto b");
      const second = addMate(first.value.project, mate("coincident-origin", ["a", "b"]));
      assert(second.ok, "a and b mate");
      equal(at(second.value.project, "b").join(), "10,10,10", "b follows grounded a");
      equal(at(second.value.project, "c").join(), "10,10,10", "and c follows b");
    }
  },
  {
    name: "two grounded parts that disagree make the mate a conflict and nothing moves",
    run: () => {
      const project = projectOf([part("a", [0, 0, 0], true), part("b", [30, 0, 0], true)]);
      const result = addMate(project, mate("coincident-origin", ["a", "b"]));
      assert(result.ok, "the mate is recorded");
      equal(result.value.project.assembly.mates[0]!.status, "conflict", "it is flagged as a conflict");
      equal(at(result.value.project, "b").join(), "30,0,0", "the grounded part did not move");
      assert(result.value.summary.includes("conflicts"), result.value.summary);
    }
  },
  {
    name: "a repeated mate is redundant, and statuses refresh when a part is moved by hand",
    run: () => {
      const project = projectOf([part("a", [0, 0, 0]), part("b", [5, 5, 5])]);
      const first = addMate(project, mate("coincident-origin", ["a", "b"]));
      assert(first.ok, "first mate");
      const duplicate = addMate(first.value.project, mate("coincident-origin", ["b", "a"]));
      assert(duplicate.ok, "second mate");
      equal(duplicate.value.project.assembly.mates.map((m) => m.status).join(), "satisfied,redundant", "the duplicate is redundant");
      const moved = applyWorkbenchOperation(first.value.project, { kind: "set-component-translation", operationId: "operation:hand-move", expectedRevision: first.value.project.revision, componentId: "component:b", translationMm: [9, 9, 9] });
      assert(moved.ok, "a manual move applies");
      equal(moved.value.project.assembly.mates[0]!.status, "conflict", "the mate no longer holds and says so");
      const solved = applyWorkbenchOperation(moved.value.project, { kind: "solve-assembly-mates", operationId: "operation:solve", expectedRevision: moved.value.project.revision });
      assert(solved.ok, "solving applies");
      equal(at(solved.value.project, "b").join(), "0,0,0", "Solve mates puts it back");
      equal(solved.value.project.assembly.mates[0]!.status, "satisfied", "and the mate holds again");
      const again = applyWorkbenchOperation(solved.value.project, { kind: "solve-assembly-mates", operationId: "operation:solve-again", expectedRevision: solved.value.project.revision });
      assert(again.ok && again.value.summary.includes("already in place"), "solving a solved assembly changes nothing");
    }
  },
  {
    name: "a fixed mate pins its part and the seeded assemblies already satisfy their own mates",
    run: () => {
      const pinned = projectOf([part("a", [0, 0, 0]), part("b", [8, 0, 0])]);
      const fixedFirst = addMate(pinned, mate("fixed", ["b"]));
      assert(fixedFirst.ok, "fixed applies");
      const meet = addMate(fixedFirst.value.project, mate("coincident-origin", ["a", "b"]));
      assert(meet.ok, "then a mate to the pinned part");
      equal(at(meet.value.project, "a").join(), "8,0,0", "the free part goes to the pinned one");

      const seeded: readonly (readonly [string, ReturnType<typeof createCargoContainerAssembly>])[] = [
        ["default", createWorkbenchProject("project:test-seeded").assembly],
        ["cargo-20ft", createCargoContainerAssembly("cargo-20ft")],
        ["cargo-40ft-hc", createCargoContainerAssembly("cargo-40ft-hc")],
        ["bess", createBessContainerAssembly()]
      ];
      for (const [name, assembly] of seeded) {
        const derived = solveAssemblyMates(assembly, { move: false });
        const bad = derived.mates.filter((candidate) => candidate.status !== "satisfied");
        assert(bad.length === 0, `${name}: seeded mates must hold, but ${bad.map((candidate) => candidate.id).join(", ")} do not`);
        const solved = solveAssemblyMates(assembly, { move: true });
        near(solved.movedIds.length, 0, 0, `${name}: solving a seeded assembly moves nothing`);
      }
    }
  }
];
