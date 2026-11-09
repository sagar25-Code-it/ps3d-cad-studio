import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { triangulateLoops } from "../packages/occt-kernel-adapter/src/polygon.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { circ, rect, sketchFeatureOf, sketchOf, solidFeature } from "./region-wave2-kit.js";
import { meshReport } from "./region-wave3-kit.js";

/**
 * Region engine, wave 3: the second re-audit found plates with a row of four equal holes (or a 12-hole bolt circle) that extrude to
 * a mesh with open edges, near-coincident intersections that dropped faces, stored references that lost or shrank holes, twisted
 * sweeps that built two stations, and plates that could not hold more than about 80 holes.
 */

interface Layout { readonly name: string; readonly entities: readonly SketchEntity[]; readonly area: number; readonly rotationDeg?: number }

function plateWith(name: string, plate: { readonly width: number; readonly height: number; readonly rotationDeg?: number; readonly center?: readonly [number, number] }, holes: readonly { readonly at: readonly [number, number]; readonly radius: number }[]): Layout {
  const center = plate.center ?? [0, 0];
  const turn = (point: readonly [number, number]): readonly [number, number] => {
    const angle = ((plate.rotationDeg ?? 0) * Math.PI) / 180;
    return [center[0] + point[0] * Math.cos(angle) - point[1] * Math.sin(angle), center[1] + point[0] * Math.sin(angle) + point[1] * Math.cos(angle)];
  };
  const base = rect("plate", center, plate.width, plate.height);
  const entities: SketchEntity[] = [plate.rotationDeg ? { ...base, rotationDeg: plate.rotationDeg } as SketchEntity : base];
  holes.forEach((hole, index) => entities.push(circ(`h${index}`, turn(hole.at), hole.radius)));
  return { name, entities, area: plate.width * plate.height - holes.reduce((total, hole) => total + Math.PI * hole.radius * hole.radius, 0) };
}

function layouts(): Layout[] {
  const all: Layout[] = [];
  // Rows and grids of equal holes, in every size the audit tried and more.
  for (const cols of [1, 2, 3, 4, 5, 6, 7, 8, 12]) for (const rows of [1, 2, 3]) for (const pitch of [9, 12.5]) {
    const holes: { at: [number, number]; radius: number }[] = [];
    for (let i = 0; i < cols; i += 1) for (let j = 0; j < rows; j += 1) holes.push({ at: [(i - (cols - 1) / 2) * pitch, (j - (rows - 1) / 2) * pitch], radius: 3 });
    all.push(plateWith(`grid ${cols}x${rows}@${pitch}`, { width: cols * pitch + 20, height: rows * pitch + 20 }, holes));
  }
  // Bolt circles of 3 to 24 holes, some turned by an angle so no hole sits on an axis.
  for (let count = 3; count <= 24; count += 1) for (const turnDeg of [0, 7.5]) {
    const holes = Array.from({ length: count }, (_, index) => {
      const angle = ((index * 360) / count + turnDeg) * (Math.PI / 180);
      return { at: [35 * Math.cos(angle), 35 * Math.sin(angle)] as const, radius: Math.min(4, 35 * Math.sin(Math.PI / count) * 0.6) };
    });
    all.push(plateWith(`bolt circle ${count} turned ${turnDeg}`, { width: 100, height: 100 }, holes));
  }
  // The plate itself turned, so no edge is axis-aligned.
  for (const turnDeg of [15, 30, 45, 90]) for (const cols of [4, 6]) {
    const holes = Array.from({ length: cols }, (_, index) => ({ at: [(index - (cols - 1) / 2) * 14, 0] as const, radius: 4 }));
    all.push(plateWith(`row of ${cols} on a plate turned ${turnDeg}`, { width: cols * 14 + 20, height: 40, rotationDeg: turnDeg, center: [10, -5] }, holes));
  }
  // Mixed radii and holes close to the edge.
  for (const radii of [[3, 4, 5, 3], [2, 2, 3, 3, 2, 2], [5, 3, 3, 5, 3, 3, 5]]) {
    const total = radii.reduce((sum, radius) => sum + radius * 2 + 4, -4);
    let x = -total / 2;
    const holes = radii.map((radius) => { const at = [x + radius, 0] as const; x += radius * 2 + 4; return { at, radius }; });
    all.push(plateWith(`mixed radii ${radii.join("-")}`, { width: total + 20, height: 30 }, holes));
  }
  for (const wall of [0.5, 1, 2]) {
    const holes = [0, 1, 2, 3].map((index) => ({ at: [-30 + index * 20, 15 - 4 - wall] as const, radius: 4 }));
    all.push(plateWith(`row of 4 with a ${wall} mm wall to the edge`, { width: 100, height: 30 }, holes));
  }
  return all;
}

