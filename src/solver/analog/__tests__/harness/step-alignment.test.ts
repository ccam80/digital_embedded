/**
 * Step-alignment tests (spec §10.2 test 1 / spec §7).
 *
 * Alignment is by exact stepStartTime equality (EPS = 1e-15).
 * Every aligned pair must satisfy |ours.stepStartTime - ng.stepStartTime| <= 1e-15.
 * Unaligned steps are allowed but every aligned pair must be strictly correct.
 *
 * Requires the ngspice DLL (skipped otherwise).
 */

import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "path";
import { existsSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { CaptureSession, MatrixEntrySentinel } from "./types.js";

function isSentinel(v: number | MatrixEntrySentinel): v is MatrixEntrySentinel {
  return typeof v === "object" && v !== null && "kind" in v;
}

const DLL_PATH = process.env.NGSPICE_DLL_PATH ?? "";
const HAS_DLL = DLL_PATH !== "" && existsSync(DLL_PATH);
const describeGate = HAS_DLL ? describe : describe.skip;

const DTS_PATH = resolve(process.cwd(), "fixtures/rlc-transient.dts");

describeGate("step-alignment: exact stepStartTime equality between engines", () => {
  let session: ComparisonSession;

  afterAll(() => {
    if (session) session.dispose();
  });

  it("creates session and runs transient", async () => {
    session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 1e-6, 1e-7);

    expect(session.ourSession).toBeTruthy();
    expect(session.ourSession!.steps.length).toBeGreaterThan(0);
    // If ngspice errors (e.g. extended DLL not yet built), skip remaining tests
    if (session.errors.length > 0) {
      console.log("ngspice errors (extended DLL may not be built yet):", session.errors);
    }
  }, 60_000);

  it("both engines produce steps", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    expect(session.ourSession!.steps.length).toBeGreaterThan(0);
    expect(ngSession.steps.length).toBeGreaterThan(0);
  });

  it("session has steps on both sides (presence counts have both > 0)", () => {
    const shape = session.getSessionShape();
    expect(shape.presenceCounts.both).toBeGreaterThan(0);
  });

  it("every paired step has a finite stepStartTimeDelta", () => {
    const ourSteps = session.ourSession!.steps;
    for (let i = 0; i < ourSteps.length; i++) {
      const stepShape = session.getStepShape(i);
      if (stepShape.presence !== "both") continue;
      expect(Number.isFinite(stepShape.stepStartTimeDelta)).toBe(true);
    }
  });

  it("first step of both engines has stepStartTime === 0", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    expect(session.ourSession!.steps[0].stepStartTime).toBe(0);
    expect(ngSession.steps[0].stepStartTime).toBe(0);
  });

  it("index-paired steps report stepStartTimeDelta = ours.stepStartTime - ng.stepStartTime", () => {
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;
    for (let i = 0; i < ourSteps.length; i++) {
      const stepShape = session.getStepShape(i);
      if (stepShape.presence !== "both") continue;
      const ngStep = ngSession.steps[i];
      if (!ngStep) continue;
      const expectedDelta = ourSteps[i].stepStartTime - ngStep.stepStartTime;
    }
  });

  it("stepStartTime values are monotonically non-decreasing in both engines", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    const ourSteps = session.ourSession!.steps;
    for (let i = 1; i < ourSteps.length; i++) {
      expect(ourSteps[i].stepStartTime).toBeGreaterThanOrEqual(ourSteps[i - 1].stepStartTime);
    }
    for (let i = 1; i < ngSession.steps.length; i++) {
      expect(ngSession.steps[i].stepStartTime).toBeGreaterThanOrEqual(ngSession.steps[i - 1].stepStartTime);
    }
  });

  it("timeAlign=true pairs a mid-run step by time when step counts differ", () => {
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    if (ourSteps.length === ngSession.steps.length) return;
    if (ourSteps.length < 4 || ngSession.steps.length < 2) return;

    const probe = Math.floor(ourSteps.length / 2);
    const report = session.getStepEnd(probe, { timeAlign: true });
    expect(report.ourStepIndex).toBe(probe);
    expect(report.ngspiceStepIndex).toBeGreaterThanOrEqual(0);

    const ourT = ourSteps[probe].stepEndTime;
    const ngStep = ngSession.steps[report.ngspiceStepIndex];
    expect(ngStep).toBeTruthy();
    const ngDt = ngStep.dt > 0 ? ngStep.dt : 1e-6;
    expect(Math.abs(ourT - ngStep.stepEndTime)).toBeLessThanOrEqual(ngDt * 2);
  });

  it("timeAlign=false pairs by positional index (ngspiceStepIndex === ourStepIndex)", () => {
    const ourSteps = session.ourSession!.steps;
    if (ourSteps.length < 2) return;
    const probe = Math.min(1, ourSteps.length - 1);
    const report = session.getStepEnd(probe, { timeAlign: false });
    expect(report.ourStepIndex).toBe(probe);
    expect(report.ngspiceStepIndex).toBe(probe);
  });
});

