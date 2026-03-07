/**
 * Tests for state slot allocation (Task 1.1).
 *
 * Verifies that the compiler allocates state slots after all net IDs,
 * that FlatComponentLayout.stateOffset() returns unique non-overlapping
 * positions, and that state slots do not corrupt net values.
 */

import { describe, it, expect } from "vitest";
import { compileCircuit } from "../compiler.js";
import { Circuit } from "@/core/circuit";
import { ComponentRegistry } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import { PropertyType } from "@/core/properties";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, PinDeclaration } from "@/core/pin";
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { PropertyBag as PropertyBagType } from "@/core/properties";
import { DigitalEngine } from "../digital-engine.js";

// ---------------------------------------------------------------------------
// Minimal test CircuitElement implementation
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pinDecls: PinDeclaration[],
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0, false, props ?? new PropertyBag());
    this._pins = resolvePins(
      pinDecls,
      position,
      0,
      createInverterConfig([]),
      createClockConfig([]),
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 2, height: 2 };
  }

  getHelpText(): string {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function twoInputPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

function dffPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: true },
    { direction: PinDirection.OUTPUT, label: "Q", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "~Q", defaultBitWidth: 1, position: { x: 2, y: 1 }, isNegatable: false, isClockCapable: false },
  ];
}

function dynamicPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

// ---------------------------------------------------------------------------
// ExecuteFn stubs
// ---------------------------------------------------------------------------

const noopExecute: ExecuteFunction = () => {};

const executeAnd: ExecuteFunction = (index, state, _highZs, layout) => {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[outBase] = (state[inBase]! & state[inBase + 1]!) >>> 0;
};

const executeDFF: ExecuteFunction = (index, state, _highZs, layout) => {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);
  const D = state[inBase]! & 1;
  const clk = state[inBase + 1]! & 1;
  const prevClk = state[stBase + 1]! & 1;
  if (!prevClk && clk) {
    state[stBase] = D;
  }
  state[outBase] = state[stBase]!;
  state[outBase + 1] = (~state[stBase]!) >>> 0;
  state[stBase + 1] = clk;
};

// ---------------------------------------------------------------------------
// Definition builders
// ---------------------------------------------------------------------------

function makeDefinition(
  name: string,
  pins: PinDeclaration[],
  executeFn: ExecuteFunction = noopExecute,
  stateSlotCount?: number | ((props: PropertyBagType) => number),
): Omit<ComponentDefinition, "typeId"> & { typeId: number } {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBagType) =>
      new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, pins, props),
    executeFn,
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    ...(stateSlotCount !== undefined ? { stateSlotCount } : {}),
  };
}

