import { readFileSync } from "node:fs";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchOperation, WORKBENCH_OPERATION_KINDS, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { sketchConstraintPayloadProblem } from "../packages/workbench-core/src/constraint-payload.js";
import { handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, type TestCase } from "./test-kit.js";
import { circle, line, projectWith, rect } from "./sketch-solver-kit.js";

/**
 * Wave 3 payload safety (second re-audit "Curve creation tools" F10 and "Sketch-to-solid pipeline" N2-04): every operation payload
 * validator returns a diagnostic for a missing or wrongly typed field and never throws, through applyWorkbenchOperation and through the
 * MCP preview tool. The fuzzer mutates valid operations of every sketch kind field by field, and throws random field soup at every
 * operation kind.
 */

type Json = unknown;

const baseProject: WorkbenchProject = projectWith(
  [line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5]), circle("c", [30, 0], 5), rect("r", [60, 0], 20, 10)],
  [{ id: "constraint:seed-h", kind: "horizontal", entityIds: ["entity:a"] }]
);

let serial = 0;
const nextId = (): string => `operation:fuzz-${++serial}`;

function op(kind: string, fields: Readonly<Record<string, Json>>): Record<string, Json> {
  return { operationId: nextId(), expectedRevision: 0, kind, ...fields };
}

const constraint = (fields: Readonly<Record<string, Json>>): Record<string, Json> => ({ id: "constraint:fz", ...fields });

/** Valid operations of the sketch family: the seeds the mutator starts from. */
function seeds(): readonly Record<string, Json>[] {
  return [
    op("add-sketch-entity", { entity: { id: "entity:n1", kind: "line", start: [0, 10], end: [5, 10], construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n2", kind: "circle", center: [5, 10], radiusMm: 2, construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n3", kind: "arc", start: [0, 0], mid: [1, 1], end: [2, 0], construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n4", kind: "rectangle", center: [5, 10], widthMm: 4, heightMm: 2, rotationDeg: 0, construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n5", kind: "spline", fitPoints: [[0, 0], [1, 2], [3, 3]], construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n6", kind: "ellipse", center: [5, 10], majorRadiusMm: 4, minorRadiusMm: 2, rotationDeg: 0, construction: false } }),
    op("add-sketch-entity", { entity: { id: "entity:n7", kind: "point", point: [1, 1], construction: false } }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "horizontal", entityIds: ["entity:b"] }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "parallel", entityIds: ["entity:a", "entity:b"] }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "tangent", entityIds: ["entity:a", "entity:c"] }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: 12 }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "radius", dimension: "radius", entityIds: ["entity:c"], valueMm: 6 }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 30 }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: 12, expression: "12" }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "distance", dimension: "aligned", entityIds: ["entity:a", "entity:c"], points: ["start", "center"], valueMm: 20 }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "pierce", entityIds: ["entity:c"], pierce: { kind: "axis", axisId: "axis:z" } }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "refraction", entityIds: ["entity:a", "entity:b", "entity:c"], ratio: 1.5 }) }),
    op("add-sketch-constraint", { constraint: constraint({ kind: "smooth", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] }) }),
    op("delete-sketch-entity", { entityId: "entity:a" }),
    op("delete-sketch-constraint", { constraintId: "constraint:seed-h" }),
    op("set-sketch-dimension", { entityId: "entity:a", dimension: "length", valueMm: 14 }),
    op("set-sketch-dimension", { entityId: "entity:a", secondEntityId: "entity:b", dimension: "line-line", valueMm: 9, points: ["start"] }),
    op("toggle-sketch-construction", { entityId: "entity:a" }),
    op("toggle-sketch-entity-visibility", { entityId: "entity:a" }),
    op("set-sketch-constraints-suppressed", { constraintIds: ["constraint:seed-h"], suppressed: true }),
    op("apply-sketch-edit", {
      label: "Fuzz edit",
      removeEntityIds: [],
      updateEntities: [{ id: "entity:a", kind: "line", start: [0, 0], end: [11, 0], construction: false }],
      addEntities: [{ id: "entity:m1", kind: "line", start: [0, 20], end: [5, 20], construction: false }],
      addConstraints: [{ id: "constraint:m1", kind: "horizontal", entityIds: ["entity:m1"] }],
      removeConstraintIds: ["constraint:seed-h"]
    }),
    op("set-sketch-plane", { plane: "xz", offsetMm: 5 }),
    op("select-workspace", { workspace: "sketch" })
  ];
}

