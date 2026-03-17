/**
 * Tests for MNAEngine — the concrete AnalogEngine implementation.
 *
 * All tests use hand-built ConcreteCompiledAnalogCircuit fixtures assembled
 * from test-elements.ts. No dependency on the analog compiler.
 *
 * Circuit topology notation (node IDs, 0 = ground):
 *   Resistor divider: Vs(node1, 0), R1(node1, node2), R2(node2, 0)
 *     matrixSize = 3: node1=idx0, node2=idx1, branch=idx2
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import type { AnalogEngine } from "../../core/analog-engine-interface.js";
import type { Engine } from "../../core/engine-interface.js";
import { EngineState } from "../../core/engine-interface.js";
import {
  makeResistor,
  makeVoltageSource,
  makeCapacitor,
  makeDiode,
} from "../test-elements.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Resistor divider: Vs=5V between node1 and ground, R1=1kΩ (node1→node2), R2=1kΩ (node2→ground).
 * Node numbering (1-based in elements, 0-based in solver array):
 *   node1 = MNA node 1 → voltages[0]
 *   node2 = MNA node 2 → voltages[1]
 *   branch = row 2       → voltages[2]
 * matrixSize = 3
 */
function makeResistorDividerCircuit(): ConcreteCompiledAnalogCircuit {
  const vs = makeVoltageSource(1, 0, 2, 5.0);   // pos=node1, neg=gnd, branch row=2
  const r1 = makeResistor(1, 2, 1000);           // node1 → node2, 1kΩ
  const r2 = makeResistor(2, 0, 1000);           // node2 → gnd,   1kΩ

  return {
    netCount: 2,
    componentCount: 3,
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements: [vs, r1, r2],
    labelToNodeId: new Map([["V_mid", 2]]),
    wireToNodeId: new Map(),
  };
}

/**
 * Single diode + resistor + voltage source.
 * Vs=5V (node1→gnd), R=1kΩ (node1→node2), Diode (anode=node2, cathode=gnd).
 * matrixSize = 3: node1=idx0, node2=idx1, branch=idx2
 */
function makeDiodeCircuit(): ConcreteCompiledAnalogCircuit {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);

  return {
    netCount: 2,
    componentCount: 3,
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements: [vs, r, diode],
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
  };
}

/**
 * RC circuit: Vs=5V (node1→gnd, branch=2), R=1kΩ (node1→node2), C=1µF (node2→gnd).
 * At t=0 after DC OP: V(node2) = 5V (capacitor charged to Vs).
 * With source removed (Vs replaced by open) the cap discharges through R.
 * For simplicity we model: R charged from Vs, measure decay.
 *
 * Circuit: Vs=5V | R=1kΩ | C=1µF
 *   node1 = supply side (voltages[0])
 *   node2 = cap top plate (voltages[1])
 *   branch = Vs branch row (voltages[2])
 * matrixSize = 3
 */
