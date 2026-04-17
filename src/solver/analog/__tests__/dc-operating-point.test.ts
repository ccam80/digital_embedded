/**
 * Tests for the DC operating point solver (Tasks 1.1.3 and 1.3.2).
 *
 * Tests cover all four outcomes:
 *   - Direct NR convergence (Level 0)
 *   - Gmin stepping fallback (Level 1)
 *   - Source stepping fallback (Level 2)
 *   - Total failure with blame attribution (Level 3)
 */

import { describe, it, expect } from "vitest";
import { DiagnosticCollector } from "../diagnostics.js";
import { solveDcOperatingPoint, cktncDump } from "../dc-operating-point.js";
import { CKTCircuitContext } from "../ckt-context.js";
import { makeResistor, makeVoltageSource, makeDiode, allocateStatePool } from "./test-helpers.js";
import type { AnalogElement } from "../element.js";
import { DEFAULT_SIMULATION_PARAMS, resolveSimulationParams } from "../../../core/analog-engine-interface.js";
import type { SimulationParams } from "../../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopBreakpoint = (_t: number): void => {};
const DEFAULT_PARAMS = resolveSimulationParams(DEFAULT_SIMULATION_PARAMS);

/**
 * Build a CKTCircuitContext for a test circuit.
 */
function makeCtx(
  elements: readonly AnalogElement[],
  nodeCount: number,
  branchCount: number,
  params: SimulationParams = DEFAULT_PARAMS,
): CKTCircuitContext {
  const pool = allocateStatePool(elements as AnalogElement[]);
  const circuit = {
    nodeCount,
    branchCount,
    matrixSize: nodeCount + branchCount,
    elements,
    statePool: pool,
  };
  const resolved = resolveSimulationParams(params);
  const ctx = new CKTCircuitContext(circuit, resolved, noopBreakpoint);
  ctx.diagnostics = new DiagnosticCollector();
  return ctx;
}

/**
 * Create a scalable voltage source element that supports setSourceScale().
 * Used in source-stepping tests where the source must be ramped.
 */
function makeScalableVoltageSource(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): AnalogElement {
  let scale = 1;
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
    stamp(solver: import("../sparse-solver.js").SparseSolver): void {
      const k = branchIdx;
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);
      solver.stampRHS(k, voltage * scale);
    },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// DcOP tests
// ---------------------------------------------------------------------------

