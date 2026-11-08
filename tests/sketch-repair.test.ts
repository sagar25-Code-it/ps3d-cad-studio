import type { SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { analyzeSketch, repairAll, validateSketch, type RepairFix, type RepairIssue } from "../packages/workbench-sketch/src/sketch-repair.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { arc, circle, commit, constraint, context, line, projectWith } from "./sketch-edit-kit.js";

let serial = 0;

/** Presses a repair button the way the UI does: a relax goes through set-sketch-constraints-suppressed, an edit through apply-sketch-edit. */
function applyFix(project: WorkbenchProject, fix: RepairFix) {
  if (fix.kind === "edit") return commit(project, fix.plan);
  serial += 1;
  return applyWorkbenchOperation(project, { kind: "set-sketch-constraints-suppressed", constraintIds: fix.constraintIds, suppressed: true, operationId: `operation:repair-test-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function fixOk(project: WorkbenchProject, fix: RepairFix): WorkbenchProject {
  const applied = applyFix(project, fix);
  if (!applied.ok) throw new Error(`fix "${fix.label}" refused: ${applied.diagnostics[0]?.message}`);
  return applied.value.project;
}

const report = (project: WorkbenchProject) => analyzeSketch(context(project));
const issuesOf = (project: WorkbenchProject, category: RepairIssue["category"]): readonly RepairIssue[] => report(project).issues.filter((issue) => issue.category === category);

/** A closed 10 x 10 square with its joints and orientations. */
function squareParts(): { readonly entities: SketchEntity[]; readonly constraints: ReturnType<typeof constraint>[] } {
  return {
    entities: [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0])],
    constraints: [
      constraint("c01", "coincident", ["s0", "s1"], { points: ["end", "start"] }), constraint("c12", "coincident", ["s1", "s2"], { points: ["end", "start"] }),
      constraint("c23", "coincident", ["s2", "s3"], { points: ["end", "start"] }), constraint("c30", "coincident", ["s3", "s0"], { points: ["end", "start"] }),
      constraint("h0", "horizontal", ["s0"]), constraint("v1", "vertical", ["s1"]), constraint("h2", "horizontal", ["s2"]), constraint("v3", "vertical", ["s3"])
    ]
  };
}

export const sketchRepairTests: readonly TestCase[] = [
  {
    name: "a clean square validates with no issues, one profile and a solid-ready verdict",
    run: () => {
      const parts = squareParts();
      const clean = report(projectWith(parts.entities, parts.constraints));
      equal(clean.errors, 0, "no errors");
      equal(clean.warnings, 0, "no warnings");
      equal(clean.closedProfiles, 1, "one closed profile");
      equal(clean.usableForSolid, true, "ready for a solid feature");
      assert(clean.summary.some((text) => text.includes("1 closed profile")), "the report says so");
      assert(validateSketch(context(projectWith(parts.entities, parts.constraints))).valid, "validateSketch agrees");
      const empty = report(projectWith([]));
      equal(empty.usableForSolid, false, "an empty sketch has nothing for a solid feature");
    }
  },
  {
    name: "redundant relations are found (implied parallel, repeated relation, equal radii dimensioned twice) and each can be deleted through the operation",
    run: () => {
      const implied = projectWith(
        [line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])],
        [constraint("ha", "horizontal", ["a"]), constraint("hb", "horizontal", ["b"]), constraint("par", "parallel", ["a", "b"])]
      );
      const found = issuesOf(implied, "redundant");
      equal(found.length, 1, "one redundant relation");
      assert(found[0]!.constraintIds.includes("constraint:par"), "it is the parallel, which both horizontals already imply");
      equal(found[0]!.severity, "warning", "an over-defined sketch is a warning");
      const cleaned = fixOk(implied, found[0]!.fixes[0]!);
      assert(!cleaned.sketch.constraints.some((c) => c.id === "constraint:par"), "the parallel is gone");
      equal(report(cleaned).issues.filter((issue) => issue.category === "redundant").length, 0, "and nothing redundant is left");

      const repeated = projectWith([line("a", [0, 0], [10, 0])], [constraint("h1", "horizontal", ["a"]), constraint("h2", "horizontal", ["a"])]);
      const repeat = issuesOf(repeated, "redundant");
      equal(repeat.length, 1, "the second horizontal is a repeat");
      equal(fixOk(repeated, repeat[0]!.fixes[0]!).sketch.constraints.length, 1, "one is kept");

      const dimensioned = projectWith(
        [circle("p", [0, 0], 5), circle("q", [20, 0], 5)],
        [constraint("eq", "equal", ["p", "q"]), constraint("rp", "radius", ["p"], { valueMm: 5, dimension: "radius" }), constraint("rq", "radius", ["q"], { valueMm: 5, dimension: "radius" })]
      );
      const over = issuesOf(dimensioned, "redundant");
      equal(over.length, 1, "dimensioning both circles of an equal pair over-defines it");
      assert(over[0]!.constraintIds.includes("constraint:rq"), "the second dimension is the redundant one");
    }
  },
  {
    name: "contradictions are errors with relax fixes: horizontal and vertical, parallel and perpendicular, two radii on an equal pair",
    run: () => {
      const both = projectWith([line("a", [0, 0], [10, 0])], [constraint("h", "horizontal", ["a"]), constraint("v", "vertical", ["a"])]);
      const conflicts = issuesOf(both, "conflict");
      assert(conflicts.length >= 1, "horizontal plus vertical conflicts");
      equal(conflicts[0]!.severity, "error", "an error");
      assert(conflicts[0]!.fixes.length >= 2, "offers to relax either one");
      const labels = conflicts[0]!.fixes.map((fix) => fix.label).join(" | ");
      assert(labels.includes("Relax"), `fixes are relaxations (${labels})`);
      const relaxed = fixOk(both, conflicts[0]!.fixes[0]!);
      assert(relaxed.sketch.constraints.some((c) => c.suppressed === true), "a relation is now relaxed, not deleted");
      equal(relaxed.sketch.constraints.length, 2, "both relations are still recorded");
      equal(issuesOf(relaxed, "conflict").length, 0, "and the conflict is gone");

      const pair = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])], [constraint("par", "parallel", ["a", "b"]), constraint("perp", "perpendicular", ["a", "b"])]);
      assert(issuesOf(pair, "conflict").length >= 1, "parallel plus perpendicular on one pair conflicts");

      const radii = projectWith(
        [circle("p", [0, 0], 5), circle("q", [20, 0], 7)],
        [constraint("eq", "equal", ["p", "q"]), constraint("rp", "radius", ["p"], { valueMm: 5, dimension: "radius" }), constraint("rq", "radius", ["q"], { valueMm: 7, dimension: "radius" })]
      );
      const radiusConflicts = issuesOf(radii, "conflict");
      assert(radiusConflicts.length >= 1, "two different radii on an equal pair conflict");
      assert(report(radii).valid === false, "so the sketch is not valid");
    }
  },
  {
    name: "geometry that does not satisfy its relations is flagged, and Apply the solve fixes it through the operation",
    run: () => {
      const crooked = projectWith([line("a", [0, 0], [10, 1.5])], [constraint("h", "horizontal", ["a"])]);
      const found = issuesOf(crooked, "unsolved-geometry");
      equal(found.length, 1, "the crooked line is flagged");
      const fixed = fixOk(crooked, found[0]!.fixes[0]!);
      const solved = fixed.sketch.entities[0]! as Extract<SketchEntity, { kind: "line" }>;
      near(solved.end[1] - solved.start[1], 0, 1e-9, "the line is now horizontal");
      equal(issuesOf(fixed, "unsolved-geometry").length, 0, "and nothing is left to apply");
    }
  },
  {
    name: "a gap between ends that almost meet is reported with the distance, and joining it closes the profile",
    run: () => {
      const entities = [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10.9], [0, 0])];
      const project = projectWith(entities);
      equal(detectSketchProfiles(project.sketch).length, 0, "the 0.9 mm gap leaves the square open");
      const gaps = issuesOf(project, "gap");
      equal(gaps.length, 1, "one gap");
      assert(gaps[0]!.title.includes("0.9"), `the gap size is in the title (${gaps[0]!.title})`);
      assert(gaps[0]!.fixes.length >= 1, "at least one way to close it");
      const closed = fixOk(project, gaps[0]!.fixes[0]!);
      equal(detectSketchProfiles(closed.sketch).length, 1, "the square is now a closed profile");
      equal(issuesOf(closed, "gap").length, 0, "no gap remains");
      assert(closed.sketch.constraints.some((c) => c.kind === "coincident"), "the joint is recorded as a coincident relation");
      // Each offered way works, not just the first.
      for (const fix of gaps[0]!.fixes) assert(applyFix(project, fix).ok, `"${fix.label}" is accepted by the operation`);
    }
  },
  {
    name: "when relations pin both ends, the gap says so instead of offering a fix that would be refused",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("b", [10.5, 0], [20, 0])],
        [constraint("fa", "fixed", ["a"]), constraint("fb", "fixed", ["b"])]
      );
      const gaps = issuesOf(project, "gap");
      equal(gaps.length, 1, "the gap is still reported");
      equal(gaps[0]!.fixes.length, 0, "but no fix is offered");
      assert((gaps[0]!.noFixReason ?? "").length > 10, `with a reason (${gaps[0]!.noFixReason})`);
    }
  },
  {
    name: "duplicate curves are found and the one with fewer relations is deleted; zero-length and tiny curves are deleted",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("a2", [10, 0], [0, 0]), circle("c", [30, 0], 4), circle("c2", [30, 0], 4), line("tiny", [60, 60], [60.05, 60])],
        [constraint("ha", "horizontal", ["a"]), constraint("fix", "fixed", ["c2"])]
      );
      const found = report(project);
      const dupes = found.issues.filter((issue) => issue.category === "duplicate");
      equal(dupes.length, 2, "a line (drawn backwards) and a circle are repeated");
      const lineFix = dupes.find((issue) => issue.entityIds.includes("entity:a2"))!;
      assert(lineFix.id === "duplicate:entity:a2", "the line without relations is the one to drop");
      const circleFix = dupes.find((issue) => issue.entityIds.includes("entity:c"))!;
      assert(circleFix.id === "duplicate:entity:c", "and for the circles the one without the fixed pin");
      const tiny = found.issues.find((issue) => issue.id === "degenerate:entity:tiny")!;
      equal(tiny.severity, "warning", "a 0.05 mm line is a warning");
      let next = project;
      for (const issue of [lineFix, circleFix, tiny]) next = fixOk(next, issue.fixes[0]!);
      equal(next.sketch.entities.length, 2, "only one line and one circle remain");
      // A zero-length line cannot exist in a valid project (the operations refuse it), but an imported or damaged sketch can hold one: it is an error with a delete fix.
      const damaged = report(projectWith([line("zero", [50, 50], [50, 50]), line("fine", [0, 0], [10, 0])]));
      const zero = damaged.issues.find((issue) => issue.id === "degenerate:entity:zero")!;
      equal(zero.severity, "error", "a zero-length line is an error");
      equal(zero.fixes.length, 1, "with a delete fix");
      equal(damaged.valid, false, "and the sketch is not valid");
      equal(report(next).issues.filter((issue) => issue.category === "duplicate" || issue.category === "degenerate").length, 0, "no duplicates or degenerate curves left");
    }
  },
  {
    name: "an open chain whose two ends are far apart is closed with a line, which makes a real profile",
    run: () => {
      const parts = squareParts();
      const open = projectWith(parts.entities.slice(0, 3), parts.constraints.filter((c) => !c.entityIds.some((id) => id === "entity:s3")));
      equal(detectSketchProfiles(open.sketch).length, 0, "three sides do not enclose anything");
      const chains = issuesOf(open, "open-chain");
      equal(chains.length, 1, "reported once");
      equal(chains[0]!.fixes.length, 1, "with one fix");
      const closed = fixOk(open, chains[0]!.fixes[0]!);
      const profiles = detectSketchProfiles(closed.sketch);
      equal(profiles.length, 1, "closing line makes a profile");
      near(profiles[0]!.areaMm2, 100, 1e-6, "of the full square");
      equal(issuesOf(closed, "open-chain").length, 0, "the chain is no longer open");

      const arcOnly = projectWith([arc("q", [0, 0], [5, 5], [10, 0])]);
      const shape = issuesOf(arcOnly, "open-chain");
      equal(shape.length, 1, "a lone arc is an open chain too");
      const filled = fixOk(arcOnly, shape[0]!.fixes[0]!);
      equal(detectSketchProfiles(filled.sketch).length, 1, "a chord closes it into a segment profile");
    }
  },
  {
    name: "a branching open chain is reported without a fix, and a lone line is left alone",
    run: () => {
      const fork = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 5]), line("c", [10, 0], [20, -5])]);
      const chains = issuesOf(fork, "open-chain");
      equal(chains.length, 1, "the fork is flagged");
      equal(chains[0]!.fixes.length, 0, "with no automatic fix");
      assert((chains[0]!.noFixReason ?? "").length > 0, "and a reason");
      equal(issuesOf(projectWith([line("alone", [0, 0], [10, 0])]), "open-chain").length, 0, "a single line is not an unclosed profile");
    }
  },
  {
    name: "Fix all repairs a messy sketch end to end: the result is valid, closed and clean",
    run: () => {
      const parts = squareParts();
      // Break the square in several ways at once: a gap, a repeated relation, a redundant parallel, a stray zero-length line, a duplicate, a crooked line.
      const messy = projectWith(
        [
          line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10.8], [0, 0]),
          line("dup", [10, 10], [0, 10]), line("stray", [40, 40], [40, 40]), line("crooked", [30, 0], [40, 2])
        ],
        [
          ...parts.constraints.filter((c) => !["constraint:c23", "constraint:c30", "constraint:v3"].includes(c.id)),
          constraint("h2b", "horizontal", ["s2"]), constraint("par02", "parallel", ["s0", "s2"]), constraint("hc", "horizontal", ["crooked"])
        ]
      );
      const before = report(messy);
      assert(before.issues.filter((i) => i.severity !== "info").length >= 5, `several problems to start (${before.issues.length})`);
      const fixed = repairAll(context(messy));
      assert(fixed.applied.length >= 5, `fix all took several steps (${fixed.applied.join("; ")})`);
      equal(fixed.remaining.errors, 0, "no errors remain");
      equal(fixed.remaining.warnings, 0, `no warnings remain (${fixed.remaining.issues.filter((i) => i.severity === "warning").map((i) => i.title).join("; ")})`);
      assert(fixed.remaining.closedProfiles >= 1, "the square is a closed profile");
      const square = detectSketchProfiles(fixed.sketch).find((profile) => Math.abs(profile.areaMm2 - 100) < 1e-6);
      assert(square !== undefined, "with the full square's area");
    }
  },
  {
    name: "every fix any issue offers is accepted by the real operation, one at a time, from the same messy sketch",
    run: () => {
      const messy = projectWith(
        [
          line("a", [0, 0], [10, 0]), line("b", [10.7, 0], [10.7, 10]), line("a2", [10, 0], [0, 0]), line("c", [0, 20], [10, 21]), line("d", [0, 30], [10, 30]), line("e", [0, 35], [10, 35]), circle("p", [30, 0], 5), circle("q", [50, 0], 5)
        ],
        [
          constraint("hc", "horizontal", ["c"]), constraint("hd", "horizontal", ["d"]), constraint("he", "horizontal", ["e"]), constraint("de", "parallel", ["d", "e"]),
          constraint("eq", "equal", ["p", "q"]), constraint("rp", "radius", ["p"], { valueMm: 5, dimension: "radius" }), constraint("rq", "radius", ["q"], { valueMm: 5, dimension: "radius" }),
          constraint("v", "vertical", ["d"])
        ]
      );
      const found = report(messy);
      let tried = 0;
      for (const issue of found.issues) {
        for (const fix of issue.fixes) {
          tried += 1;
          const applied = applyFix(messy, fix);
          assert(applied.ok, `"${fix.label}" (${issue.category}) is accepted: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
        }
      }
      assert(tried >= 8, `a good number of fixes were exercised (${tried})`);
      assert(found.fixable >= 5, `most issues are fixable (${found.fixable} of ${found.issues.length})`);
    }
  }
];
