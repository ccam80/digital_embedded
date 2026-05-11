/**
 * Phase 3, Wave 3.1- NR loop-top forceReorder gate + citation hygiene.
 *
 * Task 3.1.1: ALL TESTS DELETED.
 *   Reason: every test constructed a CKTCircuitContext via the deleted
 *   makeSimpleCtx helper (test-helpers.ts) and spied on ctx.solver.forceReorder
 *   directly. This is engine-impersonation; direct context construction is not
 *   a sanctioned access pattern.
 *   There is no path to observe forceReorder call order or per-iteration INITF
 *   mode transitions through buildFixture or ComparisonSession public surfaces.
 *   See per-test deletion entries below.
 *
 * Task 3.1.2: Citation-hygiene tests RETAINED.
 *   These tests read newton-raphson.ts and dc-operating-point.ts source text
 *   to assert citation presence/absence. No engine construction required.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Task 3.1.1 deletions
// ---------------------------------------------------------------------------

// Deleted: "fires forceReorder when cktMode has MODEINITJCT".
// Coverage: buckbjt-convergence.test.ts exercises the full NR loop including
//   the MODEINITJCT→MODEINITFIX reorder path via observable DCOP convergence.
// Reason: Required makeSimpleCtx (deleted) + vi.spyOn(ctx.solver) — engine-
//   impersonation with no public-surface equivalent per §3 POISON.

// Deleted: "fires forceReorder only on iteration 0 when cktMode has MODEINITTRAN".
// Coverage: buckbjt-convergence.test.ts covers MODEINITTRAN loop entry; harness
//   comparison-session tests cover transient NR attempt counts via getStepShape.
// Reason: Required makeSimpleCtx + ctx.postIterationHook direct write +
//   vi.spyOn(ctx.solver) — engine-impersonation per §3 POISON.

// Deleted: "does not fire forceReorder on MODEINITFLOAT or MODEINITFIX".
// Coverage: buckbjt-convergence.test.ts and ngspice-parity tests exercise these
//   modes via observable DCOP/transient convergence outcomes.
// Reason: Required makeSimpleCtx + direct ctx.solver.forceReorder monkey-patch +
//   call-stack inspection — engine-impersonation per §3 POISON.

// Deleted: "precedes factor() in call order".
// Coverage: buckbjt-convergence.test.ts covers forceReorder→factor ordering
//   indirectly through successful DCOP convergence (factor must succeed for
//   DCOP to converge, and forceReorder must precede it per the gate).
// Reason: Required makeSimpleCtx + vi.spyOn(ctx.solver) invocationCallOrder —
//   engine-impersonation per §3 POISON.

// ---------------------------------------------------------------------------
// Task 3.1.2- non-top-of-loop forceReorder citations
// ---------------------------------------------------------------------------

describe("Task 3.1.2- non-top-of-loop forceReorder citations", () => {
  it("cites niiter.c:856-859 in the loop-top gate comment", () => {
    // Read the newton-raphson.ts file and verify the citation is present
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const content = fs.readFileSync(nrPath, "utf-8");

    // Find the forceReorder call within the loop-top gate (around lines 354-357)
    const lines = content.split("\n");
    let foundCitation = false;

    // Search for the comment block before solver.forceReorder() call
    // The citation should appear within 30 lines before the first forceReorder() call in the NR loop
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("solver.forceReorder()")) {
        // This is a forceReorder call; check the preceding 30 lines for the citation
        const searchStart = Math.max(0, i - 30);
        const searchText = lines.slice(searchStart, i).join("\n");
        if (searchText.includes("niiter.c:856-859")) {
          foundCitation = true;
          break;
        }
      }
    }

    expect(foundCitation).toBe(true);
  });

  it("cites niiter.c:888-891 at the E_SINGULAR retry", () => {
    // Read the newton-raphson.ts file and verify the E_SINGULAR retry citation
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const content = fs.readFileSync(nrPath, "utf-8");
    const lines = content.split("\n");

    let foundCitation = false;

    // Find the forceReorder call within the E_SINGULAR retry block
    // It should be preceded by a check for !factorResult.success or !solver.lastFactorUsedReorder
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("solver.forceReorder()") && i > 0) {
        // Check if this is in the E_SINGULAR retry block by looking for preceding context
        const contextStart = Math.max(0, i - 10);
        const contextText = lines.slice(contextStart, i).join("\n");
        if (contextText.includes("lastFactorWalkedReorder") || contextText.includes("!factorResult")) {
          // This is the E_SINGULAR retry block; check for the citation
          const citationStart = Math.max(0, i - 10);
          const citationText = lines.slice(citationStart, i).join("\n");
          if (citationText.includes("niiter.c:888-891")) {
            foundCitation = true;
            break;
          }
        }
      }
    }

    expect(foundCitation).toBe(true);
  });

  it("rejects a stale niiter.c:474-499 citation anywhere in NR path", () => {
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const dcOpPath = path.join(
      path.dirname(__dirname),
      "dc-operating-point.ts"
    );

    const nrContent = fs.readFileSync(nrPath, "utf-8");
    const dcOpContent = fs.readFileSync(dcOpPath, "utf-8");

    // Assert that neither file contains the stale citation
    expect(nrContent).not.toContain("niiter.c:474-499");
    expect(dcOpContent).not.toContain("niiter.c:474-499");
  });
});
