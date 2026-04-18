/**
 * Tests for the AC Voltage Source component.
 *
 * Covers waveform computation, DC offset, source scaling, breakpoints,
 * and an RC low-pass filter integration test.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AcVoltageSourceDefinition,
  computeWaveformValue,
  squareWaveBreakpoints,
  type AcVoltageSourceAnalogElement,
} from "../ac-voltage-source.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import {
  makeResistor,
  createTestCapacitor,
  allocateStatePool,
} from "../../../solver/analog/__tests__/test-helpers.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Mock solver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  const stamps: [number, number, number][] = [];
  const rhs: Record<number, number> = {};

  const solver = {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs[row] = (rhs[row] ?? 0) + value;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
}

function makeMinimalCtx(solver: unknown, time = 0, srcFact = 1) {
  return {
    solver: solver as SparseSolver,
    voltages: new Float64Array(4),
    iteration: 0,
    initMode: "initFloat" as const,
    dt: 0,
    method: "trapezoidal" as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(8),
    srcFact,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: true,
    isTransient: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

// ---------------------------------------------------------------------------
// Helper — create AC source AnalogElement from props
// ---------------------------------------------------------------------------

function makeAcElement(
  overrides: {
    amplitude?: number;
    frequency?: number;
    phase?: number;
    dcOffset?: number;
    waveform?: string;
  },
  nodePos = 1,
  nodeNeg = 0,
  branchIdx = 2,
  time = 0,
): AcVoltageSourceAnalogElement {
  const props = new PropertyBag();
  props.setModelParam("amplitude", overrides.amplitude ?? 5);
  props.setModelParam("frequency", overrides.frequency ?? 1000);
  props.setModelParam("phase", overrides.phase ?? 0);
  props.setModelParam("dcOffset", overrides.dcOffset ?? 0);
  props.set("waveform", overrides.waveform ?? "sine");

  let simTime = time;
  const getTime = () => simTime;

  const el = getFactory(AcVoltageSourceDefinition.modelRegistry!.behavioral!)(
    new Map([["pos", nodePos], ["neg", nodeNeg]]),
    [],
    branchIdx,
    props,
    getTime,
  ) as AcVoltageSourceAnalogElement;

  // Expose a way to advance time for tests that call stamp at different times
  (el as unknown as { _setTime: (t: number) => void })._setTime = (t: number) => {
    simTime = t;
  };

  return el;
}

// ---------------------------------------------------------------------------
// Unit tests — waveform computation (pure function)
// ---------------------------------------------------------------------------

describe("computeWaveformValue", () => {
  it("sine at t=0 is zero (phase=0)", () => {
    expect(computeWaveformValue("sine", 5, 1000, 0, 0, 0)).toBeCloseTo(0, 10);
  });

  it("sine at quarter period equals amplitude", () => {
    const t = 0.25e-3; // 0.25ms = quarter period of 1kHz
    expect(computeWaveformValue("sine", 5, 1000, 0, 0, t)).toBeCloseTo(5.0, 5);
  });

  it("square at three-quarter period is negative amplitude", () => {
    const t = 0.75e-3; // 0.75ms = 3/4 period, sin = -1
    expect(computeWaveformValue("square", 5, 1000, 0, 0, t)).toBeCloseTo(-5.0, 5);
  });

  it("triangle at 1/8 period is half amplitude (rising)", () => {
    const t = 0.125e-3; // 1/8 period of 1kHz
    expect(computeWaveformValue("triangle", 5, 1000, 0, 0, t)).toBeCloseTo(2.5, 4);
  });

  it("dc offset is additive to sine", () => {
    const t = 0; // sin(0)=0, so result = dcOffset
    expect(computeWaveformValue("sine", 5, 1000, 0, 2, t)).toBeCloseTo(2.0, 10);
  });
});

// ---------------------------------------------------------------------------
// squareWaveBreakpoints
// ---------------------------------------------------------------------------

describe("squareWaveBreakpoints", () => {
  it("1kHz square wave has breakpoints at 0.5ms, 1ms, 1.5ms in [0, 2ms]", () => {
    const bps = squareWaveBreakpoints(1000, 0, 0, 0.002);
    expect(bps).toHaveLength(3);
    expect(bps[0]).toBeCloseTo(0.0005, 8);
    expect(bps[1]).toBeCloseTo(0.001, 8);
    expect(bps[2]).toBeCloseTo(0.0015, 8);
  });

  it("returns empty array for non-positive frequency", () => {
    expect(squareWaveBreakpoints(0, 0, 0, 1)).toHaveLength(0);
    expect(squareWaveBreakpoints(-1, 0, 0, 1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AcSource — stamp tests via MNA mock
// ---------------------------------------------------------------------------

describe("AcSource", () => {
  it("sine_at_t_zero", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 0, 2, 0);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    // RHS at branch row 2: V(t=0) = 5 * sin(0) = 0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0, 8));
  });

  it("sine_at_quarter_period", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 0, 2, 0.25e-3);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    // RHS at branch row 2: V(t=0.25ms) = 5 * sin(π/2) = 5.0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(5.0, 4));
  });

  it("square_at_half_period", () => {
    // Use t=0.75ms (3/4 period) where sin = -1, firmly in the negative half cycle
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "square" }, 1, 0, 2, 0.75e-3);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    // At t=0.75ms: sin(2π*1000*0.75e-3) = sin(3π/2) = -1 → V = -5
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(-5.0, 4));
  });

  it("triangle_linearity", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "triangle" }, 1, 0, 2, 0.125e-3);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    // At t=1/8 period: triangle is at half amplitude (rising) = 2.5V
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(2.5, 4));
  });

  it("dc_offset_applied", () => {
    const el = makeAcElement(
      { amplitude: 5, frequency: 1000, waveform: "sine", dcOffset: 2 },
      1, 0, 2, 0,
    );
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    // At t=0: sin(0)=0, so RHS = 0*scale + 2 = 2.0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(2.0, 8));
  });

  it("square_wave_breakpoints", () => {
    // ngspice PULSE convention: default riseTime=fallTime=1ns (from AC_VOLTAGE_SOURCE_DEFAULTS).
    // For 1kHz, period=1ms, halfPeriod=0.5ms.
    // Breakpoints per period at offsets: [0, TR=1ns, halfPeriod=0.5ms, halfPeriod+TF=0.5ms+1ns].
    // In (0, 0.002) exclusive:
    //   Period 0 (t=0): t=0 excluded, 1ns, 0.5ms, 0.5ms+1ns
    //   Period 1 (t=1ms): 1ms, 1ms+1ns, 1.5ms, 1.5ms+1ns
    //   Period 2 (t=2ms): all >= 2ms excluded
    // Total: 7 breakpoints.
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "square" }, 1, 0, 2, 0);
    const bps = el.getBreakpoints(0, 0.002);
    expect(bps).toHaveLength(7);
    expect(bps[0]).toBeCloseTo(1e-9,          12); // end of first rising edge
    expect(bps[1]).toBeCloseTo(0.0005,         12); // start of falling edge
    expect(bps[2]).toBeCloseTo(0.0005 + 1e-9,  12); // end of falling edge
    expect(bps[3]).toBeCloseTo(0.001,           12); // start of next rising edge
    expect(bps[4]).toBeCloseTo(0.001  + 1e-9,  12); // end of next rising edge
    expect(bps[5]).toBeCloseTo(0.0015,          12); // start of next falling edge
    expect(bps[6]).toBeCloseTo(0.0015 + 1e-9,  12); // end of next falling edge
  });

  it("set_scale_applied", () => {
    // setScale(0.5): at peak (t=0.25ms) V=5V, after scale V=2.5V
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 0, 2, 0.25e-3);
    el.setSourceScale!(0.5);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(2.5, 4));
  });
});

// ---------------------------------------------------------------------------
// Integration test — RC low-pass filter
//
// 1kHz sine (5V) → 1kΩ → 1µF → ground
// Expected capacitor voltage amplitude:
//   Vout = Vin / sqrt(1 + (2π * f * R * C)²)
//        = 5 / sqrt(1 + (2π * 1000 * 1e3 * 1e-6)²)
//        ≈ 5 / sqrt(1 + 39.48) ≈ 0.786V
// We allow ±10% for transient settling.
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("rc_lowpass", () => {
    // Build circuit using test-elements: AC source + R + C
    // Nodes: node1=Vs+ (1), node2=mid RC (2), gnd=0
    // Elements: AcSource(1,0,branch=2), R=1kΩ(1,2), C=1µF(2,0)

    const props = new PropertyBag();
    props.setModelParam("amplitude", 5);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", 0);
    props.setModelParam("dcOffset", 0);
    props.set("waveform", "sine");

    let simTime = 0;
    const getTime = () => simTime;

    const acSrc = getFactory(AcVoltageSourceDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 0]]),
      [],
      2,
      props,
      getTime,
    ) as AcVoltageSourceAnalogElement;

    const r = makeResistor(1, 2, 1000);
    const cap = createTestCapacitor(1e-6, 2, 0);

    const acElements = [acSrc as unknown as import("../../../solver/analog/element.js").AnalogElement, r, cap];
    const acStatePool = allocateStatePool(acElements);

    const circuit: ConcreteCompiledAnalogCircuit = {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements: acElements,
      labelToNodeId: new Map(),
      statePool: acStatePool,
    };

    const engine = new MNAEngine();
    engine.init(circuit);

    // Run transient for 10 periods at 1kHz (10ms), dt=5µs per step
    const period = 1e-3;
    const dt = 5e-6;
    const totalTime = 10 * period;
    const steps = Math.round(totalTime / dt);

    // Track peak capacitor voltage in the last 5 periods (after settling)
    let peakVcap = 0;
    const settleTime = 5 * period;

    for (let i = 0; i < steps; i++) {
      simTime = (i + 1) * dt;
      engine.step();

      if (simTime > settleTime) {
        const vcap = Math.abs(engine.getNodeVoltage(2)); // node2 = MNA node ID 2
        if (vcap > peakVcap) peakVcap = vcap;
      }
    }

    // Expected: 5 / sqrt(1 + 39.48) ≈ 0.786V, allow ±10%
    const expectedAmplitude = 5 / Math.sqrt(1 + Math.pow(2 * Math.PI * 1000 * 1e3 * 1e-6, 2));
    expect(peakVcap).toBeGreaterThan(expectedAmplitude * 0.9);
    expect(peakVcap).toBeLessThan(expectedAmplitude * 1.1);
  });
});

// ---------------------------------------------------------------------------
// ExprWaveform tests (Task 2.6.2)
// ---------------------------------------------------------------------------

function makeExprElement(
  exprText: string,
  time = 0,
): AcVoltageSourceAnalogElement {
  const props = new PropertyBag();
  props.setModelParam("amplitude", 5);
  props.setModelParam("frequency", 1000);
  props.setModelParam("phase", 0);
  props.setModelParam("dcOffset", 0);
  props.set("waveform", "expression");
  props.set("expression", exprText);

  let simTime = time;
  const el = getFactory(AcVoltageSourceDefinition.modelRegistry!.behavioral!)(
    new Map([["pos", 1], ["neg", 0]]),
    [],
    2,
    props,
    () => simTime,
  ) as AcVoltageSourceAnalogElement;

  (el as unknown as { _setTime: (t: number) => void })._setTime = (t: number) => {
    simTime = t;
  };

  return el;
}

describe("ExprWaveform", () => {
  it("custom_sine", () => {
    // "3 * sin(2 * pi * 500 * t)" at t=0.001 (half period of 500Hz = 1ms)
    // sin(2π * 500 * 0.001) = sin(2π * 0.5) = sin(π) ≈ 0
    const el = makeExprElement("3 * sin(2 * pi * 500 * t)", 0.001);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0, 5));
  });

  it("ramp", () => {
    // "5 * t" at t=0.001 → RHS = 5 * 0.001 = 0.005V
    const el = makeExprElement("5 * t", 0.001);
    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0.005, 8));
  });

  it("invalid_expression_emits_diagnostic", () => {
    // "sin(" is malformed — should record parse error, not throw
    const el = makeExprElement("sin(");
    expect(el._parsedExpr).toBeNull();
    expect(el._parseError).not.toBeNull();
    expect(typeof el._parseError).toBe("string");
    expect((el._parseError as string).length).toBeGreaterThan(0);

    // load should not throw and should produce RHS = 0
    const solver = makeMockSolver();
    expect(() => el.load(makeMinimalCtx(solver))).not.toThrow();
    expect(solver.stampRHS).toHaveBeenCalledWith(2, 0);
  });

  it("expression_parsed_once", () => {
    // _parsedExpr is the same object reference after two load calls
    const el = makeExprElement("5 * t", 0);
    const firstRef = el._parsedExpr;

    const solver1 = makeMockSolver();
    el.load(makeMinimalCtx(solver1));
    const solver2 = makeMockSolver();
    el.load(makeMinimalCtx(solver2));

    expect(el._parsedExpr).toBe(firstRef);
  });
});

// ===========================================================================
// Task C4.4 — AC voltage source srcFact + breakpoint parity
//
// ngspice reference: cktload.c:96-136 + VSRCload. The AC voltage source
// multiplies its computed waveform value by CKTsrcFact before stamping.
// Breakpoints derived from ngspice PULSE schedule (offsets 0, TR, halfPeriod,
// halfPeriod+TF) must match squareWaveBreakpoints output bit-exact.
// ===========================================================================

describe("ac_vsource_load_srcfact_parity", () => {
  it("sine_srcfact_05_halves_rhs_bit_exact", () => {
    const AMPLITUDE = 5;
    const FREQUENCY = 1000;
    const T = 0.25e-3; // quarter period → sin(π/2) = 1 → nominal V = 5
    const SRC_FACT = 0.5;

    const el = makeAcElement({ amplitude: AMPLITUDE, frequency: FREQUENCY, waveform: "sine" }, 1, 0, 2, T);
    const solver = makeMockSolver();

    const ctx = {
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: SRC_FACT,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    el.load(ctx);

    // NGSPICE_REF: V(t=0.25ms) * srcFact = amplitude * sin(2π*1000*0.25e-3) * 0.5.
    const NGSPICE_REF =
      (0 + AMPLITUDE * Math.sin(2 * Math.PI * FREQUENCY * T + 0)) * SRC_FACT;
    expect(solver.stampRHS).toHaveBeenCalledWith(2, NGSPICE_REF);
  });

  it("square_srcfact_025_scales_rhs_bit_exact_at_negative_half", () => {
    const AMPLITUDE = 5;
    const FREQUENCY = 1000;
    const T = 0.75e-3; // 3/4 period of 1kHz, sin = -1 → square = -amplitude
    const SRC_FACT = 0.25;

    const el = makeAcElement({ amplitude: AMPLITUDE, frequency: FREQUENCY, waveform: "square" }, 1, 0, 2, T);
    const solver = makeMockSolver();

    const ctx = {
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: SRC_FACT,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    el.load(ctx);

    // NGSPICE_REF: square waveform with default riseTime/fallTime = 1ns (AC_VOLTAGE_SOURCE_DEFAULTS).
    // At t=0.75ms (well past halfPeriod + fallTime of 0.5ms+1ns), we are firmly in the
    // "low" half of the wave → value = -amplitude. Result after srcFact = -amplitude * srcFact.
    const NGSPICE_REF =
      computeWaveformValue("square", AMPLITUDE, FREQUENCY, 0, 0, T) * SRC_FACT;
    expect(solver.stampRHS).toHaveBeenCalledWith(2, NGSPICE_REF);
    expect(NGSPICE_REF).toBe(-AMPLITUDE * SRC_FACT);
  });

  it("srcfact_0_zeroes_rhs_but_leaves_incidence", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 2, 3, 0.25e-3);
    const solver = makeMockSolver();

    const ctx = {
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(4),
      iteration: 0,
      initMode: "initJct" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: 0,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    el.load(ctx);

    // NGSPICE_REF at srcFact=0 → RHS entry exactly 0 (independent of waveform value).
    expect(solver.stampRHS).toHaveBeenCalledWith(3, 0);
    // Incidence stamps must remain (±1 at four positions).
    const stamps = solver._stamps;
    expect(stamps.some(([r, c, v]) => r === 0 && c === 3 && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 1 && c === 3 && v === -1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 3 && c === 0 && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 3 && c === 1 && v === -1)).toBe(true);
  });
});

describe("ac_vsource_breakpoints_parity", () => {
  it("square_1khz_breakpoints_exact_array_match", () => {
    // ngspice PULSE breakpoint schedule per period (offset within period):
    //   0, riseTime, halfPeriod, halfPeriod + fallTime
    // Defaults: riseTime = fallTime = 1e-9 (from AC_VOLTAGE_SOURCE_DEFAULTS).
    // For 1 kHz over (0, 2 ms) exclusive, seven breakpoints per existing
    // square_wave_breakpoints test. The bit-exact array:
    const FREQUENCY = 1000;
    const RT = 1e-9;
    const FT = 1e-9;
    const halfPeriod = 1 / (2 * FREQUENCY);

    // NGSPICE_REF: direct inline computation of each expected time.
    const NGSPICE_REF: number[] = [
      0 + RT,                       // 1ns
      0 + halfPeriod,               // 0.5ms
      0 + halfPeriod + FT,          // 0.5ms + 1ns
      1 * (1 / FREQUENCY) + 0,      // 1ms
      1 * (1 / FREQUENCY) + RT,     // 1ms + 1ns
      1 * (1 / FREQUENCY) + halfPeriod, // 1.5ms
      1 * (1 / FREQUENCY) + halfPeriod + FT, // 1.5ms + 1ns
    ];

    const el = makeAcElement({ amplitude: 5, frequency: FREQUENCY, waveform: "square" }, 1, 0, 2, 0);
    const bps = el.getBreakpoints(0, 0.002);

    // Exact array equality (same length, same element-wise IEEE-754 values).
    expect(bps).toHaveLength(NGSPICE_REF.length);
    for (let i = 0; i < NGSPICE_REF.length; i++) {
      expect(bps[i]).toBe(NGSPICE_REF[i]);
    }
  });

  it("squareWaveBreakpoints_helper_matches_inline_ngspice_schedule", () => {
    // Parity against the factored helper (source of truth for the element).
    const RT = 0, FT = 0;
    const period = 1 / 1000;
    const halfPeriod = period / 2;
    const NGSPICE_REF = [halfPeriod, period, period + halfPeriod];
    const helper = squareWaveBreakpoints(1000, 0, 0, 0.002, RT, FT);
    expect(helper).toHaveLength(NGSPICE_REF.length);
    for (let i = 0; i < NGSPICE_REF.length; i++) {
      expect(helper[i]).toBe(NGSPICE_REF[i]);
    }
  });
});
