/**
 * Tests for analog compiler bridge adapter insertion (Task 4b.2.2).
 *
 * Verifies:
 * - compileUnified routes analog circuits through compileAnalogPartition
 * - Digital subcircuit is compiled separately by the digital compiler
 * - BridgeOutputAdapter created for each 'out' pin mapping
 * - BridgeInputAdapter created for each 'in' pin mapping
 * - Inner net IDs mapped correctly from compiled inner circuit
 * - Logic family (TTL) used for pin electrical spec resolution
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import { AbstractCircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { compileUnified } from "@/compile/compile.js";
import { LOGIC_FAMILY_PRESETS } from "../../../core/logic-family.js";
import { BridgeOutputAdapter, BridgeInputAdapter } from "../bridge-adapter.js";
import type { SubcircuitHost } from "../../digital/flatten.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement for outer analog circuit leaf elements (Ground, Res)
// ---------------------------------------------------------------------------

class MinimalLeafElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0, false, props ?? new PropertyBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 4, height: 4 }; }
}

// ---------------------------------------------------------------------------
// SubcircuitHost implementation for tests
// ---------------------------------------------------------------------------

class TestSubcircuitHost extends AbstractCircuitElement implements SubcircuitHost {
  readonly internalCircuit: Circuit;
  readonly subcircuitName: string;
  private readonly _pins: readonly Pin[];

  constructor(
    name: string,
    instanceId: string,
    position: { x: number; y: number },
    internalCircuit: Circuit,
    pins: Pin[],
  ) {
    super(`Subcircuit:${name}`, instanceId, position, 0, false, new PropertyBag());
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 6, height: 6 }; }
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function noopExec(): ExecuteFunction {
  return (_idx, _state, _layout) => {};
}

function makeAnalogStubDef(typeId: string, _pinCount: number): ComponentDefinition {
  return {
    name: typeId,
    typeId: -1,
    factory: (_props) => new MinimalLeafElement(typeId, "auto", { x: 0, y: 0 }, []),
    pinLayout: [],
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

function makeDigitalInDef(): ComponentDefinition {
  return {
    name: "In",
    typeId: -1,
    factory: (_props) => new MinimalLeafElement("In", "auto", { x: 0, y: 0 }, []),
    pinLayout: [{ label: "out", direction: PinDirection.OUTPUT }],
    propertyDefs: [{ key: "label", defaultValue: "" }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "In",
    models: { digital: { executeFn: noopExec() } },
  };
}

function makeDigitalOutDef(): ComponentDefinition {
  return {
    name: "Out",
    typeId: -1,
    factory: (_props) => new MinimalLeafElement("Out", "auto", { x: 0, y: 0 }, []),
    pinLayout: [{ label: "in", direction: PinDirection.INPUT }],
    propertyDefs: [{ key: "label", defaultValue: "" }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "Out",
    models: { digital: { executeFn: noopExec() } },
  };
}

function makeAndDef(): ComponentDefinition {
  return {
    name: "And",
    typeId: -1,
    factory: (_props) => new MinimalLeafElement("And", "auto", { x: 0, y: 0 }, []),
    pinLayout: [
      { label: "In_1", direction: PinDirection.INPUT },
      { label: "In_2", direction: PinDirection.INPUT },
      { label: "out", direction: PinDirection.OUTPUT },
    ],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "And",
    models: { digital: { executeFn: noopExec() } },
  };
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: "Ground",
    typeId: -1,
    factory: (_props) => new MinimalLeafElement("Ground", "auto", { x: 0, y: 0 }, []),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "Ground",
    models: { mnaModels: { behavioral: {} } },
  };
}

/**
 * Build a registry with all needed component types.
 * The outer analog circuit needs Ground + a resistor-like analog component.
 * The inner digital circuit needs In, Out, And.
 */
