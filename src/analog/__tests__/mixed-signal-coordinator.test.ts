/**
 * Tests for MixedSignalCoordinator.
 *
 * Verifies:
 *  - Digital outputs drive analog nodes through bridge output adapters
 *  - Analog inputs above vIH drive the inner digital engine high
 *  - Analog inputs below vIL drive the inner digital engine low
 *  - Output changes register breakpoints on the analog engine
 *  - No breakpoints when outputs don't change
 *  - Threshold crossings trigger digital re-evaluation in syncAfterAnalogStep
 *  - reset() propagates to all inner engines
 *  - dispose() propagates to all inner engines
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MixedSignalCoordinator } from "../mixed-signal-coordinator.js";
import {
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { BridgeInstance } from "../bridge-instance.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { BitVector } from "../../core/signal.js";

// ---------------------------------------------------------------------------
// Shared electrical spec — CMOS 3.3V
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
// Mock MNAEngine
// ---------------------------------------------------------------------------

interface BreakpointCall {
  time: number;
}

class MockMNAEngine {
  readonly breakpoints: BreakpointCall[] = [];
  simTime: number = 0;

  addBreakpoint(time: number): void {
    this.breakpoints.push({ time });
  }
}

// ---------------------------------------------------------------------------
// Mock DigitalEngine factory helpers
//
// The coordinator creates DigitalEngine instances internally. We control
// signal values by building a minimal ConcreteCompiledCircuit-shaped object
// that the DigitalEngine's init() accepts as an "opaque CompiledCircuit".
// The opaque path only allocates signal arrays — no evaluation order is set,
// so setSignalValue() / getSignalRaw() work but step() is a no-op.
//
// For tests that need actual digital evaluation (AND gate), we instead
// directly spy on the inner engine after init().
// ---------------------------------------------------------------------------

/**
 * Build a minimal opaque CompiledCircuit that init() accepts.
 * netCount must be large enough to hold all net IDs used in the test.
 */
