import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HarnessSessionState } from "../harness-session-state.js";
import { registerHarnessTools } from "../harness-tools.js";

const mockTopology = {
  matrixSize: 4, nodeCount: 3, branchCount: 1, elementCount: 2,
  elements: [
    { index: 0, label: "Q1", type: "bjt", isNonlinear: true, isReactive: false, pinNodeIds: [1, 2, 3] },
    { index: 1, label: "R1", type: "resistor", isNonlinear: false, isReactive: false, pinNodeIds: [1, 0] },
  ],
  nodeLabels: new Map([[1, "Q1:B"], [2, "Q1:C"], [3, "Q1:E"]]),
  matrixRowLabels: new Map(), matrixColLabels: new Map(),
};

const mockSummary: any = {
  analysis: "dcop",
  stepCount: { ours: 1, ngspice: 1, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
  convergence: {
    ours: { totalSteps: 1, convergedSteps: 1, failedSteps: 0, avgIterations: 2, maxIterations: 2, worstStep: 0 },
    ngspice: { totalSteps: 1, convergedSteps: 1, failedSteps: 0, avgIterations: 2, maxIterations: 2, worstStep: 0 },
  },
  firstDivergence: null,
  totals: { compared: 5, passed: 5, failed: 0 },
  perDeviceType: {}, integrationMethod: null,
  stateHistoryIssues: { state1Mismatches: 0, state2Mismatches: 0 },
};

const mockStepEnd: any = {
  stepIndex: 0,
  simTime: { ours: 0, ngspice: 0, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
  dt: { ours: 1e-6, ngspice: 1e-6, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
  converged: { ours: true, ngspice: true },
  iterationCount: { ours: 2, ngspice: 2, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
  nodes: {
    "Q1:B": { ours: 0.7, ngspice: 0.701, delta: -0.001, absDelta: 0.001, relDelta: 0.0014, withinTol: true },
  },
  branches: {},
  components: {
    Q1: {
      deviceType: "bjt",
      slots: {
        Q_BE: { ours: 0.7, ngspice: 0.701, delta: -0.001, absDelta: 0.001, relDelta: 0.0014, withinTol: true },
      },
    },
  },
};

const mockIterations: any[] = [
  {
    stepIndex: 0,
    iteration: 0,
    simTime: 0,
    noncon: { ours: 2, ngspice: 2, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
    nodes: { "Q1:B": { ours: 0.6, ngspice: 0.61, delta: -0.01, absDelta: 0.01, relDelta: 0.016, withinTol: false } },
    rhs: {},
    matrixDiffs: [],
    components: {},
    perElementConvergence: [],
  },
];

const mockConvergenceDetail: any = {
  stepIndex: 0,
  iteration: 0,
  ourNoncon: 0,
  ngspiceNoncon: 0,
  ourGlobalConverged: true,
  ngspiceGlobalConverged: true,
  elements: [
    { label: "Q1", deviceType: "bjt", ourConverged: true, ngspiceConverged: true, worstDelta: 0.001, agree: true },
  ],
  disagreementCount: 0,
};

const mockIntegrationCoeffs: any = {
  stepIndex: 0,
  ours: { ag0: 1e6, ag1: 0, method: "backwardEuler", order: 1 },
  ngspice: { ag0: 1e6, ag1: 0, method: "backwardEuler", order: 1 },
  methodMatch: true,
  ag0Compared: { ours: 1e6, ngspice: 1e6, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
  ag1Compared: { ours: 0, ngspice: 0, delta: 0, absDelta: 0, relDelta: 0, withinTol: true },
};

const mockLimitingReport: any = {
  label: "Q1",
  stepIndex: 0,
  iteration: 0,
  junctions: [
    {
      junction: "BE",
      ourPreLimit: 0.8, ourPostLimit: 0.7, ourDelta: 0.1,
      ngspicePreLimit: 0.81, ngspicePostLimit: 0.71, ngspiceDelta: 0.1,
      limitingDiff: 0,
    },
  ],
  noEvents: false,
};

const mockStateHistory: any = {
  label: "Q1",
  stepIndex: 0,
  iteration: 1,
  state0: { Q_BE: 0.7, Q_BC: -5.0 },
  state1: {},
  state2: {},
  ngspiceState0: { Q_BE: 0.701, Q_BC: -5.01 },
  ngspiceState1: {},
  ngspiceState2: {},
};

const mockDivergenceReport: any = {
  totalCount: 1,
  worstByCategory: { voltage: null, state: null, rhs: null, matrix: null },
  entries: [
    {
      stepIndex: 0, iteration: 0, simTime: 0,
      category: "voltage", label: "Q1:B",
      ours: 0.6, ngspice: 0.61, absDelta: 0.01, relDelta: 0.016, withinTol: false,
      componentLabel: null, slotName: null,
    },
  ],
};

const mockMatrixComparison: any = {
  stepIndex: 0,
  iteration: 0,
  filter: "mismatches",
  totalEntries: 3,
  mismatchCount: 1,
  maxAbsDelta: 0.05,
  entries: [
    { row: 0, col: 0, rowLabel: "Q1:B", colLabel: "Q1:B", ours: 1.0, ngspice: 1.05, delta: -0.05, absDelta: 0.05, withinTol: false },
  ],
};

const mockToJSON: any = {
  analysis: "dcop",
  stepCount: { ours: 1, ngspice: 1 },
  nodeCount: 3,
  elementCount: 2,
  summary: { totalCompared: 5, passed: 5, failed: 0, firstDivergence: null, perDeviceType: {}, integrationMethod: null, stateHistoryIssues: { state1Mismatches: 0, state2Mismatches: 0 } },
  steps: [
    {
      stepIndex: 0, simTime: 0, dt: 1e-6,
      converged: { ours: true, ngspice: true },
      iterationCount: { ours: 2, ngspice: 2 },
      nodes: {}, components: {},
    },
  ],
};

function makeMockSession(overrides: Record<string, any> = {}) {
  return {
    _ourTopology: mockTopology,
    _engine: { elements: [{ stateSchema: { slots: [{ name: "Q_BE" }, { name: "Q_BC" }] } }, null] },
    _nodeMap: [{ ourIndex: 1, ngspiceIndex: 1, label: "Q1:B", ngspiceName: "q1_b" }],
    _ourSession: { steps: [{ simTime: 0, dt: 1e-6, converged: true, iterationCount: 2, iterations: [] }] },
    errors: [] as string[],
    init: vi.fn().mockResolvedValue(undefined),
    runDcOp: vi.fn().mockResolvedValue(undefined),
    runTransient: vi.fn().mockResolvedValue(undefined),
    getSummary: vi.fn().mockReturnValue(mockSummary),
    getStepEnd: vi.fn().mockReturnValue(mockStepEnd),
    getIterations: vi.fn().mockReturnValue(mockIterations),
    getConvergenceDetail: vi.fn().mockReturnValue(mockConvergenceDetail),
    getIntegrationCoefficients: vi.fn().mockReturnValue(mockIntegrationCoeffs),
    getLimitingComparison: vi.fn().mockReturnValue(mockLimitingReport),
    getStateHistory: vi.fn().mockReturnValue(mockStateHistory),
    getDivergences: vi.fn().mockReturnValue(mockDivergenceReport),
    getComponentsByType: vi.fn().mockReturnValue(["Q1"]),
    traceComponent: vi.fn().mockReturnValue({ label: "Q1", deviceType: "bjt", steps: [] }),
    traceNode: vi.fn().mockReturnValue({ label: "Q1:B", ourIndex: 1, ngspiceIndex: 1, steps: [] }),
    compareMatrixAt: vi.fn().mockReturnValue(mockMatrixComparison),
    toJSON: vi.fn().mockReturnValue(mockToJSON),
    dispose: vi.fn(),
    ...overrides,
  };
}

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn((p: string) => !p.includes("missing") && !p.includes("notfound")) };
});

vi.mock("../../../src/solver/analog/__tests__/harness/comparison-session.js", () => ({
  ComparisonSession: vi.fn(),
}));

vi.mock("../../../src/solver/analog/element.js", () => ({
  isPoolBacked: vi.fn((el: any) => el != null && el.stateSchema !== undefined),
}));

import { existsSync } from "fs";
import { ComparisonSession } from "../../../src/solver/analog/__tests__/harness/comparison-session.js";

function buildServer() {
  const harnessState = new HarnessSessionState();
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerHarnessTools(server, harnessState);
  return { server, harnessState };
}

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const entry = (server as any)._registeredTools?.[toolName];
  if (!entry) throw new Error("Tool not registered: " + toolName);
  return entry.handler(args);
}

async function startSession(server: McpServer) {
  const r = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
  if (r.isError) throw new Error("startSession failed: " + r.content[0].text);
  return JSON.parse(r.content[0].text).handle as string;
}

describe("harness_start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockImplementation((p: string) => !p.includes("missing") && !p.includes("notfound"));
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("valid paths returns handle h0 status ready topology populated", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.handle).toBe("h0");
    expect(data.status).toBe("ready");
    expect(data.topology.matrixSize).toBe(4);
    expect(data.topology.components).toHaveLength(2);
    expect(data.topology.nodes).toHaveLength(3);
  });

  it("topology components have label type pins slots", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
    const data = JSON.parse(result.content[0].text);
    const q1 = data.topology.components.find((c: any) => c.label === "Q1");
    expect(q1).toBeDefined();
    expect(q1.type).toBe("bjt");
    expect(q1.pins).toContain("Q1:B");
    expect(q1.slots).toContain("Q_BE");
  });

  it("topology nodes have label index connectedComponents", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
    const data = JSON.parse(result.content[0].text);
    const node = data.topology.nodes[0];
    expect(node.label).toBeDefined();
    expect(typeof node.index).toBe("number");
    expect(Array.isArray(node.connectedComponents)).toBe(true);
  });

  it("ground node index 0 absent from nodes", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
    const data = JSON.parse(result.content[0].text);
    expect(data.topology.nodes.find((n: any) => n.index === 0)).toBeUndefined();
  });

  it("missing dtsPath isError true file not found", async () => {
    (existsSync as any).mockImplementation((p: string) => !p.endsWith("missing.dts"));
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/missing.dts", cirPath: "/fixtures/test.cir" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/file not found/);
  });

  it("missing cirPath without autoGenerate isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cirPath required/);
  });

  it("autoGenerate true derives cir path from dts path", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", autoGenerate: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.cirPath).toMatch(/test\.cir$/);
  });

  it("autoGenerate true cir not found isError true", async () => {
    (existsSync as any).mockImplementation((p: string) => !p.endsWith(".cir"));
    const { server } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", autoGenerate: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/auto-generated cir path not found/);
  });

  it("init throws no handle allocated isError true", async () => {
    (ComparisonSession as any).mockImplementation(() => makeMockSession({ init: vi.fn().mockRejectedValue(new Error("compile error")) }));
    const { server, harnessState } = buildServer();
    const result = await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/circuit compile failed/);
    expect(harnessState.size).toBe(0);
  });

  it("tolerance overrides propagate to ComparisonSession", async () => {
    const { server } = buildServer();
    await callTool(server, "harness_start", { dtsPath: "/fixtures/test.dts", cirPath: "/fixtures/test.cir", tolerance: { vAbsTol: 1e-4, relTol: 1e-2 } });
    expect(ComparisonSession).toHaveBeenCalledWith(expect.objectContaining({ tolerance: { vAbsTol: 1e-4, relTol: 1e-2 } }));
  });
});

