import type { SketchEntity, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, type TestCase } from "./test-kit.js";
import { circ, fresh, line, message, pipelineApply, pipelineRun, rect } from "./pipeline-kit.js";

/**
 * Wave 3, malformed payloads (P13, P14, N2-04): an operation or an MCP call with a missing, null or wrongly typed field comes back as a
 * refusal that names the field. It never throws, and it never reaches the generic "invalid project" wording.
 */

const ack = async (): Promise<{ readonly manifestSha256: string; readonly understood: true }> => ({ manifestSha256: String((await createPs3dCollaborationGuide())["manifestSha256"]), understood: true });

function sketchProject(): WorkbenchProject {
  let project = fresh();
  project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy" });
  const entities: readonly SketchEntity[] = [rect("r", 0, 0, 40, 20), circ("c", 30, 0, 5), line("l1", [0, 30], [30, 30]), line("l2", [0, 30], [0, 60])];
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Draw" });
}

const raw = (project: WorkbenchProject, operation: Record<string, unknown>): ReturnType<typeof applyWorkbenchOperation> => applyWorkbenchOperation(project, { operationId: `operation:p3-${Math.random().toString(36).slice(2, 10)}`, expectedRevision: project.revision, ...operation } as never);

function refusal(project: WorkbenchProject, operation: Record<string, unknown>): string {
  let result: ReturnType<typeof applyWorkbenchOperation>;
  try {
    result = raw(project, operation);
  } catch (error) {
    throw new Error(`${String(operation["kind"])} threw ${error instanceof Error ? error.message : String(error)} for ${JSON.stringify(operation).slice(0, 200)}`);
  }
  assert(!result.ok, `${JSON.stringify(operation).slice(0, 160)} is refused`);
  return result.ok ? "" : result.diagnostics.map((diagnostic) => diagnostic.message).join(" | ");
}

const textObject = { id: "text:label", text: "PS3D", font: "stroke-1", heightMm: 5, widthFactor: 1, spacing: 1, align: "left", rotationDeg: 0, originMm: [0, 0], construction: false, entityIds: ["entity:t1"] };
const patternObject = { id: "pattern:holes", sourceIds: ["entity:c"], suppressed: [], spec: { kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 0, extent: false } };
const underlayObject = { name: "scan", imageId: "image-abcd", widthPx: 100, heightPx: 80, originMm: [0, 0], mmPerPixel: 0.5, rotationDeg: 0, opacity: 0.5, locked: true, visible: true };