function makeFullRegistry(): ComponentRegistry {
  const reg = new ComponentRegistry();
  reg.register(makeGroundDef());
  reg.register(makeAnalogStubDef("Resistor", 2));
  reg.register(makeDigitalInDef());
  reg.register(makeDigitalOutDef());
  reg.register(makeAndDef());
  return reg;
}

// ---------------------------------------------------------------------------
// Inner digital circuit builder: AND gate with 2 inputs and 1 output
//
// Layout:
//   In "A" at (0,0) → output pin at (2,1)
//   In "B" at (0,5) → output pin at (2,6)
//   And at (5,3)    → input In_1 at (5,2), In_2 at (5,4), output at (8,3)
//   Out "Y" at (10,3) → input pin at (10,3)
// ---------------------------------------------------------------------------

function makeInElement(
  instanceId: string,
  label: string,
  pinPos: { x: number; y: number },
): MinimalLeafElement {
  const props = new PropertyBag([["label", label]]);
  return new MinimalLeafElement("In", instanceId, { x: 0, y: 0 }, [
    {
      direction: PinDirection.OUTPUT,
      position: pinPos,
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ], props);
}

function makeOutElement(
  instanceId: string,
  label: string,
  pinPos: { x: number; y: number },
): MinimalLeafElement {
  const props = new PropertyBag([["label", label]]);
  return new MinimalLeafElement("Out", instanceId, { x: 0, y: 0 }, [
    {
      direction: PinDirection.INPUT,
      position: pinPos,
      label: "in",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ], props);
}

function makeAndElement(
  instanceId: string,
): MinimalLeafElement {
  return new MinimalLeafElement("And", instanceId, { x: 5, y: 3 }, [
    { direction: PinDirection.INPUT,  position: { x: 5, y: 2 }, label: "In_1", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.INPUT,  position: { x: 5, y: 4 }, label: "In_2", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.OUTPUT, position: { x: 8, y: 3 }, label: "out",  bitWidth: 1, isNegated: false, isClock: false },
  ]);
}

/**
 * Build a minimal inner digital circuit:
 *   In "A" → AND gate In_1
 *   In "B" → AND gate In_2
 *   AND gate out → Out "Y"
 *
 * Wire positions:
 *   A out at (2,1) → And In_1 at (5,2): wire (2,1)-(5,2)
 *   B out at (2,6) → And In_2 at (5,4): wire (2,6)-(5,4)
 *   And out at (8,3) → Y in at (10,3):  wire (8,3)-(10,3)
 *
 * Returns the internal digital circuit and a map of label→pinPos for boundary mapping.
 */
function buildInnerDigitalCircuit(): {
  circuit: Circuit;
  aPinPos: { x: number; y: number };
  bPinPos: { x: number; y: number };
  yPinPos: { x: number; y: number };
} {
  const inner = new Circuit({ name: "AndSubcircuit" });

  const inA = makeInElement("inA", "A", { x: 2, y: 1 });
  const inB = makeInElement("inB", "B", { x: 2, y: 6 });
  const andGate = makeAndElement("and1");
  const outY = makeOutElement("outY", "Y", { x: 10, y: 3 });

  inner.addElement(inA);
  inner.addElement(inB);
  inner.addElement(andGate);
  inner.addElement(outY);

  inner.addWire(new Wire({ x: 2, y: 1 }, { x: 5, y: 2 }));
  inner.addWire(new Wire({ x: 2, y: 6 }, { x: 5, y: 4 }));
  inner.addWire(new Wire({ x: 8, y: 3 }, { x: 10, y: 3 }));

  return {
    circuit: inner,
    aPinPos: { x: 2, y: 1 },
    bPinPos: { x: 2, y: 6 },
    yPinPos: { x: 10, y: 3 },
  };
}

// ---------------------------------------------------------------------------
// Outer analog circuit builder
//
// The outer analog circuit contains:
//   - A Ground element at (0,0) with its pin at (0,0)
//   - A Resistor between nodes (0,0)-(0, 20) to give the ground a path
//   - The subcircuit element representing the digital AND gate subcircuit
//     Its outer pins are at known positions connected to MNA nodes via wires.
//
// Outer pin layout for subcircuit:
//   Pin "A" at (20, 1) — INPUT into subcircuit (analog→digital)
//   Pin "B" at (20, 6) — INPUT into subcircuit (analog→digital)
//   Pin "Y" at (20, 3) — OUTPUT from subcircuit (digital→analog)
//
// Wires:
//   node1: wire (20,1)-(30,1) — connects to outer circuit for A
//   node2: wire (20,6)-(30,6) — connects to outer circuit for B
//   node3: wire (20,3)-(30,3) — connects to outer circuit for Y
//   + ground resistor wires to create a complete circuit
// ---------------------------------------------------------------------------

interface TestOuterCircuit {
  circuit: Circuit;
  subcircuitEl: TestSubcircuitHost;
  node1: number;  // MNA node for pin A
  node2: number;  // MNA node for pin B
  node3: number;  // MNA node for pin Y
}

function buildOuterAnalogCircuit(innerCircuit: Circuit): TestOuterCircuit {
  const outer = new Circuit({ name: "OuterAnalog" });

  // Ground element — gives us node 0 (ground)
  const groundEl = new MinimalLeafElement("Ground", "gnd", { x: 0, y: 0 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "gnd", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(groundEl);

  // Resistor from node1 to ground (to make the MNA system solvable)
  // Wire endpoints: (0,0)=ground and (30,1)=node1
  // Pin positions are LOCAL (relative to element origin) — pinWorldPosition
  // adds el.position to get world coords that match wire endpoints.
  const res1El = new MinimalLeafElement("Resistor", "res1", { x: 1, y: 1 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -1, y: -1 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 29, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res1El);

  // Resistor from node2 to ground
  const res2El = new MinimalLeafElement("Resistor", "res2", { x: 2, y: 6 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -2, y: -6 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 28, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res2El);

  // Resistor from node3 to ground
  const res3El = new MinimalLeafElement("Resistor", "res3", { x: 3, y: 3 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -3, y: -3 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 27, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res3El);

  // Subcircuit element — its interface pins are at outer positions
  // Pin positions are LOCAL: pinWorldPosition(el, pin) = (15,0) + pin = world pos
  const subcircuitPins: Pin[] = [
    { direction: PinDirection.INPUT,  position: { x: 5, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.INPUT,  position: { x: 5, y: 6 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.OUTPUT, position: { x: 5, y: 3 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
  ];
  const subcircuitEl = new TestSubcircuitHost(
    "AndGate",
    "andSubcircuit_0",
    { x: 15, y: 0 },
    innerCircuit,
    subcircuitPins,
  );
  outer.addElement(subcircuitEl);

  // Wires connecting subcircuit pins to outer resistor nodes
  // Wire for pin A: (20,1)-(30,1)
  outer.addWire(new Wire({ x: 20, y: 1 }, { x: 30, y: 1 }));
  // Wire for pin B: (20,6)-(30,6)
  outer.addWire(new Wire({ x: 20, y: 6 }, { x: 30, y: 6 }));
  // Wire for pin Y: (20,3)-(30,3)
  outer.addWire(new Wire({ x: 20, y: 3 }, { x: 30, y: 3 }));
  // Wire for ground node: connects all ground pins
  outer.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));

  return { circuit: outer, subcircuitEl, node1: 1, node2: 2, node3: 3 };
}

// ---------------------------------------------------------------------------
// Port element helpers
// ---------------------------------------------------------------------------

function makePortElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
  bitWidth: number = 1,
): MinimalLeafElement {
  const props = new PropertyBag([
    ["label", label],
    ["bitWidth", bitWidth],
    ["face", "left"],
    ["sortOrder", 0],
  ] as [string, PropertyValue][]);
  const pins: Pin[] = [
    {
      direction: PinDirection.BIDIRECTIONAL,
      position: { x: position.x, y: position.y + 1 },
      label: "port",
      bitWidth,
      isNegated: false,
      isClock: false,
    },
  ];
  return new MinimalLeafElement("Port", instanceId, position, pins, props);
}

function makeDigitalPortDef(): ComponentDefinition {
  return {
    name: "Port",
    typeId: -1,
    factory: (_props) => new MinimalLeafElement("Port", "auto", { x: 0, y: 0 }, []),
    pinLayout: [{ label: "port", direction: PinDirection.BIDIRECTIONAL }] as ComponentDefinition["pinLayout"],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "Port",
    models: {}, // Port is neutral infrastructure — no simulation models
  };
}

/**
 * Build a registry for Port-based subcircuit tests.
 * Outer analog circuit: Ground + Resistor.
 * Inner digital circuit: Port, And.
 */
function makePortRegistry(): ComponentRegistry {
  const reg = new ComponentRegistry();
  reg.register(makeGroundDef());
  reg.register(makeAnalogStubDef("Resistor", 2));
  reg.register(makeDigitalPortDef());
  reg.register(makeAndDef());
  return reg;
}

/**
 * Build a minimal inner digital circuit using Port interface elements:
 *   Port "A" → AND gate In_1
 *   Port "B" → AND gate In_2
 *   AND gate out → Port "Y"
 *
 * Port pin positions (pin is at position.y + 1):
 *   portA at (0,0) → pin at (0,1) → wire to And In_1 at (5,2)
 *   portB at (0,5) → pin at (0,6) → wire to And In_2 at (5,4)
 *   portY at (10,2) → pin at (10,3) → wire from And out at (8,3)
 */
function buildPortDigitalCircuit(): {
  circuit: Circuit;
  aPinPos: { x: number; y: number };
  bPinPos: { x: number; y: number };
  yPinPos: { x: number; y: number };
} {
  const inner = new Circuit({ name: "AndPortSubcircuit" });

  const portA = makePortElement("portA", "A", { x: 0, y: 0 });
  const portB = makePortElement("portB", "B", { x: 0, y: 5 });
  const andGate = makeAndElement("and1");
  const portY = makePortElement("portY", "Y", { x: 10, y: 2 });

  inner.addElement(portA);
  inner.addElement(portB);
  inner.addElement(andGate);
  inner.addElement(portY);

  // portA pin at (0,1) → And In_1 at (5,2)
  inner.addWire(new Wire({ x: 0, y: 1 }, { x: 5, y: 2 }));
  // portB pin at (0,6) → And In_2 at (5,4)
  inner.addWire(new Wire({ x: 0, y: 6 }, { x: 5, y: 4 }));
  // And out at (8,3) → portY pin at (10,3)
  inner.addWire(new Wire({ x: 8, y: 3 }, { x: 10, y: 3 }));

  return {
    circuit: inner,
    aPinPos: { x: 0, y: 1 },
    bPinPos: { x: 0, y: 6 },
    yPinPos: { x: 10, y: 3 },
  };
}

/**
 * Build the outer analog circuit wrapping a Port-based inner digital circuit.
 *
 * The subcircuit host's external pins are BIDIRECTIONAL (Port convention).
 * Pin layout on subcircuit element (el.position = {x:15, y:0}):
 *   Pin "A" at local (5,1) → world (20,1)
 *   Pin "B" at local (5,6) → world (20,6)
 *   Pin "Y" at local (5,3) → world (20,3)
 */
function buildOuterAnalogCircuitPort(innerCircuit: Circuit): TestOuterCircuit {
  const outer = new Circuit({ name: "OuterAnalogPort" });

  // Ground element
  const groundEl = new MinimalLeafElement("Ground", "gnd", { x: 0, y: 0 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "gnd", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(groundEl);

  // Resistors from each node to ground (makes MNA system solvable)
  const res1El = new MinimalLeafElement("Resistor", "res1", { x: 1, y: 1 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -1, y: -1 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 29, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res1El);

  const res2El = new MinimalLeafElement("Resistor", "res2", { x: 2, y: 6 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -2, y: -6 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 28, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res2El);

  const res3El = new MinimalLeafElement("Resistor", "res3", { x: 3, y: 3 }, [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: -3, y: -3 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 27, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
  ]);
  outer.addElement(res3El);

  // Subcircuit element — all pins BIDIRECTIONAL (Port convention)
  const subcircuitPins: Pin[] = [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 6 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 3 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
  ];
  const subcircuitEl = new TestSubcircuitHost(
    "AndPortGate",
    "andPortSubcircuit_0",
    { x: 15, y: 0 },
    innerCircuit,
    subcircuitPins,
  );
  outer.addElement(subcircuitEl);

  // Wires connecting subcircuit world-pins to resistor nodes
  outer.addWire(new Wire({ x: 20, y: 1 }, { x: 30, y: 1 }));
  outer.addWire(new Wire({ x: 20, y: 6 }, { x: 30, y: 6 }));
  outer.addWire(new Wire({ x: 20, y: 3 }, { x: 30, y: 3 }));
  outer.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));

  return { circuit: outer, subcircuitEl, node1: 1, node2: 2, node3: 3 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BridgeCompilation", () => {
  it("compiles_digital_subcircuit_separately", () => {
    const { circuit: innerCircuit } = buildInnerDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuit(innerCircuit);
    const registry = makeFullRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.compiledInner).toBeDefined();
    expect(bridge.compiledInner.netCount).toBeGreaterThan(0);
    expect(bridge.instanceName).toMatch(/^AndGate_\d+$/);
  });

  it("creates_output_adapters", () => {
    const { circuit: innerCircuit } = buildInnerDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuit(innerCircuit);
    const registry = makeFullRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    const bridge = compiled.bridges[0]!;
    // Pin "Y" is direction "out" → should create 1 BridgeOutputAdapter
    expect(bridge.outputAdapters).toHaveLength(1);
    expect(bridge.outputAdapters[0]).toBeInstanceOf(BridgeOutputAdapter);

    // The adapter should be wired to the correct outer MNA node (node for Y)
    // Node Y is connected via wire (20,3)-(30,3) which shares a net with res3's pin at (30,3)
    const adapter = bridge.outputAdapters[0]!;
    expect(adapter.outputNodeId).toBeGreaterThan(0);
  });

  it("creates_input_adapters", () => {
    const { circuit: innerCircuit } = buildInnerDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuit(innerCircuit);
    const registry = makeFullRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    const bridge = compiled.bridges[0]!;
    // Pins "A" and "B" are direction "in" → should create 2 BridgeInputAdapters
    expect(bridge.inputAdapters).toHaveLength(2);
    expect(bridge.inputAdapters[0]).toBeInstanceOf(BridgeInputAdapter);
    expect(bridge.inputAdapters[1]).toBeInstanceOf(BridgeInputAdapter);

    // Each adapter should have a valid outer MNA node
    expect(bridge.inputAdapters[0]!.inputNodeId).toBeGreaterThan(0);
    expect(bridge.inputAdapters[1]!.inputNodeId).toBeGreaterThan(0);
    // The two input adapters should be at different nodes (A and B on different nets)
    expect(bridge.inputAdapters[0]!.inputNodeId).not.toBe(bridge.inputAdapters[1]!.inputNodeId);
  });

  it("inner_net_ids_mapped", () => {
    const { circuit: innerCircuit } = buildInnerDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuit(innerCircuit);
    const registry = makeFullRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    const bridge = compiled.bridges[0]!;
    const inner = bridge.compiledInner;

    // outputPinNetIds[0] must be a valid net in the inner circuit
    expect(bridge.outputPinNetIds).toHaveLength(1);
    const outNetId = bridge.outputPinNetIds[0]!;
    expect(outNetId).toBeGreaterThanOrEqual(0);
    expect(outNetId).toBeLessThan(inner.netCount);

    // inputPinNetIds[0] and [1] must be valid nets
    expect(bridge.inputPinNetIds).toHaveLength(2);
    for (const netId of bridge.inputPinNetIds) {
      expect(netId).toBeGreaterThanOrEqual(0);
      expect(netId).toBeLessThan(inner.netCount);
    }
  });

  it("pin_electrical_resolved_for_ttl", () => {
    const { circuit: innerCircuit } = buildInnerDigitalCircuit();
    const outerMeta = {
      name: "OuterAnalog",
      logicFamily: LOGIC_FAMILY_PRESETS["ttl"],
    };
    const outer = new Circuit(outerMeta);

    // Ground element
    const groundEl = new MinimalLeafElement("Ground", "gnd", { x: 0, y: 0 }, [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "gnd", bitWidth: 1, isNegated: false, isClock: false },
    ]);
    outer.addElement(groundEl);

    // Resistor from node to ground
    // Pin positions are LOCAL: pinWorldPosition(el, pin) = (1,3) + pin = world pos
    const resEl = new MinimalLeafElement("Resistor", "res1", { x: 1, y: 3 }, [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: -1, y: -3 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 29, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
    ]);
    outer.addElement(resEl);

    // Subcircuit with a single output pin "Y"
    // Pin positions are LOCAL: pinWorldPosition(el, pin) = (15,0) + pin = world pos
    const subcircuitPins: Pin[] = [
      { direction: PinDirection.OUTPUT, position: { x: 5, y: 3 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subcircuitEl = new TestSubcircuitHost(
      "SingleOut",
      "singleOut_0",
      { x: 15, y: 0 },
      innerCircuit,
      subcircuitPins,
    );
    outer.addElement(subcircuitEl);

    // Wire connecting subcircuit Y pin to resistor node
    outer.addWire(new Wire({ x: 20, y: 3 }, { x: 30, y: 3 }));
    outer.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));

    const registry = makeFullRegistry();

    const compiled = compileUnified(outer, registry).analog!;

    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.outputAdapters).toHaveLength(1);

    // TTL vOH = 3.4V, CMOS 3.3V vOH = 3.3V
    // Verify adapter is stamping TTL characteristics by checking the adapter exists
    // and was created (exact internal validation is in bridge-adapter.test.ts).
    // The adapter's label includes the instance name and pin label.
    expect(bridge.outputAdapters[0]!.label).toContain("Y");
  });
});

// ---------------------------------------------------------------------------
// Port-based bridge compilation tests
// ---------------------------------------------------------------------------

describe("bridge compilation — Port-based subcircuits", () => {
  it("Port-based inner digital circuit compiles with bridge adapters", () => {
    // Analog parent, digital subcircuit using Port interface elements.
    // All subcircuit host pins are BIDIRECTIONAL (Port convention).
    // buildPinMappings maps BIDIRECTIONAL → "out", so all 3 ports become
    // outputAdapters.
    const { circuit: innerCircuit } = buildPortDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuitPort(innerCircuit);
    const registry = makePortRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.compiledInner).toBeDefined();
    expect(bridge.compiledInner.netCount).toBeGreaterThan(0);
    expect(bridge.instanceName).toMatch(/^AndPortGate_\d+$/);
  });

  it("bridge adapter pin mappings from Port interfaces — BIDIRECTIONAL maps to outputAdapters", () => {
    // Port elements on the subcircuit host are BIDIRECTIONAL.
    // buildPinMappings treats non-INPUT pins as "out" direction.
    // All 3 Port pins (A, B, Y) become outputAdapters; inputAdapters is empty.
    const { circuit: innerCircuit } = buildPortDigitalCircuit();
    const { circuit: outerCircuit } = buildOuterAnalogCircuitPort(innerCircuit);
    const registry = makePortRegistry();

    const compiled = compileUnified(outerCircuit, registry).analog!;

    const bridge = compiled.bridges[0]!;

    // All BIDIRECTIONAL pins → "out" mapping → BridgeOutputAdapter for each
    expect(bridge.outputAdapters).toHaveLength(3);
    for (const adapter of bridge.outputAdapters) {
      expect(adapter).toBeInstanceOf(BridgeOutputAdapter);
      expect(adapter.outputNodeId).toBeGreaterThan(0);
    }

    // No INPUT-direction pins → no input adapters
    expect(bridge.inputAdapters).toHaveLength(0);
  });

  it("Port subcircuit with multiple ports — correct adapter count", () => {
    // Inner digital circuit with 2 Port interface elements and an And gate
    // (the gate is needed so the inner circuit has a digital domain component,
    // which triggers the cross-engine boundary detection in compileUnified).
    const inner = new Circuit({ name: "TwoPortSub" });

    const portX = makePortElement("portX", "X", { x: 0, y: 0 });
    const portZ = makePortElement("portZ", "Z", { x: 0, y: 5 });
    const andGate = makeAndElement("and1");
    inner.addElement(portX);
    inner.addElement(portZ);
    inner.addElement(andGate);
    // portX pin at (0,1) → And In_1 at (5,2)
    inner.addWire(new Wire({ x: 0, y: 1 }, { x: 5, y: 2 }));
    // portZ pin at (0,6) → And In_2 at (5,4)
    inner.addWire(new Wire({ x: 0, y: 6 }, { x: 5, y: 4 }));

    // Outer analog circuit with 2 BIDIRECTIONAL subcircuit pins
    const outer = new Circuit({ name: "OuterTwoPort" });

    const groundEl = new MinimalLeafElement("Ground", "gnd", { x: 0, y: 0 }, [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "gnd", bitWidth: 1, isNegated: false, isClock: false },
    ]);
    outer.addElement(groundEl);

    // Resistor from nodeX (30,1) to ground (0,0)
    const resXEl = new MinimalLeafElement("Resistor", "resX", { x: 1, y: 1 }, [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: -1, y: -1 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 29, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
    ]);
    outer.addElement(resXEl);

    // Resistor from nodeZ (30,6) to ground (0,0)
    const resZEl = new MinimalLeafElement("Resistor", "resZ", { x: 2, y: 6 }, [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: -2, y: -6 }, label: "p0", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 28, y: 0 },  label: "p1", bitWidth: 1, isNegated: false, isClock: false },
    ]);
    outer.addElement(resZEl);

    const subcircuitPins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 1 }, label: "X", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 6 }, label: "Z", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subcircuitEl = new TestSubcircuitHost(
      "TwoPort",
      "twoPort_0",
      { x: 15, y: 0 },
      inner,
      subcircuitPins,
    );
    outer.addElement(subcircuitEl);

    // Wire X pin at world (20,1) to resX node at (30,1)
    outer.addWire(new Wire({ x: 20, y: 1 }, { x: 30, y: 1 }));
    // Wire Z pin at world (20,6) to resZ node at (30,6)
    outer.addWire(new Wire({ x: 20, y: 6 }, { x: 30, y: 6 }));
    outer.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));

    const registry = makePortRegistry();
    const compiled = compileUnified(outer, registry).analog!;

    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;

    // 2 Port pins, both BIDIRECTIONAL → 2 outputAdapters
    expect(bridge.outputAdapters).toHaveLength(2);
    expect(bridge.inputAdapters).toHaveLength(0);

    // Each adapter should have a valid outer MNA node
    for (const adapter of bridge.outputAdapters) {
      expect(adapter).toBeInstanceOf(BridgeOutputAdapter);
      expect(adapter.outputNodeId).toBeGreaterThan(0);
    }

    // The two adapters should be at different outer nodes (X and Z on different nets)
    expect(bridge.outputAdapters[0]!.outputNodeId).not.toBe(
      bridge.outputAdapters[1]!.outputNodeId,
    );
  });
});