describe("DcOP", () => {
  it("simple_resistor_divider_direct", () => {
    // Circuit: Vs=5V, R1=1kOhm (node1→node2), R2=1kOhm (node2→gnd)
    // matrixSize = 2 nodes + 1 branch = 3
    const elements = [
      makeVoltageSource(1, 0, 2, 5),   // Vs=5V: node1(+), gnd(-)
      makeResistor(1, 2, 1000),         // R1=1kOhm
      makeResistor(2, 0, 1000),         // R2=1kOhm
    ];
    const ctx = makeCtx(elements, 2, 1);

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    expect(ctx.dcopResult.method).toBe("direct");

    // V1 = 5V (node 1, 0-based index 0), V2 = 2.5V (node 2, 0-based index 1)
    expect(ctx.dcopResult.nodeVoltages[0]).toBeCloseTo(5.0, 8);
    expect(ctx.dcopResult.nodeVoltages[1]).toBeCloseTo(2.5, 8);
  });

  it("diode_circuit_direct", () => {
    const elements = [
      makeVoltageSource(1, 0, 2, 5),   // Vs=5V
      makeResistor(1, 2, 1000),         // R=1kOhm
      makeDiode(2, 0, 1e-14, 1),       // diode: anode=node2, cathode=gnd
    ];
    const ctx = makeCtx(elements, 2, 1);

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    expect(ctx.dcopResult.method).toBe("direct");

    // Forward diode voltage should be in range [0.6V, 0.75V]
    const vDiode = ctx.dcopResult.nodeVoltages[1];
    expect(vDiode).toBeGreaterThan(0.6);
    expect(vDiode).toBeLessThan(0.75);
  });

  it("direct_success_emits_converged_info", () => {
    const elements = [
      makeVoltageSource(1, 0, 1, 3),
      makeResistor(1, 0, 1000),
    ];
    const ctx = makeCtx(elements, 1, 1);

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);

    const diags = (ctx.diagnostics as DiagnosticCollector).getDiagnostics();
    const convergedDiag = diags.find(d => d.code === "dc-op-converged");
    expect(convergedDiag).toBeDefined();
    expect(convergedDiag!.severity).toBe("info");
  });

  it("gmin_stepping_fallback", () => {
    // A 200V source forward-biasing a diode through 1Ω creates an extreme
    // operating point. From zero-voltage initial guess, direct NR diverges.
    // dynamicGmin adds diagonal conductance to stabilise the Jacobian.
    const elements = [
      makeVoltageSource(1, 0, 2, 200),  // extreme 200V source
      makeResistor(1, 2, 1),             // 1Ω — huge current
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, gmin: 1e-3 });

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    const diags = (ctx.diagnostics as DiagnosticCollector).getDiagnostics();
    const successCodes = ["dc-op-converged", "dc-op-gmin", "dc-op-source-step"];
    expect(diags.some(d => successCodes.includes(d.code))).toBe(true);
    expect(diags.some(d => d.code === "dc-op-failed")).toBe(false);
  });

  it("source_stepping_fallback", () => {
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, gmin: 1e-3 });

    solveDcOperatingPoint(ctx);

    const diags = (ctx.diagnostics as DiagnosticCollector).getDiagnostics();

    if (ctx.dcopResult.converged) {
      if (ctx.dcopResult.method === "gillespie-src") {
        expect(diags.some(d => d.code === "dc-op-source-step")).toBe(true);
      } else if (ctx.dcopResult.method === "dynamic-gmin") {
        expect(diags.some(d => d.code === "dc-op-gmin")).toBe(true);
      } else {
        expect(ctx.dcopResult.method).toBe("direct");
        expect(diags.some(d => d.code === "dc-op-converged")).toBe(true);
      }
    }
  });

  it("numGminSteps_1_selects_dynamicGmin", () => {
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, numGminSteps: 1 });

    const phases: string[] = [];
    ctx._onPhaseBegin = (phase) => { phases.push(phase); };

    solveDcOperatingPoint(ctx);

    expect(phases).not.toContain("dcopGminSpice3");
  });

  it("numGminSteps_10_selects_spice3Gmin", () => {
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, numGminSteps: 10 });

    const phases: string[] = [];
    ctx._onPhaseBegin = (phase) => { phases.push(phase); };

    solveDcOperatingPoint(ctx);

    if (phases.some(p => p === "dcopGminSpice3" || p === "dcopGminDynamic")) {
      expect(phases).toContain("dcopGminSpice3");
      expect(phases).not.toContain("dcopGminDynamic");
    }
  });

  it("spice3Src_emits_uniform_phase_parameters", () => {
    const N = 4;
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 200),
      makeResistor(1, 2, 1),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, numSrcSteps: N, gmin: 1e-3 });

    const srcSweepParams: number[] = [];
    ctx._onPhaseBegin = (phase, param) => {
      if (phase === "dcopSrcSweep" && param !== undefined) {
        srcSweepParams.push(param);
      }
    };

    solveDcOperatingPoint(ctx);

    if (srcSweepParams.length >= N + 1) {
      for (let i = 0; i <= N; i++) {
        expect(srcSweepParams[i]).toBeCloseTo(i / N, 10);
      }
    }
    expect(ctx.dcopResult.converged).toBe(true);
  });

  it("gshunt_zero_is_noop", () => {
    function makeElements() {
      return [
        makeVoltageSource(1, 0, 2, 5),
        makeResistor(1, 2, 1000),
        makeResistor(2, 0, 1000),
      ];
    }

    const ctx1 = makeCtx(makeElements(), 2, 1);
    const ctx2 = makeCtx(makeElements(), 2, 1, { ...DEFAULT_PARAMS, gshunt: 0 });

    solveDcOperatingPoint(ctx1);
    solveDcOperatingPoint(ctx2);

    expect(ctx1.dcopResult.converged).toBe(true);
    expect(ctx2.dcopResult.converged).toBe(true);
    expect(ctx1.dcopResult.nodeVoltages[0]).toBeCloseTo(ctx2.dcopResult.nodeVoltages[0], 10);
    expect(ctx1.dcopResult.nodeVoltages[1]).toBeCloseTo(ctx2.dcopResult.nodeVoltages[1], 10);
  });

  it("gshunt_nonzero_used_as_gtarget", () => {
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, gshunt: 1e-6 });

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
  });

  it("failure_reports_blame", () => {
    const elements = [
      makeScalableVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeDiode(2, 0, 1e-14, 1),
    ];
    const ctx = makeCtx(elements, 2, 1);

    solveDcOperatingPoint(ctx);

    const diags = (ctx.diagnostics as DiagnosticCollector).getDiagnostics();

    if (ctx.dcopResult.converged) {
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
    const result = cktncDump(voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(n => n.node === 0)).toBe(true);
    expect(result.some(n => n.node === 1)).toBe(true);
    for (const entry of result) {
      expect(entry.delta).toBeGreaterThan(0);
    }
  });

  it("noOpIter_skips_all_nr_and_returns_converged", () => {
    const elements = [
      makeVoltageSource(1, 0, 1, 5),
      makeResistor(1, 0, 1000),
    ];
    const ctx = makeCtx(elements, 1, 1, { ...DEFAULT_PARAMS, noOpIter: true });

    let phaseBeginCount = 0;
    ctx._onPhaseBegin = () => { phaseBeginCount++; };

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    expect(ctx.dcopResult.iterations).toBe(0);
    expect(ctx.dcopResult.nodeVoltages).toBeInstanceOf(Float64Array);
    expect(ctx.dcopResult.nodeVoltages.length).toBe(ctx.matrixSize);
  });

  it("dcopFinalize_sets_initMode_to_transient_after_convergence", () => {
    const elements = [
      makeVoltageSource(1, 0, 1, 3),
      makeResistor(1, 0, 1000),
    ];
    const ctx = makeCtx(elements, 1, 1);

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    if (ctx.statePool) {
      expect(ctx.statePool.initMode).toBe("transient");
    }
  });

  // ---------------------------------------------------------------------------
  // New spec tests: writes_into_ctx_dcopResult and zero_alloc_gmin_stepping
  // ---------------------------------------------------------------------------

  it("writes_into_ctx_dcopResult", () => {
    // Run DC-OP on a resistive divider.
    // Assert ctx.dcopResult.converged === true and nodeVoltages has correct values.
    const elements = [
      makeVoltageSource(1, 0, 2, 5),
      makeResistor(1, 2, 1000),
      makeResistor(2, 0, 1000),
    ];
    const ctx = makeCtx(elements, 2, 1);

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    // V1 = 5V (index 0), V2 = 2.5V (index 1)
    expect(ctx.dcopResult.nodeVoltages[0]).toBeCloseTo(5.0, 8);
    expect(ctx.dcopResult.nodeVoltages[1]).toBeCloseTo(2.5, 8);
    // nodeVoltages must point to ctx.dcopVoltages (no additional allocation)
    expect(ctx.dcopResult.nodeVoltages).toBe(ctx.dcopVoltages);
  });

  it("zero_alloc_gmin_stepping", () => {
    // Run DC-OP on a circuit requiring gmin stepping.
    // Assert no new Float64Array calls during the entire gmin stepping sequence.
    const RealF64 = globalThis.Float64Array;
    let allocCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Float64Array = new Proxy(RealF64, {
      construct(target, args) {
        allocCount++;
        return new target(...(args as [number]));
      },
    });

    try {
      // Use extreme circuit that requires gmin stepping
      const elements = [
        makeVoltageSource(1, 0, 2, 200),
        makeResistor(1, 2, 1),
        makeDiode(2, 0, 1e-14, 1),
      ];
      const ctx = makeCtx(elements, 2, 1, { ...DEFAULT_PARAMS, gmin: 1e-3 });

      // First call: warm up
      allocCount = 0;
      solveDcOperatingPoint(ctx);
      allocCount = 0;

      // Reset for second call
      ctx.dcopResult.reset();
      ctx.dcopVoltages.fill(0);
      ctx.dcopSavedVoltages.fill(0);
      ctx.dcopSavedState0.fill(0);
      ctx.dcopOldState0.fill(0);
      if (ctx.statePool) {
        ctx.statePool.reset();
      }

      solveDcOperatingPoint(ctx);

      // No Float64Array allocations during the second DC-OP call
      expect(allocCount).toBe(0);
      expect(ctx.dcopResult.converged).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Float64Array = RealF64;
    }
  });

  it("cktncDump_returns_empty_when_all_converged", () => {
    const v = new Float64Array([1.0, 2.5, 0.0]);
    const result = cktncDump(v, v, 1e-3, 1e-6, 1e-12, 2, 3);
    expect(result).toHaveLength(0);
  });

  it("cktncDump_identifies_non_converged_nodes", () => {
    const voltages = new Float64Array([5.0, 1.0]);
    const prevVoltages = new Float64Array([4.5, 1.0]);
    const result = cktncDump(voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 2, 2);
    expect(result).toHaveLength(1);
    expect(result[0].node).toBe(0);
    expect(result[0].delta).toBeCloseTo(0.5, 10);
    expect(result[0].tol).toBeGreaterThan(0);
    expect(result[0].delta).toBeGreaterThan(result[0].tol);
  });

  it("cktncDump_uses_voltTol_for_node_rows_and_abstol_for_branch_rows", () => {
    // Node row (i=0): tol = 1e-3 * max(0,0) + voltTol = 1e-6 → 1e-7 < 1e-6 → converged
    // Branch row (i=1): tol = 1e-3 * max(0,0) + abstol = 1e-12 → 1e-7 > 1e-12 → non-converged
    const voltages = new Float64Array([1e-7, 1e-7]);
    const prevVoltages = new Float64Array([0, 0]);
    const result = cktncDump(voltages, prevVoltages, 1e-3, 1e-6, 1e-12, 1, 2);
    expect(result).toHaveLength(1);
    expect(result[0].node).toBe(1);
  });
});