export const pipeline3PayloadTests: readonly TestCase[] = [
  {
    name: "Wave3 N2-04, P14: add-sketch-constraint with a missing, null or mistyped id, kind, entityIds or points is refused naming the field, never thrown",
    run: () => {
      const project = sketchProject();
      const ok = { id: "constraint:k", kind: "equal", entityIds: ["entity:l1", "entity:l2"] };
      const cases: readonly [Record<string, unknown>, RegExp][] = [
        [{ kind: "equal", entityIds: ["entity:l1", "entity:l2"] }, /no id/u],
        [{ ...ok, id: null }, /id must be a stable id/u],
        [{ ...ok, id: true }, /id must be a stable id/u],
        [{ id: "constraint:k", kind: "equal" }, /no entityIds/u],
        [{ ...ok, entityIds: null }, /entityIds must be a list/u],
        [{ ...ok, entityIds: true }, /entityIds must be a list/u],
        [{ ...ok, entityIds: [] }, /takes 1 to 2 curve ids/u],
        [{ ...ok, entityIds: [null, "entity:l2"] }, /entityIds entry 1 must be a curve id/u],
        [{ ...ok, kind: undefined }, /no kind/u],
        [{ ...ok, kind: "bend" }, /kind must be one of/u],
        [{ id: "constraint:k", kind: "coincident", entityIds: ["entity:l1", "entity:l2"], points: null }, /points must be a list/u],
        [{ id: "constraint:k", kind: "coincident", entityIds: ["entity:l1", "entity:l2"], points: ["start", "middle"] }, /points entry 2/u],
        [{ id: "constraint:k", kind: "distance", entityIds: ["entity:l1"], valueMm: "far" }, /valueMm must be a finite number/u]
      ];
      for (const [constraint, expected] of cases) {
        const text = refusal(project, { kind: "add-sketch-constraint", constraint });
        assert(expected.test(text), `${JSON.stringify(constraint)} names the field: ${text}`);
        assert(!/exact bounded|invalid or has a duplicate/u.test(text.split("|")[0] ?? ""), `and is not the generic wording: ${text}`);
      }
      assert(/object/u.test(refusal(project, { kind: "add-sketch-constraint", constraint: null })), "a null constraint says an object is needed");
      // The same relation inside an apply-sketch-edit.
      const inEdit = refusal(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [{ kind: "equal" }], label: "x" });
      assert(/Relation number 1/u.test(inEdit) && /no id/u.test(inEdit), `a relation inside an edit is named by position: ${inEdit}`);
      const good = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:k", kind: "equal", entityIds: ["entity:l1", "entity:l2"] } });
      assert(good.ok, `a well-formed relation still works: ${message(good)}`);
    }
  },
  {
    name: "Wave3 P13: a bad text, pattern or underlay object, a parameter table entry or a missing curve is named with its object and field",
    run: () => {
      const project = sketchProject();
      const edit = (objects: Record<string, unknown>): Record<string, unknown> => ({ kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "objects", objects });
      let text = refusal(project, edit({ texts: [{ ...textObject, heightMm: 2000 }] }));
      assert(/Text object "text:label"/u.test(text) && /heightMm/u.test(text) && /0\.5 to 1000/u.test(text) && /2000/u.test(text), `text height: ${text}`);
      text = refusal(project, edit({ texts: [{ ...textObject, text: "" }] }));
      assert(/Text object "text:label": text must be/u.test(text), `empty text: ${text}`);
      text = refusal(project, edit({ texts: [{ ...textObject, id: "label" }] }));
      assert(/id must be an id that starts with "text:"/u.test(text), `text id: ${text}`);
      text = refusal(project, edit({ texts: [{ ...textObject, align: "middle" }] }));
      assert(/align/u.test(text) && /"left", "center" or "right"/u.test(text), `align: ${text}`);
      const { entityIds: _gone, ...noIds } = textObject;
      void _gone;
      text = refusal(project, edit({ texts: [noIds] }));
      assert(/missing its entityIds/u.test(text), `missing field: ${text}`);
      text = refusal(project, edit({ patterns: [{ ...patternObject, spec: { ...patternObject.spec, countX: 500 } }] }));
      assert(/Pattern object "pattern:holes"/u.test(text) && /countX/u.test(text) && /500/u.test(text), `pattern count: ${text}`);
      text = refusal(project, edit({ patterns: [{ ...patternObject, spec: { kind: "spiral" } }] }));
      assert(/spec\.kind must be "rectangular", "circular" or "path"/u.test(text), `pattern kind: ${text}`);
      text = refusal(project, edit({ patterns: [{ ...patternObject, spec: { ...patternObject.spec, countX: 1, countY: 1 } }] }));
      assert(/at least 2 instances/u.test(text), `one instance: ${text}`);
      text = refusal(project, edit({ underlay: { ...underlayObject, opacity: 3 } }));
      assert(/Underlay "scan"/u.test(text) && /opacity/u.test(text) && /0\.05 to 1/u.test(text), `underlay opacity: ${text}`);
      text = refusal(project, edit({ underlay: { ...underlayObject, imageId: "x" } }));
      assert(/imageId/u.test(text), `underlay image: ${text}`);
      text = refusal(project, edit({ texts: "hello" }));
      assert(/texts must be a list/u.test(text), `texts not a list: ${text}`);
      text = refusal(project, edit({ colour: 1 }));
      assert(/"colour"/u.test(text), `unknown object field: ${text}`);
      // A valid object is still accepted.
      const accepted = pipelineApply(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "pattern", objects: { patterns: [patternObject as never] } });
      assert(accepted.ok, `a valid pattern is accepted: ${message(accepted)}`);

      const parameter = { name: "w", expression: "30 mm", unit: "mm", comment: "" };
      const { comment: _comment, ...noComment } = parameter;
      void _comment;
      text = refusal(project, { kind: "set-design-parameters", parameters: [noComment] });
      assert(/Parameter "w" is missing its comment/u.test(text), `parameter without a comment: ${text}`);
      text = refusal(project, { kind: "set-design-parameters", parameters: [{ ...parameter, unit: "kg" }] });
      assert(/Parameter "w": unit must be/u.test(text), `parameter unit: ${text}`);
      text = refusal(project, { kind: "set-design-parameters", parameters: [null] });
      assert(/Parameter number 1 must be an object/u.test(text), `null parameter: ${text}`);

      text = refusal(project, { kind: "apply-sketch-edit", removeEntityIds: ["entity:nope"], updateEntities: [], addEntities: [], addConstraints: [], label: "x" });
      assert(/entity:nope/u.test(text), `a missing curve is named: ${text}`);
      text = refusal(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [{ ...circ("zzz", 0, 0, 3) }], addEntities: [], addConstraints: [], label: "x" });
      assert(/entity:zzz/u.test(text), `an update of a missing curve is named: ${text}`);
      text = refusal(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("c", 1, 1, 2)], addConstraints: [], label: "x" });
      assert(/entity:c/u.test(text), `a reused id is named: ${text}`);
      text = refusal(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [null], addConstraints: [], label: "x" });
      assert(/addEntities entry 1 must be an object/u.test(text), `a null entity: ${text}`);
      text = refusal(project, { kind: "delete-sketch-entity", entityId: "entity:gone" });
      assert(/entity:gone/u.test(text), `delete names the id: ${text}`);
    }
  },
  {
    name: "Wave3 N2-04: a deterministic mutation fuzz over sketch, constraint, object and parameter operations never throws, and the MCP handler returns isError",
    run: async () => {
      let project = sketchProject();
      project = pipelineRun(project, { kind: "set-design-parameters", parameters: [{ name: "w", expression: "30 mm", unit: "mm", comment: "" }] });
      const valid: readonly Record<string, unknown>[] = [
        { kind: "add-sketch-entity", entity: { id: "entity:n", kind: "line", start: [0, 0], end: [5, 5], construction: false } },
        { kind: "delete-sketch-entity", entityId: "entity:c" },
        { kind: "add-sketch-constraint", constraint: { id: "constraint:k", kind: "equal", entityIds: ["entity:l1", "entity:l2"] } },
        { kind: "add-sketch-constraint", constraint: { id: "constraint:k", kind: "coincident", entityIds: ["entity:l1", "entity:l2"], points: ["start", "start"] } },
        { kind: "add-sketch-constraint", constraint: { id: "constraint:k", kind: "distance", entityIds: ["entity:c", "entity:l1"], points: ["center", "self"], dimension: "aligned", valueMm: 20 } },
        { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 50 },
        { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "radius", valueMm: 6, expression: "w/5" },
        { kind: "toggle-sketch-construction", entityId: "entity:c" },
        { kind: "set-sketch-constraints-suppressed", constraintIds: ["constraint:k"], suppressed: true },
        { kind: "apply-sketch-edit", removeEntityIds: ["entity:c"], updateEntities: [{ id: "entity:l1", kind: "line", start: [0, 31], end: [30, 31], construction: false }], addEntities: [{ id: "entity:n", kind: "point", point: [3, 3], construction: false }], addConstraints: [{ id: "constraint:z", kind: "horizontal", entityIds: ["entity:l1"] }], label: "x" },
        { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "objects", objects: { texts: [textObject], patterns: [patternObject], underlay: underlayObject } },
        { kind: "set-design-parameters", parameters: [{ name: "w", expression: "40 mm", unit: "mm", comment: "c" }], renames: [{ from: "w", to: "w2" }] },
        { kind: "set-sketch-plane", plane: "datum:xz", offsetMm: 5 },
        { kind: "new-design-sketch", plane: "datum:yz", offsetMm: 3, tilt: { axis: "x", angleDeg: 10 } },
        { kind: "regenerate-design", results: [{ featureId: "feature:s1", message: "hi" }] }
      ];
      let seed = 20260211;
      const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
      const paths = (value: unknown, prefix: string[] = [], out: string[][] = []): string[][] => {
        if (typeof value === "object" && value !== null) for (const key of Object.keys(value)) { out.push([...prefix, key]); paths((value as Record<string, unknown>)[key], [...prefix, key], out); }
        return out;
      };
      const mutations: readonly (() => unknown)[] = [() => null, () => "x", () => -1, () => 1e300, () => 0, () => [], () => ({}), () => true, () => undefined, () => Number.NaN, () => Number.POSITIVE_INFINITY, () => "entity:nope", () => 1e-9, () => "", () => [1], () => [null], () => "A".repeat(300)];
      const throws: string[] = [];
      let total = 0;
      for (const base of valid) {
        const targets = paths(base);
        for (let round = 0; round < 260; round += 1) {
          const operation = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
          const path = targets[Math.floor(random() * targets.length)]!;
          let holder: Record<string, unknown> = operation;
          for (let depth = 0; depth < path.length - 1; depth += 1) holder = holder[path[depth]!] as Record<string, unknown>;
          const mutated = mutations[Math.floor(random() * mutations.length)]!();
          if (mutated === undefined) delete holder[path[path.length - 1]!]; else holder[path[path.length - 1]!] = mutated;
          total += 1;
          try {
            raw(project, operation);
          } catch (error) {
            if (throws.length < 6) throws.push(`${String(base["kind"])} ${path.join(".")}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      assert(throws.length === 0, `${total} mutated operations, none may throw: ${throws.join(" || ")}`);
      // The MCP handler answers a malformed relation with an error result.
      const acknowledgement = await ack();
      for (const constraint of [{ id: "constraint:k", kind: "equal" }, { kind: "equal", entityIds: ["entity:l1", "entity:l2"] }, { id: "constraint:k", kind: "coincident", entityIds: ["entity:l1", "entity:l2"], points: null }]) {
        const result = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: { operationId: "operation:mcp-1", expectedRevision: project.revision, kind: "add-sketch-constraint", constraint }, guideAcknowledgement: acknowledgement });
        assert(result.isError === true, `the MCP preview of ${JSON.stringify(constraint)} is an error result, not an exception`);
        assert(!/TypeError|Cannot read|is not a function/u.test(JSON.stringify(result.content)), "and names the field instead of a JavaScript message");
      }
      const odd = await handleWorkbenchMcpTool("ps3d_design_health", { project: { revision: {} } });
      assert(odd.isError === true, "a hollow project is an error result");
    }
  }
];
