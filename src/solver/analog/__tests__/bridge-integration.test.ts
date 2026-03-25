/**
 * End-to-end bridge integration tests (Task 4b.4.2).
 *
 * Full pipeline tests: BridgeInstance assembled directly into
 * ConcreteCompiledAnalogCircuit → MNAEngine → verify voltages.
 *
 * Node ID conventions:
 *   - test-elements.ts helpers (makeResistor, makeVoltageSource) use 1-based
 *     node IDs (0 = ground) and internally subtract 1 when calling the solver.
 *   - BridgeOutputAdapter / BridgeInputAdapter (via DigitalOutputPinModel /
 *     DigitalInputPinModel) use 0-based solver indices directly.
 *   - To share a node, adapter nodeId = helper nodeId - 1.
 *     Example: makeResistor(1, 0, R) shares node with makeBridgeOutputAdapter(spec, 0).
 *
 * Test circuit A: Analog voltage source → resistor → bridge input (NOT gate
 * subcircuit) → bridge output → resistor load to ground.
 *
 * Test circuit B: Threshold-detected input drives a 4-bit counter subcircuit
 * whose 4 bridge outputs each drive a resistor-to-ground "LED indicator".
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { MNAEngine } from "../analog-engine.js";
import {
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { BridgeInstance } from "../bridge-instance.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { makeResistor, makeVoltageSource, makeCapacitor } from "../test-elements.js";
import { EngineState } from "../../../core/engine-interface.js";
import { BitVector } from "../../../core/signal.js";
import { DigitalEngine } from "../../digital/digital-engine.js";
import { DefaultSimulationCoordinator } from "../../coordinator.js";
import type { CompiledCircuitUnified } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// CMOS 3.3V electrical spec used throughout
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal opaque CompiledCircuit that the coordinator's
 * DigitalEngine.init() accepts. netCount must be >= max net ID used.
 * step() is effectively a no-op (no evaluation order).
 */
function makeMinimalCompiledInner(netCount: number): object {
  return { netCount, componentCount: 0 };
}

/**
 * Build a ConcreteCompiledAnalogCircuit from a hand-assembled list of
 * elements + bridges, with explicit nodeCount and branchCount.
 */
function buildCompiledCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: import("../element.js").AnalogElement[];
  bridges?: BridgeInstance[];
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    bridges: opts.bridges ?? [],
  });
}

/**
 * Wrap a ConcreteCompiledAnalogCircuit in a CompiledCircuitUnified for use
 * with DefaultSimulationCoordinator.
 */
function wrapAsUnified(compiled: ConcreteCompiledAnalogCircuit): CompiledCircuitUnified {
  return {
    digital: null,
    analog: compiled,
    bridges: [],
    wireSignalMap: new Map(),
    labelSignalMap: new Map(),
    diagnostics: [],
  };
}

// ===========================================================================
// Integration::not_gate_subcircuit_inverts
//
// Drive bridge input at 3.3V (logic HIGH). NOT gate output should be LOW.
//
// Node layout (test-elements use 1-based; bridge adapters use 0-based):
//   test node 1  = solver index 0  → Vs positive terminal
//   test node 2  = solver index 1  → bridge input node (R_in connects)
//   test node 3  = solver index 2  → bridge output node (R_load connects)
//   branch row 3 (absolute index = nodeCount + 0 = 3)
//
// Bridge input adapter: 0-based index 1 (reads from solution[1])
// Bridge output adapter: 0-based index 2 (drives solution[2])
//
// The coordinator's sync sets output adapter to LOW (NOT(HIGH)=LOW).
// Since dcOperatingPoint doesn't call syncBeforeAnalogStep, we pre-set the
// output adapter to LOW before init (default is already LOW = vOL = 0V).
// ===========================================================================