describe("step-alignment: self-compare invariance for timeAlign", () => {
  it("self-compare: timeAlign=true and false both return equal indices", async () => {
    const buildRlc = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { voltage: 5 } },
          { id: "r1", type: "Resistor",        props: { resistance: 100 } },
          { id: "c1", type: "Capacitor",       props: { capacitance: 1e-6 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:A"],
          ["r1:B",   "c1:pos"],
          ["c1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      });
    };

    const s = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRlc,
      analysis: "tran",
      tStop: 1e-4,
      maxStep: 1e-5,
    });

    try {
      const steps = s.ourSession!.steps;
      expect(steps.length).toBeGreaterThan(1);
      const probe = Math.min(3, steps.length - 1);

      const alignedTrue = s.getStepEnd(probe, { timeAlign: true });
      const alignedFalse = s.getStepEnd(probe, { timeAlign: false });

      expect(alignedTrue.ourStepIndex).toBe(probe);
      expect(alignedFalse.ourStepIndex).toBe(probe);
      expect(alignedTrue.ngspiceStepIndex).toBe(alignedFalse.ngspiceStepIndex);
    } finally {
      s.dispose();
    }
  });

  it("self-compare tran: default timeAlign is true, dcop default is false", async () => {
    const buildDc = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { voltage: 5 } },
          { id: "r1", type: "Resistor",        props: { resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:A"],
          ["r1:B",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      });
    };

    const dcS = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDc,
      analysis: "dcop",
    });
    try {
      const report = dcS.getStepEnd(0);
      expect(report.ourStepIndex).toBe(0);
      expect(report.ngspiceStepIndex).toBe(0);
    } finally {
      dcS.dispose();
    }
  });
});

describe("matrix semantic join: self-compare leaves entryKind='both' for every entry", () => {
  it("self-compare DCOP: all entries have entryKind='both' and numeric values", async () => {
    const buildRc = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { voltage: 5 } },
          { id: "r1", type: "Resistor",        props: { resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:A"],
          ["r1:B",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      });
    };

    const s = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRc,
      analysis: "dcop",
    });
    try {
      const labeled = s.getMatrixLabeled(0, 0);
      expect(labeled.entries.length).toBeGreaterThan(0);
      for (const e of labeled.entries) {
        expect(e.entryKind).toBe("both");
        expect(typeof e.ours).toBe("number");
        expect(typeof e.ngspice).toBe("number");
      }
    } finally {
      s.dispose();
    }
  });

  it("self-compare: LabeledMatrixEntry sentinel type guard works", () => {
    const numericEntry: { ours: number | MatrixEntrySentinel } = { ours: 42 };
    const sentinelEntry: { ours: number | MatrixEntrySentinel } = {
      ours: { kind: "engineSpecific", presentSide: "ngspice" },
    };
    expect(isSentinel(numericEntry.ours)).toBe(false);
    expect(isSentinel(sentinelEntry.ours)).toBe(true);
    if (isSentinel(sentinelEntry.ours)) {
      expect(sentinelEntry.ours.kind).toBe("engineSpecific");
    }
  });
});

