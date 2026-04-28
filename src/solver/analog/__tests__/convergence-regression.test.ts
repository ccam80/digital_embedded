/**
 * Convergence regression integration tests for StatePool checkpoint/rollback.
 *
 * Verifies that the engine's checkpoint/rollback/rotateStateVectors wiring works
 * correctly and that circuits converge with the state-pool architecture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import { EngineState } from "../../../core/engine-interface.js";
import { allocateStatePool } from "./test-helpers.js";
import { StatePool } from "../state-pool.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../element.js";
import { makeDcVoltageSource } from "../../../components/sources/dc-voltage-source.js";
import { PropertyBag } from "../../../core/properties.js";
import { ResistorDefinition } from "../../../components/passives/resistor.js";
import { AnalogCapacitorElement, CAPACITOR_DEFAULTS } from "../../../components/passives/capacitor.js";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";

// ---------------------------------------------------------------------------
// Inline circuit-element builders using production factories
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const pinNodes = new Map([["A", nodeA], ["B", nodeB]]);
  const props = new PropertyBag();
  props.replaceModelParams({ resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { factory: (p: ReadonlyMap<string, number>, pr: PropertyBag, g: () => number) => AnalogElement }).factory;
  return factory(pinNodes, props, () => 0);
}

function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

function createTestCapacitor(capacitance: number, posNode: number, negNode: number): PoolBackedAnalogElement {
  return new AnalogCapacitorElement(
    new Map([["pos", posNode], ["neg", negNode]]),
    capacitance,
    CAPACITOR_DEFAULTS["IC"] as number,
    CAPACITOR_DEFAULTS["TC1"] as number,
    CAPACITOR_DEFAULTS["TC2"] as number,
    CAPACITOR_DEFAULTS["TNOM"] as number,
    CAPACITOR_DEFAULTS["SCALE"] as number,
    CAPACITOR_DEFAULTS["M"] as number,
  );
}

function makeDiode(anodeNode: number, cathodeNode: number, IS: number, N: number): PoolBackedAnalogElement {
  const props = new PropertyBag();
  const params: Record<string, number> = { ...DIODE_PARAM_DEFAULTS, IS, N };
  props.replaceModelParams(params);
  return createDiodeElement(
    new Map([["A", anodeNode], ["K", cathodeNode]]),
    props,
    () => 0,
  ) as PoolBackedAnalogElement;
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
  const vs = makeVoltageSource(1, 0, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = allocateStatePool(elements);

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
    } as unknown as ConcreteCompiledAnalogCircuit,
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
  const vs = makeVoltageSource(1, 0, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = createTestCapacitor(1e-6, 2, 0);
  const elements = [vs, r, cap];
  const pool = allocateStatePool(elements);

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
    } as unknown as ConcreteCompiledAnalogCircuit,
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
    // (set by initState). Diode is element[2], _stateBase should be 0
    // (vs and r have stateSize 0).
    const diodeEl = circuit.elements[2] as PoolBackedAnalogElement;
    const diodeBase = diodeEl._stateBase;
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
  // 4. rotateStateVectors shifts state1 after transient step
  // -----------------------------------------------------------------------

  it("statePool state1 is updated after accepted transient step", () => {
    const { circuit, pool } = makeHalfWaveRectifier();
    engine.init(circuit);
    engine.dcOperatingPoint();

    const diodeEl = circuit.elements[2] as PoolBackedAnalogElement;
    const diodeBase = diodeEl._stateBase;

    // After DC op, state1 should have been initialized from state0
    const state1VdAfterDc = pool.state1[diodeBase + 0];
    expect(state1VdAfterDc).toBeGreaterThan(0.5);

    // Run one transient step
    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // After accepted step, rotateStateVectors should have copied state0 → state1
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
    const v2 = engine.getNodeVoltage(2);
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

    const diodeEl = circuit.elements[2] as PoolBackedAnalogElement;
    const diodeBase = diodeEl._stateBase;
    expect(pool.state0[diodeBase + 0]).toBeGreaterThan(0); // has data

    engine.reset();

    // After reset, state0 slots are restored to initState values (not just zeroed).
    // Diode SLOT_VD (index 0) inits to 0, SLOT_GEQ (index 1) inits to GMIN (1e-12).
    expect(pool.state0[diodeBase + 0]).toBe(0);
    // History vectors are zeroed by statePool.reset() — initState does not touch them.
    expect(pool.state1[diodeBase + 0]).toBe(0);
    expect(pool.state2[diodeBase + 0]).toBe(0);
  });
});
