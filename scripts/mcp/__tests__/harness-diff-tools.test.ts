/**
 * Focused tests for the diff/investigation MCP tools:
 *   - harness_topology_diff
 *   - harness_matrix_diff
 *   - harness_first_divergence
 *
 * Uses self-compare (no DLL) to exercise the well-formedness and the
 * trivial-case verdicts (classification === "match", every divergence === null).
 * Real ngspice-driven divergence tests live alongside the parity suite.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ComparisonSession } from "../../../src/solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../src/headless/default-facade.js";
import { createDefaultRegistry } from "../../../src/components/register-all.js";
import { HarnessSessionState } from "../harness-session-state.js";
import { registerHarnessTools } from "../harness-tools.js";
import type { ComponentRegistry } from "../../../src/core/registry.js";
import type { Circuit } from "../../../src/core/circuit.js";

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
  has(name: string): boolean {
    return this._handlers.has(name);
  }
}

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
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

let session: ComparisonSession;
let handle: string;
let tools: ToolCapture;

beforeAll(async () => {
  // Don't shadow `_` between the registry and the facade; we need a real registry
  // for the session to find Capacitor's stateSchema.
  void createDefaultRegistry;

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

describe("harness diff-tool registration", () => {
  it("registers all three new tools", () => {
    expect(tools.has("harness_topology_diff")).toBe(true);
    expect(tools.has("harness_matrix_diff")).toBe(true);
    expect(tools.has("harness_first_divergence")).toBe(true);
  });
});

describe("harness_topology_diff", () => {
  it("returns a well-formed report on a self-compare session (no ngspice side)", async () => {
    const parsed = await tools.call("harness_topology_diff", { handle });
    expect(parsed).toHaveProperty("topologyDiff");
    const t = parsed.topologyDiff;
    expect(typeof t.ourElementCount).toBe("number");
    expect(t.ourElementCount).toBeGreaterThan(0);
    expect(t.ngspiceElementCount).toBe(0);
    expect(t.ourNodeCount).toBeGreaterThan(0);
    expect(t.ourMatrixSize).toBeGreaterThan(0);
    expect(Array.isArray(t.elementDiffs)).toBe(true);
    expect(Array.isArray(t.orderingDiffs)).toBe(true);
    expect(Array.isArray(t.unmappedNgspiceNodes)).toBe(true);
    expect(Array.isArray(t.structuralFindings)).toBe(true);
    // Self-compare reuses our session for both sides via deepCloneSession +
    // identity node map, so the structural assertions never fire and findings
    // stay empty.
    expect(t.structuralFindings.length).toBe(0);
    expect(t.elementDiffs.length).toBe(0);
    expect(t.orderingDiffs.length).toBe(0);
  });
});

describe("harness_matrix_diff", () => {
  it("classifies a self-compare DC-OP as 'match' with empty diff arrays", async () => {
    const parsed = await tools.call("harness_matrix_diff", { handle });
    expect(parsed).toHaveProperty("matrixDiff");
    const m = parsed.matrixDiff;
    expect(m.stepIndex).toBe(0);
    expect(m.iterationIndex).toBe(0);
    expect(m.classification).toBe("match");
    expect(m.oursOnly).toEqual([]);
    expect(m.ngspiceOnly).toEqual([]);
    expect(m.valueMismatches).toEqual([]);
    expect(m.ourCellCount).toBeGreaterThan(0);
    expect(m.ngspiceCellCount).toBe(m.ourCellCount);
  });

  it("accepts stepIndex / iterationIndex overrides", async () => {
    const parsed = await tools.call("harness_matrix_diff", {
      handle, stepIndex: 0, iterationIndex: 0,
    });
    expect(parsed.matrixDiff.classification).toBe("match");
  });

  it("throws on out-of-range step", async () => {
    await expect(
      tools.call("harness_matrix_diff", { handle, stepIndex: 9999 })
    ).rejects.toThrow(/step .* out of range/);
  });
});

describe("harness_first_divergence", () => {
  it("returns all-null on a self-compare session (all eight classes + earliest)", async () => {
    const parsed = await tools.call("harness_first_divergence", { handle });
    expect(parsed).toHaveProperty("firstDivergence");
    const f = parsed.firstDivergence;
    expect(f.voltage).toBeNull();
    expect(f.rhs).toBeNull();
    expect(f.matrix).toBeNull();
    expect(f.state).toBeNull();
    expect(f.integration).toBeNull();
    expect(f.limiting).toBeNull();
    expect(f.convergence).toBeNull();
    expect(f.shape).toBeNull();
    expect(f.earliest).toBeNull();
  });
});

describe("ComparisonSession direct API (matrixDiff / topologyDiff / firstDivergence)", () => {
  it("exposes the methods on the class and matches the MCP responses", () => {
    const t = session.topologyDiff();
    const m = session.matrixDiff();
    const f = session.firstDivergence();
    expect(t.ourElementCount).toBeGreaterThan(0);
    expect(m.classification).toBe("match");
    expect(f.earliest).toBeNull();
  });

  it("structuralFindings is readonly and empty on a clean self-compare run", () => {
    expect(session.structuralFindings.length).toBe(0);
  });
});

describe("harness AC first-divergence branch", () => {
  // Proven no-DLL AC self-compare setup (mirrors ac-first-divergence-smoke.test.ts).
  const DTS = "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts";
  const AC_PARAMS = { type: "dec" as const, numPoints: 5, fStart: 1, fStop: 1e4, outputNodes: [] as string[] };

  let acHandle: string;
  let acTools: ToolCapture;

  beforeAll(async () => {
    const acSession = await ComparisonSession.createSelfCompare({
      dtsPath: DTS,
      analysis: "ac",
      acParams: AC_PARAMS,
    });
    const acState = new HarnessSessionState();
    acHandle = acState.store({
      session: acSession,
      dtsPath: DTS,
      createdAt: new Date(),
      lastRunAt: new Date(),
      analysis: "ac", // createSelfCompare already ran the AC sweep
    });
    acTools = new ToolCapture();
    registerHarnessTools(acTools as any, acState);
  }, 30_000);

  it("registers harness_run_ac and harness_ac_session_shape", () => {
    expect(acTools.has("harness_run_ac")).toBe(true);
    expect(acTools.has("harness_ac_session_shape")).toBe(true);
  });

  it("harness_ac_session_shape returns full per-frequency-point detail", async () => {
    const res = await acTools.call("harness_ac_session_shape", { handle: acHandle });
    expect(res.analysis).toBe("ac");
    expect(res.shape.pointCount.ours).toBeGreaterThan(0);
    expect(Array.isArray(res.shape.points)).toBe(true);
    expect(res.shape.points.length).toBe(res.shape.pointCount.max);
    // self-compare clone: no frequency-axis divergence.
    expect(res.shape.largeFreqDeltas).toEqual([]);
  });

  it("harness_run_ac sets analysis=ac and returns a frequency-axis shape", async () => {
    const res = await acTools.call("harness_run_ac", { handle: acHandle, ...AC_PARAMS });
    expect(res.analysis).toBe("ac");
    expect(res.shape.pointCount.ours).toBeGreaterThan(0);
    // self-compare clone: both sides have identical point counts.
    expect(res.shape.pointCount.ours).toBe(res.shape.pointCount.ngspice);
  });

  it("harness_first_divergence dispatches to the AC branch- all-null on self-compare", async () => {
    const res = await acTools.call("harness_first_divergence", { handle: acHandle });
    expect(res.analysis).toBe("ac");
    expect(res).toHaveProperty("acFirstDivergence");
    expect(res).not.toHaveProperty("firstDivergence");
    const f = res.acFirstDivergence;
    expect(f.solution).toBeNull();
    expect(f.shape).toBeNull();
    expect(f.matrix).toBeNull();
    expect(f.rhs).toBeNull();
    expect(f.earliestPointIndex).toBeNull();
  });

  it("DC/TRAN-only tools reject an AC handle with a clear error", async () => {
    await expect(acTools.call("harness_matrix_diff", { handle: acHandle })).rejects.toThrow(/not available for AC/);
    await expect(
      acTools.call("harness_get_attempt", { handle: acHandle, stepIndex: 0, phase: "tranNR", phaseAttemptIndex: 0 }),
    ).rejects.toThrow(/not available for AC/);
    await expect(acTools.call("harness_session_map", { handle: acHandle })).rejects.toThrow(/not available for AC/);
  });
});