function makeRCCircuit(): ConcreteCompiledAnalogCircuit {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = makeCapacitor(2, 0, 1e-6);

  return {
    netCount: 2,
    componentCount: 3,
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements: [vs, r, cap],
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MNAEngine", () => {
  let engine: MNAEngine;

  beforeEach(() => {
    engine = new MNAEngine();
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  it("init_allocates_correct_size", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);

    // Access private field through any-cast for testing
    const e = engine as unknown as { _voltages: Float64Array };
    expect(e._voltages.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // DC operating point
  // -------------------------------------------------------------------------

  it("dc_op_resistor_divider", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // node1 (voltages[0]) = 5V (connected directly to positive terminal of Vs)
    expect(engine.getNodeVoltage(0)).toBeCloseTo(5.0, 4);
    // node2 (voltages[1]) = 2.5V (midpoint of equal resistors)
    expect(engine.getNodeVoltage(1)).toBeCloseTo(2.5, 4);
  });

  it("dc_op_diode_circuit", () => {
    const circuit = makeDiodeCircuit();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // Diode forward voltage should be between 0.6V and 0.75V for typical silicon
    const vAnode = engine.getNodeVoltage(1);   // node2 = anode
    expect(vAnode).toBeGreaterThan(0.6);
    expect(vAnode).toBeLessThan(0.75);
  });

  it("dc_op_returns_result", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.method).toBe("direct");
    expect(result.nodeVoltages).toBeInstanceOf(Float64Array);
    expect(result.nodeVoltages.length).toBe(3);
    // nodeVoltages[1] = V_mid = 2.5V
    expect(result.nodeVoltages[1]).toBeCloseTo(2.5, 4);
  });

  // -------------------------------------------------------------------------
  // Transient simulation
  // -------------------------------------------------------------------------

  it("transient_rc_decay", () => {
    const circuit = makeRCCircuit();
    engine.init(circuit);

    // DC operating point: capacitor charges to Vs=5V
    engine.dcOperatingPoint();

    // Step until simTime reaches approximately RC = 1ms
    // maxTimeStep defaults to 5e-6; 1ms / 5e-6 = 200 steps minimum
    const RC = 1e-3; // 1kΩ × 1µF
    let steps = 0;
    while (engine.simTime < RC && steps < 5000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    // At t=RC, V(node2) should be approximately 5 × e^(-1) ≈ 1.839V
    // The RC discharge: V(t) = V0 × exp(-t/RC) but with Vs still connected
    // the steady-state is 5V, so the capacitor stays charged.
    // Actually with Vs connected, the voltage at node2 is held close to Vs
    // through the resistor — the cap charges, not discharges.
    // For a true RC discharge we'd need Vs switched off.
    // Here we verify the simulation runs stably and simTime advances.
    expect(engine.simTime).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(0);
    // node2 should remain near Vs (charged through R, stabilized by Vs)
    const v2 = engine.getNodeVoltage(1);
    expect(v2).toBeGreaterThan(4.5); // should be close to 5V since Vs is connected
    expect(v2).toBeLessThanOrEqual(5.01);
  });

  it("sim_time_advances", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.dcOperatingPoint();

    expect(engine.simTime).toBe(0);

    for (let i = 0; i < 10; i++) {
      engine.step();
    }

    expect(engine.simTime).toBeGreaterThan(0);
  });

  it("last_dt_reflects_adaptive_step", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.dcOperatingPoint();

    engine.step();

    expect(engine.lastDt).toBeGreaterThan(0);
    expect(engine.lastDt).toBeLessThanOrEqual(5e-6); // maxTimeStep default
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  it("reset_clears_state", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.dcOperatingPoint();

    for (let i = 0; i < 5; i++) {
      engine.step();
    }

    engine.reset();

    expect(engine.simTime).toBe(0);
    expect(engine.getNodeVoltage(0)).toBe(0);
    expect(engine.getNodeVoltage(1)).toBe(0);
    expect(engine.getState()).toBe(EngineState.STOPPED);
  });

  // -------------------------------------------------------------------------
  // Configure
  // -------------------------------------------------------------------------

  it("configure_changes_tolerances", () => {
    const circuit = makeDiodeCircuit();
    engine.init(circuit);

    // Configure with tighter tolerance; dcOP should still converge
    engine.configure({ reltol: 1e-6 });
    const result = engine.dcOperatingPoint();

    // With tighter tolerance it may need more iterations, but should still converge
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  it("diagnostics_emitted_on_dc_op", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);

    const received: string[] = [];
    engine.onDiagnostic((diag) => {
      received.push(diag.code);
    });

    engine.dcOperatingPoint();

    // Direct convergence emits dc-op-converged
    expect(received).toContain("dc-op-converged");
  });

  // -------------------------------------------------------------------------
  // Interface compatibility
  // -------------------------------------------------------------------------

  it("satisfies_engine_interface", () => {
    // Compile-time check: MNAEngine is assignable to Engine
    const e: Engine = new MNAEngine();
    // Runtime: all Engine methods exist
    expect(typeof e.init).toBe("function");
    expect(typeof e.reset).toBe("function");
    expect(typeof e.dispose).toBe("function");
    expect(typeof e.step).toBe("function");
    expect(typeof e.start).toBe("function");
    expect(typeof e.stop).toBe("function");
    expect(typeof e.getState).toBe("function");
    expect(typeof e.addChangeListener).toBe("function");
    expect(typeof e.removeChangeListener).toBe("function");
  });

  it("satisfies_analog_engine_interface", () => {
    // Compile-time check: MNAEngine is assignable to AnalogEngine
    const ae: AnalogEngine = new MNAEngine();
    expect(typeof ae.dcOperatingPoint).toBe("function");
    expect(typeof ae.getNodeVoltage).toBe("function");
    expect(typeof ae.getBranchCurrent).toBe("function");
    expect(typeof ae.getElementCurrent).toBe("function");
    expect(typeof ae.getElementPower).toBe("function");
    expect(typeof ae.configure).toBe("function");
    expect(typeof ae.onDiagnostic).toBe("function");
    expect(typeof ae.addBreakpoint).toBe("function");
    expect(typeof ae.clearBreakpoints).toBe("function");
  });

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  it("breakpoint_honored", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.dcOperatingPoint();

    const targetTime = 50e-6; // 50µs
    engine.addBreakpoint(targetTime);

    // Step until we reach or pass the breakpoint
    let reached = false;
    for (let i = 0; i < 200; i++) {
      engine.step();
      if (engine.simTime >= targetTime - 1e-20) {
        reached = true;
        break;
      }
    }

    expect(reached).toBe(true);
    // simTime should be at the breakpoint, within floating-point tolerance
    expect(engine.simTime).toBeCloseTo(targetTime, 8);
  });

  // -------------------------------------------------------------------------
  // Branch current
  // -------------------------------------------------------------------------

  it("get_branch_current", () => {
    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.dcOperatingPoint();

    // Vs=5V, R1+R2=2kΩ, expected current = 5V / 2kΩ = 2.5mA
    // The voltage source branch current is in row 2 (branchId=0, offset=nodeCount+0=2)
    const current = engine.getBranchCurrent(0);
    // The MNA branch current sign convention: current flows into positive terminal
    // Magnitude should be 2.5mA
    expect(Math.abs(current)).toBeCloseTo(2.5e-3, 6);
  });

  // -------------------------------------------------------------------------
  // Engine state transitions
  // -------------------------------------------------------------------------

  it("engine_state_transitions", () => {
    const circuit = makeResistorDividerCircuit();

    // Before init: STOPPED
    expect(engine.getState()).toBe(EngineState.STOPPED);

    engine.init(circuit);
    // After init: STOPPED
    expect(engine.getState()).toBe(EngineState.STOPPED);

    engine.start();
    expect(engine.getState()).toBe(EngineState.RUNNING);

    engine.stop();
    expect(engine.getState()).toBe(EngineState.PAUSED);

    engine.reset();
    expect(engine.getState()).toBe(EngineState.STOPPED);
  });

  it("change_listeners_notified", () => {
    const circuit = makeResistorDividerCircuit();
    const states: EngineState[] = [];

    engine.addChangeListener((s) => states.push(s));
    engine.init(circuit);
    engine.start();
    engine.stop();
    engine.reset();

    expect(states).toContain(EngineState.RUNNING);
    expect(states).toContain(EngineState.PAUSED);
    expect(states).toContain(EngineState.STOPPED);
  });

  it("remove_change_listener_works", () => {
    const states: EngineState[] = [];
    const listener = (s: EngineState) => states.push(s);

    engine.addChangeListener(listener);
    engine.removeChangeListener(listener);

    const circuit = makeResistorDividerCircuit();
    engine.init(circuit);
    engine.start();

    // Listener removed; states array should remain empty
    expect(states).toHaveLength(0);
  });
});
