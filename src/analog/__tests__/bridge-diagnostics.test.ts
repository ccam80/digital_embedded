/**
 * Tests for bridge diagnostic emissions (Task 4b.4.1).
 *
 * Verifies:
 *  - bridge-indeterminate-input: emitted after 10 consecutive indeterminate
 *    timesteps (voltage between vIL and vIH)
 *  - bridge-indeterminate-input: NOT emitted when voltage stays at a valid level
 *  - bridge-oscillating-input: emitted after 20 consecutive threshold crossings
 */

import { describe, it, expect } from "vitest";
import { MixedSignalCoordinator } from "../mixed-signal-coordinator.js";
import { makeBridgeInputAdapter } from "../bridge-adapter.js";
import type { BridgeInstance } from "../bridge-instance.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { DiagnosticCollector } from "../diagnostics.js";

// ---------------------------------------------------------------------------
// Shared electrical spec — CMOS 3.3V with vIL=0.8, vIH=2.0
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
// Minimal compiled circuit for the inner digital engine
// ---------------------------------------------------------------------------

function makeMinimalCompiled(netCount: number): object {
  return { netCount, componentCount: 0 };
}

// ---------------------------------------------------------------------------
// Mock MNAEngine — only needs addBreakpoint and simTime
// ---------------------------------------------------------------------------

class MockMNAEngine {
  simTime: number = 0;
  addBreakpoint(_time: number): void {}
}

// ---------------------------------------------------------------------------
// Build a BridgeInstance with a single labeled input adapter
// ---------------------------------------------------------------------------

function makeSingleInputBridge(
  inputNodeId: number,
  inputNetId: number,
  label: string,
): BridgeInstance {
  const inputAdapter = makeBridgeInputAdapter(CMOS_3V3, inputNodeId);
  inputAdapter.label = label;
  return {
    compiledInner: makeMinimalCompiled(inputNetId + 1) as any,
    outputAdapters: [],
    inputAdapters: [inputAdapter],
    outputPinNetIds: [],
    inputPinNetIds: [inputNetId],
    instanceName: "test-bridge",
  };
}

// ---------------------------------------------------------------------------
// Helper: run coordinator for N timesteps with a fixed voltage
// ---------------------------------------------------------------------------

function runStepsWithVoltage(
  coordinator: MixedSignalCoordinator,
  nodeId: number,
  voltage: number,
  steps: number,
): void {
  const voltages = new Float64Array(nodeId + 2);
  voltages[nodeId] = voltage;
  for (let i = 0; i < steps; i++) {
    coordinator.syncBeforeAnalogStep(voltages);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics tests
// ---------------------------------------------------------------------------

describe("Diagnostics", () => {
  describe("indeterminate_input_warns", () => {
    it("emits bridge-indeterminate-input after 10 consecutive indeterminate timesteps", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET, "sub:A");
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);
      coordinator.init();

      // 1.5V is between vIL (0.8V) and vIH (2.0V) — indeterminate
      const indeterminateVoltage = 1.5;

      // Run 15 timesteps (threshold is N=10 consecutive)
      runStepsWithVoltage(coordinator, INPUT_NODE, indeterminateVoltage, 15);

      const diags = collector.getDiagnostics();
      const indetermDiags = diags.filter((d) => d.code === "bridge-indeterminate-input");

      expect(indetermDiags.length).toBeGreaterThanOrEqual(1);
      // Diagnostic must include pin label
      expect(indetermDiags[0]!.summary).toContain("sub:A");
      // Diagnostic must include the voltage
      expect(indetermDiags[0]!.summary).toContain("1.500");
    });
  });

  describe("stable_input_no_warning", () => {
    it("does not emit bridge-indeterminate-input when voltage stays above vIH", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET, "sub:B");
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);
      coordinator.init();

      // 3.3V is well above vIH (2.0V) — unambiguously logic high
      runStepsWithVoltage(coordinator, INPUT_NODE, 3.3, 100);

      const diags = collector.getDiagnostics();
      const indetermDiags = diags.filter((d) => d.code === "bridge-indeterminate-input");
      expect(indetermDiags.length).toBe(0);
    });
  });

  describe("oscillating_input_warns", () => {
    it("emits bridge-oscillating-input after 20 consecutive threshold crossings", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET, "sub:CLK");
      const mockEngine = new MockMNAEngine();
      const coordinator = new MixedSignalCoordinator(mockEngine as any, [bridge]);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);
      coordinator.init();

      // Alternate between 1.9V (just below vIH=2.0) and 2.1V (just above vIH=2.0)
      // so the logic level interpretation changes on every timestep.
      // We also run syncAfterAnalogStep to drive the oscillating-count logic.
      const lowVoltage = 1.9;   // readLogicLevel → undefined (indeterminate)
      const highVoltage = 2.1;  // readLogicLevel → true

      // Prime the previous voltage: first step with highVoltage so prevInputVoltages is set
      const voltagesHigh = new Float64Array(INPUT_NODE + 2);
      voltagesHigh[INPUT_NODE] = highVoltage;
      coordinator.syncBeforeAnalogStep(voltagesHigh);
      coordinator.syncAfterAnalogStep(voltagesHigh);

      // Now alternate for 25 steps to trigger the M=20 threshold
      for (let step = 0; step < 25; step++) {
        const v = step % 2 === 0 ? lowVoltage : highVoltage;
        const voltages = new Float64Array(INPUT_NODE + 2);
        voltages[INPUT_NODE] = v;

        const prevV = step % 2 === 0 ? highVoltage : lowVoltage;
        const prevVoltages = new Float64Array(INPUT_NODE + 2);
        prevVoltages[INPUT_NODE] = prevV;

        // syncAfterAnalogStep compares currVoltage to prevInputVoltages[i]
        // which was set in the previous call
        coordinator.syncBeforeAnalogStep(voltages);
        coordinator.syncAfterAnalogStep(voltages);
      }

      const diags = collector.getDiagnostics();
      const oscillatingDiags = diags.filter((d) => d.code === "bridge-oscillating-input");
      expect(oscillatingDiags.length).toBeGreaterThanOrEqual(1);
      expect(oscillatingDiags[0]!.summary).toContain("sub:CLK");
    });
  });
});