function makeRegistry(...defs: (Omit<ComponentDefinition, "typeId"> & { typeId: number })[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def as ComponentDefinition);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateSlotAllocation", () => {
  it("allocates_state_after_nets", () => {
    const andDef = makeDefinition("And", twoInputPins(), executeAnd, 0);
    const dffDef = makeDefinition("DFF", dffPins(), executeDFF, 2);
    const registry = makeRegistry(andDef, dffDef);

    // Build circuit: 2 AND gates + 1 DFF, all isolated (no wires)
    const circuit = new Circuit();
    const and1 = registry.get("And")!.factory(new PropertyBag());
    and1.position = { x: 0, y: 0 };
    circuit.addElement(and1);

    const and2 = registry.get("And")!.factory(new PropertyBag());
    and2.position = { x: 10, y: 0 };
    circuit.addElement(and2);

    const dff = registry.get("DFF")!.factory(new PropertyBag());
    dff.position = { x: 20, y: 0 };
    circuit.addElement(dff);

    const compiled = compileCircuit(circuit, registry);

    expect(compiled.signalArraySize).toBe(compiled.netCount + 2);

    const dffIndex = 2;
    expect(compiled.layout.stateOffset(dffIndex)).toBe(compiled.netCount);
  });

  it("multiple_sequential_components_get_distinct_offsets", () => {
    const dffDef = makeDefinition("DFF", dffPins(), executeDFF, 2);
    const registry = makeRegistry(dffDef);

    const circuit = new Circuit();
    const dff1 = registry.get("DFF")!.factory(new PropertyBag());
    dff1.position = { x: 0, y: 0 };
    circuit.addElement(dff1);

    const dff2 = registry.get("DFF")!.factory(new PropertyBag());
    dff2.position = { x: 20, y: 0 };
    circuit.addElement(dff2);

    const compiled = compileCircuit(circuit, registry);

    const offset0 = compiled.layout.stateOffset(0);
    const offset1 = compiled.layout.stateOffset(1);

    expect(offset1 - offset0).toBe(2);
    expect(offset0).toBeGreaterThanOrEqual(compiled.netCount);
    expect(offset1).toBeGreaterThanOrEqual(compiled.netCount);
    expect(offset0).not.toBe(offset1);
  });

  it("state_slots_do_not_corrupt_nets", () => {
    const dffDef = makeDefinition("DFF", dffPins(), executeDFF, 2);
    const andDef = makeDefinition("And", twoInputPins(), executeAnd, 0);
    const registry = makeRegistry(andDef, dffDef);

    const circuit = new Circuit();
    const and1 = registry.get("And")!.factory(new PropertyBag());
    and1.position = { x: 0, y: 0 };
    circuit.addElement(and1);

    const dff = registry.get("DFF")!.factory(new PropertyBag());
    dff.position = { x: 20, y: 0 };
    circuit.addElement(dff);

    const compiled = compileCircuit(circuit, registry);

    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const net0 = 0;
    const net1 = 1;
    const knownVal0 = 42;
    const knownVal1 = 99;

    (engine as unknown as { _values: Uint32Array })["_values"][net0] = knownVal0;
    (engine as unknown as { _values: Uint32Array })["_values"][net1] = knownVal1;
    (engine as unknown as { _highZs: Uint32Array })["_highZs"][net0] = 0;
    (engine as unknown as { _highZs: Uint32Array })["_highZs"][net1] = 0;

    engine.step();

    expect(engine.getSignalRaw(net0)).toBe(knownVal0);
    expect(engine.getSignalRaw(net1)).toBe(knownVal1);
  });

  it("components_with_zero_stateSlotCount_get_stateOffset_zero_or_netCount", () => {
    const andDef = makeDefinition("And", twoInputPins(), executeAnd);
    const dffDef = makeDefinition("DFF", dffPins(), executeDFF, 2);
    const registry = makeRegistry(andDef, dffDef);

    const circuit = new Circuit();
    const and1 = registry.get("And")!.factory(new PropertyBag());
    and1.position = { x: 0, y: 0 };
    circuit.addElement(and1);

    const dff = registry.get("DFF")!.factory(new PropertyBag());
    dff.position = { x: 20, y: 0 };
    circuit.addElement(dff);

    const compiled = compileCircuit(circuit, registry);

    const andStateOffset = compiled.layout.stateOffset(0);
    const dffStateOffset = compiled.layout.stateOffset(1);

    expect(andStateOffset).toBeGreaterThanOrEqual(compiled.netCount);
    expect(dffStateOffset).toBeGreaterThanOrEqual(compiled.netCount);

    const engine = new DigitalEngine("level");
    engine.init(compiled);
    const values = (engine as unknown as { _values: Uint32Array })["_values"];
    expect(values[andStateOffset]).toBe(0);
    engine.step();
    expect(engine.getSignalRaw(0)).toBeDefined();
  });

  it("dynamic_stateSlotCount_resolved_per_instance", () => {
    const dynamicDef = makeDefinition(
      "DynComp",
      dynamicPins(),
      noopExecute,
      (props: PropertyBagType) => props.getOrDefault<number>("size", 4),
    );
    const registry = makeRegistry(dynamicDef);

    const circuit = new Circuit();

    const props1 = new PropertyBag([["size", 4]]);
    const inst1 = new TestElement("DynComp", crypto.randomUUID(), { x: 0, y: 0 }, dynamicPins(), props1);
    circuit.addElement(inst1);

    const props2 = new PropertyBag([["size", 8]]);
    const inst2 = new TestElement("DynComp", crypto.randomUUID(), { x: 20, y: 0 }, dynamicPins(), props2);
    circuit.addElement(inst2);

    registry.get("DynComp")!.propertyDefs = [
      { key: "size", label: "Size", type: PropertyType.INT, defaultValue: 4 },
    ];

    const compiled = compileCircuit(circuit, registry);

    const offset0 = compiled.layout.stateOffset(0);
    const offset1 = compiled.layout.stateOffset(1);

    expect(offset0).toBeGreaterThanOrEqual(compiled.netCount);
    expect(offset1 - offset0).toBe(4);
    expect(compiled.signalArraySize).toBe(compiled.netCount + 4 + 8);
  });
});
