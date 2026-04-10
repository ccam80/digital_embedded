/**
 * harness-mcp-verification.test.ts -- End-to-end MCP tool verification tests.
 *
 * Creates a REAL ComparisonSession on the HWR square-wave circuit, runs transient,
 * then exercises every harness MCP tool through a ToolCapture mock server
 * that mirrors the McpServer.registerTool() contract.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { existsSync } from "fs";
import { ComparisonSession } from "../../../src/solver/analog/__tests__/harness/comparison-session.js";
import { HarnessSessionState } from "../harness-session-state.js";
import { registerHarnessTools } from "../harness-tools.js";

// ---------------------------------------------------------------------------
// ToolCapture -- lightweight mock that captures registerTool registrations
// ---------------------------------------------------------------------------

type ToolHandler = (args: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

class ToolCapture {
  private _handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _meta: any, handler: ToolHandler): void {
    this._handlers.set(name, handler);
  }

  async call(name: string, args: Record<string, any>): Promise<any> {
    const handler = this._handlers.get(name);
    if (!handler) throw new Error(`Tool ${name} not registered`);
    const response = await handler(args);
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  }
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const DLL_PATH =
  process.env.NGSPICE_DLL_PATH ??
  resolve(
    process.cwd(),
    "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll",
  );
const HAS_DLL = DLL_PATH !== "" && existsSync(DLL_PATH);
const describeGate = HAS_DLL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertFormattedNumber(fn: any, label: string): void {
  expect(fn, `${label} must exist`).toBeDefined();
  expect(typeof fn.display, `${label}.display must be string`).toBe("string");
  if (fn.raw !== null) {
    expect(typeof fn.raw, `${label}.raw must be number`).toBe("number");
    expect(Number.isNaN(fn.raw), `${label}.raw must not be NaN`).toBe(false);
  }
}

function assertComparedValueJSON(cv: any, label: string): void {
  assertFormattedNumber(cv.ours, `${label}.ours`);
  assertFormattedNumber(cv.ngspice, `${label}.ngspice`);
  assertFormattedNumber(cv.delta, `${label}.delta`);
  assertFormattedNumber(cv.absDelta, `${label}.absDelta`);
  expect(typeof cv.withinTol, `${label}.withinTol`).toBe("boolean");
}

function assertPagination(result: any): void {
  expect(typeof result.total).toBe("number");
  expect(typeof result.offset).toBe("number");
  expect(typeof result.limit).toBe("number");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeGate("Harness MCP Verification -- HWR square-wave transient", () => {
  let session: ComparisonSession;
  let handle: string;
  let tools: ToolCapture;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: "fixtures/hwr-square.dts",
      dllPath: DLL_PATH,
    });
    await session.runTransient(0, 10e-6, 100e-9);

    const harnessState = new HarnessSessionState();
    handle = harnessState.store({
      session,
      dtsPath: "fixtures/hwr-square.dts",
      createdAt: new Date(),
      lastRunAt: new Date(),
      analysis: "tran",
    });

    tools = new ToolCapture();
    registerHarnessTools(tools as any, harnessState);
  }, 60_000);

  // MCP-1: summary mode
  it("MCP-1: summary mode returns analysis and convergence totals", async () => {
    const result = await tools.call("harness_query", {
      handle,
      type: "summary",
    });
    expect(result.queryMode).toBe("summary");
    assertPagination(result);
    expect(result.summary).toBeDefined();
    expect(result.summary.analysis).toBe("tran");
    assertComparedValueJSON(result.summary.stepCount, "summary.stepCount");
    expect(result.summary.convergence.ours.totalSteps).toBeGreaterThan(0);
    expect(result.summary.convergence.ngspice.totalSteps).toBeGreaterThan(0);
  });

  // MCP-2: component + step (step-end)
  it("MCP-2: component + step returns step-end with slots", async () => {
    const result = await tools.call("harness_query", {
      handle,
      component: "D1",
      step: 0,
    });
    expect(result.queryMode).toBe("component-step-end");
    assertPagination(result);
    expect(result.stepEnd.label).toBe("D1");
    expect(result.stepEnd.deviceType).toBe("diode");
    const slotKeys = Object.keys(result.stepEnd.slots);
    expect(slotKeys.length).toBeGreaterThan(0);
    for (const key of slotKeys) {
      assertComparedValueJSON(result.stepEnd.slots[key], `slot ${key}`);
    }
  });

  // MCP-3: component + step + iterations (prevNodes must NOT be empty)
  it("MCP-3: step-iterations has non-empty prevNodes", async () => {
    const result = await tools.call("harness_query", {
      handle,
      component: "D1",
      step: 1,
      iterations: true,
    });
    expect(result.queryMode).toBe("step-iterations");
    expect(result.iterationData.length).toBeGreaterThan(0);

    for (const iter of result.iterationData) {
      const nodeKeys = Object.keys(iter.nodes);
      expect(nodeKeys.length, "nodes must be non-empty").toBeGreaterThan(0);
      for (const nk of nodeKeys) {
        assertComparedValueJSON(iter.nodes[nk], `iter.nodes.${nk}`);
      }

      const prevNodeKeys = Object.keys(iter.prevNodes);
      expect(
        prevNodeKeys.length,
        "prevNodes must NOT be empty",
      ).toBeGreaterThan(0);
      for (const pk of prevNodeKeys) {
        assertFormattedNumber(iter.prevNodes[pk], `iter.prevNodes.${pk}`);
      }

      assertComparedValueJSON(iter.noncon, "iter.noncon");

      const compKeys = Object.keys(iter.components);
      expect(compKeys.length, "components must be non-empty").toBeGreaterThan(
        0,
      );
      for (const ck of compKeys) {
        const slotKeys = Object.keys(iter.components[ck]);
        expect(slotKeys.length).toBeGreaterThan(0);
        for (const sk of slotKeys) {
          assertComparedValueJSON(
            iter.components[ck][sk],
            `iter.components.${ck}.${sk}`,
          );
        }
      }
    }
  });

  // MCP-4: step + integrationCoefficients
  it("MCP-4: integration coefficients have correct structure", async () => {
    // Spec §9.5: scan tranFloat steps only. Step 0 (analysisPhase="tranInit") uses
    // backward-Euler (ag1=0) and would match ic.ag0 !== 0 spuriously. We require
    // analysisPhase === "tranFloat" to guarantee trapezoidal coefficients on both sides.
    const ourSession = session.ourSession!;
    let targetStep = -1;
    for (let si = 0; si < ourSession.steps.length; si++) {
      const step = ourSession.steps[si];
      const ic = step.integrationCoefficients;
      if (step.analysisPhase === "tranFloat" && ic.ours.ag0 !== 0 && ic.ngspice.ag0 !== 0) {
        targetStep = si;
        break;
      }
    }
    expect(targetStep, "must find a transient step with non-zero coefficients on both sides").toBeGreaterThanOrEqual(0);

    const result = await tools.call("harness_query", {
      handle,
      step: targetStep,
      integrationCoefficients: true,
    });
    expect(result.queryMode).toBe("integration-coefficients");
    const ic = result.integrationCoefficients;
    assertFormattedNumber(ic.ours.ag0, "ours.ag0");
    expect(ic.ours.ag0.raw, "ours.ag0 must not be zero for transient").not.toBe(0);
    assertFormattedNumber(ic.ours.ag1, "ours.ag1");
    expect(ic.ours.ag1.raw, "ours.ag1 must not be zero for transient").not.toBe(0);
    assertFormattedNumber(ic.ngspice.ag0, "ngspice.ag0");
    expect(ic.ngspice.ag0.raw, "ngspice.ag0 must not be zero").not.toBe(0);
    assertFormattedNumber(ic.ngspice.ag1, "ngspice.ag1");
    expect(typeof ic.ours.method).toBe("string");
    expect(ic.ours.method.length).toBeGreaterThan(0);
    expect(typeof ic.ngspice.method).toBe("string");
    assertComparedValueJSON(ic.ag0Compared, "ag0Compared");
    assertComparedValueJSON(ic.ag1Compared, "ag1Compared");
    expect(typeof ic.methodMatch).toBe("boolean");
  });

  // MCP-5: step + convergence-detail (uses buckbjt which has convergence failures)
  it("MCP-5: convergence detail has per-element flags", async () => {
    const bjtSession = await ComparisonSession.create({
      dtsPath: "fixtures/buckbjt.dts",
      dllPath: DLL_PATH,
    });
    await bjtSession.runTransient(0, 10e-6, 100e-9);

    const bjtState = new HarnessSessionState();
    const bjtHandle = bjtState.store({
      session: bjtSession,
      dtsPath: "fixtures/buckbjt.dts",
      createdAt: new Date(),
      lastRunAt: new Date(),
      analysis: "tran",
    });
    const bjtTools = new ToolCapture();
    registerHarnessTools(bjtTools as any, bjtState);

    // Find the FIRST step/iteration with non-empty convergenceFailedElements
    // (requires iteration > 0, since NR can't check convergence at iteration 0)
    const bjtOurSession = bjtSession.ourSession!;
    let targetStep = -1;
    let targetIter = -1;
    outer: for (let si = 0; si < bjtOurSession.steps.length; si++) {
      const step = bjtOurSession.steps[si];
      for (let ii = 1; ii < step.iterations.length; ii++) {
        if (step.iterations[ii].convergenceFailedElements?.length > 0) {
          targetStep = si;
          targetIter = ii;
          break outer;
        }
      }
    }
    expect(
      targetStep,
      "no step with a non-converged element found — buckbjt should diverge by step ~2",
    ).toBeGreaterThanOrEqual(0);

    const result = await bjtTools.call("harness_query", {
      handle: bjtHandle,
      step: targetStep,
      iteration: targetIter,
      convergence: true,
    });
    expect(result.queryMode).toBe("per-element-convergence");
    expect(result.convergenceData.length).toBeGreaterThan(0);

    for (const elem of result.convergenceData) {
      expect(typeof elem.label).toBe("string");
      expect(typeof elem.deviceType).toBe("string");
      expect(typeof elem.converged).toBe("boolean");
      expect(typeof elem.noncon).toBe("number");
    }

    // buckbjt has convergence issues — at least one element should NOT be converged
    expect(result.convergenceData.some((e: any) => !e.ourConverged)).toBe(true);

    bjtSession.dispose();
  }, 60_000);

  // MCP-6: divergences filter=worst, sorted descending
  it("MCP-6: worst divergences sorted descending by absDelta", async () => {
    const result = await tools.call("harness_query", {
      handle,
      filter: "worst",
      worstN: 20,
    });
    expect(result.queryMode).toBe("divergences");
    expect(result.divergences.length).toBeLessThanOrEqual(20);
    expect(result.divergences.length).toBeGreaterThan(0);

    for (const entry of result.divergences) {
      assertFormattedNumber(entry.ours, "divergence.ours");
      assertFormattedNumber(entry.ngspice, "divergence.ngspice");
      assertFormattedNumber(entry.absDelta, "divergence.absDelta");
    }

    for (let i = 1; i < result.divergences.length; i++) {
      const prev = result.divergences[i - 1].absDelta.raw;
      const curr = result.divergences[i].absDelta.raw;
      if (prev !== null && curr !== null) {
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
  });

  // MCP-7: divergences filter=divergences
  it("MCP-7: divergences filter returns entries with non-zero absDelta", async () => {
    const result = await tools.call("harness_query", {
      handle,
      filter: "divergences",
    });
    expect(result.queryMode).toBe("divergences");
    for (const entry of result.divergences) {
      assertFormattedNumber(entry.absDelta, "divergence.absDelta");
      expect(entry.absDelta.raw).toBeGreaterThan(0);
    }
  });

  // MCP-8: component trace
  it("MCP-8: component trace returns steps with iterations", async () => {
    const result = await tools.call("harness_query", {
      handle,
      component: "D1",
    });
    expect(result.queryMode).toBe("component-trace");
    expect(result.componentTrace.label).toBe("D1");
    expect(result.componentTrace.deviceType).toBe("diode");
    expect(result.componentTrace.steps.length).toBeGreaterThan(0);

    for (const step of result.componentTrace.steps) {
      expect(step.iterations.length).toBeGreaterThan(0);
      for (const iter of step.iterations) {
        expect(iter.states).toBeDefined();
        for (const sk of Object.keys(iter.states)) {
          assertComparedValueJSON(iter.states[sk], `trace.states.${sk}`);
        }
        expect(iter.pinVoltages).toBeDefined();
        for (const pk of Object.keys(iter.pinVoltages)) {
          assertComparedValueJSON(
            iter.pinVoltages[pk],
            `trace.pinVoltages.${pk}`,
          );
        }
      }
    }
  });

  // MCP-9: node trace
  it("MCP-9: node trace returns steps with voltage comparisons", async () => {
    const topology = (session as any)._ourTopology;
    let nodeLabel: string | undefined;
    topology.nodeLabels.forEach((label: string, nodeId: number) => {
      if (nodeId > 0 && !nodeLabel) nodeLabel = label;
    });
    expect(nodeLabel).toBeDefined();

    const result = await tools.call("harness_query", {
      handle,
      node: nodeLabel,
    });
    expect(result.queryMode).toBe("node-trace");
    expect(result.nodeTrace.steps.length).toBeGreaterThan(0);
    for (const step of result.nodeTrace.steps) {
      expect(step.iterations.length).toBeGreaterThan(0);
      for (const iter of step.iterations) {
        assertComparedValueJSON(iter.voltage, "nodeTrace.voltage");
      }
    }
  });

  // MCP-10: step-end (step only)
  it("MCP-10: step-end returns stepStartTime, stepEndTime, dt, iterationCount, nodes, components", async () => {
    const result = await tools.call("harness_query", { handle, step: 0 });
    expect(result.queryMode).toBe("step-end");
    assertComparedValueJSON(result.stepEnd.stepStartTime, "stepEnd.stepStartTime");
    assertComparedValueJSON(result.stepEnd.stepEndTime, "stepEnd.stepEndTime");
    assertComparedValueJSON(result.stepEnd.dt, "stepEnd.dt");
    assertComparedValueJSON(
      result.stepEnd.iterationCount,
      "stepEnd.iterationCount",
    );

    const nodeKeys = Object.keys(result.stepEnd.nodes);
    expect(nodeKeys.length).toBeGreaterThan(0);
    for (const nk of nodeKeys) {
      assertComparedValueJSON(
        result.stepEnd.nodes[nk],
        `stepEnd.nodes.${nk}`,
      );
    }

    const compKeys = Object.keys(result.stepEnd.components);
    expect(compKeys.length).toBeGreaterThan(0);
  });

  // MCP-11: device-type filter
  it("MCP-11: deviceType filter returns components and steps", async () => {
    const result = await tools.call("harness_query", {
      handle,
      deviceType: "diode",
    });
    expect(result.queryMode).toBe("device-type");
    expect(result.deviceTypeData.deviceType).toBe("diode");
    expect(result.deviceTypeData.components.length).toBeGreaterThan(0);
    expect(result.deviceTypeData.steps.length).toBeGreaterThan(0);
  });

  // MCP-12: component + limiting
  it("MCP-12: limiting data returns valid structure", async () => {
    const topology = (session as any)._ourTopology;
    // Find a nonlinear element (diode or BJT) that will have limiting events
    const nlEl = topology.elements.find((e: any) => e.type === "diode" || e.type === "bjt");
    const compLabel = nlEl ? nlEl.label : "D1";

    const result = await tools.call("harness_query", {
      handle,
      component: compLabel,
      step: 0,
      iteration: 0,
      limiting: true,
    });
    expect(result.queryMode).toBe("limiting");
    const ld = result.limitingData;
    expect(ld.noEvents, "limiting events must exist for nonlinear element").toBe(false);
    expect(typeof ld.component).toBe("string");
    expect(typeof ld.stepIndex).toBe("number");
    expect(typeof ld.iteration).toBe("number");
    expect(ld.junctions.length).toBeGreaterThan(0);
    for (const j of ld.junctions) {
      assertFormattedNumber(j.ourPreLimit, "junction.ourPreLimit");
      assertFormattedNumber(j.ourPostLimit, "junction.ourPostLimit");
      assertFormattedNumber(j.ourDelta, "junction.ourDelta");
    }
  });

  // MCP-13: state history
  it("MCP-13: state history returns slots and iterations", async () => {
    const result = await tools.call("harness_query", {
      handle,
      component: "D1",
      step: 0,
      stateHistory: true,
    });
    expect(result.queryMode).toBe("step-state-history");
    expect(result.stateHistory.slots.length).toBeGreaterThan(0);
    expect(result.stateHistory.iterations.length).toBeGreaterThan(0);
  });

  // MCP-14: component divergences
  it("MCP-14: component divergences returns valid structure", async () => {
    const result = await tools.call("harness_query", {
      handle,
      component: "D1",
      filter: "divergences",
    });
    expect(result.queryMode).toBe("component-divergences");
    assertPagination(result);
    for (const d of result.divergences) {
      assertFormattedNumber(d.ours, "divergence.ours");
      assertFormattedNumber(d.ngspice, "divergence.ngspice");
      assertFormattedNumber(d.absDelta, "divergence.absDelta");
    }
  });

  // MCP-15: harness_compare_matrix valid
  it("MCP-15: compare_matrix returns labeled entries", async () => {
    const result = await tools.call("harness_compare_matrix", {
      handle,
      step: 0,
      iteration: 0,
      filter: "all",
    });
    expect(result.entries.length).toBeGreaterThan(0);
    for (const e of result.entries) {
      expect(typeof e.rowLabel).toBe("string");
      expect(typeof e.colLabel).toBe("string");
      assertFormattedNumber(e.ours, "matrix.ours");
      assertFormattedNumber(e.ngspice, "matrix.ngspice");
      assertFormattedNumber(e.delta, "matrix.delta");
      assertFormattedNumber(e.absDelta, "matrix.absDelta");
      expect(typeof e.withinTol).toBe("boolean");
    }
  });

  // MCP-16: harness_compare_matrix iteration out of range
  it("MCP-16: compare_matrix rejects out-of-range iteration", async () => {
    await expect(
      tools.call("harness_compare_matrix", {
        handle,
        step: 0,
        iteration: 999,
      }),
    ).rejects.toThrow(/iteration 999 out of range/);
  });

  // MCP-17: harness_describe
  it("MCP-17: describe returns components, nodes, matrixSize, and nodeMapping", async () => {
    const result = await tools.call("harness_describe", { handle });
    expect(result.components.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.matrixSize).toBeGreaterThan(0);
    expect(result.nodeMapping).toBeDefined();
    expect(Array.isArray(result.nodeMapping)).toBe(true);
    for (const nm of result.nodeMapping) {
      expect(typeof nm.ourIndex).toBe("number");
      expect(typeof nm.ngspiceIndex).toBe("number");
      expect(typeof nm.label).toBe("string");
    }
    for (const comp of result.components) {
      expect(typeof comp.label).toBe("string");
      expect(typeof comp.type).toBe("string");
      expect(Array.isArray(comp.pins)).toBe(true);
      expect(Array.isArray(comp.slots)).toBe(true);
    }
    for (const node of result.nodes) {
      expect(typeof node.label).toBe("string");
      expect(typeof node.index).toBe("number");
    }
  });

  // MCP-18: harness_export
  it("MCP-18: export returns sizeBytes, steps, analysis, topology", async () => {
    const result = await tools.call("harness_export", { handle });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.analysis).toBe("tran");
    expect(result.topology).toBeDefined();
    expect(result.topology.components.length).toBeGreaterThan(0);

    const roundTrip = JSON.parse(JSON.stringify(result));
    expect(roundTrip.sizeBytes).toBe(result.sizeBytes);
    expect(roundTrip.steps.length).toBe(result.steps.length);
    expect(roundTrip.analysis).toBe(result.analysis);
  });

  // MCP-19: slot glob case-insensitive (tested via stateHistory which filters by slots)
  it("MCP-19: slot glob is case-insensitive", async () => {
    const upper = await tools.call("harness_query", {
      handle,
      component: "D1",
      step: 0,
      stateHistory: true,
      slots: ["VD"],
    });
    const lower = await tools.call("harness_query", {
      handle,
      component: "D1",
      step: 0,
      stateHistory: true,
      slots: ["vd"],
    });

    expect(upper.queryMode).toBe("step-state-history");
    expect(lower.queryMode).toBe("step-state-history");

    const upperSlots = upper.stateHistory.slots;
    const lowerSlots = lower.stateHistory.slots;

    expect(upperSlots.length, "VD should match diode voltage slot").toBeGreaterThan(0);
    expect(upperSlots.length).toBe(lowerSlots.length);

    for (const name of upperSlots) {
      expect(name.toUpperCase().startsWith("VD")).toBe(true);
    }
  });

  // MCP-20: unknown component returns did-you-mean error
  it("MCP-20: unknown component returns did-you-mean error", async () => {
    await expect(
      tools.call("harness_query", { handle, component: "Q99" }),
    ).rejects.toThrow(/not found.*Did you mean/);
  });
});
