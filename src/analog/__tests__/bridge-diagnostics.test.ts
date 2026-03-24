/**
 * Tests for bridge diagnostic emissions (Task 4b.4.1).
 *
 * Verifies:
 *  - bridge-indeterminate-input: emitted after 10 consecutive indeterminate
 *    timesteps (voltage between vIL and vIH)
 *  - bridge-indeterminate-input: NOT emitted when voltage stays at a valid level
 *  - bridge-oscillating-input: emitted after 20 consecutive threshold crossings
 *  - bridge-impedance-mismatch: emitted when source R > 100 × R_in
 */

import { describe, it, expect } from "vitest";
import { MixedSignalCoordinator } from "../mixed-signal-coordinator.js";
import { makeBridgeInputAdapter } from "../bridge-adapter.js";
import type { BridgeInstance } from "../bridge-instance.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { compileAnalogCircuit } from "../compiler.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { Pin } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../../core/registry.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { CrossEngineBoundary } from "../../engine/cross-engine-boundary.js";
import type { FlattenResult, SubcircuitHost } from "../../engine/flatten.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";

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
  const voltages = new Float64Array(nodeId + 1);
  voltages[nodeId - 1] = voltage;
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
      const voltagesHigh = new Float64Array(INPUT_NODE + 1);
      voltagesHigh[INPUT_NODE - 1] = highVoltage;
      coordinator.syncBeforeAnalogStep(voltagesHigh);
      coordinator.syncAfterAnalogStep(voltagesHigh);

      // Now alternate for 25 steps to trigger the M=20 threshold
      for (let step = 0; step < 25; step++) {
        const v = step % 2 === 0 ? lowVoltage : highVoltage;
        const voltages = new Float64Array(INPUT_NODE + 1);
        voltages[INPUT_NODE - 1] = v;

        const prevV = step % 2 === 0 ? highVoltage : lowVoltage;
        const prevVoltages = new Float64Array(INPUT_NODE + 1);
        prevVoltages[INPUT_NODE - 1] = prevV;

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

// ---------------------------------------------------------------------------
// bridge-impedance-mismatch — compiler diagnostic
// ---------------------------------------------------------------------------

/**
 * Minimal leaf element for the outer analog circuit.
 * Supports a "resistance" property so detectHighSourceImpedance can find it.
 */
class HighZResistorElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    pos: { x: number; y: number },
    pins: Pin[],
    resistance: number,
  ) {
    const props = new PropertyBag([["resistance", resistance]]);
    super("HighZResistor", instanceId, pos, 0, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 4, height: 4 }; }
  getHelpText(): string { return ""; }
}

/** Ground placeholder element — gives MNA a ground reference node. */
class GroundElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, pos: { x: number; y: number }, pins: Pin[]) {
    super("Ground", instanceId, pos, 0, false, new PropertyBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 2, height: 2 }; }
  getHelpText(): string { return ""; }
}

/** SubcircuitHost placeholder for the bridge inner digital circuit. */
class BridgeSubcircuitElement extends AbstractCircuitElement implements SubcircuitHost {
  readonly internalCircuit: Circuit;
  readonly subcircuitName: string;
  private readonly _pins: readonly Pin[];

  constructor(
    name: string,
    instanceId: string,
    pos: { x: number; y: number },
    internalCircuit: Circuit,
    pins: Pin[],
  ) {
    super(`Subcircuit:${name}`, instanceId, pos, 0, false, new PropertyBag());
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 6, height: 6 }; }
  getHelpText(): string { return "subcircuit"; }
}

function noopExec(): ExecuteFunction {
  return (_idx, _state, _layout) => {};
}

function makeAnalogStubDef(typeId: string, pinCount: number): ComponentDefinition {
  return {
    name: typeId,
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    executeFn: noopExec(),
    pinLayout: Array.from({ length: pinCount }, (_, i) => ({
      label: `p${i}`,
      direction: PinDirection.BIDIRECTIONAL,
    })),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: typeId,
    engineType: "analog",
    analogFactory: (pinNodes, _internalNodeIds, _branchIdx, _props, _getTime): AnalogElement => ({
      pinNodeIds: [...pinNodes.values()],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp(_s: SparseSolver) {},
    }),
  };
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: "Ground",
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    executeFn: noopExec(),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "Ground",
    engineType: "analog",
  };
}

