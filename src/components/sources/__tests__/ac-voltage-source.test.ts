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
  makeCapacitor,
  makeVoltageSource,
} from "../../../solver/analog/test-elements.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";

// ---------------------------------------------------------------------------
// Mock solver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  const stamps: Array<{ row: number; col: number; value: number }> = [];
  const rhs: Record<number, number> = {};

  const solver = {
    stamp: vi.fn((row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs[row] = (rhs[row] ?? 0) + value;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
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
  props.set("amplitude", overrides.amplitude ?? 5);
  props.set("frequency", overrides.frequency ?? 1000);
  props.set("phase", overrides.phase ?? 0);
  props.set("dcOffset", overrides.dcOffset ?? 0);
  props.set("waveform", overrides.waveform ?? "sine");

  let simTime = time;
  const getTime = () => simTime;

  const el = AcVoltageSourceDefinition.models!.analog!.factory(
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

function setTime(el: AcVoltageSourceAnalogElement, t: number): void {
  (el as unknown as { _setTime: (t: number) => void })._setTime(t);
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
    el.stamp(solver as unknown as SparseSolver);
    // RHS at branch row 2: V(t=0) = 5 * sin(0) = 0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0, 8));
  });

  it("sine_at_quarter_period", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 0, 2, 0.25e-3);
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
    // RHS at branch row 2: V(t=0.25ms) = 5 * sin(π/2) = 5.0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(5.0, 4));
  });

  it("square_at_half_period", () => {
    // Use t=0.75ms (3/4 period) where sin = -1, firmly in the negative half cycle
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "square" }, 1, 0, 2, 0.75e-3);
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
    // At t=0.75ms: sin(2π*1000*0.75e-3) = sin(3π/2) = -1 → V = -5
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(-5.0, 4));
  });

  it("triangle_linearity", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "triangle" }, 1, 0, 2, 0.125e-3);
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
    // At t=1/8 period: triangle is at half amplitude (rising) = 2.5V
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(2.5, 4));
  });

  it("dc_offset_applied", () => {
    const el = makeAcElement(
      { amplitude: 5, frequency: 1000, waveform: "sine", dcOffset: 2 },
      1, 0, 2, 0,
    );
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
    // At t=0: sin(0)=0, so RHS = 0*scale + 2 = 2.0
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(2.0, 8));
  });

  it("square_wave_breakpoints", () => {
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "square" }, 1, 0, 2, 0);
    const bps = el.getBreakpoints(0, 0.002);
    expect(bps).toHaveLength(3);
    expect(bps[0]).toBeCloseTo(0.0005, 8);
    expect(bps[1]).toBeCloseTo(0.001, 8);
    expect(bps[2]).toBeCloseTo(0.0015, 8);
  });

  it("set_scale_applied", () => {
    // setScale(0.5): at peak (t=0.25ms) V=5V, after scale V=2.5V
    const el = makeAcElement({ amplitude: 5, frequency: 1000, waveform: "sine" }, 1, 0, 2, 0.25e-3);
    el.setSourceScale!(0.5);
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
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
    props.set("amplitude", 5);
    props.set("frequency", 1000);
    props.set("phase", 0);
    props.set("dcOffset", 0);
    props.set("waveform", "sine");

    let simTime = 0;
    const getTime = () => simTime;

    const acSrc = AcVoltageSourceDefinition.models!.analog!.factory(
      new Map([["pos", 1], ["neg", 0]]),
      [],
      2,
      props,
      getTime,
    ) as AcVoltageSourceAnalogElement;

    const r = makeResistor(1, 2, 1000);
    const cap = makeCapacitor(2, 0, 1e-6);

    const circuit: ConcreteCompiledAnalogCircuit = {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements: [acSrc, r, cap],
      labelToNodeId: new Map(),
      wireToNodeId: new Map(),
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
      engine.step(dt);

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
  props.set("amplitude", 5);
  props.set("frequency", 1000);
  props.set("phase", 0);
  props.set("dcOffset", 0);
  props.set("waveform", "expression");
  props.set("expression", exprText);

  let simTime = time;
  const el = AcVoltageSourceDefinition.models!.analog!.factory(
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
    el.stamp(solver as unknown as SparseSolver);
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0, 5));
  });

  it("ramp", () => {
    // "5 * t" at t=0.001 → RHS = 5 * 0.001 = 0.005V
    const el = makeExprElement("5 * t", 0.001);
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);
    expect(solver.stampRHS).toHaveBeenCalledWith(2, expect.closeTo(0.005, 8));
  });

  it("invalid_expression_emits_diagnostic", () => {
    // "sin(" is malformed — should record parse error, not throw
    const el = makeExprElement("sin(");
    expect(el._parsedExpr).toBeNull();
    expect(el._parseError).not.toBeNull();
    expect(typeof el._parseError).toBe("string");
    expect((el._parseError as string).length).toBeGreaterThan(0);

    // stamp should not throw and should produce RHS = 0
    const solver = makeMockSolver();
    expect(() => el.stamp(solver as unknown as SparseSolver)).not.toThrow();
    expect(solver.stampRHS).toHaveBeenCalledWith(2, 0);
  });

  it("expression_parsed_once", () => {
    // _parsedExpr is the same object reference after two stamp calls
    const el = makeExprElement("5 * t", 0);
    const firstRef = el._parsedExpr;

    const solver1 = makeMockSolver();
    el.stamp(solver1 as unknown as SparseSolver);
    const solver2 = makeMockSolver();
    el.stamp(solver2 as unknown as SparseSolver);

    expect(el._parsedExpr).toBe(firstRef);
  });
});
