/**
 * Phase 3, Wave 3.1 — NR loop-top forceReorder gate + citation hygiene.
 *
 * Task 3.1.1: Verify the pre-factor NISHOULDREORDER gate (newton-raphson.ts:337-357)
 *   fires on MODEINITJCT and MODEINITTRAN iteration 0, does NOT fire on MODEINITFLOAT
 *   / MODEINITFIX, and that forceReorder() precedes factor() in call order.
 *
 * Task 3.1.2: Verify ngspice citations at non-top-of-loop forceReorder call sites
 *   (E_SINGULAR retry and DC-OP mode transition).
 */

import { describe, it, expect, vi } from "vitest";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson } from "../newton-raphson.js";
import { CKTCircuitContext } from "../ckt-context.js";
import { makeSimpleCtx } from "./test-helpers.js";
import { PropertyBag } from "../../../core/properties.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../../components/passives/resistor.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import {
  MODEDCOP, MODEINITFLOAT, MODEINITJCT, MODETRAN,
  MODEINITTRAN, MODEINITFIX, setInitf, setAnalysis,
} from "../ckt-mode.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Production-factory wrappers
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { kind: "inline"; factory: AnalogFactory }).factory;
  return factory(new Map([["A", nodeA], ["B", nodeB]]), props, () => 0);
}

function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

