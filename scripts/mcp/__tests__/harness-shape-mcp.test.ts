/**
 * W6.T2 — MCP harness shape mode tests (§10.4).
 *
 * Tests for:
 *   1. harness_session_map returns a SessionMap object with step counts and attempts.
 *   2. harness_get_step returns step-end data with presence field on step.ours/ngspice arrays.
 *   3. circuit_convergence_log { action: "disable" } returns a conflict error when
 *      a comparison harness capture hook is installed on the active coordinator.
 *
 * These tests use the same ToolCapture mock server pattern as
 * harness-mcp-verification.test.ts, but with self-compare sessions so
 * no ngspice DLL is required.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ComparisonSession } from "../../../src/solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../src/headless/default-facade.js";
import { createDefaultRegistry } from "../../../src/components/register-all.js";
import { HarnessSessionState } from "../harness-session-state.js";
import { registerHarnessTools } from "../harness-tools.js";
import { registerSimulationTools } from "../simulation-tools.js";
import { SessionState } from "../tool-helpers.js";
import type { ComponentRegistry } from "../../../src/core/registry.js";
import type { Circuit } from "../../../src/core/circuit.js";
import type { PhaseAwareCaptureHook } from "../../../src/solver/coordinator-types.js";

// ---------------------------------------------------------------------------
// ToolCapture — lightweight mock MCP server (mirrors harness-mcp-verification)
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

  async callRaw(name: string, args: Record<string, any>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const handler = this._handlers.get(name);
    if (!handler) throw new Error(`Tool ${name} not registered`);
    return handler(args);
  }

  async call(name: string, args: Record<string, any>): Promise<any> {
    const response = await this.callRaw(name, args);
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  }
}

// ---------------------------------------------------------------------------
// Circuit factory (RC — headless, no DLL)
// ---------------------------------------------------------------------------

function buildRcCircuit(registry: ComponentRegistry): Circuit {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { capacitance: 1e-6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Shared session fixture (self-compare dcop, no DLL)
// ---------------------------------------------------------------------------

let session: ComparisonSession;
let handle: string;
let tools: ToolCapture;

beforeAll(async () => {
  const registry = createDefaultRegistry();
  session = await ComparisonSession.createSelfCompare({
    buildCircuit: buildRcCircuit,
    analysis: "dcop",
  });

  const harnessState = new HarnessSessionState();
  handle = harnessState.store({
    session,
    dtsPath: "<inline>",
    createdAt: new Date(),
    lastRunAt: new Date(),
    analysis: "dcop",
  });

  tools = new ToolCapture();
  registerHarnessTools(tools as any, harnessState);
}, 30_000);

// ---------------------------------------------------------------------------
// Test 1: harness_session_map returns a SessionMap object
// ---------------------------------------------------------------------------

describe("harness_session_map shape", () => {
  it("returns a SessionMap with analysis, step counts, and attempts on both sides", async () => {
    const parsed = await tools.call("harness_session_map", { handle });
    expect(parsed).toHaveProperty("sessionMap");
    const map = parsed.sessionMap;
    expect(map).toHaveProperty("analysis");
    expect(map.analysis).toMatch(/dcop|tran/);
    expect(map).toHaveProperty("ours");
    expect(map).toHaveProperty("ngspice");
    expect(typeof map.ours.stepCount).toBe("number");
    expect(Array.isArray(map.ours.steps)).toBe(true);
    expect(map.ours.steps.length).toBe(map.ours.stepCount);
  });
});

// ---------------------------------------------------------------------------
// Test 2: harness_get_step returns formatted timing fields
// ---------------------------------------------------------------------------

describe("harness_get_step timing fields", () => {
  it("returns stepStartTime, stepEndTime, and dt as FormattedNumber ComparedValue objects", async () => {
    const result = await tools.call("harness_get_step", { handle, index: 0 });
    expect(result.step).toBeDefined();
    const step = result.step;
    // Each timing field must be a ComparedValueJSON with FormattedNumber sub-fields
    for (const field of ["stepStartTime", "stepEndTime", "dt"] as const) {
      const cv = step[field];
      expect(cv, `${field} must be defined`).toBeDefined();
      expect(typeof cv.ours?.display, `${field}.ours.display must be string`).toBe("string");
      expect(typeof cv.ngspice?.display, `${field}.ngspice.display must be string`).toBe("string");
      expect(typeof cv.withinTol, `${field}.withinTol must be boolean`).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: circuit_convergence_log disable conflict (via MCP tool)
// Exercises the simulation-tools circuit_convergence_log handler's error path.
// ---------------------------------------------------------------------------

describe("circuit_convergence_log disable conflict", () => {
  it("returns a clear error when a harness capture hook is installed", async () => {
    const registry = createDefaultRegistry();
    const simFacade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(registry);

    // Compile via facade. No DCOP runs at compile time — analyses
    // (dcOperatingPoint(), step()) drive their own DCOP on demand.
    const coordinator = simFacade.compile(circuit);

    // Install capture hook — sets _captureHookInstalled on the coordinator
    const bundle: PhaseAwareCaptureHook = {
      iterationHook: () => {},
      phaseHook: { onAttemptBegin: () => {}, onAttemptEnd: () => {} },
    };
    simFacade.setCaptureHook(bundle);

    // Store the pre-compiled coordinator in a SessionState so
    // ensureEngine() finds it without recompiling (which would reset the hook)
    const simSession = new SessionState();
    const circuitHandle = simSession.store(circuit);
    simSession.storeEngine(circuitHandle, coordinator);

    // Register simulation tools on a separate ToolCapture
    const simTools = new ToolCapture();
    registerSimulationTools(simTools as any, simFacade, registry, simSession);

    // Call circuit_convergence_log { action: "disable" } — must return an error
    const raw = await simTools.callRaw("circuit_convergence_log", {
      handle: circuitHandle,
      action: "disable",
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/comparison harness|harness session/);
  });
});
