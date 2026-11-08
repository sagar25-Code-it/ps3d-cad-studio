import type { DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchProject, WorkbenchResult } from "../packages/workbench-core/src/index.js";
import {
  AUDIT_KEEP_FULL, AUDIT_MAX_ENTRIES, WORKBENCH_LIMITS, applyWorkbenchOperation, auditCapacity, compactWorkbenchAudit, createWorkbenchProject, designOf,
  parseWorkbenchProjectText, serializeWorkbenchProject, validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { createLatestWinsWriter } from "../apps/studio-web/src/latest-wins-writer.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";
import { pipelineGeometryTests } from "./pipeline-geometry.test.js";
import { pipelineSweepTests } from "./pipeline-sweep.test.js";

function tinyBody(id: string, scale = 1): GeneralSolidBody {
  const p = [0, 0, 0, 10 * scale, 0, 0, 0, 10 * scale, 0, 0, 0, 10 * scale];
  return { id, name: id, visible: true, color: "#b9c2c8", positionsMm: p, indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
}

/** A closed grid-sphere style mesh with roughly `triangles` triangles, used to make a project file heavy. */
function heavyBody(id: string, rings: number): GeneralSolidBody {
  const segments = rings;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const theta = (Math.PI * i) / rings;
      const phi = (2 * Math.PI * j) / segments;
      positions.push(50 * Math.sin(theta) * Math.cos(phi), 50 * Math.sin(theta) * Math.sin(phi), 50 * Math.cos(theta));
    }
  }
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = i * segments + j; const b = i * segments + ((j + 1) % segments);
      const c = (i + 1) * segments + j; const d = (i + 1) * segments + ((j + 1) % segments);
      indices.push(a, c, b, b, c, d);
    }
  }
  return { id, name: id, visible: true, color: "#b9c2c8", positionsMm: positions, indices };
}

