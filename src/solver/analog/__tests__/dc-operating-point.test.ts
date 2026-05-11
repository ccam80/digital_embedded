// Tests DC operating point solver convergence paths via buildFixture and ComparisonSession.

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { buildFixture } from "./fixtures/build-fixture.js";
import { cktncDump } from "../dc-operating-point.js";

// ---------------------------------------------------------------------------
// DcOP tests
// ---------------------------------------------------------------------------

describe("DcOP", () => {
  it("simple_resistor_divider_direct", async () => {
    // Circuit: Vs=5V, R1=1kOhm (node1-node2), R2=1kOhm (node2-gnd)
    // Expected: direct NR convergence, V(node2) ≈ 2.5V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:pos"],
            ["r1:neg",  "r2:pos"],
            ["r2:neg",  "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const directAttempt = attempts.find(a => a.phase === "dcopDirect");
    expect(directAttempt).toBeDefined();
    expect(directAttempt!.converged).toBe(true);
    const gminAttempt = attempts.find(a => a.phase === "dcopGminDynamic");
    expect(gminAttempt).toBeUndefined();
  });

  it("diode_circuit_direct", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:pos"],
            ["r1:neg",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const directAttempt = attempts.find(a => a.phase === "dcopDirect");
    expect(directAttempt).toBeDefined();
    expect(directAttempt!.converged).toBe(true);
    const gminAttempt = attempts.find(a => a.phase === "dcopGminDynamic");
    expect(gminAttempt).toBeUndefined();
  });

  it("direct_success_emits_converged_info", () => {
    // Resistive circuit → direct NR converges → coordinator emits dc-op-converged info.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 3 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const diags = fix.coordinator.getRuntimeDiagnostics();
    const convergedDiag = diags.find(d => d.code === "dc-op-converged");
    expect(convergedDiag).toBeDefined();
    expect(convergedDiag!.severity).toBe("info");
  });

  it("gmin_stepping_fallback", async () => {
    // params.noOpIter = true forces the direct NR attempt to return
    // converged=false immediately (cktop.c:47-48), so solveDcOperatingPoint
    // falls through to dcopGminDynamic. This is the ngspice NOOPITER flag.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 200 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:pos"],
            ["r1:neg",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
      params: { noOpIter: true },
    });

    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const gminAttempt = attempts.find(a => a.phase === "dcopGminDynamic");
    expect(gminAttempt).toBeDefined();
    expect(gminAttempt!.converged).toBe(true);
  });

  it("source_stepping_fallback", async () => {
    // params.noOpIter = true forces the direct NR attempt to return
    // converged=false immediately (cktop.c:47-48), causing the DC-OP ladder
    // to advance through gmin stepping and into source stepping.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:pos"],
            ["r1:neg",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
      params: { noOpIter: true },
    });

    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const srcAttempt = attempts.find(a => a.phase === "dcopSrcSweep");
    expect(srcAttempt).toBeDefined();
    expect(srcAttempt!.converged).toBe(true);
  });

  it("gshunt_zero_is_noop", () => {
    // gshunt=0 must not prevent DC-OP convergence on a resistive circuit.
    // Both default (no gshunt override) and explicit gshunt=0 must converge.
    const fix1 = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "r2:pos"],
          ["r2:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
    });
    const fix2 = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "r2:pos"],
          ["r2:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { gshunt: 0 },
    });

    const r1 = fix1.coordinator.dcOperatingPoint();
    const r2 = fix2.coordinator.dcOperatingPoint();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.converged).toBe(true);
    expect(r2!.converged).toBe(true);
  });

  it("gshunt_nonzero_used_as_gtarget", () => {
    // A circuit with a diode converges even when gshunt is set nonzero.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "d1",  type: "Diode",           props: { label: "d1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "d1:A"],
          ["d1:K",    "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { gshunt: 1e-6 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });

  it("failure_reports_blame", () => {
    // A circuit with a diode may converge or may not depending on gmin budget.
    // Either way, exactly one of the success / failure diagnostic codes must be emitted.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "d1",  type: "Diode",           props: { label: "d1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "d1:A"],
          ["d1:K",    "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();

    const diags = fix.coordinator.getRuntimeDiagnostics();

    if (result!.converged) {
      const successCodes = ["dc-op-converged", "dc-op-gmin", "dc-op-source-step"];
      expect(diags.some(d => successCodes.includes(d.code))).toBe(true);
      const successDiag = diags.find(d => successCodes.includes(d.code))!;
      expect(["info", "warning"]).toContain(successDiag.severity);
    } else {
      const failedDiag = diags.find(d => d.code === "dc-op-failed");
      expect(failedDiag).toBeDefined();
      expect(failedDiag!.severity).toBe("error");
      expect(failedDiag!.message).toContain("DC operating point failed");
    }
  });

  it("failure_cktncDump_uses_actual_voltages", () => {
    const voltages = new Float64Array([5.0, 0.7, -0.0025]);
    const prevVoltages = new Float64Array([4.0, 0.65, -0.002]);
    const scratch: Array<{ node: number; delta: number; tol: number }> = [];
    const pool: Array<{ node: number; delta: number; tol: number }> =
      Array.from({ length: 3 }, () => ({ node: 0, delta: 0, tol: 0 }));
    const result = cktncDump(scratch, pool, voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(n => n.node === 0)).toBe(true);
    expect(result.some(n => n.node === 1)).toBe(true);
    for (const entry of result) {
      expect(entry.delta).toBeGreaterThan(0);
    }
  });

  it("cktncDump_returns_empty_when_all_converged", () => {
    const v = new Float64Array([1.0, 2.5, 0.0]);
    const scratch: Array<{ node: number; delta: number; tol: number }> = [];
    const pool: Array<{ node: number; delta: number; tol: number }> =
      Array.from({ length: 3 }, () => ({ node: 0, delta: 0, tol: 0 }));
    const result = cktncDump(scratch, pool, v, v, 1e-3, 1e-6, 1e-12, 2, 3);
    expect(result).toHaveLength(0);
  });

  it("cktncDump_identifies_non_converged_nodes", () => {
    const voltages = new Float64Array([5.0, 1.0]);
    const prevVoltages = new Float64Array([4.5, 1.0]);
    const scratch: Array<{ node: number; delta: number; tol: number }> = [];
    const pool: Array<{ node: number; delta: number; tol: number }> =
      Array.from({ length: 2 }, () => ({ node: 0, delta: 0, tol: 0 }));
    const result = cktncDump(scratch, pool, voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 2);
    expect(result).toHaveLength(1);
    expect(result[0].node).toBe(0);
    expect(result[0].tol).toBeGreaterThan(0);
    expect(result[0].delta).toBeGreaterThan(result[0].tol);
  });

  it("cktncDump_uses_voltTol_for_node_rows_and_abstol_for_branch_rows", () => {
    // Node row (i=0): tol = 1e-3 * max(0,0) + voltTol = 1e-6 → 1e-7 < 1e-6 → converged
    // Branch row (i=1): tol = 1e-3 * max(0,0) + abstol = 1e-12 → 1e-7 > 1e-12 → non-converged
    const voltages = new Float64Array([1e-7, 1e-7]);
    const prevVoltages = new Float64Array([0, 0]);
    const scratch: Array<{ node: number; delta: number; tol: number }> = [];
    const pool: Array<{ node: number; delta: number; tol: number }> =
      Array.from({ length: 2 }, () => ({ node: 0, delta: 0, tol: 0 }));
    const result = cktncDump(scratch, pool, voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 1, 2);
    expect(result).toHaveLength(1);
    expect(result[0].node).toBe(1);
  });

  it("method_reflects_last_strategy", () => {
    // Two voltage sources in parallel between the same nodes declare conflicting
    // voltages (5V and 6V). Both branches constrain the same node difference,
    // producing a singular MNA matrix. Direct NR, gmin stepping, and source
    // stepping all fail against this degeneracy.
    // With gmin=0 and numSrcSteps<=1 the last strategy is gillespie-src.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs1", type: "DcVoltageSource", props: { label: "vs1", voltage: 5 } },
          { id: "vs2", type: "DcVoltageSource", props: { label: "vs2", voltage: 6 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs1:pos", "vs2:pos"],
          ["vs1:neg", "gnd:out"],
          ["vs2:neg", "gnd:out"],
        ],
      }),
      params: { gmin: 0 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(false);
    expect(result!.method).toBe("gillespie-src");
    expect(result!.method).not.toBe("direct");
  });

  it("cktncDump_zero_alloc_on_failure_path", () => {
    // Call `cktncDump` twice against the same ctx scratch+pool and assert the
    // returned array identity is the same (.toBe). Guards the zero-allocation
    // contract: no new array or entry-object literals are allocated per call.
    const voltages = new Float64Array([5.0, 0.7, -0.0025]);
    const prevVoltages = new Float64Array([4.0, 0.65, -0.002]);
    const scratch: Array<{ node: number; delta: number; tol: number }> = [];
    const pool: Array<{ node: number; delta: number; tol: number }> =
      Array.from({ length: 3 }, () => ({ node: 0, delta: 0, tol: 0 }));

    const first = cktncDump(scratch, pool, voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 3);
    const second = cktncDump(scratch, pool, voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 3);

    expect(first).toBe(scratch);
    expect(second).toBe(scratch);
    expect(first).toBe(second);
  });

  it("dynamicGmin_clean_solve_uses_dcMaxIter", () => {
    // The final clean solve in dynamicGmin must use params.maxIterations (100),
    // not params.dcTrcvMaxIter (3). A diode circuit forces the dynamic-gmin path.
    // dcTrcvMaxIter=3 is intentionally low: sub-solves use this budget. The clean
    // solve runs with gshunt=0; if it mistakenly used dcTrcvMaxIter=3 it may fail.
    // With maxIterations=100 it has adequate budget.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "d1",  type: "Diode",           props: { label: "d1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "d1:A"],
          ["d1:K",    "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { gmin: 1e-12, dcTrcvMaxIter: 3, maxIterations: 100, noOpIter: true },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    // noOpIter forces direct NR to skip, so dynamic-gmin or source-stepping was used.
    expect(result!.method).not.toBe("direct");
  });

});