const REPLACEMENTS: readonly Json[] = [null, "text", "", 0, -1, 1e9, 0.001, true, false, [], [null], ["entity:a"], {}, { a: 1 }, [[1, 2], "x"], "constraint:", "entity:a"];

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Every mutation of a JSON value: each path replaced by each replacement, and each key or element removed. */
function* mutations(root: Json): Generator<Json> {
  type Step = string | number;
  function* paths(value: Json, trail: readonly Step[]): Generator<readonly Step[]> {
    yield trail;
    if (Array.isArray(value)) for (let index = 0; index < value.length; index += 1) yield* paths(value[index], [...trail, index]);
    else if (typeof value === "object" && value !== null) for (const key of Object.keys(value)) yield* paths((value as Record<string, Json>)[key], [...trail, key]);
  }
  function at(tree: Json, trail: readonly Step[]): { parent: Record<string, Json> | Json[]; key: Step } | undefined {
    if (trail.length === 0) return undefined;
    let node = tree as Record<string, Json> | Json[];
    for (const step of trail.slice(0, -1)) node = (node as Record<string, Json>)[step as string] as Record<string, Json>;
    return { parent: node, key: trail[trail.length - 1]! };
  }
  for (const trail of paths(root, [])) {
    if (trail.length === 0) continue;
    const protectedField = trail.length === 1 && (trail[0] === "operationId" || trail[0] === "expectedRevision");
    for (const replacement of REPLACEMENTS) {
      const copy = clone(root);
      const target = at(copy, trail)!;
      (target.parent as Record<string, Json>)[target.key as string] = clone(replacement);
      yield copy;
    }
    if (!protectedField) {
      const copy = clone(root);
      const target = at(copy, trail)!;
      if (Array.isArray(target.parent)) target.parent.splice(target.key as number, 1);
      else delete target.parent[target.key as string];
      yield copy;
    }
  }
}

interface Outcome { readonly threw: string | undefined }

function tryApply(project: WorkbenchProject, operation: Json): Outcome {
  try {
    const validated = validateWorkbenchOperation(operation);
    if (!validated.ok) {
      assert(validated.diagnostics.length > 0 && typeof validated.diagnostics[0]?.message === "string" && validated.diagnostics[0].message.length > 0, "a refusal carries a message");
      return { threw: undefined };
    }
    const result = applyWorkbenchOperation(project, operation as WorkbenchOperation);
    if (!result.ok) assert(result.diagnostics.length > 0 && typeof result.diagnostics[0]?.message === "string", "a failure carries a message");
    return { threw: undefined };
  } catch (caught) {
    return { threw: caught instanceof Error ? `${caught.message} :: ${JSON.stringify(operation).slice(0, 300)}` : String(caught) };
  }
}