describe("harness_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockReturnValue(true);
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("analysis dcop calls runDcOp", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    expect(ms.runDcOp).toHaveBeenCalledOnce();
    expect(ms.runTransient).not.toHaveBeenCalled();
  });

  it("analysis tran without stopTime isError true", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_run", { handle, analysis: "tran" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/stopTime is required/);
  });

  it("analysis tran calls runTransient with correct args", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "tran", stopTime: 5e-3, maxStep: 1e-5 });
    expect(ms.runTransient).toHaveBeenCalledWith(0, 5e-3, 1e-5);
  });

  it("summary firstDivergence null when all within tolerance", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const data = JSON.parse(result.content[0].text);
    expect(data.summary.firstDivergence).toBeNull();
  });

  it("summary firstDivergence populated when divergence found", async () => {
    const fd = { stepIndex: 2, iterationIndex: 1, simTime: 1e-3, worstLabel: "Q1:C", absDelta: 0.05 };
    const ms = makeMockSession({ getSummary: vi.fn().mockReturnValue({ ...mockSummary, firstDivergence: fd }) });
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const data = JSON.parse(result.content[0].text);
    expect(data.summary.firstDivergence).not.toBeNull();
    expect(data.summary.firstDivergence.stepIndex).toBe(2);
    expect(data.summary.firstDivergence.worstLabel).toBe("Q1:C");
  });

  it("errors array populated from session.errors", async () => {
    const ms = makeMockSession({ errors: ["ngspice failed: boom"] });
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toContain("ngspice failed: boom");
  });

  it("unknown handle isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_run", { handle: "h99", analysis: "dcop" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown handle/i);
  });

  it("re-run calls runDcOp again", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    expect(ms.runDcOp).toHaveBeenCalledTimes(2);
  });
});

