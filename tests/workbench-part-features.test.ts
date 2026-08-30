import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type PartPreviewBody,
  type WorkbenchOperation,
  type WorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { buildPartPreview, type PreviewPrimitive } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchPartFeatureTests: readonly TestCase[] = [
  {
    name: "revolve pattern and mirror create traceable analytic bodies",
    run: () => {
      let project = addBodies(createWorkbenchProject("project:feature-create"), [block("part-body:seed", [0, 0, 0], [20, 12, 8])]);
      project = apply(project, {
        kind: "create-part-revolve", bodyId: "part-body:ring", name: "Ring", outerDiameterMm: 30,
        innerDiameterMm: 16, heightMm: 12, angleDeg: 270, translationMm: [45, 0, 6]
      });
      project = apply(project, {
        kind: "pattern-part-feature", bodyId: "part-body:ring", instanceIds: ["part-body:ring-p2", "part-body:ring-p3"], direction: "y", spacingMm: 36
      });
      project = apply(project, { kind: "mirror-part-feature", bodyId: "part-body:seed", newBodyId: "part-body:seed-mirror", plane: "yz" });
      equal(project.part.previewBodies?.length, 5, "revolve plus pattern and mirror should produce five selectable bodies");
      equal(find(project, "part-body:ring").shape, "revolved", "revolve should create an analytic revolved shape");
      equal(find(project, "part-body:ring").featureTrace?.kind, "revolve", "revolve history should be traceable");
      equal(find(project, "part-body:ring-p3").featureTrace?.kind, "pattern", "pattern instances should retain their parent trace");
      equal(find(project, "part-body:seed-mirror").featureTrace?.kind, "mirror", "mirror result should retain its seed trace");
      const meshes = buildPartPreview(project.part).primitives.filter((primitive) => primitive.kind === "mesh");
      equal(meshes.length, 3, "the revolved seed and two patterned instances should render analytic meshes");
      meshes.forEach(assertClosedMesh);
    }
  },
  {
    name: "blend chamfer resize draft shell delete-face and update-model are revisioned",
    run: () => {
      let project = addBodies(createWorkbenchProject("project:feature-detail"), [
        block("part-body:edge", [0, 0, 0], [30, 20, 12]),
        block("part-body:draft", [45, 0, 0], [30, 22, 16]),
        block("part-body:shell", [90, 0, 0], [32, 24, 18])
      ]);
      project = apply(project, { kind: "set-part-body-edge-treatment", bodyId: "part-body:edge", treatment: "blend", sizeMm: 2 });
      project = apply(project, { kind: "set-part-body-edge-treatment", bodyId: "part-body:edge", treatment: "blend", sizeMm: 3 });
      equal(find(project, "part-body:edge").edgeTreatment?.sizeMm, 3, "Resize Blend should regenerate the recognized blend radius");
      project = apply(project, { kind: "set-part-body-edge-treatment", bodyId: "part-body:edge", treatment: "chamfer", sizeMm: 2.5 });
      equal(find(project, "part-body:edge").edgeTreatment?.kind, "chamfer", "Chamfer should replace the prior vertical-edge treatment");
      project = apply(project, { kind: "delete-part-body-face", bodyId: "part-body:edge", feature: "edge-treatment" });
      equal(find(project, "part-body:edge").edgeTreatment, undefined, "Delete Face should heal a recognized edge-treatment face set");
      project = apply(project, { kind: "set-part-body-draft", bodyId: "part-body:draft", angleDeg: 5 });
      project = apply(project, { kind: "set-part-body-shell", bodyId: "part-body:shell", thicknessMm: 2 });
      project = apply(project, { kind: "update-part-model" });
      equal(project.part.modelUpdateSerial, 1, "Update Model should record one explicit analytic rebuild");
      const scene = buildPartPreview(project.part);
      const detailMeshes = scene.primitives.filter((primitive) => primitive.id === "part-body:draft" || primitive.id === "part-body:shell");
      equal(detailMeshes.length, 2, "draft and shell should both generate visible meshes");
      detailMeshes.forEach(assertClosedMesh);
    }
  },
  {
    name: "move offset replace and trim face operations regenerate body dimensions",
    run: () => {
      let project = addBodies(createWorkbenchProject("project:feature-face"), [block("part-body:face", [0, 0, 0], [20, 10, 20])]);
      project = apply(project, { kind: "move-part-body-face", bodyId: "part-body:face", face: "z-positive", offsetMm: 4, mode: "move" });
      equal(find(project, "part-body:face").sizeMm[2], 24, "Move Face should extend the selected local face");
      near(find(project, "part-body:face").translationMm[2], 2, 1e-12, "Move Face should keep the opposite face stationary");
      project = apply(project, { kind: "move-part-body-face", bodyId: "part-body:face", face: "x-positive", offsetMm: 2, mode: "offset" });
      equal(find(project, "part-body:face").sizeMm[0], 22, "Offset Face should change the corresponding body extent");
      project = apply(project, { kind: "replace-part-body-face", bodyId: "part-body:face", face: "y-positive", localPositionMm: 7 });
      equal(find(project, "part-body:face").sizeMm[1], 12, "Replace Face should place the supported face at the requested local datum");
      project = apply(project, { kind: "trim-part-body", bodyId: "part-body:face", keptLengthMm: 12, side: "negative" });
      equal(find(project, "part-body:face").sizeMm[2], 12, "Trim Body should retain the requested local-Z region");
      near(find(project, "part-body:face").translationMm[2], -4, 1e-12, "Trim Body should preserve the negative-side end face");
      equal(find(project, "part-body:face").featureTrace?.kind, "trim", "trim history should remain attached to the body");
    }
  },
  {
    name: "bounded Unite consumes an aligned tool and preserves an exact block result",
    run: () => {
      let project = addBodies(createWorkbenchProject("project:feature-unite"), [
        block("part-body:target", [0, 0, 0], [10, 10, 10]),
        block("part-body:tool", [10, 0, 0], [10, 10, 10])
      ]);
      project = apply(project, { kind: "boolean-part-bodies", targetBodyId: "part-body:target", toolBodyId: "part-body:tool", operation: "unite" });
      equal(project.part.previewBodies?.length, 1, "Unite should consume its tool body");
      equal(JSON.stringify(find(project, "part-body:target").sizeMm), JSON.stringify([20, 10, 10]), "aligned blocks should unite into one exact block envelope");
      equal(JSON.stringify(find(project, "part-body:target").translationMm), JSON.stringify([5, 0, 0]), "the united block center should follow the exact union bounds");
      equal(find(project, "part-body:target").featureTrace?.kind, "unite", "Unite should retain both parent IDs in feature history");
    }
  },
  {
    name: "bounded Subtract creates a closed through-bore and Delete Face heals it",
    run: () => {
      let project = addBodies(createWorkbenchProject("project:feature-subtract"), [
        block("part-body:target", [0, 0, 0], [30, 20, 10]),
        cylinder("part-body:tool", [0, 0, 0], 8, 20)
      ]);
      project = apply(project, { kind: "boolean-part-bodies", targetBodyId: "part-body:target", toolBodyId: "part-body:tool", operation: "subtract" });
      equal(find(project, "part-body:target").boreDiameterMm, 8, "Subtract should persist the analytic bore diameter");
      equal(project.part.previewBodies?.length, 1, "Subtract should consume its tool body");
      const boreMesh = buildPartPreview(project.part).primitives.find((primitive) => primitive.id === "part-body:target");
      assert(boreMesh !== undefined, "subtracted target should remain visible");
      assertClosedMesh(boreMesh);
      project = apply(project, { kind: "delete-part-body-face", bodyId: "part-body:target", feature: "bore" });
      equal(find(project, "part-body:target").boreDiameterMm, undefined, "Delete Face should remove and heal the recognized bore");
    }
  },
  {
    name: "unsupported analytic topology fails closed without consuming operands",
    run: () => {
      const project = addBodies(createWorkbenchProject("project:feature-fail"), [
        { ...block("part-body:target", [0, 0, 0], [10, 10, 10]), rotationDeg: [0, 0, 15] },
        block("part-body:tool", [10, 0, 0], [10, 10, 10])
      ]);
      const result = applyWorkbenchOperation(project, envelope(project, { kind: "boolean-part-bodies", targetBodyId: "part-body:target", toolBodyId: "part-body:tool", operation: "unite" }));
      assert(!result.ok, "a rotated unsupported Boolean should fail rather than approximate success");
      equal(result.diagnostics[0]?.code, "UNSUPPORTED_CAPABILITY", "unsupported topology should return a corrective typed diagnostic");
      equal(project.part.previewBodies?.length, 2, "failed Boolean must not consume either input body");
    }
  }
];