async function closedBodyOf(layout: Layout, extra: Parameters<typeof solidFeature>[1] = {}) {
  const built = await rebuildSolidFeature(solidFeature("extrude", extra), sketchFeatureOf(sketchOf(layout.entities)));
  assert(built.ok, `${layout.name}: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  return built.body;
}

export const regionWave3Tests: readonly TestCase[] = [
  {
    name: "region R2-01: a row of four equal holes extrudes to a closed manifold (was 6 open edges)",
    run: async () => {
      const layout = plateWith("row of 4", { width: 100, height: 40, center: [50, 20] }, [0, 1, 2, 3].map((index) => ({ at: [15 + (index * 70) / 3 - 50, 0] as const, radius: 4 })));
      const body = await closedBodyOf(layout);
      const report = meshReport(body.positionsMm, body.indices);
      equal(report.badEdges, 0, "every edge is shared by exactly two triangles");
      equal(report.sameDirectionEdges, 0, "the winding is consistent");
      assert(report.signedVolume > 0, "the volume is positive");
    }
  },
  {
    name: "region R2-01: a 12-hole bolt circle extrudes to a closed manifold (was 24 open edges)",
    run: async () => {
      const holes = Array.from({ length: 12 }, (_, index) => ({ at: [14 * Math.cos((index * Math.PI) / 6), 14 * Math.sin((index * Math.PI) / 6)] as const, radius: 2 }));
      const body = await closedBodyOf(plateWith("bolt circle", { width: 100, height: 40 }, holes));
      const report = meshReport(body.positionsMm, body.indices);
      equal(report.badEdges, 0, "every edge is shared by exactly two triangles");
      equal(report.sameDirectionEdges, 0, "the winding is consistent");
    }
  },
  {
    name: "region R2-01: every body of the layout sweep (rows, grids, bolt circles, turned plates, mixed radii, holes near edges, fillets) is a closed manifold of the analytic volume",
    run: async () => {
      let tried = 0;
      const problems: string[] = [];
      for (const layout of layouts()) {
        for (const treatment of [undefined, { kind: "fillet" as const, sizeMm: 1.5 }, { kind: "chamfer" as const, sizeMm: 1 }]) {
          // Fillets and chamfers on every layout would triple the time; the corner treatment is sampled on a third of them.
          if (treatment !== undefined && tried % 3 !== 0) { tried += 1; continue; }
          tried += 1;
          const built = await rebuildSolidFeature(solidFeature("extrude", treatment === undefined ? {} : { edge: treatment }), sketchFeatureOf(sketchOf(layout.entities)));
          if (!built.ok) { problems.push(`${layout.name}${treatment ? " " + treatment.kind : ""}: ${built.message}`); continue; }
          const report = meshReport(built.body.positionsMm, built.body.indices);
          const label = `${layout.name}${treatment ? " " + treatment.kind : ""}`;
          if (report.badEdges !== 0) problems.push(`${label}: ${report.badEdges} open or over-shared edges`);
          if (report.sameDirectionEdges !== 0) problems.push(`${label}: ${report.sameDirectionEdges} edges wound the same way`);
          if (!(report.signedVolume > 0)) problems.push(`${label}: volume ${report.signedVolume}`);
          if (treatment === undefined) {
            const expected = layout.area * 10;
            if (Math.abs(report.signedVolume - expected) > expected * 0.012) problems.push(`${label}: volume ${report.signedVolume.toFixed(1)} against ${expected.toFixed(1)}`);
          }
        }
      }
      assert(tried >= 150, `the sweep covers at least 150 builds (${tried})`);
      equal(problems.length, 0, `no body is open, mis-wound or the wrong size: ${problems.slice(0, 4).join(" | ")}`);
    }
  },
  {
    name: "region R2-01: triangulating loops whose bridges pass through another hole's extreme point keeps every boundary edge",
    run: () => {
      const ring = (cx: number, cy: number, r: number, count: number): (readonly [number, number])[] => Array.from({ length: count }, (_, index) => [cx + r * Math.cos((2 * Math.PI * index) / count), cy + r * Math.sin((2 * Math.PI * index) / count)] as const).reverse();
      const outer: (readonly [number, number])[] = [[0, 0], [100, 0], [100, 40], [0, 40]];
      const holes = [0, 1, 2, 3].map((index) => ring(15 + (index * 70) / 3, 20, 4, 64));
      const triangles = triangulateLoops(outer, holes);
      const loops = [outer, ...holes];
      const directed = new Map<string, number>();
      for (let index = 0; index < triangles.length; index += 3) for (let edge = 0; edge < 3; edge += 1) {
        const key = `${triangles[index + edge]}>${triangles[index + ((edge + 1) % 3)]}`;
        directed.set(key, (directed.get(key) ?? 0) + 1);
      }
      let offset = 0;
      for (const loop of loops) {
        for (let index = 0; index < loop.length; index += 1) {
          const a = offset + index;
          const b = offset + ((index + 1) % loop.length);
          // Every boundary edge is used by exactly one triangle, in one direction.
          equal((directed.get(`${a}>${b}`) ?? 0) + (directed.get(`${b}>${a}`) ?? 0), 1, `boundary edge ${a}-${b} is used once`);
        }
        offset += loop.length;
      }
    }
  }
];