describe("harness_describe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockReturnValue(true);
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("returns full topology components and nodes", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_describe", { handle });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.components).toHaveLength(2);
    expect(data.nodes).toHaveLength(3);
    expect(data.matrixSize).toBe(4);
  });

  it("nodeMapping is array before harness_run", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_describe", { handle });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.nodeMapping)).toBe(true);
  });

  it("nodeMapping entries have ourIndex ngspiceIndex label", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_describe", { handle });
    const data = JSON.parse(result.content[0].text);
    if (data.nodeMapping.length > 0) {
      expect(data.nodeMapping[0]).toHaveProperty("ourIndex");
      expect(data.nodeMapping[0]).toHaveProperty("ngspiceIndex");
      expect(data.nodeMapping[0]).toHaveProperty("label");
    }
  });

  it("ground node absent from nodes", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_describe", { handle });
    const data = JSON.parse(result.content[0].text);
    expect(data.nodes.find((n: any) => n.index === 0)).toBeUndefined();
  });

  it("ComponentInfoDetailed.index matches element index", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_describe", { handle });
    const data = JSON.parse(result.content[0].text);
    expect(data.components.find((c: any) => c.label === "Q1").index).toBe(0);
    expect(data.components.find((c: any) => c.label === "R1").index).toBe(1);
  });

  it("unknown handle isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_describe", { handle: "h99" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown handle/i);
  });
});

