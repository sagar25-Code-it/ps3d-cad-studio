import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import type { SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles, resolveProfileRegion, sampleArc, type SketchProfile } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-regions").sketch, entities, constraints: [] };
}

function line(id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity {
  return { id, kind: "line", start, end, construction: false };
}

function circle(id: string, center: readonly [number, number], radiusMm: number): SketchEntity {
  return { id, kind: "circle", center, radiusMm, construction: false };
}

/** Exact volume of a closed triangle mesh in cubic millimetres. */
function meshVolumeMm3(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return total / 6;
}

function polygonArea(points: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twice) / 2;
}

/** A 40 x 20 slot-ended bar: two straight sides closed by two half-circle arcs of radius 10. */
const slotEntities: readonly SketchEntity[] = [
  line("entity:top", [0, 10], [30, 10]),
  { id: "entity:right-arc", kind: "arc", start: [30, 10], mid: [40, 0], end: [30, -10], construction: false },
  line("entity:bottom", [30, -10], [0, -10]),
  { id: "entity:left-arc", kind: "arc", start: [0, -10], mid: [-10, 0], end: [0, 10], construction: false }
];

export const sketchRegionTests: readonly TestCase[] = [
  {
    name: "a 3-point arc is sampled from start to end through its midpoint on a constant radius",
    run: () => {
      const clockwise = sampleArc([10, 0], [0, 10], [-10, 0]);
      equal(clockwise[0]![0], 10, "the sample starts exactly at the arc start");
      equal(clockwise[clockwise.length - 1]![0], -10, "the sample ends exactly at the arc end");
      assert(clockwise.length > 8, "a half circle needs several facets");
      for (const point of clockwise) near(Math.hypot(point[0], point[1]), 10, 1e-9, "every sample stays on the circle");
      assert(clockwise.some((point) => point[1] > 9.9), "the arc passes through the midpoint side, not the opposite one");
      const reverse = sampleArc([-10, 0], [0, -10], [10, 0]);
      assert(reverse.some((point) => point[1] < -9.9), "an arc through the lower midpoint bulges downward");
    }
  },
  {
    name: "closed loops of lines and arcs become curve-loop profiles whose arcs stay single segments",
    run: () => {
      const profiles = detectSketchProfiles(sketchOf(slotEntities));
      equal(profiles.length, 1, "the slot is one closed profile");
      const slot = profiles[0]!;
      equal(slot.boundary.kind, "curve-loop", "a loop with arcs is a curve loop");
      if (slot.boundary.kind !== "curve-loop") throw new Error("narrowing");
      equal(slot.boundary.segments.length, 4, "each sketch entity is one segment");
      equal(slot.boundary.segments.filter((segment) => segment.kind === "arc").length, 2, "both arcs are recorded");
      equal(slot.boundary.segments.reduce((total, segment) => total + segment.edgeCount, 0), slot.boundary.points.length, "segment edges account for every outline point");
      // 30 x 20 rectangle plus a full disc of radius 10, within the facet sampling error.
      near(slot.areaMm2, 600 + Math.PI * 100, 1, "area is the rectangle plus the two half discs");

      const lineOnly = detectSketchProfiles(sketchOf([line("entity:a", [0, 0], [10, 0]), line("entity:b", [10, 0], [10, 10]), line("entity:c", [10, 10], [0, 0])]));
      equal(lineOnly[0]?.boundary.kind, "line-loop", "pure line loops keep their exact boundary kind");

      const open = detectSketchProfiles(sketchOf([slotEntities[0]!, slotEntities[1]!, slotEntities[2]!]));
      equal(open.length, 0, "an open chain is not a profile");

      const halfDisc = detectSketchProfiles(sketchOf([line("entity:chord", [-10, 0], [10, 0]), { id: "entity:dome", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false }]));
      equal(halfDisc.length, 1, "one arc and one chord close a half disc");
      near(halfDisc[0]!.areaMm2, (Math.PI * 100) / 2, 0.5, "half disc area");
    }
  },
  {
    name: "a rounded slot extrudes to its exact volume with one cylindrical wall per arc",
    run: async () => {
      const profile = detectSketchProfiles(sketchOf(slotEntities))[0]!;
      const result = await createGeneralSolidBody({ profile, plane: "xy", operation: "extrude", valueMm: 5, bodyId: "general-body:slot", name: "Slot", color: "#b9c2c8" });
      assert(result.ok, "an arc-and-line loop must extrude");
      equal(result.body.brep?.topology.faces, 4 + 2, "four side walls plus two caps");
      const roles = result.body.brep?.faces.map((face) => face.role) ?? [];
      equal(roles.filter((role) => role.startsWith("face.seg-")).length, 4, "walls are named by sketch entity");
      const expected = polygonArea(profile.boundary.kind === "curve-loop" ? profile.boundary.points : []) * 5;
      near(meshVolumeMm3(result.body.positionsMm, result.body.indices), expected, expected * 1e-9, "the mesh volume equals the sampled outline times the height");
      near(expected, (600 + Math.PI * 100) * 5, 16, "and matches the analytic slot volume within facet error");

      // The same slot rebuilt after a resize keeps the wall names, so face references persist.
      const wider = detectSketchProfiles(sketchOf([line("entity:top", [0, 10], [50, 10]), { id: "entity:right-arc", kind: "arc", start: [50, 10], mid: [60, 0], end: [50, -10], construction: false }, line("entity:bottom", [50, -10], [0, -10]), slotEntities[3]!]))[0]!;
      const rebuilt = await createGeneralSolidBody({ profile: wider, plane: "xy", operation: "extrude", valueMm: 5, bodyId: "general-body:slot", name: "Slot", color: "#b9c2c8" });
      assert(rebuilt.ok, "the wider slot extrudes");
      const keyOf = (body: { readonly brep?: { readonly faces: readonly { readonly role: string; readonly key: string }[] } }, role: string): string | undefined => body.brep?.faces.find((face) => face.role === role)?.key;
      for (const role of roles) equal(keyOf(rebuilt.body, role), keyOf(result.body, role), `wall ${role} keeps its reference across a resize`);
    }
  },
  {
    name: "a concave line loop extrudes with the exact volume",
    run: async () => {
      const c: readonly (readonly [number, number])[] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 20], [30, 20], [30, 30], [0, 30]];
      const entities = c.map((point, index) => line(`entity:c-${index}`, point, c[(index + 1) % c.length]!));
      const profile = detectSketchProfiles(sketchOf(entities))[0]!;
      const result = await createGeneralSolidBody({ profile, plane: "xy", operation: "extrude", valueMm: 10, bodyId: "general-body:c", name: "C", color: "#b9c2c8" });
      assert(result.ok, "a C-shaped loop must extrude");
      near(meshVolumeMm3(result.body.positionsMm, result.body.indices), 700 * 10, 1e-6, "C-shape area 700 mm2 times 10 mm");
    }
  },
  {
    name: "profiles inside an outline become holes, either by selection or automatically for a lone selection",
    run: async () => {
      const entities: readonly SketchEntity[] = [
        { id: "entity:plate", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false },
        circle("entity:hole-a", [-15, 0], 5),
        circle("entity:hole-b", [15, 0], 8),
        circle("entity:island", [15, 0], 3)
      ];
      const profiles = detectSketchProfiles(sketchOf(entities));
      const plate = profiles.find((profile) => profile.entityIds.includes("entity:plate"))!;
      const holeA = profiles.find((profile) => profile.entityIds.includes("entity:hole-a"))!;
      const holeB = profiles.find((profile) => profile.entityIds.includes("entity:hole-b"))!;

      const lone = resolveProfileRegion(profiles, [plate.id], { includeIslands: true });
      assert(lone.ok, "a lone outline resolves");
      equal(lone.value.holes.map((hole) => hole.id).sort().join(), [holeA.id, holeB.id].sort().join(), "directly nested profiles become holes; the island inside hole-b does not");

      const none = resolveProfileRegion(profiles, [plate.id], { includeIslands: false });
      assert(none.ok && none.value.holes.length === 0, "islands can be switched off");

      const explicit = resolveProfileRegion(profiles, [holeA.id, plate.id], { includeIslands: false });
      assert(explicit.ok && explicit.value.outer.id === plate.id && explicit.value.holes.length === 1, "the largest selected profile is the outline");

      const outside = resolveProfileRegion([...profiles, ...detectSketchProfiles(sketchOf([circle("entity:far", [200, 0], 5)]))], [plate.id, ...detectSketchProfiles(sketchOf([circle("entity:far", [200, 0], 5)])).map((profile) => profile.id)], { includeIslands: false });
      assert(!outside.ok, "a selected profile outside the outline is rejected");

      const innerIsland = profiles.find((profile) => profile.entityIds.includes("entity:island"))!;
      const nested = resolveProfileRegion(profiles, [plate.id, holeB.id, innerIsland.id], { includeIslands: false });
      assert(!nested.ok, "a profile inside another hole is a separate island and is rejected");

      const result = await createGeneralSolidBody({ profile: plate, holes: lone.value.holes, plane: "xy", operation: "extrude", valueMm: 6, bodyId: "general-body:plate", name: "Plate", color: "#b9c2c8" });
      assert(result.ok, "a plate with two holes must extrude");
      const holeAreas = lone.value.holes.reduce((total, hole) => total + polygonArea(hole.boundary.kind === "circle" ? Array.from({ length: 72 }, (_, step): [number, number] => [hole.boundary.kind === "circle" ? hole.boundary.center[0] + hole.boundary.radiusMm * Math.cos((2 * Math.PI * step) / 72) : 0, hole.boundary.kind === "circle" ? hole.boundary.center[1] + hole.boundary.radiusMm * Math.sin((2 * Math.PI * step) / 72) : 0]) : []), 0);
      const expected = (2400 - holeAreas) * 6;
      near(meshVolumeMm3(result.body.positionsMm, result.body.indices), expected, expected * 1e-9, "plate volume is the outline minus both holes");
      equal(result.body.brep?.faces.filter((face) => face.role.startsWith("face.hole-")).length, 2, "each hole contributes one wall");
      equal(result.body.brep?.topology.faces, 4 + 2 + 2, "four sides, two caps, two hole walls");

      const revolved = await createGeneralSolidBody({ profile: plate, holes: lone.value.holes, plane: "xy", operation: "revolve", valueMm: 90, bodyId: "general-body:bad", name: "Bad", color: "#b9c2c8" });
      assert(!revolved.ok, "revolving a profile with holes is refused rather than silently ignoring them");

      const bad = await createGeneralSolidBody({ profile: plate, holes: [detectSketchProfiles(sketchOf([circle("entity:big", [25, 0], 9)]))[0]!], plane: "xy", operation: "extrude", valueMm: 6, bodyId: "general-body:bad2", name: "Bad", color: "#b9c2c8" });
      assert(!bad.ok && /outside|cross|overlap|boundary/iu.test(bad.message), `a hole that leaves the outline is refused with the kernel reason: ${bad.ok ? "" : bad.message}`);
    }
  },
  {
    name: "the seeded default sketch extrudes as a plate with its centered bore",
    run: async () => {
      const project = createWorkbenchProject("project:test-default-plate");
      const profiles = detectSketchProfiles(project.sketch);
      const region = resolveProfileRegion(profiles, [], { includeIslands: true });
      assert(region.ok, "the default sketch resolves a region");
      equal(region.value.holes.length, 1, "the outline contains the centered bore");
      const outer: SketchProfile = region.value.outer;
      const result = await createGeneralSolidBody({ profile: outer, holes: region.value.holes, plane: "xy", operation: "extrude", valueMm: 10, bodyId: "general-body:default-plate", name: "Plate", color: "#b9c2c8" });
      assert(result.ok, "the default plate extrudes");
      near(meshVolumeMm3(result.body.positionsMm, result.body.indices), (60 * 40 - polygonArea(Array.from({ length: 72 }, (_, step): [number, number] => [5 * Math.cos((2 * Math.PI * step) / 72), 5 * Math.sin((2 * Math.PI * step) / 72)]))) * 10, 1e-4, "60 x 40 x 10 plate with a 10 mm bore");
    }
  }
];