function makeDiode(anodeNode: number, cathodeNode: number, IS: number, N: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, IS, N });
  return createDiodeElement(new Map([["A", anodeNode], ["K", cathodeNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Build a CKTCircuitContext for the diode+resistor+voltage-source circuit.
 *
 * Topology:
 *   Node 0 = ground
 *   Node 1 = anode (Vs positive terminal)
 *   Node 2 = junction between resistor and diode cathode
 *   Branch row 2 = voltage source branch
 *
 * Circuit: Vs source → 1kΩ resistor → diode → ground
 *   matrixSize = 3 (2 nodes + 1 branch)
 */
function makeDiodeCtx(sourceVoltage: number): CKTCircuitContext {
  const vs = makeVoltageSource(1, 0, sourceVoltage);
  const r = makeResistor(1, 2, 1000);
  const d = makeDiode(2, 0, 1e-14, 1);
  const elements = [vs, r, d];

  const ctx = makeSimpleCtx({
    elements,
    nodeCount: 2,
    matrixSize: 3,
    branchCount: 1,
    startBranch: 2,
  });
  ctx.diagnostics = new DiagnosticCollector();
  return ctx;
}

describe("Task 3.1.1 — NR loop-top forceReorder gate", () => {
  it("fires forceReorder when cktMode has MODEINITJCT", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = setAnalysis(MODEDCOP, ctx.cktMode);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);

    // Spy on solver methods to track call order
    const forceReorderSpy = vi.spyOn(ctx.solver, "forceReorder");
    const preorderSpy = vi.spyOn(ctx.solver, "preorder");
    const factorSpy = vi.spyOn(ctx.solver, "factor");

    newtonRaphson(ctx);

    // Assert that forceReorder was called at least once during the NR loop
    expect(forceReorderSpy).toHaveBeenCalled();
    expect(forceReorderSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Verify call order: preorder → forceReorder → factor
    const preorderCall = preorderSpy.mock.invocationCallOrder[0];
    const forceReorderCall = forceReorderSpy.mock.invocationCallOrder[0];
    const factorCall = factorSpy.mock.invocationCallOrder[0];

    expect(preorderCall).toBeLessThan(forceReorderCall);
    expect(forceReorderCall).toBeLessThan(factorCall);
  });

  it("fires forceReorder only on iteration 0 when cktMode has MODEINITTRAN", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = setAnalysis(MODETRAN, ctx.cktMode);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITTRAN);

    // Track forceReorder calls per NR iteration by using a cktLoad interleave.
    // cktLoad is called exactly once per iteration; forceReorder calls between
    // consecutive cktLoad calls belong to the same iteration.
    //
    // Approach: use a postIterationHook to snapshot forceReorder call count at
    // the end of each iteration, then compare counts across iterations.
    const forceReorderSpy = vi.spyOn(ctx.solver, "forceReorder");

    // Record the spy call count at the END of each iteration (after STEP J / INITF dispatch).
    const callCountAfterIteration: number[] = [];
    ctx.postIterationHook = () => {
      callCountAfterIteration.push(forceReorderSpy.mock.calls.length);
    };

    newtonRaphson(ctx);

    // At least 2 iterations must have run (iteration 0 forces noncon=1, so >= 2 total).
    expect(callCountAfterIteration.length).toBeGreaterThanOrEqual(2);

    // The loop-top gate (niiter.c:856-859) fires ONLY on iteration 0 for MODEINITTRAN
    // because the mode transitions to MODEINITFLOAT at the end of iteration 0.
    // MODEINITTRAN→MODEINITFLOAT does NOT call forceReorder in the INITF dispatcher
    // (unlike MODEINITJCT→MODEINITFIX which does). So exactly 1 forceReorder total.
    //
    // forceReorder count after iteration 0 must be exactly 1 (the loop-top call).
    expect(callCountAfterIteration[0]).toBe(1);

    // forceReorder count must NOT increase in iteration 1 or later (gate already closed).
    for (let i = 1; i < callCountAfterIteration.length; i++) {
      expect(callCountAfterIteration[i]).toBe(callCountAfterIteration[0]);
    }
  });

  it("does not fire forceReorder on MODEINITFLOAT or MODEINITFIX", () => {
    // Test both MODEINITFLOAT and MODEINITFIX modes sequentially.
    // The spec requires distinguishing loop-top forceReorder calls from
    // E_SINGULAR retry (:396) or init-transition (:567) calls.
    // We use call-site discrimination via Error().stack to verify the
    // loop-top gate (newton-raphson.ts:337-357) did not fire.

    const testModes = [
      { mode: MODEINITFLOAT, name: "MODEINITFLOAT" },
      { mode: MODEINITFIX, name: "MODEINITFIX" },
    ];

    for (const { mode, name } of testModes) {
      const ctx = makeDiodeCtx(5.0);
      ctx.cktMode = setAnalysis(MODEDCOP, ctx.cktMode);
      ctx.cktMode = setInitf(ctx.cktMode, mode);

      // Capture forceReorder call stacks to discriminate by call-site.
      // The loop-top gate is at newton-raphson.ts:354-356.
      const forceReorderStacks: string[] = [];
      const originalForceReorder = ctx.solver.forceReorder.bind(ctx.solver);
      ctx.solver.forceReorder = function (...args: Parameters<typeof originalForceReorder>) {
        forceReorderStacks.push(new Error("forceReorder call-site capture").stack ?? "");
        return originalForceReorder(...args);
      };

      newtonRaphson(ctx);

      // The loop-top gate is at newton-raphson.ts:354-356 (inside the condition block).
      // Any forceReorder call from the loop-top gate would have a stack trace containing
      // one of those line numbers. We verify NO captured stack contains "354:" or "355:" or "356:"
      // which would indicate the call originated from the loop-top gate.
      const loopTopLineNumbers = ["354:", "355:", "356:"];
      const loopTopCallFound = forceReorderStacks.some((stack) =>
        loopTopLineNumbers.some((lineNum) => stack.includes(`newton-raphson.ts${lineNum}`))
      );

      expect(
        loopTopCallFound,
        `forceReorder should not be called from the loop-top gate on ${name}`
      ).toBe(false);
    }
  });

  it("precedes factor() in call order", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = setAnalysis(MODEDCOP, ctx.cktMode);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);

    const forceReorderSpy = vi.spyOn(ctx.solver, "forceReorder");
    const factorSpy = vi.spyOn(ctx.solver, "factor");

    newtonRaphson(ctx);

    // Assert both were called
    expect(forceReorderSpy).toHaveBeenCalled();
    expect(factorSpy).toHaveBeenCalled();

    // Assert forceReorder was called before factor in the first iteration
    const firstForceReorderCall = forceReorderSpy.mock.invocationCallOrder[0];
    const firstFactorCall = factorSpy.mock.invocationCallOrder[0];

    expect(firstForceReorderCall).toBeLessThan(firstFactorCall);
  });

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
});

describe("Task 3.1.2 — non-top-of-loop forceReorder citations", () => {
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
        if (contextText.includes("lastFactorUsedReorder") || contextText.includes("!factorResult")) {
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
