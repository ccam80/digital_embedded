/**
 * Tests for bridge diagnostic emissions (Task 4b.4.1).
 *
 * Verifies:
 *  - bridge-indeterminate-input: emitted after 10 consecutive indeterminate
 *    timesteps (voltage between vIL and vIH)
 *  - bridge-indeterminate-input: NOT emitted when voltage stays at a valid level
 *  - bridge-oscillating-input: emitted after 20 consecutive threshold crossings
 *  - bridge-impedance-mismatch: emitted when source R > 100 × R_in
 *
 * Runtime diagnostics (indeterminate, oscillating) are tested through
 * DefaultSimulationCoordinator which owns the bridge sync logic.
 * The compile-time diagnostic (impedance-mismatch) is tested through
 * compileUnified().
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulationCoordinator } from "../../coordinator.js";
import { makeBridgeInputAdapter } from "../bridge-adapter.js";
import type { BridgeInstance } from "../bridge-instance.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { compileUnified } from "@/compile/compile.js";
import { Circuit, Wire } from "../../../core/circuit.js";
import { AbstractCircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../../../core/registry.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SubcircuitHost } from "../../digital/flatten.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { CompiledCircuitUnified } from "../../../compile/types.js";

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
// Helper: build a DefaultSimulationCoordinator with a bridge instance
// ---------------------------------------------------------------------------

function makeCoordinatorWithBridge(
  bridge: BridgeInstance,
  nodeCount: number,
): DefaultSimulationCoordinator {
  const analogCompiled = new ConcreteCompiledAnalogCircuit({
    nodeCount,
    branchCount: 0,
    elements: [],
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    bridges: [bridge],
  });
  const unified: CompiledCircuitUnified = {
    digital: null,
    analog: analogCompiled,
    bridges: [],
    wireSignalMap: new Map(),
    labelSignalMap: new Map(),
    diagnostics: [],
  };
  return new DefaultSimulationCoordinator(unified);
}

// ---------------------------------------------------------------------------
// Helper: set MNA engine voltages and run bridge sync steps
// ---------------------------------------------------------------------------

function setAnalogVoltage(
  coordinator: DefaultSimulationCoordinator,
  nodeId: number,
  voltage: number,
): void {
  const analog = coordinator.getAnalogEngine() as any;
  if (analog._voltages && analog._voltages.length > 0) {
    analog._voltages[nodeId - 1] = voltage;
  }
}

function runBridgeSyncSteps(
  coordinator: DefaultSimulationCoordinator,
  nodeId: number,
  voltage: number,
  steps: number,
): void {
  for (let i = 0; i < steps; i++) {
    setAnalogVoltage(coordinator, nodeId, voltage);
    (coordinator as any)._syncBeforeAnalogStep();
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
      const coordinator = makeCoordinatorWithBridge(bridge, 2);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);

      // 1.5V is between vIL (0.8V) and vIH (2.0V) — indeterminate
      runBridgeSyncSteps(coordinator, INPUT_NODE, 1.5, 15);

      const diags = collector.getDiagnostics();
      const indetermDiags = diags.filter((d) => d.code === "bridge-indeterminate-input");

      expect(indetermDiags.length).toBeGreaterThanOrEqual(1);
      expect(indetermDiags[0]!.summary).toContain("sub:A");
      expect(indetermDiags[0]!.summary).toContain("1.500");

      coordinator.dispose();
    });
  });

  describe("stable_input_no_warning", () => {
    it("does not emit bridge-indeterminate-input when voltage stays above vIH", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET, "sub:B");
      const coordinator = makeCoordinatorWithBridge(bridge, 2);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);

      // 3.3V is well above vIH (2.0V) — unambiguously logic high
      runBridgeSyncSteps(coordinator, INPUT_NODE, 3.3, 100);

      const diags = collector.getDiagnostics();
      const indetermDiags = diags.filter((d) => d.code === "bridge-indeterminate-input");
      expect(indetermDiags.length).toBe(0);

      coordinator.dispose();
    });
  });

  describe("oscillating_input_warns", () => {
    it("emits bridge-oscillating-input after 20 consecutive threshold crossings", () => {
      const INPUT_NODE = 1;
      const INPUT_NET = 0;

      const bridge = makeSingleInputBridge(INPUT_NODE, INPUT_NET, "sub:CLK");
      const coordinator = makeCoordinatorWithBridge(bridge, 2);
      const collector = new DiagnosticCollector();
      coordinator.setDiagnosticCollector(collector);

      const lowVoltage = 1.9;
      const highVoltage = 2.1;

      // Prime: first step with highVoltage so prevInputVoltages is set
      setAnalogVoltage(coordinator, INPUT_NODE, highVoltage);
      (coordinator as any)._syncBeforeAnalogStep();
      (coordinator as any)._syncAfterAnalogStep();

      // Alternate for 25 steps to trigger the M=20 threshold
      for (let step = 0; step < 25; step++) {
        const v = step % 2 === 0 ? lowVoltage : highVoltage;
        setAnalogVoltage(coordinator, INPUT_NODE, v);
        (coordinator as any)._syncBeforeAnalogStep();
        (coordinator as any)._syncAfterAnalogStep();
      }

      const diags = collector.getDiagnostics();
      const oscillatingDiags = diags.filter((d) => d.code === "bridge-oscillating-input");
      expect(oscillatingDiags.length).toBeGreaterThanOrEqual(1);
      expect(oscillatingDiags[0]!.summary).toContain("sub:CLK");

      coordinator.dispose();
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
}

function noopExec(): ExecuteFunction {
  return (_idx, _state, _layout) => {};
}

function makeAnalogStubDef(typeId: string, pinCount: number): ComponentDefinition {
  return {
    name: typeId,
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    pinLayout: Array.from({ length: pinCount }, (_, i) => ({
      label: `p${i}`,
      direction: PinDirection.BIDIRECTIONAL,
    })),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: typeId,
    defaultModel: 'behavioral',
    models: {
      mnaModels: {
        behavioral: {
          factory: (pinNodes, _internalNodeIds, _branchIdx, _props, _getTime): AnalogElement => ({
            pinNodeIds: [...pinNodes.values()],
            allNodeIds: [...pinNodes.values()],
            branchIndex: -1,
            isNonlinear: false,
            isReactive: false,
            stamp(_s: SparseSolver) {},
          }),
        },
      },
    },
  };
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: "Ground",
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "Ground",
    models: { mnaModels: { behavioral: {} } },
  };
}

function makeDigitalInDef(): ComponentDefinition {
  return {
    name: "In",
    typeId: -1,
    factory: (_props) => new GroundElement("auto", { x: 0, y: 0 }, []),
    pinLayout: [{ label: "out", direction: PinDirection.OUTPUT }],
    propertyDefs: [{ key: "label", defaultValue: "" }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "In",
    models: { digital: { executeFn: noopExec() } },
  };
}

describe("bridge-impedance-mismatch", () => {
  it("emits_bridge_impedance_mismatch_when_source_resistance_too_high", () => {
    // Build a circuit where a digital subcircuit's input pin (direction "in") is
    // driven by a high-impedance analog resistor: R_source = 2e9 Ω.
    // Default rIn from logic family = 1e7 Ω.
    // Threshold: R_source > 100 * rIn = 1e9 Ω → 2e9 > 1e9 → diagnostic emitted.

    // Inner digital circuit: a single In component labeled "SIG" with output pin at (2,1).
    // The label must match the subcircuit host's pin label so flattenCircuit's
    // buildPinMappings can resolve inner↔outer pin correspondence.
    const innerCircuit = new Circuit();

    const innerInProps = new PropertyBag([["label", "SIG"]]);

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

    const outerCircuit = new Circuit();

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

    const compiled = compileUnified(outerCircuit, registry).analog!;

    const mismatchDiags = compiled.diagnostics.filter(
      (d) => d.code === "bridge-impedance-mismatch",
    );
    expect(mismatchDiags.length).toBeGreaterThanOrEqual(1);
    expect(mismatchDiags[0]!.severity).toBe("info");
    expect(mismatchDiags[0]!.summary).toContain("SIG");
  });
});