describe("harness_dispose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockReturnValue(true);
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("valid handle success true session removed", async () => {
    const { server, harnessState } = buildServer();
    const handle = await startSession(server);
    expect(harnessState.size).toBe(1);
    const result = await callTool(server, "harness_dispose", { handle });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.handle).toBe(handle);
    expect(harnessState.size).toBe(0);
  });

  it("subsequent dispose isError true", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_dispose", { handle });
    const result = await callTool(server, "harness_dispose", { handle });
    expect(result.isError).toBe(true);
  });

  it("unknown handle isError true Already disposed in message", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_dispose", { handle: "h99" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Already disposed/);
  });

  it("ComparisonSession.dispose called once", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_dispose", { handle });
    expect(ms.dispose).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// harness_query
// =============================================================================

describe("harness_query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockImplementation((p: string) => !p.includes("missing") && !p.includes("notfound"));
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  async function startAndRun(server: McpServer) {
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    return handle;
  }

  it("unknown handle isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_query", { handle: "h99", type: "summary" });
    expect(result.isError).toBe(true);
  });

  it("no analysis run returns error", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_query", { handle, type: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/harness_run/);
  });

  it("type summary returns queryMode summary and summary object", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, type: "summary" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("summary");
    expect(data.summary).toBeDefined();
    expect(data.summary.analysis).toBe("dcop");
  });

  it("component+step returns component-step-end queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1", step: 0 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("component-step-end");
    expect(data.stepEnd.label).toBe("Q1");
  });

  it("component only returns component-trace queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("component-trace");
    expect(data.componentTrace.label).toBe("Q1");
  });

  it("node returns node-trace queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, node: "Q1:B" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("node-trace");
    expect(data.nodeTrace.label).toBe("Q1:B");
  });

  it("step only returns step-end queryMode with converged field", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, step: 0 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("step-end");
    expect(data.stepEnd.converged).toBeDefined();
  });

  it("step+iterations returns step-iterations queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, step: 0, iterations: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("step-iterations");
    expect(data.iterationData).toBeInstanceOf(Array);
  });

  it("step+integrationCoefficients returns integration-coefficients queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, step: 0, integrationCoefficients: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("integration-coefficients");
    expect(data.integrationCoefficients.methodMatch).toBe(true);
  });

  it("step+iteration+convergence returns per-element-convergence queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, step: 0, iteration: 0, convergence: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("per-element-convergence");
    expect(data.convergenceData).toBeInstanceOf(Array);
  });

  it("component+step+iteration+limiting returns limiting queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1", step: 0, iteration: 0, limiting: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("limiting");
    expect(data.limitingData.component).toBe("Q1");
    expect(data.limitingData.junctions).toHaveLength(1);
  });

  it("component+step+stateHistory returns step-state-history queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1", step: 0, stateHistory: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("step-state-history");
    expect(data.stateHistory.component).toBe("Q1");
  });

  it("deviceType returns device-type queryMode with matching components", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, deviceType: "bjt" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("device-type");
    expect(data.deviceTypeData.components).toContain("Q1");
  });

  it("filter divergences returns divergences queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, filter: "divergences" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("divergences");
    expect(data.divergences).toBeInstanceOf(Array);
  });

  it("filter worst returns divergences queryMode top entries", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, filter: "worst", worstN: 5 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("divergences");
  });

  it("no primary mode returns error", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no query mode/);
  });

  it("unknown component returns error with suggestions", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "XYZ999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("unknown node returns error", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, node: "NOTANODE" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("combining component and node returns ambiguous error", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1", node: "Q1:B" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ambiguous/);
  });

  it("step out of range returns error", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, step: 9999 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/out of range/);
  });

  it("result includes total offset limit fields", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, filter: "divergences" });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("offset");
    expect(data).toHaveProperty("limit");
  });

  it("component+filter divergences returns component-divergences queryMode", async () => {
    const { server } = buildServer();
    const handle = await startAndRun(server);
    const result = await callTool(server, "harness_query", { handle, component: "Q1", filter: "divergences" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.queryMode).toBe("component-divergences");
  });
});