/** The field names the operation validators read, taken from the source so a new operation field joins the fuzz on its own. */
function fieldVocabulary(): readonly string[] {
  const text = readFileSync("packages/workbench-core/src/operations.ts", "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/input\.([A-Za-z]+)/gu)) names.add(match[1]!);
  for (const name of ["operationId", "expectedRevision", "constraint", "entity", "entityIds", "points", "valueMm", "valueDeg"]) names.add(name);
  return [...names].sort();
}

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const operationPayloadFuzzTests: readonly TestCase[] = [
  {
    name: "Wave3 F10/N2-04: the repro payloads (constraint without id, without entityIds, entityIds as text, null id, null points) are refused with a message that names the field, in apply and through MCP",
    run: async () => {
      const bad: readonly [string, Record<string, Json>, RegExp][] = [
        ["no id", { kind: "horizontal", entityIds: ["entity:a"] }, /no id/u],
        ["no entityIds", { id: "constraint:z", kind: "horizontal" }, /no entityIds/u],
        ["entityIds as text", { id: "constraint:z", kind: "horizontal", entityIds: "entity:a" }, /entityIds (to be|must be) a list/u],
        ["null id", { id: null, kind: "horizontal", entityIds: ["entity:a"] }, /(not a valid stable id|id must be a stable id)/u],
        ["null entityIds", { id: "constraint:z", kind: "horizontal", entityIds: null }, /entityIds (to be|must be) a list/u],
        ["null points", { id: "constraint:z", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: null }, /points (to be|must be) a list/u],
        ["entityIds with a number", { id: "constraint:z", kind: "parallel", entityIds: ["entity:a", 5] }, /(not a curve id|must be a curve id)/u]
      ];
      const guide = await handleWorkbenchMcpTool("ps3d_guide", {});
      const manifestSha256 = guide.structuredContent["manifestSha256"];
      for (const [label, payload, expected] of bad) {
        for (const operation of [op("add-sketch-constraint", { constraint: payload }), op("apply-sketch-edit", { label: "x", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [payload] })]) {
          let result: ReturnType<typeof applyWorkbenchOperation> | undefined;
          try {
            result = applyWorkbenchOperation(baseProject, operation as unknown as WorkbenchOperation);
          } catch (caught) {
            throw new Error(`${label} (${String(operation["kind"])}) threw ${caught instanceof Error ? caught.message : String(caught)}`);
          }
          assert(!result.ok && expected.test(result.diagnostics[0]?.message ?? ""), `${label} (${String(operation["kind"])}) is refused naming the field: ${result.ok ? "accepted" : result.diagnostics[0]?.message}`);
          const viaMcp = await handleWorkbenchMcpTool("ps3d_preview_operation", { project: baseProject, operation, guideAcknowledgement: { manifestSha256, understood: true } });
          assert(viaMcp.isError === true, `${label} (${String(operation["kind"])}) through MCP is an error result, not an exception`);
        }
      }
    }
  },
  {
    name: "Wave3 R2-9: add-sketch-constraint range errors name the field, the value and the limit (length 0.001, radius 0.001, angle 400, angle -10, a huge length) instead of a contradiction or a generic message",
    run: () => {
      const cases: readonly [string, Record<string, Json>, RegExp][] = [
        ["length 0.001", { kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: 0.001 }, /length 0\.001 mm, below the smallest supported size of 0\.01 mm/u],
        ["radius 0.001", { kind: "radius", dimension: "radius", entityIds: ["entity:c"], valueMm: 0.001 }, /radius 0\.001 mm, below the smallest/u],
        ["angle 400", { kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 400 }, /angle 400 degrees, outside the supported range of 0 up to \(not including\) 360\. 40 degrees is the same direction/u],
        ["angle -10", { kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: -10 }, /angle -10 degrees, outside the supported range.*350 degrees is the same direction/u],
        ["length 1e9", { kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: 1e9 }, /above the largest supported size of 200,000 mm/u],
        ["radius 1e9", { kind: "radius", dimension: "radius", entityIds: ["entity:c"], valueMm: 1e9 }, /above the largest supported size of 100,000 mm/u],
        ["length -5", { kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: -5 }, /must be positive/u]
      ];
      for (const [label, payload, expected] of cases) {
        const result = applyWorkbenchOperation(baseProject, op("add-sketch-constraint", { constraint: { id: "constraint:range", ...payload } }) as unknown as WorkbenchOperation);
        const message = result.ok ? "" : result.diagnostics[0]?.message ?? "";
        assert(!result.ok && expected.test(message) && !/contradict/u.test(message) && !/duplicated, or references/u.test(message), `${label}: ${result.ok ? "accepted" : message}`);
      }
      const fine = applyWorkbenchOperation(baseProject, op("add-sketch-constraint", { constraint: { id: "constraint:ok", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 0 } }) as unknown as WorkbenchOperation);
      assert(fine.ok || !/outside the supported range/u.test(fine.ok ? "" : fine.diagnostics[0]?.message ?? ""), "an angle of 0 is in range");
      assert(sketchConstraintPayloadProblem({ id: "constraint:ok", kind: "distance", dimension: "horizontal", entityIds: ["entity:a", "entity:b"], valueMm: 0 }) === undefined, "a relative distance of 0 is in range");
    }
  },
  {
    name: "Wave3 F10: a mutation fuzzer over the sketch operation kinds (every field replaced by null, text, numbers, lists, objects, or removed) never throws in validation or apply, in the direct and the MCP path",
    run: async () => {
      let runs = 0;
      const thrown: string[] = [];
      for (const seed of seeds()) {
        for (const mutated of mutations(seed)) {
          runs += 1;
          const outcome = tryApply(baseProject, mutated);
          if (outcome.threw !== undefined && thrown.length < 8) thrown.push(outcome.threw);
        }
      }
      assert(runs > 3000, `the fuzzer ran a meaningful number of mutations (${runs})`);
      assert(thrown.length === 0, `${thrown.length}+ mutated payloads threw: ${thrown.join(" || ")}`);
      const guide = await handleWorkbenchMcpTool("ps3d_guide", {});
      const manifestSha256 = guide.structuredContent["manifestSha256"];
      const rng = mulberry(7);
      let viaMcp = 0;
      const pool = [...mutations(seeds()[7]!), ...mutations(seeds()[26]!), ...mutations(seeds()[11]!)];
      for (let draw = 0; draw < 150; draw += 1) {
        const operation = pool[Math.floor(rng() * pool.length)]!;
        let result;
        try {
          result = await handleWorkbenchMcpTool("ps3d_preview_operation", { project: baseProject, operation, guideAcknowledgement: { manifestSha256, understood: true } });
        } catch (caught) {
          throw new Error(`MCP preview threw for ${JSON.stringify(operation).slice(0, 300)}: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
        assert(typeof result.content[0]?.text === "string", "an MCP result carries text");
        viaMcp += 1;
      }
      assert(viaMcp === 150, "the MCP path ran");
    }
  },
  {
    name: "Wave3 F10: random field soup sent to every operation kind never throws (the field names come from the validator source)",
    run: () => {
      const vocabulary = fieldVocabulary();
      assert(vocabulary.length > 100, `the vocabulary is read from the validators (${vocabulary.length} names)`);
      const rng = mulberry(20261109);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
      const values: readonly Json[] = [...REPLACEMENTS, "entity:a", "constraint:seed-h", "body:x", "plane:xy", "xy", "x", "positive", "sketch", ["entity:a", "entity:b"], [[0, 0], [1, 1]], [0, 0], [1, 2, 3], { kind: "line" }, { x: 1 }, 5, 12.5, -3];
      const thrown: string[] = [];
      let runs = 0;
      for (const kind of WORKBENCH_OPERATION_KINDS) {
        for (let draw = 0; draw < 120; draw += 1) {
          const fields: Record<string, Json> = {};
          const count = Math.floor(rng() * 6);
          for (let index = 0; index < count; index += 1) fields[pick(vocabulary)] = clone(pick(values));
          const operation = { operationId: nextId(), expectedRevision: 0, kind, ...fields };
          runs += 1;
          const outcome = tryApply(baseProject, operation);
          if (outcome.threw !== undefined && thrown.length < 8) thrown.push(`${kind}: ${outcome.threw}`);
        }
      }
      assert(runs >= WORKBENCH_OPERATION_KINDS.length * 100, `every operation kind was fuzzed (${runs} runs)`);
      assert(thrown.length === 0, `${thrown.length}+ payloads threw: ${thrown.join(" || ")}`);
    }
  },
  {
    name: "Wave3 F10: operations on a fresh default project also survive the mutation fuzzer for the electromechanical, design and part families",
    run: () => {
      const fresh = createWorkbenchProject("project:test-fuzz-default");
      const family: readonly Record<string, Json>[] = [
        op("set-part-parameter", { parameter: "holeDiameterMm", value: 8 }),
        op("set-design-parameters", { parameters: [{ name: "W", expression: "10", unit: "mm", comment: "" }] }),
        op("add-construction-plane", { plane: { id: "plane:fz", name: "Fuzz", visible: true, definition: { kind: "offset", base: "xy", offsetMm: 5 } } }),
        op("add-general-body", { body: { id: "body:fz", name: "Fz", visible: true, definition: { kind: "box", sizeMm: [10, 10, 10] } } }),
        op("set-component-translation", { componentId: "component:x", translationMm: [1, 2, 3] }),
        op("set-drawing-notes", { notes: ["a"] })
      ];
      const thrown: string[] = [];
      for (const seed of family) for (const mutated of mutations(seed)) {
        const outcome = tryApply(fresh, mutated);
        if (outcome.threw !== undefined && thrown.length < 8) thrown.push(outcome.threw);
      }
      assert(thrown.length === 0, `${thrown.length}+ mutated payloads threw: ${thrown.join(" || ")}`);
    }
  }
];