export const pipelinePlatformTests: readonly TestCase[] = [
  ...pipelineGeometryTests,
  ...pipelineSweepTests,
  {
    name: "P13 an invalid sketch entity is refused with its id, the field and the limit, not a generic project message",
    run: () => {
      const project = fresh();
      const cases: readonly [string, unknown, RegExp][] = [
        ["zero-length line", line("zero", [1, 1], [1, 1]), /entity:zero.*0 mm long.*0\.01 mm/su],
        ["tiny circle", { id: "entity:tiny", kind: "circle", center: [0, 0], radiusMm: 0.005, construction: false }, /entity:tiny.*radius = 0\.005 mm.*0\.01 mm/su],
        ["far coordinate", line("far", [0, 0], [100001, 0]), /entity:far.*end x = 100,001 mm.*100,000 mm/su],
        ["huge circle", { id: "entity:huge", kind: "circle", center: [0, 0], radiusMm: 100001, construction: false }, /entity:huge.*radius = 100,001 mm.*above the 100,000 mm limit/su],
        ["wide rectangle", { id: "entity:wide", kind: "rectangle", center: [0, 0], widthMm: 200001, heightMm: 5, rotationDeg: 0, construction: false }, /entity:wide.*width = 200,001 mm.*200,000 mm/su],
        ["rotation", { id: "entity:rot", kind: "rectangle", center: [0, 0], widthMm: 5, heightMm: 5, rotationDeg: 400, construction: false }, /entity:rot.*rotation = 400.*-360 to 360/su],
        ["collinear arc", { id: "entity:arc", kind: "arc", start: [0, 0], mid: [5, 0], end: [10, 0], construction: false }, /entity:arc.*straight line/su],
        ["two-point spline", { id: "entity:two", kind: "spline", fitPoints: [[0, 0], [5, 5]], construction: false }, /entity:two.*2 fit points.*3 to 24/su],
        ["25-point spline", { id: "entity:many", kind: "spline", fitPoints: Array.from({ length: 25 }, (_, index) => [index * 3, index % 2]), construction: false }, /entity:many.*25 fit points.*3 to 24/su],
        ["minor over major", { id: "entity:ell", kind: "ellipse", center: [0, 0], majorRadiusMm: 5, minorRadiusMm: 8, rotationDeg: 0, construction: false }, /entity:ell.*minor radius.*larger than its major/su],
        ["unknown kind", { id: "entity:odd", kind: "blob", construction: false }, /entity:odd.*unknown kind "blob"/su],
        ["extra field", { ...line("extra", [0, 0], [5, 0]), colour: "red" }, /entity:extra.*unsupported field "colour"/su],
        ["bad id", { ...line("x", [0, 0], [5, 0]), id: "Entity:Upper" }, /not a valid stable id/su]
      ];
      for (const [label, entity, expected] of cases) {
        const added = pipelineApply(project, { kind: "add-sketch-entity", entity: entity as SketchEntity });
        assert(!added.ok, `${label} is refused`);
        assert(expected.test(message(added)), `${label} is explained by name, field and limit, got: ${message(added)}`);
        assert(!/duplicate ID/u.test(message(added)), `${label} no longer blames a duplicate ID`);
        const edited = pipelineApply(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [entity as SketchEntity], addConstraints: [], label: "Add one" });
        assert(!edited.ok && expected.test(message(edited)), `${label} is explained the same way inside apply-sketch-edit, got: ${message(edited)}`);
      }
      // A project file that holds such an entity names it too.
      const broken = { ...fresh(), sketch: { ...fresh().sketch, entities: [{ id: "entity:bad", kind: "circle", center: [0, 0], radiusMm: 0, construction: false }] } };
      const loaded = validateWorkbenchProject(broken);
      assert(!loaded.ok && /entity:bad.*radius/su.test(message(loaded)), `a stored bad entity is named when the project loads, got: ${message(loaded)}`);
    }
  },
  {
    name: "P14 NaN and Infinity in an entity payload give a diagnostic instead of throwing",
    run: () => {
      const project = fresh();
      const attempts: readonly (() => WorkbenchResult<unknown>)[] = [
        () => pipelineApply(project, { kind: "add-sketch-entity", entity: { id: "entity:nan", kind: "point", point: [Number.NaN, 0], construction: false } }),
        () => pipelineApply(project, { kind: "add-sketch-entity", entity: { id: "entity:inf", kind: "point", point: [Number.POSITIVE_INFINITY, 0], construction: false } }),
        () => pipelineApply(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:c", kind: "circle", center: [0, 0], radiusMm: Number.NaN, construction: false }], addConstraints: [], label: "NaN radius" }),
        () => pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:none", dimension: "length", valueMm: Number.NaN }),
        () => pipelineApply(project, { kind: "set-part-parameter", parameter: "widthMm", value: Number.POSITIVE_INFINITY })
      ];
      for (const [index, attempt] of attempts.entries()) {
        let result: WorkbenchResult<unknown> | undefined;
        try { result = attempt(); } catch (error) { assert(false, `attempt ${index} must not throw: ${String(error)}`); }
        assert(result !== undefined && !result.ok, `attempt ${index} is refused with a diagnostic`);
        assert(message(result).length > 10, `attempt ${index} says why: ${message(result)}`);
      }
      // Whatever slips past a shape check still cannot crash the reducer: a non-finite number buried in a payload is named by path.
      const buried = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:x", kind: "radius", entityIds: ["entity:none"], valueMm: Number.NaN } });
      assert(!buried.ok, "a non-finite constraint value is refused");
    }
  },
  {
    name: "P20/E22/T19 one documented envelope: 100 m sketches and 20 m extrudes work, and every limit names itself",
    run: () => {
      // A 20 m line (the audit's T19 case) used to be refused with the generic text; it is inside the +/-100 m sketch limit now.
      let project = fresh();
      project = pipelineRun(project, { kind: "add-sketch-entity", entity: line("long", [0, 0], [20_000, 5]) });
      project = pipelineRun(project, { kind: "add-sketch-entity", entity: { id: "entity:rect", kind: "rectangle", center: [50_000, 0], widthMm: 100_000, heightMm: 40, rotationDeg: 0, construction: false } });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:long", dimension: "length", valueMm: 30_000 });
      const beyond = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:long", dimension: "length", valueMm: 250_000 });
      assert(!beyond.ok && /200,000/u.test(message(beyond)), `a dimension past the limit names it: ${message(beyond)}`);
      const tooSmall = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:long", dimension: "length", valueMm: 0.001 });
      assert(!tooSmall.ok && /0\.01/u.test(message(tooSmall)), `a dimension below the minimum names it: ${message(tooSmall)}`);

      // Solid features: the distance limit and the minimum are named, a body 15 m out is stored, one past 1000 m is refused with the cause.
      const sketched = pipelineRun(pipelineRun(fresh(), { kind: "add-sketch-entity", entity: line("a", [0, 0], [10, 0]) }), { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
      const feature = (extra: Partial<DesignSolidFeature>): DesignSolidFeature => ({ id: "feature:e1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 10, bodyId: "general-body:e1", ...extra });
      const thin = pipelineApply(sketched, { kind: "add-design-solid", feature: feature({ valueMm: 0.005 }), body: tinyBody("general-body:e1") });
      assert(!thin.ok && /0\.005 mm.*0\.01 mm/su.test(message(thin)), `an extrusion thinner than a sketch can be is named: ${message(thin)}`);
      const far = pipelineApply(sketched, { kind: "add-design-solid", feature: feature({ valueMm: 100 }), body: { ...tinyBody("general-body:e1"), positionsMm: [15_000, 0, 0, 25_000, 0, 0, 15_000, 10, 0, 15_000, 0, 10] } });
      assert(far.ok, `a body 15 m out is accepted (the old 10 m wall): ${message(far)}`);
      const wall = pipelineApply(sketched, { kind: "add-design-solid", feature: feature({ valueMm: 100 }), body: { ...tinyBody("general-body:e1"), positionsMm: [2_000_000, 0, 0, 25, 0, 0, 0, 10, 0, 0, 0, 10] } });
      assert(!wall.ok && /1,000,000 mm/u.test(message(wall)), `a body beyond the model limit says how far it reaches: ${message(wall)}`);
      const huge = pipelineApply(sketched, { kind: "add-design-solid", feature: feature({ valueMm: 150_000 }), body: tinyBody("general-body:e1") });
      assert(!huge.ok && /100,000 mm feature limit/u.test(message(huge)), `a distance past the limit is named: ${message(huge)}`);
      equal(WORKBENCH_LIMITS.maxSketchCoordinateMm, 100_000, "the sketch limit is exported for the UI to quote");
    }
  },
  {
    name: "P02/E01 the audit never freezes the project: 1,300 operations fold into a checkpoint that keeps revisions and survives save and reload",
    run: () => {
      let project = fresh();
      for (let index = 0; index < 1_300; index += 1) {
        const result = pipelineApply(project, { kind: "select-workspace", workspace: index % 2 === 0 ? "part" : "sketch" });
        assert(result.ok, `operation ${index + 1} is accepted: ${message(result)}`);
        project = result.value.project;
      }
      equal(project.revision, 1_300, "every operation advanced the revision");
      assert(project.audit.length <= AUDIT_MAX_ENTRIES, `the audit stays bounded (${project.audit.length})`);
      const first = project.audit[0]!;
      equal(first.kind, "audit-checkpoint", "the oldest entry is the checkpoint");
      equal(first.checkpoint?.firstRevision, 1, "it starts at revision 1");
      equal(project.audit[project.audit.length - 1]!.revision, 1_300, "the last entry keeps its revision number");
      equal((first.checkpoint?.operations ?? 0) + project.audit.length - 1, 1_300, "folded operations plus kept entries account for every operation");
      assert(/^[0-9a-f]{64}$/u.test(first.checkpoint?.digest ?? ""), "the checkpoint carries a SHA-256 chain digest");
      const capacity = auditCapacity(project);
      equal(capacity.totalOperations, 1_300, "the capacity indicator reports every operation");
      assert(capacity.fraction > 0 && capacity.fraction <= 1 && capacity.label.includes("compacted"), `the indicator reads: ${capacity.label}`);
      // Save and reload: the file validates again and keeps working.
      const reloaded = parseWorkbenchProjectText(JSON.stringify(project, null, 2));
      assert(reloaded.ok, `the compacted project reopens: ${message(reloaded)}`);
      assert(reloaded.ok && pipelineApply(reloaded.value, { kind: "select-workspace", workspace: "part" }).ok, "and accepts the next operation");
      // The chain is deterministic: folding the same history twice gives the same digest, and a different history gives another.
      const again = compactWorkbenchAudit(project, 10);
      equal(again.audit.length, 11, "an on-request compaction keeps the last N entries in full");
      equal(again.revision, project.revision, "and leaves the revision alone");
      const twice = compactWorkbenchAudit(project, 10);
      equal(twice.audit[0]!.checkpoint?.digest, again.audit[0]!.checkpoint?.digest, "compaction is deterministic");
      assert(again.audit[0]!.checkpoint?.digest !== first.checkpoint?.digest, "a later fold chains onto the earlier digest and differs from it");
      assert(validateWorkbenchProject(again).ok, "a manually compacted project validates");
      // A forged checkpoint is refused.
      const forged = { ...project, audit: [{ ...first, checkpoint: { ...first.checkpoint!, digest: "xyz" } }, ...project.audit.slice(1)] };
      assert(!validateWorkbenchProject(forged).ok, "a checkpoint without a real digest is refused");
      const gap = { ...project, audit: [first, ...project.audit.slice(2)] };
      assert(!validateWorkbenchProject(gap).ok, "a gap in the revision sequence is refused");
      equal(AUDIT_KEEP_FULL < AUDIT_MAX_ENTRIES, true, "a compaction frees room");
    }
  },
  {
    name: "P01 a saved project over 1 MB reopens: the open limit matches the 50 MB the file workspace saves",
    run: () => {
      let project = fresh();
      project = pipelineRun(project, { kind: "add-general-body", body: heavyBody("general-body:big", 100) });
      const pretty = JSON.stringify(project, null, 2);
      assert(pretty.length > 1_000_000, `the fixture is over 1 MB (${pretty.length} bytes)`);
      const reopened = parseWorkbenchProjectText(pretty);
      assert(reopened.ok, `a file over 1 MB reopens: ${message(reopened)}`);
      assert(reopened.ok && reopened.value.part.generalBodies?.length === 1, "with its body");
      equal(WORKBENCH_LIMITS.maxJsonBytes, 50_000_000, "the open limit equals the save limit");
      const tooBig = parseWorkbenchProjectText(`{"pad":"${"x".repeat(50_000_100)}"}`);
      assert(!tooBig.ok && /50 MB/u.test(message(tooBig)), `a file past the limit says so: ${message(tooBig)}`);
    }
  },
  {
    name: "P01 saved text keeps number lists on one line, stays valid JSON and is far smaller than one number per line",
    run: () => {
      let project = fresh();
      project = pipelineRun(project, { kind: "add-general-body", body: heavyBody("general-body:big", 60) });
      const text = serializeWorkbenchProject(project);
      const pretty = JSON.stringify(project, null, 2);
      assert(text.length < pretty.length * 0.6, `the saved text is much smaller (${text.length} against ${pretty.length})`);
      equal(JSON.stringify(JSON.parse(text)), JSON.stringify(project), "and it parses back to exactly the same project");
      assert(text.endsWith("\n") && text.includes("\n  \"sketch\""), "while the structure stays indented for people");
      const reopened = parseWorkbenchProjectText(text);
      assert(reopened.ok, `it reopens: ${message(reopened)}`);
    }
  },
  {
    name: "P23 autosave coalesces a burst of edits into one trailing write, in order, and an awaiting caller resumes after its value is written",
    run: async () => {
      const written: number[] = [];
      let releaseFirst: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const writer = createLatestWinsWriter<number>(async (value) => { written.push(value); if (value === 1) await gate; }, 1);
      const first = writer.schedule(1);
      const burst = [2, 3, 4, 5].map((value) => writer.schedule(value));
      releaseFirst();
      await Promise.all([first, ...burst]);
      assert(written.join(",") === "1,5", `the first write and one trailing write of the newest value happened: ${written.join(",")}`);
      equal(writer.writes(), 2, "two writes for five edits");
      const failing = createLatestWinsWriter<number>(async (value) => { if (value === 9) throw new Error("disk full"); }, 1);
      let caught = "";
      await failing.schedule(9).catch((error: unknown) => { caught = String(error); });
      assert(caught.includes("disk full"), "a failed write reaches the caller that asked for it");
      await failing.schedule(10);
    }
  },
  {
    name: "P23 an operation on a project the reducer returned does not copy every mesh again",
    run: () => {
      let project = fresh();
      for (let index = 0; index < 4; index += 1) project = pipelineRun(project, { kind: "add-general-body", body: heavyBody(`general-body:b${index}`, 40) });
      const before = project.part.generalBodies!;
      const next = pipelineRun(project, { kind: "select-workspace", workspace: "part" });
      assert(next.part.generalBodies![0] === before[0] && next.part.generalBodies![3] === before[3], "the bodies are shared with the previous project, not deep-copied");
      equal(next.revision, project.revision + 1, "and the operation still applies");
      // A project that did not come from the reducer is still validated in full, so a damaged one is refused.
      const damaged = { ...project, sketch: { ...project.sketch, entities: [{ id: "entity:bad", kind: "circle", center: [0, 0], radiusMm: -1, construction: false }] } } as unknown as WorkbenchProject;
      assert(!pipelineApply(damaged, { kind: "select-workspace", workspace: "part" }).ok, "a damaged project is refused");
    }
  },
  {
    name: "P12 (audit part) a sketch edit with 120 jointed lines is recorded; a large changed-ID list is trimmed instead of refused",
    run: () => {
      const lines = Array.from({ length: 120 }, (_, index) => line(`seg-${index}`, [index * 5, index % 2 === 0 ? 0 : 1], [index * 5 + 5, index % 2 === 0 ? 1 : 0]));
      const joints = lines.slice(1).map((entity, index) => ({ id: `constraint:j-${index}`, kind: "coincident" as const, entityIds: [lines[index]!.id, entity.id], points: ["end" as const, "start" as const] }));
      const edited = pipelineApply(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: lines, addConstraints: joints, label: "Polyline" });
      assert(edited.ok, `120 lines with 119 joints are accepted: ${message(edited)}`);
      if (edited.ok) assert(edited.value.project.audit[0]!.changedIds.length <= 201, "the audit lists a bounded number of changed IDs");
      void near; void designOf;
    }
  }
];
