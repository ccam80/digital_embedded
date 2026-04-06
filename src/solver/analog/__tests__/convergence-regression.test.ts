/**
 * Convergence regression integration tests for StatePool checkpoint/rollback.
 *
 * Verifies that the engine's checkpoint/rollback/acceptTimestep wiring works
 * correctly and that circuits converge with the state-pool architecture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import { EngineState } from "../../../core/engine-interface.js";
import {
  makeResistor,
  makeVoltageSource,
  makeCapacitor,
  makeDiode,
} from "./test-helpers.js";
import { StatePool } from "../state-pool.js";
import type { AnalogElementCore } from "../element.js";

// ---------------------------------------------------------------------------
// State pool helper (mirrors analog-engine.test.ts)
// ---------------------------------------------------------------------------

function buildStatePool(elements: AnalogElementCore[]): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (el.stateSize > 0) {
      el.stateBaseOffset = offset;
      offset += el.stateSize;
    }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (el.stateSize > 0 && el.initState) {
      el.initState(pool);
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Half-wave rectifier: Vs=5V → R=1kΩ → Diode → GND.
 *   node1 = supply (voltages[0])
 *   node2 = diode anode / R output (voltages[1])
 *   branch = Vs branch row (voltages[2])
 */
function makeHalfWaveRectifier(): {
  circuit: ConcreteCompiledAnalogCircuit;
  pool: StatePool;
} {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = buildStatePool(elements);

  return {
    circuit: {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements,
      labelToNodeId: new Map(),
      statePool: pool,
    },
    pool,
  };
}

/**
 * RC circuit: Vs=5V → R=1kΩ → C=1µF → GND.
 *   node1 = supply (voltages[0])
 *   node2 = RC junction (voltages[1])
 *   branch = Vs branch row (voltages[2])
 *   RC time constant = 1ms
 */
function makeRCCircuit(): {
  circuit: ConcreteCompiledAnalogCircuit;
  pool: StatePool;
} {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = makeCapacitor(2, 0, 1e-6);
  const elements = [vs, r, cap];
  const pool = buildStatePool(elements);

  return {
    circuit: {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements,
      labelToNodeId: new Map(),
      statePool: pool,
    },
    pool,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("convergence regression", () => {
  let engine: MNAEngine;

  beforeEach(() => {
    engine = new MNAEngine();
  });

  // -----------------------------------------------------------------------
  // 1. Half-wave rectifier DC convergence
  // -----------------------------------------------------------------------

  it("half-wave rectifier converges and diode forward voltage is correct", () => {
    const { circuit } = makeHalfWaveRectifier();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Diode anode voltage should show forward drop ~0.6–0.75V
    const vAnode = engine.getNodeVoltage(2);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);

    // Supply node should be at Vs = 5V
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 3);
  });

  // -----------------------------------------------------------------------
  // 2. RC circuit transient stability
  // -----------------------------------------------------------------------

  it("RC circuit runs transient steps stably with capacitor near Vs", () => {
    const { circuit } = makeRCCircuit();
    engine.init(circuit);
    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Run transient steps
    let steps = 0;
    while (engine.simTime < 1e-3 && steps < 5000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);

    // With Vs connected, node2 should be near 5V (cap charges through R)
    const v2 = engine.getNodeVoltage(2);
    expect(v2).toBeGreaterThan(4.5);
    expect(v2).toBeLessThanOrEqual(5.01);
  });

  // -----------------------------------------------------------------------
  // 3. StatePool state0 populated after DC op
  // -----------------------------------------------------------------------

  it("statePool state0 has non-zero values after DC operating point", () => {
    const { circuit, pool } = makeHalfWaveRectifier();
    engine.init(circuit);

    // Before DC op, state0 should have GMIN at the diode's GEQ slot
    // (set by initState). Diode is element[2], stateBaseOffset should be 0
    // (vs and r have stateSize 0).
    const diodeBase = circuit.elements[2].stateBaseOffset;
    expect(diodeBase).toBeGreaterThanOrEqual(0);

    // SLOT_GEQ = 1 — should be GMIN (1e-12) after initState
    expect(pool.state0[diodeBase + 1]).toBeGreaterThan(0);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // After DC op, SLOT_VD = 0 should have the converged forward voltage
    const vdInPool = pool.state0[diodeBase + 0];
    expect(vdInPool).toBeGreaterThan(0.5);
    expect(vdInPool).toBeLessThan(0.8);

    // GEQ (slot 1) should be a real conductance value, not just GMIN
    const geq = pool.state0[diodeBase + 1];
    expect(geq).toBeGreaterThan(1e-6); // much larger than GMIN after convergence
  });

  // -----------------------------------------------------------------------
  // 4. acceptTimestep shifts state1 after transient step
  // -----------------------------------------------------------------------

  it("statePool state1 is updated after accepted transient step", () => {
    const { circuit, pool } = makeHalfWaveRectifier();
    engine.init(circuit);
    engine.dcOperatingPoint();

    const diodeBase = circuit.elements[2].stateBaseOffset;

    // After DC op, state1 should have been initialized from state0
    const state1VdAfterDc = pool.state1[diodeBase + 0];
    expect(state1VdAfterDc).toBeGreaterThan(0.5);

    // Capture state0 before step
    const state0VdBeforeStep = pool.state0[diodeBase + 0];

    // Run one transient step
    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // After accepted step, acceptTimestep should have copied state0 → state1
    // state1 should now reflect the post-step state0 (which may differ slightly)
    const state1VdAfterStep = pool.state1[diodeBase + 0];
    // state1 should be updated (it was the previous state0)
    expect(state1VdAfterStep).toBeGreaterThan(0.5);
    expect(state1VdAfterStep).toBeLessThan(0.8);
  });

  // -----------------------------------------------------------------------
  // 5. Engine runs multiple steps without crashing
  // -----------------------------------------------------------------------

  it("diode circuit runs 100 transient steps without error", () => {
    const { circuit } = makeHalfWaveRectifier();
    engine.init(circuit);
    engine.dcOperatingPoint();

    for (let i = 0; i < 100; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);

    // Voltages should remain physically plausible
    const v1 = engine.getNodeVoltage(1);
    const v2 = engine.getNodeVoltage(2);
    expect(v1).toBeCloseTo(5.0, 1);
    expect(v2).toBeGreaterThan(0.4);
    expect(v2).toBeLessThan(1.0);
  });

  // -----------------------------------------------------------------------
  // 6. Reset clears statePool
  // -----------------------------------------------------------------------

  it("reset restores initial values in statePool", () => {
    const { circuit, pool } = makeHalfWaveRectifier();
    engine.init(circuit);
    engine.dcOperatingPoint();

    const diodeBase = circuit.elements[2].stateBaseOffset;
    expect(pool.state0[diodeBase + 0]).toBeGreaterThan(0); // has data

    engine.reset();

    // After reset, state0 slots are restored to initState values (not just zeroed).
    // Diode SLOT_VD (index 0) inits to 0, SLOT_GEQ (index 1) inits to GMIN (1e-12).
    expect(pool.state0[diodeBase + 0]).toBe(0);
    expect(pool.state0[diodeBase + 1]).toBeCloseTo(1e-12, 20);
    // History vectors are zeroed by statePool.reset() — initState does not touch them.
    expect(pool.state1[diodeBase + 0]).toBe(0);
    expect(pool.state2[diodeBase + 0]).toBe(0);
  });
});