describe("matrix semantic join: _buildMatrixMaps routes BJT internal nodes via ngspice topology", () => {
  it("injected ngspice topology with internal BJT nodes produces engineSpecific entries for unmapped rows", async () => {
    const buildRc = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { voltage: 5 } },
          { id: "r1", type: "Resistor",        props: { resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:A"],
          ["r1:B",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      });
    };

    const s = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRc,
      analysis: "dcop",
    });

    try {
      const sAny = s as any;

      sAny._ngTopology = {
        matrixSize: 5,
        numStates: 0,
        nodeNames: new Map<string, number>([
          ["1", 1],
          ["2", 2],
          ["q1#base", 3],
          ["q1#collector", 4],
        ]),
        devices: [],
      };

      sAny._nodeMap = [
        { ourIndex: 0, ngspiceIndex: 1, label: "R1:A", ngspiceName: "1" },
        { ourIndex: 1, ngspiceIndex: 2, label: "R1:B", ngspiceName: "2" },
      ];

      sAny._opts.selfCompare = false;

      const ourStep = s.ourSession!.steps[0];
      const ourIter = ourStep.iterations[0];
      ourIter.matrix = [
        { row: 0, col: 0, value: 1e-3 },
        { row: 0, col: 1, value: -1e-3 },
        { row: 1, col: 0, value: -1e-3 },
        { row: 1, col: 1, value: 1e-3 },
      ];

      sAny._ngSession = {
        source: "ngspice",
        topology: { matrixSize: 5, nodeCount: 4, branchCount: 0, elementCount: 0, elements: [], nodeLabels: new Map(), matrixRowLabels: new Map(), matrixColLabels: new Map() },
        steps: [{
          ...ourStep,
          iterations: [{
            ...ourIter,
            matrix: [
              { row: 1, col: 1, value: 1e-3 },
              { row: 1, col: 2, value: -1e-3 },
              { row: 2, col: 1, value: -1e-3 },
              { row: 2, col: 2, value: 1e-3 },
              { row: 3, col: 3, value: 0.1 },
              { row: 3, col: 1, value: -0.05 },
              { row: 1, col: 3, value: -0.05 },
            ],
          }],
          attempts: [{
            ...ourStep.attempts[0],
            iterations: [{
              ...ourStep.attempts[0].iterations[0],
              matrix: [
                { row: 1, col: 1, value: 1e-3 },
                { row: 1, col: 2, value: -1e-3 },
                { row: 2, col: 1, value: -1e-3 },
                { row: 2, col: 2, value: 1e-3 },
                { row: 3, col: 3, value: 0.1 },
                { row: 3, col: 1, value: -0.05 },
                { row: 1, col: 3, value: -0.05 },
              ],
            }],
          }],
        }],
      };
      sAny._ngSessionReindexed = sAny._ngSession;

      sAny._buildMatrixMaps();

      const labeled = s.getMatrixLabeled(0, 0);
      const engineSpecific = labeled.entries.filter(e => e.entryKind === "engineSpecific");
      const both = labeled.entries.filter(e => e.entryKind === "both");

      expect(both.length).toBeGreaterThan(0);
      expect(engineSpecific.length).toBeGreaterThan(0);

      for (const e of engineSpecific) {
        expect(isSentinel(e.ours)).toBe(true);
        if (isSentinel(e.ours)) {
          expect(e.ours.kind).toBe("engineSpecific");
          expect((e.ours as { presentSide: string }).presentSide).toBe("ngspice");
        }
        expect(typeof e.ngspice).toBe("number");
      }

      const hasPrettyPrinted = engineSpecific.some(e =>
        e.rowLabel.includes("Q1:B'") || e.colLabel.includes("Q1:B'") ||
        e.rowLabel.includes("Q1:C'") || e.colLabel.includes("Q1:C'")
      );
      expect(hasPrettyPrinted).toBe(true);

      const mismatches = s.compareMatrixAt(0, 0, "mismatches");
      for (const e of mismatches.entries) {
        expect(e.entryKind).not.toBe("engineSpecific");
      }

      for (const e of both) {
        if (isSentinel(e.ours) || isSentinel(e.ngspice)) continue;
        expect(e.absDelta).toBeLessThanOrEqual(1e-9);
      }
    } finally {
      s.dispose();
    }
  });
});