type OperationIntent = WorkbenchOperation extends infer Operation
  ? Operation extends WorkbenchOperation
    ? Omit<Operation, "operationId" | "expectedRevision">
    : never
  : never;

function apply(project: WorkbenchProject, intent: OperationIntent): WorkbenchProject {
  const result = applyWorkbenchOperation(project, envelope(project, intent));
  assert(result.ok, `operation ${intent.kind} should apply: ${result.ok ? "" : result.diagnostics[0]?.message ?? "unknown error"}`);
  return result.value.project;
}

function envelope(project: WorkbenchProject, intent: OperationIntent): WorkbenchOperation {
  return { ...intent, operationId: `operation:test-${intent.kind}-r${project.revision}`, expectedRevision: project.revision } as WorkbenchOperation;
}

function addBodies(project: WorkbenchProject, bodies: readonly PartPreviewBody[]): WorkbenchProject {
  return apply(project, { kind: "add-part-preview-bodies", bodies });
}

function find(project: WorkbenchProject, id: string): PartPreviewBody {
  const body = project.part.previewBodies?.find((candidate) => candidate.id === id);
  assert(body !== undefined, `${id} should exist`);
  return body;
}

function block(id: string, translationMm: readonly [number, number, number], sizeMm: readonly [number, number, number]): PartPreviewBody {
  return { id, name: id, shape: "block", visible: true, color: "#aeb3b8", translationMm, rotationDeg: [0, 0, 0], sizeMm };
}

function cylinder(id: string, translationMm: readonly [number, number, number], diameterMm: number, heightMm: number): PartPreviewBody {
  return { id, name: id, shape: "cylinder", visible: true, color: "#aeb3b8", translationMm, rotationDeg: [0, 0, 0], sizeMm: [diameterMm, diameterMm, heightMm] };
}

function assertClosedMesh(primitive: PreviewPrimitive): void {
  assert(primitive.kind === "mesh", `${primitive.id} should render as an analytic mesh`);
  assert(primitive.positionsMm.every(Number.isFinite), `${primitive.id} positions should be finite`);
  assert(primitive.indices.length > 0 && primitive.indices.length % 3 === 0, `${primitive.id} should contain complete triangles`);
  const edges = new Map<string, number>();
  for (let index = 0; index < primitive.indices.length; index += 3) {
    const triangle = [primitive.indices[index]!, primitive.indices[index + 1]!, primitive.indices[index + 2]!];
    assert(new Set(triangle).size === 3, `${primitive.id} should not contain zero-index-area triangles`);
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangle[edge]!; const b = triangle[(edge + 1) % 3]!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const nonManifold = [...edges.values()].filter((count) => count !== 2);
  equal(nonManifold.length, 0, `${primitive.id} should be a closed two-manifold mesh`);
}