function makeDigitalInDef(): ComponentDefinition {
  return {
    name: "In",
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    executeFn: noopExec(),
    pinLayout: [{ label: "out", direction: PinDirection.OUTPUT }],
    propertyDefs: [{ key: "label", defaultValue: "" }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "In",
  };
}

describe("bridge-impedance-mismatch", () => {
  it("emits_bridge_impedance_mismatch_when_source_resistance_too_high", () => {
    // Build a circuit where a digital subcircuit's input pin (direction "in") is
    // driven by a high-impedance analog resistor: R_source = 2e9 Ω.
    // Default rIn from logic family = 1e7 Ω.
    // Threshold: R_source > 100 * rIn = 1e9 Ω → 2e9 > 1e9 → diagnostic emitted.

    // Inner digital circuit: a single In component labeled "A" with output pin at (2,1).
    // The digital compiler uses labelToNetId to map "A" → net ID via In/Out elements.
    const innerCircuit = new Circuit({ engineType: "digital" });

    // PropertyBag with label="A" so compileCircuit can build labelToNetId["A"]
    const innerInProps = new PropertyBag([["label", "A"]]);

    // The In element needs an OUTPUT pin so the compiler assigns it a net.
    // Position its output pin at (2,1); wire connects it to (4,1) to give a net.
    class InnerInElement extends AbstractCircuitElement {
      private readonly _p: readonly Pin[];
      constructor() {
        super("In", "innerIn_A", { x: 0, y: 0 }, 0, false, innerInProps);
        this._p = [{
          direction: PinDirection.OUTPUT,
          position: { x: 2, y: 1 },
          label: "out",
          bitWidth: 1,
          isNegated: false,
          isClock: false,
        }];
      }
      getPins(): readonly Pin[] { return this._p; }
      draw(_ctx: RenderContext): void {}
      getBoundingBox(): Rect { return { x: 0, y: 0, width: 4, height: 2 }; }
      getHelpText(): string { return ""; }
    }

    const innerIn = new InnerInElement();
    innerCircuit.addElement(innerIn);
    // Wire from In's output pin to a net node — gives the compiler a net for "A"
    innerCircuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));

    // Outer analog circuit layout:
    //   Ground at (0, 0)
    //   HighZResistor: p0 at (0,0) [ground], p1 at (10, 0) [bridge input node]
    //   Subcircuit element: pin "SIG" at (10, 0) → connects to bridge input node
    //
    // Wire:
    //   (10,0)-(10,0): self-loop connecting HighZResistor.p1 and subcircuit.SIG

    const outerCircuit = new Circuit({ engineType: "analog" });

    const gndPin: Pin = {
      direction: PinDirection.BIDIRECTIONAL,
      position: { x: 0, y: 0 },
      label: "gnd",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
    const gnd = new GroundElement("gnd", { x: 0, y: 0 }, [gndPin]);
    outerCircuit.addElement(gnd);

    // High-Z resistor: 2 GΩ — R_source > 100 * rIn triggers mismatch
    const R_SOURCE = 2e9;
    const rzp0: Pin = { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false };
    const rzp1: Pin = { direction: PinDirection.BIDIRECTIONAL, position: { x: 10, y: 0 }, label: "p1", bitWidth: 1, isNegated: false, isClock: false };
    const highZRes = new HighZResistorElement("hz1", { x: 0, y: 0 }, [rzp0, rzp1], R_SOURCE);
    outerCircuit.addElement(highZRes);

    // Subcircuit element: outer pin "SIG" at (10, 0)
    const subcircuitPin: Pin = {
      direction: PinDirection.INPUT,
      position: { x: 10, y: 0 },
      label: "SIG",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
    // Pin position is LOCAL: pinWorldPosition(el, pin) = (8,0) + (2,0) = (10,0)
    const subcircuitEl = new BridgeSubcircuitElement(
      "DigSub",
      "digsub_0",
      { x: 8, y: 0 },
      innerCircuit,
      [{ ...subcircuitPin, position: { x: 2, y: 0 } }],
    );
    outerCircuit.addElement(subcircuitEl);

    // Wires: ground node at (0,0), bridge input node at (10,0)
    // Use non-zero-length stubs — Circuit.addWire drops self-loop (zero-length) wires.
    outerCircuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));
    outerCircuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 1 }));

    // Registry: Ground, HighZResistor (analog), In (digital)
    const registry = new ComponentRegistry();
    registry.register(makeGroundDef());
    registry.register(makeAnalogStubDef("HighZResistor", 2));
    registry.register(makeDigitalInDef());

    // CrossEngineBoundary: subcircuit's "SIG" pin maps to inner "A" (direction "in")
    const boundary: CrossEngineBoundary = {
      subcircuitElement: subcircuitEl,
      internalCircuit: innerCircuit,
      internalEngineType: "digital",
      outerEngineType: "analog",
      pinMappings: [
        { pinLabel: "SIG", direction: "in", innerLabel: "A", bitWidth: 1 },
      ],
      instanceName: "DigSub_0",
    };

    const flattenResult: FlattenResult = {
      circuit: outerCircuit,
      crossEngineBoundaries: [boundary],
    };

    const compiled = compileAnalogCircuit(flattenResult, registry);

    const mismatchDiags = compiled.diagnostics.filter(
      (d) => d.code === "bridge-impedance-mismatch",
    );
    expect(mismatchDiags.length).toBeGreaterThanOrEqual(1);
    expect(mismatchDiags[0]!.severity).toBe("info");
    // Diagnostic summary must mention the pin label
    expect(mismatchDiags[0]!.summary).toContain("DigSub_0:SIG");
  });
});
