import { combineGeneralBodies, createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { applyWorkbenchOperation, createWorkbenchProject, type GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { booleanMeshes, type BooleanMeshInput } from "../packages/workbench-geometry/src/index.js";
import { evaluateProfilePrism } from "../packages/occt-kernel-adapter/src/reference-runtime.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Axis-aligned box as 12 outward triangles, face index 0..5. */
function box(min: readonly [number, number, number], max: readonly [number, number, number]): BooleanMeshInput {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positionsMm = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const quads: readonly (readonly [number, number, number, number])[] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const indices: number[] = [];
  const faceTriangles: number[] = [];
  quads.forEach(([a, b, c, d], face) => { indices.push(a, b, c, a, c, d); faceTriangles.push(face, face); });
  return { positionsMm, indices, faceTriangles };
}

async function cylinder(centerX: number, centerY: number, radius: number, z0: number, height: number, segments = 72): Promise<BooleanMeshInput> {
  const points = Array.from({ length: segments }, (_, step): readonly [number, number, number] => {
    const angle = (2 * Math.PI * step) / segments;
    return [(centerX + radius * Math.cos(angle)) / 1000, (centerY + radius * Math.sin(angle)) / 1000, z0 / 1000];
  });
  const result = await evaluateProfilePrism({ operationId: "operation:cyl", semanticId: "body:cyl", profilePointsMeters: points, normal: [0, 0, 1], heightMeters: height / 1000, smoothSides: true });
  return { positionsMm: result.positionsMeters.map((value) => value * 1000), indices: result.indices, faceTriangles: result.faceTriangles };
}

function volumeOf(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3; const b = mesh.indices[i + 1]! * 3; const c = mesh.indices[i + 2]! * 3;
    const p = mesh.positionsMm;
    total += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return total / 6;
}

function meshVolume(body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number {
  return volumeOf(body);
}

const polygonArea = (radius: number, segments: number): number => 0.5 * segments * radius * radius * Math.sin((2 * Math.PI) / segments);

export const meshBooleanTests: readonly TestCase[] = [
  {
    name: "Boolean of two overlapping boxes gives the exact join, cut and intersection volumes",
    run: () => {
      const a = box([0, 0, 0], [20, 20, 20]);
      const b = box([10, 10, 10], [30, 30, 30]);
      const intersect = booleanMeshes(a, b, "intersect");
      assert(intersect.ok, intersect.ok ? "" : intersect.message);
      near(intersect.value.volumeMm3, 1000, 1e-6, "10 x 10 x 10 overlap");
      near(volumeOf(intersect.value), 1000, 1e-6, "the returned mesh has that volume");
      const join = booleanMeshes(a, b, "join");
      assert(join.ok, join.ok ? "" : join.message);
      near(join.value.volumeMm3, 8000 + 8000 - 1000, 1e-6, "inclusion-exclusion");
      const cut = booleanMeshes(a, b, "cut");
      assert(cut.ok, cut.ok ? "" : cut.message);
      near(cut.value.volumeMm3, 8000 - 1000, 1e-6, "the target minus the overlap");
      equal(cut.value.origins.length * 3, cut.value.indices.length, "one origin per triangle");
      assert(cut.value.origins.some((origin) => origin.source === "tool"), "the cavity walls come from the tool");
      assert(cut.value.origins.some((origin) => origin.source === "target"), "the rest comes from the target");
    }
  },
  {
    name: "a through-cylinder cut removes exactly the faceted cylinder volume",
    run: async () => {
      const block = box([0, 0, 0], [40, 40, 10]);
      const pin = await cylinder(20, 20, 5, -5, 20);
      const cut = booleanMeshes(block, pin, "cut");
      assert(cut.ok, cut.ok ? "" : cut.message);
      near(cut.value.volumeMm3, 40 * 40 * 10 - polygonArea(5, 72) * 10, 1e-4, "block minus the through hole");
      const wallFaces = new Set(cut.value.origins.filter((origin) => origin.source === "tool").map((origin) => origin.face));
      assert(wallFaces.size >= 1, "the hole wall keeps the cylinder face index");
      // Cutting is not commutative: the other way round removes the block from the cylinder, leaving two pieces.
      const reversed = booleanMeshes(pin, block, "cut");
      assert(!reversed.ok && reversed.message.includes("separate pieces"), `the cylinder minus a wide block is two disconnected stubs: ${reversed.ok ? "" : reversed.message}`);
    }
  },
  {
    name: "join, cut and intersect of two overlapping cylinders agree with inclusion-exclusion",
    run: async () => {
      const first = await cylinder(0, 0, 10, 0, 10, 48);
      const second = await cylinder(8, 0, 10, 0, 10, 48);
      const intersect = booleanMeshes(first, second, "intersect");
      const join = booleanMeshes(first, second, "join");
      const cut = booleanMeshes(first, second, "cut");
      assert(intersect.ok && join.ok && cut.ok, "all three operations succeed");
      const each = volumeOf(first);
      near(join.value.volumeMm3, 2 * each - intersect.value.volumeMm3, each * 1e-6, "join = A + B - overlap");
      near(cut.value.volumeMm3, each - intersect.value.volumeMm3, each * 1e-6, "cut = A - overlap");
      assert(intersect.value.volumeMm3 > 0 && intersect.value.volumeMm3 < each, "the lens is smaller than either cylinder");
    }
  },
  {
    name: "boxes that only touch join into one solid but have nothing to cut or intersect",
    run: () => {
      const left = box([0, 0, 0], [10, 10, 10]);
      const right = box([10, 0, 0], [20, 10, 10]);
      const join = booleanMeshes(left, right, "join");
      assert(join.ok, join.ok ? "" : join.message);
      near(join.value.volumeMm3, 2000, 1e-6, "two boxes sharing a face");
      const cut = booleanMeshes(left, right, "cut");
      assert(!cut.ok && cut.message.includes("does not overlap"), "a cut with no overlap is refused");
      const common = booleanMeshes(left, right, "intersect");
      assert(!common.ok, "an empty intersection is refused");
    }
  },
  {
    name: "a pocket flush with the top face (coplanar faces) still gives a closed solid",
    run: () => {
      const block = box([0, 0, 0], [20, 20, 10]);
      const tool = box([5, 5, 5], [15, 15, 10]);
      const cut = booleanMeshes(block, tool, "cut");
      assert(cut.ok, cut.ok ? "" : cut.message);
      near(cut.value.volumeMm3, 4000 - 500, 1e-6, "a 10 x 10 x 5 pocket");
      const union = booleanMeshes(block, box([5, 5, 0], [15, 15, 10]), "join");
      assert(union.ok, union.ok ? "" : union.message);
      near(union.value.volumeMm3, 4000, 1e-6, "a box wholly inside adds nothing");
    }
  },
  {
    name: "disjoint, open and inverted inputs are refused with a clear reason",
    run: () => {
      const a = box([0, 0, 0], [10, 10, 10]);
      const far = box([50, 50, 50], [60, 60, 60]);
      const joined = booleanMeshes(a, far, "join");
      assert(!joined.ok && joined.message.includes("do not touch"), "far apart bodies cannot be joined");
      const open: BooleanMeshInput = { ...a, indices: a.indices.slice(3) };
      const withHole = booleanMeshes(open, box([5, 5, 5], [15, 15, 15]), "join");
      assert(!withHole.ok && withHole.message.includes("not a closed solid"), "a mesh with a missing triangle is not a solid");
      const inside: BooleanMeshInput = { ...a, indices: a.indices.map((_, index) => a.indices[index - (index % 3) + (2 - (index % 3))]!) };
      const flipped = booleanMeshes(inside, box([5, 5, 5], [15, 15, 15]), "join");
      assert(!flipped.ok, "an inside-out mesh is refused");
    }
  },
  {
    name: "Combine builds a named mesh solid from two sketch solids and replaces them through the operation",
    run: async () => {
      const base = createWorkbenchProject("project:test-combine");
      const sketch = (entities: readonly object[]) => ({ ...base.sketch, entities: entities as never, constraints: [] });
      const block = detectSketchProfiles(sketch([{ id: "entity:plate", kind: "rectangle", center: [20, 20], widthMm: 40, heightMm: 40, rotationDeg: 0, construction: false }]))[0]!;
      const pin = detectSketchProfiles(sketch([{ id: "entity:pin", kind: "circle", center: [20, 20], radiusMm: 5, construction: false }]))[0]!;
      const made = async (profile: typeof block, id: string, height: number): Promise<GeneralSolidBody> => {
        const result = await createGeneralSolidBody({ profile, plane: "xy", operation: "extrude", valueMm: height, bodyId: id, name: id, color: "#b9c2c8" });
        assert(result.ok, "the source solid is built");
        return result.body;
      };
      const target = await made(block, "general-body:block", 10);
      const tool = await made(pin, "general-body:pin", 25);
      const combined = await combineGeneralBodies({ target, tool, mode: "cut", bodyId: "general-body:result", name: "Block with hole" });
      assert(combined.ok, combined.ok ? "" : combined.message);
      const roles = combined.body.brep!.faces.map((face) => face.role);
      assert(roles.some((role) => role.startsWith("target.")) && roles.some((role) => role.startsWith("tool.face.lateral")), "faces are named after their source: " + roles.join(", "));
      equal(combined.body.brep!.origin, "mesh-boolean", "the result is labelled as a mesh Boolean");
      equal(combined.body.brep!.faceTriangles.length, combined.body.indices.length / 3, "every triangle has a face");
      near(meshVolume(combined.body), 40 * 40 * 10 - polygonArea(5, 72) * 10, 1e-4, "the hole is cut through the block");
      const wall = combined.body.brep!.faces.find((face) => face.role === "tool.face.lateral")!;
      near(wall.areaMm2, 72 * (2 * 5 * Math.sin(Math.PI / 72)) * 10, 1e-6, "the hole wall is the facet strip, one block height tall");

      const project = { ...base, part: { ...base.part, generalBodies: [target, tool] } };
      const applied = applyWorkbenchOperation(project, { kind: "boolean-general-bodies", operationId: "operation:test-combine", expectedRevision: project.revision, targetBodyId: target.id, toolBodyId: tool.id, mode: "cut", keepTool: false, body: combined.body });
      assert(applied.ok, applied.ok ? "" : applied.diagnostics[0]?.message ?? "");
      equal((applied.value.project.part.generalBodies ?? []).map((body) => body.id).join(), "general-body:result", "target and tool are replaced by the result");
      const kept = applyWorkbenchOperation(project, { kind: "boolean-general-bodies", operationId: "operation:test-combine-keep", expectedRevision: project.revision, targetBodyId: target.id, toolBodyId: tool.id, mode: "cut", keepTool: true, body: combined.body });
      assert(kept.ok, "keeping the tool applies");
      equal((kept.value.project.part.generalBodies ?? []).map((body) => body.id).join(), "general-body:pin,general-body:result", "the tool survives");
      const missing = applyWorkbenchOperation(project, { kind: "boolean-general-bodies", operationId: "operation:test-combine-missing", expectedRevision: project.revision, targetBodyId: "general-body:nope", toolBodyId: tool.id, mode: "cut", keepTool: false, body: combined.body });
      assert(!missing.ok, "an unknown target is a broken reference");
      const apart = await made(detectSketchProfiles(sketch([{ id: "entity:far", kind: "circle", center: [200, 200], radiusMm: 5, construction: false }]))[0]!, "general-body:far", 10);
      const refused = await combineGeneralBodies({ target, tool: apart, mode: "join", bodyId: "general-body:never", name: "Never" });
      assert(!refused.ok && refused.message.includes("do not touch"), "bodies that do not touch cannot be joined");
    }
  },
  {
    name: "a plate with holes from the kernel survives a Boolean with an overlapping tool",
    run: async () => {
      const base = createWorkbenchProject("project:test-combine-holes");
      const profiles = detectSketchProfiles({ ...base.sketch, constraints: [] });
      const plate = profiles.find((profile) => profile.entityIds.includes("entity:mounting-outline"))!;
      const bore = profiles.find((profile) => profile.entityIds.includes("entity:centered-bore-profile"))!;
      const built = await createGeneralSolidBody({ profile: plate, holes: [bore], plane: "xy", operation: "extrude", valueMm: 10, bodyId: "general-body:holed", name: "Holed plate", color: "#b9c2c8" });
      assert(built.ok, "the holed plate builds");
      const slab = box([-10, -10, 2], [10, 40, 8]);
      const tool: GeneralSolidBody = { id: "general-body:slab", name: "Slab", visible: true, color: "#b9c2c8", positionsMm: slab.positionsMm as number[], indices: slab.indices as number[] };
      const result = await combineGeneralBodies({ target: built.body, tool, mode: "cut", bodyId: "general-body:slotted", name: "Slotted plate" });
      assert(result.ok, result.ok ? "" : result.message);
      assert(meshVolume(result.body) < meshVolume(built.body) && meshVolume(result.body) > 0, "material was removed and a solid remains");
    }
  }
];