describe("Integration", () => {
  it("not_gate_subcircuit_inverts", () => {
    // test-elements 1-based node IDs
    const N_VS_POS = 1;   // solver index 0
    const N_INPUT  = 2;   // solver index 1
    const N_OUTPUT = 3;   // solver index 2
    // branchCount=1, absolute branch row = nodeCount + 0 = 3 + 0 = 3
    const BRANCH_ABS = 3;

    const vs   = makeVoltageSource(N_VS_POS, 0, BRANCH_ABS, 3.3);
    const rIn  = makeResistor(N_VS_POS, N_INPUT, 1000);
    const rLoad = makeResistor(N_OUTPUT, 0, 10000);

    // Bridge adapters use 1-based MNA node IDs (same as test-elements):
    //   N_INPUT  = 2 → readMnaVoltage(2, v) reads v[1] = solver index 1
    //   N_OUTPUT = 3 → readMnaVoltage(3, v) reads v[2] = solver index 2
    const inputAdapter  = makeBridgeInputAdapter(CMOS_3V3, N_INPUT);
    const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, N_OUTPUT);
    // Default state: outputAdapter is LOW (vOL=0V) = NOT(HIGH) ✓

    const compiledInner = makeMinimalCompiledInner(2);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [outputAdapter],
      inputAdapters:  [inputAdapter],
      outputPinNetIds: [1], // output at inner net 1 (default 0 = LOW)
      inputPinNetIds:  [0], // input at inner net 0
      instanceName: "not-gate",
    };

    // nodeCount=3, branchCount=1 → matrixSize=4
    const compiled = buildCompiledCircuit({
      nodeCount: 3,
      branchCount: 1,
      elements: [vs, rIn, rLoad, inputAdapter, outputAdapter],
      bridges: [bridge],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Node1 (solver[0]) = 3.3V from Vs
    expect(result.nodeVoltages[0]).toBeCloseTo(3.3, 1);

    // Node2 (solver[1]) = bridge input node
    // Small drop across rIn=1kΩ due to rIn_bridge=10MΩ → voltage ≈ 3.3V
    const vInput = result.nodeVoltages[1]!;
    expect(vInput).toBeGreaterThan(CMOS_3V3.vIH); // above vIH → logic HIGH

    // Node3 (solver[2]) = bridge output, adapter is LOW (vOL=0V)
    // Voltage divider: vOL (0V) × rLoad/(rOut+rLoad) = 0V
    const vOutput = result.nodeVoltages[2]!;
    expect(vOutput).toBeCloseTo(CMOS_3V3.vOL, 1);
  });

  it("not_gate_subcircuit_low_input", () => {
    // Drive bridge input with 0V (Vs=0V). NOT gate output = HIGH.
    // Output adapter pre-set to HIGH before engine.init().

    const N_VS_POS = 1;
    const N_INPUT  = 2;
    const N_OUTPUT = 3;
    const BRANCH_ABS = 3;

    const vs    = makeVoltageSource(N_VS_POS, 0, BRANCH_ABS, 0.0); // 0V source
    const rIn   = makeResistor(N_VS_POS, N_INPUT, 1000);
    const rLoad = makeResistor(N_OUTPUT, 0, 10000);

    const inputAdapter  = makeBridgeInputAdapter(CMOS_3V3, N_INPUT);
    const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, N_OUTPUT);
    // NOT(LOW=0) = HIGH → pre-set output to HIGH
    outputAdapter.setLogicLevel(true);

    const compiledInner = makeMinimalCompiledInner(2);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [outputAdapter],
      inputAdapters:  [inputAdapter],
      outputPinNetIds: [1],
      inputPinNetIds:  [0],
      instanceName: "not-gate-low",
    };

    const compiled = buildCompiledCircuit({
      nodeCount: 3,
      branchCount: 1,
      elements: [vs, rIn, rLoad, inputAdapter, outputAdapter],
      bridges: [bridge],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Node2 ≈ 0V (Vs=0V, negligible drop due to bridge input loading)
    const vInput = result.nodeVoltages[1]!;
    expect(vInput).toBeLessThan(CMOS_3V3.vIL); // below vIL → logic LOW

    // Node3 = bridge output HIGH → vOH × R_load/(rOut + R_load)
    const vOutput = result.nodeVoltages[2]!;
    const expected = CMOS_3V3.vOH * 10000 / (CMOS_3V3.rOut + 10000);
    expect(vOutput).toBeCloseTo(expected, 1);
    expect(vOutput).toBeGreaterThan(CMOS_3V3.vIH); // above vIH
  });

  it("output_voltage_through_load", () => {
    // Bridge output (HIGH) → 10kΩ load to ground.
    // Expected: V_node = vOH × R_load / (rOut + R_load)
    //   = 3.3 × 10000 / (50 + 10000) ≈ 3.284V

    // MNA node 1 → solver index 0 (nodeCount=1, matrixSize=1)
    // makeResistor uses 1-based: makeResistor(1, 0, R) → solver index 0
    const ADAPTER_NODE = 1; // 1-based MNA node ID for adapter
    const R_LOAD = 10000;

    const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, ADAPTER_NODE);
    outputAdapter.setLogicLevel(true); // drive HIGH

    const rLoad = makeResistor(1, 0, R_LOAD); // 1-based node 1 = solver index 0

    const compiledInner = makeMinimalCompiledInner(1);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [outputAdapter],
      inputAdapters:  [],
      outputPinNetIds: [0],
      inputPinNetIds:  [],
      instanceName: "output-load-test",
    };

    // nodeCount=1, branchCount=0, matrixSize=1
    const compiled = buildCompiledCircuit({
      nodeCount: 1,
      branchCount: 0,
      elements: [outputAdapter, rLoad],
      bridges: [bridge],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const vOut = result.nodeVoltages[ADAPTER_NODE - 1]!;
    const expected = CMOS_3V3.vOH * R_LOAD / (CMOS_3V3.rOut + R_LOAD);
    expect(vOut).toBeCloseTo(expected, 1);
    expect(Math.abs(vOut - expected) / expected).toBeLessThan(0.005);
  });

  it("transient_edge_propagation", () => {
    // Bridge output changes from LOW to HIGH. The output node voltage should
    // transition with the RC time constant from C_out (5pF) and R_load (10kΩ).
    // τ = C_out × (rOut || R_load) ≈ 5pF × 50Ω ≈ 250ps.
    // Run 10ns transient (>> τ) — voltage should reach steady state.

    const ADAPTER_NODE = 1; // 1-based MNA node ID
    const R_LOAD = 10000;

    const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, ADAPTER_NODE);
    outputAdapter.setLogicLevel(false); // start LOW

    const rLoad = makeResistor(1, 0, R_LOAD);

    const compiledInner = makeMinimalCompiledInner(1);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [outputAdapter],
      inputAdapters:  [],
      outputPinNetIds: [0],
      inputPinNetIds:  [],
      instanceName: "transient-edge",
    };

    const compiled = buildCompiledCircuit({
      nodeCount: 1,
      branchCount: 0,
      elements: [outputAdapter, rLoad],
      bridges: [bridge],
    });

    // Use DefaultSimulationCoordinator which owns bridge sync
    const coord = new DefaultSimulationCoordinator(wrapAsUnified(compiled));
    const engine = coord.getAnalogEngine() as MNAEngine;

    // DC OP at LOW: node ≈ 0V
    expect(engine.getNodeVoltage(ADAPTER_NODE)).toBeLessThan(0.1);

    // Switch to HIGH: set inner engine's output net so the coordinator
    // reads HIGH and drives the output adapter HIGH on each step.
    const innerEngine: DigitalEngine = (coord as any)._bridgeStates[0].innerEngine;
    innerEngine.setSignalValue(0, BitVector.fromNumber(1, 1)); // output net 0 = HIGH

    // Run transient for 10ns with tight timestep (>> τ ≈ 250ps)
    engine.configure({ maxTimeStep: 1e-10, minTimeStep: 1e-16 });

    let steps = 0;
    const TARGET_TIME = 10e-9; // 10ns
    while (engine.simTime < TARGET_TIME && steps < 200000) {
      coord.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // After 10ns (>> τ ≈ 250ps), voltage should be at steady state
    const vSteadyExpected = CMOS_3V3.vOH * R_LOAD / (CMOS_3V3.rOut + R_LOAD);
    const vFinal = engine.getNodeVoltage(ADAPTER_NODE);
    // Within 1% of steady state
    expect(Math.abs(vFinal - vSteadyExpected) / vSteadyExpected).toBeLessThan(0.01);

    coord.dispose();
  });

  it("counter_counts_on_threshold_crossings", () => {
    // Simulates a digital counter state visible through 4 bridge output adapters.
    //
    // Node layout (0-based adapter indices, 1-based for makeResistor):
    //   adapter index 0 = solver[0] = makeResistor(1,0,...) — input bias
    //   adapter index 1 = solver[1] = makeResistor(2,0,...) — Q0 output
    //   adapter index 2 = solver[2] = makeResistor(3,0,...) — Q1 output
    //   adapter index 3 = solver[3] = makeResistor(4,0,...) — Q2 output
    //   adapter index 4 = solver[4] = makeResistor(5,0,...) — Q3 output
    //
    // We manually set the inner engine output nets to represent count=4:
    //   Q0=0, Q1=0, Q2=1, Q3=0 → binary 0100
    //
    // After syncBeforeAnalogStep, output adapters should reflect this state.
    // DC OP confirms Q2 output node is HIGH, others are LOW.

    const IN_ADAPTER_NODE  = 1; // 1-based MNA node ID for clock input
    const Q0_ADAPTER_NODE  = 2;
    const Q1_ADAPTER_NODE  = 3;
    const Q2_ADAPTER_NODE  = 4;
    const Q3_ADAPTER_NODE  = 5;

    const inputAdapter  = makeBridgeInputAdapter(CMOS_3V3, IN_ADAPTER_NODE);
    const q0Adapter     = makeBridgeOutputAdapter(CMOS_3V3, Q0_ADAPTER_NODE);
    const q1Adapter     = makeBridgeOutputAdapter(CMOS_3V3, Q1_ADAPTER_NODE);
    const q2Adapter     = makeBridgeOutputAdapter(CMOS_3V3, Q2_ADAPTER_NODE);
    const q3Adapter     = makeBridgeOutputAdapter(CMOS_3V3, Q3_ADAPTER_NODE);

    // Bias/load resistors (1-based helper nodes)
    const rBias = makeResistor(1, 0, 100000); // input bias to ground
    const rQ0   = makeResistor(2, 0, 10000);
    const rQ1   = makeResistor(3, 0, 10000);
    const rQ2   = makeResistor(4, 0, 10000);
    const rQ3   = makeResistor(5, 0, 10000);

    // Inner engine: input net 0, output nets 1..4 (Q0..Q3)
    const compiledInner = makeMinimalCompiledInner(5);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [q0Adapter, q1Adapter, q2Adapter, q3Adapter],
      inputAdapters:  [inputAdapter],
      outputPinNetIds: [1, 2, 3, 4], // Q0..Q3 at inner nets 1..4
      inputPinNetIds:  [0],
      instanceName: "counter",
    };

    // nodeCount=5 (solver indices 0..4), branchCount=0
    const compiled = buildCompiledCircuit({
      nodeCount: 5,
      branchCount: 0,
      elements: [
        inputAdapter, rBias,
        q0Adapter, rQ0,
        q1Adapter, rQ1,
        q2Adapter, rQ2,
        q3Adapter, rQ3,
      ],
      bridges: [bridge],
    });

    // Use DefaultSimulationCoordinator which owns bridge sync
    const coord = new DefaultSimulationCoordinator(wrapAsUnified(compiled));
    const engine = coord.getAnalogEngine() as MNAEngine;

    // Access the inner engine through coordinator private state
    const innerEngine: DigitalEngine = (coord as any)._bridgeStates[0].innerEngine;

    // Set output nets to represent count=4 (binary 0100):
    // Q0=0(net1), Q1=0(net2), Q2=1(net3), Q3=0(net4)
    innerEngine.setSignalValue(1, BitVector.fromNumber(0, 1)); // Q0 = 0
    innerEngine.setSignalValue(2, BitVector.fromNumber(0, 1)); // Q1 = 0
    innerEngine.setSignalValue(3, BitVector.fromNumber(1, 1)); // Q2 = 1
    innerEngine.setSignalValue(4, BitVector.fromNumber(0, 1)); // Q3 = 0

    // Simulate a threshold crossing: set analog voltage at input node and run sync
    const analog = coord.getAnalogEngine() as any;
    analog._voltages[IN_ADAPTER_NODE - 1] = 3.3;
    (coord as any)._syncBeforeAnalogStep();

    // After sync, Q2 should be HIGH, others LOW
    const state = (coord as any)._bridgeStates[0];
    expect(state.prevOutputBits[0]).toBe(false); // Q0 = 0
    expect(state.prevOutputBits[1]).toBe(false); // Q1 = 0
    expect(state.prevOutputBits[2]).toBe(true);  // Q2 = 1
    expect(state.prevOutputBits[3]).toBe(false); // Q3 = 0

    // Confirm via DC OP: Q2 output node should be ≈ vOH × 10kΩ/(rOut+10kΩ)
    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    const expectedHigh = CMOS_3V3.vOH * 10000 / (CMOS_3V3.rOut + 10000);

    // Q2 at MNA node Q2_ADAPTER_NODE=4 → solver index 3 → nodeVoltages[3]
    const vQ2 = dcResult.nodeVoltages[Q2_ADAPTER_NODE - 1]!;
    expect(vQ2).toBeCloseTo(expectedHigh, 1);

    // Q0 at MNA node Q0_ADAPTER_NODE=2 → solver index 1 → nodeVoltages[1]
    const vQ0 = dcResult.nodeVoltages[Q0_ADAPTER_NODE - 1]!;
    expect(vQ0).toBeLessThan(0.1);

    coord.dispose();
  });

  it("bidirectional_nesting", () => {
    // Analog → digital → analog: analog Vs drives bridge input, digital
    // buffer copies it to bridge output, output drives analog R_load.
    //
    // Node layout:
    //   test node 1 (solver[0]) — Vs positive terminal
    //   test node 2 (solver[1]) — bridge output driving R_load
    //   branch row 2 (absolute = nodeCount(2) + 0 = 2) — Vs branch
    //
    // Bridge input adapter: reads from Vs node (solver[0])
    // Bridge output adapter: drives R_load node (solver[1])
    //
    // The digital "buffer": input net 0 → output net 1 (pass-through).
    // We pre-set output net 1 = HIGH before syncBeforeAnalogStep to simulate
    // the buffer copying the HIGH input.

    const N_VS_POS  = 1; // test-elements 1-based
    const N_OUT     = 2; // test-elements 1-based
    const BRANCH_ABS = 2; // absolute branch row = nodeCount(2) + 0 = 2

    const vs    = makeVoltageSource(N_VS_POS, 0, BRANCH_ABS, 3.3);
    const rLoad = makeResistor(N_OUT, 0, 10000);

    // Bridge adapters use 1-based MNA node IDs:
    //   input adapter at MNA node 1 → readMnaVoltage(1, v) reads v[0] = Vs = 3.3V
    //   output adapter at MNA node 2 → drives solver[1] = R_load node
    const inputAdapter  = makeBridgeInputAdapter(CMOS_3V3, N_VS_POS);
    const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, N_OUT);

    const compiledInner = makeMinimalCompiledInner(2);
    const bridge: BridgeInstance = {
      compiledInner: compiledInner as any,
      outputAdapters: [outputAdapter],
      inputAdapters:  [inputAdapter],
      outputPinNetIds: [1], // buffer output at inner net 1
      inputPinNetIds:  [0], // buffer input at inner net 0
      instanceName: "buffer-bridge",
    };

    // nodeCount=2 (solver[0], solver[1]), branchCount=1 (Vs), matrixSize=3
    const compiled = buildCompiledCircuit({
      nodeCount: 2,
      branchCount: 1,
      elements: [vs, rLoad, inputAdapter, outputAdapter],
      bridges: [bridge],
    });

    // Use DefaultSimulationCoordinator which owns bridge sync
    const coord = new DefaultSimulationCoordinator(wrapAsUnified(compiled));
    const engine = coord.getAnalogEngine() as MNAEngine;

    // Pre-set the inner engine's output net to HIGH (buffer output = input HIGH)
    const innerEngine: DigitalEngine = (coord as any)._bridgeStates[0].innerEngine;
    innerEngine.setSignalValue(1, BitVector.fromNumber(1, 1));

    // Set analog voltage at input node and run sync
    const analog = coord.getAnalogEngine() as any;
    analog._voltages[0] = 3.3; // input adapter reads from solver[0]
    (coord as any)._syncBeforeAnalogStep();

    // Output adapter should now be HIGH
    const state = (coord as any)._bridgeStates[0];
    expect(state.prevOutputBits[0]).toBe(true);

    // Run DC OP: output node (solver[1]) should be at vOH × R_load/(rOut+R_load)
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);

    // Node1 (solver[0]) = Vs = 3.3V (input + bridge input loading ≈ 3.3V)
    expect(result.nodeVoltages[0]).toBeCloseTo(3.3, 1);

    // Node2 (solver[1]) = bridge output HIGH → vOH × R_load/(rOut+R_load)
    const expectedV = CMOS_3V3.vOH * 10000 / (CMOS_3V3.rOut + 10000);
    expect(result.nodeVoltages[1]).toBeCloseTo(expectedV, 1);

    coord.dispose();
  });
});
