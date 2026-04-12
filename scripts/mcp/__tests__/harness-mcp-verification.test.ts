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

  // MCP-1: harness_session_map returns correct structure
  it("MCP-1: session_map returns analysis, step counts, and attempts on both sides", async () => {
    const result = await tools.call("harness_session_map", { handle });
    expect(result.sessionMap).toBeDefined();
    const map = result.sessionMap;
    expect(map.analysis).toBe("tran");
    expect(map.ours.stepCount).toBeGreaterThan(0);
    expect(map.ngspice.stepCount).toBeGreaterThan(0);
    expect(map.ours.steps.length).toBe(map.ours.stepCount);
    expect(map.ngspice.steps.length).toBe(map.ngspice.stepCount);

    const step0 = map.ours.steps[0];
    expect(typeof step0.index).toBe("number");
    expect(typeof step0.stepStartTime).toBe("number");
    expect(typeof step0.stepEndTime).toBe("number");
    expect(typeof step0.converged).toBe("boolean");
    expect(typeof step0.iterationCount).toBe("number");
    expect(typeof step0.totalIterationCount).toBe("number");
    expect(typeof step0.analysisPhase).toBe("string");
    expect(Array.isArray(step0.attempts)).toBe(true);
    expect(step0.attempts.length).toBeGreaterThan(0);

    const att0 = step0.attempts[0];
    expect(typeof att0.index).toBe("number");
    expect(typeof att0.phase).toBe("string");
    expect(typeof att0.outcome).toBe("string");
    expect(typeof att0.iterationCount).toBe("number");
    expect(typeof att0.accepted).toBe("boolean");
  });

  // MCP-2: harness_get_step by index returns paired attempt summaries
  it("MCP-2: get_step by index returns paired attempt summaries and pairing array", async () => {
    const result = await tools.call("harness_get_step", { handle, index: 0 });
    expect(result.step).toBeDefined();
    const step = result.step;
    expect(typeof step.stepIndex).toBe("number");
    expect(typeof step.ourStepIndex).toBe("number");
    expect(typeof step.ngspiceStepIndex).toBe("number");
    assertComparedValueJSON(step.stepStartTime, "step.stepStartTime");
    assertComparedValueJSON(step.stepEndTime, "step.stepEndTime");
    assertComparedValueJSON(step.dt, "step.dt");
    expect(Array.isArray(step.ours)).toBe(true);
    expect(Array.isArray(step.ngspice)).toBe(true);
    expect(Array.isArray(step.pairing)).toBe(true);

    for (const att of step.ours) {
      expect(typeof att.index).toBe("number");
      expect(typeof att.phase).toBe("string");
      expect(typeof att.outcome).toBe("string");
      expect(typeof att.iterationCount).toBe("number");
      expect(typeof att.accepted).toBe("boolean");
      expect(typeof att.endNodeNorm).toBe("number");
      expect(typeof att.endBranchNorm).toBe("number");
    }

    for (const pair of step.pairing) {
      expect(typeof pair.phase).toBe("string");
      expect(typeof pair.divergenceNorm).toBe("number");
    }
  });

  // MCP-3: harness_get_step by time returns a valid step
  it("MCP-3: get_step by time finds nearest step", async () => {
    const map = (await tools.call("harness_session_map", { handle })).sessionMap;
    const midTime = map.ours.steps[Math.floor(map.ours.stepCount / 2)].stepEndTime;
    const result = await tools.call("harness_get_step", { handle, time: midTime });
    expect(result.step).toBeDefined();
    expect(typeof result.step.stepIndex).toBe("number");
  });

  // MCP-4: harness_get_step rejects when both index and time provided
  it("MCP-4: get_step rejects ambiguous query", async () => {
    await expect(
      tools.call("harness_get_step", { handle, index: 0, time: 1e-6 }),
    ).rejects.toThrow(/provide either/);
  });

  // MCP-5: harness_get_step rejects when neither index nor time provided
  it("MCP-5: get_step rejects empty query", async () => {
    await expect(
      tools.call("harness_get_step", { handle }),
    ).rejects.toThrow(/provide/);
  });

  // MCP-6: harness_get_attempt returns paired iteration data
  it("MCP-6: get_attempt returns paired iterations with divergenceNorm", async () => {
    // Find a phase that exists on ours side at step 0
    const stepResult = await tools.call("harness_get_step", { handle, index: 0 });
    const step = stepResult.step;
    const ourPhase: string = step.ours[0]?.phase ?? "tranInit";

    const result = await tools.call("harness_get_attempt", {
      handle,
      stepIndex: 0,
      phase: ourPhase,
      phaseAttemptIndex: 0,
    });
    expect(result.attempt).toBeDefined();
    const att = result.attempt;
    expect(att.stepIndex).toBe(0);
    expect(att.phase).toBe(ourPhase);
    expect(att.phaseAttemptIndex).toBe(0);
    expect(Array.isArray(att.iterations)).toBe(true);

    for (const iter of att.iterations) {
      expect(typeof iter.iterationIndex).toBe("number");
      expect(typeof iter.divergenceNorm).toBe("number");
      // ours data
      if (iter.ours !== null) {
        expect(typeof iter.ours.rawIteration).toBe("number");
        expect(typeof iter.ours.globalConverged).toBe("boolean");
        expect(typeof iter.ours.noncon).toBe("number");
        expect(typeof iter.ours.nodeVoltages).toBe("object");
        expect(typeof iter.ours.branchValues).toBe("object");
        expect(typeof iter.ours.elementStates).toBe("object");
        expect(Array.isArray(iter.ours.limitingEvents)).toBe(true);
      }
    }
  });

  // MCP-7: harness_get_attempt pagination works
  it("MCP-7: get_attempt pagination limits returned iterations", async () => {
    const stepResult = await tools.call("harness_get_step", { handle, index: 0 });
    const ourPhase: string = stepResult.step.ours[0]?.phase ?? "tranInit";

    const resultFull = await tools.call("harness_get_attempt", {
      handle, stepIndex: 0, phase: ourPhase, phaseAttemptIndex: 0,
    });
    const resultPaged = await tools.call("harness_get_attempt", {
      handle, stepIndex: 0, phase: ourPhase, phaseAttemptIndex: 0, limit: 1, offset: 0,
    });
    expect(resultPaged.attempt.iterations.length).toBeLessThanOrEqual(1);
    if (resultFull.attempt.iterations.length > 1) {
      expect(resultPaged.attempt.iterations.length).toBe(1);
    }
  });

  // MCP-8: harness_get_attempt for non-existent phase returns null attempts
  it("MCP-8: get_attempt with missing phase returns null attempt summaries", async () => {
    const result = await tools.call("harness_get_attempt", {
      handle,
      stepIndex: 0,
      phase: "dcopGminSpice3",  // unlikely to appear in a transient session
      phaseAttemptIndex: 0,
    });
    expect(result.attempt.ourAttempt).toBeNull();
    expect(result.attempt.ngspiceAttempt).toBeNull();
    expect(result.attempt.iterations).toHaveLength(0);
  });

  // MCP-9: harness_session_map before harness_run fails
  it("MCP-9: session_map fails when harness_run not called", async () => {
    const emptyState = new HarnessSessionState();
    const emptySession = await ComparisonSession.create({
      dtsPath: "fixtures/hwr-square.dts",
      dllPath: DLL_PATH,
    });
    const emptyHandle = emptyState.store({
      session: emptySession,
      dtsPath: "fixtures/hwr-square.dts",
      createdAt: new Date(),
      lastRunAt: null,
      analysis: null,
    });
    const emptyTools = new ToolCapture();
    registerHarnessTools(emptyTools as any, emptyState);
    await expect(
      emptyTools.call("harness_session_map", { handle: emptyHandle }),
    ).rejects.toThrow(/run harness_run first/);
  }, 30_000);

  // MCP-10: harness_describe
  it("MCP-10: describe returns components, nodes, matrixSize, and nodeMapping", async () => {
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

  // MCP-11: harness_export
  it("MCP-11: export returns sizeBytes, steps, analysis, topology", async () => {
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

  // MCP-12: harness_get_step pairing has phases present on both sides for transient
  it("MCP-12: get_step pairing has non-empty rows for a well-converged step", async () => {
    const map = (await tools.call("harness_session_map", { handle })).sessionMap;
    // Find a step where both sides have attempts
    let targetIdx = -1;
    for (let i = 0; i < map.ours.steps.length; i++) {
      if (map.ours.steps[i].attempts.length > 0 && (map.ngspice.steps[i]?.attempts?.length ?? 0) > 0) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) return; // skip if no such step
    const result = await tools.call("harness_get_step", { handle, index: targetIdx });
    expect(result.step.pairing.length).toBeGreaterThan(0);
    for (const pair of result.step.pairing) {
      expect(typeof pair.phase).toBe("string");
      expect(typeof pair.divergenceNorm).toBe("number");
    }
  });

  // MCP-13: harness_session_map ngspice side has steps
  it("MCP-13: session_map ngspice side has steps with attempts", async () => {
    const result = await tools.call("harness_session_map", { handle });
    const ng = result.sessionMap.ngspice;
    expect(ng.stepCount).toBeGreaterThan(0);
    for (const step of ng.steps) {
      expect(step.attempts.length).toBeGreaterThan(0);
    }
  });

  // MCP-14: removed tools are not registered
  it("MCP-14: harness_query and harness_compare_matrix are not registered", async () => {
    await expect(tools.call("harness_query", { handle })).rejects.toThrow(
      /Tool harness_query not registered/,
    );
    await expect(tools.call("harness_compare_matrix", { handle, step: 0, iteration: 0 })).rejects.toThrow(
      /Tool harness_compare_matrix not registered/,
    );
  });
});