// =============================================================================
// harness_compare_matrix
// =============================================================================

describe("harness_compare_matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockImplementation((p: string) => !p.includes("missing") && !p.includes("notfound"));
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("unknown handle isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_compare_matrix", { handle: "h99", step: 0, iteration: 0 });
    expect(result.isError).toBe(true);
  });

  it("no analysis run returns error", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_compare_matrix", { handle, step: 0, iteration: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/harness_run/);
  });

  it("returns entries with rowLabel colLabel ours ngspice delta withinTol", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const result = await callTool(server, "harness_compare_matrix", { handle, step: 0, iteration: 0 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.entries).toBeInstanceOf(Array);
    expect(data.entries[0]).toHaveProperty("rowLabel");
    expect(data.entries[0]).toHaveProperty("colLabel");
    expect(data.entries[0]).toHaveProperty("ours");
    expect(data.entries[0]).toHaveProperty("ngspice");
    expect(data.entries[0]).toHaveProperty("absDelta");
    expect(data.entries[0]).toHaveProperty("withinTol");
  });

  it("default filter is mismatches", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const result = await callTool(server, "harness_compare_matrix", { handle, step: 0, iteration: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(data.filter).toBe("mismatches");
  });

  it("filter all passes through to compareMatrixAt", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    await callTool(server, "harness_compare_matrix", { handle, step: 0, iteration: 0, filter: "all" });
    expect(ms.compareMatrixAt).toHaveBeenCalledWith(0, 0, "all");
  });

  it("step out of range returns error", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const result = await callTool(server, "harness_compare_matrix", { handle, step: 9999, iteration: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/out of range/);
  });

  it("response includes total offset limit step iteration", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const result = await callTool(server, "harness_compare_matrix", { handle, step: 0, iteration: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("step", 0);
    expect(data).toHaveProperty("iteration", 0);
  });
});

// =============================================================================
// harness_export
// =============================================================================

describe("harness_export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as any).mockImplementation((p: string) => !p.includes("missing") && !p.includes("notfound"));
    (ComparisonSession as any).mockImplementation(() => makeMockSession());
  });

  it("unknown handle isError true", async () => {
    const { server } = buildServer();
    const result = await callTool(server, "harness_export", { handle: "h99" });
    expect(result.isError).toBe(true);
  });

  it("no analysis run returns error", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    const result = await callTool(server, "harness_export", { handle });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/harness_run/);
  });

  it("export returns handle exportedAt dtsPath cirPath analysis summary topology steps sizeBytes", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const result = await callTool(server, "harness_export", { handle });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.handle).toBe(handle);
    expect(data.exportedAt).toBeDefined();
    expect(data.dtsPath).toBeDefined();
    expect(data.cirPath).toBeDefined();
    expect(data.analysis).toBe("dcop");
    expect(data.summary).toBeDefined();
    expect(data.topology).toBeDefined();
    expect(data.topology.components).toBeInstanceOf(Array);
    expect(data.topology.nodes).toBeInstanceOf(Array);
    expect(data.steps).toBeInstanceOf(Array);
    expect(data.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  it("toJSON called with includeAllSteps option", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    await callTool(server, "harness_export", { handle, includeAllSteps: true });
    expect(ms.toJSON).toHaveBeenCalledWith(expect.objectContaining({ includeAllSteps: true }));
  });

  it("toJSON called with onlyDivergences option", async () => {
    const ms = makeMockSession();
    (ComparisonSession as any).mockImplementation(() => ms);
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    await callTool(server, "harness_export", { handle, onlyDivergences: true });
    expect(ms.toJSON).toHaveBeenCalledWith(expect.objectContaining({ onlyDivergences: true }));
  });

  it("path option writes file and sets writtenTo field", async () => {
    const { server } = buildServer();
    const handle = await startSession(server);
    await callTool(server, "harness_run", { handle, analysis: "dcop" });
    const tmpPath = "/tmp/harness-export-test.json";
    const result = await callTool(server, "harness_export", { handle, path: tmpPath });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.writtenTo).toBe(tmpPath);
  });
});
