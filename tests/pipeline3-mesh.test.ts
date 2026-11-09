import type { GeneralSolidBody, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { MCP_CALL_MAX_BYTES, packMeshes, parseWorkbenchProjectText, serializeWorkbenchProject, unpackMeshes, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, fresh, message, pipelineRun, solidFeature, solidOf } from "./pipeline-kit.js";

/**
 * Wave 3, P01: meshes are stored and sent packed (base64 typed arrays), a project with many solids stays far below the file and MCP
 * limits, packed and plain files both open, and a damaged packed mesh is refused with its reason.
 */

const ack = async (): Promise<{ readonly manifestSha256: string; readonly understood: true }> => ({ manifestSha256: String((await createPs3dCollaborationGuide())["manifestSha256"]), understood: true });
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

async function torusProject(count: number): Promise<WorkbenchProject> {
  const { project: sketched, sketch } = committedSketch("datum:xy", [circ("ring", 20, 0, 5)]);
  let project = sketched;
  for (let index = 0; index < count; index += 1) {
    const built = solidOf(await buildSolid(sketch, "revolve", { valueMm: 360 }));
    const feature = { ...solidFeature("revolve", sketch, { valueMm: 360 }), id: `feature:torus-${index}`, name: `Torus ${index}`, bodyId: `general-body:torus-${index}` };
    project = pipelineRun(project, { kind: "add-design-solid", feature, body: { ...built, id: feature.bodyId, name: feature.name } });
  }
  return project;
}

function sameBodies(a: WorkbenchProject, b: WorkbenchProject): boolean {
  return JSON.stringify(a.part.generalBodies) === JSON.stringify(b.part.generalBodies);
}

export const pipeline3MeshTests: readonly TestCase[] = [
  {
    name: "Wave3 P01: a saved project stores meshes packed (several times smaller than the plain lists), opens back exactly, and a plain file from an older version still opens",
    run: async () => {
      const project = await torusProject(2);
      const bodies = project.part.generalBodies!;
      assert(bodies.length === 2 && bodies[0]!.indices.length / 3 > 5_000, `the fixture holds two real tori (${bodies[0]?.indices.length ?? 0} index entries)`);
      const plain = JSON.stringify(project, null, 2);
      const text = serializeWorkbenchProject(project);
      assert(plain.length > 2_000_000, `the plain project is large (${plain.length} bytes)`);
      assert(text.length < plain.length / 6, `the saved text is at least six times smaller (${text.length} against ${plain.length})`);
      assert(text.includes("\"packedMesh\"") && !text.includes("\"positionsMm\""), "the meshes are stored as packedMesh records");
      const reopened = parseWorkbenchProjectText(text);
      assert(reopened.ok, `the packed file opens: ${message(reopened)}`);
      if (!reopened.ok) return;
      assert(sameBodies(project, reopened.value), "and every position, index and face number is exactly what was saved");
      equal(JSON.stringify(reopened.value), JSON.stringify(project), "so the whole project is the same");
      // Save, open, save again: the same bytes.
      equal(serializeWorkbenchProject(reopened.value), text, "saving the reopened project writes the same text");
      // The older layout (plain lists) is read as ever.
      const old = parseWorkbenchProjectText(plain);
      assert(old.ok && sameBodies(project, old.value), "a plain-list file saved by an earlier version still opens, unchanged");
      assert(old.ok && serializeWorkbenchProject(old.value) === text, "and saves in the packed layout");
    }
  },
  {
    name: "Wave3 P01: many solids stay below the file limit and the MCP call cap; packed projects pass through ps3d_inspect_project and ps3d_prepare_design_solid",
    run: async () => {
      const project = await torusProject(1);
      const packedOne = packMeshes(project);
      // The re-audit repro: a second torus through ps3d_prepare_design_solid was refused at 2.6 MB each.
      const sketchFeatureId = "feature:s1";
      const acknowledgement = await ack();
      const prepared = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project: packedOne, solid: { kind: "revolve", sketchFeatureId, valueMm: 360, name: "Second torus" }, guideAcknowledgement: acknowledgement });
      assert(prepared.isError !== true, `a second torus is prepared: ${JSON.stringify(prepared.content[0]).slice(0, 300)}`);
      const operation = prepared.structuredContent["operation"] as { body: Record<string, unknown> };
      assert(operation.body["packedMesh"] !== undefined && operation.body["positionsMm"] === undefined, "the returned operation carries a packed mesh");
      assert(bytesOf(prepared.structuredContent) < 2_000_000, `and the whole answer is small (${bytesOf(prepared.structuredContent)} bytes)`);
      const candidate = prepared.structuredContent["candidateProject"];
      assert(JSON.stringify(candidate).includes("packedMesh"), "the candidate project is packed too");
      const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project: packedOne, operation: prepared.structuredContent["operation"], receipt: prepared.structuredContent["receipt"], confirmed: true, guideAcknowledgement: acknowledgement });
      assert(applied.isError !== true, `the packed operation applies with the receipt of the preview: ${JSON.stringify(applied.content[0]).slice(0, 300)}`);
      const next = validateWorkbenchProject(applied.structuredContent["project"]);
      assert(next.ok && next.value.part.generalBodies?.length === 2, `the returned project reads back with two solids: ${message(next)}`);
      const inspected = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: applied.structuredContent["project"] });
      assert(inspected.isError !== true, "and can be inspected");

      // Six solids: past the call cap as plain lists, comfortably inside it packed.
      const body: GeneralSolidBody = project.part.generalBodies![0]!;
      let many = project;
      for (let index = 1; index < 6; index += 1) many = { ...many, part: { ...many.part, generalBodies: [...many.part.generalBodies!, { ...body, id: `general-body:copy-${index}`, name: `Copy ${index}` }] } };
      const plainBytes = bytesOf(many);
      const packedBytes = bytesOf(packMeshes(many));
      assert(plainBytes > MCP_CALL_MAX_BYTES * 3, `six tori are ${plainBytes} bytes as plain lists`);
      assert(packedBytes < MCP_CALL_MAX_BYTES * 0.7, `and ${packedBytes} bytes packed, inside the ${MCP_CALL_MAX_BYTES} byte MCP call cap`);
      const inspectMany = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: packMeshes(many) });
      assert(inspectMany.isError !== true, "six packed solids can be sent in one MCP call");
      const plainMany = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: many });
      assert(plainMany.isError === true && /MB/u.test(JSON.stringify(plainMany.content[0])) && /packed/u.test(JSON.stringify(plainMany.content[0])), "the same project as plain lists is refused with advice that names packing");
    }
  },
  {
    name: "Wave3 P01: a damaged, truncated or hostile packed mesh is refused with the reason; float64 positions and face numbers round trip",
    run: async () => {
      const project = await torusProject(1);
      const packed = packMeshes(project) as unknown as { part: { generalBodies: Record<string, unknown>[] } };
      const body = packed.part.generalBodies[0]!;
      const mesh = body["packedMesh"] as { pos: { d: string; n: number; t: string }; idx?: { d: string }; weld?: { d: string; n: number; t: string }; faces?: { d: string } };
      assert(mesh.weld !== undefined && mesh.faces !== undefined, "the torus repeats corners and has face numbers");
      const attempt = (patch: (clone: typeof packed) => void): string => {
        const clone = JSON.parse(JSON.stringify(packed)) as typeof packed;
        patch(clone);
        const result = validateWorkbenchProject(clone);
        return result.ok ? "accepted" : message(result);
      };
      assert(/damaged/u.test(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { pos: { d: string } }).pos.d = "AAAA"; })), "a short data string is refused as damaged");
      assert(/version/u.test(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { v: number }).v = 2; })), "an unknown version is refused naming the version");
      assert(/outside/u.test(attempt((clone) => {
        const m = clone.part.generalBodies[0]!["packedMesh"] as { weld: { d: string; n: number } };
        m.weld.d = "/".repeat(m.weld.d.length - (m.weld.d.endsWith("=") ? 1 : 0)) + (m.weld.d.endsWith("=") ? "=" : "");
      }) + attempt((clone) => { const m = clone.part.generalBodies[0]!["packedMesh"] as { weld: { d: string } }; m.weld.d = m.weld.d.replace(/[A-Za-z0-9]/gu, "/"); })), "a vertex map that points past the positions is refused");
      assert(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { extra?: number }).extra = 1; }) !== "accepted", "an unknown field is refused");
      assert(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { vertices: number }).vertices = 7; }) !== "accepted", "a wrong vertex count is refused");
      assert(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { pos: { t: string } }).pos.t = "u8"; }) !== "accepted", "an unknown number type is refused");
      assert(attempt((clone) => { (clone.part.generalBodies[0]!["packedMesh"] as { pos: { d: string } }).pos.d = "!!!!".repeat(10); }) !== "accepted", "text that is not base64 is refused");
      equal(attempt(() => undefined), "accepted", "the undamaged packed project is accepted");

      // Float64 positions (not representable in float32) and unindexed small meshes round trip exactly.
      const awkward: GeneralSolidBody = {
        id: "general-body:awkward", name: "Awkward", visible: true, color: "#b9c2c8",
        positionsMm: Array.from({ length: 36 }, (_, index) => Math.sin(index + 0.5) * 33.333333333333336),
        indices: Array.from({ length: 12 }, (_, index) => (index * 5) % 12)
      };
      const roundTrip = unpackMeshes(JSON.parse(JSON.stringify(packMeshes({ body: { ...awkward, positionsMm: [...awkward.positionsMm, ...awkward.positionsMm, ...awkward.positionsMm] } }))) as unknown);
      assert(roundTrip.ok, "float64 positions unpack");
      if (roundTrip.ok) {
        const back = (roundTrip.value as { body: GeneralSolidBody }).body;
        equal(JSON.stringify(back.positionsMm), JSON.stringify([...awkward.positionsMm, ...awkward.positionsMm, ...awkward.positionsMm]), "to exactly the same doubles");
      }
      void fresh;
    }
  }
];