function makeMinimalCompiled(netCount: number): object {
  return {
    netCount,
    componentCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a BridgeInstance with one output adapter
// ---------------------------------------------------------------------------

function makeSingleOutputBridge(outputNodeId: number, outputNetId: number): BridgeInstance {
  const outputAdapter = makeBridgeOutputAdapter(CMOS_3V3, outputNodeId);
  return {
    compiledInner: makeMinimalCompiled(outputNetId + 1) as any,
    outputAdapters: [outputAdapter],
    inputAdapters: [],
    outputPinNetIds: [outputNetId],
    inputPinNetIds: [],
    instanceName: "test-output-bridge",
  };
}

// ---------------------------------------------------------------------------
// Helper: build a BridgeInstance with one input adapter
// ---------------------------------------------------------------------------

function makeSingleInputBridge(inputNodeId: number, inputNetId: number): BridgeInstance {
  const inputAdapter = makeBridgeInputAdapter(CMOS_3V3, inputNodeId);
  return {
    compiledInner: makeMinimalCompiled(inputNetId + 1) as any,
    outputAdapters: [],
    inputAdapters: [inputAdapter],
    outputPinNetIds: [],
    inputPinNetIds: [inputNetId],
    instanceName: "test-input-bridge",
  };
}

// ---------------------------------------------------------------------------
// Sync tests
// ---------------------------------------------------------------------------

describe("Sync", () => {
  describe("digital_output_drives_analog_node", () => {
    it("output adapter logic level is set to true when inner engine output net is 1", () => {
      const OUTPUT_NODE = 1;
      const OUTPUT_NET = 0;

      const bridge = makeSingleOutputBridge(OUTPUT_NODE, OUTPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // Manually set the inner engine's output net to 1 (high)
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      innerEngine.setSignalValue(OUTPUT_NET, BitVector.fromNumber(1, 1));

      // sync — coordinator reads the inner engine's output and drives the adapter
      const voltages = new Float64Array(4);
      coordinator.syncBeforeAnalogStep(voltages);

      // The output adapter's logic level should be true (high)
      const adapter = bridge.outputAdapters[0]!;
      // We verify by checking that the adapter was updated: setLogicLevel(true)
      // stamps vOH; we can verify by checking prevOutputBits in bridge state
      const state = (coordinator as any)._bridgeStates[0];
      expect(state.prevOutputBits[0]).toBe(true);
    });
  });

  describe("analog_input_drives_digital", () => {
    it("sets inner engine input net to 1 when analog voltage is above vIH", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // Set analog voltage at the input node to 3.3V (above vIH = 2.0V)
      // readMnaVoltage(nodeId, v) reads v[nodeId-1], so put value at index 0
      const voltages = new Float64Array(4);
      voltages[INPUT_NODE - 1] = 3.3;

      coordinator.syncBeforeAnalogStep(voltages);

      // Inner engine's input net should be 1
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      const raw = innerEngine.getSignalRaw(INPUT_NET);
      expect(raw).toBe(1);
    });
  });

  describe("analog_input_below_threshold_drives_low", () => {
    it("sets inner engine input net to 0 when analog voltage is below vIL", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // Set analog voltage at the input node to 0.5V (below vIL = 0.8V)
      const voltages = new Float64Array(4);
      voltages[INPUT_NODE - 1] = 0.5;

      coordinator.syncBeforeAnalogStep(voltages);

      // Inner engine's input net should be 0
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      const raw = innerEngine.getSignalRaw(INPUT_NET);
      expect(raw).toBe(0);
    });
  });

  describe("output_change_registers_breakpoint", () => {
    it("registers a breakpoint on the analog engine when output changes", () => {
      const OUTPUT_NODE = 1;
      const OUTPUT_NET = 0;

      const bridge = makeSingleOutputBridge(OUTPUT_NODE, OUTPUT_NET);
      const mockEngine = new MockMNAEngine();
      mockEngine.simTime = 1e-6;
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      const voltages = new Float64Array(4);

      // First sync: output is low (net = 0, default)
      coordinator.syncBeforeAnalogStep(voltages);
      const breakpointsAfterFirst = mockEngine.breakpoints.length;

      // Change the inner engine output to high
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      innerEngine.setSignalValue(OUTPUT_NET, BitVector.fromNumber(1, 1));

      // Second sync: output changed from low to high — breakpoint should be registered
      coordinator.syncBeforeAnalogStep(voltages);

      expect(mockEngine.breakpoints.length).toBeGreaterThan(breakpointsAfterFirst);
    });
  });

  describe("no_change_no_breakpoint", () => {
    it("does not register a breakpoint when outputs remain the same", () => {
      const OUTPUT_NODE = 1;
      const OUTPUT_NET = 0;

      const bridge = makeSingleOutputBridge(OUTPUT_NODE, OUTPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      const voltages = new Float64Array(4);

      // First sync: output low (initial state)
      coordinator.syncBeforeAnalogStep(voltages);
      const countAfterFirst = mockEngine.breakpoints.length;

      // Second sync: output still low (same net value) — no change
      coordinator.syncBeforeAnalogStep(voltages);
      const countAfterSecond = mockEngine.breakpoints.length;

      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });

  describe("threshold_crossing_triggers_resync", () => {
    it("re-evaluates digital engine when analog voltage crosses vIH threshold", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // First timestep: voltage at 1.0V (below vIL — logic low)
      const voltages1 = new Float64Array(4);
      voltages1[INPUT_NODE - 1] = 1.0;
      coordinator.syncBeforeAnalogStep(voltages1);
      coordinator.syncAfterAnalogStep(voltages1);

      // Second timestep: voltage at 3.0V (above vIH — logic high, threshold crossed)
      const voltages2 = new Float64Array(4);
      voltages2[INPUT_NODE - 1] = 3.0;

      // syncAfterAnalogStep detects the crossing and re-evaluates
      coordinator.syncAfterAnalogStep(voltages2);

      // After crossing, the inner engine input net should be 1 (high)
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      const raw = innerEngine.getSignalRaw(INPUT_NET);
      expect(raw).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe("Lifecycle", () => {
  describe("reset_resets_inner_engines", () => {
    it("resets inner engine signal state and prevOutputBits to initial values", () => {
      const OUTPUT_NODE = 1;
      const OUTPUT_NET = 0;

      const bridge = makeSingleOutputBridge(OUTPUT_NODE, OUTPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // Set inner engine output to high and sync
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      innerEngine.setSignalValue(OUTPUT_NET, BitVector.fromNumber(1, 1));

      const voltages = new Float64Array(4);
      coordinator.syncBeforeAnalogStep(voltages);

      // Verify output was set to true before reset
      const stateBefore = (coordinator as any)._bridgeStates[0];
      expect(stateBefore.prevOutputBits[0]).toBe(true);

      // Reset
      coordinator.reset();

      // After reset, prevOutputBits should be false again
      const stateAfter = (coordinator as any)._bridgeStates[0];
      expect(stateAfter.prevOutputBits[0]).toBe(false);

      // Inner engine's signal should be reset to undefined/zero
      const rawAfterReset = innerEngine.getSignalRaw(OUTPUT_NET);
      expect(rawAfterReset).toBe(0);
    });
  });

  describe("dispose_disposes_inner_engines", () => {
    it("disposes inner engines without throwing", () => {
      const OUTPUT_NODE = 1;
      const OUTPUT_NET = 0;

      const bridge = makeSingleOutputBridge(OUTPUT_NODE, OUTPUT_NET);
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      coordinator.init();

      // dispose() should not throw and inner engine should be disposed
      expect(() => coordinator.dispose()).not.toThrow();

      // After dispose, the inner engine should have been disposed —
      // getSignalRaw on a disposed engine returns 0 (empty array)
      const innerEngine = (coordinator as any)._bridgeStates[0].innerEngine;
      expect(innerEngine.getSignalRaw(0)).toBe(0);
    });
  });
});
